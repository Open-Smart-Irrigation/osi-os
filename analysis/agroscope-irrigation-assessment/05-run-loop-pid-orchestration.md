# Piece 5 — Area Run-Loop & Sector Aggregation

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

## 1. What it is / how it works

Scope: `_run_dendro_pid_for_area` — the per-sector daily run-loop that aggregates dendrometer
signal into a sector process variable and drives the PID's propose/close lifecycle day by day.
Files: `main.py` (run-loop + valve send), `actuators.py` (PID persistence), `models.py` (schema).

**Sector aggregation.** SQL over daily `tree_stress_um` (`main.py:174-203`): sample standard
deviation (n-1) via a one-pass sum-of-squares identity (`:185-187`), guarded for `n>1` else `0`
(`:181,:191`), floored with `MAX(...,0)` before `sqrt` (`:183-189`). NULL-safe by construction:
`AVG`/`COUNT` ignore `NULL`, `WHERE tree_stress_um IS NOT NULL` plus `GROUP BY date` means a
day-group exists only when at least one sample is present. An all-null or empty sector produces no
rows and hits an early return (`:205-212`) — `n=0` cannot reach the PID.

**Process variable** (`main.py:266-269`): `upper95 = mean + 1.96*max(sd,0)/sqrt(n)` for `n>1`,
else the raw mean.

**Per-day loop** over `run_rows` (`main.py:260-342`): if a pending cycle exists for a *different*
date, close it via `update_with_next_day_observation` (`:272-291`); then run the rain-check and
propose for the current day (`:295-322`). The integral advances **only** on close
(`actuators.py:329-330`), never on propose.

**Rain-skip** (`main.py:295-315`): the prior-day close runs *before* the rain check, so a skip
never orphans a previous pending row. On skip, the pending cycle is built directly with
`irrigation_mm=0.0`, `error_before=error_today` (`:299-303`), and `save_values()` upserts a pending
row (`:304`); the integral is untouched — correct, since the integral only advances when the *next*
day closes this one.

**Trigger modes.** Auto (`main.py:214`) processes only the latest day, `all_rows[-1]`, with a
warm-restart via `load_previous_values` (`:254-255`). Manual/replay processes *all* days and first
deletes every prior PID row for the sector (`:228-239`), rebuilding the integral from zero.

**Actuation — compute-only.** `irrigation_mm > 0` only logs and hits a stub
(`main.py:324-326`: `logger.info('PID: Applying an irrigation')` + `# TODO: Implement comunication
with the valve here`). No dripper-capacity/area-surface/duration conversion and no actuator call
exist in `_run_dendro_pid_for_area`; `area.surface` is used only for *input* normalization
(`sensors_processing.py:316`), and `irrigation_time_minutes_valve` is written only from user CSV
import (`main.py:1446-1447`), never from the PID. The persisted dose `water_applied_mm` is read
back only by `load_previous_values` (`actuators.py:280`) to restore control state, not to actuate.
The one real valve path, `_send_uc51x_valve_command` (`main.py:667-770`), is invoked only by the
UI's `set_valve_status` command (`:1203-1204`) — never the PID loop — and inside it the actual
publish is commented out (`:753`), as are the rc-error check (`:756-763`) and the sequence-count
persist (`:770`); it builds the payload, logs it, sets a pending-command marker (`:765`), and
transmits nothing.

## 2. Strengths

- **Clean close/propose separation.** The integral advances exclusively on observation-close
  (`actuators.py:325-340`), never on propose — a disciplined phase split.
- **Per-area fault isolation.** Each area is wrapped in try/except so one sector's failure is
  logged and skipped without aborting the rest; a run summary is emitted (`main.py:374-396`).
- **Idempotent daily row.** UPSERT on the natural key plus `UniqueConstraint(user, sector, date)`
  (`models.py:167-169`) prevents duplicate daily PID rows.
- **Manual replay is a clean wipe-and-rebuild.** Deterministic by construction.
- **Schema-defensive persistence.** `PRAGMA table_info` gates writes to existing columns only
  (`actuators.py:113-154`).
- **Rain-skip correctly integrated.** Parks a pending row without touching the integral, with no
  orphaned state (Section 1).

## 3. Weaknesses & risks (ranked)

1. **Actuation is a stub — closed-loop control with a severed output** (highest risk). Confirmed at
   three layers: the run-loop TODO (`main.py:324-326`), the dose being read back only for control
   state, not actuation (`actuators.py:280`), and the one real valve path's publish being commented
   out (`main.py:753`, plus `:756-763`, `:770`). The entire actuation stack is a dry run — this is a
   compute-and-persist controller, not a closed loop in production.
2. **Gap bridging: non-adjacent days closed as adjacent, unscaled integral step.** The close guard
   is only `pending_day != current_day` (`main.py:277`), with no adjacency/calendar-delta check. If
   `run_rows` has a gap, day N's pending cycle is closed against day N+3 as if adjacent, and
   `ki*error` (`actuators.py:330`) is applied once, unscaled for the elapsed days. Affects both
   automatic and manual replay.
3. **Single daily tick, no catch-up.** Actuation fires only when `now_local.hour ==
   ANALYSIS_CUT_OFF_HOUR` in the hourly pipeline (`main.py:1938-1943`), and auto mode processes only
   `all_rows[-1]` (`:214`). If the process is down at that hour, that day's proposal is silently
   lost.
4. **Silent persistence failure.** `save_values`/`_close`/`_upsert` swallow all exceptions and
   return `False` (`actuators.py:171-172,232-233,291-292`); the in-memory integral can advance while
   the DB row fails to write, producing warm-restart drift with no signal.
5. **Mixed DB access.** Raw `sqlite3` (`main.py:223-224`) for PID upserts vs. a SQLAlchemy session
   for manual reset (`:230-239`) against the same SQLite file — a writer-contention/locking
   exposure.
6. **SEM-as-signal (software consequence of the formula, not a bug).** `upper95` is the upper bound
   of a normal-approximation 95% CI on the *mean* across trees (standard error of the mean). It
   shrinks toward the plain mean as tree count `n` grows (`/sqrt(n)`) — more dendrometers yields a
   *less* conservative signal. `z=1.96` is fixed regardless of `n` (should be Student-t; understated
   at `n=2-4`). At `n=1`, `ci_half=0`, so a single tree fully drives the sector — a discontinuity at
   the aggregation boundary. (A GUI comment at `:265` says this intentionally mirrors the dashboard's
   interval math.) Minor, related: `AVG(COALESCE(total_water_input,0))` (`:193`) averages water
   input across the day's per-dendrometer rows — correct only if `total_water_input` is an
   area-level value replicated per row.
7. **Replay non-determinism vs. live, on forecast mutation.** Manual replay recomputes the
   rain-skip from *current* `environmental_data` forecast rows (`main.py:295`, `:146-163`); if those
   rows were later replaced by measured data, replay diverges from what the automatic run decided
   live. Automatic-incremental and manual-replay are not guaranteed to converge.
8. **Observability.** `logger.info` only — no metric or state export of integral, error, or dose.

Note on idempotency: same-day *automatic* re-runs are, by contrast, correctly idempotent — load
restores today's pending row (`date == today`), so the close guard is false (no re-close, no
double-step), and propose re-UPSERTs the same row (`ON CONFLICT DO UPDATE`,
`actuators.py:157-165`), an overwrite rather than a double-apply.

## 4. Integration challenges (OSI)

- **[P5] Compute-only reframes the whole port strategy favorably.** Agroscope's controller never
  actuates (Section 3, item 1). "Port Agroscope's logic" therefore means porting the *decision*
  pipeline — sector stress aggregation to PID dose in mm — which naturally runs as a **shadow
  controller** alongside v6: compute both Agroscope's dose and v6's recommendation side by side,
  compare, actuate neither. This is exactly what Agroscope itself does, and it is the lowest-risk
  first phase.
- **[P5] OSI is ahead of Agroscope on actuation.** OSI's STREGA edge integration already works
  (`OPEN_FOR_DURATION`); Agroscope's equivalent is a commented-out stub. If OSI later wants the
  ported controller to actually irrigate, OSI must **author** the mm-to-duration conversion
  (dripper flow rate x emitter geometry x area -> open-duration) — this does not exist to copy.
  OSI's Areas/zone model already carries dripper capacity and spacing geometry, and the working
  STREGA path can be reused for transmission. This is a real design task, not a port.
- **[P5] Aggregation divergence to decide explicitly.** Agroscope uses SEM-of-the-mean (shrinks
  with `n`, understated at small `n`, degenerates at `n=1`). OSI v6 uses a MAD-filtered 75th
  percentile of the tree population — a population-spread statistic, not a CI-on-the-mean, and
  arguably more sensible/robust. Decide: reproduce SEM faithfully for parity with Agroscope, or use
  v6's sounder population statistic for the port. This is a place v6's existing aggregation may
  already be better than what is being ported.
- **[P5] Correctness fixes to bake in.** Adjacency/calendar-delta handling in the close step (scale
  or skip integration across missing days) — fixes the gap-bridging bug (Section 3, item 2). Treat
  rain input as a decision-time snapshot, not a live re-query of mutable forecast rows, so replay
  matches live — ties to the Piece 3 weather-drain fix.
- **[P5] Mapping.** Sector maps to an OSI zone; `daily_sensor_parameters` maps to OSI
  `dendro_daily`; `environmental_data` forecast rain maps to OSI weather (Piece 3 contract); a new
  per-zone/date PID-state table is needed. Trigger is a new OSI scheduled job per the Piece 1
  placement decision.

## 5. OSI v6 improvement ideas

- **[P5] v6's population-percentile aggregation is validated, not just different.** MAD + 75th
  percentile is more robust than Agroscope's SEM-of-the-mean for a sector-level statistic. That
  said, v6 could still borrow Agroscope's habit of carrying an explicit sector-level
  uncertainty/confidence figure into the decision, rather than a point statistic alone.
- **[P5] Adopt the close-then-propose two-phase lifecycle if v6 ever gains controller state.** The
  close-then-propose sequencing plus rain-skip-parks-without-update is a clean state-machine
  pattern; worth adopting if v6 gains feedback/controller state (ties to the Piece 6 headline
  finding that v6 is open-loop).
- **[P5] Per-area fault isolation + run-summary logging is a good scheduler pattern for v6 too,**
  independent of whether the PID itself is ported.

## 6. Re-implementation complexity

**Rating: MEDIUM.**

The orchestration itself — aggregate -> close -> propose -> persist — is small and mechanical, and
ports directly. Two parts are genuinely hard:

1. **The output stage does not exist and must be authored.** The mm-to-duration conversion
   (dripper flow rate x emitter/area geometry -> open-duration -> `set_timecontrolvalvestatus` /
   UC51X `time_sec`) has no source to copy from — it is a `# TODO` (`main.py:326`) and a
   commented-out publish (`:753`). The confirm/pending-transition safety logic already built for the
   UI valve path (`:701-731`) should be reused for the new PID-originated actuation path, and the
   publish call must be un-commented and wired.
2. **Correct gap/calendar handling in the close step**, plus reconciling automatic-incremental vs.
   manual-replay determinism (Section 3, items 2 and 7).

Everything else — the aggregation SQL, the per-day loop, the rain-skip, the UPSERT lifecycle — is
schema-agnostic and reproduces faithfully with a straightforward rebind onto OSI's zone/date model.
