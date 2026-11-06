package cz.orbit.setup

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class SetupActivity : Activity() {
    private val preferences by lazy { getSharedPreferences("orbit_setup", MODE_PRIVATE) }
    private lateinit var backendUrl: EditText
    private lateinit var deviceName: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 32)
        }
        root.addView(TextView(this).apply {
            text = "ORBIT SETUP"
            textSize = 14f
        })
        root.addView(TextView(this).apply {
            text = "Konfigurace agentové aplikace"
            textSize = 30f
            setPadding(0, 12, 0, 24)
        })
        backendUrl = input("URL backendu", "http://192.168.1.100:8000")
        backendUrl.setText(preferences.getString("backend_url", backendUrl.text.toString()))
        deviceName = input("Název headsetu", "Quest")
        deviceName.setText(preferences.getString("device_name", deviceName.text.toString()))
        root.addView(backendUrl)
        root.addView(deviceName)
        val configureButton = Button(this).apply {
            text = "Uložit a otevřít agent"
            setOnClickListener { configureAgent() }
        }
        root.addView(configureButton)
        status = TextView(this).apply {
            text = "Agent vykonává příkazy a běží i bez tohoto GUI."
            setPadding(0, 24, 0, 0)
        }
        root.addView(status)
        setContentView(root)
    }

    private fun configureAgent() {
        val url = backendUrl.text.toString().trim().trimEnd('/')
        val name = deviceName.text.toString().trim()
        if (url.isBlank() || name.isBlank()) {
            status.text = "Vyplňte URL backendu a název headsetu."
            return
        }
        preferences.edit().putString("backend_url", url).putString("device_name", name).apply()
        sendBroadcast(Intent().apply {
            component = ComponentName("cz.orbit.quest", "cz.orbit.quest.AgentConfigurationReceiver")
            action = "cz.orbit.quest.action.CONFIGURE"
            putExtra("backend_url", url)
            putExtra("device_name", name)
        })
        startActivity(Intent().apply {
            component = ComponentName("cz.orbit.quest", "cz.orbit.quest.MainActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        status.text = "Agent byl nakonfigurován."
    }

    private fun input(hint: String, value: String) = EditText(this).apply {
        this.hint = hint
        setText(value)
        textSize = 16f
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, 16, 0, 16)
    }
}