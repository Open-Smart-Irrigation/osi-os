# AGENTS.md — OSI OS (Edge)

Operational source of truth for `osi-os`. The edge is canonical; `osi-server` mirrors edge-backed farms. Cloud-originated edits are pending until the edge applies them.

Sister repo: [`osi-server`](../osi-server/AGENTS.md).

---

## Architecture

```
Pi (edge)
  ├── Node-RED  (localhost:1880)        — REST API, scheduler, sync orchestration
  │     ├── SQLite  /data/db/farming.db — canonical local state
  │     └── React GUI  /gui             — farmer dashboard
  ├── ChirpStack (LoRaWAN NS, :8080)    — sensor uplinks / valve downlinks
  └── osi-bootstrap (first boot)        — auto-provisions ChirpStack + UCI identity

  ↕ REST/HTTPS (primary, bidirectional)
  ↕ MQTT/WSS:443 (telemetry only, edge → cloud)

osi-server (cloud) — see ../osi-server/AGENTS.md
```

**REST is the only cloud→edge command path.** MQTT carries only edge→cloud telemetry, heartbeats, status, and ACKs. The edge is **not** subscribed to the cloud broker.

---

## Sync REST endpoints

| Endpoint | Method | Purpose | Cadence |
|----------|--------|---------|---------|
| `/auth/local-sync` | POST | Account link + sync token | On-demand |
| `/auth/refresh-sync` | POST | Refresh sync token | Hourly |
| `/api/v1/sync/edge/bootstrap` | POST | Full state snapshot upload | Every 6 h |
| `/api/v1/sync/edge/events` | POST | Outbox event delivery | Every 30 s |
| `/api/v1/sync/gateways/{eui}/pending-commands` | GET | Pull cloud-originated commands | Every 30 s |
| `/api/v1/sync/gateways/{eui}/status` | GET | Sync state info | On-demand |
| `/api/v1/sync/gateways/{eui}/reconciliation` | GET | Reconciliation status | On-demand |
| `/api/v1/devices/claim-bulk` | POST | Bulk claim during link | On-demand |

**Cloud → edge command types** (via pending-commands):
`UPSERT_ZONE`, `DELETE_ZONE`, `UPSERT_SCHEDULE`, `UPDATE_SCHEDULE`, `UPSERT_ZONE_CONFIG`, `UPSERT_ZONE_LOCATION`, `ASSIGN_DEVICE_TO_ZONE`, `REMOVE_DEVICE_FROM_ZONE`, `UPSERT_DEVICE_FLAGS`, `UNCLAIM_DEVICE`, `SYNC_LINKED_AUTH`, `FORCE_EDGE_SYNC`, `VALVE_COMMAND`, `SET_LSN50_*`, `SET_KIWI_*`, `SET_STREGA_*`, `SET_FAN`, `REBOOT`, `REGISTER_DEVICE`.

---

## MQTT topics (edge → cloud only)

Broker: `wss://server.opensmartirrigation.org/mqtt`

| Topic | Payload | Cadence |
|-------|---------|---------|
| `devices/{eui}/heartbeat` | Gateway status (CPU, memory, firmware) | 60 s |
| `devices/{eui}/telemetry` | Sensor readings | Real-time |
| `devices/{eui}/status` | Valve state | On change |
| `devices/{eui}/command_ack` | Command result | Per command |

---

## Sync model

- Edge writes canonical local state first, then emits events to the outbox.
- Cloud mirrors via REST polling; cloud-originated edits arrive via pending-commands.
- Identifiers: `user_uuid`, `zone_uuid`, `gateway_device_eui`, `sync_version`. Tombstones via `deleted_at`.
- Tables: `sync_outbox` (pending → cloud), `sync_inbox` (dedupe incoming), `sync_cursor` (progress).

### Chameleon calibration global table

- `chameleon_calibrations` — keyed by `array_id` (uppercase 16-char hex). Source via.farm; bundled into firmware seed before release.
- `chameleon_calibration_misses` — negative cache (24h TTL) for unknown array_ids.
- `chameleon_readings.calibration_status` — `'calibrated'`, `'pending'`, or `'unknown'`.
- **Edge endpoints:** `POST /api/devices/:deveui/chameleon/refresh-calibration` (sync worker fetches from cloud), `PUT /api/devices/:deveui/chameleon/depth` (depth-only save, replaces old chameleon-config).
- **Node-RED sync worker** queries missing calibrations every 30s alongside pending commands, fetches from `/api/v1/sync/chameleon/calibrations/lookup`, persists locally, and runs local backfill.
- **Removed:** `PUT /api/devices/:deveui/chameleon-config` endpoint and the 9 per-device coefficient columns (`chameleon_swt[123]_[abc]`). Depth columns (`chameleon_swt[123]_depth_cm`) stay.
- Per-device calibration values entered by hand are discarded in the 2026-05-19 migration. Operators verify post-upgrade that each live array_id has a row in `chameleon_calibrations`.
- **Release script:** `OSI_ADMIN_TOKEN=… node scripts/refresh-chameleon-calibrations.js` before cutting a release.

---

## File locations

### On the Pi

| What | Path |
|------|------|
| Node-RED flows | `/srv/node-red/flows.json` |
| SQLite database | `/data/db/farming.db` |
| React GUI | `/usr/lib/node-red/gui/` |
| Node-RED settings | `/srv/node-red/settings.js` |
| MQTT credentials | `/srv/node-red/flows_cred.json` |
| UCI identity | `osi-server.cloud.*` (`uci show osi-server`) |

### In the repo

| What | Path |
|------|------|
| Node-RED flows | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` |
| Seed database | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` |
| Bootstrap init | `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` |
| React source | `web/react-gui/src/` |
| Node-RED settings | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` |
| Sync verifier | `scripts/verify-sync-flow.js` |

---

## Device catalog

| Device | ChirpStack app | Profile | Sensors |
|--------|----------------|---------|---------|
| KIWI_SENSOR | Sensors | Kiwi | SWT, light, temp, humidity |
| TEKTELIC_CLOVER | Sensors | (same as Kiwi) | VWC, temp, humidity |
| DRAGINO_LSN50 | Sensors | LSN50 | Ext temp, ADC (dendrometer, rain, flow) |
| SENSECAP_S2120 | Sensors | S2120 | Wind, rain, pressure, UV, temp/humidity |
| STREGA_VALVE | Actuators | STREGA | Valve state, battery |

**SWT canonicalization:** `device_data.swt_1`, `swt_2`, `swt_3` (kPa) are the canonical channels. Legacy `swt_wm1` / `swt_wm2` are read-only aliases for old rows.

**MQTT IN topic rule:** all Node-RED MQTT IN nodes must subscribe to `application/+/device/+/event/up`. ChirpStack generates per-installation application UUIDs at bootstrap; hardcoded UUIDs break silently. Device-type discrimination is done downstream via `CHIRPSTACK_PROFILE_*` env vars and `deviceProfileName` fallback. Enforced by `scripts/check-mqtt-topics.sh`.

---

## Verification commands

```bash
node scripts/verify-sync-flow.js              # sync implementation
node scripts/verify-strega-gen1.js            # STREGA Gen1 decoder
node scripts/verify-communication-contract.js # contract preflight
scripts/check-mqtt-topics.sh                  # MQTT IN topic compliance

cd web/react-gui && npm run test:unit         # frontend unit tests
cd web/react-gui && npm run build             # frontend build
```

---

## Adding a new device type

1. Update DB schema (`database/farming.db` + `seed-blank.sql`).
2. Add TypeScript types (`web/react-gui/src/types/farming.ts`).
3. Add Node-RED ingest flow in `flows.json` (use the `application/+/device/+/event/up` topic).
4. Add catalog / merge logic.
5. Add React card/component and render in dashboard.
6. Update bundled DB copies; verify with `scripts/verify-db-schema-consistency.js`.
7. Map ChirpStack app + profile; update `osi-bootstrap` if profile is new.

---

## Live-deploy safety rules

- **Never** overwrite `/data/db/farming.db` on a running or previously provisioned Pi. `deploy.sh` only seeds on a fresh device (target file absent and no orphaned WAL/SHM/journal sidecars).
- Before risky repair: timestamped backup at `/data/db/backups/osi-os-<timestamp>` covering `/data/db/`, `/srv/node-red/`, `/usr/lib/node-red/gui/`, `flows.json`, `settings.js`.
- Schema changes go via migrations or idempotent SQL — never replace `farming.db`.
- Stale `/srv/node-red/.chirpstack.env` `DEVICE_EUI*` values can override runtime identity; remove during repair. Canonical EUI is uppercase and comes from the helper / UCI path.

---

## Security

- Local auth tokens: HMAC-signed JWT.
- Local passwords: bcrypt-hashed.
- `/download/database`: gated.
- Linked login uses a gateway-specific offline verifier (`bcrypt(password::DEVICE_EUI)`), **not** cloud password hash sync.

---

## Conventions

- Commit prefixes: `feat:` for new features, `fix:` for bug fixes, `chore:` / `docs:` / `release:` as appropriate.
- BusyBox case conversion: use `tr 'abcdef' 'ABCDEF'`; `tr '[:lower:]' '[:upper:]'` is unreliable on the Pi image.
- Treat `flows.json` as the main edge backend — most API and scheduler changes live there.
- `MqttPublisherService` on the cloud is deprecated (kept for potential future use); all cloud→edge commands are REST.

---

## TypeScript work in `web/react-gui`

Read the repo-owned `architect.yaml` and `RULES.yaml` overlays before edits. See [docs/agents/typescript-rule-overlays.md](docs/agents/typescript-rule-overlays.md) for the workflow.

---

## Session closeout

When the user says `finish the session`:

1. Run `git status --short --branch` and report staged/unstaged/untracked.
2. Remove only clearly temporary files. List ambiguous files as cleanup candidates instead of deleting them.
3. Review and update this `AGENTS.md` for durable repo-level changes.
4. Review and update `/home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md` for cross-session operational context.
5. Run `scripts/session-closeout.sh` and report warnings.
6. If no context files needed changes, say so explicitly.
7. End with remaining risks, skipped verification, and the next recommended step.

Keep closeout updates factual. Never delete ambiguous files without asking.

---

## Issues

Tracked at https://github.com/Open-Smart-Irrigation/osi-os/issues. Open areas: S2120 history (#33), LSN50 ADC display (#34), i18n (#47).
