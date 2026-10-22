package cz.orbit.quest

import android.app.Activity
import android.content.SharedPreferences
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.util.Log
import android.media.projection.MediaProjectionManager
import android.media.projection.MediaProjection
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URISyntaxException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONException
import org.json.JSONObject
import kotlin.concurrent.thread
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SessionDescription
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.SurfaceTextureHelper

class MainActivity : Activity() {
    private companion object {
        const val HEARTBEAT_INTERVAL_MS = 10_000L
        const val PAIRING_POLL_INTERVAL_MS = 3_000L
        const val PREFS = "orbit_quest"
        const val PAIRED_BACKEND_URL = "paired_backend_url"
        const val PENDING_BACKEND_URL = "pending_backend_url"
        const val PENDING_PAIRING_ID = "pending_pairing_id"
        const val PAIRING_PIN = "pairing_pin"
        const val PAIRING_NONCE = "pairing_nonce"
        const val DEVICE_NAME = "device_name"
        const val SCREEN_CAPTURE_REQUEST = 1001
    }

    private val preferences: SharedPreferences by lazy {
        getSharedPreferences(PREFS, MODE_PRIVATE)
    }
    private lateinit var backendUrl: EditText
    private lateinit var deviceName: EditText
    private lateinit var status: TextView
    private lateinit var pairButton: Button
    private lateinit var resetButton: Button
    private lateinit var pairingPinLabel: TextView
    private lateinit var pairingPinText: TextView
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private val pairingHandler = Handler(Looper.getMainLooper())
    private val heartbeatInFlight = AtomicBoolean(false)
    private val pairingPollInFlight = AtomicBoolean(false)
    private val heartbeatTask = object : Runnable {
        override fun run() {
            sendHeartbeat()
            heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }
    private val serialNumber by lazy {
        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: UUID.randomUUID().toString()
    }
    private lateinit var pairingPin: String
    private lateinit var nonce: String
    private var signalingSocket: WebSocket? = null
    private var peerConnection: PeerConnection? = null
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var videoSource: VideoSource? = null
    private var eglBase: EglBase? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var pendingOffer: SessionDescription? = null
    private var pendingCapture: Pair<SessionDescription, Intent>? = null
    private val pendingRemoteCandidates = mutableListOf<org.webrtc.IceCandidate>()
    private var remoteDescriptionReady = false
    private var stoppingCapture = false
    private var screenCaptureServiceReady = false
    private var peerFactory: PeerConnectionFactory? = null
    private var iceServers = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pairingPin = preferences.getString(PAIRING_PIN, null) ?: (1000..9999).random().toString().also {
            preferences.edit().putString(PAIRING_PIN, it).apply()
        }
        nonce = preferences.getString(PAIRING_NONCE, null) ?: (UUID.randomUUID().toString().replace("-", "") +
            UUID.randomUUID().toString().replace("-", "")).also {
            preferences.edit().putString(PAIRING_NONCE, it).apply()
        }
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions()
        )
        peerFactory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(null, true, false))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(null))
            .createPeerConnectionFactory()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 32)
        }
        val scroll = ScrollView(this).apply { addView(root) }

        root.addView(label("ORBIT QUEST / PROTOTYP"))
        root.addView(title("Párování headsetu"))
        root.addView(description("Nechte tuto aplikaci otevřenou a potvrďte zařízení ve webové administraci."))

        backendUrl = input("URL backendu", "http://192.168.1.100:8000")
        deviceName = input("Název headsetu", "Quest")
        backendUrl.setText(preferences.getString(PAIRED_BACKEND_URL, null)
            ?: preferences.getString(PENDING_BACKEND_URL, null)
            ?: backendUrl.text)
        deviceName.setText(preferences.getString(DEVICE_NAME, null) ?: deviceName.text)
        root.addView(backendUrl)
        root.addView(deviceName)

        pairingPinLabel = label("PIN PRO PÁROVÁNÍ").apply {
            setPadding(0, 32, 0, 4)
        }
        root.addView(pairingPinLabel)
        pairingPinText = TextView(this).apply {
            text = pairingPin
            textSize = 42f
            gravity = Gravity.CENTER
            setTextColor(0xff218c83.toInt())
            setPadding(0, 8, 0, 24)
        }
        root.addView(pairingPinText)

        pairButton = Button(this).apply {
            text = if (isPaired()) "Headset je spárovaný" else "Spárovat headset"
            setOnClickListener { sendDiscovery() }
        }
        root.addView(pairButton)
        resetButton = Button(this).apply {
            text = "Reset"
            setOnClickListener { resetPairing() }
        }
        root.addView(resetButton)

        status = description(if (isPaired()) {
            "Stav: spárováno, připojuji se k backendu..."
        } else if (pendingPairingId() != null) {
            "Stav: čeká na potvrzení PINem $pairingPin ve webu."
        } else {
            "Stav: připravuji první párování..."
        })
        status.setPadding(0, 24, 0, 0)
        root.addView(status)
        setContentView(scroll)
        updatePairingControls()
    }

    override fun onStart() {
        super.onStart()
        when {
            isPaired() -> heartbeatHandler.post(heartbeatTask)
            pendingPairingId() != null -> pairingHandler.post(pairingPollTask)
            else -> window.decorView.postDelayed({ sendDiscovery() }, 500)
        }
        if (isPaired()) loadIceServersAndConnect()
    }

    override fun onStop() {
        heartbeatHandler.removeCallbacks(heartbeatTask)
        pairingHandler.removeCallbacks(pairingPollTask)
        super.onStop()
    }

    override fun onDestroy() {
        signalingSocket?.close(1000, "Activity destroyed")
        signalingSocket = null
        stopScreenShare()
        peerFactory?.dispose()
        peerFactory = null
        super.onDestroy()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != SCREEN_CAPTURE_REQUEST || resultCode != RESULT_OK || data == null) {
            pendingOffer = null
            pendingCapture = null
            pendingRemoteCandidates.clear()
            remoteDescriptionReady = false
            stopService(Intent(this, ScreenCaptureForegroundService::class.java))
            screenCaptureServiceReady = false
            return
        }
        val offer = pendingOffer ?: return
        pendingOffer = null
        pendingCapture = offer to data
        startPendingCapture()
    }

    private fun connectSignaling() {
        if (signalingSocket != null) return
        val baseUrl = preferences.getString(PAIRED_BACKEND_URL, null).orEmpty()
        val wsUrl = baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") +
            "/api/webrtc/" + java.net.URLEncoder.encode(serialNumber, "UTF-8")
        signalingSocket = OkHttpClient().newWebSocket(Request.Builder().url(wsUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"device"}""")
                runOnUiThread { status.text = "Stav: headset je připravený pro živé sdílení." }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val message = JSONObject(text)
                    when (message.getString("type")) {
                        "offer" -> runOnUiThread {
                            status.text = "Stav: web žádá o sdílení obrazovky..."
                            pendingOffer = SessionDescription(SessionDescription.Type.OFFER, message.getString("sdp"))
                            startScreenCaptureService()
                            val projection = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                            startActivityForResult(projection.createScreenCaptureIntent(), SCREEN_CAPTURE_REQUEST)
                        }
                        "candidate" -> {
                            val candidate = message.getJSONObject("candidate")
                            val iceCandidate = org.webrtc.IceCandidate(
                                candidate.optString("sdpMid"),
                                candidate.getInt("sdpMLineIndex"),
                                candidate.getString("candidate")
                            )
                            runOnUiThread {
                                val connection = peerConnection
                                if (connection == null || !remoteDescriptionReady) pendingRemoteCandidates += iceCandidate
                                else connection.addIceCandidate(iceCandidate)
                            }
                        }
                        "hangup" -> runOnUiThread { stopScreenShare() }
                    }
                } catch (error: JSONException) {
                    Log.w("OrbitQuest", "Neplatná WebRTC signalizace.", error)
                }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                runOnUiThread { status.text = "Stav: živé sdílení není dostupné." }
                Log.w("OrbitQuest", "WebRTC signalizace se nepodařila.", error)
                signalingSocket = null
            }
        })
    }

    private fun loadIceServersAndConnect() {
        val baseUrl = preferences.getString(PAIRED_BACKEND_URL, null).orEmpty()
        if (baseUrl.isBlank()) return
        thread {
            try {
                val connection = (URI("$baseUrl/api/webrtc/config").toURL()
                    .openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                }
                val code = connection.responseCode
                if (code !in 200..299) throw IOException("Backend vrátil HTTP $code.")
                val servers = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                    .getJSONArray("ice_servers")
                val parsed = (0 until servers.length()).map { index ->
                    val server = servers.getJSONObject(index)
                    val urls = server.get("urls")
                    val builder = if (urls is org.json.JSONArray) {
                        PeerConnection.IceServer.builder((0 until urls.length()).map { urls.getString(it) })
                    } else {
                        PeerConnection.IceServer.builder(urls.toString())
                    }
                    if (server.has("username")) builder.setUsername(server.getString("username"))
                    if (server.has("credential")) builder.setPassword(server.getString("credential"))
                    builder.createIceServer()
                }
                if (parsed.isNotEmpty()) iceServers = parsed
                connection.disconnect()
            } catch (error: IOException) {
                Log.w("OrbitQuest", "Konfigurace ICE se nepodařila načíst, používám STUN.", error)
            } catch (error: JSONException) {
                Log.w("OrbitQuest", "Konfigurace ICE má neplatný formát, používám STUN.", error)
            } catch (error: URISyntaxException) {
                Log.w("OrbitQuest", "URL konfigurace ICE není platná.", error)
            } finally {
                runOnUiThread { connectSignaling() }
            }
        }
    }

    private fun startScreenCaptureService() {
        val serviceIntent = Intent(this, ScreenCaptureForegroundService::class.java)
        ScreenCaptureForegroundService.onForegroundReady = {
            runOnUiThread {
                screenCaptureServiceReady = true
                startPendingCapture()
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(serviceIntent)
            else startService(serviceIntent)
        } catch (error: SecurityException) {
            status.text = "Stav: Android nepovolil službu pro sdílení obrazovky."
            Log.e("OrbitQuest", "Foreground service pro sdílení se nepodařilo spustit.", error)
        }
    }

    private fun startPendingCapture() {
        val capture = pendingCapture ?: return
        if (!screenCaptureServiceReady || isFinishing) return
        pendingCapture = null
        startScreenShareCapture(capture.first, capture.second)
    }

    private fun startScreenShareCapture(offer: SessionDescription, permissionData: Intent) {
        val factory = peerFactory ?: return
        stopScreenShare(stopForegroundService = false)
        remoteDescriptionReady = false
        eglBase = EglBase.create()
        videoSource = factory.createVideoSource(false)
        screenCapturer = ScreenCapturerAndroid(permissionData, object : MediaProjection.Callback() {
            override fun onStop() {
                stopScreenShare()
            }
        })
        surfaceTextureHelper = SurfaceTextureHelper.create("ScreenCapture", eglBase!!.eglBaseContext)
        screenCapturer?.initialize(
            surfaceTextureHelper,
            this,
            videoSource!!.capturerObserver
        )
        try {
            screenCapturer?.startCapture(1280, 720, 15)
        } catch (error: SecurityException) {
            stopScreenShare()
            status.text = "Stav: Android nepovolil sdílení obrazovky."
            Log.e("OrbitQuest", "MediaProjection se nepodařilo spustit.", error)
            return
        }
        val videoTrack = factory.createVideoTrack("screen", videoSource)
        val configuration = PeerConnection.RTCConfiguration(iceServers)
        peerConnection = factory.createPeerConnection(configuration, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: org.webrtc.IceCandidate) {
                signalingSocket?.send("""{"type":"candidate","candidate":{"sdpMid":${json(candidate.sdpMid ?: "")},"sdpMLineIndex":${candidate.sdpMLineIndex},"candidate":${json(candidate.sdp)}}}""")
            }
            override fun onSignalingChange(newState: PeerConnection.SignalingState) {
                Log.i("OrbitQuest", "WebRTC signaling stav: $newState")
            }
            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
                Log.i("OrbitQuest", "WebRTC ICE stav: $newState")
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out org.webrtc.IceCandidate>) {}
            override fun onAddStream(stream: org.webrtc.MediaStream) {}
            override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
            override fun onDataChannel(dataChannel: org.webrtc.DataChannel) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver, mediaStreams: Array<out org.webrtc.MediaStream>) {}
        })
        peerConnection?.addTrack(videoTrack, listOf("screen"))
        peerConnection?.setRemoteDescription(object : SdpObserver() {
            override fun onSetSuccess() {
                remoteDescriptionReady = true
                pendingRemoteCandidates.forEach { peerConnection?.addIceCandidate(it) }
                pendingRemoteCandidates.clear()
                peerConnection?.createAnswer(object : SdpObserver() {
                    override fun onCreateSuccess(description: SessionDescription) {
                        peerConnection?.setLocalDescription(object : SdpObserver() {
                            override fun onSetSuccess() {
                                signalingSocket?.send("""{"type":"answer","sdp":${json(description.description)}}""")
                            }
                            override fun onSetFailure(error: String) {
                                sendWebRtcError("Nastavení lokálního SDP selhalo: $error")
                                super.onSetFailure(error)
                            }
                        }, description)
                    }
                    override fun onCreateFailure(error: String) {
                        sendWebRtcError("Vytvoření SDP odpovědi selhalo: $error")
                        super.onCreateFailure(error)
                    }
                }, MediaConstraints())
            }
            override fun onSetFailure(error: String) {
                sendWebRtcError("Nastavení vzdáleného SDP selhalo: $error")
                super.onSetFailure(error)
            }
        }, offer)
    }

    private fun stopScreenShare(stopForegroundService: Boolean = true) {
        if (stoppingCapture) return
        stoppingCapture = true
        try {
            screenCapturer?.stopCapture()
        } finally {
            screenCapturer?.dispose()
            screenCapturer = null
            surfaceTextureHelper?.dispose()
            surfaceTextureHelper = null
            peerConnection?.close()
            peerConnection = null
            videoSource?.dispose()
            videoSource = null
            eglBase?.release()
            eglBase = null
            if (stopForegroundService) {
                stopService(Intent(this, ScreenCaptureForegroundService::class.java))
            }
            screenCaptureServiceReady = false
            pendingCapture = null
            pendingRemoteCandidates.clear()
            remoteDescriptionReady = false
            stoppingCapture = false
        }
    }

    private fun sendWebRtcError(message: String) {
        signalingSocket?.send("""{"type":"error","message":${json(message)}}""")
        runOnUiThread { status.text = "Stav: $message" }
    }

    private fun sendDiscovery() {
        if (isPaired()) return
        val baseUrl = backendUrl.text.toString().trim().trimEnd('/')
        val name = deviceName.text.toString().trim()
        if (baseUrl.isBlank() || name.isBlank()) {
            status.text = "Vyplňte URL backendu a název headsetu."
            return
        }
        preferences.edit()
            .putString(PENDING_BACKEND_URL, baseUrl)
            .putString(DEVICE_NAME, name)
            .apply()
        pairButton.isEnabled = false
        status.text = "Stav: odesílám discovery..."
        thread {
            try {
                val url = URI("$baseUrl/api/pairing/discover").toURL()
                val connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 5000
                connection.readTimeout = 5000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                val payload = """{"name":${json(name)},"serial_number":${json(serialNumber)},"model":"Meta Quest 2","nonce":"$nonce","pin":"$pairingPin"}"""
                connection.outputStream.use { it.write(payload.toByteArray()) }
                val code = connection.responseCode
                val responseBody = if (code in 200..299) {
                    connection.inputStream.bufferedReader().use { it.readText() }
                } else {
                    null
                }
                if (responseBody == null) {
                    throw IOException("Backend vrátil HTTP $code.")
                }
                val pairingId = JSONObject(responseBody).getString("id")
                preferences.edit().putString(PENDING_PAIRING_ID, pairingId).apply()
                connection.disconnect()
                runOnUiThread {
                    status.text = "Stav: discovery odesláno. Ve webu potvrďte PIN $pairingPin."
                    updatePairingControls()
                    pairingHandler.removeCallbacks(pairingPollTask)
                    pairingHandler.post(pairingPollTask)
                }
            } catch (error: IOException) {
                runOnUiThread {
                    status.text = "Stav: odeslání selhalo: ${error.message ?: "neznámá chyba"}"
                    updatePairingControls()
                }
            } catch (error: JSONException) {
                runOnUiThread {
                    status.text = "Stav: backend poslal neplatnou odpověď."
                    updatePairingControls()
                    Log.w("OrbitQuest", "Neplatná odpověď discovery.", error)
                }
            } catch (error: URISyntaxException) {
                runOnUiThread {
                    status.text = "Stav: URL backendu není platná."
                    updatePairingControls()
                    Log.w("OrbitQuest", "URL backendu pro discovery není platná.", error)
                }
            }
        }
    }

    private val pairingPollTask = object : Runnable {
        override fun run() {
            pollPairingStatus()
            pairingHandler.postDelayed(this, PAIRING_POLL_INTERVAL_MS)
        }
    }

    private fun pollPairingStatus() {
        val baseUrl = preferences.getString(PENDING_BACKEND_URL, null) ?: return
        val pairingId = pendingPairingId() ?: return
        if (!pairingPollInFlight.compareAndSet(false, true)) return
        thread {
            try {
                val connection = (URI("$baseUrl/api/pairing/$pairingId").toURL()
                    .openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 5000
                    readTimeout = 5000
                }
                val code = connection.responseCode
                if (code !in 200..299) throw IOException("Backend vrátil HTTP $code.")
                val pairing = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                connection.disconnect()
                when (pairing.getString("status")) {
                    "confirmed" -> markPaired(baseUrl, pairing.optString("device_id"))
                    "expired", "rejected" -> clearPendingPairing("Párování vypršelo nebo bylo odmítnuto.")
                }
            } catch (error: IOException) {
                Log.w("OrbitQuest", "Kontrola párování se nepodařila.", error)
            } catch (error: JSONException) {
                Log.w("OrbitQuest", "Neplatná odpověď kontroly párování.", error)
            } catch (error: URISyntaxException) {
                Log.w("OrbitQuest", "URL backendu pro kontrolu párování není platná.", error)
            } finally {
                pairingPollInFlight.set(false)
            }
        }
    }

    private fun markPaired(baseUrl: String, deviceId: String) {
        preferences.edit()
            .putString(PAIRED_BACKEND_URL, baseUrl)
            .putString("paired_device_id", deviceId)
            .remove(PENDING_BACKEND_URL)
            .remove(PENDING_PAIRING_ID)
            .remove(PAIRING_PIN)
            .remove(PAIRING_NONCE)
            .apply()
        runOnUiThread {
            pairingHandler.removeCallbacks(pairingPollTask)
            status.text = "Stav: headset je spárovaný a připojený."
            updatePairingControls()
            heartbeatHandler.post(heartbeatTask)
            loadIceServersAndConnect()
        }
    }

    private fun clearPendingPairing(message: String) {
        preferences.edit()
            .remove(PENDING_BACKEND_URL)
            .remove(PENDING_PAIRING_ID)
            .apply()
        runOnUiThread {
            pairingHandler.removeCallbacks(pairingPollTask)
            status.text = "Stav: $message Spusťte párování znovu."
            updatePairingControls()
        }
    }

    private fun resetPairing() {
        heartbeatHandler.removeCallbacks(heartbeatTask)
        pairingHandler.removeCallbacks(pairingPollTask)
        signalingSocket?.close(1000, "Pairing reset")
        signalingSocket = null
        stopScreenShare()
        pairingPin = (1000..9999).random().toString()
        nonce = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "")
        preferences.edit()
            .remove(PAIRED_BACKEND_URL)
            .remove("paired_device_id")
            .remove(PENDING_BACKEND_URL)
            .remove(PENDING_PAIRING_ID)
            .putString(PAIRING_PIN, pairingPin)
            .putString(PAIRING_NONCE, nonce)
            .apply()
        pairingPinText.text = pairingPin
        status.text = "Stav: připravuji nové párování..."
        updatePairingControls()
        window.decorView.postDelayed({ sendDiscovery() }, 500)
    }

    private fun pendingPairingId() = preferences.getString(PENDING_PAIRING_ID, null)

    private fun isPaired() = !preferences.getString(PAIRED_BACKEND_URL, null).isNullOrBlank()

    private fun updatePairingControls() {
        if (!::pairButton.isInitialized) return
        val paired = isPaired()
        backendUrl.isEnabled = !paired
        deviceName.isEnabled = !paired
        pairButton.isEnabled = !paired && pendingPairingId() == null
        pairButton.visibility = if (paired) View.GONE else View.VISIBLE
        resetButton.visibility = if (paired) View.VISIBLE else View.GONE
        pairingPinLabel.visibility = if (paired) View.GONE else View.VISIBLE
        pairingPinText.visibility = if (paired) View.GONE else View.VISIBLE
        backendUrl.visibility = if (paired) View.GONE else View.VISIBLE
        deviceName.visibility = if (paired) View.GONE else View.VISIBLE
    }

    private fun sendHeartbeat() {
        if (!heartbeatInFlight.compareAndSet(false, true)) return
        if (!isPaired()) {
            heartbeatInFlight.set(false)
            return
        }
        val baseUrl = preferences.getString(PAIRED_BACKEND_URL, null).orEmpty()
        if (baseUrl.isBlank()) {
            heartbeatInFlight.set(false)
            return
        }
        thread {
            try {
                val url = URI("$baseUrl/api/devices/heartbeat").toURL()
                val connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 5000
                connection.readTimeout = 5000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                val payload = """{"serial_number":${json(serialNumber)},"current_app":"Orbit Quest"}"""
                connection.outputStream.use { it.write(payload.toByteArray()) }
                val responseCode = connection.responseCode
                if (responseCode !in 200..299) {
                    throw IOException("Backend vrátil HTTP $responseCode.")
                }
                connection.disconnect()
                runOnUiThread {
                    status.text = "Stav: headset je spárovaný a připojený k serveru."
                }
            } catch (error: IOException) {
                runOnUiThread {
                    status.text = "Stav: headset je spárovaný, server není dostupný."
                }
                Log.w("OrbitQuest", "Heartbeat se nepodařilo odeslat.", error)
            } catch (error: IllegalArgumentException) {
                runOnUiThread {
                    status.text = "Stav: headset je spárovaný, URL serveru není platná."
                }
                Log.w("OrbitQuest", "URL backendu pro heartbeat není platná.", error)
            } finally {
                heartbeatInFlight.set(false)
            }
        }
    }

    private fun json(value: String) = JSONObject.quote(value)

    private abstract class SdpObserver : org.webrtc.SdpObserver {
        override fun onCreateFailure(error: String) {
            Log.w("OrbitQuest", "WebRTC SDP nabídka selhala: $error")
        }
        override fun onSetFailure(error: String) {
            Log.w("OrbitQuest", "WebRTC SDP nastavení selhalo: $error")
        }
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        textSize = 12f
        setTextColor(0xff218c83.toInt())
    }

    private fun title(text: String) = TextView(this).apply {
        this.text = text
        textSize = 30f
        setTextColor(0xff17202b.toInt())
        setPadding(0, 8, 0, 8)
    }

    private fun description(text: String) = TextView(this).apply {
        this.text = text
        textSize = 16f
        setTextColor(0xff6b7785.toInt())
    }

    private fun input(hint: String, value: String) = EditText(this).apply {
        this.hint = hint
        setText(value)
        textSize = 16f
        setSingleLine(true)
        setPadding(0, 20, 0, 8)
    }
}
