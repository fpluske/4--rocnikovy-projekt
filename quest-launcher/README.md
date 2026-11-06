# Orbit Quest pairing app

## Aplikace Agent a Setup

Projekt nyní vytváří dvě APK:

- `app` / `cz.orbit.quest` – Orbit Agent. Je device owner, obsahuje heartbeat,
  vykonávání příkazů, boot receiver a WebRTC foreground service. Nemá launcher
  obrazovku pro běžné používání.
- `setup` / `cz.orbit.setup` – Orbit Setup. Je běžné konfigurační GUI, které
  předává URL backendu a název headsetu agentovi přes chráněný broadcast.

Agentova Activity se otevře pouze při prvním párování nebo při systémovém
potvrzení sdílení obrazovky. Po spárování a při startu headsetu se Agent pokusí
dialog pro sdílení obrazovky otevřít automaticky. Android ale stále vyžaduje
potvrzení uživatelem; po potvrzení převezme sdílení foreground service. Po
dokončení konfigurace může být Setup ukončen, agentové služby na něm nejsou
závislé.

Sestavení obou APK:

```bash
./gradlew :app:assembleDebug :setup:assembleDebug
```

Výsledné soubory jsou v `app/build/outputs/apk/debug/` a
`setup/build/outputs/apk/debug/`.

Minimální Android aplikace pro první spárování headsetu s Orbit backendem.

Aplikace obsahuje `DeviceAdminReceiver`, takže ji lze při provisioningu nastavit
jako device owner. Samotné přidání receiveru nemění oprávnění aplikace; device
owner se nastavuje pouze během úvodního nastavení zařízení nebo podporovaným
enterprise provisioningem.

## Spuštění

Otevři adresář `quest-launcher` v Android Studiu a spusť aplikaci na Questu.
V aplikaci nastav URL backendu dostupnou ze stejné sítě jako headset, například:

```text
http://192.168.1.10:8000
```

`localhost` ani `127.0.0.1` na headsetu neodkazují na počítač s backendem.

## Device owner provisioning

Po sestavení a instalaci APK lze ověřit dostupnost admin komponenty:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell dumpsys package cz.orbit.quest | grep -A 10 -B 5 DeviceAdmin
```

Na čistém, dosud neprovisionovaném zařízení lze aplikaci nastavit jako device
owner:

```bash
adb shell dpm set-device-owner \
  cz.orbit.quest/.OrbitDeviceAdminReceiver
```

Pokud zařízení už dokončilo úvodní nastavení (`device_provisioned=1`), Android
obvykle vyžaduje factory reset nebo enterprise provisioning. Smazání Meta účtu
tento stav samo o sobě nezmění. Stav ownera lze ověřit příkazem:

```bash
adb shell dpm list-owners
```

Aplikace odešle:

```text
POST /api/pairing/discover
```

Po úspěšném odeslání se žádost zobrazí ve webu na `http://localhost:8080`.
Administrátor zadá PIN zobrazený v headsetu a zařízení se spáruje.

Identifikátor zařízení je v tomto prototypu `ANDROID_ID`. Později jej nahradíme
stabilním identifikátorem z Quest/enterprise správy, pokud bude dostupný.

Po potvrzení párování si aplikace uloží URL backendu do lokálního úložiště.
Při dalších spuštěních ji použije automaticky a nové párování nevyžaduje.
Stav připojení se ověřuje heartbeat zprávou každých deset sekund a zobrazuje se
přímo v aplikaci jako připojený nebo odpojený server.
Při zhasnutí displeje agent hlásí backendu stav `standby`; po probuzení jej
změní zpět na `online`.

Po spárování aplikace skryje ovládání nového párování a zobrazí tlačítko
**Reset**. Jeho použitím se uložené spojení smaže, vygeneruje se nové párování
a aplikace se vrátí do párovacího režimu.

Pokud je headset online, lze v dashboardu stisknout **Živě**. Aplikace si
vyžádá systémové oprávnění ke sdílení obrazovky a následně obraz odešle přímo
do prohlížeče přes WebRTC. Backend slouží pouze jako signalizační relay.
