# 03 — Edge backend (flows.json)

[← Edge gateway](02-edge-gateway.md) · [Index](README.md) · [→ Edge database](04-edge-database.md)

The entire edge backend is one Node-RED flow file:
[conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json),
mirrored byte-identically to the `bcm2709` profile. Measured at the snapshot:
579 nodes, 18 tabs, 238 function nodes, 101 `http in` endpoints, 27 inject
timers, 7 `mqtt in` and 9 `mqtt out` nodes.

Editing rules are strict and owned by the `osi-flows-json-editing` skill: the
file is machine-formatted (`JSON.stringify(flows, null, 2) + '\n'`), edited
only by one-shot scripts with a byte-identity roundtrip guard, and both
profile copies change in the same commit.

## Function-node conventions

- npm helpers bind through the node's `libs` array
  (`{"var":"osiLib","module":"osi-lib"}`), enabled by
  `functionExternalModules: true`. In-repo helpers load via
  `osiLib.require('<name>')`; bare `require()` of a non-builtin fails CI
  (`scripts/flows-bare-require-scan.js`).
- Builtins `fs`/`os`/`cp` come from `functionGlobalContext` via
  `global.get(...)`, not `libs`.
- Every `new osiDb.Database(...)` needs a matching `.close(` in the same
  function body; `scripts/test-flows-wiring.js` audits this.
- HTTP handlers send exactly one response per code path. On auth-gated routes
  a token-less request returns 401; that is the healthy probe signal, while
  404 indicates broken wiring and 500 a handler bug.
- New empty `catch` blocks fail the ratchet
  (`scripts/verify-no-new-silent-catch.js`); errors surface via `node.warn` or
  `node.error`.
- Node ids are stable forever; `wires` arrays reference them directly.

## Tab inventory

Locations are `tab → node name`.

### Authentication (7 function nodes)

Local account registry, independent of the cloud. `POST /auth/register`
(nodes "Register User", "Insert User") stores bcrypt hashes; `POST
/auth/login` ("Login User", "Lookup Auth User", "Process Result") issues
HMAC-signed JWTs. "Set Download Headers" gates `GET /download/database`.

### Device Management (103 function nodes)

The primary REST surface for the GUI. Functional groups:

- Device registry: list/create/claim/delete (`GET|POST /api/devices`,
  `DELETE /api/devices/:deveui`; nodes "Check If Device Exists", "Insert or
  Claim Device", "Unlink Device"). "CS Register Device" also provisions the
  device in ChirpStack via `osi-chirpstack-helper`. `GET /api/catalog` returns
  the supported-type catalog.
- Zones: CRUD with soft delete ("(Soft) Delete Zone" writes `deleted_at`
  tombstones so deletion propagates through sync), device assignment
  ("Verify Zone & Device", "Assign Device", "Unassign Device").
- Schedules: `PUT /api/irrigation-zones/:id/schedule` ("Verify Zone
  Ownership", "Build UPSERT") validates `threshold_kpa` in (0, 300] for SWT
  metrics; `POST /api/irrigation-zones/schedules/disable-all` is the bulk
  kill switch.
- Manual actuation: `POST /api/valve/:deveui` ("Auth + Validate + Normalize",
  "Check device ownership + type", "Build actuator_command + DB writes"),
  cancel endpoints, `GET /api/v1/devices/:deveui/today-liters`.
- Per-family remote configuration, each an `Auth + Parse` / `Authorize +
  Fanout` / `Format Response` chain ending in a downlink: LSN50
  mode/interval/interrupt-mode/5-V warm-up; Kiwi interval and
  temperature-humidity enable; STREGA interval, model, timed-action, magnet,
  partial-opening, flushing; rain-gauge and flow-meter settings; soil
  moisture depths; dendro config and baseline reset.
- Chameleon: `POST …/chameleon/refresh-calibration` (fetch from cloud on
  demand) and `PUT …/chameleon/depth` (installation geometry only; per-device
  calibration coefficients were removed in the 2026-05-19 migration).
- Card data: per-device sensor/rain/dendro history endpoints, gateway
  location, recent actuations, zone assignments.

### Scheduler (6 function nodes)

Cron `00 06 * * *` ("Schedule time") drives "Build zones query (enabled
schedules)" → "Build mean query (last hour, all datapoints)" → "Decide +
build actuator cmd + build DB logs". Decision rule: `irrigate = meanKpa >=
threshold`. Output feeds the STREGA tab and writes `irrigation_events`. The
tab also carries one-time DB bootstrap injects ("Init DB", "Migrate users
schema", "Enable foreign keys").

### Sensor tabs: KIWI, LSN50, S2120, LORAIN, UC512

Each family owns one ingest tab headed by an `mqtt in` node on
`application/+/device/+/event/up`, with a `deviceProfileName`/env filter at
the branch head:

| Tab | Nodes | Specifics |
|---|---|---|
| Sensor_KIWI (5) | "Process Data", "Build SQL INSERT" | Kiwi/Clover payloads arrive pre-decoded from ChirpStack. The tab also hosts "Process STREGA"/"Persist STREGA Uplink" (valve uplinks share the stream) and "Forward Agroscope Dendro" plus the "Dendro to Agroscope IoT" `mqtt out` (opt-in research forward; `docs/operations/agroscope-iot-forwarding.md`). |
| Sensor_LSN50 (7) | "Decode LSN50", "Build Config Query", "Apply Config", "LSN50 Normalize + Write", "Build Dendrometer Readings INSERT", "Insert Chameleon Reading", "Aggregate Zone Rain/Flow" | Multi-attachment family (DS18B20, dendrometer, rain, flow, Chameleon I2C). Decoder handles Chameleon V1/V2 frames with status flags. "LSN50 Normalize + Write" is the narrow-waist path (`osi-lsn50-normalize` → `osi-device-writer`); `lsn50_shadow_diff` records old-vs-new writer divergence during cutover. |
| Sensor_S2120 (3) | "Process S2120", "Build SQL INSERT", "Aggregate Zone Rain" | Rain arrives as a cumulative counter. The processor derives deltas against the prior `rain_gauge_cumulative_mm` row with explicit `rain_delta_status` values (`first_sample`, `counter_reset`, `duplicate_timestamp`, `out_of_order`, `invalid_interval`, `ok`); only `ok` rows aggregate into `zone_daily_environment`. |
| Sensor_LORAIN (3) | "Process LoRain", "Build LoRain SQL INSERT", "Aggregate LoRain Zone Rain" | Interval rain: the payload already carries 0.5 mm tip steps (`rain_mm_delta = rainlevel * 0.5`), so re-aggregation of duplicate or out-of-order uplinks is forbidden. FPorts 10 (current) and 2 (legacy) both decode. |
| Sensor_UC512 (1) | "UC512 Normalize + Write" | Milesight UC512 valve controller (valve states, pulse counters, `pipe_pressure_kpa`); fully on the narrow-waist writer. |

### Actuator_STREGA (5 function nodes)

"Build STREGA downlink + emit log ctx" encodes `OPEN_FOR_DURATION` for the
STREGA Gen1 payload format; "Build zone lookup SQL"/"Apply zone_id from
lookup" resolve journaling context; "Build actuator_log INSERT" persists it;
"MQTT to ChirpStack" enqueues the downlink. "Build LSN50 mode downlink"
encodes LSN50 configuration frames.

### OSI-Server Cloud Integration (48 function nodes)

The sync worker; protocol semantics in chapter [06](06-edge-cloud-sync.md).
Node groups and cadences:

| Concern | Nodes | Cadence |
|---|---|---|
| Boot schema | "Sync Init Schema + Triggers" (`sync-init-fn`, frozen legacy DDL + guarded fail-closed `devices` CHECK rebuild), "Register Startup (crash-loop)" | boot |
| Heartbeat/health | "Build Heartbeat" → `devices/{eui}/heartbeat`; "Gather Edge Health", "Record Error"; "Persist Gateway Health"; "Gateway Health Rollup" | 60 s; rollup cron `10 2 * * *` |
| Telemetry | "Build Telemetry" → `devices/{eui}/telemetry` | per uplink |
| State sync | "Build Cloud Bootstrap"/"POST Bootstrap to Cloud IPv4"/"Mark Bootstrap Synced"; "Build Edge Event Batch"/"POST Edge Events to Cloud IPv4"/"Mark Synced Events Delivered"; "Prune Sync Outbox" | 6 h; 30 s; cron `0 2 * * *` |
| History shadow | "Build/POST History Batch" + "Mark History Batch ACK"; "Build/POST History Manifest" + ACK | 60 s; 300 s |
| Command intake | "Build Pending Command Pull"/"GET Pending Commands IPv4"; "Deduplicate Pending Command" (sync_inbox); "Route Command"; appliers ("Build UPDATE SQL", "CS Register (cloud cmd)", ACK builders); "Replay Pending Commands" | 30 s |
| ACK delivery | "Queue REST Command ACK" → "Build Command ACK Batch" → "POST Command ACKs to Cloud IPv4" → "Mark Command ACKs Delivered" | 30 s |
| Tokens/state | "Build Sync Token Refresh"/"Store Refreshed Sync Token"; "Build Sync State"; "Run Force Sync" | 3600 s; on demand |
| Valve safety | "Reject Indefinite Open"; "Write STREGA Expectation" | per command |
| Calibration sync | "calibration-missing-query" → "calibration-batch-fetch" → "calibration-persist" → "calibration-local-backfill" | 30 s |
| Work requests | "support-delivery-worker"; "Apply Work Request Status" | 300 s |

### System Admin (7 function nodes)

`GET /api/system/stats` ("System Stats": CPU, memory, load, temperature, fan),
`POST /api/system/reboot`, `POST /api/system/fan` ("Fan Control", writes PWM
sysfs under `/sys/class/pwm/pwmchip2/pwm3`; see AGENTS.md for the `pwm-fan`
driver caveat), "Command Type Registry" (startup-loaded command catalog),
"STREGA Reconciliation Monitor" (60 s expectation-vs-observed check), and
"Improvement Requests API Router" (`/api/improvement-requests*`).

### Account Link (19 function nodes)

Implements gateway↔cloud pairing over `POST/DELETE /api/account-link` and
`GET /api/account-link/status`. Chain: "Validate & decode token" → "Build
server auth request" → "POST /auth/local-sync IPv4" → "Handle server auth
response" → "Persist MQTT Broker Config" → "Finalize linked account state" →
"Schedule Link Restart". Unlink and failure paths ("Clear linked account
state", "Rollback MQTT Broker Config", "Restore MQTT Broker Config",
"Schedule Unlink Restart") keep the state machine reversible at each step.
Linked login afterwards verifies `bcrypt(password::DEVICE_EUI)` offline; the
cloud never ships password hashes to the edge.

### Dendrometer Analytics (11 function nodes)

"Daily Dendrometer Analytics" (cron `0 8 * * *`) executes the v5 envelope
model through `osi-dendro-analytics`: per tree and day it derives
`d_max_um`/`d_min_um`, `tgr_um`, `mds_um`, `twd_um`, `dr_um`, and a stress
level against per-crop absolute thresholds, writing `dendrometer_daily`. The
cloud's self-calibrating v6 (`TWD_rel`) is separate and does not feed the
edge scheduler. REST nodes: "Get Daily Indicators", "Get Raw Readings",
"Get Zone Recommendations", "Set Reference Tree", "Set Zone
Timezone/Location", "Update Zone Config", "Get Zone Environment Summary"
(`osi-zone-env`), "Save Zone Irrigation Calibration".

### History API (3 function nodes)

Three routers delegating to tested packages: "History API Router"
(`osi-history-router` + `osi-history-helper`: cards, workspaces, per-card
data/advanced/preferences, `GET /api/history/zones/:zoneId/export.csv` with
derived pF row pairing, `GET /api/system/features`), "History Rollup Tick"
(cron `0 2 * * *` plus `POST /api/history/rollups/run`), and "Analysis API
Router" (`/api/analysis/channels|series|views`).

### Field testing, Download Sensor Data, Simulations, Dendro Live Sim

RAK10701 field-tester ingest and CSV export (`GET /download-fieldtest`);
`device_data` CSV export (`GET /download-sensordata`); developer-only
uplink/command simulators (fake KIWI/dendro uplinks, 10-minute dendro sim).

## Shared helper modules

Under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`
(deployed to `/usr/share/node-red/`), each an npm-style package with tests
where noted:

| Module | Responsibility |
|---|---|
| `osi-lib` | Loader; `osiLib.require('<name>')` resolves sibling helpers. |
| `osi-db-helper` | SQLite facade: serialized operation queue, `transaction()` with `BEGIN IMMEDIATE` and rollback-on-throw, `busy_timeout` 5000 ms. |
| `osi-cloud-http` | HTTPS client for sync calls: token header, IPv4 pinning, timeouts. |
| `osi-device-writer` | Canonical `device_data` writer (validation + column mapping); the ingest narrow waist. |
| `osi-lsn50-normalize`, `osi-uc512-normalize` | Family normalizers producing writer input. |
| `osi-chameleon-helper` | `resistanceOhmsToKpa`: `kPa = a·ln(R_kΩ) + b·R_kΩ + c`, clamped [0, 300], open-circuit sentinel 10 MΩ; calibration/array-id utilities. |
| `osi-dendro-helper` | Dendrometer voltage→µm conversion and calibration. |
| `osi-dendro-analytics` | v5 daily analytics engine (tests in `index.test.js`). |
| `osi-zone-env` | Zone environment summary assembly. |
| `osi-history-helper` (+ `analysis.js`) | History/analysis queries, CSV export incl. `pF = log10(kPa·10)` pairing. |
| `osi-history-router` | Route table + auth glue for the history/analysis API. |
| `osi-history-sync-helper` | Segment/manifest builder for history shadow sync (hash v1). |
| `osi-health-helper` | Gateway health sampling and hourly rollup. |
| `osi-db-integrity` | Boot integrity check (also invoked by the init script). |
| `osi-chirpstack-helper` | ChirpStack API client: device provisioning, downlink enqueue, queue flush. |
| `codecs/` | Payload decoders: `dragino_lsn50_decoder.js`, `sensecap_s2120_decoder.js`, `aquascope_lorain_decoder.js`, `strega_gen1_decoder.js`, `milesight_uc512_decoder.js`, `agroscope_uplink_transform.js`. Kiwi/Clover decode vendor-side. |
| `edge-channels.json` | Channel manifest (measurement id → unit → `device_data` column); parity-checked against GUI and cloud copies. |
