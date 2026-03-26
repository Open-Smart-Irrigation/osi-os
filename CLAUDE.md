# CLAUDE.md — OSI OS Developer & AI Context

This file is kept for backward compatibility and quick project onboarding.

For the most current implementation handoff, also see:

- [AGENTS.md](/home/phil/Repos/osi-os/AGENTS.md)

The intent is:

- `CLAUDE.md` keeps the broader repo/build/runtime context
- `AGENTS.md` tracks the current implementation state and recent architectural changes

---

## What This Project Is

**OSI OS** (Open Smart Irrigation OS) is a custom OpenWrt 24.10-based embedded Linux firmware for Raspberry Pi 5 LoRaWAN gateways. It enables offline-first smart irrigation management for smallholder farmers, combining:

- **ChirpStack** — LoRaWAN network server receiving sensor/valve data over LoRa radio
- **Node-RED** — backend logic engine, REST API, irrigation scheduler, sync orchestration
- **SQLite** — persistent local database
- **React** — farmer-facing web dashboard

Primary target:

- Raspberry Pi 5 (`full_raspberrypi_bcm27xx_bcm2712`)

Current branch focus:

- `dendrov2`

Current architectural rule:

- **`osi-os` is the operational source of truth**
- **`osi-server` mirrors edge-backed farms**

---

## Repository Structure

```text
osi-os/
├── AGENTS.md                           # Current implementation handoff
├── CLAUDE.md                           # Broad project context / compatibility doc
├── README.md
├── BUILD-Readme.md
├── Makefile
├── Jenkinsfile
├── docker-compose.yml
├── Dockerfile-devel
├── feeds.conf.default
├── prepare_release.sh
│
├── web/react-gui/                      # React frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── FarmingDashboard.tsx
│   │   │   ├── Login.tsx
│   │   │   ├── Register.tsx
│   │   │   └── AccountLink.tsx
│   │   ├── components/farming/
│   │   ├── contexts/AuthContext.tsx
│   │   ├── services/api.ts
│   │   └── types/farming.ts
│   ├── public/locales/
│   └── package.json
│
├── conf/
│   └── full_raspberrypi_bcm27xx_bcm2712/
│       ├── .config
│       ├── files/
│       │   ├── usr/share/flows.json    # Main Node-RED flow source
│       │   ├── usr/share/db/farming.db
│       │   └── etc/uci-defaults/
│       └── patches/
│
├── feeds/chirpstack-openwrt-feed/
│   └── apps/
│       ├── node-red/
│       └── node-red-node-sqlite/
│
├── database/farming.db
├── scripts/
│   └── verify-sync-flow.js
└── openwrt/
```

---

## Critical File Locations

### On the running Raspberry Pi

| What | Path |
|---|---|
| Node-RED flows | `/srv/node-red/flows.json` |
| SQLite database | `/data/db/farming.db` |
| React GUI static files | `/usr/lib/node-red/gui/` |
| Node-RED settings | `/srv/node-red/settings.js` |
| Node-RED init script | `/etc/init.d/node-red` |
| Web UI | `http://<device-ip>:1880/gui` |

### In the repo

| What | Path |
|---|---|
| Node-RED flows source | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` |
| Database source | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` |
| React source | `web/react-gui/src/` |
| Sync flow verifier | `scripts/verify-sync-flow.js` |
| Node-RED settings | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` |

---

## Architecture: How The Layers Connect

```text
Farmer Browser
    ↕ HTTP (/gui, React SPA)
Node-RED (localhost:1880)
    ├── REST API (/api/*, /auth/*)
    ├── Scheduler / irrigation logic
    ├── Dendrometer analytics
    ├── Sync bootstrap / outbox / pending-command loop
    ├── MQTT subscriber (sensor uplinks from ChirpStack)
    └── MQTT publisher (valve downlinks + cloud sync ACK path)
    ↕ SQLite (/data/db/farming.db)
ChirpStack (LoRaWAN NS)
    ↕ MQTT
Packet forwarder / concentrator
    ↕ LoRa radio
Field devices
```

---

## Current Important Implementation State

### Security

The old insecure auth assumptions are no longer accurate.

Current state:

- local auth tokens are **HMAC-signed**
- local passwords are **bcrypt-hashed**
- privileged endpoints now enforce stronger auth and ownership checks
- linked account login uses a **gateway-specific offline verifier**
- `/download/database` is gated

### Dendrometer

The dendrometer implementation on `dendrov2` is substantially overhauled:

- envelope-based TWD logic
- timezone-aware local-day processing
- QA/confidence logic
- zone aggregation with outlier handling
- edge-side authoritative dendro recommendations
- DENDRO schedule support on-device

### Sync

Bidirectional mirror foundations now exist between `osi-os` and `osi-server`.

Control-plane sync includes:

- zones
- schedules
- zone config/location
- device assignment / unassignment
- device flags
- device unclaim

Data-plane mirroring includes:

- sensor data
- dendrometer readings
- dendro daily rows
- zone daily recommendations
- zone daily environment
- irrigation events

Key sync concepts:

- `user_uuid`
- `zone_uuid`
- `gateway_device_eui`
- `sync_version`
- `deleted_at`
- `sync_outbox`
- `sync_inbox`
- `sync_cursor`

### Recovery

Current recovery features:

- proactive sync token refresh
- periodic bootstrap repair
- manual `Force Sync`
- re-auth recovery from expired sync tokens in the account-link page

---

## REST/API Surface Notes

Older docs that described auth as `base64(username:timestamp)` are outdated.

Important current local endpoints include:

```text
POST   /auth/login
POST   /auth/register

GET    /api/account-link/status
POST   /api/account-link
DELETE /api/account-link

GET    /api/sync/state
POST   /api/sync/force
```

Important cloud sync endpoints include:

```text
POST   /auth/local-sync
POST   /auth/refresh-sync

POST   /api/v1/sync/edge/bootstrap
POST   /api/v1/sync/edge/events
GET    /api/v1/sync/gateways/{gatewayEui}/pending-commands
GET    /api/v1/sync/gateways/{gatewayEui}/status
GET    /api/v1/sync/gateways/{gatewayEui}/reconciliation
```

---

## Development Workflow

The practical workflow is still:

1. Edit [flows.json](/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json)
2. Validate with:

```bash
node scripts/verify-sync-flow.js
```

3. Build frontend with:

```bash
cd web/react-gui
npm run build
```

4. Deploy to target device as needed

Common manual deployment pattern:

```bash
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json root@<pi-ip>:/srv/node-red/flows.json
scp -r web/react-gui/build/* root@<pi-ip>:/usr/lib/node-red/gui/
```

Then restart Node-RED on the Pi if needed.

---

## Adding A New Device Type

The general pattern is still:

1. Update DB schema
2. Update TypeScript types in `web/react-gui/src/types/farming.ts`
3. Add Node-RED ingest flow
4. Add catalog / merge logic
5. Add React card/component
6. Render it in the dashboard
7. Update bundled DB copies if schema changed

But for `dendrov2`, also consider:

- sync metadata requirements
- edge/cloud mirrored DTO shape
- whether the device participates in data-plane mirroring
- whether ChirpStack registration needs app/profile mapping

---

## Device Registration Notes

Device registration is intended to work through the GUI by registering through ChirpStack on the Pi.

Expected mapping:

- Kiwi -> `Sensors` application + Kiwi profile
- LSN50 -> `Sensors` application + LSN50 profile
- Valve -> `Actuators` application + valve profile

Registration success should now mean actual provisioning, not just a local DB insert.

This still needs real end-to-end runtime verification after the recent hardening and sync work.

---

## Known Important Gaps

These are still the main practical gaps to keep in mind:

- runtime end-to-end validation on real devices and real edge/cloud reconnect scenarios
- full UI parity/polish between `osi-os` and `osi-server`
- further operator-facing sync observability in the GUI
- firmware/build pipeline is still less important than product behavior and may remain rough

---

## Recommended Reading Order

For current implementation state:

1. [AGENTS.md](/home/phil/Repos/osi-os/AGENTS.md)
2. [flows.json](/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json)
3. [verify-sync-flow.js](/home/phil/Repos/osi-os/scripts/verify-sync-flow.js)
4. relevant frontend pages/components in `web/react-gui/src/`

For broad repo/build context:

1. this file
2. [README.md](/home/phil/Repos/osi-os/README.md)
3. [BUILD-Readme.md](/home/phil/Repos/osi-os/BUILD-Readme.md)

