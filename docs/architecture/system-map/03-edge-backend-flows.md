# 03 — Edge Backend (Node-RED flows)

[← Edge gateway](02-edge-gateway.md) · [Index](README.md) · [→ Edge database](04-edge-database.md)

The gateway's entire backend — REST API, irrigation scheduler, sensor ingest,
cloud sync — is **one Node-RED flow file**:

- Canonical copy: [conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json)
- Byte-identical mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

Node-RED is a visual programming runtime: the file is a JSON array of "nodes"
(small boxes of logic) wired together. At the snapshot date it contains
**579 nodes across 18 tabs**, including 238 JavaScript function nodes and 101
HTTP endpoints. It is **never edited by hand**: only by one-shot scripts that
parse, mutate, and re-serialize the JSON (see the skill
`.claude/skills/osi-flows-json-editing/` and chapter [08](08-operations.md) for
the guard rails).

During the refactor program, the heavy logic was progressively moved *out* of
the flow file into small, unit-tested **helper modules** (section "Shared helper
modules" below); the flow nodes increasingly act as thin adapters that parse the
HTTP request, call a helper, and send the response.

## The tabs, in plain language

A "tab" is a page in the Node-RED editor grouping one subsystem. Locations below
are written as **tab → node name**.

### Authentication (7 function nodes)

The gateway's front door. Handles farmer registration and login against the
*local* user table (passwords stored bcrypt-hashed, sessions issued as
HMAC-signed JWT tokens — no cloud needed to log in). Key nodes: **Register
User** / **Insert User** (create account), **Login User** / **Lookup Auth
User** / **Process Result** (verify password, issue token), **Set Download
Headers** (gates the `/download/database` full-database download behind auth).

### Device Management (103 function nodes — the biggest tab)

The dashboard's main REST API. Everything a farmer does on the devices/zones
screen lands here. Grouped by job:

- **Device registry**: list devices (**Build Query**/**Format Response**),
  register or claim a device (**Check If Device Exists**, **Insert or Claim
  Device**, plus **CS Register Device**, which also enrolls it in ChirpStack so
  the radio side knows it), remove a device (**Unlink Device**), and the device
  catalog of supported types (**Return Catalog**).
- **Irrigation zones**: create/list/delete zones (**Insert Zone**, **(Soft)
  Delete Zone**: deletion is a tombstone, never a hard erase, so sync can
  propagate it), assign/unassign devices to zones (**Verify Zone & Device**,
  **Assign Device**, **Unassign Device**).
- **Schedules**: save a zone's watering schedule (**Verify Zone Ownership**,
  **Build UPSERT**: also validates thresholds, e.g. soil-tension 0–300 kPa),
  plus a safety switch to disable all schedules at once (**Disable All
  Schedules**).
- **Manual valve control**: open a valve now (**Auth + Validate + Normalize**,
  **Check device ownership + type**, **Build actuator_command + DB writes**),
  cancel a running irrigation (**Cancel STREGA Actuation**), and today's
  delivered liters per valve (**Query today-liters**).
- **Remote device configuration**: a long series of `Auth + Parse …` /
  `Authorize + Fanout …` / `Format … Response` triplets, one per setting the
  dashboard can change *on the field device itself* (sent as radio downlinks):
  LSN50 mode/interval/interrupt/5-V-warm-up, Kiwi interval and
  temperature-humidity reporting, STREGA interval/model/timed-action/
  magnet/partial-opening/flushing, rain-gauge and flow-meter settings, soil
  moisture depths, dendrometer configuration and baseline reset
  (**Auth + Reset Dendro Baseline**).
- **Chameleon calibration**: refresh a soil probe's calibration from the cloud
  on demand (**chameleon-refresh-\*** chain) and save probe burial depths
  (**chameleon-depth-\***).
- **History snippets for cards**: per-device sensor/rain/dendro history
  endpoints used by dashboard cards (**Auth + Build SQL**, **Auth + Daily Rain
  History**), gateway location (**Auth + Query Gateway Location**), and the
  recent-actuations list.

### Scheduler (6 function nodes)

The daily irrigation brain. A cron inject (**Schedule time**, 06:00) triggers:
**Build zones query (enabled schedules)** → **Build mean query (last hour, all
datapoints)** → **Decide + build actuator cmd + build DB logs**, which applies
the rule *mean soil tension ≥ threshold → irrigate* and emits both the valve
command and the journal rows. (For dendrometer-triggered schedules the stored
"threshold" is a stress level 1–4 rather than kPa.) The tab also carries
one-time database setup helpers (**Enable foreign keys**, **Migrate users
schema** inject).

### Sensor_KIWI (5 function nodes)

Radio ingest for the Kiwi/Clover soil-and-climate sensors, whose payloads arrive
already decoded by ChirpStack. **Process Data** normalizes the reading, **Build
SQL INSERT** writes it to `device_data`. This tab also hosts **Process STREGA**
/ **Persist STREGA Uplink** (valve status messages ride the same uplink stream)
and **Forward Agroscope Dendro**, which — when enabled — republishes dendrometer
uplinks to the Agroscope research institute's IoT broker
(see [docs/operations/agroscope-iot-forwarding.md](../../operations/agroscope-iot-forwarding.md)).

### Actuator_STREGA (5 function nodes)

The valve command transmitter. **Build STREGA downlink + emit log ctx**
translates an actuator command into the exact radio bytes for the STREGA valve
(always `OPEN_FOR_DURATION`; the valve self-closes), **Build zone lookup SQL** /
**Apply zone_id from lookup** attach the zone for journaling, **Build
actuator_log INSERT** writes the journal row, and the MQTT out node **MQTT to
ChirpStack** hands the downlink to the radio server. **Build LSN50 mode
downlink** does the same translation for LSN50 configuration changes.

### Simulations (Dev) & Dendro Live Sim (4 function nodes)

Developer-only test rigs: fake sensor uplinks (**KIWI UPLINK SIM**, **DENDRO
SIM SETUP**, **DENDRO TREE UPLINK SIM** on a 10-minute timer) and a test valve
command, so the whole pipeline can be exercised without physical hardware.

### Field testing (3 function nodes)

Support for the RAK10701 field tester device (a handheld gadget that measures
radio coverage on-site). Stores its uplinks and per-gateway reception info
(`field_tester_uplinks` / `field_tester_rxinfo`) and serves them as CSV at
`GET /download-fieldtest` (**Build SQL + Params**, **Rows → CSV + Headers**).

### Download Sensor Data (3 function nodes)

The raw-data export hatch: `GET /download-sensordata` streams the `device_data`
table as CSV (**Build SQL + Params**, **Rows → CSV + Download**).

### OSI-Server Cloud Integration (48 function nodes — the sync hub)

Everything that talks to the cloud lives here; chapter
[06](06-edge-cloud-sync.md) explains the protocol. The moving parts:

- **Boot & schema**: **Sync Init Schema + Triggers** (node id `sync-init-fn`)
  runs legacy schema statements on every boot. It is **frozen**: new schema
  work goes through the migration runner (chapter [04](04-edge-database.md)).
  Its one sanctioned extra duty is a guarded, fail-closed rebuild of the
  `devices` table when the allowed-device-type list drifts.
  **Register Startup (crash-loop)** notes each boot so repeated crash-restarts
  can be detected and escalated.
- **Heartbeat & health**: **Build Heartbeat** (every 60 s: CPU, memory, load,
  fan, firmware version → MQTT `devices/{eui}/heartbeat`), **Gather Edge
  Health** and **Record Error** (error counters), **Persist Gateway Health** +
  **Gateway Health Rollup** (same facts stored locally: raw samples kept 14
  days, hourly min/mean/max kept a year; nightly rollup at 02:10).
- **Telemetry**: **Build Telemetry** republishes every local sensor uplink to
  MQTT `devices/{eui}/telemetry` for live cloud dashboards.
- **State sync (outbox)**: **Build Cloud Bootstrap** / **POST Bootstrap to
  Cloud IPv4** / **Mark Bootstrap Synced** upload a full state snapshot every
  6 h; **Build Edge Event Batch** / **POST Edge Events to Cloud IPv4** / **Mark
  Synced Events Delivered** drain the `sync_outbox` every 30 s; **Prune Sync
  Outbox** (nightly, 02:00) applies retention so the tray can't grow forever.
- **History shadow sync**: **Build History Batch** / **POST History Batch** /
  **Mark History Batch ACK** (every 60 s) plus **Build History Manifest** /
  **POST History Manifest** / **Mark History Manifest ACK** (every 5 min)
  stream *historical* table segments to the cloud with content hashes, so the
  cloud mirror can prove it holds exactly what the edge holds.
- **Command intake**: **Build Pending Command Pull** / **GET Pending Commands
  IPv4** (every 30 s) fetch cloud-originated commands; **Deduplicate Pending
  Command** consults the `sync_inbox` so a re-delivered command is never applied
  twice; **Route Command** dispatches by type (zone edits, schedule edits,
  device flags, valve commands, fan, reboot, device registration via
  **CS Register (cloud cmd)** …); appliers build the SQL (**Build UPDATE
  SQL**) and acknowledgements (**Build Schedule ACK**, **Build Status + ACK**,
  **Build Special Command ACK**).
- **Acknowledgement delivery**: **Queue REST Command ACK** → **Build Command
  ACK Batch** → **POST Command ACKs to Cloud IPv4** → **Mark Command ACKs
  Delivered** (every 30 s, with MQTT `command_ack` as the fast lane).
- **Auth & tokens**: **Build Sync Token Refresh** / **POST Refresh Sync Token
  IPv4** / **Store Refreshed Sync Token** renew the gateway's cloud credential
  hourly; **Build Sync State** and **Run Force Sync** back the local
  `GET /api/sync/state` and `POST /api/sync/force` endpoints.
- **Valve safety**: **Reject Indefinite Open** (refuses open-ended valve
  commands) and **Write STREGA Expectation** (records what should happen so the
  reconciliation monitor can verify it did).
- **Chameleon calibration sync**: **calibration-missing-query** →
  **calibration-batch-fetch** → **calibration-persist** →
  **calibration-local-backfill**: every 30 s, asks the cloud for any unknown
  soil-probe calibration IDs, stores new ones, and back-fills readings that were
  waiting for them.
- **Farmer feedback**: **support-delivery-worker** (every 5 min) delivers
  locally-filed improvement requests to the cloud, and **Apply Work Request
  Status** brings status updates back (chapter [08](08-operations.md), Stage 0
  pipeline).

### Sensor_LSN50 (7 function nodes)

Ingest for the Dragino LSN50 family — the "Swiss army knife" node that can carry
a temperature probe, a dendrometer, a rain gauge, a flow meter, or a Chameleon
soil-probe array. **Decode LSN50** runs the codec; **Build Config Query** /
**Apply Config** look up how *this particular* device is configured (which
attachment, calibration, depths); **LSN50 Normalize + Write** is the
refactored "narrow waist" path (normalizer + shared device writer);
**Build Dendrometer Readings INSERT** and **Insert Chameleon Reading** feed the
specialist history tables; **Aggregate Zone Rain/Flow** rolls rain/flow readings
up into the per-zone daily environment table.

### Sensor_S2120 (3), Sensor_LORAIN (3), Sensor_UC512 (1)

One small ingest tab per remaining device family:

- **Process S2120** + **Build SQL INSERT** + **Aggregate Zone Rain**: SenseCAP
  weather station. Rain arrives as a *cumulative* counter, so the flow computes
  the difference from the previous reading, with explicit statuses for first
  sample, counter reset, duplicates, and out-of-order packets — only clean
  deltas count toward a zone's daily rainfall.
- **Process LoRain** + **Build LoRain SQL INSERT** + **Aggregate LoRain Zone
  Rain**: Aqua-Scope LoRain gauge. Reports *interval* rain (already a delta of
  0.5 mm bucket tips), so it must never be double-aggregated.
- **UC512 Normalize + Write**: Milesight UC512 valve controller telemetry
  (valve states, pulse counters, pipe pressure), fully on the narrow-waist
  writer path.

### System Admin (7 function nodes)

Gateway housekeeping API: **System Stats** (`GET /api/system/stats` — CPU,
memory, disk, temperature), **Reboot**, **Fan Control** (writes the Pi's PWM fan
via `/sys/class/pwm/...`), **Command Type Registry** (the catalog of command
types the gateway accepts, loaded at startup), **STREGA Reconciliation
Monitor** (every 60 s compares valve expectations against observed state and
flags e.g. `STALE_OPEN_OBSERVED`), **Improvement Requests API Router** (the
farmer-feedback endpoints), and **CORS Preflight**.

### Account Link (19 function nodes)

The pairing ceremony between a gateway and a cloud account.
`POST /api/account-link` → **Validate & decode token** → **Build server auth
request** → **POST /auth/local-sync IPv4** → **Handle server auth response** →
**Persist MQTT Broker Config** + **Finalize linked account state**: i.e.
verify the farmer locally, exchange credentials with the cloud, store the sync
token and the cloud MQTT credentials, then **Schedule Link Restart** so
Node-RED reconnects with them. The mirror-image unlink path (**Clear linked
account state**, **Clear MQTT Broker Config**, **Schedule Unlink Restart**) and
crash-safe rollback (**Rollback MQTT Broker Config**, **Restore MQTT Broker
Config**) make the ceremony reversible at any step. Linked login afterwards
uses a gateway-specific offline verifier — the cloud never sends password
hashes to the edge.

### Dendrometer Analytics (11 function nodes)

Tree-health computation and its API. **Daily Dendrometer Analytics** (08:00
daily) runs the v5 "envelope" model via the extracted `osi-dendro-analytics`
module: for each tree it derives daily max/min stem size, growth rate, **MDS**
(max daily shrinkage) and **TWD** (tree water deficit), classifies a stress
level against per-crop thresholds, and stores a row per tree per day. The rest
are REST endpoints for the dashboard: **Get Daily Indicators**, **Get Raw
Readings**, **Get Zone Recommendations**, **Set Reference Tree**, **Set Zone
Timezone / Location / Config** (**Update Zone Config**), **Get Zone Environment
Summary** (via the `osi-zone-env` module), and **Save Zone Irrigation
Calibration** (measured flow rate per zone, used to estimate liters).

### History API (3 function nodes)

The refactored history/analysis backend — three thin routers that delegate to
tested modules: **History API Router** (cards, workspaces, per-card data +
preferences, CSV export with derived pF rows, feature flags at
`GET /api/system/features`) delegating to `osi-history-router`/
`osi-history-helper`; **History Rollup Tick** (nightly 02:00 pre-aggregation
into `history_channel_rollups`, plus `POST /api/history/rollups/run` for manual
runs); **Analysis API Router** (cross-zone analysis: channel catalog, series
data, saved views) delegating to `osi-history-helper/analysis.js`.

## HTTP API at a glance

101 endpoints; the full list lives in the flow file. Families:

| Prefix | Serves | Tab |
|---|---|---|
| `/auth/*`, `/download/database` | Login, registration, gated DB download | Authentication |
| `/api/devices*`, `/api/catalog`, `/api/irrigation-zones*`, `/api/valve*`, `/api/v1/valves/*` | Devices, zones, schedules, valve control | Device Management (+ Dendrometer Analytics for zone config/location/recommendations) |
| `/api/history/*`, `/api/analysis/*`, `/api/system/features` | History cards, workspaces, CSV export, cross-zone analysis | History API |
| `/api/dendrometer/*` | Tree analytics | Dendrometer Analytics |
| `/api/system/*` | Stats, fan, reboot | System Admin |
| `/api/improvement-requests*` | Farmer feedback | System Admin |
| `/api/account-link*`, `/api/sync/*` | Cloud pairing + sync status/force | Account Link, Cloud Integration |
| `/download-sensordata`, `/download-fieldtest` | CSV exports | Download / Field testing |

Conventions: protected endpoints check the JWT and return **401** without one
(a 401 on a gated route is the *healthy* signal); every code path sends exactly
one HTTP response; responses for zone-scoped data verify ownership first.

## Timers at a glance

| Cadence | Job (inject node) | Tab |
|---|---|---|
| 60 s | Heartbeat → cloud; gateway health sample; STREGA reconciliation; history shadow batch | Cloud Integration / System Admin |
| 30 s | Outbox flush; pending-command poll; command-ACK flush | Cloud Integration |
| 5 min | History manifest; support delivery | Cloud Integration |
| Hourly | Sync token refresh | Cloud Integration |
| 6 h | Full bootstrap snapshot | Cloud Integration |
| Daily 02:00 | History rollups; outbox retention | History API / Cloud Integration |
| Daily 02:10 | Gateway health rollup | Cloud Integration |
| Daily 06:00 | Irrigation scheduler | Scheduler |
| Daily 08:00 | Dendrometer analytics | Dendrometer Analytics |

## Shared helper modules (`osi-*`)

Reusable, unit-tested JavaScript packages shipped beside the flow at
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` (on the Pi:
`/usr/share/node-red/`). Function nodes load them through the `osi-lib` loader.
These are the products of the refactor program — logic that used to live as
giant text blobs inside flow nodes.

| Module | Plain-language job |
|---|---|
| `osi-lib` | The librarian: `osiLib.require('<name>')` is the sanctioned way for a flow node to load any other helper. |
| `osi-db-helper` | The database driver: opens `/data/db/farming.db`, queues operations so writes don't collide, provides safe transactions. Every open must be paired with a close (guard-tested). |
| `osi-cloud-http` | The gateway's telephone line to the cloud: HTTPS requests with the sync token, IPv4 pinning, timeouts. |
| `osi-device-writer` | The narrow waist: one validated write path for sensor rows into `device_data`, so every device family stores data the same way. |
| `osi-lsn50-normalize` / `osi-uc512-normalize` | Family-specific translators that turn decoded payloads into the writer's canonical input. |
| `osi-chameleon-helper` | Soil-probe math: converts raw electrical resistance to soil tension in kPa using per-array calibration curves (clamped 0–300 kPa). |
| `osi-dendro-helper` | Dendrometer decoding/calibration helpers (voltage → micrometers). |
| `osi-dendro-analytics` | The daily tree-analytics engine (v5 envelope model: MDS, TWD, stress level). |
| `osi-zone-env` | Builds the "zone environment summary" (rain, temperature, irrigation totals for a zone). |
| `osi-history-helper` (+ `analysis.js`) | History/analysis queries, CSV export (including paired pF rows for soil tension). |
| `osi-history-router` | Maps history/analysis HTTP routes to helper calls (routing table + auth glue). |
| `osi-history-sync-helper` | Packs historical rows into hashed segments/manifests for shadow sync. |
| `osi-health-helper` | Gateway health sampling and rollup logic. |
| `osi-db-integrity` | Boot-time database integrity check (also run by the `osi-db-integrity` init service). |
| `osi-chirpstack-helper` | Talks to the local ChirpStack API (device registration, downlink queueing, queue flush). |
| `codecs/` | The payload translators, one per device family: `dragino_lsn50_decoder.js`, `sensecap_s2120_decoder.js`, `aquascope_lorain_decoder.js`, `strega_gen1_decoder.js`, `milesight_uc512_decoder.js`, plus `agroscope_uplink_transform.js` (reshapes dendro uplinks for the Agroscope forward). |
| `edge-channels.json` | The channel manifest: the machine-readable list of every measurement "channel" (soil tension, rain, wind …) with units and which database column feeds it. Mirrored to the GUI and the cloud. |
