# AGENTS.md — OSI OS / OSI Server Current Working Context

## Scope

This document reflects the current implementation state in the active working branches. It covers the communication architecture between osi-os (edge) and osi-server (cloud), security hardening, dendrometer logic, bidirectional sync, and the current Terra Intelligence standalone integration.

Working context for:

- `osi-os` at `/home/phil/Repos/osi-os`
- `osi-server` at `/home/phil/Repos/osi-server`

Architectural rule:

- **`osi-os` is the operational source of truth**
- **`osi-server` mirrors edge-backed farms**
- cloud-originated edits for synced resources should be treated as pending until the edge applies them

---

## Current Branches

- `osi-os`: `main`
- `osi-server`: `main`

> Note: the current live server and Pi rollout were deployed from local release snapshots before merge. The prediction-engine, admin prediction lab, and clustered Track B rollout work has now been consolidated back onto `osi-server` `main`.

---

## Communication Architecture: REST-Only Sync + MQTT Telemetry

The communication between osi-os and osi-server uses **two distinct protocols**:

```
┌─────────────────┐                    ┌─────────────────┐
│   OSI-OS Edge   │◄──────────────────►│  OSI-Server     │
│   (Gateway)     │   REST/HTTPS Sync   │  (Cloud)        │
│                 │   (Bidirectional)   │                 │
└────────┬────────┘                    └────────┬────────┘
         │                                      │
         │   ┌──────────────────┐               │
         └──►│  MQTT Broker     │               │
              │  (Telemetry +    │               │
              │   ACKs Only)    │               │
              └──────────────────┘
```

**Important**: Cloud → Edge commands flow via **REST polling**, NOT MQTT subscription. The edge is not subscribed to the cloud MQTT broker's command topics.

---

### REST (HTTP/HTTPS) — Full Bidirectional Sync

| osi-os calls → osi-server | Method | Purpose | Cadence |
|---------------------------|--------|---------|---------|
| `/auth/local-sync` | POST | Account linking + sync token acquisition | On-demand |
| `/auth/refresh-sync` | POST | Proactive sync token refresh | Every 1 hour |
| `/api/v1/sync/edge/bootstrap` | POST | Full state snapshot upload | Every 6 hours |
| `/api/v1/sync/edge/events` | POST | Incremental event outbox delivery | Every 30 seconds |
| `/api/v1/sync/gateways/{eui}/pending-commands` | GET | **Pull cloud-originated commands** | Every 30 seconds |
| `/api/v1/sync/gateways/{eui}/status` | GET | Sync state info | On-demand |
| `/api/v1/sync/gateways/{eui}/reconciliation` | GET | Full reconciliation status | On-demand |
| `/api/v1/devices/claim-bulk` | POST | Bulk device claiming during link | On-demand |

**Cloud → Edge command types (via REST pending-commands):**
- `UPSERT_ZONE`, `DELETE_ZONE` — zone management
- `UPSERT_SCHEDULE`, `UPDATE_SCHEDULE` — schedule changes
- `UPSERT_ZONE_CONFIG`, `UPSERT_ZONE_LOCATION` — zone configuration
- `ASSIGN_DEVICE_TO_ZONE`, `REMOVE_DEVICE_FROM_ZONE` — device assignment
- `UPSERT_DEVICE_FLAGS` — device flags
- `UNCLAIM_DEVICE` — device unclaim
- `SYNC_LINKED_AUTH` — linked login verifier update
- `FORCE_EDGE_SYNC` — queue one local sync sweep
- `VALVE_COMMAND` — valve control
- `SET_LSN50_*`, `SET_KIWI_*`, `SET_STREGA_*` — device configuration
- `SET_FAN`, `REBOOT` — gateway control
- `REGISTER_DEVICE` — device registration

### MQTT (WSS, port 443) — Edge → Cloud Only

**Broker**: `wss://server.opensmartirrigation.org/mqtt`

MQTT is used for **telemetry and acknowledgments only**. The edge subscribes to its local ChirpStack MQTT broker, NOT the cloud broker.

**Edge → Cloud (MQTT out):**
| Topic | Payload | Purpose |
|-------|---------|---------|
| `devices/{eui}/heartbeat` | Gateway status (CPU, memory, firmware) | Periodic heartbeat |
| `devices/{eui}/telemetry` | Sensor data (temp, humidity, soil moisture, dendro) | Real-time telemetry |
| `devices/{eui}/status` | Actuator state (valve open/closed) | Status updates |
| `devices/{eui}/command_ack` | Command acknowledgment with result | Command confirmation |

**Note**: The cloud does publish to `devices/{eui}/commands` via MQTT (in `CommandService.java`), but the edge is **not subscribed** to this topic. This MQTT command path appears to be unused/legacy code.

### Why REST for Sync?

1. **Reliable**: HTTP polling works reliably through proxies and NAT
2. **Retry-friendly**: Natural retry semantics with idempotent operations
3. **Edge-controlled**: The edge polls when ready, no need for persistent connections
4. **Simple**: Single protocol for both directions

---

## Key OSI-OS Files

### Backend / flow logic

- [flows.json](/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json)
- [osi-gateway-identity.sh](/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh)
- [chirpstack-bootstrap.js](/home/phil/Repos/osi-os/scripts/chirpstack-bootstrap.js)
- [node-red.init](/home/phil/Repos/osi-os/feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init)

This file contains:

- auth + local login
- account linking (REST → osi-server)
- OSI-Server Cloud Integration tab (MQTT telemetry out + command handler)
- sync bootstrap / outbox / pending-command polling (REST)
- sync token refresh
- manual force sync endpoint
- control-plane sync apply handlers
- data-plane sync event emission
- dendrometer analytics and scheduling

### Frontend

- [AccountLink.tsx](/home/phil/Repos/osi-os/web/react-gui/src/pages/AccountLink.tsx)
- [api.ts](/home/phil/Repos/osi-os/web/react-gui/src/services/api.ts)
- [farming.ts](/home/phil/Repos/osi-os/web/react-gui/src/types/farming.ts)

### Verification script

- [verify-sync-flow.js](/home/phil/Repos/osi-os/scripts/verify-sync-flow.js)

---

## Key OSI-Server Files

- [EdgeSyncService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java)
- [EdgeSyncController.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncController.java)
- [CommandService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/command/CommandService.java)
- [DeviceMqttProvisioningService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/mqtt/DeviceMqttProvisioningService.java)
- [MqttSubscriberService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/mqtt/MqttSubscriberService.java)
- [MqttPublisherService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/mqtt/MqttPublisherService.java)
- [AuthController.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/user/AuthController.java)
- [UserController.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/user/UserController.java)
- [LinkedGatewayAccountService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/user/LinkedGatewayAccountService.java)
- [LinkedGatewaySyncService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/user/LinkedGatewaySyncService.java)
- [JwtTokenProvider.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/security/JwtTokenProvider.java)
- [DendroAnalyticsService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java)
- [PredictionController.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/prediction/PredictionController.java)
- [ZoneFieldGeometryService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/zone/ZoneFieldGeometryService.java)
- [PredictionFieldStateService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/prediction/PredictionFieldStateService.java)
- [PredictionCard.tsx](/home/phil/Repos/osi-server/frontend/src/components/farming/prediction/PredictionCard.tsx)
- [prediction_animation_v2](/home/phil/Repos/osi-server/prediction_animation_v2)

---

## Important Current Endpoints

### OSI OS local

- `POST /auth/login`
- `POST /auth/register`
- `GET /api/account-link/status`
- `POST /api/account-link`
- `DELETE /api/account-link`
- `GET /api/sync/state`
- `POST /api/sync/force`

### OSI Server cloud (REST sync API)

- `POST /auth/local-sync`
- `POST /auth/refresh-sync`
- `POST /api/v1/users/me/password`
- `GET /api/v1/users/me/linked-gateways`
- `POST /api/v1/users/me/linked-gateways/force-sync`
- `POST /api/v1/users/me/linked-gateways/{gatewayEui}/force-sync`
- `POST /api/v1/sync/edge/bootstrap`
- `POST /api/v1/sync/edge/events`
- `GET /api/v1/sync/gateways/{gatewayEui}/pending-commands`
- `GET /api/v1/sync/gateways/{gatewayEui}/status`
- `GET /api/v1/sync/gateways/{gatewayEui}/reconciliation`
- `GET /api/v1/irrigation-zones/{zoneId}/field-geometry`
- `PUT /api/v1/irrigation-zones/{zoneId}/field-geometry`
- `GET /api/v1/irrigation-zones/{zoneId}/prediction-field-state`

---

## Edge-First Sync Model

For gateway-backed farms:

- edge writes canonical local state first
- edge emits sync events via REST outbox
- cloud mirrors edge state
- cloud-originated edits flow via REST pending-commands polling
- MQTT is used only for real-time telemetry mirroring (edge → cloud)

### Sync Concepts

- `user_uuid` — user identity
- `zone_uuid` — zone identity
- `gateway_device_eui` — gateway binding
- `sync_version` — event versioning
- tombstones via `deleted_at`
- `sync_outbox` — edge events pending cloud delivery
- `sync_inbox` — deduplication of incoming edge events
- `sync_cursor` — sync progress tracking

---

## Verified Commands

### OSI OS

```bash
node scripts/verify-sync-flow.js
```

Frontend build:

```bash
cd web/react-gui && npm run build
```

### OSI Server

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceControlPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceStatusTest
./gradlew test --tests org.osi.server.sync.EdgeSyncControllerTest
./gradlew test --tests org.osi.server.user.LinkedGatewaySyncServiceTest
./gradlew test --tests org.osi.server.mqtt.DeviceMqttProvisioningServiceTest
./gradlew test --tests org.osi.server.zone.ZoneFieldGeometryServiceTest
./gradlew test --tests org.osi.server.prediction.PredictionFieldStateServiceTest
```

Terra frontend build:

```bash
cd /home/phil/Repos/osi-server/prediction_animation_v2
npm run build
```

---

## Practical Notes For Future Agents

- Treat `flows.json` as the main edge backend; many API and scheduler changes live there.
- Prefer edge-first assumptions when a design choice is ambiguous.
- Use `feat:` for new-feature commits and `fix:` for bug-fix commits by default.
- Do not reintroduce cloud password hash sync; linked login uses a gateway-specific offline verifier.
- For synced farms, mirrored edge outputs are the canonical user-facing state.
- **All cloud→edge commands flow via REST polling** (`pending-commands` endpoint), not MQTT subscription.
- MQTT is used for **telemetry only** (edge → cloud) plus heartbeats and ACKs.
- Linked-password continuity is now a first-class control-plane feature: cloud password changes enqueue `SYNC_LINKED_AUTH`, and the cloud account page exposes linked-gateway status plus safe force-sync replay.
- Runtime gateway EUIs are normalized to uppercase on the edge. On BusyBox helpers, prefer `tr 'abcdef' 'ABCDEF'`; `tr '[:lower:]' '[:upper:]'` was not reliable on the live Pi images.
- The server MQTT provisioning layer now creates both uppercase and lowercase gateway usernames for mixed-version rollout compatibility, but new edge runtime state should still use the uppercase canonical EUI.
- The deploy/bootstrap post-check for `CHIRPSTACK_PROFILE_CLOVER` is stale. Current bootstrap writes `CHIRPSTACK_PROFILE_RAK10701`, so `CLOVER`-based checks can fail as a false negative.
- Terra Intelligence lives in `osi-server/prediction_animation_v2` and is served by the backend at `/terra-intelligence`.
- Direct access to `/terra-intelligence` should open demo mode; OSI Cloud launches live mode with a zone-scoped `?zoneId=<id>` link from the prediction advisory card.
- When wiring Spring SPA forwarding for Terra, prefer explicit `/terra-intelligence` entry mappings; broad `**/{path:...}` patterns can fail startup under Spring's `PathPatternParser`.
- As of `2026-04-16`, the live `osi-backend` on `83.228.220.63` is configured to use the separate prediction VPS at `https://vps-92c7b4bb.vps.ovh.net` instead of the local in-stack prediction service.
- The prediction VPS nginx config leaves `/health` public but allowlists `/internal/*`, `/openapi.json`, `/docs`, and `/redoc` to the live OSI server addresses `83.228.220.63`, `2001:1600:18:103::336`, and localhost.
- The old local `osi-prediction-service` container on the main OSI server was intentionally left running as a dormant fallback after cutover. Revisit it after a few weeks of stable operation before removing it.
- The live VPS checkout may not have working GitHub auth for `git pull`. A local git bundle + `git pull --ff-only <bundle> main` is a viable fallback, then `git update-ref refs/remotes/origin/main HEAD` keeps the live repo state clean.
- As of `2026-04-18`, the live main OSI server at `83.228.220.63` is still a small VPS class host (`4 CPU / 4 GB RAM / 80 GB disk`). Do **not** run broad on-host rebuilds like `docker compose up -d --build` there; that rollout pattern was enough to make the host unresponsive.
- On that small VPS, prefer prebuilt artifacts from a stronger machine. The safe backend rollout pattern is `docker compose build backend && docker compose up -d --no-deps backend`, or better, ship a prebuilt jar/image and recreate only `osi-backend`.
- The live main VPS now has a persistent `4G` swapfile at `/var/lib/swap/swapfile`. Keep it enabled, but treat it as a safety net, not as permission to resume full-stack on-host builds.

### Live Deploy Database Safety

- Never overwrite `/data/db/farming.db` on a running Pi. It is live operational data and the source of truth for edge state.
- `deploy.sh` must preserve an existing `/data/db/farming.db`; it may seed the bundled DB only when the target DB is absent.
- Do not run manual `scp .../farming.db root@<pi>:/data/db/farming.db` against a live or previously provisioned device.
- Before any manual DB repair or destructive cloud cleanup, take a timestamped backup of the Pi DB, including `farming.db-wal`, `farming.db-shm`, and `farming.db-journal` when present.
- If a deploy needs schema changes, use migrations or idempotent SQL against the existing DB instead of replacing the file.
- If `/data/db/farming.db` is missing but SQLite sidecar files exist, stop and inspect/recover rather than seeding a new DB.
- On upgraded installs, do not let stale `/srv/node-red/.chirpstack.env` `DEVICE_EUI*` values override runtime identity. The canonical gateway EUI should come from the helper / UCI path, and stale overrides should be removed during manual repair.
- Before a live VPS rollout, create a timestamped backup under `/home/rocky/backups/osi-server-<timestamp>` with the repo snapshot, Docker env/config, PostgreSQL dump, Mosquitto state, and OpenAgri data.
- For the current small live VPS, do not rebuild unrelated services during rollout. Use the narrowest possible command (`docker compose up -d --no-deps backend` after a backend-only build) and avoid any deploy path that lets Compose rebuild `prediction-service`, `fao-reference-service`, `mosquitto`, or the whole stack on-host.
- Before a risky Pi rollout or manual repair, create a timestamped backup under `/data/db/backups/osi-os-<timestamp>` including `/data/db/`, `/srv/node-red/`, `/usr/lib/node-red/gui/`, `/etc/init.d/node-red`, `flows.json`, and `settings.js`.

---

## Session Closeout

When the user says `finish the session`, treat it as an explicit close-out request. Unless the user says otherwise, execute all of the following steps:

1. Run `git status --short --branch` and report staged, unstaged, and untracked files.
2. Clean up only clearly temporary files created during the current session (e.g. `/tmp/` scripts, throwaway test files).
3. If a file might still be useful or might belong to the user, do **not** delete it — report it as a cleanup candidate instead.
4. Review the repo context files (`AGENTS.md`, `CLAUDE.md`) so they stay accurate across sessions.
5. Update `AGENTS.md` for durable repo-level facts: architecture, workflows, commands, file locations, branch expectations, known gotchas.
6. Update `/home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md` for cross-session operational details, device inventory, historical notes, and similar durable context.
7. Run `scripts/session-closeout.sh` and report any warnings it surfaces.
8. If no context files needed changes, explicitly state that `AGENTS.md` and `MEMORY.md` were reviewed and left unchanged.
9. End with a short summary of remaining risks, skipped verification, and the next recommended step.

Constraints:
- Do not rewrite context files speculatively.
- Keep updates factual and concise.
- Never delete ambiguous files without asking.
- Prefer conservative cleanup over aggressive cleanup.

---

## Known Pending Work / UI Issues

These are confirmed bugs and missing features as of 2026-04-20. Not yet filed as issues.

### S2120 Weather Station
- **Missing history for unique params**: The S2120 card has a history/monitoring tab, but it only covers standard fields. Wind speed, wind direction, UV index, barometric pressure, and rain gauge have no chart/history view yet. Needs dedicated history support for these weather-specific channels.

### LSN50 Sensor Card
- **ADC voltage shown in temperature-only mode**: When a Dragino LSN50 is configured for external temperature only (no dendrometer/ADC connected), the card still renders the ADC voltage field. It should be hidden when only the temperature channel is active.

### Terra Intelligence Live View
- **Multiple rendering breaks**: The Terra live view has several broken states that need investigation and repair before it can be used reliably.
- **Zone not loaded on startup**: Terra does not load the previously saved zone on open — the field geometry / zone selection is blank. The flow for reading the saved `zoneId` from URL param or stored state is broken or incomplete.
- **Save-to-zone does not overwrite**: Saving field geometry back to the zone does not reliably persist. Consider adding a dedicated "Save to zone" button rather than auto-saving.
- **Draw field regression — cannot close polygon**: Clicking the first point to close the polygon drawing no longer works. The polygon stays open and cannot be completed via the standard first-point click.

### Soil Profile Card
- **Uneven / many-decimal horizon values**: Soil horizon depth values are displayed with inconsistent rounding and excess decimal places. Values should be rounded to a sensible precision.
- **Soil asset does not expand with variable horizons**: When horizon count changes, the soil profile asset (illustration) does not resize — the extra area renders with a black background instead of extending the soil graphic.

### Navigation
- **No back button to OSI dashboard**: Terra Intelligence and any standalone views lack a navigation control to return to the main OSI OS dashboard. A "Back to dashboard" button or equivalent navigation affordance is missing.

### Terra — Overlapping UI / Sensor Anchor Box
- **Draw field and sensor anchors box overlap**: The draw-field control and the sensor anchors panel render on top of each other, making both hard to use simultaneously.
- **Sensor anchor box cannot be closed without sensors**: If no sensors are installed, the sensor anchor box has no close/dismiss control and the user is stuck with it open.

---

## Deprecated Code

### osi-server: MqttPublisherService

**Status**: Deprecated (marked `@Deprecated`)

Cloud-to-edge commands no longer use MQTT. The `MqttPublisherService` is kept for potential future use.

- Location: `backend/src/main/java/org/osi/server/mqtt/MqttPublisherService.java`
- Used by: `CommandService.java` (also deprecated)
- Replacement: REST polling via `EdgeSyncService.getPendingCommands()`

---

## Adding A New Device Type

1. Update DB schema (`database/farming.db`)
2. Update TypeScript types (`web/react-gui/src/types/farming.ts`)
3. Add Node-RED ingest flow in `flows.json`
4. Add catalog / merge logic
5. Add React card/component
6. Render in dashboard
7. Update bundled DB copies

Also consider sync metadata requirements and ChirpStack app/profile mapping.

### Device ChirpStack Mapping

| Device | Application | Profile |
|--------|-------------|---------|
| Kiwi | `Sensors` | Kiwi |
| LSN50 | `Sensors` | LSN50 |
| Valve | `Actuators` | STREGA |

---

## Security

- Local auth tokens: HMAC-signed
- Local passwords: bcrypt-hashed
- `/download/database`: gated
- Linked login: gateway-specific offline verifier

---

## Critical File Locations

### On the running Raspberry Pi

| What | Path |
|------|------|
| Node-RED flows | `/srv/node-red/flows.json` |
| SQLite database | `/data/db/farming.db` |
| React GUI | `/usr/lib/node-red/gui/` |
| Node-RED settings | `/srv/node-red/settings.js` |
| Node-RED init | `/etc/init.d/node-red` |
| Web UI | `http://<device-ip>:1880/gui` |

### In the repo

| What | Path |
|------|------|
| Node-RED flows | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` |
| Database | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` |
| React source | `web/react-gui/src/` |
| Node-RED settings | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` |
