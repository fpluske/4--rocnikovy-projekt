package cz.orbit.quest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AgentConfigurationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != "cz.orbit.quest.action.CONFIGURE") return
        val backendUrl = intent.getStringExtra("backend_url")?.trim()?.trimEnd('/') ?: return
        val deviceName = intent.getStringExtra("device_name")?.trim() ?: return
        if (backendUrl.isBlank() || deviceName.isBlank()) return
        context.getSharedPreferences("orbit_quest", Context.MODE_PRIVATE)
            .edit()
            .putString("pending_backend_url", backendUrl)
            .putString("device_name", deviceName)
            .apply()
    }
}