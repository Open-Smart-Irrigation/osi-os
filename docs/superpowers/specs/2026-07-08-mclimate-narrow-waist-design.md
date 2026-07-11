# Narrow-Waist Pilot — Codec + Normalizer + Manifest-Driven Writer + Round-Trip Gate + LSN50 Shadow

**Status:** Draft — **NEEDS REWRITE for UC512** (see §UC512 rewrite note below). Architecture is ~80% reusable; device-specific sections need replacing.
**Refactor-program items:** 3.1 (DD6: narrow-waist ingest, the second consumer) + 3.2 (`verify-device-integration.js` round-trip gate) + 3.3 (LSN50 shadow mode). Bundled because the writer (3.1), the CI gate that proves it (3.2), and the shadow harness that de-risks retrofitting it onto LSN50 (3.3) are one indivisible design decision — the abstraction is only trustworthy if all three land together.
**Focus: osi-os** (server-side applier is item 3.4, osi-server, separate).
**Depends on:** 1.A1 (`osi-lib` loader — the normalizer and writer load via `osiLib.require`, per that spec's §E rule) and 3.0 (actuator duration-bound gate — merges before any valve downlink code; the valve open MUST be `requires_duration: true`).
**Pilot device:** **Milesight UC512** (confirmed 2026-07-10, replacing MClimate as the first valve integration).

## UC512 rewrite note (2026-07-10 — Fable review)

**The Milesight UC512 will be integrated first**, not MClimate. This spec was written around MClimate's payload and needs updating. Assessment of reusability:

**~80% device-agnostic (reuse as-is):**
- §A normalize contract (pure `normalize(decoded, meta) → {channels}`)
- §B writer (`osi-device-writer`, manifest-driven, closed allow-list, parameterized INSERT, dead-letter to `ingest_quarantine`)
- §D LSN50 shadow mode + the 18 manifest rows
- §F round-trip gate (`verify-device-integration.js`)
- §E surface enumeration structure (surfaces 1–7, 11–13 are device-name-agnostic)
- Plan Tasks 2 (writer), 3.2 (shadow node), 4 (round-trip gate), 6 (schema surfaces), 7 (shadow diff), 10 (verification)

**~20% device-specific (rewrite for UC512):**
- Codec file: `codecs/milesight_uc512_decoder.js` (Milesight SensorDecoders is public; no UC51x codec is vendored in the repo — verified)
- Normalizer: `osi-uc512-normalize` — field mapping from UC512's decoded payload to manifest channels
- ChirpStack profile env names: `UC512_CODEC_PATH`, `CS_PROFILE_UC512_NAME`, `CHIRPSTACK_PROFILE_UC512`
- `devices.type_id`: `MILESIGHT_UC512` (not `MCLIMATE_TVALVE`)
- Golden vectors: from Milesight UC512 datasheet examples

**CRITICAL design delta (Fable review HIGH):** The UC512 is a **two-channel** valve controller (it can control two independent valves per device). The entire current actuation model assumes one valve per `deveui`:
- `valve_actuation_expectations` is keyed by `expectation_id` with `device_eui NOT NULL` but no channel discriminator column — the single-valve assumption is structural (no way to address channel 1 vs channel 2 on the same deveui)
- Zone `valve_deveui` is a single value
- STREGA command wiring addresses one valve per device
- The Decide node's actuation logic assumes one valve per device

**The spec rewrite must decide per-channel command addressing** — whether each UC512 channel maps to a separate zone (two zones per device), or whether one device can serve one zone with two valves. `channels.json` currently has **zero valve channels** (verified), so the UC512 integration will add the first valve-state channels.

**DD17 (actuator safety) applies identically:** confirm UC512's device-side auto-close/duration-bound from the Milesight datasheet before any downlink code. The 3.0 gate mechanism is device-agnostic.
**Governing decisions:** DD6, DD7, DD8, DD17 in [`docs/architecture/refactor-program-2026.md`](../../architecture/refactor-program-2026.md); ADRs [static device plugins](../../adr/2026-05-28-static-device-plugin-registry.md) + [schema & contract ownership](../../adr/2026-06-30-schema-and-contract-ownership.md).

## Problem

Adding a LoRaWAN device to OSI today means hand-editing ~8 surfaces and hand-writing a per-device SQL string-builder. The five existing devices each have a bespoke "Build SQL INSERT" function node (`lsn50-sql-fn`, `s2120-sql-fn`, `lorain-sql-fn`, `strega-sql-fn`, and the KIWI/chameleon path) that string-interpolates a `device_data` INSERT with device-specific columns and its own `sqlStr()`/`sqlNum()` helpers. There is:

- **no shared normalize step** — each node reads a device-specific `msg.formattedData` shape and knows its own column list;
- **no closed allow-list** — a normalizer that emitted an unexpected field would either be silently dropped (the field isn't in the hand-written INSERT) or, if someone added an auto-`ADD COLUMN`, silently mutate schema;
- **no round-trip CI gate** — nothing asserts that a device's codec output, once normalized, writes exactly the columns the channel manifest declares and nothing else.

The channel manifest (`web/react-gui/src/channels/channels.json`, CI-parity-checked by `verify-channel-manifest-parity.js`) already exists and declares `key`/`edgeField`/`serverField`/`exportable`/`legacyAliases` per channel — the narrow waist's backbone. **What's missing is the waist itself:** a pure `normalize(decoded, meta) → {channels}` per device and ONE manifest-driven writer with a closed allow-list, plus the CI gate that proves the round trip.

**Why MClimate now (DD6):** the MClimate T-Valve (#18) is a NEW device *and an actuator*, so it forces the abstraction to express both a sensor uplink (valve state/battery/temperature telemetry) and — critically — an actuator downlink that must be duration-bounded (DD17). Building the narrow waist against a second real consumer is the risk control: "if the manifest can't express what an actuator needs, the abstraction is wrong — learn it there, not after retrofitting six devices" (program Risks section). MClimate is the second consumer that justifies the writer; LSN50 (the highest-volume existing device) is the retrofit target proven in shadow (3.3) but **not cut over in this item** (cutover is 4.1, gated on the DD7 evidence bar).

## Verified ground truth (checked against `main`, 2026-07-08)

1. **The ingest seam is per-device string-built SQL, not parameterized.** `lsn50-sql-fn` ("Build SQL INSERT") takes `msg.formattedData` (a device-specific normalized object, e.g. `d.swt1Kpa`, `d.dendroRatio`, `d.batV`) and builds `msg.topic = 'INSERT INTO device_data (...) VALUES (...)'` via `sqlStr()`/`sqlNum()` string interpolation, branching on `d.detectedMode`. `s2120-sql-fn`, `lorain-sql-fn`, `strega-sql-fn` follow the same shape with different column sets. **This means a `msg.formattedData`-shaped normalize step already exists per device — informally, inline, untested.** The narrow waist formalizes it as a pure module and replaces the string-builder with a manifest-driven writer. (The writer does NOT change the existing five devices in this item — see §D shadow scope; it is *added* for MClimate and *shadowed* against LSN50.)

2. **`channels.json` is the manifest and `verify-channel-manifest-parity.js` gates it.** 25 channel entries today; each has `key`, `unit`, `label`, `cardType`, `category`, `edgeField` (the `device_data` column name, or `null` for server-only channels like `vwc`), `serverField`, `exportable`, `deprecated`, `legacyAliases`. `registry.ts` (`createChannelRegistry`) consumes it in the React build. The `edgeField` values ARE the `device_data` column names the writer must target — e.g. `swt_1`, `ext_temperature_c`, `bat_v`, `dendro_ratio`. **NOT every `device_data` column has a manifest entry — the gap is large and measured.** `lsn50-sql-fn` writes **36 distinct columns** across its two branches; **16 map to a manifest `edgeField`, 18 do NOT** (verified 2026-07-08). The 18 unmapped: `counter_interval_seconds`, `dendro_mode_used`, `dendro_saturated`, `dendro_saturation_side`, `dendro_valid`, `flow_count_cumulative`, `flow_delta_status`, `flow_liters_delta`, `flow_liters_per_10min`, `flow_liters_per_min`, `flow_liters_today`, `flow_pulses_delta`, `lsn50_mode_code`, `lsn50_mode_label`, `lsn50_mode_observed_at`, `rain_count_cumulative`, `rain_delta_status`, `rain_tips_delta`. (The rain-derived channels `rain_mm_per_hour`/`rain_mm_today`/etc. ARE mapped; the gap is the flow, raw-rain-counter, LSN50-mode, and dendro-diagnostic columns.) This gap is load-bearing for §C.3 (the allow-list source) and §D (shadow parity) — half the LSN50 write set needs manifest rows before shadow can be zero-diff, so §D decision (a) is not optional trimming, it is ~18 concrete manifest rows.

3. **MClimate is NOT in the repo.** Grep for `mclimate|t-valve|tvalve|t_valve` (case-insensitive) across `.js`/`.json`/`.ts`/`.md` outside `node_modules`: zero matches. There is no codec, no device type, no card, no channel. Per the batch-C pre-ruling and DD6 ("MClimate vendor payload format: likely NOT in the repo"): **the MClimate byte layout is an EXECUTION-TIME operator-supplied input (the vendor datasheet).** This spec specifies the codec's *structure, interface, and test methodology* and names the datasheet as the source of golden vectors — it does **not** invent byte offsets. Any concrete byte layout in a worker's implementation must be transcribed from the MClimate T-Valve LoRaWAN payload datasheet, cited in the codec header, with golden vectors taken from the datasheet's own worked examples.

4. **Codec delivery surface (verified via 1.A1's spec + `chirpstack-bootstrap.js`).** Codecs live in `conf/<profile>/files/usr/share/node-red/codecs/`, are copied wholesale by `98_osi_node_red_seed` and fetched individually by `deploy.sh`, and are provisioned into ChirpStack device profiles by `chirpstack-bootstrap.js` via `<DEVICE>_CODEC_PATH` env vars + `CS_PROFILE_<DEVICE>_NAME` + a `getOrCreateProfileWithCodec()` call in `bootstrap()`. Adding MClimate means: a new codec file, a new `MCLIMATE_CODEC_PATH` + `CS_PROFILE_MCLIMATE_NAME` env pair, and a new `getOrCreateProfileWithCodec()` call + a `CHIRPSTACK_PROFILE_MCLIMATE` UCI/env output (the bootstrap already emits `CHIRPSTACK_PROFILE_LSN50` etc.).

5. **A new `devices.type_id` triggers the FULL boot-node merge gate.** Per `.claude/skills/osi-schema-change-control/SKILL.md`: adding `MCLIMATE_TVALVE` to `devices.type_id` extends the sanctioned `sync-init-fn` `REQUIRED_TYPES` set (currently `KIWI_SENSOR, STREGA_VALVE, DRAGINO_LSN50, TEKTELIC_CLOVER, SENSECAP_S2120, AQUASCOPE_LORAIN`) AND requires: an ordered migration (destructive-class, since a CHECK change is a table rebuild), `seed-blank.sql` update, all 7 bundled `farming.db` copies rebuilt, `verify-runtime-schema-parity.js` + `verify-db-schema-consistency.js` + `verify-devices-rebuild-fence.js` extended, and `rehearse-devices-rebuild.test.js` re-run. **This is the single largest sub-task and its cost is cited, not re-derived** — see §E's surface enumeration and the plan's schema task.

6. **Device-catalog surfaces for a new type (enumerated, verified):** (a) `devices.type_id` CHECK in `seed-blank.sql` + 7 bundled DBs; (b) `REQUIRED_TYPES` in `sync-init-fn` (both profiles) + the destructive migration; (c) the three schema parity/fence verifiers + rehearse test; (d) ChirpStack profile + codec in `chirpstack-bootstrap.js` + env; (e) the MQTT-IN → normalize → write ingest path in `flows.json`; (f) the codec file under `codecs/`; (g) React: `DeviceType` union in `web/react-gui/src/types/farming.ts`, the `catalog-response` node's hardcoded list (`GET /api/catalog`), `AddDeviceModal`/`IrrigationZoneCard` device-type filters, and a device card component; (h) `channels.json` (only if MClimate needs channels not already declared). §E rules each in-scope or deferred.

7. **`error_counts` + `node.error` chain exists** (per 1.A1 §C and the canary-gate spec): a `node.error(...)` feeds `global.error_counts.total`/`.last` via the "Record Error" function; the heartbeat surfaces `errors_total`. The dead-letter mechanism (pre-ruled) uses `node.error` → `error_counts` for heartbeat visibility PLUS an `ingest_quarantine` table row.

8. **`verify-device-integration.js` does NOT exist** (confirmed: `ls` returns "No such file or directory"). Item 3.2 creates it. It is a NEW verifier, wired into CI alongside the existing edge verifiers.

## Design

The narrow waist has three parts, in dataflow order: **normalize** (pure, per device) → **writer** (one, manifest-driven, closed allow-list) → **round-trip gate** (CI, proves the two compose to exactly the manifest columns). Then **shadow** (3.3) runs the new writer alongside the old LSN50 path and diffs, producing the DD7 evidence without risking LSN50.

### A. The normalize contract — pure `normalize(decoded, meta) → { channels }`

**Signature (frozen contract every device normalizer implements):**

```js
// normalize(decoded, meta) -> NormalizeResult
//   decoded: the codec's decodeUplink output (the raw per-device object; MClimate's
//            comes from the vendor codec, LSN50's is today's msg.formattedData-equivalent)
//   meta:    { deveui, typeId, recordedAt, fPort, rawHex } — device identity + envelope,
//            NOT payload-derived (so a normalizer never re-decodes)
// returns:  { channels: { <manifestKey>: <value|null>, ... }, unknown: { <field>: value } }
//   channels: ONLY keys that are manifest `key`s (the closed vocabulary). Values are
//             already unit-correct (kPa for SWT, °C, V, etc. — the manifest `unit`).
//   unknown:  fields the normalizer produced that map to NO manifest key — surfaced,
//             NEVER silently dropped. The writer dead-letters these (§C.4).
```

- **Pure and side-effect-free:** no DB, no Node-RED globals, no `require` of anything but Node builtins. Loaded via `osiLib.require('mclimate-normalize')` (1.A1 §E rule; registered in `NAME_TO_PATH`, three-surface packaged). This makes it `node --test`-able off-device with plain fixtures.
- **Channel keys, not column names.** The normalizer speaks the manifest's `key` vocabulary (`swt_1`, `ext_temperature_c`, `bat_v`, …); the writer resolves `key → edgeField` (the actual `device_data` column) via the manifest. This is the indirection that lets the manifest be the single field-name truth (DD5/DD6) — a normalizer never hard-codes a column name.
- **`unknown` is the closed-allow-list enforcement point at authoring time.** If a normalizer wants to emit a value with no manifest `key`, it puts it in `unknown` and the writer dead-letters it — the author's signal to *add a manifest row first* (which goes through `verify-channel-manifest-parity.js`), never to sneak a column in. The round-trip gate (§B) fails if a normalizer's `channels` contains a non-manifest key, so "put it in `channels` anyway" cannot pass CI.

**MClimate normalizer specifics (structure only — bytes are datasheet-sourced):** the T-Valve uplink reports (per the MClimate T-Valve datasheet, to be cited in the codec) at minimum: battery voltage, target/current valve opening (%), device temperature, and open/close/status flags. The normalizer maps these to manifest channels — **and here the abstraction earns its keep or fails:** if the T-Valve needs a channel the manifest doesn't have (e.g. `valve_open_pct`, `target_temperature_c`), that channel must be **added to `channels.json` first** (with `edgeField` = a new `device_data` column, itself an additive ordered migration + 7-DB update). §E lists this. If the T-Valve's telemetry maps cleanly onto existing channels (`bat_v`, `ambient_temperature`), no new channel is needed. **The worker MUST enumerate the T-Valve's uplink fields from the datasheet and decide per-field: existing manifest key, new manifest key (+ migration), or `unknown`/not-persisted.** Do not guess the field set here.

### B. The writer — one module, manifest-driven, closed allow-list

**`osi-device-writer` (new helper module, `osiLib.require('device-writer')`):** a single function that turns a `NormalizeResult` + `meta` into a persisted `device_data` row.

```js
// writeDeviceData(db, manifest, normalizeResult, meta) -> { inserted, deadLettered, columns }
//   1. Resolve each channels[key] -> manifest entry -> edgeField (the column). A key with
//      no manifest entry, or a manifest entry whose edgeField is null (server-only channel
//      like vwc), is NOT writable to device_data -> routed to dead-letter with reason
//      'unmapped_channel' / 'server_only_channel'. This is the CLOSED ALLOW-LIST: the set of
//      writable columns is exactly { manifest entries where edgeField != null }, computed
//      from the manifest, never from the normalizer's output.
//   2. Build a PARAMETERIZED insert (not string interpolation — a correctness upgrade over
//      the existing sql-fn nodes' sqlStr/sqlNum): INSERT INTO device_data (deveui, <cols>,
//      recorded_at) VALUES (?, ?..., ?). Only manifest-declared, edgeField-non-null columns
//      plus the fixed envelope columns (deveui, recorded_at) may appear. The column list is
//      validated against a cached PRAGMA table_info(device_data) column set at first call:
//      a manifest edgeField that is NOT an actual device_data column is a HARD ERROR (fail
//      the write + dead-letter + node.error), never an auto-ALTER (DD6: never auto-DDL).
//   3. normalizeResult.unknown -> dead-letter each, reason 'unknown_channel'.
//   4. Never drop silently: every key in channels is either written, dead-lettered, or (for
//      a null value on a real column) written as NULL — the accounting must be total.
```

- **Closed allow-list, three ways it stays closed:** (i) writable columns = manifest `edgeField != null` ∩ actual `device_data` columns — a manifest typo or a column-less channel can't create a column; (ii) `unknown` fields never reach SQL; (iii) a manifest `edgeField` naming a non-existent column is a hard error, not an `ADD COLUMN`. There is **no code path in the writer that emits DDL.**
- **Dead-letter mechanism (pre-ruled, not reopened):** a small additive `ingest_quarantine` table — **ordered migration, additive-class**, row-capped ~1,000 with oldest-eviction, columns `payload` (raw hex + decoded JSON) + `channel` + `deveui` + `reason` + `received_at`. Plus `node.error(...)` (→ `error_counts` → heartbeat `errors_total`, per §7). A quarantined channel is NEVER silently dropped and NEVER auto-DDL'd. The `ingest_quarantine` table is its own schema task (additive migration + `seed-blank.sql` + 7 DBs + `verify-db-schema-consistency.js` extension) — cheaper than the `devices.type_id` rebuild (additive, no FK fence, no boot-node touch).
- **Parameterized, not string-built:** the writer uses `db.run(sql, params)` with `?` placeholders. This is a deliberate correctness improvement over the existing `sqlStr()`/`sqlNum()` interpolation, but it is confined to the writer (the shadow path); the existing sql-fn nodes are untouched until 4.1. The round-trip gate asserts the writer's column list, not its SQL string, so the parameterization is transparent to the gate.
- **The writer is generic but has ZERO device knowledge:** it takes the manifest and a `NormalizeResult`; it does not know "LSN50" or "MClimate". Device knowledge lives entirely in the per-device normalizer. This is the DD6 narrow waist: N normalizers, 1 writer.

### C. Wiring MClimate into the ingest flow (flows.json)

MClimate's live path (added, not shadowed — it's a new device): `MQTT IN (existing shared topic application/+/device/+/event/up)` → device-type classification (by ChirpStack profile / `deviceProfileName`, the existing discrimination mechanism — see `osi-config-and-flags`) → **`MClimate Normalize + Write`** function node that: (a) `osiLib.require('device-writer')` + `osiLib.require('mclimate-normalize')` + loads the manifest (bundled as a small JSON the writer reads, or the writer embeds the writable-column allow-list derived from it — decide at plan time whether the edge ships `channels.json` or a derived allow-list; the manifest is a React-src file today, so shipping a derived edge copy + a parity check is the likely answer, mirroring the DD5 "channels.json as shared truth" direction). The node opens `osiDb.Database`, calls `normalize` then `writeDeviceData`, closes the DB (the `.close(` audit in `test-flows-wiring.js` applies), and `node.error`s on writer failure.

- **The actuator downlink (DD17 gate):** the T-Valve open command MUST enter the Command Type Registry as `actuator: true, requires_duration: true` (or item 3.0's gate fails the merge). The T-Valve's native open is duration-capable per its datasheet (MClimate valves support a timed open); the downlink codec encodes the duration into the payload so the *device firmware* auto-closes — the DD17 failsafe. If the datasheet reveals the T-Valve has NO device-side auto-close, that is a **blocking finding**: MClimate cannot be an OSI actuator under DD17 without one, and the item escalates to a FABLE-DECISION rather than shipping an unbounded valve. (State this honestly; do not assume the capability.)
- **Flows edits** follow `.claude/skills/osi-flows-json-editing/SKILL.md`: one-shot Node mutation script, roundtrip guard, both profiles, `libs` entries for `osiLib`/`osiDb`, `.close(` present, new node ids minted fresh. The new ingest node is additive (own MQTT-routed path), not a tee into a shared node.

### D. Shadow mode on LSN50 (3.3) — evidence without risk

**Non-destructive compare, per pre-ruling:** the existing `lsn50-sql-fn` path keeps writing (unchanged — it is the source of truth during shadow). A NEW shadow node runs the SAME LSN50 uplink through `normalize('lsn50', decoded)` + `writeDeviceData(... , { shadow: true })`, where **shadow mode COMPUTES the row and DIFFS it against what the old path wrote, but does NOT persist to `device_data`.** Results (row-level field diffs, including NULL-vs-absent-column and dedup/duplicate-uplink semantics) are logged to a **local shadow-diff table** (`lsn50_shadow_diff`, additive migration — or a flat file the 4.1 runbook reads; decide at plan time, table preferred for queryability). This is what produces the DD7 evidence bar (§ below).

- **Requires an LSN50 normalizer** (`osiLib.require('lsn50-normalize')`) that reproduces today's `lsn50-sql-fn` field mapping as a pure module. This is the "prove the pattern on the highest-volume device" step. Building it is behavior-preserving extraction (golden vectors captured from the old node first, per the program's extraction mandate) — the shadow diff being **zero** is the proof the extraction is faithful.
- **The diff must be semantically aware, not naive:** the old string-built path writes `NULL` for absent fields and has MOD9-vs-default column-set branching (`d.detectedMode === 9`); the writer writes only manifest columns. Each of the **18 columns `lsn50-sql-fn` writes but the manifest does not declare** (enumerated in §2) will show as a diff UNLESS the manifest is extended to declare it. **This is the central finding shadow mode surfaces:** the manifest is currently narrower than the LSN50 column set by exactly half its write set, so a faithful shadow either (a) requires extending `channels.json` to cover every LSN50 column the old path writes, or (b) the writer supports a per-device "extra columns" extension beyond the manifest — which would breach the closed allow-list. **Decision: (a)** — the manifest must grow to cover every column any device legitimately writes; the closed allow-list stays closed; extending the manifest is the sanctioned, CI-gated way to add a writable column. The shadow-diff-driven manifest expansion for LSN50 is a concrete deliverable of 3.3: **~18 new `channels.json` rows**, one per unmapped column in §2's list. These columns **already exist in `device_data`** (the old path writes them today), so this is manifest rows, NOT new columns/migrations, in every case — a pure additive manifest change gated by `verify-channel-manifest-parity.js`. Pure-diagnostic columns (e.g. `lsn50_mode_code`, `dendro_saturation_side`, `flow_delta_status`) get a manifest entry with `exportable: false` (like `bat_v`/`bat_pct` today) rather than an allow-list bypass; the flow-metering columns (`flow_liters_today`, etc.) are legitimately chartable and get `exportable: true`.

**DD7 evidence bar (consumed verbatim, LAW):** the LSN50 cutover (item 4.1, NOT this item) may proceed only after **≥14 days OR ≥500 live LSN50 uplinks per gateway, with ZERO row diffs and ZERO dead-letters** in `lsn50_shadow_diff`, on the demo gateways first, then production; rest of fleet convert-on-touch only. This item's job is to *stand up the measurement*, not to pass the bar. The 4.1 runbook reads the shadow-diff table to judge the bar.

### E. Device-catalog surface enumeration for `MCLIMATE_TVALVE` (DD6 completeness requirement)

Every surface a new device type touches, each ruled in-scope or deferred (the pre-ruling permits deferring the React card to a follow-up UI item — decision below):

| # | Surface | In this item? | Rationale |
|---|---|---|---|
| 1 | `devices.type_id` CHECK: `seed-blank.sql` + 7 bundled DBs | **Yes** | A device can't be registered without it; destructive migration (CHECK rebuild). |
| 2 | `REQUIRED_TYPES` in `sync-init-fn` (both profiles) | **Yes** | Sanctioned boot-node exception; set-equality guard converges the live CHECK. Full merge gate (fact 5). |
| 3 | `verify-runtime-schema-parity.js` + `verify-db-schema-consistency.js` + `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js` | **Yes** | Parity gates for the CHECK change; all must pass. |
| 4 | Ordered destructive migration for the CHECK rebuild | **Yes** | The governed schema authority (ADR); risk: destructive; not run on-device yet but the durable record. |
| 5 | `ingest_quarantine` table (additive migration + seed + 7 DBs + consistency verifier) | **Yes** | The dead-letter mechanism the writer needs. Additive, cheaper than #4. |
| 6 | Any NEW `device_data` columns for T-Valve channels (additive migration + seed + 7 DBs) + `channels.json` rows | **Yes, if the datasheet requires channels not already columns** | Decided per-field from the datasheet (§A). May be zero if T-Valve maps to `bat_v`/`ambient_temperature`. |
| 7 | ChirpStack: `MCLIMATE_CODEC_PATH`, `CS_PROFILE_MCLIMATE_NAME`, `getOrCreateProfileWithCodec()` call, `CHIRPSTACK_PROFILE_MCLIMATE` output in `chirpstack-bootstrap.js` | **Yes** | Without a device profile + codec, uplinks never decode. |
| 8 | The codec file `codecs/mclimate_tvalve_decoder.js` (uplink) + downlink encoder | **Yes** | Datasheet-sourced bytes; golden vectors from datasheet examples. |
| 9 | Ingest path in `flows.json`: normalize+write node + downlink command wiring | **Yes** | The live MClimate path (§C). |
| 10 | Command Type Registry: T-Valve open as `actuator:true, requires_duration:true` | **Yes** | DD17 gate (item 3.0) fails otherwise. |
| 11 | `verify-device-integration.js` round-trip gate (item 3.2) | **Yes** | Bundled — proves the writer. |
| 12 | React `DeviceType` union (`farming.ts`), `catalog-response` list, `AddDeviceModal`/`IrrigationZoneCard` filters | **Yes (minimal)** | `DeviceType` union + catalog list are one-line additions and are needed for the device to be *registerable* via the GUI. Cheap, in-scope. |
| 13 | A dedicated MClimate device **card** component (`MClimateValveCard.tsx`) + its test | **DEFERRED to a follow-up UI item** | The card is presentation-only; the device functions (registers, ingests, actuates) without a bespoke card — it can render via a generic/valve fallback until the UI item lands. Deferring keeps this (already-L) item focused on the ingest narrow waist. Explicit deferral per the pre-ruling's "React card MAY be deferred." |

**Decision on the card (pre-ruling asks us to decide):** DEFER the bespoke card to a follow-up UI item; ship the `DeviceType` union + catalog entry so the device is registerable and its telemetry is queryable, with a generic rendering fallback. The narrow-waist ingest (the actual DD6 deliverable) does not depend on the card.

### F. The round-trip gate — `verify-device-integration.js` (item 3.2)

**A NEW CI verifier asserting the full round trip for every device wired into the narrow waist:** for each registered device normalizer, feed its golden decoded vectors (the codec's `decodeUplink` output, captured from datasheet examples for MClimate and from real uplinks for LSN50) through `normalize`, then through `writeDeviceData` against a **scratch SQLite DB seeded from `seed-blank.sql`**, and assert:

1. **Every key in `normalize().channels` is a manifest `key`** (no non-manifest channels — the closed-vocabulary check at the normalize boundary).
2. **The set of `device_data` columns actually written == exactly the manifest-declared writable columns for those channels** (manifest `edgeField != null` for the emitted keys) **plus the fixed envelope** (`deveui`, `recorded_at`) — and NOTHING else. No stray columns, no missing columns. This is the "manifest-declared columns and nothing else" assertion the charter names.
3. **`normalize().unknown` is empty for a well-formed golden vector** (a normalizer that produces unknowns on its own datasheet examples is mis-mapped) — but a deliberately-malformed vector asserts unknowns are dead-lettered, not dropped (accounting-total check).
4. **The writer emits ZERO DDL** — assert the scratch DB's schema is byte-identical before and after a write (fingerprint compare) — pinning "never auto-DDL" (DD6) as a test, not a hope.
5. **Parameterization** — a golden vector containing a SQL-hostile value (e.g. an apostrophe in a string field, if any string channels exist) round-trips correctly and does not corrupt the row — pinning the correctness upgrade over `sqlStr()`.

Wired into CI (a new `- run: node scripts/verify-device-integration.js` in the appropriate workflow, plus `node --test` for its co-located unit tests). Golden vectors live in a fixtures dir (`scripts/fixtures/device-integration/<device>/*.json` or similar); MClimate's cite the datasheet page/example they came from.

## Non-goals

- **LSN50 cutover** — that is item 4.1 (runbook), gated on the DD7 bar this item merely *measures*. The five existing sql-fn nodes are untouched here.
- **Migrating the other four devices onto the writer** — convert-on-touch (DD7); only MClimate uses the writer live, only LSN50 is shadowed.
- **Server-side MClimate applier** — item 3.4 (osi-server, `SyncEventApplier`, DD12).
- **The bespoke MClimate React card** — deferred (§E #13).
- **Inventing MClimate byte offsets** — datasheet is an execution-time operator input (§3).
- **Feature-flag framework** — none (DD8); shadow mode needs no flag (old path writes, new path computes+diffs). The 4.1 cutover uses ONE temporary UCI kill-switch (DD8), owned by that item.
- **Any osi-server change.**

## Definition of Done

- **Normalize contract** (§A) documented + implemented as `osiLib.require`-loaded pure modules for MClimate and LSN50, each with co-located `node --test` golden-vector suites; both registered in `NAME_TO_PATH` and three-surface packaged (per 1.A1 §E); `verify-helper-registration.js` green.
- **`osi-device-writer`** (§B): one manifest-driven, closed-allow-list, parameterized writer; emits ZERO DDL; dead-letters unmapped/unknown/server-only channels to `ingest_quarantine`; `node.error` → `error_counts`. Co-located unit tests.
- **`ingest_quarantine` table**: additive ordered migration + `seed-blank.sql` + 7 bundled DBs + `verify-db-schema-consistency.js` extended; row-cap ~1,000 oldest-eviction; columns per pre-ruling.
- **`MCLIMATE_TVALVE` device type**: destructive CHECK-rebuild migration + `seed-blank.sql` + 7 DBs + `REQUIRED_TYPES` (both profiles) + all four schema verifiers/rehearse green + `DeviceType` union + `catalog-response` entry + `AddDeviceModal`/`IrrigationZoneCard` filter. Full boot-node merge gate satisfied (fact 5).
- **MClimate codec** (`codecs/mclimate_tvalve_decoder.js` uplink + downlink), datasheet-cited, golden vectors from datasheet examples; ChirpStack profile + `MCLIMATE_CODEC_PATH`/`CS_PROFILE_MCLIMATE_NAME`/`CHIRPSTACK_PROFILE_MCLIMATE` in `chirpstack-bootstrap.js`.
- **T-Valve open** in the Command Type Registry as `actuator:true, requires_duration:true`; item 3.0's gate green; downlink encodes device-side auto-close duration (or FABLE-escalated if the datasheet shows no auto-close).
- **MClimate live ingest node** in `flows.json` (both profiles, byte-parity, `libs`/`.close(` correct, roundtrip-guarded); flows pre-commit checklist green.
- **LSN50 shadow node** (§D) computing + diffing to `lsn50_shadow_diff` (additive migration + surfaces), NOT persisting; LSN50 normalizer extraction is behavior-preserving (golden vectors captured first); the shadow-diff is the DD7 evidence source.
- **`channels.json` extended** as needed so every LSN50 column the old path writes has a manifest entry (§D decision (a)); `verify-channel-manifest-parity.js` green.
- **`verify-device-integration.js`** (§F): the five-assertion round-trip gate + co-located tests, wired into CI, green for both MClimate and LSN50.
- Both profiles byte-parity for every changed `conf/` file; frozen `sync-init-fn` untouched except the sanctioned `REQUIRED_TYPES` set-equality extension.
- This document's "Open decisions" section shows none outstanding.

## Open decisions

None outstanding — each is resolved inline above:

- **Where the edge gets the manifest's writable-column allow-list** — ship a derived edge copy of `channels.json` (or the derived allow-list) + a parity check, mirroring DD5's "channels.json as shared truth" direction (§C). Final form (full JSON vs derived allow-list) is a plan-time mechanical choice; the parity check is mandatory either way.
- **LSN50 columns absent from the manifest** — extend `channels.json` to cover them (§D decision (a)); closed allow-list stays closed; pure-diagnostic columns get `exportable:false` manifest rows, never an allow-list bypass.
- **MClimate React card** — DEFERRED to a follow-up UI item; ship `DeviceType`+catalog so the device is registerable (§E #13).
- **MClimate byte layout** — execution-time datasheet input; codec header cites it; golden vectors from datasheet examples; NOT invented here (§3, §A).
- **T-Valve device-side auto-close** — required by DD17; if the datasheet shows none, escalate to FABLE-DECISION rather than ship an unbounded valve (§C).
- **Shadow-diff sink** — a local `lsn50_shadow_diff` table (queryable by the 4.1 runbook), preferred over a flat file (§D).
- **Dead-letter table** — `ingest_quarantine`, pre-ruled shape, additive migration (§B).
