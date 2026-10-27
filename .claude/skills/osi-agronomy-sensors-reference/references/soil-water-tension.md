# Soil water tension

Part of the osi-agronomy-sensors-reference skill; read SKILL.md first.

## Soil water tension (SWT)

**Definition (as used here):** SWT is the suction (matric potential) the soil
exerts on water — the force a root must overcome to extract it. Higher tension
means drier soil; lower tension means wetter soil. It is not the same
quantity as VWC (volumetric water content); this repo does not convert
between them.

**Storage and sign convention (verified, load-bearing):**
- Canonical channels are `device_data.swt_1`, `swt_2`, `swt_3` in **kPa**, and
  they are stored and compared as **positive numbers where higher = drier**.
  Verified in three independent places:
  1. The Chameleon resistance→kPa conversion clamps to `[MIN_KPA=0, MAX_KPA=300]`
     — `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`,
     function `resistanceOhmsToKpa`.
  2. The irrigation scheduler compares `meanKpa >= threshold` (drier soil reads as a larger positive kPa); locate the current predicate with the grep in the provenance section
     — `flows.json` node id `5f0d2b7e9b9b1b3a` ("Decide + build actuator cmd +
     build DB logs"). Rising kPa past the threshold triggers irrigation, i.e.
     higher kPa = drier = irrigate.
  3. The GUI's SWT summary bucketing treats low kPa as "Wet" and high kPa as
     "Dry": `mean < 20` → Wet, `mean < 60` → Moderate, else Dry
     (`web/react-gui/src/utils/swt.ts`, `summarizeSwtValues`).
- Legacy `device_data.swt_wm1` / `swt_wm2` are **read-only aliases** for old
  rows (pre-canonicalization); new writes go to `swt_1`/`swt_2`/`swt_3`. Reads
  should coalesce canonical-then-legacy — `flows.json`'s latest-data query uses
  `COALESCE(dd.swt_1, dd.swt_wm1) AS swt_1`.
- `irrigation_schedules.threshold_kpa` is validated `0 < x ≤ 300` for
  non-DENDRO trigger metrics (`flows.json`, "Verify Zone Ownership" node); for
  `trigger_metric = 'DENDRO'` the same column instead holds an **encoded
  1-4 stress level** (1=mild … 4=severe), not a kPa value — do not treat
  `threshold_kpa` as kPa when the metric is DENDRO.
- **Trigger-metric CHECK is a schema contract, not agronomy semantics.** If
  `irrigation_schedules.trigger_metric` accepts or rejects the wrong symbolic
  metrics, verify the current seed and ordered migrations before planning:
  `grep -n "trigger_metric" database/seed-blank.sql` and
  `ls database/migrations/ordered/`. Route any CHECK change through
  **osi-schema-change-control**; this skill only explains what the metrics mean.

**Depth columns:** `devices.chameleon_swt1_depth_cm`, `chameleon_swt2_depth_cm`,
`chameleon_swt3_depth_cm` record the physical burial depth of each Chameleon
sensor channel (`database/seed-blank.sql`). Per-device calibration
coefficient columns (`chameleon_swt[123]_[abc]`) were **removed** in the
2026-05-19 migration in favor of the global `chameleon_calibrations` table
(see below) — depth stayed device-local because it's installation geometry,
not a sensor calibration constant.

### pF (soil water tension, logarithmic)

pF is the base-10 logarithm of tension expressed in hPa (1 kPa = 10 hPa); it
compresses the wide dynamic range of soil suction into a small number
range (roughly 0-4.5) more familiar to some agronomists.

Canonical SWT channels store positive kPa magnitudes. Native Tensiomark pF is also retained as exact source tokens in observation provenance on the edge and cloud; it does not replace canonical kPa or add a duplicate display channel.

The shared mathematical contract is [matric-potential/v1.md](../../../../docs/contracts/matric-potential/v1.md): `pF = log10(abs(kPa)) + 1`, inverse magnitude `10 ** (pF - 1)`. Zero and non-finite inputs have no finite pF. Negative pF is valid mathematically; each sensor adapter applies its own range and sentinel rules before conversion. The former zero floor and four-decimal CSV rule are legacy behavior.

Keep calculated doubles and raw CSV values without decimal rounding. Format display strings only. The contract vectors cover edge JavaScript, GUI TypeScript and server Java. Native tokens preserve source signs and trailing zeros; transport tests require identical IEEE754 bits for the calculated value.

**CSV pairing:** each SWT kPa row with a valid pF conversion gets a paired `_pf` row with unit `pF`. Aggregate canonical kPa first, then convert; never average pF for a kPa-based scheduler.

**What did NOT ship:** an earlier spec draft considered adding
`threshold_unit` + `threshold_pf` authoring columns to `irrigation_schedules`
so operators could author thresholds in pF. That was descoped — PR #98 is
"zero-schema": that change added no pF measurement columns, and the scheduler **always**
compares in kPa regardless of the operator's display preference (comparing
in pF would silently change trigger behavior, since a mean of pF values is a
geometric-mean-like quantity in kPa space — Jensen's inequality). If you see
a document proposing `threshold_pf`, treat it as an unimplemented proposal,
not current behavior.

## Chameleon sensor stack

**What it is:** the VIA Chameleon module is a 3-channel resistance-based soil
water sensor array, read over I2C by a Dragino LSN50 running OSI custom
firmware (`feature/chameleon-i2c-reader`, standalone repo, not part of
osi-os). The LSN50 uplink (FPort 2, LSN50 MOD=2 "3ADC+IIC" frame) carries a
Chameleon extension: per-channel temperature-compensated and raw resistances,
a status byte, soil temperature, and (V1 payload) an 8-byte array ID. Two
payload versions exist and are both decoded —
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js`,
functions `decodeChameleonV1`/`decodeChameleonV2` (dispatched by
`isChameleonV1Frame`/`isChameleonV2Frame` on byte 8 of the payload).

**Status flags exposed by the decoder** (verified field names):
V1: `Chameleon_I2C_Missing`, `Chameleon_Timeout`, `Chameleon_Temp_Fault`,
`Chameleon_ID_Fault`, `Chameleon_CH1_Open`/`CH2_Open`/`CH3_Open`. V2 collapses
the first two into `Chameleon_Data_Invalid`, plus `Chameleon_Temp_Fault`,
`Chameleon_ID_Fault`, and the same per-channel `_Open` flags (derived from an
open-circuit resistance sentinel of 10,000,000 Ω rather than a status bit).
`i2c_missing`/`timeout`/`data_invalid` downstream in `chameleon_readings` and
the calibration helper trace back to these flags.

**Calibration model — global table, verified formula:**
`chameleon_calibrations` is keyed by `array_id` (uppercase 16-char hex,
normalized by `normalizeArrayId`), with per-sensor coefficients `a`, `b`, `c`
for each of the 3 channels. The conversion, verified in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`,
function `resistanceOhmsToKpa`:

```
resistance_kΩ = resistance_Ω / 1000
kPa = a * ln(resistance_kΩ) + b * resistance_kΩ + c
```

...clamped to `[0, 300]` kPa and rounded to 2 decimals; resistances `<= 0` or
`>= 10,000,000 Ω` (open circuit) are rejected as `null` before the formula
runs. `calibration_status` is `'calibrated'` (a matching `chameleon_calibrations`
row exists), `'pending'` (Chameleon enabled, no calibration row yet), or
implicitly `'unknown'` when the array ID itself can't be read.
`chameleon_calibration_misses` is a 24-hour negative cache keyed by
`array_id` so the sync worker doesn't hammer the cloud for IDs it just
learned are missing. The Node-RED sync worker polls
`/api/v1/sync/chameleon/calibrations/lookup` every 30 s (same cadence as
pending-commands) for any outstanding misses, persists new rows locally, and
backfills previously-pending `device_data.swt_*` values.

**Raw vs canonical:** `chameleon_readings` is the raw/diagnostic mirror (raw +
compensated resistances, status flags, array ID, calibration_status) —
useful for protocol debugging. `device_data.swt_1/swt_2/swt_3` are the
canonical application values that scheduler, GUI, and cloud sync all read.
If you repair history from `chameleon_readings` + `chameleon_calibrations`,
you must also update `device_data`. The live `INSERT`-only sync trigger does
not fire on that `UPDATE`, but it is still carried: `trg_sync_device_data_dirty_au`
marks the row in `sync_history_dirty_keys`, which the history correction
phase picks up. Do not enqueue explicit `DEVICE_DATA_APPENDED` events for
the repair — every such event has `sync_version` 0, and the cloud rejects a
changed payload at an equal version as `equal_version_payload_conflict`.
Update by row `id`: `device_data` has no UNIQUE(deveui, recorded_at)
(AGENTS.md, "SWT history repairs").

**A `DRAGINO_LSN50` may be a WATERMARK node, not a Chameleon board.** FPort 11
+ profile 3 uplinks decode to soil-tension resistance readings stored in
`watermark_readings` and surfaced as `latest_data.watermark`; the two firmware
variants are mutually exclusive on one board. Before troubleshooting SWT on a
`DRAGINO_LSN50` as a Chameleon I2C fault, check whether the device is a
WATERMARK node instead.

**Wiring rule (one line; the field incident summary lives elsewhere):** power the VIA
Chameleon I2C reader from the LSN50's own `VDD` rail (3.3-3.6 V) when SDA/SCL
are wired directly to the LSN50 STM32 I2C pins. Do not power it from switched
5 V without a proper bidirectional I2C level shifter plus power isolation —
the reader's pull-ups follow VCC and a switched-off 5 V rail can back-power
the board through SDA/SCL. Field incident summary:
`docs/hardware/chameleon-reference.md` (section "Field incident: reader powered from a different rail than the bus"); for
troubleshooting a live `i2c_missing` symptom, use **osi-debugging-playbook**
instead of re-deriving this here.
