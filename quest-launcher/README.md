# Orbit Quest Launcher

Android/Kotlin launcher pro Quest 2. Launcher se registruje k backendu Orbitu,
posílá heartbeat a každých 5 sekund vyzvedává příkazy z webové administrace.

## Konfigurace

1. Spusť backend s registračním klíčem:

   ```bash
   LAUNCHER_REGISTRATION_KEY=local-dev-key docker compose up --build
   ```

2. V launcheru zadej URL backendu dostupnou z Questu (např. `http://192.168.1.10:8080`)
   a stejný registrační klíč.
3. Launcher vytvoří headset v seznamu webu. Pro existující zařízení použij stejné
   sériové číslo.

## Omezení prototypu

Přenos obrazu, skutečná aktualizace APK a vypnutí/restart vyžadují Quest/Android
device-owner oprávnění a podepsaný release build. Tento prototyp už řeší bezpečný
protokol registrace, heartbeat a frontu příkazů, ale privilegované akce je nutné
ověřit na konkrétním spravovaném Questu.
