# Piece 6 — PID Controller (Control Law, Persistence, Anti-Windup)

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

## 1. What it is / how it works

Scope: `backend/actuators.py` — the positional PID that turns a daily deficit into an actual
valve-open dose, and its warm-restartable persistence.

**Construction.** Error `e = tree_daily_limit - margin` (`_compute_error_from_deficit:90-92`).
Raw output `raw = Kp*e + integral + Kd*(e - last_error)`; the valve target is
`clamp(raw - water_input, 0, max)` (`_build_output_from_error:77-88`) — feed-forward (measured
rain/irrigation) is subtracted before the clamp, the correct placement for a disturbance term.
`Ki` is not applied in this construction step; it is applied at accumulation time (`:330`), so the
integral enters as an already-scaled running total, not a positional `Ki*sum(e)` computed fresh
each call.

**Daily two-phase lifecycle.**
- `propose_irrigation_for_day(day, margin)` computes today's error, builds the valve target, stashes
  a `pending_cycle`, and `save_values()` writes a **pending** row (`:304-323`).
- `update_with_next_day_observation(next_day, next_margin, next_water)` computes tomorrow's error,
  applies anti-windup — `if 0 < next_target < max: integral += Ki*error_next` (`:329-330`) — sets
  `last_error = error_next` (`:332`), and closes the pending row (`:325-340`).

**Persistence.** One row per `(user, sector, date)` in `dendro_pid_states`
(`models.py:136-169`, `UniqueConstraint(user, sector, date)` at `:167-168`). `load_previous_values`
restores `integral`/`last_error`/gains and, if the latest row (by `date DESC, rowid DESC`) is
pending, reconstructs `pending_cycle` (`:235-292`). Writes are column-guarded via `PRAGMA`
(`:73-75, 114-120`); connection ownership is correct — an injected connection is never closed, a
path-opened one is closed in `finally` (`:98-103`).

## 2. Strengths

- **Correct warm restart.** Load reads the latest row (`ORDER BY date DESC, rowid DESC`), restores
  `integral`/`last_error`, and reconstructs `pending_cycle` if that row is pending. Because a
  pending row stores the **pre-update** integral and a closed row stores the **post-update**
  integral, resuming either phase after a restart is exactly right (`:235-292`).
- **Feed-forward placement.** Subtracting `water_input` before the clamp (`:81`) is the correct
  location for a disturbance term in a positional PID — it does not distort the anti-windup gate's
  view of the unclamped control signal.
- **Column-guarded, idempotent-leaning persistence.** Check-first schema, `PRAGMA`-guarded ALTERs,
  and `UniqueConstraint(user, sector, date)` prevent duplicate daily rows; connection lifecycle
  (injected vs. path-opened) is handled correctly.
- **Sound positional-PID arithmetic at the single-call level.** In isolation, `raw = Kp*e +
  integral + Kd*delta_e`, feed-forward subtraction, then clamp is a standard, correct positional
  form.

## 3. Weaknesses & risks (ranked)

1. **Silent persistence-failure swallowing** (`:171, 232, 291`). Every persistence method is
   `except Exception: return False`, and callers ignore the return (`save_values()`'s result is
   discarded at `:322`). Controller state — including the integral term — can silently fail to
   save, with no logging, no alarm, and no distinguishable symptom from a normal run.
2. **`update()` double-integrates on double-invocation.** The integral increment at `:330` runs on
   every call to `update_with_next_day_observation` and is **not** guarded by `pending_cycle` (only
   the DB row close is guarded, `:175`). Calling `update` twice — or calling it with no prior
   `propose` — silently mutates the integral a second time. Non-idempotent control state.
3. **Anti-windup freezes on saturation in either direction and can stall recovery.** The gate is a
   coarse freeze-on-any-saturation: it previews the *next* target using the **stale pre-update**
   integral, with strict bounds `0 < preview < max` (exact 0 or exact `max` both skip
   integration), and freezes whenever the preview clamps at *either* end. A large integral built up
   during a deficit can stall and delay recovery once conditions flip back (a delayed, not
   permanent, unwind). Because feed-forward (rain) is subtracted before the same preview, a large
   rain event can freeze integration even when the PID term itself is nowhere near saturated.
4. **Gain-reload footgun.** `load_previous_values` overwrites `self.kp/ki/kd` from the last DB row
   (`:268-270`), so constructor/config gains are silently discarded whenever any row exists — DB
   always wins. Framed in the docstring as "restart reproducibility," but it is a silent
   live-tuning trap: a changed `Ki` in config never rescales the historical integral and has no
   effect until the DB row itself is changed.
5. **Dead derivative term (structural), with an off-by-one in `last_error`.** `update` sets
   `last_error = error_next` (`:332`); the next `propose` reuses that same margin, so
   `Kd*(e - last_error)` evaluates to `0` at `:79` regardless of `Kd`. `last_error` at propose time
   holds the **current** day's error, not the previous day's — a semantic off-by-one. Moot at the
   configured default (`Kd=0`), but silently dead the moment `Kd` is set nonzero.
6. **First error never integrated.** `e1` drives `valve1` proportionally, but only `e2, e3, ...`
   ever enter the integral (accumulation happens at `:330`, which only runs on `update`, never on
   the first `propose`). A one-sample asymmetry versus a textbook positional PID.
7. **No `dt`/sample-time handling.** `Ki` is applied per-*step*, not per-day-rate; two elapsed days
   closed in one `update` call are treated as a single step, and irregular sampling silently
   mis-integrates with no gap detection anywhere in the class.
8. **`'today'` date-key bug in the back-compat wrapper.** `calculate_irrigation_depth_in_mm` passes
   `day_date='today'` (`:346`); `datetime.fromisoformat('today')` raises, and the fallback stores
   the literal string `'today'` as the date. `'today'` sorts lexically **above** any `'2026-...'`
   date, so it becomes the "latest" row on `ORDER BY date DESC` load — latent corruption of the
   warm-restart path via a wrapper that looks like a harmless convenience default.
9. **Naive-clock timestamps.** Auto day-keying (`:62`) and `created_at`/`updated_at` use naive
   `datetime.now()` — TZ-sensitive at local midnight, consistent with the naive-clock issues found
   elsewhere in the Agroscope codebase (piece 1).

Separately, `GrowthModel` (`:10-19`) is a dormant, unused stub — the controller never calls it, and
`calculate_irrigation_depth_in_mm` even discards its own `target_potential_size_um` argument
(`:344`). Dead code, not a control-loop risk, but worth flagging so it is not mistaken for an active
growth-target feature during the port.

## 4. Integration challenges (OSI)

**The port decision — surface this before any other integration point.** Distilling Source A found
real, load-bearing defects: a structurally dead derivative term, the first-error integration skip,
non-idempotent double-integration on repeated `update` calls, the gain-reload footgun, the
`'today'` date-key corruption, and silent persistence-failure swallowing. The goal of this
integration is to evaluate Agroscope's **approach** — closed-loop, regulated-deficit dose control
with next-day feedback — not to reproduce its implementation bugs. **Recommendation: OSI should
port a corrected PID, not a bug-for-bug port.** State the tradeoff explicitly to stakeholders: a
corrected port will **not** be bit-identical to Agroscope's numbers, so the comparison is about
control approach and field outcomes, not numeric reproduction. (Bit-exact parity with a live
Agroscope instance is a separate, lower-value exercise, only worth doing if that specific parity
claim is ever required.)

**What to adopt regardless of the bug-fix decision (the genuinely good ideas):**
- The closed-loop structure itself — propose dose, observe next-day tree response, correct.
- The RDI setpoint — a deliberate mild-deficit target, not an implicit "avoid stress" threshold.
- Feed-forward rain subtraction before the clamp.
- The **correct** warm-restart discipline: pending row = pre-update state, closed row = post-update
  state, keyed off row status. Copy this pattern directly — it is the one piece of persistence
  design in this module that is unambiguously right.

**Net-new infrastructure.** OSI has no controller infra today — v6 is open-loop rule-based
classification. A `DendroIrrigationPID`-equivalent is net-new code, not a refactor. Placement
follows the piece 1 decision (edge for actuation + next-day feedback, or cloud shadow for
comparison against v6). PID state (`integral`/`last_error` per zone/date) maps to a new OSI table,
`DendroPIDStates`-equivalent, keyed per zone/date (mirroring Agroscope's
`UniqueConstraint(user, sector, date)`).

**Fixes to bake in from the start, not bolt on after:**
- Guard the integral increment behind the same pending/closed check that guards the DB row close —
  makes `update` idempotent.
- Explicit gain precedence (config vs. DB) instead of silent DB-always-wins.
- Real `dt`/missing-day handling: treat `Ki` as a per-day rate and skip or scale integration across
  gaps — a genuine improvement over Agroscope, not just a bug fix.
- Surface (log/alert) persistence failures instead of swallowing them.
- Real date keys everywhere; no string-literal date fallback.

## 5. OSI v6 improvement ideas

- **[P6] Headline of the whole assessment: v6 is open-loop.** It classifies stress and applies a
  percentage rule with no feedback from whether the tree actually responded. The single biggest
  idea to borrow from Agroscope, independent of whether OSI ever ports the PID itself, is
  **closed-loop correction**: add a feedback/integral term that adjusts the water recommendation
  based on whether yesterday's irrigation actually reduced measured stress. Even short of a full
  PID, an integral term over the v6 stress trajectory would make v6 self-correcting instead of
  purely reactive.
- **[P6] Adopt an explicit RDI setpoint.** Replace v6's implicit "avoid stress" thresholds with a
  deliberate, named mild-deficit target, the way Agroscope's `tree_daily_limit = -100 um` makes RDI
  the setpoint itself rather than an emergent property of threshold tuning.
- **[P6] Warm-restart state persistence + missed-cycle reconciliation.** Any v6 controller state
  (a stress-trajectory integral, or a future PID) should persist pending-vs-closed state the way
  Agroscope's PID does correctly, and reconcile missed cycles on restart — ties directly to the
  [P1] persisted-run-state idea already in the registry.

## 6. Re-implementation complexity

**Rating: control arithmetic alone — LOW. Exact-behavior fidelity — MEDIUM, bordering HIGH.**

The single-call formula (`Kp*e + integral + Kd*delta_e`, feed-forward subtract, clamp) is trivial
arithmetic on any stack. The difficulty is entirely in reproducing the *exact* stateful behavior
around it, which is subtle enough to silently diverge if ported casually:

1. The propose/close accumulation timing — the integral advances only at `update` (close), using
   the *next* day's error, computed *before* the next `propose`; `e1` is never integrated.
2. The exact anti-windup gate — a post-feed-forward, post-clamp preview computed with the
   **pre-update** integral/last-error, strict (not inclusive-safe) bounds.
3. The derivative degeneracy — `D == 0` under same-margin propose, given the `last_error` timing.
4. Warm-restart semantics — DB gains override config; a pending row is pre-update, a closed row is
   post-update.
5. `update()`'s non-idempotency under repeated or out-of-order calls.
6. The silent-swallow control flow around every persistence call.

**Recommended fixes, independent of the porting decision:** guard the integral increment behind
the `pending_cycle` check (fixes double-integration); surface persistence failures instead of
swallowing them; fix `last_error` semantics if the derivative term is meant to be live; replace the
`day_date='today'` fallback with a real date; decide explicitly whether DB gains should override
config, rather than leaving it as an implicit side effect of `load_previous_values`.

Given the port decision in Section 4 (correct, don't bug-for-bug reproduce), OSI's actual
implementation effort is lower than a literal port would suggest — items 2 and 5 above are
precisely the behaviors OSI should *not* reproduce. What must still be preserved exactly is the
propose/close phase split (item 1) and the correct warm-restart discipline (item 4), since those
are the mechanisms, not the bugs.
