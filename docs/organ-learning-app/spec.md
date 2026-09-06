# PocketMaestro: product specification (draft 0.7)

Status: consolidated after four interview rounds and the adjudicated expert
panel of 2026-09-06. Decisions carry `D-n` (section 18); the panel's adopted
changes are folded into every section below, with the panel record in
[panel-review-2026-09-06.md](panel-review-2026-09-06.md). Companions:
[catalogue.md](catalogue.md) (launch ladder, grading, licensing) and
[architecture.md](architecture.md) (algorithms, data, build order). The spec
is ready to freeze for the phase 0 spike.

## 1. Summary

PocketMaestro is a phone-first mobile app that teaches organ playing through
complete classical pieces. One lesson is one piece; each lesson is a set of
short exercises the app selects and scales from the learner's measured or
self-reported progress. The audience is adult classical music enthusiasts
who already play a keyboard instrument and read music. The app works on any
organ: MIDI scoring is the upgrade, per-part self-assessment with ear
training is the first-class alternative, and the share of learners who can
connect MIDI is an assumption to be measured, not a given (A-2).

It launches on Android (Pixel 8 Pro is the test device); the spike verifies
the same code on an iPhone so the iOS decision is made on evidence (D-42).
The launch is device-local: no accounts, progress on the phone with Android
Auto Backup behind it, sync arriving with the iOS release (D-38). The free
lesson is free forever; the subscription is CHF 15 monthly or CHF 96
annually, anchored against the price of a teacher's hour (D-43). Tutoring is
offered through a hosted scheduler at CHF 150 for 90 minutes (D-41). The
founder-organist builds alone with AI assistance at 20 hours per week, four
of which belong permanently to distribution (D-45). Piano is not part of
this product (D-14).

## 2. Target users

Primary persona: an adult amateur with several years of keyboard experience,
either a pianist moving to the organ or a church organist who learned
informally and wants structured technique. They read staff notation
fluently, know the repertoire by ear, and lose patience with content that
talks down to them. Their instruments split three ways: digital home organs
(the reliable MIDI segment), pipe or older electronic instruments with no
data output (the self-assessed segment), and virtual organs (Hauptwerk,
GrandOrgue) whose MIDI is already cabled into a computer — reachable over
network MIDI, which is in scope for B2 (D-40 panel item 12).

Every learner already plays a keyboard instrument (D-2). Pedal technique is
not assumed; the ladder now has a true first rung (catalogue.md) and the
free lesson carries a pedal-orientation on-ramp. Not targeted: children,
non-readers, conservatory students on a teacher-led syllabus.

## 3. Product principles

1. Repertoire first. Technique is taught because a specific bar of a
   specific piece needs it. The one licensed exception is the pedal
   orientation on-ramp, which draws its notes from the piece's own pedal
   line.
2. Scholarly register. Sources follow a declared hierarchy (autograph or
   composer-supervised print first); editorial layers are marked and
   argued; commentary at the level of a good edition's preface, including
   the uncomfortable parts (BWV 565's attribution).
3. Adaptive with a choice of control: guided or self-directed, per lesson.
4. Feedback after the attempt, and fading. While playing, the screen is a
   score and a cursor. Afterwards, full analysis on first exposure, then a
   one-line verdict with detail on request — the learner's own judgment is
   asked for before the machine's is shown.
5. Instrument-agnostic and honest about instruments. Registration is
   taught as families, couplers, box, and tremulant, with concrete recipes
   per instrument archetype; the app knows the learner's pedalboard type
   and room acoustic and adapts what it shows and expects.
6. Works on any organ. The self-assessed track is a complete product, not
   a fallback: ratings with behavioural anchors, ear calibration, and
   recording playback.
7. Works offline. Downloaded lessons need no network.
8. Motivation in musical terms. A sessions-per-week goal, milestones, and
   achievements awarded quietly after the fact — never dangled in advance.

## 4. Domain model

| Entity | Definition |
|---|---|
| Piece | A musical work in a fixed in-house edition: composer, title, catalogue number, exact source (edition, date, plate), duration, difficulty profile. |
| Lesson | The learning unit built on one piece: adaptive exercises plus orientation material (commentary, reference performance, registration recipes, analysis). |
| Section | A contiguous span of bars with a musical identity, flagged metrical or free. Exercises target sections. |
| Cell | One section crossed with one part configuration. The unit of progress; the state machine (untried, in progress, passed, secured) runs per cell. |
| Exercise | One task instantiated from a template with a difficulty setting (tempo, span, parts). |
| Attempt | One recorded performance: note events and derived scores (MIDI track) or per-part ratings with a pre-attempt prediction (self-assessed track), plus the package and scoring versions in force. |
| Instrument profile | The learner's instruments: MIDI devices and channel map, couplers detected, pedalboard type, compass, acoustic (dry / church / very live), console make and model. |
| Curriculum | The graded ladder over the catalogue with a recommended next lesson; the learner may pick any lesson. |

The nine-dimension skill profile from earlier drafts is cut (panel item 22).
Cold-start prediction is a nearest-neighbour over the learner's own attempt
history on cells sharing annotation tags; there is no trait vector and no
skill dashboard.

## 5. Lesson structure

### 5.1 Orientation

- Piece overview: composer, date, context, form outline with a tappable bar
  map, and the source-critical notes the edition rests on.
- Reference performance: the organist's complete take, captured as MIDI and
  audio in one session (D-26). The complete take is the interpretive and
  tempo reference; sectional takes are practice aids only.
- Registration: three concrete recipes (small two-manual, neo-baroque
  tracker, romantic three-manual with box), each with a short audio demo,
  plus couplers, box, tremulant, a change timeline (which bar, which hand
  or foot is free), and a balance procedure.
- Technical preview: the bars flagged for this learner and why, and which
  pedaling layer (alternate-toe or heel-toe) the app will show, given the
  declared pedalboard and the piece's style.

### 5.2 Exercise templates

| Template | Task | Self-assessed scoring |
|---|---|---|
| Segment | A short span (2 to 4 bars), all parts, reduced tempo. The primary simplification. | Rating per part |
| Part isolation | One part of a section; the app sounds or mutes the others. | Rating for that part |
| Progressive pairing | Parts added cumulatively: RH+pedal, LH+pedal, then all. | Rating per part |
| Full texture | All parts at the engine's difficulty setting. Unlocks when isolation has passed (not secured), and a short full-texture segment appears early in every section regardless. | Rating per part plus metronome tempo |
| Loop drill | Two to eight bars repeated, difficulty ramped; spawned by fail streaks, with one-tap failure-cause tags (wrong note / coordination / reading / fingering-pedaling / tempo) steering the engine's response. | Rating per part per step |
| Pedal technique | Pedal line alone in the selected pedaling layer; includes the on-ramp (the line's own notes as a slow ladder, played without looking). | Pedal rating |
| Articulation | Touch-category work: play the passage in its authored touch (legato / ordinary / detached / staccato); scored as band membership, consistency across like figures, and release behaviour. | Listening comparison, rating |
| Manual change | Passages with manual switches; note channel checked against the expected manual. | Rating per part |
| Continuity | Cold-start play-through without stopping; a stop or restart fails; recovery points every two bars. Feeds the repertoire list's "played through cold" column. | Pass/fail self-report |
| Listening and analysis | Answer-key tasks: subject entries, cadences, registration comparison, and ear-calibration A/B items (which take has the late pedal, the ragged release?). | Answer key |

Sight reading and progressive score-hiding are gone from lessons (panel
items 32 and 33); score-hiding survives only as an opt-in variant of
Continuity.

### 5.3 Pass conditions

Scored track, per attempt, thresholds tunable over the air (A-1):

| Dimension | Measure | Pass shape |
|---|---|---|
| Pitch | Errors per bar, weighted by voice role (subject and cantus entries weigh more than filler voices); precision and recall both reported. | At most one weighted error per N bars; wrong pedal notes scaled by passage length, never a single-note kill switch. |
| Timing | Onset deviation as a fraction of the local inter-onset interval, floored in ms, widened at annotated cadences and phrase ends; three steadiness figures (evenness, tempo accuracy, stability). | Share of onsets in band at the difficulty setting. |
| Articulation | Membership in the authored touch band; consistency across like figures; releases (repeated notes re-articulated, chord releases synchronous). Reference comparison is feedback, never the gate. | Band and consistency shares. |

Free sections score pitch and order only. Self-assessed track: per-part
ratings on behavioural anchors ("stopped or corrected at least once" /
"played through, some unevenness" / "played through twice at this tempo
with no stop"), a pre-attempt prediction whose gap is shown afterwards, and
a delayed judgment at probe time. MIDI users give the same ratings before
seeing their analysis; the measured gap calibrates the self-assessed track
and any systematic bias is subtracted, not damped. Securing still requires
separate days: two for scored evidence, three for self-rated.

## 6. Adaptivity engine

The engine's governing rule is a guardrail, not an optimum: keep realised
success inside a band of roughly 75 to 90 percent early in a cell, relaxing
to 65 to 80 for consolidation and probes — high enough to build efficacy,
low enough to stretch. Learning itself is driven by structure: practice
regimes (blocked on first exposure, interleaved across three to four active
cells, random among passed cells), a hard cap of three consecutive attempts
per cell, segmentation before fractionation, retrieval through continuity
and probes, and faded feedback. The tempo staircase is documented as a
heuristic ramp — two consecutive passes to step up, two consecutive fails
(or a learner-marked restart) to step down, down-steps suppressed late in a
session — and difficulty is a short ordered ladder mixing tempo, span, and
part combination rather than tempo alone. Retention probes run at section
level within a quarter of the session budget, on intervals that can grow to
months. The full algorithm, constants, and interfaces are in
[architecture.md](architecture.md) section 6; the closed beta runs one real
blocked-versus-interleaved experiment with delayed retention as the outcome
(panel item 28).

Both control modes survive unchanged: guided executes the engine's choice
with its one-line reason; self-directed renders the same ranking on the
lesson map.

## 7. Instrument input and feedback

### 7.1 Input

| Channel | Support |
|---|---|
| USB MIDI (class compliant) | Android at launch, iOS at the port. Native timestamps required; the spike's exit test is numeric (architecture.md). |
| Bluetooth LE MIDI | Same order; also the charging fallback, since USB host blocks charging. |
| Network MIDI (RTP) | B2, for Hauptwerk and GrandOrgue rigs; until then the setup guide documents a thru path. |
| Microphone | Never for scoring. Recording for playback comparison is a self-assessed-track feature. |
| No connection | The complete self-assessed track. |

The MIDI layer accepts multiple simultaneous devices with per-source part
mapping (a pedalboard on its own port is common), detects couplers in the
setup wizard and de-duplicates their echoes, treats note-on velocity 0 as
note-off, and filters non-note traffic. Velocity is ignored throughout.

### 7.2 During the attempt

Landscape score, one system, metronome-driven cursor, count-in. Nothing
else. Follow-my-playing cursor tracking is deferred past launch (panel item
14). The metronome uses a lookahead audio scheduler; a one-time offset
calibration aligns app audio with the instrument.

### 7.3 After the attempt

First exposure to a cell: full analysis (bar heat map, timing plot,
articulation view, reference overlay). Thereafter: the learner first taps
where they think the errors were and gives their per-part rating, then sees
a one-line verdict, with full detail on request and a summary every third
attempt. Self-assessed track adds recording playback against the reference
with a targeted listening prompt.

### 7.4 Sound

The built-in organ is a wavetable synth per stop family (kilobytes, no
sample-set licence exposure), with an acoustic switch — dry, church, very
live — on both the learner's recorded attempt and the reference, so the
point of articulation is audible. It accompanies, demonstrates
registration recipes, and never pretends to replace the instrument.

## 8. Score rendering

Scores are pre-rendered at authoring time: the content pipeline emits SVG
at a fixed set of widths plus a per-note position table (timemap), and the
app draws the system as a single GPU-composited image with the cursor as an
overlay. No notation engine runs on the phone (Hermes has no WebAssembly;
panel item 13). Exercises are 2 to 16 bars and fit one to three systems;
the full score is a separate pinch-zoom reading view over the same SVG.
Landscape is the playing default (D-21). Rendering NFRs: first system
visible within 250 ms, zero dropped frames during a 60-second cursor sweep
at 120 Hz. The rendering acceptance test runs on the Widor and BWV 565
first, where organ notation is hardest.

## 9. Content pipeline

MuseScore is the source of truth; a CLI turns exported MusicXML into MEI,
pre-rendered SVG, and the timemap; the authoring tool is an annotation
editor over the rendered score (sections, per-bar tags, touch categories,
pedaling layers, alignment check, signed export). It runs on the
workstation; nothing is hosted. Per piece:

1. Source per the hierarchy: autograph or composer-supervised first print;
   19th-century collected editions only where nothing earlier survives;
   Peters never as the engraving source. Exact source, date, and plate go
   into the manifest.
2. Engraving bought or taken from vetted CC0 community typesettings where
   available, else engraved in house; proofread on device.
3. Editorial fingering and two pedaling layers where defensible —
   alternate-toe (early) and heel-toe (modern) — marked as editorial, with
   a paragraph on what each assumes (D-30 panel item; the product's
   signature).
4. Sectioning (metrical or free), difficulty annotations, touch
   categories, per-piece achievements.
5. Commentary in German and English, analysis questions, ornament tables
   (Bach's Explication, the agrement tables) where relevant.
6. Reference recording: the complete take as the reference, MIDI and audio
   together; effort budgeted by grade, not flat.
7. Validation: schema check, every exercise configuration played once, a
   self-assessed walk-through, and the recording session doubles as the
   YouTube film shoot (D-45).

The launch ladder, regraded with a true grade 1, is in
[catalogue.md](catalogue.md): the free lesson (BWV 639, graded honestly),
four paid lessons deep in grades 1 and 2, and the free BWV 565 pedal-solo
exercise as the store-facing demo (D-44).

## 10. Motivation layer

| Element | Behaviour |
|---|---|
| Practice calendar | Days and minutes shown; the learner-set goal is sessions per week, not minutes. No penalty for gaps. |
| Milestones | First section secured, first play-through, lesson complete; dated, shareable as an image. |
| Achievements | General and per-piece (D-25), awarded quietly at session end and framed retrospectively ("you played the pedal solo at 100 on 4 March"). Unearned achievements are never displayed. |
| Repertoire list | Completed lessons with date, tempo reached, and a second column: played through cold (from the Continuity template). Concert-programme layout. |
| Requests | One-tap "I want to learn this" on catalogue entries, feeding the authoring queue from B3 (D-46 context). |

## 11. Brand and visual identity

New brand, explored separately in Claude Design (D-34) across the three
directions of draft 0.3. Two constraints precede design spend: the
trademark search (Swiss IGE and EUIPO) runs first, and the store title
carries the category — "PocketMaestro: Organ", "PocketMaestro – Orgel
lernen" on the German listing (D-47).

## 12. Pricing and access (D-43, D-46)

| Tier | Contents |
|---|---|
| Free | The free lesson complete, the BWV 565 pedal-solo exercise, ear-calibration items. No account, no time limit. |
| Subscription | The whole catalogue and every new lesson. CHF 15 monthly or CHF 96 annually, annual preselected. The anchor, stated in the store listing: less than one hour with an organ teacher, for a year of structured practice. Piece counts never appear in marketing. |
| Founding member | First 150 subscribers: lifetime access, CHF 249, closed publicly when the cap is reached. |
| Institutional seats | CHF 60 per seat per year at ten seats or more, redeemed by offer code — for C-Ausbildung courses, chapters, and church music offices. |
| Tutoring | Per session, outside the stores (section 13). |

Entitlements are cached with a 14-day offline grace period; cancelling
keeps all data and the repertoire list.

## 13. Tutor sessions (D-41)

The offer stays; the infrastructure goes. A button in the app opens a
hosted scheduler (Cal.com class, EU-hosted) with payment attached: CHF 150
for 90 minutes, two slots per week, manually invoiced. The learner shares
their exported progress file before the session if they wish. In-app
booking, the booking service, and the snapshot upload are all deferred
until bookings exceed eight a month — by which time accounts will exist.
The first session's default agenda is stated in onboarding: bench position,
foot geometry, and shoes.

## 14. Distribution (D-45)

Four of the twenty weekly hours belong to distribution, permanently:

- Institutional: Kirchenmusikalische C-Ausbildung courses (Landeskirchen,
  dioceses, Swiss equivalents), GdO, AGO chapters, RCO/IAO — seeded with
  the institutional seat tier.
- One lesson, one film: every reference recording session also produces a
  YouTube video; the app is the call to action under the video.
- The Hauptwerk/GrandOrgue forums and Contrebombarde, from B2 when RTP
  lands.
- Beta testers are recruited inside these channels, not among friends, so
  compliance, seeding, and the first Play reviews are the same act; the
  MIDI-share question (A-2) is asked at recruitment.
- The email list ("tell me when a new lesson ships") is the owned channel
  and the future account-migration hook.

## 15. Technology stack

| Layer | Choice |
|---|---|
| Language | TypeScript monorepo (pnpm workspaces). |
| Mobile client | React Native with Expo (dev client, EAS Build); Android first, the spike verifies iOS. |
| Score display | Pre-rendered SVG via Skia as one composited image; Reanimated cursor overlay from the timemap. No on-device notation engine. |
| MIDI | In-house Expo module in Kotlin over android.media.midi (native timestamps, batched over JSI), with an Expo config plugin for the manifest and permission plumbing; CoreMIDI twin at the port. |
| Audio | react-native-audio-api (Oboe underneath): wavetable organ, convolution acoustic, lookahead metronome. |
| Engines | Pure TS packages: content-schema (Zod), scoring, adaptivity. Tested against recorded console fixtures and simulated learners. |
| Local store | expo-sqlite + Drizzle; WAL and foreign keys on; integer ms timestamps; versioned attempts. Android Auto Backup with WAL checkpointing; manual export kept as the portable migration path. |
| Content delivery | Static: catalogue.json and signed lesson packages on Swiss object storage behind a CDN; detached signatures verified over zip bytes before extraction; two pinned keys. |
| Server code | None with learner state. One serverless endpoint receives anonymous opt-in beta telemetry rows; the engine constants ship as OTA-updatable data (EAS Update) so threshold tuning is a publish, not a release. |
| Subscriptions | RevenueCat anonymous IDs over Play Billing; offer codes carry the institutional tier; founding tier as a one-time product. |
| Crash and release | Sentry (EU region, no PII) and expo-updates from B1; GitHub Actions; weekly builds to the closed track. |
| Notifications and email | Local scheduled notifications only (practice reminder, probe due, new lesson downloaded); newsletter provider with EU/Swiss processing for the opt-in list. |

### 15.1 Legal setup

Week 1: Einzelfirma registration and a D-U-N-S number, so the Play account
is an organization account (keeps the home address off the listing and
gives tutoring a clean invoicing entity); verify the current closed-test
tester rule rather than assuming 12 or 20. Apple's account waits for the
port decision. Tax advice (R-1) is needed before the first paid tutor
session, not before the beta; store subscriptions have Apple and Google as
merchant of record. The revised Swiss DPA applies: privacy policy, export,
deletion; Sentry and RevenueCat named as processors; telemetry is opt-in
and anonymous.

### 15.2 Build order

Spike (2 weeks): MIDI module with the numeric timestamp test, one console
visit with a capture screen (real fixtures, channel and coupler reality,
cabling), pre-rendered SVG proof on the Widor, audio scheduling proof, and
three days verifying the same app on an iPhone (D-42). Then the content
pipeline (CLI plus annotation tool) before B1, because B1's lesson package
depends on it. Betas as in architecture.md section 11: B1 free lesson and
self-assessed track; gate G1; B2 scoring, RTP, telemetry and the
calibration study; B3 adaptivity regimes, subscription with founding and
institutional tiers, request voting, tablet layout. iOS timing is decided
on spike evidence. Working rules unchanged: spec and schema updated before
code, every engine change carries a fixture test, a build reaches the phone
weekly.

## 16. Non-functional requirements

| Requirement | Target |
|---|---|
| Onset timestamp accuracy | <= 3 ms RMS inter-onset deviation (spike-verified) |
| First system visible | <= 250 ms from exercise start |
| Cursor animation | No dropped frames over 60 s at 120 Hz |
| Cold start to cached lesson | <= 3 s |
| Lesson package size | <= 25 MB including reference audio and pre-rendered SVG |
| Offline | All learning features after download |
| Battery | Setup guide covers USB-host charging (powered hub or BLE); a 90-minute session must not exhaust a full battery |
| Accessibility | Dynamic type, screen-reader labels on non-score UI, high-contrast score theme |
| Languages | German and English at launch (D-13) |
| Privacy | No accounts; anonymous opt-in telemetry only; Swiss/EU processing |
| Minimum OS | Android 10 with USB host at launch; iOS 16 at the port |

## 17. Out of scope for the first release

Piano (D-14); user accounts and sync (until iOS); in-app tutor booking and
any learner-state server (D-41); follow-my-playing cursor; microphone
scoring; sight-reading exercises; score-hiding as a default; grade 5 and 6
full lessons (the BWV 565 pedal-solo exercise excepted); console/virtual-
organ registration integration; remote push notifications; social features.

## 18. Decisions

D-1 to D-40 remain as recorded in draft 0.6 except where amended below; the
panel's 47 adopted changes (panel-review section 3) are part of this draft.

| ID | Decision |
|---|---|
| D-41 | Tutoring via hosted scheduler, CHF 150 / 90 min, 2 slots/week, manual invoice; in-app booking deferred until > 8 bookings/month. Supersedes D-19's price/format and D-31. |
| D-42 | Android remains the build platform; the spike verifies iOS on a real device and the port decision follows the evidence; tablet layout lands in B3. Amends D-33. |
| D-43 | CHF 15 monthly / CHF 96 annually, annual preselected, teacher-hour anchor, no piece counts in marketing. Supersedes D-27. |
| D-44 | Launch: free BWV 639 + four paid lessons in grades 1-2 + free BWV 565 pedal-solo exercise. Supersedes D-28's shape. |
| D-45 | Four of twenty weekly hours to distribution; channels as section 14; testers recruited there. Amends D-32's allocation. |
| D-46 | Institutional seat tier (CHF 60/seat/yr, 10+) and founding-member lifetime tier (CHF 249, first 150) ship with B3. |
| D-47 | Name stays PocketMaestro with a category suffix in store titles; trademark search precedes design. Amends D-16/D-24 scope. |
| D-48 | The adjudicated panel changes are adopted as a block; individual items are cited inline as "panel item n". |

## 19. Assumptions

| ID | Assumption |
|---|---|
| A-1 | Pass thresholds and engine constants are placeholders, tuned via opt-in beta telemetry and OTA constants. |
| A-2 | The MIDI-capable share of learners is unknown (was D-1's 60 %); measured at tester recruitment. |
| A-3 | Guided mode is the default for new learners. |
| A-4 | Session budget defaults to 30 minutes. |
| A-5 | Self-rated securing needs three separate days against two for scored. |
| A-6 | Behavioural rating anchors are understandable without a teacher; checked in B1. |
| A-7 | Offline entitlement grace period of 14 days. |
| A-8 | Android Auto Backup's quota accommodates the pruned database; verified before B1 ships. |
| A-9 | Skia renders the pipeline's SVG correctly; verified in the spike (outline-path fallback if not). |
| A-10 | Vetted CC0 community engravings exist for at least part of the launch ladder; licence-checked per piece. |
| A-11 | The hosted scheduler's EU hosting and Stripe terms fit the Swiss posture; checked before B3. |
| A-12 | The current Play closed-test tester rule is verified in week 1. |

## 20. Open items

| ID | Item | Must close before |
|---|---|---|
| R-1 | VAT position for tutoring and the Einzelfirma's invoicing; advisor consult. | First paid tutor session. |
| R-2 | Trademark search on PocketMaestro. | Design spend (D-47). |
| R-3 | The verification list from the panel (assumptions A-8 to A-12). | Their named gates. |
