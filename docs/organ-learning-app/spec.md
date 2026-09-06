# PocketMaestro: product specification (draft 0.2)

Status: brainstorming draft, second round. Section 15 records the decisions
taken in the first interview (`D-n`). Statements marked `A-n` are assumptions
still awaiting confirmation; `Q-n` are open questions for the next round.
This document is unrelated to OSI OS firmware; it lives here because the
brainstorming session ran in this repository.

## 1. Summary

PocketMaestro is a phone-first mobile app (iOS and Android) that teaches
organ playing through complete classical pieces. One lesson is one piece.
Each lesson contains exercises that the app selects and scales from the
learner's measured or self-reported progress. The audience is adult classical
music enthusiasts who already play a keyboard instrument and read music. About
60 % of them can connect their instrument by MIDI (D-1); the other 40 % use
the same lessons with self-assessment instead of automatic scoring. Content is
authored in house by a professional organist from public-domain sources, sold
by subscription, with one-to-one tutor sessions as a premium service. Piano is
not part of this product (D-14).

## 2. Target users

Primary persona: an adult amateur with several years of keyboard experience,
either a pianist moving to the organ or a church organist who learned
informally and wants structured technique. They read staff notation fluently,
know the standard repertoire by ear, and lose patience with content that talks
down to them. Roughly six in ten own or can reach a MIDI-capable instrument:
a digital home organ, a virtual organ (Hauptwerk, GrandOrgue) driven by a MIDI
console, or a MIDI-equipped church console (D-1). The rest practise on pipe
organs or older electronic instruments with no data output.

Every learner already plays a keyboard instrument (D-2). Pedal technique
cannot be assumed; the first lessons in the ladder carry pedal foundations
inside real repertoire (section 9).

Not targeted: children, non-readers, and conservatory students following a
teacher-led syllabus.

## 3. Product principles

1. Repertoire first. Technique is taught because a specific bar of a specific
   piece needs it, never as an abstract drill.
2. Scholarly register. Public-domain urtext sources (D-7), editorial fingering
   and pedaling marked as such, commentary at the level of a good edition
   preface.
3. Adaptive with a choice of control. The learner picks, per lesson, whether
   the app drives the sequence or the learner does with recommendations (D-4).
4. Feedback after the attempt, never during it (D-5). While playing, the screen
   is a score with a cursor and nothing else.
5. Instrument-agnostic. Registration is expressed in generic stop families and
   mapped by the learner once per instrument (D-6). No console integration.
6. Works without MIDI. Every lesson is complete for a learner with no data
   connection to the instrument; scoring is the upgrade, not the entry ticket.
7. Works offline. Downloaded lessons need no network.
8. Motivation in musical terms. Practice calendar, milestones, and achievements
   are in scope (D-15); their language and visuals stay in the register of a
   concert programme, and no mechanic punishes a missed day.

## 4. Domain model

| Entity | Definition |
|---|---|
| Piece | A musical work in a fixed in-house edition: composer, title, catalogue number, source, duration, difficulty profile. |
| Lesson | The learning unit built on one piece. Owns an ordered but adaptive set of exercises plus orientation material (commentary, reference performance, analysis). |
| Section | A contiguous span of bars with a musical identity (exposition, fugue subject entry, pedal solo). Exercises target sections. |
| Exercise | One task with a pass condition: section, parts (RH, LH, pedal, combinations), target tempo, loop count. Instantiated from a template, parameterised by the learner's profile. |
| Attempt | One recorded performance of an exercise. Scored attempts hold note events and derived scores; self-assessed attempts hold the learner's rating and the metronome tempo used. |
| Skill profile | Per-learner vector of capabilities (section 6.1), with a confidence value per dimension that depends on whether evidence is measured or self-reported. |
| Instrument profile | The learner's instruments: MIDI capable or not, manuals, pedalboard compass, registration mapping. |
| Curriculum | A difficulty ladder over the catalogue with a recommended next lesson; the learner may pick any lesson. |
| Tutor session | A booked one-to-one session with a professional tutor, with the tutor's notes and assigned exercises written back into the lesson (section 11). |

## 5. Lesson structure

### 5.1 Orientation

- Piece overview: composer, date, liturgical or concert context, form outline
  with a tappable bar map.
- Reference performance: a commissioned recording by the in-house organist
  captured as MIDI, with audio where the recording instrument allows (D-9).
  The MIDI reference plays through the built-in organ sound or through the
  learner's own instrument (D-10), and it is the reference for tempo and
  articulation in scoring.
- Registration proposal in generic families (principal chorus 8'+4'+2',
  flute 8' on the second manual, pedal 16'+8') with historical rationale.
- Technical preview: the bars the difficulty model flags for this learner,
  and why (pedal crossings, manual changes, thumbing on a held voice).

### 5.2 Exercise templates

| Template | Task | Scoring without MIDI |
|---|---|---|
| Part isolation | One part (RH, LH, pedal) of a section; app sounds or mutes the others. | Self-rating |
| Part pairing | Two of three parts; the organ sequence RH+pedal, LH+pedal, then manuals. | Self-rating |
| Full texture | All parts at a tempo the profile predicts as achievable. | Self-rating plus metronome tempo |
| Loop drill | Two to eight bars repeated, tempo ramped between repetitions. | Self-rating per tempo step |
| Pedal technique | Pedal line alone with heel/toe indications; scored by timing. | Self-rating |
| Legato and articulation | Note overlap and gap scored against the reference performance; on the organ this is the main expressive parameter. | Listening comparison, self-rating |
| Manual change | Passages with manual switches; note channel checked against the expected manual. | Self-rating |
| Sight reading | An unseen section once at a comfortable tempo; scores reading accuracy. | Self-rating |
| Memory | Score hidden progressively. | Self-rating |
| Listening and analysis | Identify subject entries, name the cadence, compare two registrations. | Answer key (identical for both tracks) |

### 5.3 Pass conditions

Scored track, placeholder thresholds to tune with data (A-1):

| Dimension | Pass | Secure |
|---|---|---|
| Pitch | 95 % correct notes, no wrong pedal note | 99 % |
| Timing | 90 % of onsets within ±60 ms at target tempo | 95 % within ±40 ms |
| Articulation | 80 % of scored note pairs within tolerance of the reference | 90 % |

Self-assessed track: a three-step rating after each attempt (not yet, mostly,
secure) plus the metronome tempo the learner used. A rating of "secure" at
target tempo counts as a pass; three such ratings on separate days count as
secure (A-2), against two for the scored track, because self-reports carry
less evidence.

A lesson is complete when every section is secured and the whole piece has
been played through once at tempo, scored above the pass line or self-rated
secure.

## 6. Adaptivity engine

The engine answers one question after every attempt: what should this learner
do next in this lesson? It runs on the device, takes attempt history, skill
profile, and the piece's difficulty annotations, and is a pure library with
unit tests and no network dependency.

### 6.1 Skill profile dimensions (A-3)

| Dimension | Measured from (scored track) | Estimated from (self-assessed track) |
|---|---|---|
| Pedal accuracy | Pitch errors on pedal notes | Ratings on pedal-only exercises |
| Pedal timing | Onset error pedal versus manuals | Ratings on part pairings with pedal |
| Hand independence | Error rise when parts are combined | Rating drop when parts are combined |
| Voice independence | Inner-voice errors in counterpoint | Ratings on contrapuntal sections |
| Legato control | Overlap and gap distribution | Not estimated |
| Manual-change fluency | Timing error around switches | Ratings on manual-change exercises |
| Sight-reading speed | First-attempt accuracy at a note density | First-attempt ratings |
| Tempo ceiling per texture | Highest tempo passed per texture class | Highest metronome tempo rated secure |
| Retention | Score decay on secured sections | Rating decay on secured sections |

Each dimension carries a confidence value. Measured evidence raises it fast;
self-reports raise it slowly. Low confidence makes the engine choose smaller
tempo steps and more retention probes.

### 6.2 Two selection modes (D-4)

Guided mode: the app picks the next exercise and starts it. The learner sees
a one-line reason ("pedal line of bars 17 to 24 failed twice at 72; looping
at 60") and can skip once per exercise.

Self-directed mode: the lesson map shows every section and part
configuration with its status (untried, in progress, passed, secured) and a
highlighted recommendation. The learner taps any cell. The engine still sets
the tempo suggestion and still spawns loop drills on repeated failures, shown
as suggestions rather than started.

The mode is chosen per lesson and can be switched at any time. Default for a
new learner is guided (A-4).

### 6.3 Selection rules (both modes; in self-directed they produce the recommendation)

1. Open each session with a retention probe on the oldest secured section
   (interval doubles on success, halves on failure).
2. Pick the section with the largest gap between predicted and target tempo.
3. Within it, choose the least combined part configuration not yet passed;
   combine only when isolation is secure.
4. Set tempo at the last passed tempo plus one step (default 4 % of target,
   A-5), minus one step after two consecutive failures. Halve the step while
   the relevant confidence is low.
5. After three failures on the same bars, spawn a loop drill on those bars
   and attach the technique card named in the difficulty annotation.
6. Cap the session from the learner's practice budget (default 30 minutes,
   A-6).

### 6.4 Difficulty annotations

Each piece ships with per-bar annotations written during authoring: texture
class, pedal difficulty (crossings, wide leaps, double pedal), manual changes,
ornaments, voice count, and a technique tag. The engine predicts difficulty
for a profile before the first attempt and corrects the prediction from
attempts.

## 7. Instrument input and feedback

### 7.1 Input channels

| Channel | Support |
|---|---|
| USB MIDI (class compliant) | iOS via USB-C or Lightning adapter, Android via USB host. v1. |
| Bluetooth LE MIDI | Both platforms. v1. Latency budget ≤ 20 ms measured; the app warns above. |
| Network MIDI (RTP) | Later; relevant for Hauptwerk on a computer. |
| Microphone | Not for scoring. Polyphonic organ sound in a reverberant room is not reliably transcribable on a phone. |
| No connection (self-assessed track) | Metronome, reference playback, score, self-rating. Full lesson available. |

Pedal and manual notes are told apart by MIDI channel. A guided setup asks
the learner to press one key on each manual and one pedal and stores the
mapping in the instrument profile.

### 7.2 During the attempt

The screen shows the exercise's bars, one system at a time in landscape or
two to three bars per line in portrait (A-7), with a cursor. The cursor is
driven by the metronome by default. MIDI learners can switch to "follow my
playing", where the cursor tracks the matched notes; there is no correctness
colouring in either case (D-5).

### 7.3 After the attempt

- Scored track: a heat map over the bars, a timing plot against the beat
  grid, and, for legato passages, the articulation profile against the
  reference performance. Tapping a bar replays the attempt against the
  reference. The last three attempts can be overlaid.
- Self-assessed track: the rating prompt, the tempo used, and the reference
  playback of the same bars for comparison by ear.
- Both: the engine's next suggestion with its one-line reason.

### 7.4 Sound (D-10)

The app sounds accompanying parts (for example the pedal while the learner
plays manuals) and the reference performance either through a built-in
sampled organ or as MIDI out to the learner's instrument. The built-in set is
small: one principal chorus, one flute, one reed, pedal 16'+8'. It is not a
substitute for the instrument.

## 8. Score rendering, phone first (D-3)

The phone sits on the music desk or beside the console, so the score view is
designed for a 6 to 6.7 inch screen first; tablet layout is a later
enhancement (A-8). Consequences:

- Exercises are short by design (two to sixteen bars), so a phone shows an
  exercise in one to three systems without scrolling during play.
- The full score is a separate reading view with pinch zoom and vertical
  scroll, used for orientation and study, not while playing.
- Landscape shows one wide system; portrait shows narrower systems with
  larger glyphs. The learner's last choice is remembered per lesson.
- Three-staff organ notation is compressed by reducing inter-staff spacing
  before reducing glyph size; a minimum glyph size is enforced and the
  renderer breaks systems earlier instead.
- Foot-switch page turning is only relevant in the reading view; it is a
  later feature.

Scores are stored as MEI and rendered on device with Verovio (section 12);
the authoring tool uses the same library in its web build, so the organist's
preview matches the phone rendering.

## 9. Content pipeline (D-8)

One professional organist authors every lesson in house. That single
throughput sets the catalogue growth rate, so the authoring tool is designed
around this person's time (A-9: roughly one lesson every two weeks alongside
other duties).

Per piece:

1. Source: public-domain urtext (Bach Gesellschaft, Buxtehude collected
   editions, first editions for the French school). Editions by editors who
   died after 1955 are not used even when the music is public domain (Dupré's
   Bach editions, for instance, are not free).
2. Engrave in a notation editor (MuseScore or Dorico) and export MusicXML;
   convert to MEI in the authoring tool; proofread on device.
3. Add editorial fingering and pedaling, marked as editorial.
4. Segment into sections; write the difficulty annotations.
5. Write orientation commentary in German and English (D-13) and the analysis
   questions.
6. Record the reference performance as MIDI on the organist's console, with
   audio when available (D-9). The tool aligns the MIDI to the score and
   flags mismatches.
7. Validate: schema check, a play-through of every exercise configuration on
   the console to confirm channel mapping and tempo targets, and a
   self-assessed walk-through to confirm the lesson stands without MIDI.

### 9.1 Candidate launch catalogue (A-10, for the organist to revise)

Ten pieces at launch, graded as a ladder, then two per month. All are public
domain in the EU and Switzerland; the edition is in house.

| Grade | Piece | Why it is here |
|---|---|---|
| 1 | J. S. Bach, "Ich ruf zu dir, Herr Jesu Christ" BWV 639 | Slow trio, simple pedal line, first manual change; ideal pedal foundation inside real repertoire. |
| 1 | Brahms, "Es ist ein Ros entsprungen" op. 122 no. 8 | Chordal legato, quiet pedal; teaches finger substitution. |
| 2 | J. S. Bach, "Liebster Jesu, wir sind hier" BWV 731 | Ornamented cantus firmus, pedal at walking pace. |
| 2 | Pachelbel, Ciacona in F minor | Variation form; pedal optional, so it works for manuals-only practice. |
| 3 | J. S. Bach, "Wachet auf, ruft uns die Stimme" BWV 645 | Cantus in the tenor, ritornello texture; classic independence study. |
| 3 | Buxtehude, "Nun bitten wir den heiligen Geist" BuxWV 208 | North German chorale prelude, ornamented line over pedal. |
| 4 | Boëllmann, Toccata from Suite gothique | Popular, repetitive figuration, pedal melody; strong motivator. |
| 4 | Mendelssohn, Sonata no. 6 op. 65, chorale and variations | Romantic legato, manual changes, moderate pedal. |
| 5 | J. S. Bach, Toccata and Fugue in D minor BWV 565 | Pedal solo, the piece most enthusiasts want; sections span the ladder. |
| 6 | Widor, Toccata from Symphony no. 5 | Aspirational; rapid manual figuration over pedal theme. Widor died in 1937, so the work is public domain. |

Candidates for the following months: Bach BWV 553 to 560, Franck Prélude,
fugue et variation, Vierne Carillon de Westminster, Bach Pastorella BWV 590,
Buxtehude Praeludium in G minor BuxWV 149.

## 10. Motivation layer (D-15)

| Element | Behaviour |
|---|---|
| Practice calendar | Days practised and minutes, a weekly minute goal set by the learner, no penalty display for gaps. |
| Lesson milestones | First section secured, first full play-through, lesson complete; each with a dated entry the learner can share as an image. |
| Achievements | Named in musical terms: "First fugue secured", "Pedal solo at tempo", "Ten hours of pedal work", "Thirty days at the console". Awarded quietly at session end, listed in the profile. |
| Repertoire list | Completed lessons form a repertoire list with the date and the tempo reached, in the layout of a concert programme. |

## 11. Tutor sessions (D-12)

A premium service, sold separately from the subscription: a one-to-one video
session with a professional organist, initially the in-house organist.

- Booking: the learner picks a lesson to discuss and a slot from the tutor's
  calendar; the app confirms and sends a video link (an external service such
  as Zoom or Jitsi in v1, A-11).
- Preparation: the tutor sees the learner's lesson map, skill profile, and the
  last attempts with their heat maps or ratings before the session.
- Follow-up: the tutor writes notes and can pin exercises with a tempo into
  the learner's lesson; the engine treats pinned exercises as the next
  recommendation until passed.
- Payment: live person-to-person services may be sold outside the store's
  in-app purchase system under Apple's guideline 3.1.3(d); Google Play's rule
  must be checked before launch (Q-3).
- A tutor web view is needed for preparation and notes; it shares the
  authoring tool's codebase.

## 12. Technology stack (D-16)

Requirements shaping the choice: one small team, phone-first, iOS and Android
from one codebase, USB and Bluetooth MIDI on both platforms, high-quality
custom score rendering, low-latency audio, offline SQLite, store
subscriptions, and a web authoring tool maintained by the same team.

| Option | Fit |
|---|---|
| Flutter (Dart) | Strong custom rendering (Impeller), one codebase, mature MIDI package (`flutter_midi_command`, USB and BLE on both platforms), C++ FFI for Verovio, SQLite via `drift`, RevenueCat SDK. |
| React Native with Expo (TypeScript) | Largest package library, shares TypeScript with the backend and authoring tool; MIDI and low-latency audio need custom native modules; score rendering via Skia or a web view. |
| Kotlin Multiplatform with Compose | Native performance; iOS Compose is younger; MIDI needs platform code twice. |
| Two native apps (Swift, Kotlin) | Best MIDI and audio control; double maintenance, wrong for a small team. |

Recommendation: Flutter for the mobile client. The decisive points are
rendering control for the score view, one MIDI package that covers both
transports on both platforms, and a single codebase a small team can hold.

| Layer | Choice |
|---|---|
| Mobile client | Flutter, Dart. Tablet layout later from the same code. |
| Score renderer | Verovio compiled to a native library, called through Dart FFI; SVG output drawn with the Flutter canvas. |
| Scoring engine | Dart library: note alignment of played events to the score, timing and articulation metrics. Pure functions, unit-tested with recorded fixtures. |
| Adaptivity engine | Dart library, same discipline. |
| Audio | Native low-latency output (AVAudioEngine, Oboe) behind a small platform channel; sample playback of the built-in organ set. |
| MIDI | `flutter_midi_command`; RTP MIDI later. |
| Local store | SQLite via `drift`, one database per learner. |
| Backend | Supabase (managed Postgres, auth, storage, edge functions) hosted in an EU region (A-12). Holds accounts, catalogue metadata, progress sync, tutor bookings. |
| Content delivery | Signed lesson packages (MEI, MIDI reference, audio, commentary) on object storage behind a CDN. |
| Subscriptions | RevenueCat over App Store and Google Play billing. |
| Authoring and tutor tool | Web app in TypeScript with Verovio's JavaScript build, same MEI, same rendering. |
| Analytics | PostHog, opt-in, aggregated per exercise template. |
| CI and release | GitHub Actions with Codemagic or Fastlane for store builds. |

The scoring and adaptivity engines are deliberately kept as plain Dart
packages without Flutter dependencies, so they can be tested on a laptop
against recorded MIDI fixtures and, if the stack ever changes, ported.

## 13. Non-functional requirements

| Requirement | Target |
|---|---|
| MIDI event to cursor update | ≤ 30 ms on supported devices |
| Cold start to a cached lesson | ≤ 3 s |
| Lesson package size | ≤ 25 MB including reference audio |
| Offline | All learning features after download; sync deferred |
| Accessibility | Dynamic type, screen-reader labels on all non-score UI, high-contrast score theme |
| Languages | German and English at launch (D-13); the content model supports adding languages per lesson |
| Privacy | Attempts stay on device unless sync is on; EU hosting; no third-party trackers |
| Minimum OS | iOS 16, Android 10 with USB host (A-13) |

## 14. Out of scope for the first release

- Piano or any second instrument (D-14).
- Console or virtual-organ integration for registration (D-6).
- Live scoring feedback during an attempt (D-5).
- Tablet-optimised layout (phone first, D-3).
- Microphone-based scoring.
- Improvisation, harmonisation, hymn playing, service skills.
- Group features, community, or any teacher role beyond tutor sessions.

## 15. Decisions from interview round one

| ID | Decision |
|---|---|
| D-1 | About 60 % of users can connect MIDI; the app must be complete without it. |
| D-2 | Learners already play a keyboard instrument and read music. |
| D-3 | Phone first; tablet later. |
| D-4 | Two selection modes: guided (automatic) and self-directed (map with recommendation). |
| D-5 | Post-attempt analysis only; no live colouring. |
| D-6 | Registration in generic families only. |
| D-7 | Public-domain sources only. |
| D-8 | In-house authoring. |
| D-9 | Commissioned reference performances captured as MIDI. |
| D-10 | Sound both from the app and via MIDI to the instrument. |
| D-11 | Subscription model. |
| D-12 | Teacher involvement limited to exclusive one-to-one sessions with a professional tutor. |
| D-13 | German and English at launch, more later. |
| D-14 | Piano deferred entirely. |
| D-15 | Practice calendar, milestones, and achievements are in scope. |
| D-16 | Name PocketMaestro; team is one professional organist; stack to be modern, flexible, maintainable. |

## 16. Assumptions register

| ID | Assumption |
|---|---|
| A-1 | Scored-track thresholds in section 5.3 are placeholders. |
| A-2 | Self-assessed "secure" needs three ratings on separate days. |
| A-3 | Skill profile dimensions per section 6.1. |
| A-4 | Guided mode is the default for new learners. |
| A-5 | Tempo step of 4 % of target, halved at low confidence. |
| A-6 | Default session budget of 30 minutes. |
| A-7 | Portrait shows two to three bars per line; landscape one system. |
| A-8 | Tablet layout comes after launch. |
| A-9 | Authoring throughput of one lesson per two weeks. |
| A-10 | The launch catalogue in section 9.1. |
| A-11 | Tutor video runs on an external service in v1. |
| A-12 | Backend hosted in an EU region. |
| A-13 | Minimum iOS 16 and Android 10. |

## 17. Open questions for round two

| ID | Question |
|---|---|
| Q-1 | Subscription shape: monthly and annual prices, trial length, and whether one lesson stays free as a permanent sample. |
| Q-2 | Self-assessed track: is the three-step rating plus metronome tempo acceptable, or do you want a richer self-check (per-part ratings, a short checklist per exercise)? |
| Q-3 | Tutor sessions: price, session length, who else may tutor later, and whether booking happens in the app or on a web page. |
| Q-4 | Catalogue: which of the ten candidates stay, what replaces the rest, and how many hours one lesson takes you to author with a good tool. |
| Q-5 | Score view: is landscape acceptable as the default while playing on a phone? |
| Q-6 | Who builds it: an outside developer or agency, an AI-assisted solo effort, or a hire; and the target date for a first testable build. |
| Q-7 | Data location and legal: Swiss or EU hosting, and which entity signs the store accounts. |
| Q-8 | Visual identity: any existing PocketMaestro branding, or does design start from zero? |
| Q-9 | Achievements: do you want a fixed list now, or should the authoring tool let you define achievements per piece? |
| Q-10 | Reference audio: does your recording instrument give you audio alongside MIDI, or is MIDI rendered through the built-in sound the only playback at launch? |
