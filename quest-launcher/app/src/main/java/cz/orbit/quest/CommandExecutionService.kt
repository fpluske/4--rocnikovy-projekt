package cz.orbit.quest

import android.app.Service
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.os.IBinder
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import org.json.JSONObject

class CommandExecutionService : Service() {
    companion object {
        const val EXTRA_BASE_URL = "base_url"
        const val EXTRA_DEVICE_ID = "device_id"
        const val EXTRA_COMMAND = "command"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val baseUrl = intent?.getStringExtra(EXTRA_BASE_URL)
        val deviceId = intent?.getStringExtra(EXTRA_DEVICE_ID)
        val commandJson = intent?.getStringExtra(EXTRA_COMMAND)
        if (baseUrl == null || deviceId == null || commandJson == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        Thread {
            execute(baseUrl, deviceId, JSONObject(commandJson))
            stopSelf(startId)
        }.start()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun execute(baseUrl: String, deviceId: String, command: JSONObject) {
        val commandId = command.getString("id")
        try {
            if (!updateCommand(baseUrl, deviceId, commandId, "sent", null)) return
            when (command.getString("type")) {
                "restart" -> {
                    if (!updateCommand(baseUrl, deviceId, commandId, "acknowledged", null)) return
                    getSystemService(DevicePolicyManager::class.java).reboot(
                        ComponentName(this, OrbitDeviceAdminReceiver::class.java),
                    )
                }
                "lock" -> {
                    if (updateCommand(baseUrl, deviceId, commandId, "acknowledged", null)) {
                        dispatchKioskCommand(MainActivity.ACTION_LOCK, baseUrl, deviceId, commandId)
                    }
                }
                "unlock" -> {
                    if (updateCommand(baseUrl, deviceId, commandId, "acknowledged", null)) {
                        dispatchKioskCommand(MainActivity.ACTION_UNLOCK, baseUrl, deviceId, commandId)
                    }
                }
                "launch_app" -> launchApp(baseUrl, deviceId, commandId, command)
                "shutdown" -> updateCommand(
                    baseUrl, deviceId, commandId, "failed",
                    "Android neposkytuje aplikaci API pro vypnutí zařízení; použijte uzamčení.",
                )
                else -> updateCommand(baseUrl, deviceId, commandId, "failed", "Neznámý typ příkazu.")
            }
        } catch (error: Exception) {
            Log.w("OrbitQuest", "Příkaz se nepodařilo vykonat.", error)
            updateCommand(baseUrl, deviceId, commandId, "failed", error.message ?: "Neznámá chyba.")
        }
    }

    private fun launchApp(baseUrl: String, deviceId: String, commandId: String, command: JSONObject) {
        val packageName = command.optJSONObject("payload")?.optString("package_name").orEmpty()
        if (packageName.isBlank()) {
            updateCommand(baseUrl, deviceId, commandId, "failed", "Příkaz neobsahuje package name aplikace.")
            return
        }
        val applicationInfo = packageManager.getApplicationInfo(packageName, 0)
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0) {
            updateCommand(baseUrl, deviceId, commandId, "failed", "Systémovou aplikaci nelze spustit z tohoto tlačítka.")
            return
        }
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: throw IllegalArgumentException("Aplikace nemá dostupnou launcher aktivitu.")
        if (!updateCommand(baseUrl, deviceId, commandId, "acknowledged", null)) return
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        startActivity(launchIntent)
        updateCommand(baseUrl, deviceId, commandId, "completed", null)
    }

    private fun dispatchKioskCommand(action: String, baseUrl: String, deviceId: String, commandId: String) {
        startActivity(Intent(this, MainActivity::class.java).apply {
            this.action = action
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(MainActivity.EXTRA_COMMAND_BASE_URL, baseUrl)
            putExtra(MainActivity.EXTRA_COMMAND_DEVICE_ID, deviceId)
            putExtra(MainActivity.EXTRA_COMMAND_ID, commandId)
        })
    }

    private fun updateCommand(
        baseUrl: String,
        deviceId: String,
        commandId: String,
        commandStatus: String,
        errorMessage: String?,
    ): Boolean {
        return try {
            val connection = (URI("$baseUrl/api/devices/$deviceId/commands/$commandId").toURL().openConnection() as HttpURLConnection).apply {
                requestMethod = "PATCH"
                connectTimeout = 5000
                readTimeout = 5000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            val payload = JSONObject().put("status", commandStatus).put("error_message", errorMessage).toString()
            connection.outputStream.use { it.write(payload.toByteArray()) }
            val successful = connection.responseCode in 200..299
            connection.disconnect()
            successful
        } catch (error: IOException) {
            Log.w("OrbitQuest", "Stav příkazu se nepodařilo uložit.", error)
            false
        }
    }
}