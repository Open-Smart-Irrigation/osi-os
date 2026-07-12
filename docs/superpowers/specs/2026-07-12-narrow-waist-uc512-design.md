# Narrow-Waist Ingest — Milesight UC512 Pilot + Generic Writer + Round-Trip Gate + LSN50 Shadow

**Status:** Spec — Fable-reviewed, findings addressed (2026-07-12)
**Refactor-program items:** 3.1 (DD6: narrow-waist ingest, UC512 as second consumer) + 3.2 (`verify-device-integration.js` round-trip gate) + 3.3 (LSN50 shadow mode). Bundled because the writer, the CI gate that proves it, and the shadow harness that de-risks retrofitting it onto LSN50 are one indivisible design decision.
**Focus:** osi-os (server-side applier is item 3.4, osi-server, separate).
**Depends on:** 1.A1 (`osi-lib` loader — done, merged) and 3.0 (actuator duration-bound gate — done, merged).
**Pilot device:** Milesight UC512 (confirmed 2026-07-10). Replaces MClimate T-Valve as the first narrow-waist consumer; MClimate follows as a subsequent integration.
**Supersedes:** `2026-07-08-mclimate-narrow-waist-design.md` (draft, never executed).
**Governing decisions:** DD6, DD7, DD8, DD17 in [`refactor-program-2026.md`](../../architecture/refactor-program-2026.md); ADRs [static device plugins](../../adr/2026-05-28-static-device-plugin-registry.md) + [schema & contract ownership](../../adr/2026-06-30-schema-and-contract-ownership.md).

## Problem

Adding a LoRaWAN device to OSI today requires hand-writing ~8 surfaces including a bespoke SQL string-builder. The five existing devices each have their own "Build SQL INSERT" function node that string-interpolates a `device_data` INSERT with device-specific columns and inline `sqlStr()`/`sqlNum()` helpers. There is:

- **no shared normalize step** — each node reads a device-specific `msg.formattedData` shape and knows its own column list;
- **no closed allow-list** — a normalizer that emitted an unexpected field would be silently dropped or, worse, silently mutate schema if auto-ALTER were added;
- **no round-trip CI gate** — nothing asserts that a device's codec output, once normalized, writes exactly the columns the channel manifest declares and nothing else;
- **no centralized timestamp clamp** — only the KIWI writer (`9b3afb405207302e`) has `clampRecordedAt`; the other four writers pass timestamps through without validation;
- **no dead-letter** — unknown or unmapped fields are silently dropped with no forensic surface.

The channel manifest (`web/react-gui/src/channels/channels.json`, 25 entries, CI-parity-checked) already exists. What's missing is the waist itself: a pure `normalize(decoded, meta) → {channels}` per device and ONE manifest-driven writer with a closed allow-list, plus the CI gate that proves the round trip.

**Why UC512 now (DD6):** the Milesight UC512 is a new device AND an actuator (two-channel solenoid valve controller), so it forces the abstraction to express both sensor uplink telemetry and duration-bounded actuator downlinks. Building the narrow waist against a second real consumer is the risk control: "if the manifest can't express what an actuator needs, the abstraction is wrong — learn it there, not after retrofitting six devices." The UC512 uses the writer live; LSN50 runs in shadow mode to build DD7 evidence for eventual cutover (item 4.1).

## Verified ground truth (checked against `main` `56a208d4`, 2026-07-12)

1. **The ingest seam is per-device string-built SQL, not parameterized.** `lsn50-sql-fn` builds `msg.topic = 'INSERT INTO device_data ...'` via `sqlStr()`/`sqlNum()` string interpolation. `s2120-sql-fn`, `lorain-sql-fn` follow the same pattern. `strega-sql-fn` uses parameterized `osiDb.Database` but is still per-device. Each has its own `msg.formattedData`-shaped normalize step inline.

2. **`channels.json` is the manifest.** 25 channel entries; 24 have non-null `edgeField` (writable to `device_data`); 1 is server-only (`vwc`, `edgeField: null`). Categories: soil, environment, weather, dendro, diagnostic. `verify-channel-manifest-parity.js` CI-gates it. The `edgeField` values ARE the `device_data` column names.

3. **Manifest coverage gap is large.** `lsn50-sql-fn` writes 36 distinct columns; only 16 map to a manifest `edgeField`. The 18 unmapped: `counter_interval_seconds`, `dendro_mode_used`, `dendro_saturated`, `dendro_saturation_side`, `dendro_valid`, `flow_*` (7 columns), `lsn50_mode_*` (3 columns), `rain_count_cumulative`, `rain_delta_status`, `rain_tips_delta`. These need manifest rows before LSN50 shadow can be zero-diff.

4. **UC512 is NOT in the repo.** Zero codec, device type, channel, or card. The Milesight public codec (`Milesight-IoT/SensorDecoders`, MIT license, `uc-series/uc512/`) provides `uc512-decoder.js` (uplink, TLV-based, ChirpStack v4 `decodeUplink` interface) and `uc512-encoder.js` (downlink, `encodeDownlink` interface).

5. **UC512 uplink fields** (from the public decoder): `battery` (%), `valve_1`/`valve_2` (open/close status), `valve_1_pulse`/`valve_2_pulse` (cumulative flow counter, uint32), `gpio_1`/`gpio_2` (v2.0+), `pressure` (pipe pressure, v4.0+), `valve_1_task_status`/`valve_2_task_status` (task/real/cmd status, v4.0+), plus device metadata (firmware/hardware version, serial number, LoRaWAN class).

6. **UC512 downlink: duration-bounded valve open is native (DD17 satisfied).** The `setValveTask` encoder accepts `{ valve_index: 1|2|7, valve_status: 'open'|'close', duration: N, sequence_id: 0-255 }`. Duration is a 24-bit unsigned integer (seconds, up to ~194 days). The device firmware auto-closes after the specified duration. Additionally, `time_rule_enable` and `pulse_rule_enable` provide secondary auto-close rules (by time or flow-meter pulse count).

7. **UC512 is a two-channel controller.** Uplink differentiates channels via IPSO channel IDs (`0x03`/`0x04` = valve/pulse 1, `0x05`/`0x06` = valve/pulse 2). Downlink addresses channels via `valve_index` (1, 2, or 7=all). The existing actuation model assumes one valve per `deveui`: `valve_actuation_expectations` has `device_eui` but no channel discriminator; zone-to-valve linkage goes through `devices.irrigation_zone_id` (device→zone FK), so one `deveui` can only serve one zone — a junction table is needed for the two-channel case.

8. **`device_data` has 49 columns** (id + deveui + 47 data columns). The next migration number is 0009. Current device type CHECK: `KIWI_SENSOR, STREGA_VALVE, DRAGINO_LSN50, TEKTELIC_CLOVER, SENSECAP_S2120, AQUASCOPE_LORAIN`.

9. **`verify-device-integration.js` does NOT exist.** Item 3.2 creates it.

10. **The `osi-lib` loader** (`osi-lib/index.js`) has `NAME_TO_PATH` for module registration with quarantine+cooldown. New modules must be added here and pass `verify-helper-registration.js`.

## Design

### A. The normalize contract — `normalize(decoded, meta) → { channels, unknown }`

**Frozen contract every device normalizer implements:**

```js
// normalize(decoded, meta) -> NormalizeResult
//   decoded: the codec's decodeUplink output (device-specific object)
//   meta:    { deveui, typeId, recordedAt, fPort } — envelope, NOT payload-derived
// returns:  { channels: { <manifestKey>: <value|null> }, unknown: { <field>: value } }
//   channels: ONLY keys that are manifest `key`s (closed vocabulary).
//             Values are unit-correct (kPa, °C, V, %, etc. per manifest `unit`).
//   unknown:  fields the normalizer produced that map to NO manifest key.
//             Surfaced, NEVER silently dropped. The writer dead-letters these.
```

- **Pure and side-effect-free:** no DB, no Node-RED globals, no `require` beyond Node builtins. Loaded via `osiLib.require('uc512-normalize')`. This makes it `node --test`-able with plain fixtures.
- **Channel keys, not column names.** The normalizer speaks the manifest's `key` vocabulary; the writer resolves `key → edgeField` (the `device_data` column) via the manifest. A normalizer never hard-codes a column name.
- **`unknown` is the closed-allow-list enforcement point at authoring time.** If a normalizer wants to emit a value with no manifest `key`, it puts it in `unknown` and the writer dead-letters it — the author's signal to add a manifest row first (through `verify-channel-manifest-parity.js`), never to sneak a column in.

### B. The writer — `osi-device-writer`

One module, manifest-driven, closed allow-list. Loaded via `osiLib.require('device-writer')`.

```js
// writeDeviceData(db, manifest, normalizeResult, meta, options) -> WriteResult
//   { inserted: boolean, deadLettered: [{channel, reason}], columns: string[] }
```

**Core logic:**
1. **Resolve** each `channels[key]` → manifest entry → `edgeField` (the column). A key with no manifest entry → dead-letter `'unmapped_channel'`. A manifest entry whose `edgeField` is `null` (server-only, like `vwc`) → dead-letter `'server_only_channel'`.
2. **Timestamp clamp** (`clampRecordedAt`): centralized in the writer, applied to every device. Same floor (`2024-01-01`) and future skew (1 hour) as the existing KIWI implementation. `node.warn` on clamp.
3. **Build a parameterized INSERT:** `INSERT INTO device_data (deveui, <cols>, recorded_at) VALUES (?, ?..., ?)`. Only manifest-declared, `edgeField`-non-null columns plus envelope columns (`deveui`, `recorded_at`) may appear.
4. **Column validation:** on first call, cache `PRAGMA table_info(device_data)` column set. A manifest `edgeField` naming a non-existent column is a HARD ERROR (dead-letter + `node.error`), never auto-ALTER. There is **no code path in the writer that emits DDL.**
5. **`normalizeResult.unknown`** → dead-letter each, reason `'unknown_channel'`.
6. **Accounting is total:** every key in `channels` is either written, dead-lettered, or written as NULL. Nothing is silently dropped.
7. **Shadow mode:** when `options.shadow === true`, the writer computes the row but does NOT execute the INSERT. Instead it returns `{ shadowRow: {...}, columns: [...] }` for the shadow diff mechanism.

**Closed allow-list, three enforcements:**
- Writable columns = manifest `edgeField ≠ null` ∩ actual `device_data` columns
- `unknown` fields never reach SQL
- A manifest `edgeField` naming a non-existent column is a hard error, not `ADD COLUMN`

**Helper registration surfaces (M9):** every new `osi-*` helper module (writer, UC512 normalizer, LSN50 normalizer) requires 6 registration touchpoints:
1. `osi-lib/index.js` `NAME_TO_PATH` entry (both profiles)
2. `package.json` in `/srv/node-red/` (if it declares local dependencies)
3. `package-lock.json` (regenerated by `npm install`)
4. `98_osi_node_red_seed` init script (seeds helpers on fresh image)
5. `deploy.sh` (delivers the module over the reverse tunnel)
6. `verify-helper-registration.js` (CI-asserts all 5 above are consistent)

### C. Dead-letter mechanism — `ingest_quarantine` table

Additive ordered migration (0009):

```sql
CREATE TABLE IF NOT EXISTS ingest_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT NOT NULL,
  channel TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_value TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ingest_quarantine_received
  ON ingest_quarantine(received_at);
```

**No FK on `deveui`:** quarantine is a forensic log, not a relational entity. An FK on `devices(deveui)` would prevent quarantining data from unregistered/unclaimed devices — exactly the scenario dead-lettering needs to capture.

Row-capped at ~1,000 with oldest-eviction (the writer prunes before insert when count exceeds cap). Plus `node.error(...)` → `error_counts` → heartbeat `errors_total` for observability.

### D. UC512 codec

**Uplink decoder** (`codecs/milesight_uc512_decoder.js`): Adapted from Milesight's public `uc512-decoder.js` (MIT, `Milesight-IoT/SensorDecoders`). Exports `decodeUplink(input)` returning `{ data: decoded }`. TLV-based parsing of IPSO channels.

**Downlink encoder** (embedded in the command wiring, not a separate codec file): Uses the `setValveTask` pattern from Milesight's public encoder. The OSI command path builds `{ valve_index, valve_status, duration, sequence_id }` and encodes it to the 11-byte `0xFF 0x1D` command frame.

**Golden vectors:** Taken from the Milesight UC512 communication protocol examples, cited in the codec header.

**Deploy delivery (H7):** `deploy.sh` must include a `fetch_required` line for `codecs/milesight_uc512_decoder.js` alongside the existing codec files (STREGA, LSN50, S2120, LoRain). Without this, the codec exists in the repo but is never delivered to the Pi.

### E. UC512 normalizer — `osi-uc512-normalize`

Maps UC512 decoded fields to manifest channel keys:

| UC512 decoded field | Manifest key | Unit | Notes |
|---|---|---|---|
| `battery` | `bat_pct` | % | Already exists in manifest |
| `valve_1` | `valve_1_state` | — | NEW manifest entry (text: 'open'/'close') |
| `valve_2` | `valve_2_state` | — | NEW manifest entry |
| `valve_1_pulse` | `valve_1_pulse` | count | NEW manifest entry (cumulative uint32) |
| `valve_2_pulse` | `valve_2_pulse` | count | NEW manifest entry |
| `pressure` | `pipe_pressure_kpa` | kPa | NEW manifest entry (v4.0+ hardware) |
| `gpio_1` | — | — | → `unknown` (diagnostic, not persisted initially) |
| `gpio_2` | — | — | → `unknown` |
| `valve_1_task_status` | — | — | → `unknown` (status reporting, not telemetry) |
| `valve_2_task_status` | — | — | → `unknown` |
| Device metadata (`sn`, `firmware_version`, etc.) | — | — | Not passed to normalizer (envelope-level) |

**Decision on GPIO/task-status:** these are diagnostic fields. GPIO is explicitly dead-lettered as `unknown` — if a use case arises, add a manifest row then (the sanctioned path). Task status is a command response, not telemetry.

### F. Channel-per-zone schema extension

The UC512 controls two independent valves. User-approved model: **each valve channel maps to a separate irrigation zone.**

**Current model:** `devices.irrigation_zone_id` is a FK linking one device → one zone. One UC512 `deveui` can only point at one zone. This is insufficient: a single UC512 needs to serve two zones (one per valve channel).

**Solution: `zone_valve_assignments` junction table (migration 0011, additive):**
```sql
CREATE TABLE IF NOT EXISTS zone_valve_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  deveui TEXT NOT NULL,
  valve_channel INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE,
  UNIQUE (zone_id, valve_channel)
);
CREATE INDEX IF NOT EXISTS idx_zone_valve_zone ON zone_valve_assignments(zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_valve_deveui ON zone_valve_assignments(deveui);

ALTER TABLE valve_actuation_expectations ADD COLUMN valve_channel INTEGER;
```

- **STREGA zones:** no row in `zone_valve_assignments`. The existing `devices.irrigation_zone_id` path is unchanged. The scheduler continues to find the STREGA via the subquery `WHERE d.irrigation_zone_id = iz.id AND d.type_id = 'STREGA_VALVE'`.
- **UC512 zones:** one row per zone in `zone_valve_assignments`, e.g. `(zone_id=5, deveui='00112233...', valve_channel=1)` and `(zone_id=6, deveui='00112233...', valve_channel=2)`.
- The **scheduler's irrigate path** (`Build zones query`) currently hard-filters `type_id = 'STREGA_VALVE'` — must be extended to also look up UC512 via `zone_valve_assignments` (UNION or COALESCE), returning `valve_channel` alongside `valve_deveui`.
- The downlink wiring reads `valve_channel` to set `valve_index` in the UC512 command frame.
- `valve_actuation_expectations` gains a `valve_channel` column to discriminate per-channel expectations for the same `device_eui`.
- Zone registration UI (`IrrigationZoneCard`/`AddDeviceModal`): when a UC512 is selected as the valve device, prompt for channel 1 or 2, write the junction row.

### G. New `device_data` columns + manifest entries

**Migration 0012 (additive):**
```sql
ALTER TABLE device_data ADD COLUMN valve_1_state TEXT;
ALTER TABLE device_data ADD COLUMN valve_2_state TEXT;
ALTER TABLE device_data ADD COLUMN valve_1_pulse INTEGER;
ALTER TABLE device_data ADD COLUMN valve_2_pulse INTEGER;
ALTER TABLE device_data ADD COLUMN pipe_pressure_kpa REAL;
```

**New `channels.json` entries (5):**

| key | unit | edgeField | category | cardType | exportable |
|---|---|---|---|---|---|
| `valve_1_state` | — | `valve_1_state` | diagnostic | gateway | false |
| `valve_2_state` | — | `valve_2_state` | diagnostic | gateway | false |
| `valve_1_pulse` | count | `valve_1_pulse` | diagnostic | gateway | false |
| `valve_2_pulse` | count | `valve_2_pulse` | diagnostic | gateway | false |
| `pipe_pressure_kpa` | kPa | `pipe_pressure_kpa` | environment | environment | true |

Valve state and pulse are marked `exportable: false` (diagnostic); pipe pressure is exportable telemetry.

**Sync caveat (H6):** the `device_data` outbox trigger in `seed-blank.sql` (and recreated by `sync-init-fn` at boot) enumerates columns explicitly in a `json_object(...)` call (~51 key-value pairs, ~102 args). Adding these 5 columns would push it to ~112 args. SQLite's `SQLITE_MAX_FUNCTION_ARG` defaults to 100 but the OpenWrt build uses 127 (verified); still, this is worth confirming at implementation time. Regardless, adding these 5 columns without updating the trigger means UC512 telemetry is **edge-only** — it will NOT sync to the cloud until the outbox trigger is extended. This is acceptable for item 3.1: the server-side UC512 applier (item 3.4, osi-server) is the right place to add both the trigger columns and the server schema. Until then, UC512 data lives only on the edge.

**Parity surfaces (M8):** adding new exportable channels also requires updating:
- `VALID_EXPORT_CHANNEL_KEYS` in the CSV export route (if `pipe_pressure_kpa` is exportable)
- `analysis.js CHANNELS` list (if it gates on a hardcoded channel set)
- These must stay in sync with `channels.json` per the existing `verify-channel-manifest-parity.js` contract.

### H. Device type — `MILESIGHT_UC512`

**Migration 0010 (destructive — CHECK rebuild):**
Adds `'MILESIGHT_UC512'` to `devices.type_id` CHECK constraint.

This triggers the full device-type-change surface:
- `seed-blank.sql` update
- All 7 bundled `farming.db` copies rebuilt
- **`sync-init-fn` (both profiles) — sanctioned boot-node exception, THREE surfaces:**
  1. `REQUIRED_TYPES` array — add `'MILESIGHT_UC512'`
  2. `DEVICES_NEW_DDL` — the `CREATE TABLE IF NOT EXISTS devices_new (...)` string must include `'MILESIGHT_UC512'` in its CHECK constraint (this DDL is what `verify-runtime-schema-parity.js` asserts against)
  3. `DEVICES_COPY_SQL` — if any new columns were added to `devices` (none in this item, but verify the column list matches seed-blank)
- `verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`, `verify-devices-rebuild-fence.js` extended
- `rehearse-devices-rebuild.test.js` re-run

### I. ChirpStack integration

In `chirpstack-bootstrap.js`:
- New `UC512_CODEC_PATH` env var pointing to `codecs/milesight_uc512_decoder.js`
- New `CS_PROFILE_UC512_NAME` for the device profile name
- New `getOrCreateProfileWithCodec()` call for UC512
- New `CHIRPSTACK_PROFILE_UC512` output in `.chirpstack.env`

### J. Command Type Registry

Add UC512 valve open to the Command Type Registry node:

```js
UC512_OPEN_FOR_DURATION: {
  label: 'UC512 Open for Duration',
  actuator: true,
  requires_duration: true,
  dispatch: 'uc512_valve_open'
}
```

Both `COMMAND_TYPES` primary and all `COMMAND_TYPES_FALLBACK` copies. `verify-command-safety.js` (3.0 gate) asserts `actuator: true, requires_duration: true`.

**Downlink encoding assertion (addressing open decision M3):** `verify-device-integration.js` includes a downlink golden-vector test: `encode({ valve_status: 'open', duration: 0 })` must be rejected (duration=0 could mean indefinite on some devices). `encode({ valve_status: 'open', duration: 300 })` must produce a valid 11-byte frame with the duration bytes correctly set.

**Actuation observability (M11):** UC512 open commands MUST write `valve_actuation_expectations` rows (same pattern as STREGA's `write-strega-expectation`), with `valve_channel` populated. The reconciliation monitor must match expectations to UC512 uplink `valve_X_state` confirmations. Cancel semantics: cancelling a zone's actuation cancels only the assigned valve_channel, not both channels (a single UC512 may serve two independent zones). If cancellation of "all channels" (valve_index=7) is needed, it must be explicitly requested.

### K. LSN50 shadow mode (3.3)

**Non-destructive compare, per DD7:** the existing `lsn50-sql-fn` keeps writing (unchanged). A NEW shadow node runs the same LSN50 uplink through `normalize('lsn50', decoded)` and **compares at the normalize level** — comparing `channels` output against what the old path's `msg.formattedData` would have produced. The comparison is done AFTER the old path's INSERT completes (wired sequentially, not in parallel) to avoid racing the old path.

**Why normalize-level comparison, not write-level:** The writer applies `clampRecordedAt`, but the old path does NOT clamp timestamps. A write-level comparison would show guaranteed non-zero diffs on every uplink with a clamped timestamp, polluting the DD7 evidence. By comparing at the normalize level (pre-clamp), we isolate real behavioral divergence from intentional writer improvements.

**LSN50 normalizer:** `osi-lsn50-normalize` — reproduces today's `lsn50-sql-fn` field mapping as a pure module. Building it is behavior-preserving extraction (golden vectors captured from the old node first). The shadow diff being zero is the proof the extraction is faithful.

**Shadow diff storage:** `lsn50_shadow_diff` table (additive, local-only, not synced):
```sql
CREATE TABLE IF NOT EXISTS lsn50_shadow_diff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  diff_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Manifest expansion for LSN50:** ~18 new `channels.json` rows for the unmapped columns (§ground truth 3). These columns already exist in `device_data`; this is manifest rows only, NOT new columns/migrations. Pure-diagnostic columns get `exportable: false`.

**DD7 evidence bar (consumed verbatim, LAW):** LSN50 cutover (item 4.1, NOT this item) may proceed only after ≥14 days OR ≥500 live LSN50 uplinks per gateway, zero row diffs, zero dead-letters in `lsn50_shadow_diff`, on demo gateways first, then production. This item's job is to stand up the measurement, not to pass the bar.

### L. Flows.json wiring

**UC512 live ingest node (additive, new path):**
- MQTT IN (existing shared topic `application/+/device/+/event/up`) → device-type classification by ChirpStack profile → **"UC512 Normalize + Write"** function node
- The node: `osiLib.require('device-writer')` + `osiLib.require('uc512-normalize')`, loads the edge manifest (derived allow-list from `channels.json`), opens `osiDb.Database`, calls `normalize` then `writeDeviceData`, closes DB
- `libs` entries for `osiLib` and `osiDb`; `.close(` present (audit by `test-flows-wiring.js`)
- New node IDs minted fresh; additive placement, not tee into shared node

**LSN50 shadow node (additive, sequential after old path):**
- Wired AFTER the existing `lsn50-sql-fn` output (not in parallel) to avoid racing the old path's INSERT
- Runs `normalize('lsn50', decoded)` to produce the new-path channel mapping
- Compares the normalize output (channel keys + values) against the old path's `msg.formattedData` field mapping
- Writes per-field diffs to `lsn50_shadow_diff` (comparison at normalize level, NOT write level — avoids `clampRecordedAt` divergence noise)

**UC512 command wiring — three existing choke points must be updated:**

1. **`Build actuator_command + DB writes` (`dde8e1ef265e96d7`):** currently hard-rejects `typeId !== 'STREGA_VALVE'` → 409. Must accept `MILESIGHT_UC512` too, reading `valve_channel` from `zone_valve_assignments` for the UC512 path.
2. **Route Command (`934bf2bc19a8ce22`):** `OPEN_FOR_DURATION` dispatch currently only knows STREGA's downstream wiring. Must detect UC512 device type and route to a UC512-specific encode output (new output index on the switch node).
3. **REST validator (valve endpoint flow):** normalizes commands to `OPEN_FOR_DURATION` whose dispatch label is `strega_timed_open`. The dispatch label itself is cosmetic (it's a Command Registry key), but the Route Command's routing based on device type must distinguish UC512 vs STREGA at the `OPEN_FOR_DURATION` branch.

**New UC512 encode node:** reads `valve_channel` from the zone/VAE to set `valve_index`, encodes the `setValveTask` frame (11-byte `0xFF 0x1D`), queues via ChirpStack downlink. Duration from the irrigation zone's configured duration (same pattern as STREGA's `OPEN_FOR_DURATION`).

All edits via one-shot Node mutation scripts per `osi-flows-json-editing` skill.

### M. Edge manifest delivery

The writer needs the manifest's writable-column allow-list at runtime. `channels.json` lives in `web/react-gui/src/` (a React build input). The edge gets a **derived allow-list**:

- Build step: `scripts/build-edge-manifest.js` reads `channels.json` and writes `conf/<profile>/files/usr/share/node-red/edge-channels.json` containing only `{ key, edgeField, unit }` for entries where `edgeField ≠ null`.
- CI gate: `verify-channel-manifest-parity.js` extended to assert the derived edge copy matches the source manifest.
- `deploy.sh` delivers it alongside the helper modules.
- **Fresh-image seeding (M10):** `98_osi_node_red_seed` must also seed `edge-channels.json` so a freshly flashed gateway has the manifest before the first deploy.
- The writer reads it once at load time and caches the allow-list.

### N. Round-trip gate — `verify-device-integration.js` (3.2)

A NEW CI verifier asserting the full round trip for every device wired into the narrow waist. For each registered device normalizer, feeds golden decoded vectors through `normalize` → `writeDeviceData` against a scratch SQLite DB seeded from `seed-blank.sql`, and asserts:

1. **Every key in `normalize().channels` is a manifest `key`** (closed-vocabulary check).
2. **The set of `device_data` columns actually written == exactly the manifest-declared writable columns for the emitted keys** plus the fixed envelope (`deveui`, `recorded_at`) — nothing else.
3. **`normalize().unknown` is empty for well-formed golden vectors**; deliberately-malformed vectors assert unknowns are dead-lettered, not dropped.
4. **Zero DDL emitted** — scratch DB schema fingerprint identical before and after write.
5. **Parameterization correctness** — a golden vector with SQL-hostile values round-trips without corruption.
6. **Downlink duration-encoding** (DD17, addressing M3) — `encode(open, duration=0)` rejected; `encode(open, duration=300)` produces correct bytes.

**LSN50 mode-dependent column count (L15):** the LSN50 normalizer produces different channel sets depending on `detectedMode` (soil mode → ~22 channels, dendro mode → ~21 channels, rain/flow mode → different subset). The round-trip gate must test at least one golden vector per mode, and assertion 2 (exact column set) must be per-vector, not a fixed global count.

Wired into CI as `node scripts/verify-device-integration.js` in the migrations workflow.

### O. React minimal surface

- `DeviceType` union in `web/react-gui/src/types/farming.ts`: add `'MILESIGHT_UC512'`
- `catalog-response` node hardcoded list: add UC512 entry
- `AddDeviceModal`/`IrrigationZoneCard` device-type filters: include UC512, show channel selector (1/2) when UC512 is the valve device
- **No bespoke UC512 card** — deferred to a follow-up UI item. Device renders via generic/valve fallback.

## Migration sequence

| # | Name | Risk class | Content |
|---|---|---|---|
| 0009 | `ingest_quarantine` | additive | Dead-letter table + index |
| 0010 | `add_milesight_uc512_type` | destructive | `devices.type_id` CHECK rebuild |
| 0011 | `valve_channel` | additive | `valve_channel` column on `irrigation_zones` + `valve_actuation_expectations` |
| 0012 | `uc512_device_data_columns` | additive | 5 new `device_data` columns for UC512 telemetry |
| 0013 | `lsn50_shadow_diff` | additive | Shadow diff table for DD7 evidence |

**Migration consolidation note (M12):** migrations 0009, 0011, 0012, 0013 are all additive and could be combined into fewer files to reduce DB rebuild cycles. However, keeping them separate aids clarity and independent revertability. Implementation may consolidate 0009+0011+0012+0013 into two files (one for new tables, one for ALTER TABLEs) if rebuild time is a bottleneck, or keep them separate for auditability. The one migration that MUST stay separate is 0010 (destructive CHECK rebuild).

## Non-goals

- **LSN50 cutover** — item 4.1, gated on DD7 evidence bar this item merely measures.
- **Migrating other devices onto the writer** — convert-on-touch (DD7); only UC512 uses the writer live, only LSN50 is shadowed.
- **Server-side UC512 applier** — item 3.4 (osi-server, `SyncEventApplier`, DD12).
- **Bespoke UC512 React card** — deferred to a follow-up UI item.
- **MClimate T-Valve integration** — follows as a subsequent item using the same writer.
- **Any osi-server change.**
- **Feature-flag framework** — none (DD8). Shadow mode needs no flag.

## Definition of Done

- **Normalize contract** (§A) documented + implemented as `osiLib.require`-loaded pure modules for UC512 and LSN50, each with co-located `node --test` golden-vector suites; both registered in `NAME_TO_PATH`; `verify-helper-registration.js` green.
- **`osi-device-writer`** (§B): one manifest-driven, closed-allow-list, parameterized writer; centralized `clampRecordedAt`; emits zero DDL; dead-letters to `ingest_quarantine`; `node.error` → `error_counts`. Co-located unit tests.
- **`ingest_quarantine` table** (§C): additive migration 0009 + `seed-blank.sql` + 7 DBs + `verify-db-schema-consistency.js` extended; row-cap ~1,000.
- **`MILESIGHT_UC512` device type** (§H): destructive migration 0010 + `seed-blank.sql` + 7 DBs + `REQUIRED_TYPES` (both profiles) + all schema verifiers green + `DeviceType` union + `catalog-response` entry.
- **Channel-per-zone** (§F): additive migration 0011 + `zone_valve_assignments` junction table + VAE `valve_channel` column + scheduler query extended for UC512 + command wiring updated (3 existing choke points + new encode node).
- **UC512 `device_data` columns** (§G): additive migration 0012 + 5 manifest entries + `verify-channel-manifest-parity.js` green.
- **UC512 codec** (§D): `codecs/milesight_uc512_decoder.js`, golden vectors from Milesight docs; ChirpStack profile + env vars in `chirpstack-bootstrap.js`.
- **UC512 open** in Command Type Registry as `actuator: true, requires_duration: true`; 3.0 gate green; downlink encodes device-side auto-close duration.
- **UC512 live ingest node** in `flows.json` (both profiles, byte-parity, `libs`/`.close(` correct).
- **LSN50 shadow node** (§K) computing + diffing to `lsn50_shadow_diff`; LSN50 normalizer extraction behavior-preserving (golden vectors first); shadow-diff table migration 0013.
- **`channels.json` extended** (§K) with ~18 LSN50 unmapped columns + 5 UC512 channels; `verify-channel-manifest-parity.js` green.
- **Edge manifest** (§M): derived `edge-channels.json` + build script + parity check + deploy.sh delivery.
- **`verify-device-integration.js`** (§N): 6-assertion round-trip gate + downlink encoding gate, wired into CI, green for both UC512 and LSN50.
- **UC512 actuation observability:** VAE rows with `valve_channel`, reconciliation matching uplink state, per-channel cancel semantics.
- Both profiles byte-parity for every changed `conf/` file; frozen `sync-init-fn` touched for sanctioned exception only: `REQUIRED_TYPES` + `DEVICES_NEW_DDL` CHECK constraint + `DEVICES_COPY_SQL` verification.
- `test-flows-wiring.js`, `verify-sync-flow.js`, all existing CI checks green.
