# Orbit Quest pairing app

Minimální Android aplikace pro první spárování headsetu s Orbit backendem.

## Spuštění

Otevři adresář `quest-launcher` v Android Studiu a spusť aplikaci na Questu.
V aplikaci nastav URL backendu dostupnou ze stejné sítě jako headset, například:

```text
http://192.168.1.10:8000
```

`localhost` ani `127.0.0.1` na headsetu neodkazují na počítač s backendem.

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

Po spárování aplikace skryje ovládání nového párování a zobrazí tlačítko
**Reset**. Jeho použitím se uložené spojení smaže, vygeneruje se nové párování
a aplikace se vrátí do párovacího režimu.

Pokud je headset online, lze v dashboardu stisknout **Živě**. Aplikace si
vyžádá systémové oprávnění ke sdílení obrazovky a následně obraz odešle přímo
do prohlížeče přes WebRTC. Backend slouží pouze jako signalizační relay.
