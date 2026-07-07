# AGENTS.md — OSI OS (Edge)

Operational source of truth for `osi-os`. The edge is canonical; `osi-server` mirrors edge-backed farms. Cloud-originated edits are pending until the edge applies them.

Sister repo: [`osi-server`](../osi-server/AGENTS.md).

> **How to work here:** [docs/engineering-playbook.md](docs/engineering-playbook.md) — the working loop (verify reality → written plan → adversarial review → exact execution → independent verification), the thinking tools, and the failure modes this repo has already paid for. Read it before your first non-trivial change; hold every PR to its §8 definition of done.

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

**Fan telemetry/control:** gateway stats expose `fan_available`, `fan_mode`, `fan_value`, and `fan_max`; cloud fan control arrives as `SET_FAN`. The current Node-RED fan path uses raw PWM sysfs (`/sys/class/pwm/pwmchip2/pwm3`). If the Pi 5 kernel `pwm-fan` driver is enabled through `dtparam=cooling_fan=okay` and `kmod-hwmon-pwmfan`, switch fan detection/control to the `pwmfan` hwmon device (`/sys/class/hwmon/*/pwm1`, `pwm1_enable`) because the driver owns the raw PWM channel and direct writes can fail with `EBUSY`.

**Gateway health persistence:** the same CPU/memory/load/fan facts the 60 s heartbeat reports are also persisted locally (osi-os #68) via its own 60s inject `gateway-health-sample-tick`: `gateway_health_samples` (raw, default 14 d) and `gateway_health_hourly` (min/mean/max rollups, default 365 d) in `/data/db/farming.db`, written by the `Persist Gateway Health` node and rolled up + pruned daily at 02:10 by `Gateway Health Rollup`. Includes the best-effort `get_throttled` bitfield. Schema: `database/migrations/ordered/0002__gateway_health.sql`; local-only (not cloud-synced) in v1. Operator guide: [docs/operations/edge-history-retention.md](docs/operations/edge-history-retention.md).

---

## Sync model

- Edge writes canonical local state first, then emits events to the outbox.
- Cloud mirrors via REST polling; cloud-originated edits arrive via pending-commands.
- Identifiers: `user_uuid`, `zone_uuid`, `gateway_device_eui`, `sync_version`. Tombstones via `deleted_at`.
- Tables: `sync_outbox` (pending → cloud), `sync_inbox` (dedupe incoming), `sync_cursor` (progress).
- SQLite startup migrations must preserve local history. If a parent table such as `devices` is rebuilt with a drop/rename swap, fence the swap with `PRAGMA foreign_keys=OFF` and restore `PRAGMA foreign_keys=ON` after the final drop; otherwise `ON DELETE CASCADE` child tables such as `device_data` and `chameleon_readings` can be wiped on Node-RED startup. See [docs/operations/edge-history-retention.md](docs/operations/edge-history-retention.md).

### Boot-DDL freeze (edge schema)

`sync-init-fn` (Node-RED "Sync Init Schema + Triggers") performs schema DDL inline
on every boot (incl. ~93 ADD COLUMNs, 81 of them redundant with the seed; the
verifier's past `duplicate column` failures were the stale upgrade-test baseline,
issue #84 — not this node). This node is FROZEN:
do not add new schema behavior there. New schema changes go through the migration
runner (`lib/osi-migrate`). `scripts/verify-runtime-schema-parity.js` (CI-gated) fails
if the shipped flow DOWNGRADES `database/seed-blank.sql` (devices CHECK / triggers).
Replacing the inline boot DDL with the runner ("Option B") is a separate boot-path
project — see the ADR trigger conditions.

The boot node remains frozen for *schema* changes; the guarded + fail-closed `devices`
rebuild (2026-07, both profiles) is the sanctioned exception, because it is a safety
fix rather than new schema behavior: the rebuild only runs when the live `devices`
CHECK is missing a required `type_id`, copies rows with a plain `INSERT` inside
`_db.transaction()` (a CHECK violation throws → ROLLBACK, `devices` left intact —
no more silent `INSERT OR IGNORE` drops), and restores `PRAGMA foreign_keys=ON` in a
`finally` on every exit path; errors are surfaced via `node.error`, never swallowed.
Merge gate for any further touch to this block: `verify-runtime-schema-parity.js` +
`verify-profile-parity.js` + `verify-devices-rebuild-fence.js` +
`node --test scripts/rehearse-devices-rebuild.test.js` green, plus a production-copy
rehearsal.

### Migration risk classes

- `additive` — append-only schema (new tables, columns, indexes, views, triggers). No backup, no transaction fence.
- `destructive` — schema mutation (drop/rename/rebuild/alter). Requires `writersStopped=true` (deploy pre-start), toggles `PRAGMA foreign_keys` outside the transaction, and takes a backup. Fenced: `BEGIN`/`COMMIT` inside the FK toggle.
- `data` — data backfill/mutation: takes an online backup, applies in a normal transaction (no FK fence, no writers-stopped gate). Run at deploy (a long backfill holds the write lock past the 5s runtime busy timeout); write it idempotently against the pre-migration row format.

### Chameleon calibration global table

- `chameleon_calibrations` — keyed by `array_id` (uppercase 16-char hex). Source via.farm; bundled into firmware seed before release.
- `chameleon_calibration_misses` — negative cache (24h TTL) for unknown array_ids.
- `chameleon_readings.calibration_status` — `'calibrated'`, `'pending'`, or `'unknown'`.
- **LSN50 Chameleon wiring:** when SDA/SCL are connected directly to the LSN50 STM32 I2C pins, power the VIA Chameleon I2C reader from LSN50 `VDD` (same 3.3-3.6 V rail as the bus). Do **not** power it from switched 5 V unless a proper bidirectional I2C level shifter and power isolation are added; the reader pull-ups follow VCC and switched-off 5 V can leave the board back-powered through SDA/SCL. See [docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md](docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md).
- **Edge endpoints:** `POST /api/devices/:deveui/chameleon/refresh-calibration` (sync worker fetches from cloud), `PUT /api/devices/:deveui/chameleon/depth` (depth-only save, replaces old chameleon-config).
- **Node-RED sync worker** queries missing calibrations every 30s alongside pending commands, fetches from `/api/v1/sync/chameleon/calibrations/lookup`, persists locally, and runs local backfill.
- **Removed:** `PUT /api/devices/:deveui/chameleon-config` endpoint and the 9 per-device coefficient columns (`chameleon_swt[123]_[abc]`). Depth columns (`chameleon_swt[123]_depth_cm`) stay.
- Per-device calibration values entered by hand are discarded in the 2026-05-19 migration. Operators verify post-upgrade that each live array_id has a row in `chameleon_calibrations`.
- Chameleon SWT analysis reads canonical kPa values from `device_data.swt_1`, `swt_2`, and `swt_3`. `chameleon_readings` is the raw/diagnostic mirror. If historical SWT values are repaired from `chameleon_readings` plus `chameleon_calibrations`, update `device_data` too and enqueue corrected `DEVICE_DATA_APPENDED` sync events because the live sync trigger fires on `INSERT`, not historical `UPDATE`.
- **Release script:** `OSI_ADMIN_TOKEN=… node scripts/refresh-chameleon-calibrations.js` before cutting a release.
- Apply the generated release seed with `node scripts/apply-chameleon-calibration-seed.js`; it updates every bundled DB copy and fails on an empty calibration snapshot.

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

Full Raspberry Pi image workflow: [docs/build/rpi5-full-osi-image.md](docs/build/rpi5-full-osi-image.md). Current Pi 5 and Pi 4/400/3/2 release images use `CONFIG_TARGET_ROOTFS_PARTSIZE=14336` so the writable overlay fits 16GB-class SD cards. Path B images also ship a one-shot rootfs grow path (`90_osi_rootfs_grow` + `osi-rootfs-resize`) that uses `parted resizepart`, reboots, then retries `resize2fs` until the mounted filesystem grows successfully. The workflow assumes concentratord is manually configured/enabled after flashing. Chameleon calibration rows may be absent from the OSI OS seed DB because the authoritative calibration source and admin token live on OSI Server; image completeness is gated on schema, helper, GUI, refresh endpoint, sync worker, and runtime calibration lookup support.

**Profile parity invariant:** `bcm2712 / DEVICE_rpi-5` is the canonical source-of-truth for all OSI runtime payload files (flows, codecs, DB, bootstrap, helpers). `bcm2709 / DEVICE_rpi-2` mirrors that payload byte-for-byte; `scripts/verify-profile-parity.js` enforces this and is chained from `scripts/verify-sync-flow.js`. Any change to a file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` must also be propagated to `conf/full_raspberrypi_bcm27xx_bcm2709/files/` — the parity check will fail CI otherwise.

---

## Device catalog

| Device | ChirpStack app | Profile | Sensors |
|--------|----------------|---------|---------|
| KIWI_SENSOR | Sensors | Kiwi | SWT, light, temp, humidity |
| TEKTELIC_CLOVER | Sensors | (same as Kiwi) | VWC, temp, humidity |
| DRAGINO_LSN50 | Sensors | LSN50 | Ext temp, ADC (dendrometer, rain, flow) |
| SENSECAP_S2120 | Sensors | S2120 | Wind, rain, pressure, UV, temp/humidity |
| AQUASCOPE_LORAIN | Sensors | LoRain | Interval rain, ambient temp, battery |
| STREGA_VALVE | Actuators | STREGA | Valve state, battery |

**SWT canonicalization:** `device_data.swt_1`, `swt_2`, `swt_3` (kPa) are the canonical channels. Legacy `swt_wm1` / `swt_wm2` are read-only aliases for old rows. pF is a display/export derivative, not stored measurement state: `pF = log10(kPa * 10)`. Positive SWT kPa rows in zone CSV exports are paired with derived `_pf` rows; non-positive or non-finite kPa has no pF row.

**Aqua-Scope LoRain:** `AQUASCOPE_LORAIN` is the Aqua-Scope LoRain / `RANLWE01` rain gauge, provisioned into ChirpStack `Sensors` as LoRaWAN 1.0.3 OTAA Class A. Public onboarding uses FPort `10`; the legacy firmware decoder uses FPort `2`, so `aquascope_lorain_decoder.js` accepts both. JoinEUI/AppEUI is `4943485448592021`; AppKey is retrieved from Aqua-Scope with DevEUI + email and must not be stored in this repo. Payload command `0x06 0x81` reports raw 0.5 mm steps: the decoder keeps vendor `rainlevel` as raw steps and exposes normalized `rain_mm_delta` in millimeters. LoRain rainfall is interval rainfall, not cumulative; duplicate or out-of-order timestamps must not aggregate twice. Assigned LoRain gauges update `zone_daily_environment` with `rain_source='aquascope_lorain'`.

**STREGA timed irrigation:** user-facing opens are `OPEN_FOR_DURATION`; normal close is the valve's own timed close, not a bare `CLOSE` command. Operator cancellation uses `POST /api/v1/valves/:deveui/cancel`, flushes the ChirpStack device queue, and marks the latest active `valve_actuation_expectations` row `CANCELLED`. Actuation expectations store `commanded_at`, duration, `expected_close_at`, observed open/close timestamps, `reconciliation_state`, and optional `estimated_gross_liters`. Active states are `PENDING_OBSERVATION` and `OBSERVED_RUNNING`. `zone_irrigation_calibration` stores per-zone flow-rate measurements used for estimates; if it is absent on an older Pi, actuation rows still insert with null estimated volume. `zone_daily_environment.flow_liters` remains measured flow-meter data only; estimated valve-time volume stays separate. The reconciliation monitor reads STREGA state from `devices.current_state` and recent uplink time from `device_data.recorded_at`.

**Agroscope dendrometer controller draft:** [docs/architecture/agroscope-dendrometer-controller.md](docs/architecture/agroscope-dendrometer-controller.md) captures the future opt-in `controller_mode='dendrometer'` architecture. It is recommendation-only, edge-authoritative, and not current shipped behavior.

**MQTT IN topic rule:** all Node-RED MQTT IN nodes must subscribe to `application/+/device/+/event/up`. ChirpStack generates per-installation application UUIDs at bootstrap; hardcoded UUIDs break silently. Device-type discrimination is done downstream via `CHIRPSTACK_PROFILE_*` env vars and `deviceProfileName` fallback. Enforced by `scripts/check-mqtt-topics.sh`.

---

## Verification commands

```bash
node scripts/verify-sync-flow.js              # sync implementation
node scripts/verify-no-new-silent-catch.js    # empty catch ratchet
node scripts/verify-strega-gen1.js            # STREGA Gen1 decoder
node scripts/verify-lorain-codec.js           # Aqua-Scope LoRain decoder
node scripts/verify-communication-contract.js # contract preflight
scripts/check-mqtt-topics.sh                  # MQTT IN topic compliance
node --test scripts/test-gateway-health-persistence.js  # gateway health persistence guard

cd web/react-gui && npm run test:unit         # frontend unit tests
cd web/react-gui && npm run build             # frontend build
```

---

## Adding a new device type

> **Why this is still a manual checklist:** there is no plugin registry — see ADR [`docs/adr/2026-05-28-static-device-plugin-registry.md`](docs/adr/2026-05-28-static-device-plugin-registry.md) for the deferral rationale. Do not propose a plugin system without a concrete second-party candidate.

1. Update DB schema (`database/farming.db` + `seed-blank.sql`). If the change extends the `devices.type_id` `CHECK` list, register an idempotent table-rebuild in `scripts/repair-pi-schema.js` (SQLite cannot alter `CHECK` in place).
2. Add TypeScript types (`web/react-gui/src/types/farming.ts`).
3. Add Node-RED ingest flow in `flows.json` (use the `application/+/device/+/event/up` topic; guard the branch head with a `deviceProfileName` filter so other branches don't double-process the same message).
4. Add catalog / merge logic.
5. Add React card/component and render in dashboard.
6. Update bundled DB copies; verify with `scripts/verify-db-schema-consistency.js`.
7. Map ChirpStack app + profile; update `osi-bootstrap` if profile is new.

---

## Live-deploy safety rules

- **Never** overwrite `/data/db/farming.db` on a running or previously provisioned Pi. `deploy.sh` only seeds on a fresh device (target file absent and no orphaned WAL/SHM/journal sidecars).
- Before risky repair: timestamped backup at `/data/db/backups/osi-os-<timestamp>` covering `/data/db/`, `/srv/node-red/`, `/usr/lib/node-red/gui/`, `flows.json`, `settings.js`.
- Schema changes go via migrations or idempotent SQL — never replace `farming.db`.
- **Stale-stamp recovery:** if `applyPending`/`verifyHead` report fingerprint drift after a crash between a migration commit and its stamp, and the live schema is confirmed correct, re-baseline with `node scripts/restamp-fingerprints.js /data/db/farming.db`. This is the ONLY sanctioned way to overwrite the fingerprint baseline; do not hand-edit `schema_object_fingerprints`.
- Stale `/srv/node-red/.chirpstack.env` `DEVICE_EUI*` values can override runtime identity; remove during repair. Canonical EUI is uppercase and comes from the helper / UCI path.

## Production cloud access

- `osicloud.ch` is the production OSI Server. Treat any SSH access to that host, including through a local alias or loaded SSH key, as restricted production access.
- Do not connect to `osicloud.ch`, inspect its files, read its environment, copy secrets from it, or run commands there unless the user explicitly asks for production/`osicloud.ch` access in the current turn.
- A working SSH key or successful `ssh` check is not permission. Ambiguous requests such as "the other server" are not enough; clarify or use the test host instead.

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
- Empty `catch` blocks in `flows.json`: `scripts/verify-no-new-silent-catch.js` ratchets the maintained-profile baseline. When touching any function node, convert empty `catch(_){}` / `catch(e){}` / `catch {}` blocks in that node to a visible warning such as `catch (e) { node.warn('<node/context>: ' + (e && e.message ? e.message : e)); }`; new function code must not swallow errors silently. Keep new function-node `libs: []`.
- Error-counter heartbeat fields: maintained profiles now have catch nodes wired to `Record Error` (`global.error_counts`). Do not add heartbeat `errors_total` / `errors_last_at` fields until the flow has a `Gather Edge Health` node; that node is absent in the current maintained-profile baseline, so heartbeat surfacing is intentionally skipped.
- `MqttPublisherService` on the cloud is deprecated (kept for potential future use); all cloud→edge commands are REST.

---

## TypeScript work in `web/react-gui`

Read the repo-owned `architect.yaml` and `RULES.yaml` overlays before edits. See [docs/agents/typescript-rule-overlays.md](docs/agents/typescript-rule-overlays.md) for the workflow.

---

## Agent skills

Field manuals for agents live in `.claude/skills/` (Agent Skills spec: SKILL.md + `name`/`description` frontmatter). Claude Code and OpenCode auto-discover that path; `.agents/skills` is a committed symlink to it for `.agents`-convention tools (Codex, Gemini CLI, …) — never materialize a copy there. Index:

- `osi-debugging-playbook` — symptom→triage table + verifier toolbox; load when investigating any edge failure or data gap.
- `osi-live-ops-runbook` — deploy/repair/post-check procedures for live Pis; load before touching a real gateway.
- `osi-flows-json-editing` — script-only flows.json editing rules; load before ANY Node-RED flow change.
- `osi-schema-change-control` — migrations, risk classes, frozen boot DDL, parity gates; load before ANY schema change.
- `osi-agronomy-sensors-reference` — domain pack (SWT/pF, Chameleon, dendrometry, rain, LoRaWAN as used here); load when touching sensor semantics or displays.
- `osi-config-and-flags` — UCI/env/flag catalog incl. DEVICE_EUI resolution; load when configuring or provisioning.
- `osi-hardest-problem-campaign` — deferred stub; do not author without maintainer input.

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

Tracked at https://github.com/Open-Smart-Irrigation/osi-os/issues. Don't trust this
list or any issue body blindly — re-verify against current `main` before planning
(several issues have turned out already-fixed or mostly stale). Long-running open
areas as of 2026-07-05: i18n (#47), lossless edge→cloud backup (#56), rootfs
auto-grow (#50), Uganda live-ops (#55, #64, #87), dendro scheduling (#22), Mclimate
valve (#18), and the schema-hardening roadmap (#88–#90, gated — see its plan docs).
