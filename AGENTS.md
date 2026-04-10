# AGENTS.md — OSI OS / OSI Server Current Working Context

## Scope

This document reflects the current implementation state on `main` branch. It covers the communication architecture between osi-os (edge) and osi-server (cloud), security hardening, dendrometer logic, and bidirectional sync.

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

> Note: The `dendrov2` branch was merged into `main`.

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
- [MqttSubscriberService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/mqtt/MqttSubscriberService.java)
- [MqttPublisherService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/mqtt/MqttPublisherService.java)
- [AuthController.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/user/AuthController.java)
- [JwtTokenProvider.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/security/JwtTokenProvider.java)
- [DendroAnalyticsService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java)

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
- `POST /api/v1/sync/edge/bootstrap`
- `POST /api/v1/sync/edge/events`
- `GET /api/v1/sync/gateways/{gatewayEui}/pending-commands`
- `GET /api/v1/sync/gateways/{gatewayEui}/status`
- `GET /api/v1/sync/gateways/{gatewayEui}/reconciliation`

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
./gradlew test --tests org.osi.server.sync.EdgeSyncControllerTest
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
