# Piece 4 — Sensor Processing (Baseline Dendro / Watermeter / Valve / Rain)

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

## 1. What it is / how it works

Scope: the per-sensor cleaning/derivation stage between raw ingestion and daily parameters —
`_load_sensor_timeseries` / `_process_single_sensor` (`main.py:1231-1277,1583-1618`) and the
per-sensor-type algorithms in `sensors_processing.py`.

**Load & trim.** `_load_sensor_timeseries` (`main.py:1231-1277`) builds a DataFrame from the raw
table (falling back to processed) as a naive-local, ascending `DatetimeIndex` with a single
`value` column. `_process_single_sensor` (`main.py:1583-1618`) trims to `index < today 03:00 local`
(`ANALYSIS_CUT_OFF_HOUR = 3`), runs `Baseline(...).run()`, and persists the 15-min series plus
daily params. Algorithm exceptions are swallowed and the function returns `0`
(`main.py:1641-1649`) — a failure and an empty-but-valid run are indistinguishable to the caller.

**Dendro cleaning pipeline** (`sensors_processing.py`, function `dendro_processing`):

- Numeric coerce, drop exact-zero rows (76-79).
- Unit normalization: `'agriscope' in mqtt_topic` divides the whole series by 1000 (mV→V);
  Dragino sensors are kept in V (82-86).
- Polarity read from `sensor.polarity == 'inverted'` (88-91).
- Manual jump removal: for each date in `dendro_jumps_dates`, subtract the step
  `value[i] - value[i-1]` from row `i` onward (95-108).
- Per-day state machine over a **dense** day range (`pd.date_range(min, max, freq='D')`, line 114).
  Each "day" is a window shifted by `dawn_time_limit = 3h`
  (`(index - 3h).normalize()`, line 133). No data for a day → skip it entirely (138).
  - **Quiet day** (`max - min < 0.25V`, 141) + `check_hourly_coverage` passes → set `first_max` if
    unset, append to a rolling `last_3_days_data`, keep the rows.
  - Otherwise → blank the day to `NaN`.
  - **Jump day** (`max - min >= 0.25V`, 161) + coverage passes → baseline mean/std comes from the
    last three **quiet** days (or, if fewer than 3 quiet days seen so far, the current day's own
    10th–90th percentile); values outside `mean ± 3σ` (floored at 0) are clipped to `NaN`;
    `first_max` is set. Otherwise → blank to `NaN`.
  - Jump days never feed the rolling baseline — it is appended to only at 145-148, on quiet days.
  - `check_hourly_coverage` (121-127): after the 3h shift, requires a sample in shifted-hours
    `{15, 16, 17}` **and** `{22, 23}` — i.e. real-clock ~18:00-20:00 and ~01:00-02:00.
- Normalize + convert to units (199-205): `first_max = voltage_reference - first_max_raw`
  (unconditional), then non-inverted `value = value - first_max`, inverted
  `value = voltage_reference - value - first_max`; converted to µm via
  `* sensor_length * 1000 / voltage_reference`.
- Resample to 15-min mean → reindex onto a dense 15-min grid → `interpolate(linear, limit=5)`
  both directions (207-213).
- Daily params (216-243): `min`; `max_eod` = max over 22:00-23:59; a coverage gate nulls
  min/max on low-coverage days (224); `growth_um = max_eod.diff()` (226);
  `MDS = max_eod - min` (227); `tree_max_historical_size_um = max_eod.cummax()` (239);
  `tree_stress_um = max_eod - historical_max.shift(1)` (243). Strict 6-column output schema
  (232-250).
- `full_history=False` returns the last 2 days of the 15-min series but only the single
  `day[-2]` daily row (255-257) — a one-run-lag finalization.

**Other sensor types** (all in `sensors_processing.py`, all exclude the last day):

- **Watermeter** (260-357): resample → interpolate(`limit=5`) → diff (overnight 02:00-06:00 window
  for `'shared'` meters, else the full day) → divide by `area.surface` → daily-sum into
  `irrigation_mm` and `irrigation_time_minutes_wm`.
- **Valve** (360-439): binary `resample.nearest()` → diff → nonzero transitions → per-day open
  span + `irrigation_count = count / 2`.
- **Rain** (442-503): resample → `interpolate` with **no limit** → diff / 5 (0.2 mm/pulse) →
  daily-sum `precipitation_mm`.

## 2. Strengths

- **Clean pluggability.** `ALGORITHM_REGISTRY` + `select_algorithm`, with a commented-out
  `BaselineV2` override point (`sensors_processing.py:525-559`) — swapping the dendro algorithm is
  a registry entry, not a rewrite.
- **Strict explicit output schema**, enforced even on the empty-input path (62-72) — callers never
  see a ragged frame.
- **Multi-stage defensive cleaning** — zero-drop, unit fix, polarity fix, manual jump correction,
  then the quiet/jump state machine.
- **Deliberately gap-safe daily math.** Densify-then-diff refuses to invent growth/stress across a
  data gap — it emits `NaN` instead of silently bridging two non-adjacent days.
- **Idempotent persistence.** Delete+insert per timestamp for the 15-min series; daily rows dedup
  on `MAX(id)` per `(date, user, area, dendro_sensor)`.

## 3. Weaknesses & risks (ranked)

1. **Non-inverted normalization offset bug** (`sensors_processing.py:199-203`). Line 199
   unconditionally sets `first_max = voltage_reference - first_max_raw`, so the non-inverted
   branch (203) computes `value - voltage_reference + first_max_raw`, not the documented
   `value - first_max_raw`. The offset **cancels** in difference-based columns (MDS, growth,
   stress) but is **retained** in absolute-size columns (`tree_min/max_daily_value_um`,
   `tree_max_historical_size_um`) — absolute trunk size is not comparable between inverted and
   non-inverted sensors. Reads as line 199 written for the inverted case and applied to both
   unconditionally.
2. **`first_max` None/NaN traps** (`sensors_processing.py:143,153,180,184`; `main.py:1641`).
   `first_max` can stay `None`; `voltage_reference - None` raises `TypeError`, which is swallowed
   by `main.py:1641-1649` and silently persists 0 rows. Separately, the guards use `== None`
   rather than `is None`, so they do not re-arm on `NaN` — an empty `between_time('01:00','03:00')`
   `.max()` freezes `first_max = NaN` and poisons the entire downstream history. Coverage checks
   usually guarantee a night sample, which narrows the window, but the trap is real and latent.
3. **Manual-jump row-0 wraparound** (95-108). If the nearest matched index is row 0,
   `iloc[sel_index - 1]` resolves to `iloc[-1]` (the last sample in the series), applying a
   garbage step to the whole series. Caught per-jump (logged), so it corrupts rather than crashes.
4. **Stale/bootstrapped thresholds on sparse data.** The 0.25V jump gate and the `mean ± 3σ` band
   both depend on `last_3_days_data`, populated only from quiet days — during a long jumpy
   stretch the baseline goes stale. With fewer than 3 quiet days ever seen, the first jump day
   bootstraps its outlier detector from its own 10th-90th percentile (outlier detection derived
   from outliers). Coverage hours and the `f'0{dawn_time_limit}:00'` format string are hardcoded
   and assume a single-digit hour.
5. **Inconsistent interpolation limits.** Dendro/watermeter cap interpolation at `limit=5`
   (≤75 min bridged); rain interpolates with **no limit** (483), so it can smear across arbitrary
   gaps before the diff — an inconsistency between sibling algorithms in the same file.
6. **`full_history=False` persistence gaps** (255-257, `main.py:1532-1533`). A single-day sensor
   raises `IndexError` on `index[-2]`, swallowed, so it is never persisted. Separately, non-dendro
   daily params only `UPDATE` existing rows; if no dendro row exists yet for
   `(date, user, area)`, the watermeter/valve/rain data for that day is silently dropped
   (`continue`). Because the scheduler processes sensors in raw id order, any watermeter/valve/rain
   sensor with a lower id than its field's dendro sensor loses its daily params on any day that
   lacks a pre-existing dendro row (e.g. the first run) — an ordering/coupling fragility.
7. **Gap cost on the first post-gap day.** `diff`/`cummax`/`shift` across a densified gap are safe
   (they correctly emit `NaN`, not fabricated adjacency; `cummax` continues across gaps via
   `skipna`), but each gap still costs the first post-gap day's `growth` **and** `stress` (`NaN` via
   the cummax-on-gap-row plus `shift`), even when a valid historical max exists two rows back.
8. **DST mis-bucketing.** The naive-local index, `(index - 3h).normalize()`, `between_time`, and
   `resample('15min')` all interact on 23h/25h DST days to mis-bucket by an hour and
   double/half-count samples.
9. **Reprocesses all history every run** (`TODO`, line 37) — O(days²): a per-day full-index scan
   plus an in-loop `pd.concat` (150/158/186/190).
10. **Design/maintainability.** One ~130-line stateful, order-dependent method with no seams —
    hard to unit test. Magic numbers throughout (`0.25`, `3σ`, `limit=5`, coverage hours,
    `dawn_time_limit=3`). Failure modes are indistinguishable from the outside: exceptions,
    `None`-crash, and `NaN`-poison all yield the same blank output with no distinct signal.
    Watermeter/rain `diff` goes negative on a yearly counter reset, guarded only by a comment
    (345). Dead code: `else: processed_data = processed_data` (86); the scheduler hardcodes
    `full_history=False`, so `if full_history:` (255) is dead.

## 4. Integration challenges (OSI OS / OSI Server)

- **[P4] This is the direct counterpart to OSI v6's own dendro extraction — the crux of the
  parallel comparison.** Agroscope's control signal is a signed
  `tree_stress = max_eod - GLOBAL cummax.shift(1)` (deficit from an ever-increasing historical
  maximum). OSI v6 deliberately abandoned the global `cummax` in favor of a stepwise **envelope**
  and `TWD_rel`. The two systems compute a fundamentally different deficit reference from the same
  raw trunk data. For a faithful 1:1 port and an apples-to-apples comparison, OSI must implement
  Agroscope's `tree_stress` as a **separate extraction path** — do not reuse v6's envelope
  extraction — from the same raw dendro readings.
- **[P4] #1 fidelity risk of the whole port: reproduce the densify-then-diff/cummax/shift
  semantics exactly** (resample to 15-min + `interpolate(limit=5)` + dense-grid diff). A JVM/Node
  port that aggregates only days-with-data, rather than a fully densified dense day grid, will
  silently diverge on growth/stress the first time there is a data gap.
- **[P4] Bugs to fix vs. bugs that are moot on OSI's model.** Fix on port: the non-inverted
  normalization offset (Section 3, item 1), the `first_max` None/NaN traps (item 2). Moot on OSI:
  DST bucketing (item 8) and the non-dendro piggyback ordering (item 6) — OSI stores UTC and uses a
  separate per-sensor data model with no piggyback coupling. The normalization and densify
  semantics, however, must be reproduced correctly regardless of platform.
- **[P4] Day-boundary decision.** Agroscope uses a 03:00-shifted **local** day. OSI must pick a
  consistent zone-local day boundary — v6 already handles per-zone timezones; reuse that rather
  than inventing a second timezone convention.
- **[P4] OSI is better positioned on several fronts:** UTC storage sidesteps the DST bug if
  conversion happens at the processing boundary; a separate per-sensor data model avoids the
  non-dendro piggyback; edge-side extraction avoids an extra network hop for raw 15-min series.

## 5. OSI v6 improvement ideas

- **[P4] Consider trunk growth as a first-class daily signal.** Agroscope tracks day-to-day trunk
  growth explicitly, consistent with its RDI rationale of "grow toward potential." v6 does not use
  growth as a control input today — worth evaluating whether it should.
- **[P4] Confirm v6 never treats gap-separated days as adjacent.** v6's envelope anchor-eligibility
  logic largely already covers this, but verify no day-to-day computation in v6 silently bridges a
  gap the way a naive (non-densified) port of Agroscope's logic would.
- **[P4] Coverage-gate validation, not a change.** Agroscope's per-day coverage gate (samples
  required in specific hour buckets) parallels v6's confidence gating. v6's solar-window plus
  sample-floor approach is arguably more principled — treat this as validation that v6 is already
  on the right track, not a prompt to change it.

## 6. Re-implementation complexity

**Rating: Dendro — HIGH. Watermeter/valve/rain — LOW-MEDIUM.**

Dendro is high-complexity because of the stateful, order-dependent cleaning state machine
combined with densify-then-diff/cummax/shift semantics that are easy to get subtly wrong outside
pandas. Watermeter/valve/rain are low-medium: the shared overnight window, counter-reset
negatives, and last-day exclusion are the only real traps.

**Portable "just math":** MDS, growth, `cummax`, and stress reduce to elementary running-max and
adjacent-difference operations — trivial on any stack.

**Pandas-idiom-dependent and load-bearing — must be preserved exactly:**

- The shifted-day bucketing, `(index - 3h).normalize()` + `between_time`.
- The densify step (`resample('15min').mean()` + reindex onto a dense grid +
  `interpolate(limit=5)`). This is load-bearing: it is what makes `diff`/`shift`/`cummax` behave as
  true adjacent-day operations that correctly emit `NaN` across gaps. A naive port that groups
  "days that have data" will compute growth/stress across gaps as if the days were adjacent — a
  different, wrong result.
- The stateful cleaning state machine ports directly but must preserve exact branch order and the
  rule that jump days never feed the rolling baseline.

**Input contract:** a single numeric `value` column on a naive-local ascending `DatetimeIndex`,
trimmed to `< today 03:00 local`, plus sensor scalars `polarity`, `voltage_reference`,
`sensor_length` (mm), `mqtt_topic` (unit selector), and `dendro_jumps_dates` (CSV).

**Output contract:** a daily-indexed frame with columns `tree_growth_um`,
`tree_min_daily_value_um`, `tree_max_daily_value_um`, `tree_mds_um`,
`tree_max_historical_size_um`, `tree_stress_um` (shifted-day index), plus the 15-min processed
value series.

**Recommended fixes to make before or during the port:** resolve the non-inverted normalization
offset (199-203); switch to `is None` plus an explicit empty-`between_time` → `NaN` guard; guard
`iloc[sel_index - 1]` at row 0; make a `first_max`-`None` outcome a distinct, handled state rather
than a swallowed `TypeError`; process dendro sensors before their field's non-dendro sensors (or
switch to `INSERT` rather than `UPDATE`-only); remove the in-loop `concat` and per-day full-index
scans to eliminate the O(days²) cost.
