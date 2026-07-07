# Piece 1 — Entry Point & Scheduler / Orchestration

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

## 1. What it is / how it works

Agroscope's root `main.py` launches two supervised subprocesses: a backend on port 5101 and a GUI
on port 5100.

**Backend process.** A Flask dev server (werkzeug, threaded) runs in the main thread. Alongside
it, a daemon runtime thread consumes a thread-safe `control_queue`, and an APScheduler
`BackgroundScheduler` runs a single cron job, `_backend_master_pipeline`, hourly at minute 10,
Europe/Zurich time.

**Each hourly tick:**
1. Runs the weather task, then raw-data ingestion — each wrapped in its own swallow-all
   try/except.
2. Computes `now_local`. Only if the local hour equals `ANALYSIS_CUT_OFF_HOUR` (3) does it
   additionally run `_run_task_process_data` and then `_run_configured_area_actuators`.
3. At midnight (checked via a naive `datetime.now().hour == 0`), runs forecast cleanup inside the
   weather task.

Schema is created/migrated ad hoc at runtime start via `_ensure_*` ALTER/CREATE statements — there
is no migration tool or schema version tracking.

In effect: one hourly cron job does double duty as both a frequent ingestion poller and, once a
day, the gate for the entire process → actuate pipeline. The "run at 3am" behavior is really "the
tick that happens to fire during the hour-3 window, after that tick's own ingestion step has
already run."

## 2. Strengths

- **Free ordering guarantee.** The within-tick sequential pipeline (ingest → process → actuate)
  gives an implicit, correct ordering for free — no separate coordination mechanism is needed to
  ensure data lands before it's analyzed.
- **Per-stage fault isolation.** Each pipeline stage runs in its own try/except, so one stage's
  exception doesn't necessarily prevent the tick from completing (though see weaknesses below on
  what that isolation costs).
- **Process isolation with a guarded internal API.** Backend and GUI are separate processes,
  communicating through a token-guarded internal API rather than sharing Python state directly.
- **Single-consumer command queue.** The `control_queue` serializes GUI-originated mutations
  through one consumer thread, avoiding a class of write races.
- **Idempotent-leaning persistence.** Schema setup uses check-first creates and column-guarded
  ALTERs; a `UniqueConstraint(user, sector, date)` on PID state prevents duplicate daily rows.
- **Defensive valve state machine.** Valve commands require a known current state, a valid
  transition, and uplink confirmation before being considered applied.
- **Duplicate-runtime guard.** The runtime thread is started under a lock that prevents two
  instances of the daemon consumer from running concurrently.

## 3. Weaknesses & risks (ranked)

1. **Daily control run is a single point of silent loss** (`backend/main.py:1935-1938`). There is
   exactly one tick per day that can trigger the process → actuate pipeline. That opportunity is
   lost if: ingestion overruns past 03:59; APScheduler's `max_instances=1` causes a skip; the
   default `misfire_grace_time=1s` expires; or the tick falls inside the 600-second systemd
   `RestartSec` blackout. There is no persisted "last successful daily run" marker and no
   startup catch-up or reconciliation — a missed day is simply gone.
2. **Stale-data actuation** (`backend/main.py:1929-1945`). Because ingestion failures are swallowed
   around line 1932, processing and the PID controller still run on stale data. The control gate
   has no data-freshness precondition — it checks the clock, not the data.
3. **Unmanaged concurrency around one SQLite file.** Flask request threads, the APScheduler pool
   threads, the runtime consumer thread, and the MQTT client thread all share a single, untuned
   SQLite file (no WAL, no `busy_timeout`) plus module-level globals. Correctness rests on SQLite's
   single-writer lock and the Python GIL, not on deliberate design. The GUI process also reads and
   writes the SQLite file directly (`GUI/main.py:91`), forming a second coordination plane
   alongside `/api/command`.
4. **Fire-and-forget commands.** `/api/command` returns `{ok, queued}` with no job id and no
   result channel, backed by an unbounded queue. A full-history reprocess job queued ahead of a
   valve command will block that valve command behind it with no visibility into the delay.
5. **Three time domains coexist.** pytz Zurich time drives the analysis gate (line 1935); a naive
   `datetime.now()` drives midnight cleanup (line 1797) and the supervisor; and per-sensor
   `TimezoneFinder` lookups drive individual pull windows. A single-clock port would silently move
   these boundaries.
6. **Weak observability.** `/api/health` (lines 437-439) can report `runtime_started: true` even if
   initialization threw, because the schema/MQTT/scheduler init block (lines 1980-1993) sits
   outside the surrounding try/finally. There is no thread/scheduler liveness check and no
   missed-run detection — only logs.

**Other notables:**
- The docstrings at lines 1962-1966 describe a different system than the code implements (they
  claim a startup pull plus three separate jobs, none of which exist). Any port must be derived
  from behavior, not comments.
- The valve MQTT publish and its sequence-counter persistence are currently commented out (around
  lines 752-770), while the pending-valve in-memory lock still arms on command — so a single UI
  click can block further valve commands until process restart.
- `systemd RestartSec=600` means a GUI crash takes the backend down for a 10-minute outage window
  (the two processes are coupled at the supervisor level even though they communicate over an
  internal API).

## 4. Integration challenges (OSI OS / OSI Server)

- **Placement decision is the biggest one.** Agroscope is a single central process (ingest →
  process → actuate in one tick, SQLite as the de facto mutex). OSI is split: edge (Node-RED /
  SQLite, canonical for `dendro_daily`, actuates STREGA) versus cloud (osi-server / Spring /
  Postgres, home of v6 analytics). A closed-loop PID that actuates and needs next-day feedback maps
  most naturally onto the **edge** — consistent with OSI's existing
  `agroscope-dendrometer-controller.md` draft, which already posited an edge-authoritative
  dendrometer controller. But v6 runs cloud-side, and a side-by-side comparison is a stated goal.
  This needs a decision: run the Agroscope port where it can actuate (edge), mirroring its
  decisions to cloud for comparison against v6; or run both cloud-side in shadow mode (no
  actuation) first, to compare before committing to an actuation path.
- **Scheduler semantics differ.** osi-server uses Spring `@Scheduled` cron; osi-os uses Node-RED
  inject/cron nodes. Neither reproduces APScheduler's drop-no-catch-up semantics — do **not** copy
  Agroscope's fragile after-ingestion hour-gate. Instead, key the daily run off a persisted
  last-run date plus an explicit data-freshness gate. (This is also a v6 improvement — see below.)
- **Multi-timezone support.** Agroscope hardcodes 03:00 CET. OSI spans Uganda (equatorial) and
  Switzerland, so any ported cutoff must be per-zone. OSI is already better positioned here: v6
  already handles per-zone timezones via zone lat/long (SolarWindows). This is a mild challenge and
  an area where OSI's design already exceeds Agroscope's.
- **In-process coordination must be re-expressed on OSI's durable infra, not ported
  line-by-line.** Agroscope's `control_queue`, pending-valve lock, and valve sequence counter are
  in-memory and crash-lossy. OSI already has durable pending-commands REST polling (30s), a sync
  outbox/inbox, and command leasing. These Agroscope mechanisms need to be mapped onto those
  primitives — a genuine mapping effort, not a copy, but the destination is materially safer.
- **Data model additions.** Agroscope's `DailySensorParameters` and `DendroPIDStates` (keyed by
  user/sector/date) correspond to OSI's per-zone/date model. New, additive PID-state tables are
  needed on whichever side ends up hosting the controller.
- **APScheduler skip-semantics vs. Quartz/Spring defaults.** APScheduler's "skip — never queue,
  never catch up" behavior is load-bearing in the source system and differs from Quartz/Spring
  `@Scheduled` misfire defaults. A naive port changes which days actuate; this needs to be an
  explicit design decision in OSI, not an accidental side effect of switching schedulers.
- **No completion marker to key a split pipeline on.** Agroscope's gate is "local hour == 3,
  measured after ingestion happened to run" — not "run at 03:00." If OSI splits ingestion and
  control into separate jobs/services (likely, given the edge/cloud split), there needs to be an
  explicit DB-backed ingestion-completion marker to replace this implicit ordering.
- **SQLite as hidden global mutex.** Agroscope's correctness partly depends on SQLite serializing
  all writers. Porting to Postgres (cloud) or even to OSI's edge SQLite usage (which is already
  more disciplined) enables interleavings that were previously impossible — the port must add
  explicit concurrency control rather than relying on an accidental one.

## 5. OSI v6 improvement ideas

- **Persisted run state and freshness gating.** v6's `DendroScheduler` is itself a plain daily cron
  with no persisted last-successful-run marker, no data-freshness precondition, and no missed-run
  reconciliation. Agroscope's failure modes (silent daily-run loss, stale-data actuation) are a
  cautionary tale that applies equally to v6. Add: a persisted per-zone "last successful analytics
  date," a freshness gate (skip or flag if the latest ingested day is stale), and startup/missed-run
  reconciliation logic. OSI can do better than both systems here.
- **Health/observability.** v6 should expose per-zone last-run timestamp and data freshness so a
  missed daily run is externally detectable. Agroscope's `/api/health` can report a healthy runtime
  even when initialization partially failed — v6 should not repeat that pattern; health checks
  should verify the state they claim to report, not just that the process is up.

## 6. Re-implementation complexity

**Rating: MEDIUM.**

The mechanism itself is small — one cron job, one hour-gate, a sequential pipeline. What makes a
faithful port non-trivial is everything the mechanism is quietly leaning on:

- Un-spec'd temporal semantics (three time domains, an hour-gate that assumes same-tick ingestion
  ordering rather than a real completion marker).
- An implicit concurrency contract (SQLite-as-mutex, GIL-assisted correctness) that does not
  survive a move to Postgres or a split edge/cloud architecture.
- Hidden multi-plane in-memory state (`control_queue`, pending-valve lock, sequence counter) that
  is crash-lossy today and resists being split across services or processes.

A line-by-line port would reproduce Agroscope's silent-failure modes. A faithful *behavioral* port
requires re-deriving the intended semantics (daily run, ingest-before-process ordering,
single-flight valve commands) and re-expressing them on OSI's durable primitives — which is where
the real effort lives.
