package cz.orbit.setup

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.json.JSONObject

class SetupActivity : Activity() {
    private val preferences by lazy { getSharedPreferences("orbit_setup", MODE_PRIVATE) }
    private val handler = Handler(Looper.getMainLooper())
    private val pollInFlight = AtomicBoolean(false)
    private lateinit var backendUrl: EditText
    private lateinit var deviceName: EditText
    private lateinit var status: TextView
    private lateinit var pairingPin: TextView
    private lateinit var pairButton: Button
    private lateinit var resetButton: Button

    private val pollTask = object : Runnable {
        override fun run() {
            pollPairingStatus()
            handler.postDelayed(this, 3_000L)
        }
    }

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
        root.addView(TextView(this).apply {
            text = "PIN PRO PÁROVÁNÍ"
            setPadding(0, 28, 0, 4)
        })
        pairingPin = TextView(this).apply {
            text = preferences.getString("pairing_pin", "----")
            textSize = 42f
            setTextColor(0xff218c83.toInt())
        }
        root.addView(pairingPin)
        pairButton = Button(this).apply {
            text = "Spustit párování"
            setOnClickListener { startPairing() }
        }
        root.addView(pairButton)
        resetButton = Button(this).apply {
            text = "Resetovat připojení"
            setOnClickListener { resetPairing() }
        }
        root.addView(resetButton)
        status = TextView(this).apply {
            text = ""
            setPadding(0, 24, 0, 0)
        }
        root.addView(status)
        setContentView(root)
        status.text = when {
            preferences.getBoolean("paired", false) -> "Headset je spárovaný a agent běží."
            pendingPairingId() != null -> "Čekám na potvrzení PINu ve webu."
            else -> "Agent se nastaví po potvrzení párování."
        }
        updateControls()
    }

    override fun onStart() {
        super.onStart()
        if (pendingPairingId() != null) {
            handler.removeCallbacks(pollTask)
            handler.post(pollTask)
        }
    }

    override fun onStop() {
        handler.removeCallbacks(pollTask)
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacks(pollTask)
        super.onDestroy()
    }

    private fun startPairing() {
        val url = backendUrl.text.toString().trim().trimEnd('/')
        val name = deviceName.text.toString().trim()
        if (url.isBlank() || name.isBlank()) {
            status.text = "Vyplňte URL backendu a název headsetu."
            return
        }
        val pin = (1000..9999).random().toString()
        val nonce = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "")
        preferences.edit()
            .putString("backend_url", url)
            .putString("device_name", name)
            .putString("pairing_pin", pin)
            .putString("pairing_nonce", nonce)
            .remove("pairing_id")
            .putBoolean("paired", false)
            .apply()
        pairingPin.text = pin
        status.text = "Odesílám žádost o párování..."
        updateControls()
        thread {
            try {
                val response = request(
                    "POST",
                    "$url/api/pairing/discover",
                    JSONObject()
                        .put("name", name)
                        .put("serial_number", android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID) ?: UUID.randomUUID().toString())
                        .put("model", "Meta Quest 2")
                        .put("nonce", nonce)
                        .put("pin", pin)
                        .toString(),
                )
                preferences.edit().putString("pairing_id", JSONObject(response).getString("id")).apply()
                runOnUiThread {
                    status.text = "Čekám na potvrzení PINu ve webu."
                    updateControls()
                    handler.removeCallbacks(pollTask)
                    handler.post(pollTask)
                }
            } catch (error: Exception) {
                runOnUiThread {
                    status.text = "Párování selhalo: ${error.message ?: "neznámá chyba"}"
                    updateControls()
                }
            }
        }
    }

    private fun pollPairingStatus() {
        val url = preferences.getString("backend_url", null) ?: return
        val pairingId = pendingPairingId() ?: return
        if (!pollInFlight.compareAndSet(false, true)) return
        thread {
            try {
                val pairing = JSONObject(request("GET", "$url/api/pairing/$pairingId", null))
                when (pairing.getString("status")) {
                    "confirmed" -> markPaired(pairing.optString("device_id"))
                    "expired", "rejected" -> runOnUiThread {
                        preferences.edit().remove("pairing_id").apply()
                        status.text = "Párování vypršelo nebo bylo odmítnuto."
                        updateControls()
                    }
                }
            } catch (_: Exception) {
                runOnUiThread { status.text = "Čekám na odpověď backendu..." }
            } finally {
                pollInFlight.set(false)
            }
        }
    }

    private fun markPaired(deviceId: String) {
        if (deviceId.isBlank()) return
        val url = preferences.getString("backend_url", null) ?: return
        val name = preferences.getString("device_name", null) ?: return
        preferences.edit()
            .putBoolean("paired", true)
            .putString("device_id", deviceId)
            .remove("pairing_id")
            .remove("pairing_nonce")
            .apply()
        sendAgentConfiguration(url, name, deviceId)
        runOnUiThread {
            handler.removeCallbacks(pollTask)
            status.text = "Headset je spárovaný a agent běží."
            updateControls()
        }
    }

    private fun resetPairing() {
        handler.removeCallbacks(pollTask)
        val url = preferences.getString("backend_url", "") ?: ""
        val name = preferences.getString("device_name", "Quest") ?: "Quest"
        sendBroadcast(Intent().apply {
            component = ComponentName("cz.orbit.quest", "cz.orbit.quest.AgentConfigurationReceiver")
            action = "cz.orbit.quest.action.RESET"
        }, "cz.orbit.quest.permission.CONFIGURE_AGENT")
        preferences.edit()
            .putBoolean("paired", false)
            .remove("pairing_id")
            .remove("device_id")
            .apply()
        status.text = "Připojení bylo resetováno."
        pairingPin.text = "----"
        updateControls()
        if (url.isNotBlank()) {
            backendUrl.setText(url)
            deviceName.setText(name)
        }
    }

    private fun sendAgentConfiguration(url: String, name: String, deviceId: String) {
        sendBroadcast(Intent().apply {
            component = ComponentName("cz.orbit.quest", "cz.orbit.quest.AgentConfigurationReceiver")
            action = "cz.orbit.quest.action.CONFIGURE"
            putExtra("backend_url", url)
            putExtra("device_name", name)
            putExtra("device_id", deviceId)
            putExtra("paired", true)
        }, "cz.orbit.quest.permission.CONFIGURE_AGENT")
    }

    private fun pendingPairingId() = preferences.getString("pairing_id", null)

    private fun updateControls() {
        val paired = preferences.getBoolean("paired", false)
        val pending = pendingPairingId() != null
        backendUrl.isEnabled = !paired && !pending
        deviceName.isEnabled = !paired && !pending
        pairButton.isEnabled = !paired && !pending
        resetButton.isEnabled = true
    }

    private fun request(method: String, url: String, body: String?): String {
        val connection = (URI(url).toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 5_000
            readTimeout = 5_000
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) connection.outputStream.use { it.write(body.toByteArray()) }
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("Backend vrátil HTTP $code.")
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun input(hint: String, value: String) = EditText(this).apply {
        this.hint = hint
        setText(value)
        textSize = 16f
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, 16, 0, 16)
    }
}