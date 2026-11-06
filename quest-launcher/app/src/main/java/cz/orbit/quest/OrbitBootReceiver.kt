package cz.orbit.quest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class OrbitBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED &&
            intent?.action != Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) return
        if (context.getSharedPreferences("orbit_quest", Context.MODE_PRIVATE)
            .getString("paired_backend_url", null).isNullOrBlank()
        ) return

        val serviceIntent = Intent(context, OrbitAgentService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
        context.startActivity(Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }
}