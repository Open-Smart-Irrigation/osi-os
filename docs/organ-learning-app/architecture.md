# PocketMaestro: technical architecture (draft 0.2)

Companion to [spec.md](spec.md), section 14. This document fixes the
structure the phase 0 spike builds against: module layout, lesson package
format, local database schema, the scoring and adaptivity algorithms, the
console emulator that stands in for the organ during development, the screen
map, and the device-local flows for content, subscriptions, and tutor
booking. The launch has no user accounts (spec D-38); everything a learner
produces lives on the device until sync arrives with the iOS port.

## 1. System overview

```
Phone (Android, later iOS)                      Server side (Swiss hosting)
+---------------------------------+
| React Native app (Expo)         |             +--------------------------+
|  screens, navigation            |   HTTPS     | Object storage + CDN     |
|  Verovio (JS) -> SVG score      |<----------->|  catalogue.json          |
|  audio engine (Web Audio RN)    |  downloads  |  lesson packages (.zip)  |
|  MIDI bridge (USB / BLE)        |             +--------------------------+
|---------------------------------|             +--------------------------+
| engine packages (pure TS)       |   HTTPS     | Booking service (Hono)   |
|  content-schema (Zod)           |<----------->|  slots, bookings, Stripe |
|  scoring                        |  booking    |  Postgres                |
|  adaptivity                     |             +--------------------------+
|---------------------------------|             +--------------------------+
| SQLite (expo-sqlite + Drizzle)  |             | Authoring web tool       |
|  attempts, states, profile      |             |  (same content-schema)   |
+---------------------------------+             +--------------------------+
```

Store billing runs through RevenueCat with anonymous app user IDs; no
PocketMaestro account exists at launch. The booking service is the only
server code with learner-facing state, and it holds an email address per
booking, nothing more.

## 2. Monorepo layout

pnpm workspaces, TypeScript everywhere:

| Package | Contents | Depends on |
|---|---|---|
| `packages/content-schema` | Zod schemas and types for the lesson package, catalogue, and difficulty annotations; package validation and signature check. | nothing |
| `packages/scoring` | Score expansion, note alignment, timing and articulation metrics. Pure functions, no I/O. | content-schema |
| `packages/adaptivity` | Skill profile, exercise state machine, selection rules, both modes. Pure functions. | content-schema |
| `apps/mobile` | Expo app: screens, SQLite, MIDI and audio bridges, Verovio rendering, RevenueCat. | all engine packages |
| `apps/authoring` | Vite web app: MusicXML import, sectioning, annotations, alignment, package export, tutor views. | content-schema, scoring |
| `apps/booking-api` | Hono service: tutor slots, bookings, Stripe webhook. | content-schema (shared types only) |

The engine packages compile and test on a laptop with no emulator. MIDI fixtures
(emulator-generated until gate G1, console-recorded after; section 7) are
checked into the repo and every scoring change runs against them in CI.

## 3. Lesson package format

A lesson is one zip, downloaded once, verified, then read from local
storage. The free lesson ships inside the app binary in the same format.

```
bwv639/
  manifest.json        id, version, title, composer, grade, target tempos,
                       file hashes, ed25519 signature over the manifest
  score.mei            the engraved edition, part labels per staff
  sections.json        bar ranges, names, section order, per-section target tempo
  annotations.json     per-bar difficulty tags (texture, pedal, manual changes,
                       ornaments, voice count, technique tag)
  exercises.json       template instantiations the authoring tool pinned
                       (the engine may generate more at runtime)
  reference.mid        the organist's performance, one track per part
  reference.m4a        audio of the same take
  commentary.de.md     orientation text, analysis questions
  commentary.en.md
  achievements.json    per-piece achievements: id, name, condition
```

The app pins the publishing public key; a package whose manifest signature
or file hashes fail verification is discarded. `catalogue.json` on the CDN
lists id, version, grade, size, and price tier per lesson; the app compares
versions to offer updates. Nothing in the content path is dynamic, so the
whole content side is static files behind a CDN.

## 4. Local database schema

SQLite via Drizzle. IDs are ULIDs generated on device so rows merge cleanly
when sync arrives later. Times are stored as UTC ISO strings.

| Table | Columns (abridged) |
|---|---|
| `lessons` | id, package_version, installed_at, mode (guided or self_directed) |
| `section_state` | lesson_id, section_id, status (untried, in_progress, passed, secured), secured_days_count, last_probe_at, probe_interval_days |
| `exercise_state` | lesson_id, exercise_id, status, best_tempo_ratio, fail_streak, pinned_by_tutor |
| `attempts` | id, exercise_id, started_at, tempo_ratio, input (midi or self), duration_s |
| `attempt_events` | attempt_id, seq, kind (note_on, note_off), channel, pitch, t_ms — MIDI attempts only, pruned after 90 days keeping derived scores |
| `attempt_scores` | attempt_id, part, pitch_score, timing_score, articulation_score, verdict |
| `part_ratings` | attempt_id, part, rating (not_yet, mostly, secure) — self-assessed track |
| `skill_profile` | dimension, value, confidence, evidence_count, updated_at |
| `instruments` | id, name, midi_capable, channel_map (JSON), created_at |
| `achievements_awarded` | achievement_id, awarded_at, lesson_id nullable |
| `practice_days` | date, minutes |
| `settings` | key, value |

Attempts are append-only; states are derived and rebuildable from attempts
plus package data, which keeps the future sync design simple (upload
attempts, recompute states).

### 4.1 Backup before sync exists

Device-local progress dies with the phone, so the settings screen offers a
backup export: a zip of the attempt, rating, profile, and achievement tables
plus a schema version, written through the system share sheet. Import merges
by ULID and never overwrites newer rows. This is loss protection, not sync;
it is also the migration path into accounts when they arrive (A-1).

## 5. Scoring pipeline

Runs after the attempt ends, on device, in the `scoring` package.

1. **Expansion.** The MEI for the exercise's bars is expanded to an expected
   note list per part: pitch, onset in beats, duration in beats, staff, and
   flags for ornaments (matched leniently: any of the ornament's realisations
   accepts) and repeats (unfolded).
2. **Part split.** Played events are routed to parts by MIDI channel using
   the instrument's channel map. A merged-channel instrument routes
   everything to one stream and only single-part exercises are scored.
3. **Alignment.** Per part, expected and played notes are aligned with
   windowed dynamic programming, cost = pitch distance plus onset distance,
   window ±2 beats around the metronome grid. Output per expected note:
   matched (with onset error), missed, or wrong pitch; unmatched played
   notes are extras. This is edit-distance alignment, not audio DTW; inputs
   are discrete events, so the window keeps it linear in practice.
4. **Tempo fit.** A local tempo curve is fitted over matched onsets
   (piecewise linear, one knot per two bars). Timing errors are residuals
   against the fitted curve, so a steady learner who drifts slow is scored
   on evenness at the exercise's nominal tempo separately from drift.
5. **Metrics.** Pitch score = matched / expected, with pedal wrong notes
   reported separately. Timing score = share of onsets within the tolerance
   band. Articulation, on legato-scored passages: for each note pair, gap or
   overlap as a fraction of the inter-onset interval, compared to the same
   figure measured from `reference.mid`; the score is the share of pairs
   within the tolerance band around the reference value.
6. **Verdict.** Scores against the pass thresholds (spec 5.3) produce the
   attempt verdict; the adaptivity engine consumes verdict plus raw metrics.

Fixtures: each catalogue piece carries a clean take, a take with planted
wrong notes, and a rushed take. Until the console is available these come
from the emulator with fixed seeds (section 7); gate G1 replaces them with
takes recorded on the real instrument. Expected verdicts are asserted in CI.

## 6. Adaptivity engine (D-40)

One target governs the engine: keep each learner where roughly three
attempts in four succeed. Below that band practice discourages; far above
it, nothing is being stretched. Everything else is three small mechanisms, a
mastery estimate, a tempo staircase, and a scheduler, plus spaced retention
probes. Each is a few lines of arithmetic, testable alone, and explainable
to the learner in one sentence.

A cell is one section crossed with one part configuration (pedal alone,
RH plus pedal, full texture, and so on). Cells are the unit of progress: the
spec's state machine (untried, in progress, passed, secured) runs per cell,
driven by attempt verdicts. Mastery, below, is the continuous estimate that
drives selection and prediction; verdicts, not mastery, change status.

### 6.1 Mastery estimate

Each cell holds mastery `m` in [0, 1], updated after every attempt by an
exponential moving average, `m += alpha * (outcome - m)`. The outcome of a
scored attempt is the mean of the three dimension scores, each rescaled so
its pass threshold lands at 0.75; a self-assessed attempt maps not yet to 0,
mostly to 0.6, secure to 1.0, averaged over the rated parts. `alpha` is 0.35
for scored evidence and 0.15 for self-rated, which is the whole of the
"self-reports count less" policy.

### 6.2 Pace: a tempo staircase per cell

The tempo ratio moves up one step after two consecutive passes at the
current tempo and down one step after a single fail. This is the two-down
one-up staircase from psychophysics; it settles by itself at the tempo where
about 71 % of attempts succeed, inside the target band, with no learner
model needed. The step is 4 % of target tempo, halved while the profile
confidence behind the cell is low and never below 1 %. The staircase stops
at target tempo; securing is then the state machine's business (pass
thresholds on separate days, spec 5.3).

Draft 0.5 and earlier had this rule inverted (up after one pass, down after
two fails). That variant equilibrates near 38 % success, which would grind
learners down; the fix is recorded here deliberately because the two rules
look interchangeable and are not.

### 6.3 Scheduler: which cell, which template

Ordered rules; the first rule that yields a candidate wins, ties broken by
the largest gap between target and mastery:

1. Tutor-pinned exercises not yet passed.
2. Retention probes due: each secured cell carries an interval that starts
   at one day, doubles on a passed probe, halves on a failed one, and is
   capped at 21 days. A failed probe returns the cell to in progress.
3. Open loop drills: a fail streak of three on the same bars spawns a drill
   on exactly those bars, with the technique card attached.
4. Progress: the section with the largest tempo gap, and inside it the
   least combined part configuration whose prerequisites are secure
   (isolation before pairing, pairing before full texture).
5. Variety guard, applied to whatever the rules above produced: the same
   template never runs more than twice in a row, and a session touches at
   least two sections when the lesson has them.

The session budget closes the loop: exercises carry a time estimate (loop
count times passage length), and the engine stops recommending when the
budget is spent. Guided mode executes the top choice; self-directed mode
renders the same ranking as the highlighted recommendation on the map.

### 6.4 Cold start and the skill profile

The skill profile is nine dimensions (spec 6.1), each an EMA in [0, 1] with
a confidence that saturates at 20 evidence points (a scored attempt adds 1,
a self-rating 0.4). After every attempt, each dimension tagged by the
exercise's annotations moves toward the outcome with a small rate (0.1).

An untried cell's starting mastery is predicted from the profile: for each
dimension the cell's annotations tag, take demand times (1 minus skill),
average, and subtract from 1. The staircase starts at whichever is higher,
60 % of target tempo or the tempo this prediction suggests. The prediction
is corrected by real attempts within a handful of tries; its only job is to
spare a strong learner the crawl through material below them, and a weak
learner the first-attempt faceplant.

### 6.5 Constants and interface

Every tunable lives in one constants module, so beta tuning is a data
change:

| Constant | Default |
|---|---|
| alpha scored / self | 0.35 / 0.15 |
| Staircase step / floor | 4 % / 1 % of target tempo |
| Target success band | 60 to 85 % |
| Probe interval start / cap | 1 day / 21 days |
| Loop-drill fail streak | 3 |
| Template repeat cap | 2 |
| Evidence saturation | 20 points |
| Session budget | 30 minutes |

The engine is two pure functions plus an event stream:

```ts
nextRecommendation(lesson, states, profile, mode, budget, today)
  -> { exercise, tempoRatio, reason }   // reason: i18n key + params
applyAttempt(attempt, scoresOrRatings, states, profile)
  -> { states, profile, events }        // secured, achievement, drill, probe
```

Every recommendation carries its reason as an i18n key ("two passes at 66,
stepping to 69"), which keeps the engine honest: a rule that cannot state
its reason in one sentence does not belong in it.

## 7. Console emulator (D-39)

No organ stands next to the development machine, so the app reads MIDI
through a `MidiSource` interface with three implementations: `UsbMidiSource`,
`BleMidiSource`, and `EmulatedConsoleSource`. The emulator sits behind a dev
flag and generates a performance of the current exercise from its expected
notes and a learner model, streamed in real time on the phone or
faster-than-real-time in engine tests.

| Learner-model parameter | Effect on the generated take |
|---|---|
| Skill per part (0 to 1) | Scales all error rates for that part |
| Onset jitter | Gaussian noise on note onsets, in ms |
| Tempo drift | Slow ramp of the local tempo across the take |
| Pitch slip rate | Substitution by a neighbouring key |
| Miss and extra rates | Dropped and inserted notes |
| Independence penalty | Error rates multiplied when parts are combined |
| Fatigue | Error rates grow over the attempt's duration |

Fixed seeds make every take reproducible. One generator therefore feeds
three consumers: the scoring fixtures in CI, the simulated learners that
exercise the adaptivity engine, and a dev panel on the phone that plays a
chosen learner model into the live exercise so screens can be built and
demonstrated without an instrument.

What the emulator cannot test: USB host behaviour, Bluetooth pairing,
transport timestamp quality, the channel wizard against a real instrument,
and audio latency at the console. Gate G1 sits between betas B1 and B2 for
exactly this list: re-record the scoring fixtures on the real console, run
the channel wizard against it, and measure end-to-end latency. B2 does not
reach MIDI testers before G1 passes.

## 8. Screen map

| Area | Screens | Notes |
|---|---|---|
| Today | practice home: next recommendation, calendar strip, streaks-free minutes total | Entry point; one tap into the recommended exercise. |
| Catalogue | lesson list by grade, lesson detail (orientation, sections, demands for your profile), download manager | Free lesson marked; locked lessons show the paywall. |
| Lesson | lesson map (sections × part configurations grid), orientation reader, commentary | Map is the self-directed mode's main surface. |
| Player | exercise player (landscape score, cursor, metronome controls), pre-roll count-in | Portrait allowed for reading; playing defaults to landscape. |
| Analysis | post-attempt: heat map, timing plot, articulation view, reference comparison, per-part rating entry | Rating entry is the whole analysis screen on the self-assessed track. |
| Profile | repertoire list, achievements, skill profile view, practice calendar | Repertoire list styled as a concert programme. |
| Tutor | slot calendar, booking form (email), my bookings | Works without account; bookings keyed by email plus a booking code. |
| Setup | instrument profiles, MIDI channel confirmation wizard, audio output choice, backup export/import, language, subscription management | Wizard flags merged-channel instruments. |

Navigation: bottom tabs (Today, Catalogue, Profile) plus stack flows for
lesson → player → analysis. The player locks orientation and keeps the
screen awake.

## 9. Device-local commerce and booking

- **Subscription.** RevenueCat anonymous app user ID, Play Billing
  underneath. Entitlement state is cached locally with a 14-day offline
  grace period. "Restore purchases" covers reinstall on the same Google
  account. No email, no password.
- **Tutor booking.** The app fetches open slots from the booking service,
  posts a booking with an email address and the chosen lesson, and hands the
  learner to Stripe Checkout in a browser tab. The Stripe webhook confirms
  the booking; confirmation and the video link go to the email. The tutor
  manages slots and sees booking context in the authoring tool. Because
  attempts live on the device only, the learner's app uploads a snapshot
  (lesson map, profile, last attempt summaries) at booking time, with
  consent shown in the flow — this is the one place learner data leaves the
  phone at launch (A-2).
- **Kill switch for scope creep.** Nothing else on the server knows the
  learner exists. Push notifications, analytics, and remote config are all
  absent at launch.

## 10. Beta-first build order

The spec's phase plan collapsed into three beta milestones (spec D-37 asked
for beta as soon as possible):

| Beta | Ships | Learners get |
|---|---|---|
| B1 | Spike results, lesson player, free lesson (BWV 639), self-assessed track, local progress | The full learning loop without scoring; runs for every tester regardless of MIDI. |
| B2 | MIDI capture, scoring pipeline, analysis screens | Scored track for connected testers; thresholds tuned on their data. |
| B3 | Adaptivity in both modes, six lessons, subscription, booking | The launch product. Google's 14-day closed test requirement is satisfied inside this sequence. |

B1 needs neither the booking service nor RevenueCat, so the first testable
build is the app plus static content alone, developed entirely against the
emulated console. Gate G1 (section 7) stands between B1 and B2.

## 11. Testing strategy

| Layer | Approach |
|---|---|
| content-schema | Every catalogue package validates in CI; a corpus of broken packages must fail. |
| scoring | Fixture takes with asserted verdicts (section 5); property test that alignment is stable under small onset jitter. |
| adaptivity | Simulated learners built from the emulator's error model (able, slow, erratic, self-assessed-only) run through whole lessons; assertions: success rate lands in the 60 to 85 % band after warm-up, time-to-secure falls as ability rises, every unlocked cell is eventually reached, the budget is respected. |
| rendering | Golden SVG snapshots per piece per orientation from Verovio; diffs reviewed on version bumps. |
| app | Maestro flows for the core loops (complete an exercise, rate an attempt, download a lesson); run on a Pixel 8 Pro profile in CI. |
| booking | Contract tests against a Stripe test account. |

## 12. Assumptions

| ID | Assumption |
|---|---|
| A-1 | Backup export/import is acceptable loss protection until sync arrives with iOS. |
| A-2 | Uploading a progress snapshot at tutor-booking time, with consent in the flow, is acceptable. |
| A-3 | Attempt event pruning after 90 days (scores kept) is acceptable. |
| A-4 | The console connects to the Pixel 8 Pro by USB-C cable; if the console exposes USB-B, a C-to-B cable suffices, no OTG adapter (D-35). |
| A-5 | Emulator-generated fixtures are adequate until gate G1; scoring thresholds are only tuned on real-console data. |
