package cz.orbit.launcher

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = getSharedPreferences("launcher", MODE_PRIVATE)
        val server = EditText(this).apply { hint = "Server URL"; setText(settings.getString("server", "http://192.168.1.100:8080")) }
        val name = EditText(this).apply { hint = "Název headsetu"; setText(settings.getString("name", "Quest 2")) }
        val serial = EditText(this).apply { hint = "Sériové číslo"; setText(settings.getString("serial", "")) }
        val key = EditText(this).apply { hint = "Registrační klíč"; setText(settings.getString("key", "")) }
        val status = TextView(this).apply { text = "Není připojeno"; setPadding(0, 24, 0, 24) }
        val connect = Button(this).apply { text = "Registrovat a spustit launcher" }
        connect.setOnClickListener {
            settings.edit().putString("server", server.text.toString().trim()).putString("name", name.text.toString().trim())
                .putString("serial", serial.text.toString().trim()).putString("key", key.text.toString()).apply()
            status.text = "Registruji zařízení…"
            startService(Intent(this, LauncherService::class.java))
            status.text = "Launcher běží na pozadí"
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 50, 40, 40)
            addView(TextView(context).apply { text = "Orbit Quest Launcher"; textSize = 24f })
            addView(server); addView(name); addView(serial); addView(key); addView(connect); addView(status)
        })
    }
}
