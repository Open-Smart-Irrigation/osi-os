# CLAUDE.md — OSI OS Developer & AI Context

## What This Project Is

**OSI OS** (Open Smart Irrigation OS) is a custom OpenWrt 24.10-based embedded Linux firmware for Raspberry Pi 5 LoRaWAN gateways. It enables offline-first smart irrigation management for smallholder farmers, combining:

- **ChirpStack** — LoRaWAN network server receiving sensor/valve data over LoRa radio
- **Node-RED** — backend logic engine, REST API, irrigation scheduler
- **SQLite** — persistent local database
- **React** — farmer-facing web dashboard

Current version: **0.5.0 Alpha**. Primary focus: Raspberry Pi 5 (`full_raspberrypi_bcm27xx_bcm2712`).

---

## Repository Structure

```
osi-os/
├── CLAUDE.md                          # This file
├── README.md                          # Project README
├── BUILD-Readme.md                    # Firmware build instructions
├── Makefile                           # Build orchestration (init/devshell/switch-env)
├── Jenkinsfile                        # CI/CD pipeline (12 stages)
├── docker-compose.yml                 # Docker build environment
├── Dockerfile-devel                   # Dev container (Debian + OpenWrt deps)
├── feeds.conf.default                 # OpenWrt feed sources
├── prepare_release.sh                 # Release script
│
├── web/react-gui/                     # React frontend (TypeScript + Tailwind + Vite)
│   ├── src/
│   │   ├── App.tsx                    # Routes: /login, /register, /dashboard
│   │   ├── pages/
│   │   │   ├── FarmingDashboard.tsx   # Main UI — zones, devices, schedules
│   │   │   ├── Login.tsx
│   │   │   └── Register.tsx
│   │   ├── components/farming/        # Device UI components
│   │   │   ├── KiwiSensorCard.tsx     # Soil sensor display
│   │   │   ├── StregaValveCard.tsx    # Valve OPEN/CLOSE control
│   │   │   ├── IrrigationZoneCard.tsx # Zone + device assignment
│   │   │   ├── ScheduleSection.tsx    # Schedule editor (threshold, duration)
│   │   │   ├── AddDeviceModal.tsx     # Register device by DevEUI
│   │   │   ├── AssignDeviceModal.tsx  # Assign device to zone
│   │   │   └── CreateZoneModal.tsx    # Create irrigation zone
│   │   ├── contexts/AuthContext.tsx   # JWT token storage (localStorage)
│   │   ├── services/api.ts            # Axios client + interceptors
│   │   └── types/farming.ts          # All TypeScript interfaces
│   ├── vite.config.js                 # Dev proxy: /api + /auth → localhost:1880
│   ├── tailwind.config.js             # Custom farm colour palette
│   └── package.json
│
├── conf/                              # Per-target OpenWrt configs
│   └── full_raspberrypi_bcm27xx_bcm2712/   # PRIMARY TARGET (Pi 5)
│       ├── .config                    # OpenWrt package/kernel config
│       ├── files/
│       │   ├── usr/share/flows.json  # Node-RED flows (backend logic)
│       │   ├── usr/share/db/farming.db  # Pre-seeded SQLite DB (bundled)
│       │   └── etc/uci-defaults/     # First-boot UCI scripts
│       └── patches/                  # Quilt patches (boot, SPI, etc.)
│
├── feeds/chirpstack-openwrt-feed/     # ChirpStack + Node-RED packages
│   └── apps/
│       ├── node-red/                  # Node-RED OpenWrt package
│       │   └── files/
│       │       ├── settings.js        # Node-RED config (port 1880, /gui)
│       │       ├── node-red.init      # procd init (START=99)
│       │       └── node-red.nginx     # nginx proxy config
│       └── node-red-node-sqlite/      # SQLite plugin + alternate init
│
├── database/farming.db               # Source-of-truth DB schema
└── openwrt/                          # OpenWrt 24.10 source (git submodule)
```

---

## Critical File Locations

### On the Running Raspberry Pi

| What | Path |
|---|---|
| Node-RED flows | `/srv/node-red/flows.json` |
| SQLite database | `/data/db/farming.db` |
| React GUI static files | `/usr/lib/node-red/gui/` |
| Node-RED settings | `/srv/node-red/settings.js` |
| Node-RED init script | `/etc/init.d/node-red` |
| Node-RED start/stop | `/etc/init.d/node-red start` / `stop` |
| Web UI | `http://<device-ip>:1880/gui` |
| WiFi AP | SSID: `OSI-OS-<mac-suffix>`, password: `opensmartirrigation` |

### In the Repository (Pi 5 target)

| What | Path |
|---|---|
| Node-RED flows source | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` |
| Database source | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` |
| React source | `web/react-gui/src/` |
| Node-RED settings | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` |

> **Note:** The DB is bundled at `/usr/share/db/farming.db` in the firmware and the flows at `/usr/share/flows.json`. A first-boot init script is still needed to copy these to `/data/db/` and `/srv/node-red/` respectively. Currently this is done manually during device setup.

---

## Architecture: How the Layers Connect

```
Farmer's Browser
    ↕ HTTP (port 1880/gui, React SPA)
Node-RED (localhost:1880)
    ├── REST API  (/api/*, /auth/*)
    ├── Scheduler (cron-like, SWT threshold checks)
    ├── MQTT subscriber (sensor uplinks from ChirpStack)
    └── MQTT publisher (valve downlinks to ChirpStack)
    ↕ SQLite (/data/db/farming.db)
ChirpStack (LoRaWAN NS, localhost:8080)
    ↕ MQTT (localhost:1883)
ChirpStack Concentratord (packet forwarder)
    ↕ LoRa radio
Field devices (KIWI soil sensors, STREGA valves)
```

**MQTT Application IDs (hardcoded in flows.json — update per device):**
- KIWI sensors: `application/3f268526-2f47-48c7-8b8c-0cae26fc3a7e/device/#`
- Field tester: `application/ac0fa0cb-8775-418e-8181-6346862660d5/#`
- Valve downlinks: `application/af28ecae-1af8-4ffe-8576-76384b6805ca/device/{devEui}/command/down`

---

## Database Schema (farming.db)

```
users              — username, password_hash (plaintext — MVP only), created_at
farms              — farm_id (text PK), claim_code_hash, name
devices            — deveui (PK), name, type_id, user_id, farm_id,
                     current_state, target_state, irrigation_zone_id, chirpstack_app_id
device_data        — deveui, swt_wm1, swt_wm2, light_lux,
                     ambient_temperature, relative_humidity, recorded_at
irrigation_zones   — id, name, user_id, created_at, deleted_at (soft delete)
irrigation_schedules — irrigation_zone_id (UNIQUE), trigger_metric,
                       threshold_kpa, enabled, duration_minutes, last_triggered_at
irrigation_events  — user_id, zone_id, action, reason, aggregate_kpa,
                     threshold_kpa, duration_minutes, valve_deveui
actuator_log       — deveui, action, duration_minutes, reason, irrigation_zone_id
field_tester_uplinks / field_tester_rxinfo — RAK 10701 coverage testing
```

**Device types** (`type_id`): `KIWI_SENSOR`, `STREGA_VALVE`
**Trigger metrics**: `SWT_WM1`, `SWT_WM2`, `SWT_AVG`

---

## Node-RED Flow Tabs

| Tab | Purpose |
|---|---|
| Authentication | POST /auth/login, /auth/register |
| Device Management | All /api/* REST endpoints |
| Scheduler | Automated irrigation (SWT threshold checks) |
| Sensor_KIWI | MQTT uplink → decode Hz→kPa → INSERT device_data |
| Actuator_STREGA | actuator_command → MQTT downlink → actuator_log |
| Simulations (Dev) | Dev/test helpers (disabled by default) |
| Field testing | RAK 10701 MQTT uplink handling |
| Download Sensor Data | CSV/DB file download endpoints |

---

## REST API Surface

```
POST   /auth/login                              → { token }
POST   /auth/register                           → { success }

GET    /api/devices                             → Device[]
POST   /api/devices                             → Device
DELETE /api/devices/:deveui
GET    /api/catalog                             → DeviceCatalogItem[]
POST   /api/valve/:deveui                       { action, duration_minutes }

GET    /api/irrigation-zones                    → IrrigationZone[]
POST   /api/irrigation-zones                    → IrrigationZone
DELETE /api/irrigation-zones/:id
PUT    /api/irrigation-zones/:id/devices/:deveui
DELETE /api/irrigation-zones/:id/devices/:deveui
PUT    /api/irrigation-zones/:id/schedule       { trigger_metric, threshold_kpa, enabled, duration_minutes }

GET    /download/database
GET    /download-sensordata
GET    /download-fieldtest
```

**Auth:** `Authorization: Bearer <token>` where token = `base64(username:timestamp)`.
No HMAC — adequate for offline/LAN use only. Must be upgraded before internet-facing deployment.

---

## Development Workflow

The firmware build is currently broken. Development is done by:

1. **Direct Pi editing** — SSH into Pi, edit `/srv/node-red/flows.json` directly, then restart: `/etc/init.d/node-red restart`
2. **Dev Node-RED server** — Run Node-RED locally on a dev machine, pointing at a local SQLite DB copy
3. **React dev server** — `cd web/react-gui && npm run dev` (proxies /api and /auth to localhost:1880)

After editing flows locally, copy back to the Pi:
```bash
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json root@<pi-ip>:/srv/node-red/flows.json
/etc/init.d/node-red restart    # run on Pi
```

After editing React locally:
```bash
cd web/react-gui
npm run build
scp -r build/* root@<pi-ip>:/usr/lib/node-red/gui/
```

---

## Adding a New Device Type (Pattern)

1. **Database**: Add new `type_id` value to the `CHECK` constraint in `devices` table. Add any new data columns to `device_data` (or a new table if the data model is very different).

2. **TypeScript types** (`web/react-gui/src/types/farming.ts`): Add the new type to `DeviceType`, add fields to `Device.latest_data`.

3. **Node-RED — new flow tab**: Create a tab named `Sensor_<DeviceName>` following the Sensor_KIWI pattern:
   - `mqtt in` node subscribing to the ChirpStack application topic
   - `function` node: decode raw payload → structured data
   - `function` node: build INSERT SQL for device_data
   - `sqlite` node: execute INSERT

4. **Node-RED — Device Management**: Add device type to the catalog returned by `GET /api/catalog`, and to the `Merge Data` function if the device has sensor readings.

5. **React — new card component** in `web/react-gui/src/components/farming/`: follow `KiwiSensorCard.tsx` as template.

6. **FarmingDashboard.tsx**: Render the new card in the appropriate section.

7. **Database file**: Update `database/farming.db` and all `conf/*/files/usr/share/db/farming.db` copies with the schema change.

---

## Known Issues & Active Work

### Bug: Valve error prompt on open/close
**Location:** `Device Management` tab → `Build actuator_command + DB writes` function node
**Cause:** `INSERT INTO actuator_log (deveui, action, duration_open, ...)` — column should be `duration_minutes`
**Status:** Fix pending

### Bug: Valve "last seen" shows wrong timestamp
**Cause:** No MQTT subscriber for valve uplinks. `device_data` has no valve rows. Falls back to `devices.updated_at`.
**Fix needed:** Add MQTT subscriber for valve uplinks in `Actuator_STREGA` tab; store uplink in `device_data` (sensor fields as NULL).
**Status:** Fix pending

### Missing: First-boot init script
**Cause:** `farming.db` is bundled at `/usr/share/db/farming.db` and `flows.json` at `/usr/share/flows.json`, but nothing copies them to `/data/db/` and `/srv/node-red/` on first boot.
**Status:** Needs implementation (UCI default script)

### Missing: Firmware build (CI/CD broken)
**Status:** Lower priority than feature work; manual deployment workflow in use

---

## Roadmap (in priority order)

1. **Fix valve bugs** (error prompt + last_seen)

2. **LSN50 Integration: Change the different modes via the GUI


---

## OSI Server Integration (Implemented)

The OSI Server is a live cloud service at `server.opensmartirrigation.org`. The Pi communicates via persistent MQTT WebSocket.

**Connection model (MQTT over WebSocket):**

```
Pi (OSI OS)                          OSI Server (cloud)
    │── devices/{eui}/heartbeat ──────>│  Every 60s — device presence
    │── devices/{eui}/telemetry ───────>│  Every uplink — sensor data
    │── devices/{eui}/status ──────────>│  State changes
    │── devices/{eui}/command_ack ─────>│  Command acknowledgement
    │<─ devices/{eui}/commands ─────────│  Commands from server UI
```

**Authentication:** Pi identifies by LoRa concentrator EUI (`0016C001F11766E7`). MQTT credentials stored in env vars `DEVICE_EUI` / `DEVICE_MQTT_PASSWORD` on the Pi. Managed in `OSI-Server Cloud Integration` flow tab.

**Commands supported (server → Pi):**
- `UPDATE_SCHEDULE` — updates `irrigation_schedules` table on Pi (zoneId, triggerMetric, thresholdKpa, durationMinutes, enabled)
- Valve commands (OPEN/CLOSE) via existing `Actuator_STREGA` tab

**Offline behaviour:** Pi operates fully independently. Commands sent while Pi is offline will be delivered when MQTT reconnects (QoS 1).

**CRITICAL — topic env var limitation:** Node-RED 4.x MQTT `in` node topic field does NOT expand env vars. Commands subscription topic is HARDCODED: `devices/0016C001F11766E7/commands`.

**OSI Server stack:** Spring Boot 3.4.3 / Java 21 / PostgreSQL 16 / Eclipse Paho MQTT / React 18 (Vite)
- Repo: `github.com/Open-Smart-Irrigation/osi-server`
- Docker: `rocky@83.228.220.63:~/docker/osi-server/docker/`
- Rebuild: `docker compose up --build -d`
- Frontend source MUST be in the repo — Docker builds from source, not pre-built dist

---

## Conventions & Notes

- **DevEUI normalization:** Always `UPPER()` — enforced by DB trigger and in all function nodes
- **Timestamps:** ISO 8601 strings in SQLite TEXT columns, always UTC
- **SQL escaping:** String interpolation with `replace(/'/g, "''")` — no parameterized queries (workaround for node-red-node-sqlite limitation)
- **CORS:** All HTTP endpoints include `Access-Control-Allow-Origin: *` + OPTIONS preflight handler
- **Shell on device:** OpenWrt uses `ash` (BusyBox), not bash
- **Node-RED service:** `procd`-managed via `/etc/init.d/node-red`
- **React build output:** `web/react-gui/build/` → deployed to `/usr/lib/node-red/gui/`
