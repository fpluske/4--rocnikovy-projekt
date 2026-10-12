package cz.orbit.launcher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class LauncherService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var token: String? = null
    private var deviceId: String? = null

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel("orbit", "Orbit Launcher", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        startForeground(10, Notification.Builder(this, "orbit").setContentTitle("Orbit Quest Launcher").setContentText("Správa zařízení je aktivní").setSmallIcon(android.R.drawable.stat_notify_sync).build())
        scope.launch { registerAndPoll() }
    }

    private suspend fun registerAndPoll() {
        val prefs = getSharedPreferences("launcher", MODE_PRIVATE)
        val server = prefs.getString("server", "")!!.trimEnd('/')
        val body = JSONObject()
            .put("name", prefs.getString("name", "Quest 2"))
            .put("serial", prefs.getString("serial", "").orEmpty())
            .toString()
        val registration = request("$server/api/launcher/register", "POST", body, mapOf("X-Launcher-Key" to prefs.getString("key", "")))
        token = registration.getString("token")
        deviceId = registration.getString("deviceId")
        while (currentCoroutineContext().isActive) {
            heartbeat(server)
            request("$server/api/launcher/commands", "GET", null, authHeaders()).getJSONArray("commands").let { commands ->
                for (index in 0 until commands.length()) handleCommand(commands.getJSONObject(index).getString("command"))
            }
            delay(5000)
        }
    }

    private suspend fun heartbeat(server: String) {
        request("$server/api/launcher/heartbeat", "POST", JSONObject().put("battery", 100).put("firmware", BuildConfig.VERSION_NAME).put("app", "Orbit Launcher").toString(), authHeaders())
    }

    private fun handleCommand(command: String) {
        when (command) {
            "restart" -> Runtime.getRuntime().exec(arrayOf("reboot"))
            "shutdown" -> Runtime.getRuntime().exec(arrayOf("reboot", "-p"))
            "sync", "update" -> Unit
        }
    }

    private fun authHeaders() = mapOf("Authorization" to "Bearer ${token.orEmpty()}")

    private fun request(url: String, method: String, body: String?, headers: Map<String, String>): JSONObject {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 10000
        connection.readTimeout = 10000
        headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toByteArray()) }
        }
        if (connection.responseCode !in 200..299) error("Launcher API error ${connection.responseCode}")
        return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
