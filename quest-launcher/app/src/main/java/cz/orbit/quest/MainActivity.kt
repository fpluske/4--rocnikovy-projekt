package cz.orbit.quest

import android.app.Activity
import android.content.SharedPreferences
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URISyntaxException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONException
import org.json.JSONObject
import kotlin.concurrent.thread

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
    }

    private val preferences: SharedPreferences by lazy {
        getSharedPreferences(PREFS, MODE_PRIVATE)
    }
    private lateinit var backendUrl: EditText
    private lateinit var deviceName: EditText
    private lateinit var status: TextView
    private lateinit var pairButton: Button
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
    private val pairingPin by lazy {
        preferences.getString(PAIRING_PIN, null) ?: (1000..9999).random().toString().also {
            preferences.edit().putString(PAIRING_PIN, it).apply()
        }
    }
    private val nonce by lazy {
        preferences.getString(PAIRING_NONCE, null) ?: (UUID.randomUUID().toString().replace("-", "") +
            UUID.randomUUID().toString().replace("-", "")).also {
            preferences.edit().putString(PAIRING_NONCE, it).apply()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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

        root.addView(label("PIN PRO PÁROVÁNÍ").apply {
            setPadding(0, 32, 0, 4)
        })
        root.addView(TextView(this).apply {
            text = pairingPin
            textSize = 42f
            gravity = Gravity.CENTER
            setTextColor(0xff218c83.toInt())
            setPadding(0, 8, 0, 24)
        })

        pairButton = Button(this).apply {
            text = if (isPaired()) "Headset je spárovaný" else "Spárovat headset"
            setOnClickListener { sendDiscovery() }
        }
        root.addView(pairButton)

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
    }

    override fun onStop() {
        heartbeatHandler.removeCallbacks(heartbeatTask)
        pairingHandler.removeCallbacks(pairingPollTask)
        super.onStop()
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
                    "confirmed" -> markPaired(baseUrl)
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

    private fun markPaired(baseUrl: String) {
        preferences.edit()
            .putString(PAIRED_BACKEND_URL, baseUrl)
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

    private fun pendingPairingId() = preferences.getString(PENDING_PAIRING_ID, null)

    private fun isPaired() = !preferences.getString(PAIRED_BACKEND_URL, null).isNullOrBlank()

    private fun updatePairingControls() {
        if (!::pairButton.isInitialized) return
        val paired = isPaired()
        backendUrl.isEnabled = !paired
        deviceName.isEnabled = !paired
        pairButton.isEnabled = !paired && pendingPairingId() == null
        pairButton.text = if (paired) "Headset je spárovaný" else "Spárovat headset"
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
                connection.responseCode
                connection.disconnect()
            } catch (error: IOException) {
                Log.w("OrbitQuest", "Heartbeat se nepodařilo odeslat.", error)
            } catch (error: IllegalArgumentException) {
                Log.w("OrbitQuest", "URL backendu pro heartbeat není platná.", error)
            } finally {
                heartbeatInFlight.set(false)
            }
        }
    }

    private fun json(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

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
