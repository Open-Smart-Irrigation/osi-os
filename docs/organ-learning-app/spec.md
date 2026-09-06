# PocketMaestro: product specification (draft 0.6)

Status: consolidated after four interview rounds; ready to freeze for the
phase 0 spike. Section 17 records the decisions (`D-n`). The launch
catalogue is detailed in [catalogue.md](catalogue.md); the technical
architecture in [architecture.md](architecture.md). Statements marked `A-n` are assumptions
still awaiting confirmation; `Q-n` are open questions for the next round.
This document is unrelated to OSI OS firmware; it lives here because the
brainstorming session ran in this repository.

## 1. Summary

PocketMaestro is a phone-first mobile app that teaches organ playing through
complete classical pieces. It launches on Android; the iOS port follows after
launch from the same codebase (D-33). One lesson is one piece.
Each lesson contains exercises that the app selects and scales from the
learner's measured or self-reported progress. The audience is adult classical
music enthusiasts who already play a keyboard instrument and read music. About
60 % of them can connect their instrument by MIDI (D-1); the other 40 % use
the same lessons with self-assessment instead of automatic scoring. Content is
authored in house by a professional organist from public-domain sources. The
first lesson is free for everyone; the rest need a monthly or annual
subscription (D-17). Two-hour one-to-one tutor sessions are bookable in the
app at any time for 100 USD (D-19). The launch is device-local: no user
accounts, progress stays on the phone, and sync arrives with the iOS port
(D-38). The organist builds the product alone with AI assistance (D-22),
which shapes the stack in section 14. Piano is not part of this product
(D-14).

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
| Tutor session | A booked one-to-one session with a professional tutor, with the tutor's notes and assigned exercises written back into the lesson (section 13). |

## 5. Lesson structure

### 5.1 Orientation

- Piece overview: composer, date, liturgical or concert context, form outline
  with a tappable bar map.
- Reference performance: a commissioned recording by the in-house organist
  captured as MIDI and audio at the same time (D-9, D-26).
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
| Part isolation | One part (RH, LH, pedal) of a section; app sounds or mutes the others. | Rating for that part |
| Part pairing | Two of three parts; the organ sequence RH+pedal, LH+pedal, then manuals. | Rating per part |
| Full texture | All parts at a tempo the profile predicts as achievable. | Rating per part plus metronome tempo |
| Loop drill | Two to eight bars repeated, tempo ramped between repetitions. | Rating per part at each tempo step |
| Pedal technique | Pedal line alone with heel/toe indications; scored by timing. | Pedal rating |
| Legato and articulation | Note overlap and gap scored against the reference performance; on the organ this is the main expressive parameter. | Listening comparison, rating per part |
| Manual change | Passages with manual switches; note channel checked against the expected manual. | Rating per part |
| Sight reading | An unseen section once at a comfortable tempo; scores reading accuracy. | Rating per part |
| Memory | Score hidden progressively. | Rating per part |
| Listening and analysis | Identify subject entries, name the cadence, compare two registrations. | Answer key (identical for both tracks) |

### 5.3 Pass conditions

Scored track, placeholder thresholds to tune with data (A-1):

| Dimension | Pass | Secure |
|---|---|---|
| Pitch | 95 % correct notes, no wrong pedal note | 99 % |
| Timing | 90 % of onsets within ±60 ms at target tempo | 95 % within ±40 ms |
| Articulation | 80 % of scored note pairs within tolerance of the reference | 90 % |

Self-assessed track: after each attempt the learner rates every part that
was played (RH, LH, pedal) on a three-step scale (not yet, mostly, secure)
and records the metronome tempo used (D-18). Per-part ratings let the engine
see which hand or foot limits a combined exercise, which is the same signal
the scored track gets from per-part error rates. An exercise passes when all
its parts are rated "secure" at target tempo; three such passes on separate
days secure the section (A-2), against two for the scored track, because
self-reports carry less evidence.

A lesson is complete when every section is secured and the whole piece has
been played through once at tempo, scored above the pass line or self-rated
secure.

## 6. Adaptivity engine

The engine answers one question after every attempt: what should this learner
do next in this lesson? It runs on the device, takes attempt history, skill
profile, and the piece's difficulty annotations, and is a pure library with
unit tests and no network dependency. Its governing target is a success rate
near three attempts in four, the band where practice stretches without
discouraging; the update rules that hold a learner there are specified in
[architecture.md](architecture.md), section 6 (D-40).

### 6.1 Skill profile dimensions (A-3)

| Dimension | Measured from (scored track) | Estimated from (self-assessed track) |
|---|---|---|
| Pedal accuracy | Pitch errors on pedal notes | Ratings on pedal-only exercises |
| Pedal timing | Onset error pedal versus manuals | Ratings on part pairings with pedal |
| Hand independence | Error rise when parts are combined | Per-part rating drop when parts are combined |
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
4. Raise the tempo one step (default 4 % of target, A-5) after two
   consecutive passes at the current tempo; drop it one step after a fail.
   This staircase settles where about 71 % of attempts succeed. (Earlier
   drafts had the inverse rule, which settles near 38 %; the correction is
   explained in architecture.md 6.2.) Halve the step while the relevant
   confidence is low.
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
| USB MIDI (class compliant) | Android via USB host at launch; iOS via USB-C or Lightning adapter at the port (D-33). |
| Bluetooth LE MIDI | Same platform order. Latency budget ≤ 20 ms measured; the app warns above. |
| Network MIDI (RTP) | Later; relevant for Hauptwerk on a computer. |
| Microphone | Not for scoring. Polyphonic organ sound in a reverberant room is not reliably transcribable on a phone. |
| No connection (self-assessed track) | Metronome, reference playback, score, self-rating. Full lesson available. |

Pedal and manual notes are told apart by MIDI channel; instruments are
assumed to send each division on its own channel (D-30). The guided setup
confirms the mapping by asking for one key per manual and one pedal note. An
instrument that merges divisions onto one channel is detected at this step;
its learner keeps full scoring on single-part exercises and falls back to
self-rating where parts must be told apart (A-17).

### 7.2 During the attempt

The screen shows the exercise's bars, one system at a time in landscape
(the default, D-21) or two to three bars per line in portrait (A-7), with a
cursor. The cursor is
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
- Landscape is the default while playing and shows one wide system (D-21).
  Portrait is available for reading and for learners who prop the phone
  upright; it shows narrower systems with larger glyphs.
- Three-staff organ notation is compressed by reducing inter-staff spacing
  before reducing glyph size; a minimum glyph size is enforced and the
  renderer breaks systems earlier instead.
- Foot-switch page turning is only relevant in the reading view; it is a
  later feature.

Scores are stored as MEI and rendered on device with Verovio (section 14);
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
6. Record the reference performance as MIDI and audio in one take on the
   organist's console (D-9, D-26). The tool aligns the MIDI to the score and
   flags mismatches; the audio is trimmed to the same start point so bar
   positions map to both.
7. Validate: schema check, a play-through of every exercise configuration on
   the console to confirm channel mapping and tempo targets, and a
   self-assessed walk-through to confirm the lesson stands without MIDI.

### 9.1 Launch catalogue

The catalogue plan, with grading criteria, per-piece section and technique
plans, licensing checks, and authoring effort estimates, is in
[catalogue.md](catalogue.md). Its headline: ten pieces at launch would cost
about 250 authoring hours, which a solo builder cannot afford alongside the
app; the decision is six at launch (grades 1 to 4) and ten within the first
quarter after (D-28).

## 10. Motivation layer (D-15)

| Element | Behaviour |
|---|---|
| Practice calendar | Days practised and minutes, a weekly minute goal set by the learner, no penalty display for gaps. |
| Lesson milestones | First section secured, first full play-through, lesson complete; each with a dated entry the learner can share as an image. |
| Achievements | Two kinds (D-25). General achievements are defined once in the app: "First fugue secured", "Ten hours of pedal work", "Thirty days at the console". Per-piece achievements are defined by the organist in the authoring tool with a name, a condition (section secured, tempo reached, exercise passed without error), and a sentence of context: "Pedal solo of BWV 565 at 100". Both are awarded quietly at session end and listed in the profile. |
| Repertoire list | Completed lessons form a repertoire list with the date and the tempo reached, in the layout of a concert programme. |

## 11. Brand and visual identity (D-24)

PocketMaestro is a new brand with no existing assets. The plan is to explore
several directions before settling, each as a set of mock screens (lesson
map, playing view in landscape, post-attempt analysis) rather than a logo
alone, because the score view dominates the product and the brand must
survive next to engraved music. Three starting directions to try (A-15):

| Direction | Character |
|---|---|
| Concert programme | Serif typography, cream and black, restrained accent colour; progress presented like a printed programme. |
| Engraver's workshop | Reference to plate engraving: fine rules, stamped numerals, warm greys; the analysis views drawn like proof sheets. |
| Modern loft | Sans-serif, dark interface for low-light organ lofts, single bright accent for the cursor and the recommendation. |

The score theme (staff line weight, glyph font, cursor colour) is part of
each direction and is tested on a phone at arm's length on a music desk.
The exploration runs separately in Claude Design (D-34); this spec only
records the outcome once a direction is chosen.

## 12. Pricing and access (D-17)

| Tier | What it includes |
|---|---|
| Free | The first lesson of the ladder (BWV 639) with every feature: scoring, both selection modes, reference performance, achievements. No time limit and no account; accounts do not exist at launch (D-38). |
| Subscription | The whole catalogue and new lessons as they are published. CHF 12 monthly or CHF 96 annually, the annual price equal to eight monthly payments (D-27). Progress sync across devices joins the benefits when accounts arrive with iOS (D-38). |
| Tutor session | Bought per session, subscription not required (section 13). |

The free lesson is the trial: it shows the full system on a piece a pianist
can finish in a few weeks, so there is no separate time-limited trial.
Subscription state is checked from the local RevenueCat cache, so a lapsed
subscription offline still opens downloaded lessons until the grace period
ends (A-16). Cancelling keeps the learner's data; the repertoire list and
achievements stay visible.

## 13. Tutor sessions (D-12, D-19)

An optional service, always available, sold separately from the
subscription: a two-hour one-to-one video session with a professional
organist for 100 USD, initially the in-house organist. Booking happens in the
app.

- Booking: the learner picks a lesson to discuss and a slot from the tutor's
  published availability; the app confirms, takes payment, and sends the
  video link. Video runs on an external service (Zoom or Jitsi, A-11).
- Preparation: the tutor sees the learner's lesson map, skill profile, and
  the last attempts with their heat maps or per-part ratings before the
  session.
- Follow-up: the tutor writes notes and can pin exercises with a tempo into
  the learner's lesson; the engine treats pinned exercises as the next
  recommendation until passed.
- Payment: the session is a live person-to-person service consumed outside
  the app, so it may be sold outside store billing under Apple's guideline
  3.1.3(d) and Google Play's exemption for services delivered outside the
  app; the plan is Stripe Checkout inside the booking flow (A-14). If a
  store review rejects that, the fallback is a consumable in-app purchase at
  the nearest price tier, which costs the store commission.
- Capacity: ten two-hour slots per week are opened at launch (D-31). Slots
  are a ceiling, not a commitment; unbooked slots cost nothing. Fully booked,
  they are 20 hours of tutoring on top of the 20 build hours (D-32) and the
  authoring load, so if bookings approach the ceiling the slot count comes
  down or the price goes up before quality does.
- The tutor web view for preparation and notes shares the authoring tool's
  codebase.

## 14. Technology stack (D-16, D-22, D-23)

Requirements shaping the choice: one person building with AI assistance and
no professional development background, phone-first, iOS and Android from one
codebase, USB and Bluetooth MIDI on both platforms, high-quality score
rendering, offline SQLite, store subscriptions, a web authoring tool, and
Swiss hosting for the backend.

### 14.1 Why the recommendation changed from draft 0.2

Draft 0.2 recommended Flutter, mainly for rendering control and MIDI
latency. Two decisions since then move the balance:

- Feedback is post-attempt only (D-5), so MIDI-to-screen latency no longer
  matters for scoring. Note timestamps come from the platform MIDI layer and
  are scored after the attempt; a JavaScript bridge in the path costs
  nothing.
- The builder works alone with AI assistance (D-22). One language across
  mobile, backend, and authoring tool halves what must be learned, and
  TypeScript with React is the corpus where AI coding assistants are most
  reliable. Expo's cloud build service removes the local Xcode and Gradle
  toolchain, which is the part of mobile development a solo non-developer
  most often gets stuck on.

The remaining risk on the TypeScript path is MIDI: the React Native packages
are less mature than Flutter's. That risk is bounded by a spike in the first
week (section 14.4) and shrinks with the Android-first order (D-33), because
Android's USB host MIDI is the better-trodden path in those packages; if the
spike fails, the fallback is Flutter with the rest of the stack unchanged.

### 14.2 Chosen stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere, one monorepo (pnpm workspaces). |
| Mobile client | React Native with Expo (dev client, EAS Build and Submit). Landscape score view, phone first. |
| Score renderer | Verovio's JavaScript build producing SVG, drawn with `react-native-svg`. The authoring tool uses the same Verovio build, so preview equals device rendering. |
| MIDI | Web MIDI API shape over CoreMIDI and Android MidiManager (candidate `@motiz88/react-native-midi`); Bluetooth MIDI pairing through the system dialogs. Verified by the spike. |
| Audio | `react-native-audio-api` (Web Audio API for React Native) for sample playback of the built-in organ set and reference audio. |
| Scoring engine | Pure TypeScript package: alignment of played events to the score, timing and articulation metrics. Tested against recorded MIDI fixtures. |
| Adaptivity engine | Pure TypeScript package, same discipline. |
| Content schema | Zod schemas shared by mobile, API, and authoring tool; lesson packages are validated at authoring time and at load time. |
| Local store | `expo-sqlite` with Drizzle ORM. |
| Backend API | Small Hono service on Node, in a container, for tutor slots and bookings only (D-38). Catalogue and lessons are static files on the CDN; details in architecture.md. |
| Auth | None at launch (D-38). Accounts and progress sync arrive with the iOS port; attempts are append-only with device-generated ULIDs so they merge cleanly then. Until then a backup export protects against phone loss (architecture.md 4.1). |
| Database and storage | Managed PostgreSQL and S3-compatible object storage at a Swiss provider (Exoscale, Zurich or Geneva zones; Infomaniak as alternative), D-23. Lesson packages and reference audio served from object storage through the provider's CDN. |
| Hosting | One container host at the same provider running the API, the authoring web tool, and nightly backups to object storage. |
| Subscriptions | RevenueCat with anonymous app user IDs over Play Billing (`react-native-purchases`), App Store at the port. RevenueCat receives store identifiers, not personal data. |
| Tutor payments | Stripe Checkout (A-14). |
| Authoring and tutor tool | React web app (Vite) served from the same host. |
| Push and email | No push at launch. Transactional email (booking confirmations) through a provider with EU or Swiss processing. |
| Analytics | None at launch beyond the app's own attempt data; PostHog self-hosted later if needed. |
| CI and release | GitHub Actions running tests and schema checks; EAS Build for store binaries; weekly TestFlight and Play internal builds. |

### 14.3 Legal and account setup for a private person (D-23)

- Google Play developer accounts can be held by an individual. Google
  requires identity verification and, for individual accounts, a closed test
  with at least twenty testers over fourteen days before production release,
  so recruiting those testers is on the launch critical path (Q-2). The
  Apple Developer Program account is only needed when the iOS port starts.
- Apple and Google are the merchant of record for subscriptions and handle
  consumer VAT. For tutor sessions sold through Stripe, the seller is the
  private person; Swiss VAT registration starts at CHF 100 000 global
  turnover, and live online tutoring by a person is not an electronically
  supplied service under EU VAT rules, so the place of supply stays in
  Switzerland. Confirming both points with a tax advisor is deferred by
  decision (D-29) and tracked as risk R-1 in section 19; it must close
  before the first paid tutor session, not before the free beta.
- The revised Swiss Data Protection Act applies; the app needs a privacy
  policy, data export, and account deletion. Swiss hosting keeps attempt
  data in the country; RevenueCat and Stripe are foreign processors and go
  in the policy.

### 14.4 Build order (D-22, D-37)

The beta comes as early as possible (D-37), so the plan is three beta
milestones instead of a long phase ladder: B1 is the free lesson with the
self-assessed track and local progress, B2 adds MIDI scoring, B3 adds
adaptivity, six lessons, the subscription, and booking, and B3 is the launch
product. The milestone contents, exit tests, and the two-week spike that
precedes B1 are in architecture.md, section 10. B1 needs no server code at
all, and the twenty recruited students (D-36) test from B1 onward, which
satisfies Google's fourteen-day closed-test requirement inside the normal
beta sequence.

Working rules for the build: the specification and the content schema live
in the repository and are updated before code changes; every engine change
comes with a fixture test; a build goes to the phone at least weekly and is
played against the emulated console (architecture.md, section 7) until the
organ is available, and gate G1 there revalidates MIDI capture, the channel
wizard, and the scoring fixtures on the real instrument before B2 reaches
MIDI testers (D-39); no native module is added without a spike branch
proving it on the target platform.

## 15. Non-functional requirements

| Requirement | Target |
|---|---|
| MIDI event to cursor update | ≤ 30 ms on supported devices |
| Cold start to a cached lesson | ≤ 3 s |
| Lesson package size | ≤ 25 MB including reference audio |
| Offline | All learning features after download; sync deferred |
| Accessibility | Dynamic type, screen-reader labels on all non-score UI, high-contrast score theme |
| Languages | German and English at launch (D-13); the content model supports adding languages per lesson |
| Privacy | Attempts stay on device (no accounts at launch, D-38); the one upload is the consented snapshot at tutor booking; Swiss hosting; no third-party trackers |
| Minimum OS | Android 10 with USB host at launch; iOS 16 at the port (A-13) |

## 16. Out of scope for the first release

- Piano or any second instrument (D-14).
- Console or virtual-organ integration for registration (D-6).
- Live scoring feedback during an attempt (D-5).
- Tablet-optimised layout (phone first, D-3).
- Microphone-based scoring.
- Improvisation, harmonisation, hymn playing, service skills.
- Group features, community, or any teacher role beyond tutor sessions.

## 17. Decisions from the interviews

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
| D-17 | First lesson always free; monthly and annual subscriptions. |
| D-18 | Self-assessment is rated per part. |
| D-19 | Tutor sessions: two hours for 100 USD, always available, optional, booked in the app. |
| D-20 | Catalogue detailed in catalogue.md. |
| D-21 | Landscape is the default playing orientation. |
| D-22 | The organist builds the product alone with AI assistance. |
| D-23 | Swiss hosting; the legal entity is a private person. |
| D-24 | New brand, several visual directions to be tried. |
| D-25 | Achievements both general and per piece. |
| D-26 | Reference performances captured as MIDI and audio together. |
| D-27 | Prices CHF 12 monthly, CHF 96 annually. |
| D-28 | Six lessons at launch, ten within the first quarter after. |
| D-29 | Tax and legal advice deferred (risk R-1). |
| D-30 | Divisions are assumed to send on separate MIDI channels. |
| D-31 | Ten two-hour tutor slots per week at launch. |
| D-32 | Build time is 20 hours per week. |
| D-33 | Android launches first; iOS is ported after launch. |
| D-34 | Brand exploration runs separately in Claude Design. |
| D-35 | Test device Pixel 8 Pro, USB-C cable to the console, no OTG adapter. |
| D-36 | Twenty students are recruitable for the Google closed test. |
| D-37 | Beta as soon as possible; spec depth goes to design and architecture, not roadmap. |
| D-38 | Device-local launch; accounts and sync arrive with the iOS port. |
| D-39 | Development runs against an emulated console; gate G1 revalidates on the real instrument before B2. |
| D-40 | Adaptivity is a design priority: a simple, explainable algorithm adjusting pace and exercise type per learner. |

## 18. Assumptions register

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
| A-10 | Resolved by D-28. |
| A-11 | Tutor video runs on an external service in v1. |
| A-12 | Backend hosted in an EU region. |
| A-13 | Minimum Android 10 at launch, iOS 16 at the port. |
| A-14 | Tutor payment through Stripe outside store billing passes review. |
| A-15 | The three brand directions in section 11 are the starting set. |
| A-16 | Offline grace period of 14 days after a subscription lapses. |
| A-17 | Merged-channel instruments fall back to self-rating only where parts must be told apart. |

## 19. Open items

Deferred risks:

| ID | Risk | Must close before |
|---|---|---|
| R-1 | VAT position for tutor sessions and store account setup as a private person, unconfirmed (D-29). | First paid tutor session. |

The interview is closed; rounds one to four are all folded in. What remains
open before code:

1. Review of [architecture.md](architecture.md), in particular its four
   assumptions: backup export as loss protection, the consented snapshot
   upload at tutor booking, 90-day pruning of raw attempt events, and the
   USB-C cabling assumption for the console (its USB-B socket, if that is
   what it has, needs a C-to-B cable).
2. The brand direction, decided in Claude Design (D-34) and recorded here
   afterwards.
3. Risk R-1 above, before the first paid tutor session.
