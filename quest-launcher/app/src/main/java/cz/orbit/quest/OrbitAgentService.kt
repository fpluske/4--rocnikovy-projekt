package cz.orbit.quest

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.content.BroadcastReceiver
import android.content.Context
import android.app.ActivityManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference

class OrbitAgentService : Service() {
    companion object {
        private const val CHANNEL_ID = "orbit_agent"
        private const val NOTIFICATION_ID = 1003
        private const val HEARTBEAT_INTERVAL_MS = 10_000L
        private const val COMMAND_POLL_INTERVAL_MS = 5_000L
        private const val PREFS = "orbit_quest"
        private const val PAIRED_BACKEND_URL = "paired_backend_url"
        private const val PAIRED_DEVICE_ID = "paired_device_id"
        private val MENU_PACKAGES = setOf(
            "com.oculus.vrshell",
            "com.meta.systemui",
            "com.oculus.systemux",
        )
        private val HOME_PACKAGES = setOf(
            "com.oculus.igvr",
            "com.oculus.home",
            "com.meta.home",
        )
    }

    private val handler = Handler(Looper.getMainLooper())
    private val heartbeatInFlight = AtomicBoolean(false)
    private val commandPollInFlight = AtomicBoolean(false)
    private val deviceStatus = AtomicReference("online")
    private val screenStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val status = when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> "standby"
                Intent.ACTION_SCREEN_ON -> "online"
                else -> return
            }
            if (deviceStatus.getAndSet(status) != status) sendHeartbeat()
        }
    }
    private val serialNumber by lazy {
        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: UUID.randomUUID().toString()
    }
    private val appVersion by lazy {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "unknown"
    }
    private val devicePolicyManager by lazy { getSystemService(DevicePolicyManager::class.java) }
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
        deviceStatus.set(if (getSystemService(PowerManager::class.java).isInteractive) "online" else "standby")
        registerReceiver(screenStateReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        })
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
        unregisterReceiver(screenStateReceiver)
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
                    val battery = readBatteryLevels()
                    it.write(JSONObject()
                        .put("serial_number", serialNumber)
                        .put("status", deviceStatus.get())
                        .put("battery_percent", battery.headset)
                        .put("is_charging", battery.isCharging)
                        .put("left_controller_battery_percent", battery.leftController)
                        .put("right_controller_battery_percent", battery.rightController)
                        .put("firmware_version", appVersion)
                        .put("horizon_os_version", "${android.os.Build.DISPLAY} (${android.os.Build.VERSION.INCREMENTAL})")
                        .put(
                            "horizon_os_update_pending",
                            devicePolicyManager.getPendingSystemUpdate(
                                ComponentName(this@OrbitAgentService, OrbitDeviceAdminReceiver::class.java),
                            ) != null,
                        )
                        .put("current_app", readCurrentApp())
                        .toString()
                        .toByteArray())
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

    private data class BatteryLevels(
        val headset: Int?,
        val isCharging: Boolean?,
        val leftController: Int?,
        val rightController: Int?,
    )

    private fun readBatteryLevels(): BatteryLevels {
        val batteryManager = getSystemService(BatteryManager::class.java)
        val headsetLevel = batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            ?.takeIf { it in 0..100 }
        val batteryStatus = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val isCharging = when (batteryStatus) {
            BatteryManager.BATTERY_STATUS_CHARGING -> true
            BatteryManager.BATTERY_STATUS_DISCHARGING,
            BatteryManager.BATTERY_STATUS_NOT_CHARGING,
            BatteryManager.BATTERY_STATUS_FULL -> false
            else -> null
        }

        val leftController = readControllerBatteryLevel(1)
        val rightController = readControllerBatteryLevel(0)
        return BatteryLevels(headsetLevel, isCharging, leftController, rightController)
    }

    private fun readCurrentApp(): String {
        val packageName = readForegroundPackage() ?: return "Home"
        return when {
            packageName in MENU_PACKAGES -> "Menu"
            packageName in HOME_PACKAGES -> "Home"
            else -> try {
                packageManager.getApplicationLabel(
                    packageManager.getApplicationInfo(packageName, 0),
                ).toString()
            } catch (error: android.content.pm.PackageManager.NameNotFoundException) {
                packageName
            }
        }
    }

    private fun readForegroundPackage(): String? {
        return try {
            getSystemService(ActivityManager::class.java)
                ?.getRunningTasks(1)
                ?.firstOrNull()
                ?.topActivity
                ?.packageName
                ?: readForegroundPackageFromUsageStats()
        } catch (error: SecurityException) {
            Log.w("OrbitQuest", "Aktivní aplikaci nelze zjistit přes ActivityManager.", error)
            readForegroundPackageFromUsageStats()
        }
    }

    private fun readForegroundPackageFromUsageStats(): String? {
        val usageStatsManager = getSystemService(UsageStatsManager::class.java) ?: return null
        val endTime = System.currentTimeMillis()
        val events = usageStatsManager.queryEvents(endTime - 60_000L, endTime)
        val event = UsageEvents.Event()
        var foregroundPackage: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                foregroundPackage = event.packageName
            }
        }
        return foregroundPackage
    }

    private fun readControllerBatteryLevel(controllerType: Int): Int? {
        return try {
            val controllersManager = getSystemService("controllers_manager") ?: return null
            val controllerInfo = controllersManager.javaClass
                .getMethod("getPairedDeviceInfo", Int::class.javaPrimitiveType)
                .invoke(controllersManager, controllerType)
                ?: return null
            controllerInfo.javaClass.getMethod("getBatteryLevel").invoke(controllerInfo)
                .let { it as? Int }
                ?.takeIf { it in 0..100 }
        } catch (error: ReflectiveOperationException) {
            Log.w("OrbitQuest", "Baterii ovladačů se nepodařilo načíst.", error)
            null
        } catch (error: SecurityException) {
            Log.w("OrbitQuest", "Přístup k baterii ovladačů byl odmítnut.", error)
            null
        }
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