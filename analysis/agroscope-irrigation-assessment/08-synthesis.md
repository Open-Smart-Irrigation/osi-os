# Piece 8 — Synthesis: Integrating Agroscope's Irrigation Logic into OSI

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

This piece consolidates the seven per-piece analyses (01–07) into a single integration plan, a
prioritized v6 improvement roadmap, and a final verdict. Every claim below traces to a piece via
its `[P#]` tag; no new code analysis is performed here.

## 1. Executive summary / verdict

Agroscope built a genuinely interesting control-theoretic irrigation controller: a daily
closed-loop PID that holds trees at a deliberate mild-deficit setpoint (regulated-deficit
irrigation, RDI) by computing a water dose in mm and correcting from the tree's measured
next-day response. This is a fundamentally different, more principled paradigm than OSI v6's
open-loop classify-then-percentage-rules. The core ideas are strong and worth adopting.

The implementation, however, is research-grade:

- the actuation output is a stub, compute-only `[P5]`;
- the controller has real defects — dead derivative, first-error skip, double-integration,
  gain-reload footgun, no `dt`/gap handling `[P6]`;
- the forecast-rain gate is broken by a state-mutation race `[P3]`;
- timestamps are DST-fragile local-naive `[P2][P4]`;
- secrets are hardcoded `[P2]`;
- and much of the codebase is print-driven and untested `[P7]`.

**Verdict.** Port the approach, not the code; fix the defects in the port; and lean on OSI's more
mature infrastructure — native ingestion, robust sync, working STREGA actuation, per-zone
timezones, UTC discipline — which is ahead of Agroscope on every plumbing dimension.

## 2. What Agroscope got right (consolidated strengths)

- **Closed-loop feedback.** Propose dose → observe next-day tree response → correct. `[P5][P6]`
- **RDI as the setpoint.** A deliberate mild deficit (`-100 um`) baked in as the control target,
  not layered on afterward. `[P6]`
- **Feed-forward rain compensation.** Subtract measured water input from the output; skip and
  freeze the controller entirely on forecast rain. `[P5][P3]`
- **Correct warm-restart discipline.** A pending row stores pre-update state, a closed row stores
  post-update state. `[P6]`
- **Measured-beats-forecast weather reconciliation.** A monotone, idempotent state machine. `[P3]`
- **Self-healing incremental ingestion.** High-water-mark pull with overlap. `[P2]`
- **Per-area fault isolation and run summaries.** `[P5]`
- **`UC51XCodec`.** Clean, pure, sequence-numbered, testable actuation codec with correct
  encode/transport/confirm separation; open-for-duration as the fail-safe primitive. `[P7]`
- **The "just-math" daily extraction core.** MDS, growth, `cummax`, stress. `[P4]`

## 3. What to be careful of (consolidated weaknesses/risks)

Grouped by how they should gate the port.

### Blocking — fix or decide before the port does anything real

- **Actuation is a stub / compute-only** `[P5]` — but this makes shadow mode trivial to adopt as a
  first phase.
- **PID defects.** Dead derivative (`last_error` off-by-one), first error never integrated,
  `update()` double-integrates, no `dt`/irregular-sampling handling, gain-reload footgun (DB
  silently overrides config). `[P6]`
- **Gap-bridging in the run-loop.** Non-adjacent days are closed as adjacent, with an unscaled
  integral step. `[P5]`
- **Weather-rain drain bug.** The forecast-rain gate reads a state class the ingester continuously
  erases, so the rain-skip fires on scheduler luck, and replay never matches live behavior. `[P3]`

### Structural

- **Local-naive, DST-fragile timestamps.** A dedup-key collision destroys roughly an hour of data
  per sensor per year. `[P2][P4]`
- **SEM-of-mean sector aggregation.** Shrinks with tree count; degenerates at n=1. `[P5]`
- **Single hourly tick, no catch-up.** Silent daily-run loss; stale-data actuation. `[P1]`
- **Silent-swallow error handling throughout.** Persistence and algorithm code alike. `[P1][P5][P6]`
- **O(days²) full-history reprocessing.** `[P4]`

### Operational / security — do not port

- **Hardcoded plaintext credentials** and a TLS-disable path. `[P2]`
- **Dead/duplicate/inert code** — `get_data_api.py`, Strega, `GUI/GUI.py`, MQTT firehose-drop.
  `[P2][P7]`
- **Docstrings that describe a different system than the code.** `[P1][P2][P3]`

## 4. Integration plan

### 4.1 Guiding principle

Port the **decision pipeline** (control logic), not the plumbing. OSI's plumbing is already
better on every axis:

- native LoRaWAN ingestion vs. a REST mirror;
- robust watermark sync with outbox/inbox vs. a high-water-mark pull;
- working STREGA `OPEN_FOR_DURATION` with async confirm vs. stubbed/dead actuation;
- per-zone timezones and solar windows vs. hardcoded CET;
- DB-backed calibration;
- UTC discipline throughout.

### 4.2 What ports, what doesn't

| Piece | Port? | Action |
|---|---|---|
| P1 Scheduler | No | Use OSI's scheduler; add persisted last-run + data-freshness gate (better than Agroscope). Don't copy APScheduler's drop semantics or the after-ingestion hour-gate. |
| P2 Ingestion | No | OSI ingests natively and is the system of record. Reuse OSI sync. Confirm raw sub-daily dendro availability wherever the controller runs. |
| P3 Weather | Minimal | Author a thin provider giving "forecast rain (mm) for local day D per zone" over S2120 plus a global forecast API. Adopt measured-beats-forecast reconciliation; design out the drain bug (decision-time snapshot; local-day bucketing). |
| P4 Sensor processing | Yes (separate path) | Port Agroscope's `tree_stress` extraction (global-cummax signed deficit) as a separate extraction alongside v6's `TWD_rel`, from the same raw data. Reproduce the densify-then-diff/cummax/shift semantics faithfully — the #1 fidelity risk. Fix the normalization offset and the `None`/`NaN` traps. |
| P5 Run-loop | Yes (corrected) | Port sector aggregation and the close-then-propose lifecycle plus rain-skip-parks. Decide SEM vs. v6's percentile aggregation. Add gap/calendar handling. Author the mm→duration conversion. |
| P6 PID | Yes (corrected) | Port a corrected PID — fix dead-D, first-error, double-integrate, gain precedence, `dt`/gap handling. Keep the good warm-restart. Not bug-for-bug. |
| P7 Actuation | No | Reuse OSI's STREGA `OPEN_FOR_DURATION` + async-confirm — it already satisfies the contract and is ahead of Agroscope. |

### 4.3 Placement (phased)

- **Phase 0 — shadow, compute-only.** Run the Agroscope decision pipeline alongside v6,
  persisting both outputs (Agroscope dose in mm; v6 recommendation) per zone/day. Neither
  actuates. Lowest risk; exactly what Agroscope itself does today; directly serves the comparison
  goal.
- **Phase 1 — edge actuation, opt-in.** For opted-in zones, let the Agroscope controller drive
  OSI's STREGA (via the authored mm→duration stage), edge-side — raw data, actuation, and
  next-day feedback all local. Mirror decisions to cloud for the side-by-side comparison against
  v6. Matches OSI's existing `agroscope-dendrometer-controller.md` draft (edge-authoritative,
  recommendation-first).
- **Recommendation.** Start Phase 0 as a cloud-side shadow — the fastest path to a comparison —
  then move actuation to the edge in Phase 1.
- **Open question to resolve first.** Does the cloud hold raw sub-daily dendro readings (needed
  for Agroscope's extraction), or only daily params? If only daily params, Phase 0 extraction must
  run edge-side, or raw data must be synced.

### 4.4 The "1:1" question, resolved

"1:1" should mean faithful to the **approach** — closed-loop RDI PID dose control on
global-cummax stress with forecast-rain feed-forward — not bit-identical to Agroscope's buggy
numbers. Reproducing the defects would degrade the comparison, not sharpen it. Port a corrected
controller and document each deviation. Exact parity with a live Agroscope instance, if ever
needed, is a separate, lower-value exercise.

### 4.5 Data model

- A new per-zone PID-state table mirroring `DendroPIDStates` (integral, last-error, gains,
  status, date; warm-restart support).
- Sector → zone.
- `daily_sensor_parameters` → `dendro_daily`, plus a new Agroscope-stress column alongside v6's
  `twd_rel`.
- Environmental forecast-rain → the OSI weather contract.

## 5. OSI v6 improvement roadmap

Prioritized by value and risk, drawing on both Agroscope's strengths and its failure modes.

**P0 — highest value, borrowed from Agroscope's strengths:**

1. **Add closed-loop feedback to v6.** v6 is purely open-loop/reactive. Add a feedback/integral
   term that corrects the water recommendation based on whether the tree's stress actually
   responded to yesterday's irrigation. Even short of a full PID, an integral over the v6 stress
   trajectory makes v6 self-correcting. This is the single biggest borrow from the whole
   assessment. `[P6]`
2. **Adopt an explicit RDI setpoint** — a deliberate mild-deficit target — instead of v6's
   implicit avoid-stress thresholds. This is the water-saving lever. `[P6]`

**P1 — robustness, from Agroscope's failure modes as cautionary tales:**

3. **Persisted last-successful-run marker, data-freshness gate, and missed-run reconciliation**
   in v6's `DendroScheduler`. `[P1]`
4. **Measured-beats-forecast reconciliation and a decision-time rain snapshot** for v6
   weather/rain handling. `[P3]`
5. **Warm-restart / state-persistence discipline** for any v6 controller state. `[P6]`

**P2 — validation, where v6 is already ahead; keep these:**

- v6's stepwise envelope (vs. Agroscope's ever-rising global `cummax`), per-crop DB calibration,
  MAD+75th-percentile aggregation (vs. SEM-of-mean), per-zone timezones and solar windows,
  confidence gating, and UTC discipline are all superior to Agroscope's equivalents. This
  assessment validates these v6 choices — no change needed.

**Empirical questions the parallel run should answer** (open experimental questions, not settled
claims):

- Does v6's VPD adjustment add signal or noise? Agroscope dropped VPD from control, using stress
  and forecast rain only. `[P3]`
- Which deficit reference tracks irrigation need better — Agroscope's global-cummax signed stress,
  or v6's stepwise-envelope `TWD_rel`? `[P4]`
- Does closed-loop dose control (Agroscope) save more water or hold tree status better than v6's
  open-loop percentage rules, at equal-or-better quality? `[P5][P6]`

## 6. The paradigm divergence

| Aspect | Agroscope | OSI v6 |
|---|---|---|
| Signal | Global-cummax signed stress | Stepwise-envelope `TWD_rel` |
| Aggregation | SEM-of-mean upper-95% CI | MAD-filtered 75th percentile |
| Paradigm | Closed-loop PID, dose in mm | Open-loop classify → percentage rule |
| Deficit strategy | RDI setpoint (`-100 um`) | Threshold avoid-stress |
| Feedback | Next-day correction | None |
| Rain | Feed-forward subtract + forecast skip | Suppression window |
| Weather source | MeteoSwiss-only | S2120 + forecast API |
| VPD | Dropped from control | Active stress adjustment |
| Actuation | Stub / dead Strega | Working STREGA |
| Calibration | Global environment gains + fixed setpoint | Per-crop DB thresholds |
| Timezone | Hardcoded CET | Per-zone |
| Maturity | Research-grade | Productionized |

## 7. Recommended next steps

1. Decide placement/phasing — recommendation is Phase 0 cloud-side shadow.
2. Confirm raw sub-daily dendro availability wherever the controller will run.
3. Spec the corrected PID, the mm→duration conversion, and the per-zone PID-state schema.
4. Spec the minimal weather (forecast-rain) provider and the measured/forecast reconciliation.
5. Stand up the shadow comparison harness: persist both controllers' daily outputs per zone, plus
   a view to compare doses/recommendations against realized tree status.
6. Then brainstorm and plan the implementation — this assessment feeds a spec, it is not one.
