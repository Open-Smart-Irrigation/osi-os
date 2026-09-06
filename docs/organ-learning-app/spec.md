# Organ learning app: product specification (draft 0.1)

Status: brainstorming draft. Every statement marked `A-n` is an assumption
awaiting confirmation; every `Q-n` is an open question for the product owner.
This document is unrelated to OSI OS firmware; it lives here because the
brainstorming session ran in this repository.

## 1. Summary

A mobile app (iOS and Android) that teaches organ playing through complete
classical pieces. One lesson is one piece. Each lesson contains a sequence of
exercises that the app selects and scales from the learner's measured
progress. The audience is adult classical music enthusiasts who already read
music and want repertoire-driven study rather than method-book drills. A later
release extends the same engine to piano.

## 2. Target users

Primary persona: an adult amateur with several years of keyboard experience,
often a pianist who wants to move to the organ, or a church organist who
learned informally and wants structured technique. They own or have regular
access to an instrument with a pedalboard, most often a digital home organ or a
virtual organ (Hauptwerk, GrandOrgue) driven by MIDI consoles (A-1). They read
staff notation fluently, know the standard repertoire by ear, and lose patience
with content that talks down to them.

Secondary persona: a piano player with no pedal experience who wants to try
the organ before committing to an instrument. Their sessions may run on a
piano or MIDI keyboard with no pedalboard; the app must still offer value in
that configuration (A-2).

Not targeted in the first release: children, absolute beginners who cannot
read music, and conservatory students following a teacher-led syllabus (A-3).

## 3. Product principles

1. Repertoire first. Technique is taught because a specific bar of a specific
   piece needs it, never as an abstract drill.
2. Scholarly register. Urtext or urtext-derived scores, editorial fingering
   and pedaling marked as such, historical and analytical commentary at the
   level of a good liner note or a Bärenreiter preface.
3. Adaptive, not gamified. Progress is expressed as tempo reached, passages
   secured, and skills demonstrated. No streak fireworks, no cartoon mascots
   (A-4). Light motivational structure (practice calendar, milestones) is
   acceptable if it stays in the visual language of a concert programme.
4. Instrument-agnostic where possible. The app never assumes a particular
   stop list or console layout; registration guidance is expressed in generic
   families and mapped by the user once per instrument.
5. Works offline. Churches, practice rooms, and organ lofts often have no
   connectivity. Every downloaded lesson is fully playable without a network.

## 4. Domain model

| Entity | Definition |
|---|---|
| Piece | A musical work in a fixed edition: composer, title, catalogue number, score source, duration, difficulty profile, licensing status. |
| Lesson | The learning unit built on one piece. Owns an ordered but adaptive set of exercises plus reference material (commentary, recordings, analysis). |
| Section | A contiguous span of bars within a piece with a musical identity (exposition, fugue subject entry, pedal solo). Exercises target sections. |
| Exercise | A single task with a defined pass condition: which section, which parts (RH, LH, pedal, any combination), target tempo, loop count, feedback mode. Generated from templates, parameterised by the learner's profile. |
| Attempt | One recorded performance of an exercise: note events with timing, derived scores, and the exercise parameters in force at the time. |
| Skill profile | A per-learner vector of measured capabilities (see section 6). Updated after every attempt. |
| Instrument profile | The learner's registered instruments: MIDI capabilities, manuals, pedalboard compass, registration mapping. |
| Curriculum | An ordered suggestion of lessons based on the skill profile; the learner may override it at any time (A-5). |

## 5. Lesson structure

A lesson opens with orientation material and moves through exercises in
tiers. The app chooses the next exercise; the learner can always see the full
map and jump.

### 5.1 Orientation

- Piece overview: composer, date, liturgical or concert context, form outline
  with a clickable bar map.
- Reference listening: a licensed or commissioned recording, or a rendered
  MIDI performance when no recording licence exists (Q-10).
- Registration proposal in generic terms (principal chorus 8'+4'+2', flute
  8' on the second manual, pedal 16'+8') with historical rationale.
- Technical preview: the app highlights the bars its difficulty model flags
  as demanding for this learner and explains why (pedal crossings, manual
  changes, thumbing-under on a held voice).

### 5.2 Exercise templates

| Template | What the learner does | Typical parameters |
|---|---|---|
| Part isolation | Play one part (RH, LH, pedal) of a section while the app sounds or mutes the others. | section, part, tempo ratio, accompaniment on/off |
| Part pairing | Two of three parts together; the classic organ sequence RH+pedal, LH+pedal, then manuals. | section, part pair, tempo ratio |
| Full texture | All parts at a tempo the profile predicts as achievable. | section, tempo ratio |
| Loop drill | A short problem passage (two to eight bars) repeated, tempo ramped between repetitions. | passage, start tempo, target tempo, step |
| Pedal technique | Pedal line alone with heel/toe indications; app scores foot choice where a sensor exists, timing otherwise (A-6). | section, pedaling edition |
| Legato and articulation | Scores note overlap and gap between consecutive notes against the edition's articulation. Organ-specific: no velocity, so articulation is the main expressive parameter. | section, tolerance |
| Manual change | Passages with manual switches; app checks the MIDI channel of each note against the expected manual (A-7). | section |
| Sight reading | An unseen section played once at a comfortable tempo; scores reading accuracy, not polish. | section, tempo |
| Memory | Score hidden progressively (first bars, then whole systems). | section, reveal level |
| Listening and analysis | Non-playing tasks: identify the fugue subject entries, mark the cadence type, compare two registrations. | section, question set |

### 5.3 Pass conditions and progression

Each exercise carries a pass condition in three dimensions: pitch accuracy,
timing accuracy at the target tempo, and articulation where scored. Default
thresholds are placeholders (A-8):

| Dimension | Pass | Secure |
|---|---|---|
| Pitch | 95 % correct notes, no wrong pedal note | 99 % |
| Timing | 90 % of onsets within ±60 ms at target tempo | 95 % within ±40 ms |
| Articulation | 80 % of scored note pairs within tolerance | 90 % |

A section is *secured* when the full-texture exercise reaches the secure
threshold at the lesson's target tempo on two separate days (spacing rule,
A-9). A lesson is complete when every section is secured and the whole piece
has been played through once at tempo with a pitch score above the pass line.

## 6. Adaptivity engine

The engine answers one question after every attempt: what should this learner
do next in this lesson? Inputs are the attempt history, the skill profile, and
the piece's difficulty annotations.

### 6.1 Skill profile dimensions (A-10)

| Dimension | Measured from |
|---|---|
| Pedal accuracy | Pedal-only and combined exercises, pitch dimension |
| Pedal timing | Onset error on pedal notes relative to manual notes |
| Hand independence | Error rate rise when parts are combined versus isolated |
| Voice independence | Errors in inner voices of contrapuntal textures |
| Legato control | Overlap/gap distribution |
| Manual-change fluency | Timing error around manual switches |
| Sight-reading speed | First-attempt accuracy at a given note density |
| Tempo ceiling per texture class | Highest tempo ratio passed for chorale, fugue, toccata textures |
| Retention | Score decay between sessions on secured sections |

### 6.2 Selection rules

1. Start each session with a retention probe on the oldest secured section
   (spaced repetition; interval doubles on success, halves on failure).
2. Pick the section with the largest gap between predicted and target tempo.
3. Within it, choose the least combined part configuration that has not yet
   passed; combine only when isolation is secure.
4. Set the tempo at the learner's last passed tempo plus one step (default
   4 % of target, A-11), or minus one step after two consecutive failures.
5. If the same bars fail three times, spawn a loop drill on exactly those
   bars and, if the difficulty annotation names a technique, attach its
   explanatory card.
6. Cap a session's exercise count and length from the learner's stated
   practice budget (default 30 minutes, A-12).

### 6.3 Difficulty annotations

Each piece ships with per-bar annotations produced during authoring: texture
class, pedal difficulty (crossings, wide leaps, double pedal), manual changes,
ornaments, voice count, and a free-text technique tag. The engine uses these
to predict difficulty for a given profile before the learner has played a
bar; the prediction is corrected by attempts.

## 7. Instrument input and feedback

### 7.1 Input channels

MIDI is the primary and, for scoring, the only trusted channel (A-13).

| Channel | Support |
|---|---|
| USB MIDI (class compliant) | iOS via Lightning/USB-C camera adapter, Android via USB host. Required for v1. |
| Bluetooth LE MIDI | Both platforms. Required for v1; latency budget ≤ 20 ms measured, warn above. |
| Network MIDI (RTP) | Nice to have; relevant for Hauptwerk on a computer. |
| Microphone pitch tracking | Not for scoring. Polyphonic organ sound in a reverberant room is not reliably transcribable on a phone. Optional later for single-line exercises. |
| No instrument | Listening, analysis, score study, and memory-by-reading exercises remain available. |

Pedal notes are distinguished from manual notes by MIDI channel. The
instrument profile records which channel each division sends on; a guided
setup asks the learner to press one key on each manual and one pedal (A-7).

### 7.2 Feedback modes

- Live: the score scrolls with the performance; the played note is coloured
  green, red, or amber (early/late) on the staff at the moment it sounds.
  Wrong pedal notes get a distinct marker.
- Post-attempt: a heat map over the bars of the section, a timing plot
  against the beat grid, and the articulation profile for legato passages.
  Tapping a bar replays the learner's attempt against the reference.
- Comparative: overlay of the last three attempts of the same exercise.

### 7.3 Sound

The app can sound the parts it is accompanying (for example the pedal while
the learner plays manuals) through a built-in sampled organ, or send them as
MIDI to the learner's instrument so the real console plays them (A-14). The
built-in sound set is small (one principal chorus, one flute, one reed, one
pedal 16'+8') and is not meant to replace the instrument.

## 8. Score rendering and content format

Scores are stored as MusicXML or MEI and rendered on device (A-15). The
renderer must support: three-staff organ notation, pedal heel/toe glyphs,
manual indications, editorial versus original marking distinction,
bar-level highlighting, and reflow to the device width. Candidates:
Verovio (MEI-native, C++ with mobile bindings), OpenSheetMusicDisplay in a
web view, or a purpose-built renderer. Rendering quality is a product
differentiator for this audience; a web-view solution is acceptable for a
prototype but probably not for release.

Page turning: automatic scroll during live feedback; foot-switch page turn
(AirTurn, PageFlip, generic Bluetooth HID) in read-only score mode.

## 9. Content pipeline

Each lesson is authored, not generated. The pipeline per piece:

1. Source score: public-domain urtext (IMSLP, Bach Gesellschaft, NBA where
   permitted) or a licensed edition (Q-8).
2. Engrave or import to MusicXML/MEI; proofread.
3. Add editorial fingering and pedaling, marked as editorial, by a named
   organist.
4. Segment into sections; write the difficulty annotations.
5. Write orientation commentary and analysis questions.
6. Record or license a reference performance; else render a MIDI reference.
7. Validate: automated schema check plus a play-through by the authoring
   organist on a MIDI console to verify part/channel mapping and tempo
   targets.

An internal authoring tool (desktop web) is in scope; it is not a
learner-facing feature (A-16).

Launch catalogue: roughly 12 to 20 pieces spanning easy to demanding,
weighted towards Bach with Buxtehude, Pachelbel, Brahms chorale preludes,
Mendelssohn, and Franck (A-17). Composers who died after 1955 are excluded
unless a licence is negotiated.

## 10. Platform and architecture

| Layer | Proposal (A-18) |
|---|---|
| Mobile client | One codebase for both platforms. Flutter or React Native are both viable; native MIDI and audio modules are needed either way. Tablet-first layout with phone support. |
| Score renderer | Verovio compiled for the mobile platform, wrapped as a native module. |
| Audio | Native low-latency path (AVAudioEngine / Oboe) for the built-in sounds. |
| Local store | SQLite. Lessons, attempts, profile, and instrument profiles all local. |
| Backend | Content delivery (lesson packages, signed), account and progress sync, catalogue. Small; no real-time component. |
| Sync | Attempts and profile are append-only events synced when online; last-writer-wins on settings. |
| Analytics | Opt-in, aggregated per exercise template for tuning thresholds. |

The adaptivity engine runs entirely on the device so a lesson works offline
and so the selection logic can be unit-tested without a server.

## 11. Non-functional requirements

| Requirement | Target |
|---|---|
| MIDI-to-visual feedback latency | ≤ 30 ms on supported devices |
| Cold start to playable lesson | ≤ 3 s with lesson cached |
| Lesson package size | ≤ 25 MB including reference audio |
| Offline | All learning features after download; sync deferred |
| Accessibility | Dynamic type, screen-reader labels on all non-score UI, high-contrast score theme |
| Languages | English, German, French at launch (A-19) |
| Privacy | Attempts stay on device unless sync is enabled; no third-party trackers |

## 12. Piano extension

The piano release reuses the lesson, exercise, and adaptivity model with
these additions: velocity and dynamics scoring, sustain-pedal usage scoring,
two-staff rendering as default, and a piano skill profile (dynamic control,
voicing within a hand, pedal clarity). Exercise templates specific to organ
(pedal technique, manual change) are hidden for piano lessons. To keep this
path open, the v1 domain model treats "parts" and "divisions" as data rather
than hard-coding RH/LH/pedal (A-20).

## 13. Out of scope for the first release

- Live teacher interaction, video lessons, or a marketplace.
- Composition, improvisation, or harmonisation exercises.
- Hymn playing and service-playing skills (transposition, modulation).
- Social features beyond optional progress export.
- Microphone-based scoring.

## 14. Assumptions register

| ID | Assumption |
|---|---|
| A-1 | Most learners have a MIDI-capable instrument with a pedalboard. |
| A-2 | The app must degrade gracefully to manuals-only and no-instrument use. |
| A-3 | No children, no non-readers, no institutional syllabus in v1. |
| A-4 | Minimal gamification; progress shown in musical terms. |
| A-5 | Learners may override the suggested curriculum freely. |
| A-6 | Heel/toe is taught but scored only by timing unless a sensor exists. |
| A-7 | Manual and pedal identification uses MIDI channel mapping set up once. |
| A-8 | Pass thresholds in section 5.3 are placeholders to tune with data. |
| A-9 | "Secured" requires success on two separate days. |
| A-10 | Skill profile dimensions per section 6.1. |
| A-11 | Tempo step of 4 % of target tempo. |
| A-12 | Default session budget of 30 minutes. |
| A-13 | MIDI is the only scoring input in v1. |
| A-14 | Built-in sound is a small sample set; the user's instrument is preferred. |
| A-15 | MusicXML/MEI stored, rendered on device. |
| A-16 | Internal authoring tool is in scope, learner-invisible. |
| A-17 | Launch catalogue of 12 to 20 public-domain pieces, Bach-weighted. |
| A-18 | Cross-platform client with native MIDI/audio/renderer modules. |
| A-19 | English, German, French at launch. |
| A-20 | Parts and divisions are data, to keep the piano path open. |

## 15. Open questions

Ordered by how much the answer changes the design.

| ID | Question |
|---|---|
| Q-1 | Instrument reality: what share of the intended users can plug in MIDI? If many practise on church pipe organs without MIDI, scoring needs a different strategy and the value proposition shifts to score study and structured practice plans. |
| Q-2 | Entry level: does the learner already play a keyboard instrument, or must the app also teach a pianist the pedalboard from zero? Both are plausible; the second needs a pedal-only onboarding course before any piece. |
| Q-3 | Form factor: tablet-first on the music stand, phone-first in the pocket, or both equally? This decides score rendering priorities and whether a phone-only user gets live feedback at all. |
| Q-4 | Adaptivity control: should the app decide the next exercise silently, propose and let the learner accept, or expose the whole map with a recommendation? |
| Q-5 | Depth of feedback: is note-level live colouring wanted, or is it distracting for this audience and post-attempt analysis suffices? |
| Q-6 | Articulation scoring: how strict, and against which edition's articulation? Historical performance practice differs between editors. |
| Q-7 | Registration: teach it in generic families only, or integrate with Hauptwerk/GrandOrgue and specific console MIDI to switch stops from the app? |
| Q-8 | Editions and licensing: public domain only, or licensed modern urtext editions (Bärenreiter, Breitkopf) with their fingerings? Budget and timeline implications. |
| Q-9 | Who authors: in-house organists, commissioned editors, or a community pipeline with review? |
| Q-10 | Reference recordings: licensed commercial recordings, commissioned recordings, MIDI renders, or none? |
| Q-11 | Sound: should the app ever produce organ sound itself, or always route MIDI back to the instrument? |
| Q-12 | Business model: subscription, per-lesson purchase, one-time purchase, or freemium with a free piece? |
| Q-13 | Teacher role: any teacher-facing dashboard or sharing of attempts with a human teacher? |
| Q-14 | Languages at launch and location of the primary market. |
| Q-15 | Piano timing: design v1 with piano hidden behind a flag, or defer piano entirely to a second product? |
| Q-16 | Existing assets: brand, name, team, preferred technology, budget, target launch date. |
| Q-17 | Analysis content: how much theory (harmonic analysis, form, counterpoint) belongs inside a lesson versus optional reading? |
| Q-18 | Motivation: practice calendar and milestones acceptable, or strictly no gamification? |
