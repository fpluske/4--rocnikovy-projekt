package cz.orbit.quest

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.content.pm.ServiceInfo
import android.provider.Settings
import android.util.Log
import java.net.URLEncoder
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONException
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource

class ScreenCaptureForegroundService : Service() {
    companion object {
        private const val CHANNEL_ID = "screen_capture"
        private const val NOTIFICATION_ID = 1002
        const val EXTRA_PERMISSION_DATA = "permission_data"
        const val EXTRA_OFFER_SDP = "offer_sdp"
        const val EXTRA_REMOTE_CANDIDATES = "remote_candidates"
        var onForegroundReady: (() -> Unit)? = null
        var signalingReady = false
    }

    private val preferences by lazy { getSharedPreferences("orbit_quest", MODE_PRIVATE) }
    private val serialNumber by lazy {
        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
    }
    private var signalingSocket: WebSocket? = null
    private var peerFactory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var videoSource: VideoSource? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var eglBase: EglBase? = null
    private var permissionData: Intent? = null
    private var pendingOffer: SessionDescription? = null
    private val pendingCandidates = mutableListOf<org.webrtc.IceCandidate>()
    private var remoteDescriptionReady = false
    private val iceServers = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
    )

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Sdílení obrazovky",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions()
        )
        peerFactory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(null, true, false))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(null))
            .createPeerConnectionFactory()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getParcelableExtra<Intent>(EXTRA_PERMISSION_DATA)?.let {
            permissionData = it
        }
        intent?.getStringExtra(EXTRA_OFFER_SDP)?.let {
            pendingOffer = SessionDescription(SessionDescription.Type.OFFER, it)
        }
        intent?.getStringExtra(EXTRA_REMOTE_CANDIDATES)?.let { candidatesJson ->
            try {
                val candidates = org.json.JSONArray(candidatesJson)
                for (index in 0 until candidates.length()) {
                    val candidate = candidates.getJSONObject(index)
                    pendingCandidates += org.webrtc.IceCandidate(
                        candidate.optString("sdpMid"),
                        candidate.getInt("sdpMLineIndex"),
                        candidate.getString("candidate"),
                    )
                }
            } catch (error: JSONException) {
                Log.w("OrbitQuest", "Počáteční ICE kandidáty mají neplatný formát.", error)
            }
        }
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Orbit Quest")
            .setContentText("Obraz headsetu se sdílí do webu.")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (permissionData != null) connectSignaling()
        onForegroundReady?.invoke()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
            onForegroundReady = null
        signalingSocket?.close(1000, "Service destroyed")
        signalingSocket = null
        signalingReady = false
        stopCapture()
        peerFactory?.dispose()
        peerFactory = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun connectSignaling() {
        if (signalingSocket != null || permissionData == null) return
        val baseUrl = preferences.getString("paired_backend_url", null).orEmpty()
        if (baseUrl.isBlank()) return
        val wsUrl = baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") +
            "/api/webrtc/" + URLEncoder.encode(serialNumber, "UTF-8")
        signalingSocket = OkHttpClient().newWebSocket(
            Request.Builder().url(wsUrl).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    signalingReady = true
                    webSocket.send("""{"type":"device"}""")
                    pendingOffer?.let {
                        pendingOffer = null
                        startCapture(it)
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val message = JSONObject(text)
                        when (message.getString("type")) {
                            "offer" -> startCapture(SessionDescription(SessionDescription.Type.OFFER, message.getString("sdp")))
                            "candidate" -> {
                                val candidate = message.getJSONObject("candidate")
                                val iceCandidate = org.webrtc.IceCandidate(
                                    candidate.optString("sdpMid"),
                                    candidate.getInt("sdpMLineIndex"),
                                    candidate.getString("candidate"),
                                )
                                if (peerConnection == null || !remoteDescriptionReady) pendingCandidates += iceCandidate
                                else peerConnection?.addIceCandidate(iceCandidate)
                            }
                            "hangup" -> stopPeerConnection()
                        }
                    } catch (error: JSONException) {
                        Log.w("OrbitQuest", "Neplatná WebRTC signalizace.", error)
                    }
                }

                override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                    Log.w("OrbitQuest", "WebRTC signalizace se nepodařila.", error)
                    signalingSocket = null
                    signalingReady = false
                }
            },
        )
    }

    private fun startCapture(offer: SessionDescription) {
        val factory = peerFactory ?: return
        val permission = permissionData ?: return
        stopPeerConnection()
        if (screenCapturer == null || videoSource == null || surfaceTextureHelper == null || eglBase == null) {
            eglBase = EglBase.create()
            videoSource = factory.createVideoSource(false)
            screenCapturer = ScreenCapturerAndroid(permission, object : android.media.projection.MediaProjection.Callback() {
                override fun onStop() = stopCapture()
            })
            surfaceTextureHelper = SurfaceTextureHelper.create("BackgroundScreenCapture", eglBase!!.eglBaseContext)
            screenCapturer!!.initialize(surfaceTextureHelper, this, videoSource!!.capturerObserver)
            try {
                screenCapturer!!.startCapture(1280, 720, 15)
            } catch (error: Exception) {
                Log.e("OrbitQuest", "MediaProjection se nepodařilo spustit.", error)
                stopCapture()
                return
            }
        }
        val videoTrack = factory.createVideoTrack("background-screen", videoSource)
        peerConnection = factory.createPeerConnection(
            PeerConnection.RTCConfiguration(iceServers),
            object : PeerConnection.Observer {
                override fun onIceCandidate(candidate: org.webrtc.IceCandidate) {
                    signalingSocket?.send("""{"type":"candidate","candidate":{"sdpMid":${json(candidate.sdpMid ?: "")},"sdpMLineIndex":${candidate.sdpMLineIndex},"candidate":${json(candidate.sdp)}}}""")
                }
                override fun onSignalingChange(newState: PeerConnection.SignalingState) {}
                override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {}
                override fun onIceCandidatesRemoved(candidates: Array<out org.webrtc.IceCandidate>) {}
                override fun onAddStream(stream: org.webrtc.MediaStream) {}
                override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
                override fun onDataChannel(dataChannel: org.webrtc.DataChannel) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(receiver: org.webrtc.RtpReceiver, mediaStreams: Array<out org.webrtc.MediaStream>) {}
            },
        )
        peerConnection?.addTrack(videoTrack, listOf("screen"))
        peerConnection?.setRemoteDescription(object : SdpObserver() {
            override fun onSetSuccess() {
                remoteDescriptionReady = true
                pendingCandidates.forEach { peerConnection?.addIceCandidate(it) }
                pendingCandidates.clear()
                peerConnection?.createAnswer(object : SdpObserver() {
                    override fun onCreateSuccess(description: SessionDescription) {
                        peerConnection?.setLocalDescription(object : SdpObserver() {
                            override fun onSetSuccess() {
                                signalingSocket?.send("""{"type":"answer","sdp":${json(description.description)}}""")
                            }
                        }, description)
                    }
                }, MediaConstraints())
            }
        }, offer)
    }

    private fun stopPeerConnection() {
        peerConnection?.close()
        peerConnection = null
        pendingCandidates.clear()
        remoteDescriptionReady = false
    }

    private fun stopCapture() {
        try {
            screenCapturer?.stopCapture()
        } catch (_: Exception) {
        }
        screenCapturer?.dispose()
        screenCapturer = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null
        videoSource?.dispose()
        videoSource = null
        eglBase?.release()
        eglBase = null
        stopPeerConnection()
    }

    private fun json(value: String) = JSONObject.quote(value)

    private abstract class SdpObserver : org.webrtc.SdpObserver {
        override fun onCreateFailure(error: String) { Log.w("OrbitQuest", "WebRTC create selhal: $error") }
        override fun onSetFailure(error: String) { Log.w("OrbitQuest", "WebRTC set selhal: $error") }
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
    }
}
