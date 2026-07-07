# Agroscope Irrigation Logic — Integration Assessment

## Purpose & goals

Agroscope (a Swiss federal agricultural research institute) built a Python dendrometer-driven
irrigation controller, `dendro_irrigation`. OSI plans to:

1. **Port Agroscope's logic 1:1** into OSI's own stack (OSI OS = edge firmware on Raspberry Pi,
   Node-RED + SQLite; OSI Server = cloud, Java/Spring + Postgres).
2. **Run the port in parallel** with OSI's existing "v6" dendrometer logic, against the same
   sensor data, without letting the two controllers fight over actuation.
3. **Compare outcomes** between the two approaches under real field conditions.

This assessment supports three goals:

- **Integration challenges** — what it takes to port Agroscope's logic into OSI's edge/cloud split.
- **Strengths/weaknesses** — an honest technical read of the Agroscope implementation.
- **v6 improvement ideas** — what OSI's current cloud-side logic should borrow or fix, informed by
  studying a second, independently-built system.

This is a multi-part, piece-by-piece analysis. This file and `01-scheduler-orchestration.md` are
the first two pieces.

## The Agroscope algorithm in one page

Agroscope's controller is a **closed-loop daily PID controller** (default configuration is
effectively PI: `Kp=0.5`, `Ki=0.1`, `Kd=0`) that computes an actual water **dose in mm** per
sector and self-corrects from the tree's measured response the following day. This contrasts with
OSI v6, which classifies stress into discrete levels and applies percentage-based adjustment rules
(open-loop, reactive).

**Signal.** Per tree, per day, the pipeline extracts: daily min, end-of-day max (22:00–23:59),
maximum daily shrinkage (MDS), growth, a running historical max (`cummax`), and
`tree_stress_um = today's max - yesterday's historical max` — a signed overnight deficit (negative
means the tree closed below its historical peak). The design deliberately measures the
overnight/rehydrated deficit, not midday shrinkage.

**Control law.**
- Setpoint: `tree_daily_limit = -100 um` — a deliberate mild deficit target. Regulated-deficit
  irrigation (RDI) is baked directly into the setpoint, not layered on afterward.
- Process variable: the sector's upper-95% confidence interval of `tree_stress_um` across its
  dendrometers.
- Error: `setpoint - observed`.
- Output: `mm = clamp(Kp*e + integral + Kd*delta_e - water_input_mm, 0, max=10 mm/day)`.
- Feed-forward: measured rain/irrigation is subtracted from the output; the controller skips and
  freezes entirely if forecast rain exceeds 2 mm.
- Anti-windup: the integral term accumulates only when the output is unsaturated.
- Closed loop: propose today's dose → apply via valve → observe next-day growth margin →
  update integral and last-error → persist controller state (supports warm restart).

**Actuation.** STREGA LoRaWAN valve (also supports a Milesight UC51X class of valve controllers).

## How this differs from OSI v6

| Aspect | Agroscope | OSI v6 |
|---|---|---|
| Paradigm | Closed-loop PID computing a dose (mm) | Classify stress level → apply percentage rule |
| Feedback | Next-day growth margin corrects the controller | No feedback loop |
| Deficit strategy | RDI is the setpoint itself (`-100 um`) | Deficit handling deferred to rule tuning |
| Deficit reference | Global historical `cummax`, signed, overnight window | Stepwise envelope, `TWD_rel` |
| Rain handling | Feed-forward subtraction + forecast-based skip | Suppression window |
| Aggregation | Upper-95% CI across sector's dendrometers | MAD-filtered 75th percentile |
| Calibration | Global environment gains + fixed setpoint | Per-crop DB thresholds |
| Placement | Single central process (ingest→process→actuate) | Edge-canonical `dendro_daily` + cloud analytics |

## Assessment structure / piece index

- `01-scheduler-orchestration.md` — Entry point & scheduler (**done**)
- `02-measurement-ingestion.md` — MQTT + REST ingestion (**done**)
- `03-weather-pipeline.md` — MeteoSwiss OGD, VPD, rain/forecast (**done**)
- `04-sensor-processing.md` — Baseline dendro/watermeter/valve/rain processing (**done**)
- `05-run-loop-pid-orchestration.md` — Area run-loop & sector aggregation (**done**)
- `06-pid-controller.md` — PID control law, persistence, anti-windup (**done**)
- `07-actuation.md` — STREGA / Milesight valve control (**done**)
- `08-synthesis.md` — Integration challenges, strengths/weaknesses, v6 improvements (**done**)

## Running cross-cutting registers

The synthesis (`08-synthesis.md`) consolidates and prioritizes these registers into an
integration plan and a v6 roadmap.

These four lists accumulate findings across all pieces. Each entry is tagged with the piece that
contributed it (`[P1]` = piece 1, scheduler/orchestration).

### Integration challenges (into OSI)

- **[P1] Placement decision.** Agroscope is a single central process (ingest → process → actuate
  in one tick, SQLite as the de facto mutex). OSI splits this across edge (Node-RED/SQLite,
  canonical for `dendro_daily`, actuates STREGA) and cloud (osi-server/Spring/Postgres, v6
  analytics). A closed-loop PID that actuates and needs next-day feedback maps most naturally to
  the **edge** (consistent with OSI's existing `agroscope-dendrometer-controller.md` draft, which
  already posited an edge-authoritative dendrometer controller). But v6 runs cloud-side, and a
  side-by-side comparison is a goal. Decision to make: run the Agroscope port where it can actuate
  (edge) and mirror decisions to cloud for comparison against v6, or run both cloud-side in shadow
  mode (no actuation) first.
- **[P1] Scheduler semantics differ.** osi-server uses Spring `@Scheduled` cron; osi-os uses
  Node-RED inject/cron nodes. Neither reproduces APScheduler's drop-no-catch-up behavior, and that
  is a good thing — do not copy Agroscope's fragile after-ingestion hour-gate. Key the daily run
  off a persisted last-run date plus a data-freshness gate instead. (Also a v6 improvement — see
  below.)
- **[P1] Multi-timezone.** Agroscope hardcodes 03:00 CET. OSI spans Uganda (equatorial) and
  Switzerland, so the cutoff must generalize per zone. OSI is already better positioned here: v6
  already handles per-zone timezones. This is a mild challenge and an area where OSI's design is
  already superior.
- **[P1] In-process coordination must be re-expressed on OSI's durable infra, not ported
  line-by-line.** Agroscope's `control_queue` / pending-valve lock / valve sequence counter are
  in-memory and crash-lossy. OSI already has durable pending-commands REST polling, a sync
  outbox/inbox, and command leasing. Map the Agroscope coordination model onto those primitives —
  a real mapping effort, not a copy, but the target is a safer host.
- **[P1] Data model.** Agroscope's `DailySensorParameters` and `DendroPIDStates` (keyed by
  user/sector/date) map to OSI's per-zone/date model. Additive new PID-state tables are needed on
  whichever side hosts the controller.
- **[P2] This piece largely does not port.** OSI OS edge already ingests LoRaWAN uplinks natively
  (ChirpStack/MQTT) and is the system of record — no pull window, no token, no overlap math is
  needed on the edge; ingestion reuses OSI's existing dendro ingestion unchanged. See
  `02-measurement-ingestion.md`.
- **[P2] Raw sub-daily data availability if run cloud-side.** Agroscope processing needs raw
  15-min dendro timeseries (min/max/MDS), not just daily params. If the ported controller runs
  cloud-side as a shadow, confirm the cloud holds raw dendro readings, not only the
  `dendro_daily` mirror — a second, independent argument (alongside piece 1's placement
  discussion) for edge placement.
- **[P2] Reuse OSI's sync, not Agroscope's pull.** OSI's edge→cloud sync already uses
  watermark-style incremental transfer (`sync_resource_watermarks`) with a durable outbox/inbox —
  a more robust analogue of Agroscope's high-water-mark pull. Reuse it; do not port Agroscope's
  pull logic.
- **[P2] UTC discipline.** OSI stores/handles time in UTC and must keep doing so, converting only
  at the processing boundary — this sidesteps Agroscope's local-naive-wall-clock DST dedup flaw
  by construction, provided the port introduces no local-naive timestamp as a storage/dedup key.
- **[P3] MeteoSwiss/CH-only source is the top blocker.** The weather pipeline is Swiss-specific
  end to end (STAC endpoint, slot IDs, parameter codes, bundled Swiss station CSV, hardcoded
  Europe/Zurich); OSI has non-Swiss sites (e.g. Uganda) with no MeteoSwiss coverage. Requires a
  provider abstraction — `fetch(station, window) -> [(ts, values, finalized)]` — backed by OSI's
  on-site SenseCAP S2120 (real measured rain/temp/humidity) plus a forecast API.
- **[P3] The integration surface is small.** The controller needs only one query: forecast rain
  (mm) for local day D, per zone — not the whole MeteoSwiss pipeline.
- **[P3] Design out the forecast-rain drain bug at the outset.** Query rain over all rows for the
  target day (or a decision-time snapshot), never the mutable forecast-only class; bucket by the
  zone's local day, not UTC.
- **[P4] Agroscope's global-cummax `tree_stress` vs. v6's envelope `TWD_rel` is the core
  comparison.** The two systems compute a fundamentally different deficit reference from the same
  raw trunk data; port Agroscope's signal as a separate extraction path, not a reuse of v6's
  envelope logic.
- **[P4] Densify-then-diff semantics are the #1 port-fidelity risk.** Resample-to-15min +
  `interpolate(limit=5)` + dense-grid diff/cummax/shift must be reproduced exactly; aggregating
  only days-with-data silently diverges on growth/stress across any gap.
- **[P4] Pick a consistent zone-local day boundary.** Agroscope's 03:00-shifted local day must map
  onto OSI's existing per-zone timezone handling (v6 already has this) rather than a new
  convention.
- **[P5] Compute-only reframes the plan as shadow/side-by-side — lowest-risk first phase.**
  Agroscope's controller never actuates; porting its logic means porting the decision pipeline
  (sector stress aggregation → PID dose in mm) as a shadow controller alongside v6, computing both
  and actuating neither.
- **[P5] OSI is ahead on actuation — must author the mm→duration stage.** STREGA
  `OPEN_FOR_DURATION` already works on OSI; Agroscope's valve path is a commented-out stub. OSI must
  design the dripper-flow × geometry → open-duration conversion from scratch; it does not exist to
  port.
- **[P5] Decide SEM vs. v6's population-percentile aggregation.** Agroscope's sector statistic is
  an SEM-of-the-mean (shrinks with tree count, degenerates at n=1); v6's MAD-filtered 75th
  percentile is a population-spread statistic and arguably sounder — choose faithful-parity vs.
  the better statistic.
- **[P5] Add gap/calendar handling + a decision-time rain snapshot.** Fix the close step's
  non-adjacent-day bridging (unscaled integral step across gaps) and make replay use a frozen
  rain snapshot instead of a live re-query, ties to the Piece 3 weather-drain fix.
- **[P6] Port a corrected PID, not bug-for-bug.** Real defects (dead derivative, first-error skip,
  double-integration, gain-reload footgun, `'today'` date-key corruption, silent persistence
  swallowing) should not be reproduced; a corrected port evaluates Agroscope's control approach,
  not its numeric output, so it will not be bit-identical to a running Agroscope instance.
- **[P6] Net-new controller infra + per-zone PID-state table.** OSI has no closed-loop controller
  today (v6 is open-loop). A `DendroIrrigationPID`-equivalent and its state table
  (`integral`/`last_error` per zone/date) are net-new, placed per the piece 1 edge/cloud-shadow
  decision.
- **[P6] Explicit gain precedence + real `dt` handling.** Bake in config-vs-DB gain precedence and
  per-day-rate integration with gap handling from the start, rather than inheriting Agroscope's
  silent DB-override and no-`dt` behavior.
- **[P7] Actuation barely ports.** OSI's existing STREGA `OPEN_FOR_DURATION` + async-confirm
  design already satisfies the minimal command contract derived from Agroscope's two driver
  families, and is ahead of Agroscope (whose live actuation is a commented-out stub). Different
  hardware (Agroscope Milesight vs. OSI STREGA) means no code reuse — OSI reuses its own path. The
  only new work is the mm-to-duration conversion (ties to the Piece 5 output-stage gap).

### Agroscope strengths

- **[P1] Free ordering guarantee.** The within-tick sequential pipeline (ingest → process →
  actuate) gives an implicit, correct ordering for free, with per-stage try/except resilience
  isolating one stage's failure from the others.
- **[P1] Process isolation with a guarded internal API.** Backend and GUI run as separate
  processes, communicating through a token-guarded internal API rather than shared Python state.
- **[P1] Single-consumer command queue.** The `control_queue` serializes GUI-originated mutations
  through one consumer thread, avoiding a class of write races.
- **[P1] Idempotent-leaning persistence.** Check-first schema creates, column-guarded ALTERs, and
  a `UniqueConstraint(user, sector, date)` on PID state prevent duplicate daily rows.
- **[P1] Defensive valve state machine.** Valve commands require a known current state, a valid
  transition, and uplink confirmation before being considered applied.
- **[P1] Duplicate-runtime guard.** The runtime thread starts under a lock that prevents two
  daemon-consumer instances from running concurrently.
- **[P2] Self-healing incremental pull.** High-water-mark + 30-minute-overlap pull, derived from
  the destination table itself, is stateless, crash-tolerant, and auto-recovers outage windows.
- **[P2] Atomic idempotent upsert.** Delete-then-insert per `(sensor_id, timestamp)` makes
  re-pulls idempotent despite the destination table having no unique constraint.
- **[P2] Single persistence funnel.** Both scheduled and manual pulls converge on the same
  `_store_timeseries_data` call, avoiding divergent write paths.
- **[P3] Measured-vs-forecast reconciliation state machine.** Five explicit named outcomes
  (insert / update_to_measured / update_forecast / skip_duplicate / skip_keep_measured), a
  monotone measured-beats-forecast lattice, idempotent and keyed per station/timestamp, with
  stats logged.
- **[P3] Multi-slot all-or-nothing fetch.** Tries the three most recent hourly slots and requires
  all four weather parameters before accepting a row, so no partial rows ever reach the database.
- **[P3] Self-healing past+future coverage.** Each fetch spans past and future hours, so a failed
  hour is automatically backfilled on the next run.
- **[P4] Registry pluggability.** `ALGORITHM_REGISTRY` + `select_algorithm`, with a commented-out
  override point already present — swapping the dendro algorithm is a registry entry, not a
  rewrite.
- **[P4] Strict output schema**, enforced even on the empty-input path.
- **[P4] Gap-safe densify-then-diff daily math.** Densify-then-diff refuses to invent
  growth/stress across a data gap, emitting `NaN` instead of bridging non-adjacent days.
- **[P4] Idempotent persistence.** Delete+insert per timestamp for the 15-min series; daily rows
  dedup on `MAX(id)` per `(date, user, area, sensor)`.
- **[P5] Per-area fault isolation + run summary.** Each area's run is wrapped in try/except so one
  sector's failure is logged and skipped without aborting the rest, with a run summary emitted.
- **[P5] Idempotent UPSERT daily-row lifecycle.** `UniqueConstraint(user, sector, date)` plus
  UPSERT semantics prevent duplicate daily PID rows across auto and manual runs.
- **[P5] Clean close-then-propose separation.** The integral advances exclusively on
  observation-close, never on propose — a disciplined phase split.
- **[P5] Rain-skip correctly integrated.** Parks a pending row with `irrigation_mm=0.0` without
  touching the integral, with no orphaned state.
- **[P6] Correct warm-restart / pending-vs-closed state reconstruction.** Pending rows store
  pre-update integral/last-error, closed rows store post-update — resuming either phase after a
  restart is exactly right.
- **[P6] Feed-forward placement.** Rain/water-input subtraction happens before the clamp, the
  correct location for a disturbance term in a positional PID.
- **[P6] Column-guarded persistence.** Check-first schema, `PRAGMA`-guarded ALTERs, and
  `UniqueConstraint(user, sector, date)` prevent duplicate daily PID-state rows.
- **[P6] Sound positional-PID arithmetic.** The single-call formula (proportional + integral +
  derivative, feed-forward subtract, clamp) is a standard, correct positional form in isolation.
- **[P7] `UC51XCodec` is pure, static, sequence-numbered, and testable**, with a clean
  encode-transport-confirm separation; open-for-duration is a fail-safe primitive; Strega is a
  thorough, manual-page-cited protocol reference.

### Agroscope weaknesses / risks

- **[P1] Daily control run is a single point of silent loss.** No persisted last-run marker and
  no catch-up mechanism — a missed daily tick (overrun ingestion, scheduler skip, misfire-grace
  expiry, restart blackout) is simply gone, with nothing to detect or recover it.
- **[P1] Stale-data actuation.** Ingestion failures are swallowed, so processing and the PID
  controller still run against stale data — the control gate checks the clock, not data
  freshness.
- **[P1] Unmanaged concurrency.** SQLite acts as a de facto mutex across Flask, APScheduler, the
  runtime thread, and the MQTT client thread; the GUI process also writes the DB directly,
  forming a second, uncoordinated write plane alongside the internal API.
- **[P1] Fire-and-forget unbounded command queue.** `/api/command` returns no job id and no
  result channel; a long job queued ahead of a valve command can block that valve command with no
  visibility into the delay.
- **[P1] Three time domains coexist.** A pytz Zurich gate, a naive `datetime.now()` cleanup path,
  and per-sensor `TimezoneFinder` lookups drive different parts of the system — a single-clock
  port would silently move these boundaries.
- **[P1] Health endpoint can lie.** `/api/health` can report a healthy runtime even after a
  partial initialization failure, because the init block sits outside the surrounding
  try/finally.
- **[P1] Other notables.** Docstring/comment drift on the processing hour (three different hours
  claimed in comments vs. code); a half-disabled valve MQTT path (publish and sequence-counter
  persistence commented out, but the pending-confirmation lock still arms) that can block a valve
  until process restart.
- **[P2] Local-naive DST dedup data loss.** Local-naive wall-clock timestamps are the dedup key;
  on DST fall-back, two distinct UTC hours collide to one local string and the delete-insert
  overwrites one — roughly an hour of data destroyed per sensor per year, silently.
- **[P2] Write-time timezone resolution drift.** Timezone is resolved per call via `TimezoneFinder`
  on the area's lat/lon; a later coordinate change makes old and new rows in the same table use
  different offsets, drifting the high-water-mark window re-localization.
- **[P2] Hardcoded credentials and TLS-disable.** Plaintext credentials in both REST clients, an
  API token defaulting to `local-dev-token`, MQTT broker credentials as env defaults, and
  `verify = not debug` disabling TLS verification.
- **[P2] No request timeouts.** No timeout on any REST call; a hung upstream socket stalls the
  whole pipeline, compounded by a single shared token with no retry/backoff.
- **[P2] January-1 full-history bug.** A "full history" bootstrap (`min_date=None`) actually
  substitutes January 1 of the current year, so a January bootstrap fetches almost none of the
  prior season.
- **[P2] Dead MQTT path and dead code chain.** MQTT subscribes to the whole broker firehose with
  no message handler and discards everything; the valve MQTT publish is commented out;
  `mqtt_bridge.py` is an orphaned script; `get_data_api.py` and `GUI/GUI.py` are unreferenced dead
  code, the latter serving fake readings via a swallowed `NameError`.
- **[P3] Forecast-rain drain bug.** The only weather input the controller uses (forecast rain via
  `measured=0` rows) is systematically starved by the ingester's own behavior: every hourly run
  upgrades elapsed hours to measured, and cleanup deletes forecast rows older than 7 days. This
  breaks both the daily rain-skip gate (outcome depends on scheduler luck, not weather) and
  historical PID replay (which always sees forecast_rain=0).
- **[P3] O(stations) nationwide re-downloads.** Weather fetch runs per station and re-downloads
  the full STAC list plus all four nationwide CSVs each time, then filters to one point — K
  stations means K identical multi-megabyte downloads per run.
- **[P3] Five clock conventions in one path.** UTC-naive storage, a Zurich-aware `measured` flag,
  a UTC-date rain bucket, a Zurich-aware daily gate, and a naive cleanup cutoff all coexist.
- **[P3] No request timeouts.** No timeout on any weather API call; since weather runs first in
  the pipeline, a hung endpoint stalls the whole tick.
- **[P3] Euclidean nearest-station without cos(lat).** Station assignment uses raw lat/lon
  distance with no latitude correction, inflating east-west distance, and drops valid `0.0`
  coordinates via a truthiness check.
- **[P4] Polarity-asymmetric normalization offset on absolute-size columns.** An unconditional
  offset assignment meant for the inverted case is applied to both branches; it cancels in
  difference-based columns (MDS/growth/stress) but corrupts absolute-size columns
  (min/max/historical-max) for non-inverted sensors.
- **[P4] `first_max` None→crash / NaN-poison latent trap.** A `None` first_max raises a swallowed
  `TypeError`; `== None` guards (not `is None`) fail to re-arm on `NaN`, so an empty night-window
  read freezes `first_max = NaN` and poisons the entire downstream history.
- **[P4] O(days²) full-history reprocessing.** Every run reprocesses all history via a per-day
  full-index scan plus an in-loop `concat`.
- **[P4] Non-dendro-piggyback ordering silently drops params.** Non-dendro daily params only
  `UPDATE` existing rows keyed to a dendro row; without a pre-existing dendro row for that
  `(date, user, area)`, watermeter/valve/rain data for the day is silently dropped.
- **[P4] DST mis-bucketing.** The naive-local index, 3h day-shift, `between_time`, and 15-min
  resample interact to mis-bucket and double/half-count samples on DST transition days.
- **[P5] Actuation is a stub — compute-only, severed output.** The PID's dose never reaches a
  valve at any of three layers checked (run-loop TODO, dose read-back for state only, and the one
  real valve path's publish commented out); the entire actuation stack is a dry run.
- **[P5] Gap-bridging closes non-adjacent days as adjacent, unscaled integral.** The close guard is
  only `pending_day != current_day`, with no adjacency/calendar-delta check, so a multi-day gap is
  closed as a single unscaled integral step.
- **[P5] Single daily tick, no catch-up.** Actuation fires only at the hourly gate's cutoff hour
  and auto mode processes only the latest day; a missed tick's proposal is silently lost.
- **[P5] Silent persistence-failure → warm-restart drift.** Persistence methods swallow exceptions
  and return `False`; the in-memory integral can advance while the DB row fails to write, with no
  signal.
- **[P5] SEM-of-mean signal shrinks with tree count / degenerates at n=1.** More dendrometers
  yields a less conservative sector signal; fixed z=1.96 understates the interval at small n; a
  single-tree sector fully drives the signal with `ci_half=0`.
- **[P5] Mixed raw-sqlite3 + SQLAlchemy contention.** PID upserts use raw `sqlite3` while manual
  reset uses a SQLAlchemy session against the same file — a writer-contention/locking exposure.
- **[P6] Dead derivative, off-by-one.** `last_error` is set to the current day's error at update
  time, so `Kd*(e - last_error)` is structurally always `0` at the next propose — moot at the
  configured `Kd=0` default, silently dead if `Kd` is ever set nonzero.
- **[P6] First error never integrated.** `e1` drives the first valve output proportionally only;
  the integral accumulates starting at `e2` — a one-sample asymmetry vs. a textbook positional PID.
- **[P6] `update()` double-integrates (non-idempotent).** The integral increment is not guarded by
  the pending/closed check, so calling `update` twice (or without a prior `propose`) silently
  mutates the integral a second time.
- **[P6] Anti-windup freezes both directions and can stall recovery.** The gate freezes integration
  whenever the preview clamps at either 0 or max, using the stale pre-update integral; a large
  integral built during deficit can delay recovery once conditions flip.
- **[P6] Gain-reload footgun.** DB-stored gains silently override config/constructor gains on every
  restart with any existing row — a live-tuning trap, not documented as such.
- **[P6] Silent persistence-failure swallowing.** Every persistence method returns `False` on any
  exception with no logging, and callers discard the result — PID state can silently fail to save.
- **[P6] `'today'` date-key corruption.** A back-compat wrapper's literal `'today'` fallback sorts
  lexically above real dates, so it can become the "latest" row loaded on warm restart.
- **[P6] No `dt`/irregular-sampling handling.** `Ki` is applied per-step, not per-day-rate; multi-day
  gaps closed in one `update` call are integrated as a single step.
- **[P7] Strega is dead/unreachable code**, written against an old MQTT client. Its blocking
  `wait_for_ack` parks a thread for 18-36 minutes and shares concurrency-unsafe ACK state.
  `set_valvestatus` can leave a valve open indefinitely with no confirmation on the safety-critical
  commands; `set_time` writes local wall-clock, not UTC, to the device RTC; there is a
  hex-vs-BCD encoding ambiguity; the code is print-based, untested, and duplicated.

### OSI v6 improvement ideas

- **[P1] Persisted run state and freshness gating.** v6's `DendroScheduler` is itself a plain daily
  cron with no persisted last-successful-run marker, no data-freshness precondition, and no
  missed-run reconciliation. Agroscope's failure modes (silent daily-run loss, stale-data
  actuation — see piece 1) are a cautionary tale that applies to v6 too. Add: a persisted per-zone
  "last successful analytics date," a freshness gate (skip/flag if the latest ingested day is
  stale), and startup/missed-run reconciliation. OSI can do better than both systems here.
- **[P1] Health/observability.** v6 should expose per-zone last-run status and data freshness so a
  missed daily run is detectable from the outside. Agroscope's `/api/health` can report a healthy
  runtime even when initialization partially failed (see piece 1) — v6 should not repeat that
  pattern.
- **[P2] Measured-data-beats-forecast reconciliation.** v6 should adopt the discipline that
  measured data, once available, supersedes forecast-based estimates rather than being
  reconciled ad hoc (detailed further in the weather-pipeline piece).
- **[P2] Document the sync mirror's gap-fill guarantee.** Confirm and document that OSI's
  edge→cloud dendro mirror carries a "self-healing gap-fill" guarantee equivalent to Agroscope's
  high-water-mark + overlap pull, so a cloud-side shadow run of either controller never silently
  sees a gap after an outage.
- **[P3] Adopt the measured-beats-forecast reconciliation discipline.** Measured immutable,
  forecast revisable, measured never downgraded by a later forecast — cleaner than v6's current
  rain suppression window, and fully correct on OSI once a real measured source (S2120) is paired
  with a forecast feed.
- **[P3] Open design/experimental question — VPD's role.** Agroscope computes VPD but drops it
  from control (rain + stress only); OSI v6 applies a VPD-based stress adjustment. Flag this
  divergence for the parallel comparison as a chance to test empirically whether v6's VPD
  adjustment adds signal or noise — not a settled claim either way.
- **[P4] Consider trunk growth as a first-class daily signal.** Agroscope tracks day-to-day trunk
  growth explicitly (its RDI rationale is "grow toward potential"); v6 does not use growth as a
  control input today — worth evaluating.
- **[P4] Confirm v6 never treats gap-separated days as adjacent.** v6's envelope
  anchor-eligibility logic largely already covers this; verify no day-to-day computation silently
  bridges a gap the way a naive port of Agroscope's logic would.
- **[P4] Coverage-gate validation, not a change.** Agroscope's per-day coverage gate parallels
  v6's confidence gating; v6's solar-window + sample-floor approach is arguably more principled —
  treat this as validation that v6 is on the right track.
- **[P5] v6's population-percentile aggregation is validated, not just different.** MAD + 75th
  percentile is a sounder sector statistic than Agroscope's SEM-of-the-mean; v6 could still borrow
  Agroscope's habit of carrying an explicit sector-level uncertainty/confidence into the decision.
- **[P5] Adopt the close-then-propose lifecycle if v6 gains controller state.** The
  close-then-propose two-phase plus rain-skip-parks-without-update is a clean state-machine
  pattern worth reusing if v6 gains feedback/controller state.
- **[P5] Per-area fault isolation + run-summary logging is a good ops pattern for v6's scheduler
  too.**
- **[P6] Headline of the whole assessment: add closed-loop feedback to v6.** v6 is open-loop —
  classify stress, apply a percentage rule, no feedback on whether the tree responded. Borrow
  Agroscope's core idea: a feedback/integral term that corrects the water recommendation based on
  whether yesterday's irrigation actually reduced measured stress. Even short of a full PID, an
  integral term over the v6 stress trajectory would make v6 self-correcting instead of purely
  reactive.
- **[P6] Adopt an explicit RDI setpoint.** Replace v6's implicit "avoid stress" thresholds with a
  deliberate, named mild-deficit target, as Agroscope's `tree_daily_limit` does.
- **[P6] Warm-restart state persistence + missed-cycle reconciliation.** Any v6 controller state
  should persist pending-vs-closed state correctly and reconcile missed cycles on restart, tying
  to the [P1] persisted-run-state idea.
- **[P7] Validate, don't change.** Confirm OSI's actuation design (fail-safe open-for-duration +
  async confirm + explicit unknown-on-timeout + sequence/idempotency) is sound — it already matches
  the contract this review derives. If any gap: ensure OSI's command layer always surfaces an
  explicit `unknown` state on ack timeout rather than assuming success or failure, the discipline
  Agroscope's Strega violates and `UC51XCodec`/`main.py` gets right.
