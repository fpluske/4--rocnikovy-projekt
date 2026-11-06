package cz.orbit.quest

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

class OrbitAgentService : Service() {
    companion object {
        private const val CHANNEL_ID = "orbit_agent"
        private const val NOTIFICATION_ID = 1003
        private const val HEARTBEAT_INTERVAL_MS = 10_000L
        private const val COMMAND_POLL_INTERVAL_MS = 5_000L
        private const val PREFS = "orbit_quest"
        private const val PAIRED_BACKEND_URL = "paired_backend_url"
        private const val PAIRED_DEVICE_ID = "paired_device_id"
    }

    private val handler = Handler(Looper.getMainLooper())
    private val heartbeatInFlight = AtomicBoolean(false)
    private val commandPollInFlight = AtomicBoolean(false)
    private val serialNumber by lazy {
        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: UUID.randomUUID().toString()
    }
    private val heartbeatTask = object : Runnable {
        override fun run() {
            sendHeartbeat()
            handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }
    private val commandTask = object : Runnable {
        override fun run() {
            pollCommands()
            handler.postDelayed(this, COMMAND_POLL_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        handler.removeCallbacks(heartbeatTask)
        handler.removeCallbacks(commandTask)
        handler.post(heartbeatTask)
        handler.post(commandTask)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(heartbeatTask)
        handler.removeCallbacks(commandTask)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun sendHeartbeat() {
        if (!heartbeatInFlight.compareAndSet(false, true)) return
        val preferences = getSharedPreferences(PREFS, MODE_PRIVATE)
        val baseUrl = preferences.getString(PAIRED_BACKEND_URL, null).orEmpty()
        if (baseUrl.isBlank()) {
            heartbeatInFlight.set(false)
            return
        }
        Thread {
            try {
                val connection = (URI("$baseUrl/api/devices/heartbeat").toURL().openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 5000
                    readTimeout = 5000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
                connection.outputStream.use {
                    it.write("{\"serial_number\":${JSONObject.quote(serialNumber)},\"current_app\":\"Orbit Quest\"}".toByteArray())
                }
                if (connection.responseCode !in 200..299) throw IOException("HTTP ${connection.responseCode}")
                connection.disconnect()
            } catch (error: Exception) {
                Log.w("OrbitQuest", "Heartbeat se nepodařilo odeslat.", error)
            } finally {
                heartbeatInFlight.set(false)
            }
        }.start()
    }

    private fun pollCommands() {
        if (!commandPollInFlight.compareAndSet(false, true)) return
        val preferences = getSharedPreferences(PREFS, MODE_PRIVATE)
        val baseUrl = preferences.getString(PAIRED_BACKEND_URL, null).orEmpty()
        val deviceId = preferences.getString(PAIRED_DEVICE_ID, null).orEmpty()
        if (baseUrl.isBlank() || deviceId.isBlank()) {
            commandPollInFlight.set(false)
            return
        }
        Thread {
            try {
                val connection = (URI("$baseUrl/api/devices/$deviceId/commands?limit=20").toURL().openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                }
                if (connection.responseCode !in 200..299) throw IOException("HTTP ${connection.responseCode}")
                val commands = JSONArray(connection.inputStream.bufferedReader().use { it.readText() })
                connection.disconnect()
                for (index in 0 until commands.length()) {
                    val command = commands.getJSONObject(index)
                    if (command.getString("status") == "queued") {
                        startService(Intent(this, CommandExecutionService::class.java).apply {
                            putExtra(CommandExecutionService.EXTRA_BASE_URL, baseUrl)
                            putExtra(CommandExecutionService.EXTRA_DEVICE_ID, deviceId)
                            putExtra(CommandExecutionService.EXTRA_COMMAND, command.toString())
                        })
                        break
                    }
                }
            } catch (error: Exception) {
                Log.w("OrbitQuest", "Načtení příkazů se nepodařilo.", error)
            } finally {
                commandPollInFlight.set(false)
            }
        }.start()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Orbit agent", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun notification(): Notification = Notification.Builder(this, CHANNEL_ID)
        .setContentTitle("Orbit Quest")
        .setContentText("Agent komunikuje s backendem.")
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setOngoing(true)
        .build()
}