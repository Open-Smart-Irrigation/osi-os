# PocketMaestro: expert panel review, adjudicated (2026-09-06)

Four independent reviewers judged spec draft 0.6, catalogue 0.1, and
architecture 0.2, each from one discipline, without seeing each other's
reports. Their verbatim reports are in [panel/](panel/). This document is the
adjudication: what was adopted for draft 0.7, what needed the product
owner's decision, and what was rejected. The owner accepted all seven
recommendations in section 4 on 2026-09-06 (spec decisions D-41 to D-48),
and the fold-in is complete: spec 0.7, catalogue 0.2, architecture 0.3.

Finding references: P = [organ pedagogue](panel/organ-pedagogue.md),
L = [learning scientist](panel/learning-scientist.md),
E = [mobile engineer](panel/mobile-engineer.md),
S = [product strategist](panel/product-strategist.md), each with the
panelist's own numbering.

## 1. Panel verdicts in one line each

| Seat | Verdict |
|---|---|
| Organ pedagogue | Musically credible in architecture, musically naive in measurement; the scoring layer converts judgment into numbers in organ-hostile ways. |
| Learning scientist | Would plausibly produce learning; the five hardest calls are already right, but the engine optimises the metric its own theory distrusts. |
| Mobile engineer | Shippable by this builder, except the renderer as specified cannot run at all, the alignment breaks on lessons one and two, and the authoring tool is missing from the plan. |
| Product strategist | A viable asset, not a viable business as framed: wrong platform priority, no acquisition mechanism, and tutoring priced at a third of market. |

## 2. Where the panel converged

Independent seats found the same faults, which is the strongest signal the
review produced:

1. **Cut the in-app tutor booking infrastructure** — both externalists chose
   it as their single cut (S-4, E-cut). A hosted scheduler replaces roughly
   100 hours of build and the only server holding learner data.
2. **The 71 % staircase claim is unearned** — L-F3 (nonstationary learner,
   lapse bias, wrong target) and E-F16 (never enough trials to converge)
   arrive at the same conclusion from different fields.
3. **Articulation-versus-one-take scoring fails** — P-F1 (musically wrong)
   and L-F13 (construct validity) and E-F2 (the measurement noise exceeds
   the signal) each kill it independently.
4. **The tuning plan contradicts the privacy plan** — S-F3, E-F9, and L's
   calibration findings all note that constants promised to be "tuned with
   data" have no data path.
5. **Auto Backup instead of manual export** — S-F8 and E-F18.
6. **Timing tolerance must be proportional to tempo, not fixed ms** — P-F4
   and E-F15.
7. **The Hauptwerk/virtual-organ cohort is locked out at launch** — S-F7 and
   P-F17.

## 3. Adopted for draft 0.7

### 3.1 Scoring and musicality

| # | Change | Source |
|---|---|---|
| 1 | Articulation gate replaced: authored touch categories scored as wide bands, consistency across like figures, and release behaviour (repeated-note re-articulation, chord-release synchrony). Reference comparison stays as feedback only. | P-F1, L-F13 |
| 2 | Pass conditions rewritten: pitch as errors-per-bar weighted by voice role; timing tolerance as a fraction of local inter-onset interval with a ms floor, widened at annotated cadences; wrong-pedal-note gate scaled by passage length; precision reported alongside recall. | P-F4, L-F15, E-F4 |
| 3 | Sections flagged metrical or free; free sections score pitch and order only. BWV 565 gets its attribution commentary. | P-F13 |
| 4 | Target tempo becomes a range per section; instrument profile gains an acoustic setting (dry / church / very live) that shifts the ceiling. | P-F14 |
| 5 | Ornaments: one matched item per ornament, excluded from extras and from timing except the start onset; Bach's Explication and agrement tables ship as orientation assets; held-voice trills get authored fingering. | E-F15, P-F15 |
| 6 | Reference defined: the complete take is the interpretive and tempo reference; sectional takes are practice aids. Recording effort re-estimated by grade. | P-F12 |

### 3.2 Alignment and MIDI correctness

| # | Change | Source |
|---|---|---|
| 7 | DP banded in event-index space, semi-global (free head/tail deletions), tempo fitted after, optional second pass. | E-F3 |
| 8 | Chord model: onset-cluster alignment with set matching inside clusters. | E-F4 |
| 9 | Robust tempo fit (median-of-slopes or Huber), minimum matched onsets per knot, monotonicity constraint; three steadiness metrics (evenness, accuracy, stability). | E-F15 |
| 10 | MIDI layer handles couplers (wizard detection plus cross-channel dedup), note-on velocity 0 as note-off, CC/program/active-sensing filtering, multiple simultaneous MIDI devices with per-source part mapping. | E-F13, P-F17 |
| 11 | Timestamps: native provenance required; spike exit criterion is numeric (<= 3 ms RMS inter-onset deviation over 500 note-ons). Primary plan is a small in-house Kotlin Expo module over android.media.midi; the manifest/permission plumbing (uses-feature, USB intent filter, Bluetooth runtime permissions) goes into an Expo config plugin. | E-F2 |
| 12 | RTP-MIDI moves from "later" into B2, or at minimum a documented thru-path for Hauptwerk/GrandOrgue rigs at launch. | S-F7, P-F17 |

### 3.3 Rendering

| # | Change | Source |
|---|---|---|
| 13 | No Verovio on device (Hermes has no WASM). The authoring pipeline pre-renders SVG at fixed widths plus a per-note timemap; the app draws them via Skia as one composited image with a Reanimated cursor overlay. New NFRs: first system <= 250 ms, zero dropped frames in a 60 s sweep at 120 Hz. Rendering acceptance test runs on the Widor and BWV 565 first, where organ notation support is thinnest. | E-F1, E-F6, E-F19 |
| 14 | Follow-my-playing cursor deferred past launch; metronome cursor only. The 30 ms cursor NFR is replaced by the timestamp-accuracy NFR. | E-F7 |

### 3.4 Adaptivity engine

| # | Change | Source |
|---|---|---|
| 15 | The success band becomes a motivational guardrail, raised to 75-90 % early in a cell, relaxing to 65-80 % for consolidation; the staircase is documented as a heuristic ramp, not an estimator; realised success is measured over a sliding window and corrected explicitly. | L-F3, E-F16 |
| 16 | Lapse guard: two consecutive fails to step down, plus a learner-invoked "restart, don't score". Down-steps suppressed in the last minutes of a session and after the third consecutive attempt on a cell. | L-F3, L-F14 |
| 17 | Practice structure becomes a first-class parameter: blocked on first exposure, interleaved (rotate 3-4 active cells) once in progress, random among passed cells; hard cap of 3 consecutive attempts per cell; the variety guard becomes an interleaving policy over cells. | L-F2 |
| 18 | Retention probes move to section level (full texture), get a budget share of at most 25 % of session minutes, and the interval cap rises to 90-180 days; a passed probe feeds mastery. Part-level decomposition only as a diagnostic after a failed section probe. A warm-up cell precedes the first probe of a session. | L-F4, P-F16 |
| 19 | Feedback fades: full analysis on first exposure, then one-line verdict with detail on request and a summary every third attempt; before the heat map is revealed the learner taps where they think the errors were. | L-F5 |
| 20 | Part practice rebalanced: segmentation (short span, all parts) becomes the primary simplification; full texture unlocks at passed, not secured, isolation; progressive-part is the stated pairing rule; a short full-texture segment appears early in every section. | L-F6, P (verdict) |
| 21 | Difficulty becomes a small ordered ladder mixing tempo, passage length, and part combination; the tempo floor rises to ~75 % for material annotated rate-dependent; slow work is reframed as an accuracy drill, not staircase evidence. | L-F7 |
| 22 | The nine-dimension skill profile is cut. Cold start becomes: 70 % of target tempo, or the learner's achieved tempo on cells sharing annotation tags (nearest neighbour over stored attempts). The profile screen goes with it. | L-cut, L-F8 |
| 23 | Self-assessment rebuilt: behaviourally anchored rating criteria; pre-attempt prediction plus post-attempt rating with the gap shown; a delayed judgment at probe time; MIDI users give the same ratings before seeing their analysis, which produces the calibration data that maps ratings to scores; measured bias is subtracted, not damped. | L-F1, L-E1, L-E5 |
| 24 | Self-assessed track gains ear training: phone-mic recording for playback comparison (never scoring) with targeted listening prompts, and A/B ear-calibration items on the answer-key machinery. This also closes the legato hole. | P-F7, P-E2 |
| 25 | Emulator gains a learning rule (skill gain, day-scale forgetting, spacing term) so CI can compare scheduling policies; new assertions that can fail: probe load bounded, no monotone tempo ratchet, no infinite oscillation, attempt cap respected. A RecordedMidiSource replays real console captures as the scoring fixtures; the emulator remains the adaptivity simulator. Simulation is documented as validating mechanism, not pedagogy. | L-F9, L-E3, E-F14 |
| 26 | Loop drills gain one-tap failure-cause tagging (wrong note / coordination / reading / fingering-pedaling / tempo), and the engine's response differs by cause. | L-E4 |
| 27 | The weekly goal becomes sessions per week; minutes stay as a statistic. Per-piece achievements are never shown before they are earned and are framed retrospectively. | L-F11, L-F12 |
| 28 | The beta runs one real within-subject experiment: blocked versus interleaved scheduling across two comparable lessons, 7-day delayed retention as the primary outcome. | L-E2 |

### 3.5 Content and catalogue

| # | Change | Source |
|---|---|---|
| 29 | Source hierarchy declared: autograph or composer-supervised print first; 19th-century collected editions only where nothing earlier survives; Peters excluded as engraving source; exact source, date, and plate recorded in the manifest; the Widor issue named. | P-F6 |
| 30 | Pedal technique becomes two axes (alternate-toe early / heel-toe modern) with two editorial layers per piece where defensible, selected by style and the learner's declared pedalboard type. This is also the product's signature feature. | P-F2, P-E1 |
| 31 | Bench-and-posture one-time setup (propped-phone side-on photo against a rubric); pedalboard type recorded and driving which pedaling layer is shown; onboarding says plainly what a first tutor session is for. | P-F3 |
| 32 | The ladder gets a true grade 1 (L'Organiste, Walther/Pachelbel chorales, manualiter movements, four-part settings with slow pedal); BWV 639 is regraded honestly and kept as the free lesson's goal with a pedal-orientation on-ramp drawn from its own pitch set. Pachelbel to grade 3, pedal required, sectioned by variation groups. Mendelssohn titled as the movement it is, with commentary on the rest. Sight-reading template removed from lessons (an unseen corpus may return later). | P-F5, P-F9, P-F10, P-F11, L-F13 |
| 33 | Memory template replaced by a continuity template: cold-start play-through without stopping, recovery points every two bars, a second repertoire column ("played through cold"). Score-hiding survives only as an opt-in variant. Adjudication note below. | P-cut, L-F10 |
| 34 | Registration model extended: couplers, swell box, tremulant, a change timeline, three archetype recipes per piece with short audio demos, and a balance procedure. An acoustic switch (three convolution presets) on the built-in sound makes articulation-versus-room audible. | P-F8, P-E4, P-E3 |
| 35 | Catalogue strategy: depth in grades 1-3 before anything at grade 5; the BWV 565 pedal solo ships early as a free standalone exercise (~6 h) serving store screenshots and video; grade 5-6 full lessons come later. | S-F6, S-E3, P-F5 |
| 36 | Authoring pipeline: MuseScore is the source of truth, a CLI produces MEI + pre-rendered SVG + timemap, and the authoring tool shrinks to an annotation editor over the rendered score (~40-60 h), explicitly scheduled before B1. Engravings are bought or taken from CC0 community sources where licences allow. | E-F5, E-E1, E-F20 |

### 3.6 Platform and operations

| # | Change | Source |
|---|---|---|
| 37 | Android Auto Backup (with WAL checkpoint and sidecar exclusion) is the loss protection; the manual export remains as the portable migration path. Note: Auto Backup's ~25 MB quota must be checked against the database growth curve — attempt-event pruning likely keeps it inside, but it is a real limit. | S-F8, E-F18 |
| 38 | Local scheduled notifications (no server); an email opt-in for "new lesson" announcements that doubles as the future account-migration hook; opt-in beta telemetry posting compact per-attempt rows; the engine constants module served over EAS Update so tuning is an OTA publish. Together these close the "tune with data" contradiction. | S-F3, E-F9, E-E4 |
| 39 | Sentry (EU region, no PII) and expo-updates from B1. | E-F10 |
| 40 | Package integrity reworked: detached signature verified over the zip bytes before extraction, streaming native SHA-256, native unzip, zip-slip path validation, two pinned keys with key_id. | E-F11 |
| 41 | Built-in sound becomes a wavetable synth per stop family (kilobytes, no licence exposure) instead of a sample set; a one-time audio offset calibration in Setup; the metronome uses a lookahead scheduler, never setTimeout. | E-F12, E-E3 |
| 42 | Schema fixes: package_version on attempts, per-section revision hashes with a reset rule, scoring/thresholds versions on attempt_scores, primary keys and indexes named, integer millisecond timestamps, WAL and foreign keys enabled explicitly; the rebuild claim restated over attempt_scores and part_ratings; achievements excluded from rebuilds. | E-F8 |
| 43 | Week-1 console trip: the builder is the organist — one two-hour visit with a capture screen answers timestamps, channels, couplers, and cabling, and produces the first real fixtures. Gate G1 remains as the full pre-B2 validation. D-39's emulator-first stance stands for daily work. | E-F14 |
| 44 | Setup guide notes: powered OTG hub or BLE when charging is needed; battery drain NFR line; C-to-B cable procured before the console trip. Console make/model recorded in the instrument profile. | E-F17, E-E5 |
| 45 | D-1 (60 % MIDI) is demoted to an assumption and measured at tester recruitment with one question; the self-assessed track is presented as first-class ("works on any organ, MIDI optional"), not as a fallback. | S-F7 |
| 46 | Store title carries the category ("PocketMaestro: Organ" / "Orgel lernen" on the DE listing); trademark search (IGE + EUIPO) before design hours are spent on the name. Play policy verified for the current closed-test tester count; an organization Play account via Einzelfirma + D-U-N-S is prepared in week 1, which also gives R-1 its clean invoicing answer. | S-F10, S-F9, E-F19 |
| 47 | Learner-request voting ("I want to learn this") ships at B3, feeding the authoring queue and the email opt-in. | S-E5 |

## 4. Decisions that belong to the product owner

These change interview decisions or spend money; the panel's case and my
recommendation are stated, the call is not mine.

1. **Tutor sessions (changes D-19, D-31).** Both externalists say the same
   thing: keep the offer, cut the build. Recommendation: hosted scheduler
   (Cal.com class, EU-hosted) behind a button, price CHF 150 for 90 minutes,
   2 slots per week, manual invoice; build in-app booking when bookings pass
   eight a month. This also deletes the only learner-data server and defers
   most of risk R-1.
2. **Platform order (challenges D-33).** The strategist's case: the money,
   the iPad-on-the-music-desk culture, and forScore all live on iOS, and
   CoreMIDI is the best-trodden MIDI path in mobile music, so Android-only
   may cut the observable market below decision threshold. Recommendation:
   keep Android as the build platform, but spend three spike days and USD 99
   verifying the same code on an iPhone/iPad, pull the tablet layout into
   B3, and decide iOS timing on the spike's evidence rather than now.
3. **Pricing (changes D-27).** Anchor the value against a teacher hour, not
   a catalogue ("CHF 96 a year is less than one hour with an organ
   teacher"). Recommendation: CHF 15 monthly / CHF 96 annually with annual
   preselected; never show piece counts in marketing.
4. **Launch scope (touches D-28).** With BWV 639 regraded and a true grade 1
   inserted, "six pieces, grades 1-4" is no longer the shipped ladder.
   Recommendation: launch = free lesson + three to four lessons deep in
   grades 1-2, plus the free BWV 565 pedal-solo exercise; the engineer's
   arithmetic (11-15 months total as previously scoped) argues for the
   smaller catalogue and a bought engraving pass.
5. **Distribution budget (touches D-32).** The strategist's blocker: nothing
   in the plan puts anyone on the store page. Recommendation: 4 of the 20
   weekly hours go permanently to distribution — C-Ausbildung cohorts, GdO/
   AGO chapters, and one YouTube film per authored lesson recorded in the
   same session as the reference take. Tester recruitment happens inside
   those channels.
6. **Growth mechanics (new).** Institutional seat pricing (CHF 60/seat/year,
   10+), a capped founding-member lifetime tier (~CHF 249, first 150), or
   neither — these are business-model additions the panel proposed and only
   the owner can want.
7. **Name (touches D-16/D-24).** Keep PocketMaestro with a category suffix,
   or revisit the name in the Claude Design exploration with the trademark
   search done first.

## 5. Rejected or deferred, with reasons

| Item | Disposition |
|---|---|
| Simultaneous iOS launch (S-F1 as stated) | Deferred to owner decision 2; the spike evidence should precede a platform reversal, and D-33 stands until then. |
| Scheduled score-hiding as the retrieval mechanism (L-F10 taken literally) | The pedagogue's objection is decisive for organists (eyes leave the page, go to the feet). The continuity template preserves the retrieval function — cold-start performance is retrieval — without the harmful cue. Score-hiding stays as opt-in only. |
| Cutting the MIDI scored track (raised and rejected by S) | Rejected for the strategist's own reason: it is the differentiation. |
| Microphone-based scoring | Stays out; every seat that touched it agreed. Mic recording for playback (adopted #24) is a different feature. |
| Four-dimension reduced skill profile (L-F8 fallback) | Not taken; the full cut (#22) with nearest-neighbour cold start is simpler and does the same job. |
| In-app booking build | Formally the adopted cut in owner decision 1. |

## 6. Adjudicator notes on panel conflicts

- **Memory versus retrieval (P-cut vs L-F10).** Both are right in their own
  frame. Resolution: the continuity template is retrieval practice for
  score-reading musicians; the score-hiding mechanic, not retrieval itself,
  is what the pedagogue objects to. Adopted as item 33.
- **Emulator-first versus console-now (D-39 vs E-F14).** The premise "no
  organ available" conflated *at the dev site* with *accessible*. The
  builder is an organist; one visit produces the fixtures the emulator
  cannot. Both stances survive: emulator for daily work and adaptivity
  simulation, recorded real captures for scoring truth.
- **The staircase.** The learning scientist attacks the target and the
  convergence claim; the engineer attacks the sample size. Neither attacks
  the mechanism as a ramp. Adopted as items 15-16: keep the ramp, raise the
  band, delete the convergence language, guard the lapses.
- **Panel claims to verify before relying on them** (each plausible, none
  verified here): the current Play closed-test tester count (12 vs 20); the
  Auto Backup quota against our database size; Skia's SVG handling of
  Verovio output; CC0 status of specific community engravings; Cal.com EU
  hosting terms; the exact Apple 3.1.3(d) and Play external-services
  wording if in-app booking ever returns.
