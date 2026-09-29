# WATERMARK 200SS soil tension on the Dragino LSN50 — design

Date: 2026-09-25 · Status: draft for owner review · Repos: osi-os (edge), osi-server (cloud)

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
- the cloud mirrors calibration, status and provenance without taking authority
  away from the edge.

## 2. Decisions (owner, 2026-09-25)

| # | Decision |
|---|---|
| D1 | kPa is written as soon as a calibration exists. The scheduler uses a probe only after an explicit **WATERMARK enable**, which has preconditions (§8). |
| D2 | Raw readings sync to the cloud in phase 3, the same way Chameleon's raw table does today. |
| D3 | Code names use `watermark_*` / `WATERMARK_*` throughout, fully qualified (`watermark_calibrations`, `WATERMARK_CALIBRATION_UPSERTED`), never a bare `watermark`, so they stay distinct from the sync code's `SyncResourceWatermark` / `x-watermark-key`. |
| D4 | The LSN50 compensates for measured soil temperature from the start. KIWI keeps its fixed Hz→kPa table in this work; moving KIWI onto the shared conversion is a follow-up issue because it changes live KIWI values. |
| D5 | The conversion helper and the GUI probe section are node-neutral from the start. The LSN50 uses them now; switching KIWI over is a follow-up. |
| D6 | The `SET_CHAMELEON_ENABLED` / `SET_CHAMELEON_CONFIG` mismatch (§10) is fixed in a separate small paired PR before phase 2. |
| D7 | Chameleon and WATERMARK scheduler admission are mutually exclusive on one device, enforced where the flags are written. |
| D8 | One editable calibration row per device with `sync_version`. Each reading records the calibration version and conversion version that produced it. No revision history table. |
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
| Neither clipped, flag `0x04` (unsettled) | Resistance and offset are reported. kPa only if R ≤ 550 Ω (`saturated`); otherwise `unsettled`, no kPa. |
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

`conversion_version` = `wm-lsn50-p3-v1`. It is stored per reading, and any
change to the formulas bumps it.

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

## 7. Phase 2 — sync and cloud parity (cloud deploys first)

**Contract** (osi-os `docs/contracts/sync-schema/`, mirrored byte-for-byte):

- events `WATERMARK_CALIBRATION_UPSERTED` and `WATERMARK_CALIBRATION_DELETED`;
- commands `SET_WATERMARK_CALIBRATION` (values + `base_sync_version`) and
  `DELETE_WATERMARK_CALIBRATION`; phase 3 adds `SET_WATERMARK_CONFIG {enabled}`;
- the cloud derives its phase 2 WATERMARK indicator from calibration existence;
  phase 3 adds a separate calibration-bound scheduler-admission resource;
- golden vectors for each.

**Edge.**

- Outbox triggers are migration-owned and gated on a linked gateway (precedent:
  `zone_irrigation_calibration`).
- The DEVICE event does not change in phase 2. The frozen `sync-init-fn` is not
  edited.
- Command appliers call the phase 1 writer: `stale_sync_version` on a mismatch,
  dedup by delivery `commandId` through `applied_commands`.
- `sync-bootstrap-build` and `sync-force-build` include `watermark_calibrations`,
  so a calibration made before linking is not stranded.

**Cloud (osi-server).**

- Flyway migration: calibration mirror table and device columns.
- Event appliers.
- An `EdgeOwnershipService` case for the device-keyed calibration resource; a
  calibration that arrives before its device is a retryable dependency.
- Controller endpoints that queue the commands, shown as pending, stale or
  applied.
- Capability `watermark_v1` from `gatewayIdentity.syncCapabilities()` gates the
  commands and the GUI per gateway.
- No new rate-limit bucket: calibration travels through sync events and
  commands, which are already covered or unfiltered like every other command
  endpoint.

**Cloud consumers.**

- `zoneSensorPresence.reportsSoilTension`, `HistoryCardService.isSoilSourceDevice`
  / `soilChannelsForDevice` and `AnalysisCatalogService` recognise WATERMARK.
- `soilDepthCm` prefers the generic depths for WATERMARK devices.
- Cloud frontend parity: the probe section, calibration form with
  pending/conflict states, history labels "WATERMARK 1/2", all locales.

**Rollout.** osi-server deploys before any edge that emits the new events.

## 8. Phase 3 — scheduler admission and raw-reading sync

**Calibration-bound scheduler admission.**

- `watermark_scheduler_admissions` is a device-keyed resource with `enabled`,
  the accepted `calibration_sync_version`, its own `sync_version`, and
  `updated_at`. It is not a `devices` column. Its writer (edge API and command
  applier) refuses enable
  unless:
  - a live calibration exists;
  - `chameleon_enabled = 0`;
  - at least one channel had status `ok` or `saturated` in the last 24 h under
    the live calibration version.
- Enable quotes both the admission's base version and the calibration version
  the person accepted. Its command effect key is
  `watermark_scheduler_admission:<EUI>:<base>` and is contract-bound to the
  same device and admission base. The Chameleon flag writer refuses while
  WATERMARK admission is enabled (D7).
- Deleting a calibration disables admission in the same transaction. Updating
  a calibration keeps admission enabled and atomically advances its accepted
  calibration version: the person entering the values is the one accepting
  them. Old readings remain excluded until a new uplink uses that version.
- Sync uses `WATERMARK_SCHEDULER_ADMISSION_UPSERTED` and a dedicated cloud
  mirror. The cloud queues `SET_WATERMARK_CONFIG` against this resource and
  never mutates the mirror directly.
- Cloud ingest tolerates admission arriving before its calibration. It retains
  the edge observation but treats admission as ineffective until the live
  calibration version matches; delivery order alone is never a terminal
  rejection.
- Every newly accepted command advances the admission version and emits its
  mirror event, including a same-value request. This gives the desired-state
  ledger the post-base mirror version it requires to reach APPLIED. Redelivery
  of the same command ID replays its stored result without another write.

**Scheduler.** Add a DRAGINO_LSN50 WATERMARK branch that requires enabled
admission, the admission's calibration version equal to the live calibration,
and the reading's calibration version equal to that same live version. It lifts
the phase 1 interlock (§6) for admitted rows only; every other WATERMARK row
stays excluded. The
existing `trigger_metric` values `SWT_1` / `SWT_2` / `SWT_AVG` cover it, so no
schedule schema change is needed.

**Raw sync.** A `WATERMARK_READING_APPENDED` event mirrors
`CHAMELEON_READING_APPENDED`, with a cloud mirror table and retention. Until
then `watermark_readings` is edge-local: migration `0061` creates it without
outbox triggers, and no flow emits an event for it.

**Bench gate before any field use.** A real-probe dry-down through 2–15 kΩ sets
the unsettled acceptance envelope and confirms forward/reverse agreement.

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

A small paired PR fixes the name. It also adds a test that every command type a
cloud controller issues is in the contract enum. It lands before phase 2.

Status on main at `ca08dcc13`: not implemented. Route Command
(`934bf2bc19a8ce22`) still has no `SET_CHAMELEON_CONFIG` branch. The plan
`docs/superpowers/plans/2026-09-26-chameleon-enabled-command-fix.md` is marked
NOT EXECUTABLE until its tasks are rewritten around the desired-state ledger.

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
- Phase 2: contract schemas and op parity, cloud Gradle tests, mirror byte check.
- Phase 3: flag preconditions, revocation on delete, scheduler admission.

## 12. Out of scope and follow-ups

- **KIWI** onto the shared temperature-compensated conversion and the shared
  probe section (follow-up issue; changes live KIWI values; D4, D5).
- Pull and series drift with die temperature and VDDA (data is recorded for it).
- Firmware changes; automatic calibration; a calibration revision history table.
- **Ops note:** the Pi 4 test gateway will hold misread rows from the bench node
  until phase 1 is deployed there. It is unlinked, so they stay local; they are
  cleaned after deployment with a backup first.

## 13. Phase 2 decisions (confirmed 2026-09-27)

The phase 2 plan (`docs/superpowers/plans/2026-09-26-watermark-lsn50-phase2.md`)
settles §7's choices as follows. The project owner accepted P2-1 through P2-7
on 2026-09-27; these decisions are binding on the implementation plan. The plan
itself is marked REWRITE BEFORE EXECUTION.

- **Cloud indicator (P2-1).** The cloud derives `devices.watermark_calibrated`
  from a live calibration mirror row. The DEVICE event does not change in phase
  2, and the edge gains no `devices` column. As a result the cloud offers the
  calibration form on every LSN50 whose gateway reports `watermark_v1`, and a
  board reflashed back to Chameleon stays WATERMARK on the cloud until its
  calibration is deleted. Phase 3 uses a separate calibration-bound
  scheduler-admission resource; it does not add a phase 2 observation marker.
- **Names (P2-2).**
  - Events are `WATERMARK_CALIBRATION_UPSERTED` / `_DELETED`, with
    aggregateType `WATERMARK_CALIBRATION` and key = device EUI. The payload is
    the whole row, tombstone included.
  - The two commands carry `base_sync_version` (an existing contract property,
    and the desired-state ledger's field) instead of `expected_sync_version`.
  - A stale version is acked `CONFLICT` / `stale_sync_version`.
  - Replays are deduplicated by delivery `commandId` in `applied_commands`;
    §7's "dedup via `sync_inbox`" does not apply to commands.
- **Metadata (P2-3).** All four metadata fields sync. In a command, an omitted
  key keeps the stored value and `null` clears it, as in the edge PUT. The cloud
  form sends all four keys, and desired-state convergence includes all four;
  otherwise a metadata-only edit could be reported applied before the edge
  mirror changed.
- **History before phase 3 (P2-4).** Classification is per device: a calibrated
  LSN50's `swt_1`/`swt_2` are "WATERMARK 1/2", with generic depths. No field is
  added to `DEVICE_DATA`, because that would change v1/v2 history hashes.
  Status, resistance and supply stay on the gateway.
- **Bootstrap (P2-5).** A `watermark_calibrations` bootstrap array, applied on
  the cloud through the same event applier.
- **DEVICE event augmentation.** §7's Sentek-style augmentation is not needed in
  phase 2 because no device field is added. Phase 3 syncs scheduler admission as
  its own resource instead of decorating DEVICE events.
- **Liveness (P2-7).** `watermark-ingest-fn` publishes WATERMARK MQTT telemetry
  (stored values, or a liveness-only message for unknown and rejected frames).
  This restores the cloud `last_seen` refresh and auto-create that phase 1 gave
  up when `Build Telemetry` began dropping FPort 11 uplinks. For a
  gateway-forwarded non-STREGA sensor, `MqttMessageRouter` returns after that
  heartbeat upsert; this path does not refresh `current_state` or persist
  canonical values.
- **Migration numbers.** Phase 1 shipped as `0061__watermark_lsn50.sql`,
  because `0060` went to the RAK10701 field-tester migration first. Phase 2
  and phase 3 take the next free numbers when they are rebased onto main: on
  main at `ca08dcc13` those are `0062` (phase 2) and `0063` (phase 3).
