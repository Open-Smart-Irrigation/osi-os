# AGENTS.md — OSI OS / OSI Server Current Working Context

## Scope

This document reflects the current `dendrov2` implementation state after the sync, security, dendrometer, registration, and recovery work completed on **2026-03-26**.

It is written as an agent handoff for future work in:

- `osi-os` at `/home/phil/Repos/osi-os`
- `osi-server` at `/home/phil/Repos/osi-server`

The architectural rule is now:

- **`osi-os` is the operational source of truth**
- **`osi-server` mirrors edge-backed farms**
- cloud-originated edits for synced resources should be treated as pending until the edge applies them

---

## Current Branches

- `osi-os`: `dendrov2`
- `osi-server`: `dendrov2`

---

## What Changed Today

### 1. Dendrometer logic was overhauled and aligned

The dendrometer pipeline is now much closer across edge and cloud:

- v5-style envelope-based TWD logic
- timezone-aware previous-local-day computation
- QA/confidence handling
- low-confidence handling
- MAD-style outlier filtering and representative zone aggregation
- updated irrigation decision priority
- DENDRO schedule support on the edge

Important edge behavior:

- the edge now computes and stores the authoritative daily dendro outputs
- the edge recommendation is the source of truth for synced farms
- rain suppression, recovery verification, and DENDRO threshold behavior are implemented on-device

Key files:

- `osi-os`: [flows.json](/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json)
- `osi-server`: [DendroAnalyticsService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java)

### 2. Security hardening landed

On `osi-os`:

- login tokens are HMAC-signed, not base64-forgeable
- local passwords are bcrypt-hashed
- privileged endpoints check real auth and ownership
- `/download/database` is gated
- linked account login uses a gateway-specific offline verifier, not the cloud password hash

On `osi-server`:

- command ACK validation is stricter
- telemetry no longer auto-claims ownership from `cloudUserId`
- `/auth/local-sync` no longer returns a cloud password hash
- sync token rotation exists via `/auth/refresh-sync`

### 3. Bidirectional sync foundation was implemented

Control-plane sync now exists for:

- zones
- schedules
- zone config/location
- device assignment / unassignment
- device flags
- device unclaim

Data-plane mirroring now exists for:

- sensor data
- dendrometer readings
- daily dendro outputs
- zone daily recommendations
- zone daily environment
- irrigation events

Key concepts now in use:

- `user_uuid`
- `zone_uuid`
- `gateway_device_eui`
- `sync_version`
- tombstones via `deleted_at`
- `sync_outbox`
- `sync_inbox`
- `sync_cursor`

### 4. Sync auth and repair were added

The sync transport is now authenticated and has repair paths:

- edge gets a dedicated sync JWT during account linking
- edge refreshes the sync token proactively
- edge runs periodic bootstrap repair
- edge exposes sync state locally
- cloud exposes pending commands and gateway sync status

### 5. Manual sync recovery was added

For long offline recovery:

- `osi-os` now exposes `POST /api/sync/force`
- the account-link page now has a **Force sync now** button
- if the sync token is expired, the UI now offers a friendly **Re-authenticate with OSI Server** flow instead of leaving the user to guess that re-linking is needed

---

## Current Architecture

### Edge-first sync model

For gateway-backed farms:

- edge writes canonical local state first
- edge emits sync events
- cloud mirrors edge state
- cloud-originated edits are routed toward the owning gateway

### Shared identifiers

- user identity: `user_uuid`
- zone identity: `zone_uuid`
- device identity: `DevEUI`

### Gateway binding

Every synced zone is intended to belong to exactly one gateway via `gateway_device_eui`.

---

## Key OSI-OS Files

### Backend / flow logic

- [flows.json](/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json)

This file now contains:

- auth + local login
- account linking
- sync bootstrap / outbox / pending-command polling
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

This checks:

- required sync HTTP routes
- critical sync function node compilation
- bootstrap cadence
- token refresh cadence
- required bootstrap snapshot arrays

---

## Key OSI-Server Files

- [EdgeSyncService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java)
- [EdgeSyncController.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncController.java)
- [AuthController.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/user/AuthController.java)
- [JwtTokenProvider.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/security/JwtTokenProvider.java)
- [DendroAnalyticsService.java](/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java)

Recent important migrations:

- `V17__bidirectional_sync_foundation.sql`
- `V18__data_plane_mirror.sql`

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

### OSI Server cloud

- `POST /auth/local-sync`
- `POST /auth/refresh-sync`
- `POST /api/v1/sync/edge/bootstrap`
- `POST /api/v1/sync/edge/events`
- `GET /api/v1/sync/gateways/{gatewayEui}/pending-commands`
- `GET /api/v1/sync/gateways/{gatewayEui}/status`
- `GET /api/v1/sync/gateways/{gatewayEui}/reconciliation`

---

## Device Registration Status

The LoRa device registration path was tightened:

- ChirpStack provisioning is now required for successful registration
- local registration success should no longer mean “DB row only”
- cloud registration success should no longer mean “command sent only”

Expected application/profile routing:

- Kiwi -> `Sensors` application + Kiwi profile
- LSN50 -> `Sensors` application + LSN50 profile
- Valve -> `Actuators` application + valve profile

Registration should be tested again end-to-end after this sync/security work.

---

## What Is Working Now

### Control plane

- synced zone create/edit flows
- schedule propagation
- device assignment changes
- device unclaim handling
- command ACK routing with sync metadata

### Data plane

- telemetry mirror ingest
- dendro reading mirror ingest
- daily dendro mirror ingest
- zone recommendation mirror ingest
- zone environment mirror ingest
- irrigation event mirror ingest

### Recovery

- periodic bootstrap repair
- outbox flush
- pending-command polling
- sync token refresh
- manual force sync
- manual re-auth when force sync reveals token expiry

---

## Residual Gaps / Next Likely Work

These are the most likely next tasks:

1. Runtime end-to-end validation on real edge/cloud deployments
- especially reconnect timing
- long offline windows
- command replay behavior

2. GUI parity work
- both GUIs should stay visually and behaviorally mirrored
- account-link / sync state UX may need to be mirrored on `osi-server`

3. Registration verification
- test whether device registration now appears correctly in ChirpStack
- confirm edge/cloud visibility after join/uplink

4. Additional sync observability
- clearer per-resource sync status in device/zone/schedule responses
- operator-facing drift indicators in the UI

5. Optional polish
- better localized copy for the new force-sync and re-auth actions
- code splitting in the React GUI if bundle size becomes a concern

---

## Verified Commands

### OSI OS

Run from repo root:

```bash
node scripts/verify-sync-flow.js
```

Frontend build:

```bash
cd web/react-gui
npm run build
```

### OSI Server

Typical targeted test commands used today:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceControlPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncControllerTest
./gradlew test --tests org.osi.server.user.AuthControllerTest
./gradlew test --tests org.osi.server.security.JwtTokenProviderTest
```

---

## Practical Notes For Future Agents

- Treat `flows.json` as the main edge backend; many API and scheduler changes live there.
- Prefer edge-first assumptions when a design choice is ambiguous.
- Use `feat:` for new-feature commits and `fix:` for bug-fix commits by default.
- Do not reintroduce cloud password hash sync; linked login now depends on a gateway-specific offline verifier.
- For synced farms, mirrored edge outputs are the canonical user-facing state.
- If a sync token is expired, the intended user recovery path is now:
  - account-link page
  - `Force sync now`
  - if needed, `Re-authenticate with OSI Server`
