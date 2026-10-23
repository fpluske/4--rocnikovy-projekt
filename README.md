# Orbit Quest Management

Prototyp webové aplikace pro správu Meta Quest headsetů. Obsahuje FastAPI backend,
React frontend a SQLite databázi uloženou v persistentním Docker volume.

## Spuštění

Požadavky:

- Docker
- Docker Compose v2

```bash
docker compose up --build
```

Webová aplikace bude dostupná na <http://localhost:8080>, API dokumentace na
<http://localhost:8000/docs> a kontrola dostupnosti backendu na
<http://localhost:8000/api/health>.

Dashboard v hlavičce zobrazuje, jestli je backend dostupný. Stav se ověřuje
při načtení a každých deset sekund; při nedostupnosti zůstává poslední načtený
seznam zařízení zobrazený a indikátor se přepne na „Server odpojen“.

Pro zastavení:

```bash
docker compose down
```

Databáze zůstává v volume `orbit-data`. Pro kompletní reset lokálních dat lze
explicitně použít `docker compose down -v`.

## Databázový model

Backend při startu vytvoří následující tabulky. Prototyp zatím používá
`Base.metadata.create_all`; před produkčním nasazením bude nahrazen Alembic
migracemi.

- **`devices`** – registrované headsety, sériové číslo, model, stav, baterie,
  firmware, IP adresa, aktuální aplikace a poslední kontakt.
- **`commands`** – fronta příkazů pro zařízení (`restart`, `shutdown`, `lock`,
  `unlock`, `update`) a jejich životní cyklus
  (`queued` → `sent` → `acknowledged` → `completed` nebo `failed`).
- **`update_packages`** – metadata budoucích balíčků aktualizací, URL a checksum.
- **`audit_events`** – neměnitelný základ auditní historie registrací, příkazů
  a pozdějších heartbeatů.
- **`pairing_requests`** – krátkodobé discovery žádosti s nonce, hashí PINu,
  expirací a stavem (`pending`, `confirmed`, `expired`, `rejected`).

Vztahy:

```text
devices 1 ─── N commands
devices 1 ─── N audit_events
```

Záměrně nejsou vložena žádná demo data. Zařízení se registruje přes dashboard
nebo později přes autentizovaný Quest agent.

## API prototypu

- `GET /api/health`
- `GET /api/devices`
- `POST /api/devices`
- `POST /api/devices/heartbeat`
- `DELETE /api/devices/{device_id}`
- `GET /api/devices/{device_id}/commands`
- `POST /api/devices/{device_id}/commands`
- `GET /api/events`
- `GET /api/pairing`
- `POST /api/pairing/discover`
- `GET /api/pairing/{pairing_id}`
- `POST /api/pairing/{pairing_id}/confirm`
- `POST /api/pairing/{pairing_id}/reject`
- `WS /api/webrtc/{device_id}` – WebRTC signalizační relay pro živý obraz
- `GET /api/webrtc/config` – ICE/STUN/TURN konfigurace pro WebRTC klienty

Autentizace, skutečné doručování příkazů agentovi a PostgreSQL jsou navazující
kroky. Připojení k PostgreSQL lze připravit nastavením `DATABASE_URL`;
výchozí hodnota je `sqlite:///./data/orbit.db`.

Při prvním spuštění si aplikace zapamatuje URL backendu a ID párovací žádosti.
Po potvrzení PINu ve webu uloží stav jako spárovaný. Při dalších spuštěních se
automaticky připojí k uloženému backendu bez nového párování. Spárovaný Quest
agent posílá heartbeat každých deset sekund a přímo v aplikaci zobrazuje, zda
server odpověděl. Zařízení je po úspěšném heartbeatu
označeno jako `online`; pokud backend neobdrží heartbeat déle než třicet sekund,
dashboard jej při dalším načtení označí jako `offline`.

## Párovací flow

1. Quest aplikace později vyšle discovery zprávu s názvem, sériovým číslem,
   nonce a důkazem čtyřmístného PINu.
2. Backend vytvoří žádost s expirací pět minut; žádost se zobrazí v dashboardu.
3. Administrátor přepíše PIN z obrazovky headsetu do dashboardu.
4. Backend ověří PIN přes nonce, vytvoří zařízení a označí žádost jako potvrzenou.

V aktuálním prototypu je discovery dostupné přes `POST /api/pairing/discover`;
UDP broadcast/multicast transport bude napojen později na stejný endpoint.

## Živý obraz headsetu

Dashboard obsahuje u online zařízení tlačítko **Živě**. Prohlížeč naváže
WebRTC spojení přes signalizační WebSocket a Android aplikace po systémovém
potvrzení sdílení obrazovky odešle aktuální obraz headsetu. Tlačítko lze použít
u více zařízení a všechny vybrané přenosy se zobrazí současně v galerii; každý
přenos lze samostatně ukončit nebo otevřít na celou obrazovku. Backend pouze
přeposílá WebRTC SDP a ICE zprávy; obrazová data přes něj neprocházejí.
V seznamu zařízení lze přenosy předem vybrat zaškrtávacími políčky a následně
je spustit jedním tlačítkem; dostupná je také rychlá volba všech online headsetů.
Před použitím živého obrazu musí být headset online a aplikace musí být
spárovaná se stejným backendem.

Pro sítě, ve kterých přímé ICE spojení neprojde, nastavte TURN server přes
proměnnou `WEBRTC_ICE_SERVERS`. Hodnota je JSON pole kompatibilní s konfigurací
`RTCPeerConnection`, například:

```text
WEBRTC_ICE_SERVERS=[{"urls":["stun:turn.example.com:3478","turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"],"username":"user","credential":"password"}]
```

Android aplikace i web si tuto konfiguraci načtou z `/api/webrtc/config`.
