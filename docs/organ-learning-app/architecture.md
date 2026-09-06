# PocketMaestro: technical architecture (draft 0.3)

Companion to [spec.md](spec.md), rewritten after the adjudicated panel
review (panel items cited as "item n"). Fixes what the phase 0 spike builds
against: module layout, the content pipeline and package format, the local
database, the scoring pipeline, the adaptivity engine, the console emulator
and recorded fixtures, rendering, screens, commerce, build order, and
testing. The launch has no user accounts and no server holding learner
state (spec D-38, D-41).

## 1. System overview

```
Phone (Android; iOS verified in spike)          Server side
+-----------------------------------+
| React Native app (Expo)           |            +---------------------------+
|  screens, navigation              |   HTTPS    | Object storage + CDN (CH) |
|  pre-rendered SVG via Skia        |<---------->|  catalogue.json           |
|  cursor overlay from timemap      |  downloads |  <piece>.zip + .sig       |
|  audio: wavetable + convolution   |            +---------------------------+
|  MIDI: in-house Kotlin module     |   HTTPS    +---------------------------+
|-----------------------------------|  opt-in    | Telemetry endpoint        |
| engine packages (pure TS)         |  beta rows | (serverless, anonymous)   |
|  content-schema / scoring /       |            +---------------------------+
|  adaptivity                       |   link     +---------------------------+
|-----------------------------------|----------->| Hosted scheduler (tutor)  |
| SQLite (expo-sqlite + Drizzle)    |            | external service, no code |
|  + Android Auto Backup            |            +---------------------------+
+-----------------------------------+
Workstation: MuseScore -> CLI (MEI + SVG + timemap) -> annotation tool -> signed zip
```

Nothing server-side knows a learner exists. Billing is RevenueCat anonymous
IDs over Play; tutoring is a link to an external scheduler (item and
decision D-41); telemetry is opt-in, anonymous, and beta-focused (item 38).

## 2. Monorepo layout

| Package | Contents |
|---|---|
| `packages/content-schema` | Zod schemas for package, catalogue, annotations (touch categories, pedaling layers, metrical/free flags, voice weights); validation and signature check. |
| `packages/scoring` | Expansion, part split, cluster alignment, tempo fit, metrics. Pure functions. |
| `packages/adaptivity` | Cells, mastery, regimes, scheduler, calibration. Pure functions; constants as OTA-updatable data. |
| `packages/midi-android` | Expo Module in Kotlin over android.media.midi: native timestamps, batched JSI delivery, config plugin for uses-feature, USB intent filter + device_filter.xml, Bluetooth runtime permissions. A CoreMIDI twin follows at the port. |
| `apps/mobile` | The Expo app. |
| `apps/content` | The CLI (MusicXML -> MEI + pre-rendered SVG + timemap, via Verovio in Node/browser where WASM works) and the annotation tool (Vite, local-only): sections, tags, pedaling layers, alignment check, signed export. Nothing hosted. |

There is no booking service and no Postgres (item, D-41). MIDI fixtures —
recorded on the real console from week 1, emulator-generated for adaptivity
— live in the repo and run in CI.

## 3. Lesson package format

```
bwv639/
  manifest.json        id, version, per-section revision hashes, source
                       edition + date + plate, target tempo ranges, file
                       hashes, key_id
  score.mei            the edition; part labels, both pedaling layers,
                       touch categories, ornament spans as editorial layers
  render/<width>.svg   pre-rendered systems at fixed widths (portrait and
                       landscape sets)
  timemap.json         per-note {noteId, x, y, staff, beat} + system breaks
  sections.json        bar ranges, names, metrical|free flag, tempo range,
                       recovery points
  annotations.json     per-bar tags: texture, pedal demands per axis,
                       manual changes, ornaments, voice count + weights,
                       technique tag, rate-dependent flag
  exercises.json       authored exercise pins (engine may generate more)
  reference.mid        the complete take (the reference); sectional takes
                       as separate, clearly non-reference files
  reference.m4a        audio of the same complete take
  commentary.de.md / commentary.en.md
  achievements.json
bwv639.zip.sig         detached ed25519 signature over the zip bytes
bwv639.manifest.json   detached manifest copy for pre-download inspection
```

Verification order: signature over the raw zip bytes first, then
extraction with zip-slip path checks, then per-file hash checks (streaming
native SHA-256 via react-native-quick-crypto; native unzip). Two publishing
keys are pinned (current and next), selected by `key_id` (item 40). The
free lesson ships in the app binary in the same format.

## 4. Local database

SQLite via Drizzle; ULIDs; integer millisecond timestamps; `PRAGMA
journal_mode=WAL` and `foreign_keys=ON` set explicitly (item 42).

| Table | Key columns |
|---|---|
| `lessons` | id, package_version, installed_at, mode |
| `cell_state` | lesson_id, section_id, part_config, status, regime, secured_days, probe_due_at, probe_interval_days; PK (lesson_id, section_id, part_config) |
| `attempts` | id, exercise_id, cell ref, started_at, session_attempt_index, difficulty rung, tempo_ratio, input, package_version, scoring_version, thresholds_version |
| `attempt_events` | PK (attempt_id, seq); kind, source, channel, pitch, t_ms. Pruned after 90 days; scores are the durable record. |
| `attempt_scores` | attempt_id, part, pitch (precision + recall + weighted errors/bar), timing (in-band share, evenness, accuracy, stability), articulation (band, consistency, releases), verdict |
| `part_ratings` | attempt_id, part, prediction, rating, delayed_judgment flag |
| `failure_tags` | attempt_id, cause |
| `instruments` | id, name, midi devices + per-source part map, couplers_detected, pedalboard_type, compass, acoustic, make_model |
| `achievements_awarded` | achievement_id, awarded_at; excluded from any state rebuild |
| `practice_days` | date, minutes, sessions |
| `settings` | key, value |

States rebuild from `attempt_scores` + `part_ratings` (append-only), never
across a scoring-version boundary; a section whose package revision hash
changed resets to in-progress with a note. Android Auto Backup covers the
database (WAL checkpointed, sidecars excluded); the share-sheet export
remains as the portable path and future account migration (items 37, 42).

## 5. Scoring pipeline

1. **Expansion.** MEI to expected notes per part: pitch, onset, duration,
   voice weight, touch category, ornament span, repeat structure with
   zero-cost skip arcs at volta boundaries.
2. **Part split.** Events route by (device, channel) through the
   instrument map; coupler echoes (same pitch, onset within ~10 ms, other
   channel) de-duplicate; note-on velocity 0 is note-off; program changes,
   CCs, and active sensing are dropped; velocity is ignored (item 10).
3. **Alignment.** Onset clusters (played events within ~40 ms; expected
   notes by notated onset) aligned per part with semi-global DP banded in
   event-index space (band max(8, 10 % of N)); set matching inside a
   cluster; free deletions at head and tail so false starts don't poison
   the attempt (items 7, 8). Ornament spans match as one item and leave
   the extras count.
4. **Tempo fit.** Robust piecewise fit (median-of-slopes), minimum 12
   matched onsets per knot else a single global tempo, monotone
   constraint; optional second alignment pass in the fitted frame.
5. **Metrics.** Pitch: weighted errors per bar, precision and recall.
   Timing: in-band share (band = fraction of local inter-onset interval,
   ms floor, widened at annotated cadences) plus evenness, tempo accuracy,
   and stability. Articulation: touch-band membership, consistency across
   like figures, repeated-note re-articulation, chord-release synchrony;
   the reference comparison renders as feedback only (items 1, 2, 9).
6. **Free sections** score pitch and order only (item 3).

Fixtures: the golden set is recorded on the real console (week-1 capture
and every visit after), hand-labelled; the emulator's generated takes test
the engine's breadth but never stand in for expansion truth (items 25, 43).

## 6. Adaptivity engine

Governing rule: a guardrail band of realised success — 75-90 % early in a
cell, 65-80 % for consolidation and probes — measured over a sliding
window and corrected explicitly when left. Learning is driven by
structure, not by the band (items 15-21).

- **Mastery** per cell: EMA `m += alpha (o - m)`, alpha 0.35 scored / 0.15
  self-rated; self outcomes pass through the calibration mapping (below)
  before entering, and measured systematic bias is subtracted.
- **Ramp, not estimator**: difficulty steps up after two consecutive
  passes, down after two consecutive fails or never on a learner-marked
  restart; down-steps are suppressed in the session's last minutes and
  after a third consecutive attempt on one cell. No convergence claim.
- **Difficulty ladder**: ordered rungs mixing tempo, span, and part
  combination; tempo floor ~75 % for rate-dependent material; slow work is
  an accuracy drill, not staircase evidence.
- **Regimes**: blocked on first exposure; interleaved rotation over 3-4
  active cells once in progress; random among passed cells. Hard cap of 3
  consecutive attempts per cell.
- **Scheduler order**: tutor-pinned; probes within their budget (<= 25 %
  of session minutes, overflow deferred by predicted recall); open loop
  drills (with failure-cause tags steering the response — a "reading" tag
  gets a slower reveal, not a slower tempo); progress with segmentation
  first, progressive pairing, full texture at passed isolation; the
  interleave guard applies across all of it.
- **Retention probes**: section level, full texture; interval 1 day
  doubling to a 120-day cap, halving on failure; a passed probe feeds
  mastery; part-level decomposition only after a failed section probe; a
  warm-up cell precedes the first probe of a session.
- **Cold start**: nearest-neighbour over the learner's attempts on cells
  sharing annotation tags, else 70 % of target. No skill-trait vector
  (item 22).
- **Calibration**: pre-attempt prediction, post-attempt rating (MIDI users
  too, before their analysis is revealed), delayed judgment at probe time;
  the prediction-outcome gap is shown to the learner and consumed by the
  mapping.
- **Feedback fading** is engine policy: full analysis at first exposure,
  verdict-only with detail on request thereafter, summary every third
  attempt, guess-first tap before the heat map.

Interface unchanged in shape: `nextRecommendation(...)` returning exercise,
difficulty rung, and an i18n reason; `applyAttempt(...)` returning states,
calibration, and events. Every constant lives in one module shipped as
OTA-updatable data (item 38); the beta's blocked-versus-interleaved
experiment is a per-lesson config flag with 7-day delayed retention as its
outcome (item 28).

## 7. Console emulator and recorded fixtures

`MidiSource` has four implementations: `UsbMidiSource`, `BleMidiSource`
(later `RtpMidiSource`), `RecordedMidiSource`, and `EmulatedConsoleSource`.

`RecordedMidiSource` replays captured `(bytes, native_timestamp)` logs; a
hidden capture screen ships in the first dev build so every console visit
mints fixtures (item 43).

`EmulatedConsoleSource` generates takes from a learner model — per-part
skill, onset jitter, tempo drift, pitch slips, miss/extra rates,
independence penalty, fatigue — now extended with a learning rule: per-cell
skill gain from practice, day-scale forgetting, and a spacing term, so CI
can compare scheduling policies and the comparison can fail (item 25). CI
assertions: probe load stays inside its budget share; no cell's difficulty
ratchets monotonically down over a long run; no infinite oscillation; the
attempt cap and session budget hold; and the policy comparison (interleaved
beats blocked on simulated day-30 retention) — model-dependent and labelled
as such. Simulation validates mechanism; the beta experiment validates
pedagogy.

Gate G1 before B2: fixtures re-recorded on the real console at scale, the
channel wizard run against it, couplers exercised, end-to-end latency and
timestamp accuracy measured. The week-1 visit is a preview of G1, not a
replacement.

## 8. Rendering

The content CLI runs Verovio where WASM works (Node/browser) and emits SVG
per system at fixed widths plus the timemap; the app never runs a notation
engine (Hermes has no WebAssembly; item 13). On device, a system is one
Skia `ImageSVG` node; the cursor is a Reanimated overlay driven from the
timemap on the UI thread; the score never re-renders during an attempt.
If Skia's SVG support balks at Verovio output, the CLI emits outline paths
(A-9). Budgets: first system <= 250 ms; zero dropped frames over a 60 s
sweep at 120 Hz; acceptance runs on the Widor and BWV 565 first (item 13).

## 9. Screens

| Area | Screens | Notes |
|---|---|---|
| Today | Recommendation, calendar strip, sessions-per-week goal | One tap into the next exercise. |
| Catalogue | Ladder by grade, lesson detail, downloads, request voting (B3) | Free items marked; teacher-hour anchor at the paywall. |
| Lesson | Map (cells grid with regime and status), orientation reader, registration recipes with audio | |
| Player | Landscape score, cursor, metronome, count-in | Orientation locked, screen kept awake. |
| Analysis | Guess-first tap, prediction vs outcome, verdict line, detail on request, reference playback, recording playback (self-assessed) | |
| Profile | Repertoire list (with "played through cold"), achievements, practice calendar | No skill dashboard. |
| Tutor | One screen: what a session is, the scheduler link, export-before-session hint | External booking (D-41). |
| Setup | Instruments (devices, channels, couplers, pedalboard type, acoustic, make/model), bench-and-posture check, audio offset calibration, backup export/import, language, subscription | Wizard detects couplers and merged channels. |

## 10. Commerce and data paths

- Subscriptions: RevenueCat anonymous IDs over Play Billing; annual
  preselected; founding-member lifetime as a one-time product; offer codes
  carry the institutional tier (D-43, D-46). Cross-platform entitlement
  policy is written down before launch: the email opt-in is the future
  binding point.
- Tutoring: an external scheduler link; no learner data leaves the app for
  it (the learner may share their export by hand). D-41.
- Telemetry: opt-in, beta-oriented; a compact anonymous row per attempt
  (exercise id, versions, difficulty rung, scores, verdict, input type) to
  a single serverless endpoint appending to object storage. No note
  events, no identifiers. Production default off, prompted opt-in.
- Local notifications only (practice reminder, probe due, new lesson
  downloaded); the newsletter list is the sole outbound channel.
- Crash reporting: Sentry, EU region, PII off; OTA JS fixes via EAS Update
  from B1 (item 39).

## 11. Build order

| Phase | Contents | Exit |
|---|---|---|
| Spike (2 wks) | Kotlin MIDI module; console visit with capture screen; pre-rendered SVG proof on the Widor; audio scheduling proof; three days running the app on an iPhone (D-42). | Timestamp test <= 3 ms RMS over 500 note-ons; rendering budgets met; real fixtures in repo; iOS evidence written up. |
| Content pipeline | CLI + annotation tool; free lesson built through them. | BWV 639 package validates, renders, and plays end to end. |
| B1 | Lesson player, self-assessed track with calibration screens, local progress, Auto Backup, Sentry, EAS Update, emulator dev panel. | A tester without MIDI completes the free lesson. |
| G1 | Real-console validation at scale. | Fixture suite green on recorded takes; wizard and couplers verified. |
| B2 | MIDI capture, scoring pipeline, analysis screens, RTP-MIDI, telemetry opt-in, MIDI-user rating capture (calibration study). | Scored attempts on real consoles look right; thresholds tuned OTA. |
| B3 | Adaptivity regimes + experiment flag, four paid lessons + 565 exercise, subscription with founding and institutional tiers, request voting, tablet layout. | Play closed test running in recruited channels; purchase flow passes sandbox. |
| Launch | Play listing (category title, DE+EN), privacy policy, distribution push. | Google Play approved. |
| Port | iOS per the spike's evidence: CoreMIDI twin, accounts and sync, entitlement binding via the email list. | App Store approved. |

## 12. Testing

| Layer | Approach |
|---|---|
| content-schema | Every package validates; a corpus of broken packages fails; per-section revision hashing covered. |
| scoring | Recorded golden fixtures (clean, planted errors, rushed, chords, ornaments, skipped repeat, false start); property test: alignment stable under small jitter; precision and recall both asserted. |
| adaptivity | Learning-rule simulations across learner types; the assertions of section 7; policy comparison. |
| rendering | Golden SVG of the shipped artifacts per width; visual diff on CLI version bumps; device smoke on Widor/565. |
| app | Maestro flows: complete an exercise, rate with prediction, download and verify a package, coupler wizard path. |
| release | Play pre-launch report on each closed-track build. |

## 13. Assumptions

| ID | Assumption |
|---|---|
| A-1 | Recorded fixtures plus the beta calibration study suffice to tune thresholds; emulator data is never used for tuning. |
| A-2 | The consented manual export covers tutor preparation until accounts exist. |
| A-3 | 90-day event pruning with durable scores is acceptable. |
| A-4 | Console cabling: USB-C to the Pixel 8 Pro; C-to-B cable procured in case. |
| A-5 | Auto Backup quota fits the pruned database (verify before B1). |
| A-6 | Skia renders the CLI's SVG (verify in spike; outline-path fallback). |
| A-7 | The serverless telemetry endpoint and newsletter provider meet the Swiss/EU posture. |
