# WATERMARK 200SS soil tension on the Dragino LSN50 — design

Date: 2026-09-25 · Status: Phase 1 reference; §§7–8 and §13 superseded 2026-09-30 · Repos: osi-os (edge), osi-server (cloud)

## 1. Purpose

A custom LSN50v2 firmware (`Open-Smart-Irrigation/LoRa_STM32`, branch
`feature/watermark-profile3-temperature`, PR #1) reads two IRROMETER WATERMARK
200SS probes and a DS18B20 soil thermometer with no added electronics. It sends a
27-byte "profile 3" frame on FPort 11. This design brings those readings into OSI
so a WATERMARK probe on an LSN50 is handled like a WATERMARK probe on a KIWI node:
the probe is the unit and the node is only the transport. The one intended
difference is calibration. The LSN50 measures through the MCU's internal pull
resistors, whose values differ per board and are entered by hand.

Success means:

- the edge decodes profile 3 frames, converts them to kPa with the board's
  calibration and the measured soil temperature, and shows them on both GUIs;
- nothing is ever written from a misread frame;
- a mistyped calibration cannot start irrigation on its own;
- the cloud mirrors calibration and safe contact/canonical history state
  without taking authority away from the edge; raw electrical status and
  per-reading provenance stay local.

## 2. Decisions (owner, 2026-09-25)

| # | Decision |
|---|---|
| D1 | kPa is written as soon as a calibration exists. The scheduler remains interlocked until a later approved Phase 3 design adds explicit, qualification-bound admission (§8). |
| D2 | Raw WATERMARK readings and electrical diagnostics remain edge-local. Cloud parity syncs the calibration resource and canonical `device_data` history only. |
| D3 | Code names use `watermark_*` / `WATERMARK_*` throughout, fully qualified (`watermark_calibrations`, `WATERMARK_CALIBRATION_UPSERTED`), never a bare `watermark`, so they stay distinct from the sync code's `SyncResourceWatermark` / `x-watermark-key`. |
| D4 | The LSN50 compensates for measured soil temperature from the start. KIWI keeps its fixed Hz→kPa table in this work; moving KIWI onto the shared conversion is a follow-up issue because it changes live KIWI values. |
| D5 | The conversion helper and the GUI probe section are node-neutral from the start. The LSN50 uses them now; switching KIWI over is a follow-up. |
| D6 | Chameleon configuration joins the pending-first command foundation defined by the cloud-parity design. Controller, contract, router, capability, and effect-key names must agree before the cloud control is enabled. |
| D7 | Chameleon and WATERMARK scheduler admission are mutually exclusive on one device, enforced where the flags are written. |
| D8 | One editable calibration row per device with `sync_version`. That calibration resource version syncs in Phase 2. Each reading records the calibration and conversion versions that produced it, but those per-reading versions remain edge-local. No revision history table. |
| D9 | kPa only from a measured DS18B20 temperature between 0 and 50 °C. The firmware's 12.5 °C constant never produces kPa. |
| D10 | Frame supply voltage (VDDA, a regulated rail) goes to the raw table. `device_data.bat_v` stays null for profile 3 rows. |

Reviews folded in: an external design review and a Fable adjudication of it
(both 2026-09-25). Claims below marked *verified* were checked in code on
osi-os `main` 50334d12d and osi-server `main` 92d96d23; the branch is rebased onto
osi-os `main` c5bc18314, which adds the soil water-status colours (#352).

## 3. Current state that shapes the design

- **A profile 3 frame is misread today** (verified). `lsn50-decode-fn` always
  runs `dendro.decodeRawAdcPayload(data.data)` without looking at the FPort, and
  the shared codec has no FPort 11 branch. A profile 3 frame therefore writes
  about 41.5 V battery and 330 °C temperature into `device_data`, and the row
  syncs if the gateway is linked. Until phase 1 lands, a profile 3 node belongs
  only on an unlinked gateway (today: the Pi 4 test gateway).
- **The scheduler** (verified, flows.json query node `d0b2b1c1a937e16d`) runs at
  06:00 plus on manual trigger. It averages `swt_*` over the last hour and acts
  on a single point. LSN50 devices are admitted only with `chameleon_enabled = 1`,
  so WATERMARK stays out until a clause is added.
- **History correction already converges** (verified). A plain `UPDATE` of
  `device_data` fires `trg_sync_device_data_dirty_au`. The row then travels
  through `sync_history_dirty_keys` and the history correction phase to the cloud
  `DeviceDataHistoryMapper`. Chameleon's backfill relies on this path. Explicit
  `DEVICE_DATA_APPENDED` events would be rejected as
  `equal_version_payload_conflict` (sync_version is always 0). AGENTS.md's
  guidance to enqueue them is stale and is corrected in phase 1.
- **KIWI** reads the same probe through its own interface. It reports Hz, which
  `Sensor_KIWI / Process Data` maps to kPa with a fixed table and no temperature
  term. The scheduler admits KIWI by device type alone.
- **Chameleon assumptions** (verified) sit in six consumers: the scheduler,
  edge `zoneSoil.ts`, cloud `zoneSensorPresence.ts`, `HistoryCardService`,
  `AnalysisCatalogService` (depth lookup prefers Chameleon depth columns), and
  `DraginoTempCard`.

## 4. The frame (firmware contract, profile 3)

FPort 11, 27 bytes, big-endian.

| Bytes | Field |
|---|---|
| 0 | tag `0xA2` |
| 1 | profile `3` |
| 2–3 | VDDA, mV |
| 4–5 | soil temperature, centi-°C, int16, `-32768` = unknown |
| 6–7 | die temperature, centi-°C, int16, `-32768` = unknown |
| 8 | status: bits 0–1 soil temperature source (0 unknown, 1 firmware constant, 2 DS18B20, 3 reserved); bit 2 DS18B20 read failed; bit 3 die temperature invalid; bits 4–7 reserved |
| 9–17 | probe 1: flags, forward early, forward late, reverse early, reverse late (uint16 each, `0xFFFF` = invalid) |
| 18–26 | probe 2, same layout |

Probe flags: `0x01` ADC error, `0x02` timing error, `0x04` unsettled, `0x08`
setup error, `0x10` charge imbalance, `0x20` experimental circuit (always set).
`0x40` and `0x80` are reserved.

A frame is **rejected whole** (nothing written to `device_data`, one warning
logged, raw bytes kept in the raw table with status `frame_rejected`) if:

- the length is not 27;
- the tag or profile differs;
- any reserved status bit or reserved flag bit is set;
- the source is 3.

## 5. Conversion (node-neutral helper + LSN50 front end)

A new pure helper module `osi-watermark-helper` has two layers.

**Shared probe layer (node-neutral, D5):**
`tensionFromResistance(ohm, soilTempC)` → `{ kpa, status }`. It uses the
IRROMETER 200SS relation already in the firmware reference decoder (`decoder.js`
`tensionKpa`, Shock et al. 1998 segments). Temperature must be 0–50 °C. Below
300 Ω → `short`, no kPa. 300–550 Ω → 0 kPa, `saturated`. Results outside
0–200 kPa → `outside_200ss_range`, no kPa. The module also exports the status
vocabulary (§5.3) that every node type uses.

**LSN50 profile 3 front end:** `parseProfile3(bytes)` and
`resistanceFromCodes(channel, codes, calibration, vddaMv)`.

### 5.1 Resistance and electrode offset

Use the late samples. Let `xf = fwd/4095` and `xr = rev/4095`, with pull-up
`Pu`, pull-down `Pd` and series terms `sf`, `sr` for the channel. Then
`af = (1 − xf)/Pu` and `ar = xr/Pd`. A stable electrode offset `e` (as a
fraction of VDDA, positive on the sense side) gives:

```
xf     = af·(R + sf) + e
1 − xr = ar·(R + sr) − e
⇒  R = (xf + 1 − xr − af·sf − ar·sr) / (af + ar)
   e = xf − af·(R + sf)      offset_mv = e · VDDA_mV
```

This recovers every bench resistor within 0.6 % with |offset| ≤ 1 mV
(fixtures, §11; the worst case is the 0.996 kΩ resistor solving to 1002 Ω).

### 5.2 Clipping, short, open and settling

| Condition (late codes) | Result |
|---|---|
| Probe flags `0x01`, `0x02`, `0x08` or `0x10`, or any `0xFFFF` code | `invalid_sample`; no resistance, no kPa |
| Forward ≥ 4087 or reverse ≤ 8 | `open` (dry beyond range or disconnected); no kPa |
| Reverse = 4095 or forward = 0 (one direction clipped at the rail) | Evaluate the §5.1 formula with the clipped code at its rail. The result is an **upper bound** `r_upper_bound`. Bound ≤ 550 Ω → 0 kPa, `saturated`. Bound < 300 Ω → `short_suspected`, no kPa. Otherwise `wet_offset_clipped`, no kPa, and the GUI shows "≤ N kPa". N is the largest tension any resistance up to the bound can have: the 200SS relation drops at its 8 kΩ segment edge at warm temperatures, so the tension at the bound alone can understate it. |
| Neither direction clipped and R < 300 Ω | `short`; no kPa |
| Neither clipped, flag `0x04` (unsettled) | Converted like a settled reading: temperature rules, then `tensionFromResistance`. A result of `ok` is stored with its kPa and the status `unsettled`; any other result keeps its own status. Until `wm-lsn50-p3-v2` (#415) an unsettled reading above 550 Ω got no kPa. |
| Neither clipped, settled | Temperature rules, then `tensionFromResistance` |

The firmware decoder's short rule (`fwd ≤ 4 ⇒ short`) is **not** copied. It
would call the swapped-wire wet probe (fwd 0, rev 3826) a short, when that frame
is a wet probe with about 110 mV offset and R ≤ 1.29 kΩ.

The acceptance envelope for unsettled readings during a real dry-down (how much
early/late drift is still trustworthy) is a phase 3 bench gate, not a phase 1
rule.

### 5.3 Temperature and statuses

kPa needs source = 2, a non-sentinel value, bit 2 clear and 0–50 °C. Otherwise
the status is `temperature_missing` or `temperature_out_of_range`, and
resistance and offset are still reported. Provenance comes from the status bits,
never from the value; a real 12.5 °C is valid.

Status vocabulary, per channel: `ok`, `saturated`, `wet_offset_clipped`,
`short`, `short_suspected`, `open`, `unsettled`, `invalid_sample`,
`calibration_required`, `temperature_missing`, `temperature_out_of_range`,
`outside_200ss_range`, plus `frame_rejected` at frame level.

`conversion_version` = `wm-lsn50-p3-v2` since #415 (`v1` withheld kPa from
unsettled readings). It is stored per reading, and any change to the formulas
bumps it.

## 6. Phase 1 — edge: decode, convert, display (no sync, no scheduler admission)

**Scheduler interlock.** The scheduler query excludes every `device_data` row
that is a WATERMARK observation (`NOT EXISTS` on `watermark_readings.device_data_id`).
Without it, a board still flagged `chameleon_enabled` after a reflash would feed
WATERMARK kPa, including backfilled rows, into irrigation. Phase 3 replaces the
interlock with the explicit enable.

**Access.** With scoped access off, the calibration routes verify the bearer
inline and require the owner; no code path loads the scope helper. With scoped
access on, writes trust `scoped-device-config-guard` (bearer, role and device
access already checked, so an assigned researcher can write), and reads are
account-wide.

Bench-safe on a linked gateway: the only thing that reaches the cloud is the
`device_data` row it already syncs today, now with correct values.

**Ingest.**

- `lsn50-decode-fn` dispatches on `fPort === 11` **before** the raw fallback, and
  the helper parses the raw bytes itself (`data.data`). A stale codec on a
  gateway therefore cannot corrupt the path.
- FPort 2 behaviour stays byte-identical, pinned by the existing Chameleon golden
  frames.
- The shared codec `dragino_lsn50_decoder.js` gets a matching FPort 11 branch
  that emits raw fields only, for ChirpStack's event view. A parity test runs the
  codec and the helper over the same golden frames.

**Writes.** Each accepted frame writes:

- one `watermark_readings` row;
- one `device_data` row with `swt_1`, `swt_2` (kPa or null) and
  `ext_temperature_c` (the DS18B20, regardless of `temp_enabled`); `bat_v` stays
  null (D10).

**Schema** (migration `0061`, seed, all 7 bundled DBs via `build-seed-db`; the
Pi 4 tree by propagation). No `devices` column: a new devices column would force a
change to the frozen boot node's `DEVICES_COLUMNS` table, and phase 1 does not need
one.

- `watermark_calibrations`: `deveui` PK; `pullup_1_ohm`, `pulldown_1_ohm`,
  `series_fwd_1_ohm`, `series_rev_1_ohm` and the same four for channel 2;
  `measured_at`, `method`, `worst_residual_pct`, `notes`, `sync_version`,
  `updated_at`, `deleted_at`.
  - CHECKs: pulls 25 000–65 000 Ω, series 0–500 Ω.
- `watermark_readings`: `id`, `deveui`, `recorded_at`, `fcnt`, `payload_hex`,
  `tag`, `profile`, `supply_mv`, `soil_temp_c`, `soil_temp_source`,
  `die_temp_c`, `status_byte`.
  - Per channel: `flags`, four codes, `r_fwd`, `r_rev`, `r_solved`,
    `offset_mv`, `r_upper_bound`, `kpa_upper_bound`, `status`, `kpa`.
  - `calibration_sync_version`, `conversion_version`.
  - `device_data_id`: the exact id of its `device_data` row, read with
    `last_insert_rowid()` in the same transaction as the device writer's
    INSERT. `device_data` has no UNIQUE(deveui, recorded_at), so every link
    (backfill, scheduler interlock, device list) goes by id, never by
    timestamp.
  - Kept indefinitely, like `chameleon_readings` (the edge DB is the full local
    history).
- WATERMARK detection: the device list joins the `watermark_readings` row of
  each device's **latest** `device_data` row. The WATERMARK section and its
  fault statuses exist only while the current observation is a WATERMARK one,
  so an old WATERMARK fault never outlives a board swap.

**Calibration writer.**

- One transactional writer behind `GET/PUT/DELETE
  /api/devices/:deveui/watermark/calibration`. `GET` follows the account-wide read
  pattern; `PUT` and `DELETE` go through `scoped-device-config-guard`.
- `PUT` carries `expected_sync_version`; a mismatch returns 409
  `stale_sync_version`.
- `PUT` metadata (`measured_at`, `method`, `worst_residual_pct`, `notes`) is
  partial: an omitted field keeps its stored value, so a coefficients-only save
  from the GUI keeps the bench provenance; an explicit null or empty string
  clears the field. On a first save, or after a delete, an omitted field is
  null.
- `DELETE` writes a tombstone and bumps the version.
- `PUT` with `dry_run: true` is the preview: it validates the candidate and
  returns resistance, offset, status and kPa for the latest stored frame under it,
  without saving.

**Backfill.**

- Runs only when a calibration is saved, in batches of 500 readings: the
  first batch inside the writer's transaction, each later batch in its own
  transaction, so uplinks and API calls run between batches instead of waiting
  behind weeks of pending readings. A batch that finds the calibration changed
  or deleted stops. A later batch that fails rolls back and ends the loop; the
  saved calibration stands and the response carries `backfill_incomplete:
  true`. A crash between batches, like a failed batch, leaves the remaining
  readings `calibration_required`; the next calibration save converts them.
- Rows are selected by `watermark_readings.ch<n>_status =
  'calibration_required'` and update `device_data` by `device_data_id`, never
  by timestamp and never by `swt IS NULL`.
- Each selected row is recomputed from the original codes, and `device_data` is
  updated with a plain `UPDATE`, so correction sync carries it (§3).
- Recalibration never rewrites readings that already have kPa.

**GUI (edge).** No new card: WATERMARK appears inside the existing LSN50 card,
as the Chameleon section does today.

- A node-neutral `WatermarkProbeSection` (two probes), a section component that
  any device card can embed (the KIWI card later, D5):
  - kPa or "wet, ≤ N kPa";
  - status text;
  - resistance and offset (offset as a probe-health hint);
  - soil and die temperature;
  - supply voltage, labelled "supply", never "battery".
- `DraginoTempCard` shows it when the device list reports a latest WATERMARK
  reading for the device.
- `DraginoSettingsModal` gets a WATERMARK calibration form with live preview,
  and two probe-depth inputs saved through the existing generic
  `soil_moisture_probe_depths_json`.
- Build on the soil water-status colours from #352, don't duplicate them:
  - each probe's kPa gets the shared `SwtStatusIndicator` through
    `classifySwtWaterStatus`, like the Chameleon, KIWI and SDI-12 cards;
  - a clipped probe shows "≤ N kPa". It is coloured `wet` only when N itself
    classifies as wet; a channel without kPa shows no colour.
- `zoneSoil`:
  - `isTensionSensor` accepts WATERMARK devices;
  - a `watermarkChannelFaulted` rule, next to `chameleonChannelFaulted`, drops
    `open`, `short`, `short_suspected` and `invalid_sample` channels from the
    zone summary.
- All shipped locales (edge `lg` per the Luganda policy: human translation
  pending, logged in `docs/i18n/pending-luganda-translations.md`).

**Docs.** Correct AGENTS.md's stale backfill guidance (§3).

## 7. Phase 2 — cloud parity, without scheduler admission

The binding Phase 2 architecture is
`docs/superpowers/specs/2026-09-30-watermark-cloud-parity-design.md`. In summary:

- `WATERMARK_CALIBRATION` is an edge-authoritative resource. The cloud queues
  pending commands and updates its mirror only from edge events or snapshots.
- migration `0068` is reserved for linked-gateway calibration outbox triggers;
  `watermark_readings` gets no sync trigger;
- generic probe-depth and Chameleon configuration edits use the same
  pending-first command foundation while continuing to converge through the
  `DEVICE` aggregate;
- FPort 11 publishes contact-only MQTT. Contact time and canonical reading time
  are separate;
- no raw payload, resistance, offset, flags, status, supply, die temperature,
  per-reading calibration version, or conversion version is synchronized; the
  calibration resource's own `sync_version` is synchronized for concurrency
  and convergence;
- historical channels remain **Soil tension 1/2** until rows carry immutable
  sensor provenance.

Phase 2 qualification work is non-blocking. It does not weaken the Phase 1
scheduler interlock.

## 8. Phase 3 — qualification and scheduler admission

Phase 3 remains disabled and requires a new approved design before
implementation. The earlier admission proposal is superseded in these ways:

- continuity, interpolation, and rolling-median tests are self-consistency
  diagnostics, not independent evidence of soil-tension accuracy;
- qualification needs an independent reference, both channels and polarities,
  cross-channel and ground-state checks, the installed cable length, and a
  versioned applicability envelope;
- each depth needs a temperature measurement, or evidence that one DS18B20
  represents both depths within a predeclared limit;
- individual scheduler samples must pass the envelope without smoothing or
  interpolation;
- per-channel freshness, minimum points, hysteresis, and re-arm rules must be
  fixed before admission can exist;
- changing any of the eight electrical calibration coefficients revokes
  qualification. Fresh evidence and explicit human reacceptance are required.
  Metadata-only edits do not revoke qualification.

Deleting a calibration must still make any future admission ineffective.
Saving new coefficients must never keep admission enabled or automatically
advance an accepted calibration version.

## 9. Error handling summary

- **Malformed or unknown frame:** rejected whole; a raw row with
  `frame_rejected`; nothing in `device_data`.
- **One bad channel:** that channel's `swt` is null with a status; the other
  channel is unaffected.
- **Calibration out of range:** refused by the writer (400), and CHECK
  constraints back it up.
- **Concurrent edits:** the edge version wins; the cloud command is acked
  `stale_sync_version` and the cloud shows the edge state.

## 10. Separate prerequisite (D6)

The cloud issues `SET_CHAMELEON_ENABLED` (`DeviceController.java:296`), but the
contract and the edge registry only know `SET_CHAMELEON_CONFIG`. As a result the
cloud Chameleon toggle never applies on the gateway.

The cloud-parity foundation fixes this through pending-first
`SET_CHAMELEON_CONFIG`. Controller, contract, edge registry, route, capability,
and effect key must agree. A parity test checks every command type issued by a
cloud controller against the contract and edge router before the control is
enabled.

Historical status at `ca08dcc13`: not implemented. Route Command
`934bf2bc19a8ce22` had no `SET_CHAMELEON_CONFIG` branch. The plan
`docs/superpowers/plans/2026-09-26-chameleon-enabled-command-fix.md` is marked
NOT EXECUTABLE until its tasks are rewritten around the desired-state ledger
and the cloud-parity design.

## 11. Tests

**Golden frames (§4 rejection rules):**

- the firmware's golden frame;
- malformed variants (length, tag, profile, reserved bits, source 3).

**Bench fixtures** (calibration: ch1 Pu 41 670 / Pd 41 260 / sf 130 / sr 112;
ch2 Pu 42 530 / Pd 42 070 / sf 46 / sr 27; VDDA 3300):

| Frame (late fwd / rev) | Expected |
|---|---|
| ch1 open 4093 / 2 | `open` |
| ch1 wire 12 / 4085 | R ≈ −9 Ω → `short` |
| ch1 0.996 kΩ 108 / 3987 | R 1002 Ω, offset ≈ 0 |
| ch1 9.97 kΩ 800 / 3291 | R 9977 Ω |
| ch1 29.95 kΩ 1716 / 2369 | R 29 938 Ω |
| ch2 0.996 / 9.97 / 29.96 kΩ | 995 / 9979 / 29 958 Ω |
| ch2 wire 4 / 4093 | `short` |
| WM2 in water 71 / 4058 | R 529 Ω, +13 mV → 0 kPa `saturated` |
| WM2 later 39 / 4037 | R 471 Ω, −8 mV → `saturated` |
| WM1 in water 276 / 4095 | bound 1325 Ω, offset ≥ 115 mV → `wet_offset_clipped` |
| WM1 swapped 0 / 3826 | bound 1287 Ω → `wet_offset_clipped` (not `short`) |

**Other cases:**

- Temperature: source 1 (constant) → no kPa; source 2 at 12.5 °C → kPa;
  sentinel; bit 2 set; out of range.
- Chameleon FPort 2 regression through `lsn50-decode-fn`.
- Calibration writer: stale version, tombstone, backfill selects only
  `calibration_required` and converges through correction sync (verify-sync-flow).
- Schema: seed replay, db-schema-consistency, runtime-schema-parity,
  profile-parity.
- Phase 2: contract schemas and operation parity, pending-state convergence,
  gateway binding, separate contact/reading timestamps, and proof that no raw
  diagnostic field leaves the edge.
- Phase 3: not executable. A later plan must test independent-reference
  qualification, revocation after a material calibration change, explicit
  reacceptance, and the approved per-channel sampling policy.

## 12. Out of scope and follow-ups

- **KIWI** onto the shared temperature-compensated conversion and the shared
  probe section (follow-up issue; changes live KIWI values; D4, D5).
- Pull and series drift with board temperature and VDDA (data is recorded for
  local diagnosis).
- Firmware changes; a calibration-fit wizard; a calibration revision history
  table. The wizard is a later operator aid, not a Phase 2 release gate.
- **Ops note:** the Pi 4 test gateway will hold misread rows from the bench node
  until phase 1 is deployed there. It is unlinked, so they stay local; they are
  cleaned after deployment with a backup first.

## 13. Cloud-parity supersession (2026-09-30)

The earlier Phase 2 decisions and the old Phase 2/3 implementation plans are
superseded by
`docs/superpowers/specs/2026-09-30-watermark-cloud-parity-design.md`.

In particular, calibration existence is not proof of historical row
provenance; the cloud uses neutral Soil tension 1/2 labels. FPort 11 MQTT is
contact-only. Raw diagnostics do not sync. Migration `0068` is reserved for
the edge cloud-parity change. Scheduler admission remains disabled pending an
independently referenced qualification and a separately approved sampling
policy.
