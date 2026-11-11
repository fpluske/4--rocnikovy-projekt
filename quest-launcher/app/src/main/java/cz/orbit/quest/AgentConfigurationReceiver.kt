package cz.orbit.quest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AgentConfigurationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val preferences = context.getSharedPreferences("orbit_quest", Context.MODE_PRIVATE)
        when (action) {
            "cz.orbit.quest.action.CONFIGURE" -> {
                val backendUrl = intent.getStringExtra("backend_url")?.trim()?.trimEnd('/') ?: return
                val deviceName = intent.getStringExtra("device_name")?.trim() ?: return
                if (backendUrl.isBlank() || deviceName.isBlank()) return
                val editor = preferences.edit().putString("device_name", deviceName)
                if (intent.getBooleanExtra("paired", false)) {
                    val deviceId = intent.getStringExtra("device_id")?.trim() ?: return
                    if (deviceId.isBlank()) return
                    editor.putString("paired_backend_url", backendUrl)
                        .putString("paired_device_id", deviceId)
                        .remove("pending_backend_url")
                        .remove("pending_pairing_id")
                } else {
                    editor.putString("pending_backend_url", backendUrl)
                }
                editor.apply()
                if (intent.getBooleanExtra("paired", false)) {
                    val serviceIntent = Intent(context, OrbitAgentService::class.java)
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        context.startForegroundService(serviceIntent)
                    } else {
                        context.startService(serviceIntent)
                    }
                }
            }
            "cz.orbit.quest.action.RESET" -> {
                context.stopService(Intent(context, OrbitAgentService::class.java))
                context.stopService(Intent(context, ScreenCaptureForegroundService::class.java))
                preferences.edit()
                    .remove("paired_backend_url")
                    .remove("paired_device_id")
                    .remove("pending_backend_url")
                    .remove("pending_pairing_id")
                    .apply()
            }
        }
    }
}