package cz.orbit.quest

import android.app.Activity
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var backendUrl: EditText
    private lateinit var deviceName: EditText
    private lateinit var status: TextView
    private lateinit var pairButton: Button
    private val serialNumber by lazy {
        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: UUID.randomUUID().toString()
    }
    private val pairingPin = (1000..9999).random().toString()
    private val nonce = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "")

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
            text = "Odeslat discovery"
            setOnClickListener { sendDiscovery() }
        }
        root.addView(pairButton)

        status = description("Stav: čeká na odeslání discovery.")
        status.setPadding(0, 24, 0, 0)
        root.addView(status)
        setContentView(scroll)
    }

    private fun sendDiscovery() {
        val baseUrl = backendUrl.text.toString().trim().trimEnd('/')
        val name = deviceName.text.toString().trim()
        if (baseUrl.isBlank() || name.isBlank()) {
            status.text = "Vyplňte URL backendu a název headsetu."
            return
        }
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
                val message = if (code in 200..299) {
                    "Discovery odesláno. Ve webu potvrďte zařízení PINem $pairingPin."
                } else {
                    "Backend vrátil HTTP $code. Zkontrolujte URL a dostupnost sítě."
                }
                connection.disconnect()
                runOnUiThread { status.text = "Stav: $message"; pairButton.isEnabled = true }
            } catch (error: Exception) {
                runOnUiThread {
                    status.text = "Stav: odeslání selhalo: ${error.message ?: "neznámá chyba"}"
                    pairButton.isEnabled = true
                }
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
