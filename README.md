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
  expirací a stavem (`pending`, `confirmed`, `expired`).

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
- `DELETE /api/devices/{device_id}`
- `GET /api/devices/{device_id}/commands`
- `POST /api/devices/{device_id}/commands`
- `GET /api/events`
- `GET /api/pairing`
- `POST /api/pairing/discover`
- `POST /api/pairing/{pairing_id}/confirm`

Autentizace, skutečné doručování příkazů agentovi, heartbeat a PostgreSQL jsou
navazující kroky. Připojení k PostgreSQL lze připravit nastavením `DATABASE_URL`;
výchozí hodnota je `sqlite:///./data/orbit.db`.

## Párovací flow

1. Quest aplikace později vyšle discovery zprávu s názvem, sériovým číslem,
   nonce a důkazem čtyřmístného PINu.
2. Backend vytvoří žádost s expirací pět minut; žádost se zobrazí v dashboardu.
3. Administrátor přepíše PIN z obrazovky headsetu do dashboardu.
4. Backend ověří PIN přes nonce, vytvoří zařízení a označí žádost jako potvrzenou.

V aktuálním prototypu je discovery dostupné přes `POST /api/pairing/discover`;
UDP broadcast/multicast transport bude napojen později na stejný endpoint.
