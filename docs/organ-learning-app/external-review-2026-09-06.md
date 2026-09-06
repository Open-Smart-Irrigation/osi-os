# External design review (verbatim, received 2026-09-07)

Provenance: independent external reviewer's report dated 2026-09-06,
delivered by the product owner on 2026-09-07. Verbatim external content
(text encoding repaired); the adjudication is in
[external-review-consolidation-2026-09-07.md](external-review-consolidation-2026-09-07.md).

---

Review date: 6 September 2026. Record reviewed: spec 0.7, catalogue 0.2, architecture 0.3, the adjudication, and all four verbatim panel reports. No application code exists. The source documents have not been changed.

## Judgment

Proceed with a tightly bounded feasibility spike after correcting the scoring and progression contracts. Do not treat the current record as an implementation-ready freeze.

The revised practice structure is a reasonable starting policy. Its remaining weakness is the meaning of the evidence it consumes: what the instrument actually reveals, what counts as a qualifying performance, and what self-ratings can establish. The commercial proposition is plausible for an early paid cohort; the record does not establish that four paid lessons sustain an annual subscription.

I retain Android first, device-local learning state, MIDI scoring, the complete self-assessed route, public-domain musical sources, and German/English launch. I do not reopen the panel's cuts to the skill dashboard, microphone scoring, default score-hiding, or in-app booking. Where I challenge an accepted decision, I say so below.

Costs are my rough founder-hour estimates, including ordinary verification. They are not supplier quotes. "Specify" means work before implementation; "deliver" means implementation or operational work later. Many fixes complete already-promised features and should replace their current estimates, rather than simply being added on top. Shared work is identified where relevant.

A blocker prevents the named milestone from honestly satisfying its contract. A major finding affects learning validity, dependable operation, or the business promise. A minor finding is bounded and inexpensive to correct. Ranking follows the risk to the core product first, then the later launch gates.

## Ranked findings

### F01 — Blocker before scoring design: a MIDI channel is not a hand

**Location:** spec §§4, 5.2, 7.1; architecture §§5.2, 9. **Panel relationship:** items 10 and 43 address mapping and couplers, but do not resolve what cannot be observed.

The learner-facing parts are RH, LH, and pedal. The splitter assigns parts by device and channel. When both hands play one manual, that channel contains both hands. Exchanging the hands assigned to an overlapping pitch can produce the same MIDI stream; a channel wizard cannot recover the missing information. This matters immediately for the manualiter Brahms lesson. The same-pitch, near-simultaneous coupler rule can also erase a real unison played on two manuals.

**Fix:** separate musical voices, hands, physical manuals, and observable MIDI streams. Store instrument capabilities. Score a combined manuals part when hand attribution is ambiguous; retain individual hand self-ratings and score genuine isolation exercises. De-duplicate only supported, observed coupler routes. If a console cannot distinguish physical presses from coupled echoes, request an uncoupled MIDI configuration or disable the affected dimension. Ambiguous input must produce "not measured," never a fabricated hand score.

**Cost:** specify 2-3 h; deliver capability flags, fallbacks, and discriminating fixtures 8-14 h. Add same-manual two-hand playing and genuine cross-manual unisons to the existing console visit.

### F02 — Blocker before schema freeze: progress has no defined qualifying performance

**Location:** spec §§4, 5.3, 6, 10; architecture §§4, 6. **Panel relationship:** new interaction between items 20-23 and 42.

A cell is section x part configuration, yet its difficulty ladder can change the part configuration and the span. The record does not say whether a two-bar success passes an eight-bar cell, how changing parts changes the cell being updated, or which tempo/rung is required for "secured." An EMA pools outcomes from tasks of different difficulty without defining the performance that its state certifies. Separate-day counting does not repair this ambiguity.

Rebuilding states also requires the adaptivity and calibration rules used at the time. Scoring versions are recorded, but there is no specified calibration version, adaptivity version, or frozen state checkpoint at a version boundary.

**Fix:** keep immutable attempts with exact bar span, parts, tempo, assistance, evidence type, instrument-profile revision, and relevant policy versions. Define an authored qualifying task for each cell: its whole span, stated parts, and an acceptable tempo range. Shorter or easier exercises guide practice but cannot pass that qualifying task. Changing parts targets another cell. Retain the accepted two/three separate-day rule provisionally, applied only to qualifying performances. Store dated achievements separately from current review status. Define checkpoint/migration behavior when a policy changes.

**Cost:** specify 4-6 h; deliver 12-20 h. This is foundational work inside the existing state engine, not another engine.

### F03 — Major before calibration claims: the proposed data cannot establish the proposed correction

**Location:** spec §5.3, A-1, A-5, A-6; architecture §§6, 10, 11. **Panel relationship:** residual defect in adopted items 23, 24, 28, and 38.

For a learner without MIDI, prediction and post-attempt rating are both self-reports. A zero gap can mean accurate judgment or consistent overconfidence. It cannot identify systematic performance bias. MIDI-user ratings provide a possible population mapping, but the record supplies no evidence that it transfers to non-MIDI instruments, rooms, or learners. Listening discrimination and evaluation of one's own playing are also different tasks.

The telemetry row omits predictions, ratings, delayed judgments, and calibration version. Rows have no learner linkage or within-person aggregate, so the specified endpoint cannot support either the mapping or the paired retention experiment. Locally collected fields do not solve a missing analysis path.

**Fix:** keep the useful prediction exercise, but distinguish prediction error from measurement error. Use ratings as explicit reports at B1; do not subtract an individual's "bias" without independent evidence. Add paired rating/score aggregates computed on device and consented exports for the study. Validate a small set against a consistent teacher rubric, including non-MIDI recordings. Freeze the scorer before fitting the mapping; evaluate on held-out learners. Define the scale being mapped and avoid applying both a learned correction and a second subtraction of the same bias.

**Cost:** specify 3-4 h; deliver revised capture/aggregate export 6-10 h; initial teacher-reviewed feasibility study 12-20 h plus participant practice time. This is exploratory calibration, not proof of population validity.

### F04 — Major before claiming complete-piece learning: section mastery never becomes a tested whole

**Location:** spec §§1, 4, 5.2, 8, 10; architecture §§6, 9, 11. **Panel relationship:** item 33 adds Continuity, but does not define lesson completion or transitions between sections.

Exercises target individual sections and are described as 2-16 bars. Retention probes are also section-level. The repertoire list nevertheless records a completed lesson and a cold play-through. There is no rule for testing the joins, carrying a registration change across a boundary, or completing a piece longer than one exercise. Passing every isolated section does not demonstrate uninterrupted performance of the work.

**Fix:** author overlapping boundary exercises using the last bars of one section and the first bars of the next. Define a complete-piece Continuity task, with a stable repeat plan and score navigation. Separate "all sections practised" from "whole piece played through." Permit a full self-reported completion on the non-MIDI route, with recording optional. A click-free performance must be possible; it can use a chosen starting tempo without being paced throughout by the app.

**Cost:** specify 2-3 h; deliver 8-14 h reusing the player; boundary authoring/QA 0.5-1 h per lesson. Shared rendering work with F13 should be counted once.

### F05 — Major before B3: the adaptivity rules need precedence, not more constants

**Location:** spec §§5.2, 5.3, 6; architecture §§6-7. **Panel relationship:** contradictions introduced or left by items 15-18 and 21-23.

Four examples make the issue testable:

- Spec §6 steps down on a learner-marked restart; architecture §6 says never. Continuity says a restart fails.
- Default cold start is 70% even where the ladder floor is about 75%. The record does not choose a short qualifying rung or a separately labelled slow drill.
- The staircase and a second success-band correction can both change difficulty. Their precedence, minimum sample, window membership, and action are absent.
- The highest rating describes two performances, while an Attempt is one performance and the cap counts attempts. It is unclear how many repetitions the learner has actually done.

The three-attempt cap also has no fallback when only one cell is eligible. Late-session suppression can keep presenting work that is too hard. Probes can be contaminated if the preceding warm-up rehearses the same material.

**Fix:** write an ordered transition table. Technical interruptions invalidate an attempt; an abandoned practice take supplies no pass and resets any pass streak; a musical restart on a valid Continuity/probe attempt fails that test. Record all elapsed practice. Use single-performance rating anchors. Define streaks over qualifying attempts at the same rung, including after interleaving. Keep one difficulty controller. I would make success bands diagnostic during beta, with persistent difficulty triggering a learner choice, rather than a second automatic controller. This explicitly challenges the panel's mandatory band-correction rule. Warm up on unrelated material; specify a one-cell exception and a safe session-end response.

**Cost:** specify 3-4 h; transition fixtures and implementation 6-10 h. Do not treat these estimates as separate from F02 where the same transition code is involved.

### F06 — Major before committing dates: the revised effort model still contradicts itself

**Location:** catalogue §§3-5; spec §§13-15.2; architecture §11. **Panel relationship:** verification of the adopted scope and revised authoring model, not a repeat of the old missing-tool finding.

The launch table adds to 65 h. The detailed model says 21-26 h for an average complete lesson. Applying that model to five complete lessons plus the 6 h demo gives 111-136 h. Short pieces can cost less, but the record does not identify which tasks disappear or shrink enough to reach its 10-14 h lesson estimates. Bought engraving only explains one line of the budget; it does not remove bilingual commentary, ear items, recordings, or validation.

Five further lessons in the first quarter also exceed the stated one-per-month sustainable cadence. At the detailed rate, they consume about 8-10 h/week across thirteen weeks. After 4 h distribution, 3 h of fully booked tutoring, and a proposed 2 h operations reserve, only about 1-3 h/week remains for engineering, before tutor preparation. Separately, two spike weeks contain 32 build hours, not 40. "Three iPhone days" has no hour definition, and the CoreMIDI twin is otherwise deferred to the port.

**Fix:** time the first complete lesson through the pipeline, including bilingual proofreading and all promised audio assets. Re-estimate by task and specific piece; make the quarter-one list a prioritised queue until capacity is demonstrated. Convert spike days to hours and name the iOS MIDI deliverable. Reserve operations explicitly inside the 20 h total.

**Cost:** 3-4 h of planning; timing the already-planned free lesson adds little work. A representative two-bar authoring slice can be tested in the spike but cannot validate whole-lesson recording effort.

### F07 — Major before locking the ladder: the new first rung contains a factual error

**Location:** catalogue §§1-3; spec §9. **Panel relationship:** not caught by the panel's regrading.

Brahms op. 122 no. 8 has no pedal part. I inspected both pages of the specified Simrock first edition: the work is written for manuals, with manual-change indications, not the advertised quiet slow pedal line. This is a good candidate for manual legato teaching, but it cannot supply the pedal rung described in the table. [Simrock first edition, p. 10](https://brahmsinstitut.de/Archiv/web/bihl_digital/jb_erstdrucke/op_122_h2_s_010.html), [p. 11](https://brahmsinstitut.de/Archiv/web/bihl_digital/jb_erstdrucke/op_122_h2_s_011.html).

The other grade-1 entry is still an unspecified Franck piece. Its added simple pedal bass needs to be identified as the app's editorial arrangement if it is absent from the selected original. Thus the exact complete work that supplies the first genuine pedal step is still uncommitted.

**Fix:** retain Brahms as manualiter and label its outcomes accurately. Select the exact Franck work, edition, bass treatment, and intended first-pedal outcome, or replace one paid slot with a verified easy pedal work. This need not expand the catalogue. Also correct BWV 553's unqualified Bach attribution: the publisher describes the set as formerly attributed to him. This is a small metadata/content correction distinct from the pedal problem. [Baerenreiter's catalogue](https://www.barenreiter.co.uk/eight-short-preludes-and-fugues-bwv-553-560-formerly-ascribed-to-johann-sebastian-bach-organ.html).

**Cost:** 3-5 h for source checks, selection, grading, and metadata; full authoring stays in the existing lesson budget. A replacement is one-for-one.

### F08 — Blocker for the institutional tier at B3: offer codes do not specify institutional seats

**Location:** spec §§12, 14-15, D-46; architecture §§10-11. **Panel relationship:** tests the mechanism underlying accepted owner decision 6.

Play subscription promo codes provide trials. Redemption requires a payment method and leads to an auto-renewing subscription. That is not, by itself, an institution purchasing ten annual seats for CHF 600. Discount offers are another mechanism, but neither mechanism supplies cohort eligibility, seat reassignment, or institution-paid renewals automatically. [Google Play promo-code documentation](https://developer.android.com/google/play/billing/promo).

**Fix:** distinguish an individual cohort discount from a bulk-paid institutional licence. Define the payer, store product, eligibility check, redemption, term, renewal price, refund route, and reassignment policy, then prove the exact route in a billing sandbox. Billing records can remain with the billing provider; learner progress need not leave the phone. Until that route is demonstrated, recruit through institutions using ordinary individual subscriptions and quote no seat entitlement the app cannot deliver. This challenges D-46's unconditional B3 commitment, not institutional distribution.

**Cost:** 2-3 h to specify; 4-8 h for a mechanism prototype. Any custom redemption administration must be estimated after this proof; it is not "no code." Do not author a seat-management system during the spike.

### F09 — Major before paid release: anonymous purchase recovery and offline access have no lifecycle contract

**Location:** spec §§12, 15-16, A-7; architecture §§4, 10. **Panel relationship:** an unresolved gap beyond the panel's advice to write an entitlement policy.

Fourteen days can mean fourteen days after last verification or after a known expiry. Those behave differently for an annual subscriber abroad. Cancellation, failed renewal, refund, lifetime access, reinstall, and an imported progress file also require different treatment. A newsletter email is neither an authenticated identity nor proof of purchase. It cannot bind a future iOS entitlement by itself.

**Fix:** publish and implement the state table in this report's commerce section. Provide a user-triggered restore path, choose RevenueCat's transfer behavior deliberately, and make lifetime a non-consumable if retained. Use store evidence for entitlement; importing progress never imports access. Keep newsletter consent separate from future account creation, and bind purchases through a verified store transaction when that account is created. Test the selected SDK version: cached customer information alone is not a specification of a 14-day policy. [RevenueCat restore behavior](https://www.revenuecat.com/docs/getting-started/restoring-purchases), [caching documentation](https://www.revenuecat.com/docs/test-and-launch/debugging/caching).

**Cost:** specify 3-4 h; implement and test lifecycle cases 12-20 h, excluding any institutional custom service. Some cases belong to the baseline billing integration.

### F10 — Major before privacy copy or vendor commitment: the stated processing boundary is false

**Location:** spec §§15-16; architecture §§1, 10. **Panel relationship:** new check of the adopted vendor combination.

"Nothing server-side knows a learner exists" is incompatible with RevenueCat customer IDs and purchase records, the newsletter, crash reporting, and the explicitly consented research path. The narrower promise that PocketMaestro has no hosted learner-progress database is achievable. An unconditional Swiss/EU-only processing claim is also incompatible with the documented standard RevenueCat arrangement: its August 2026 DPA lists US infrastructure and logging subprocessors. [RevenueCat DPA, Annex 3](https://www.revenuecat.com/dpa).

**Fix:** write a short data inventory covering progress, backups, billing identifiers, diagnostics, research summaries, email, and tutoring. For each, state processor, purpose, retention, transfers, consent where applicable, and deletion route. Either change the absolute regional claim to an accurate description with assessed transfers or choose a service that meets the strict boundary. This explicitly challenges the current Swiss/EU-only NFR; it does not require accounts or a hosted progress service. Inspect an actual scrubbed crash report before claiming that a SDK option removes every identifying field.

**Cost:** specify/review 4-6 h; configuration and diagnostic inspection 3-5 h; specialist review fees additional if needed. This overlaps the existing privacy-policy work.

### F11 — Major before developer enrollment: an organization account does not hide its address

**Location:** spec §15.1; panel adopted item 46 and strategist F9. **Panel relationship:** a factual premise adopted without verification.

Google says organization profiles display their legal address. If that address is the founder's home, establishing an Einzelfirma and obtaining a D-U-N-S number does not conceal it. Google also says obtaining a D-U-N-S number can take up to 30 days. [Google's account requirements](https://support.google.com/googleplay/android-developer/answer/13628312?hl=en).

**Fix:** decide which genuine, verifiable business address will be published and verify that the proposed entity qualifies for the selected account type. Keep the Einzelfirma plan if appropriate; remove the privacy guarantee. For the later port, Apple explicitly directs sole proprietors to individual enrollment. Registration also does not settle the VAT questions in R-1. [Apple enrollment rules](https://developer.apple.com/help/account/membership/program-enrollment/).

**Cost:** 1-2 h to correct the plan and prepare verification; address arrangements, registration, and professional fees additional. Waiting time is not founder work time.

### F12 — Major before B1: ninety-day pruning is not a backup-size strategy

**Location:** spec §15, A-8; architecture §§4, 13. **Panel relationship:** direct examination of an explicitly unverified panel assumption.

Auto Backup's ordinary cloud quota is 25 MB; when the app exceeds it, cloud backup stops. I created a synthetic SQLite event table with the specified composite key and plausible field types. Ninety days x twenty minutes actually playing per day x three note-ons/second, with corresponding note-offs, produced 648,000 rows and a 58.82 MiB file. That excludes every other table and recording. This is a sizing scenario, not a measurement of nonexistent app code; it disproves the idea that a 90-day cutoff inherently makes the database small. [Android Auto Backup](https://developer.android.com/identity/data/autobackup).

**Fix:** keep durable progress in a small database, and raw MIDI/audio in a separately capped store excluded from automatic cloud backup. Define local byte limits and retention for recordings. Exclude downloaded lessons as well. Back up the needed billing preferences, verify a consistent snapshot/restore after abrupt termination, and explain what the portable export includes. Make quota and restore tests a B1 gate; do not promise that every Android device always restores automatically.

**Cost:** specify 2 h; storage separation and restore/quota checks 6-10 h. The reproducible sizing method is appended below.

### F13 — Major before content-schema freeze: rendered scores and adaptive tasks have no complete joining contract

**Location:** spec §§5.2, 8-9; architecture §§3, 5.1, 8, 12. **Panel relationship:** consequences of the adopted pre-rendered approach, not a request to restore on-device engraving.

The package names width-specific SVGs and per-note positions. It does not define how an excerpt beginning inside a rendered system, a changed pedaling layer, a loop/repeat occurrence, and a multi-system performance select their assets and time origin. These are ordinary exercise cases. Tied notes or accompaniment already sounding at an excerpt boundary also need an explicit rule. One successful static Widor render does not test this contract.

**Fix:** keep the fixed rendering approach and restrict generated tasks to authored legal boundaries. Choose fixed full-texture systems for launch; provide separately rendered pedaling variants or separately composited annotation layers. Add stable note/bar IDs, variant/system IDs, excerpt offsets, and occurrence mapping for repeats. Define boundary-note handling for playback and scoring. Run one two-bar slice through MuseScore -> package -> both editorial variants -> phone -> loop -> analysis. Add a dense rendering stress excerpt separately.

**Cost:** specify 2-3 h; prototype/implementation 8-14 h. The spike slice covers part of this; whole-piece navigation overlaps F04. If the prototype is costly, reduce variant freedom rather than build a notation engine on the phone.

### F14 — Minor: the acoustic switch promises a transformation that convolution cannot supply

**Location:** spec §7.4; panel item 34. **Panel relationship:** a new problem when the adopted acoustic demo is applied to microphone recordings.

A microphone recording made in a reverberant church already contains that room. Applying a dry preset cannot remove the recorded reverberation; adding another room layers more reverberation on top. The same issue affects the captured reference audio. A dry MIDI resynthesis can support the three-way demonstration, but it is a reconstruction with a different instrument sound.

**Fix:** apply the acoustic switch to synthetic demonstrations and clearly labelled MIDI reconstructions. Play microphone/reference audio in its original acoustic. Do not add dereverberation to scope.

**Cost:** specify 0.5 h; labels and signal-routing distinctions 2-4 h within existing audio work.

### F15 — Minor: the complete frozen record depends on missing decisions

**Location:** spec §18 and references to D-1-D-40; spec §20.

Section 18 preserves earlier decisions "as recorded in draft 0.6," but that draft and the actual D-1-D-40 table are absent from the supplied complete record. Some decisions can be inferred from the body; that is not an authoritative conflict-resolution rule for a coding agent.

**Fix:** include a compact current decision table with superseded entries marked, or remove unresolved historical references and make the current body authoritative. Give each new open item a gate, evidence required, and fallback. Prefix architecture assumptions separately: its A-1 means something different from spec A-1.

**Cost:** 1-2 h. This prevents repeat clarification rather than adding product scope.

## The learning policy I would freeze

The panel improved the direction: segmentation, early full texture, capped repetition, spaced checks, and learner control now have explicit roles. I would retain those roles. I would not describe the numerical bands, EMA weights, or day counts as validated organ-learning parameters. Wilson et al.'s often-cited 85% result concerns specified learning algorithms in binary classification; it does not establish an organ-performance pass-rate optimum. [Wilson et al., 2019](https://www.nature.com/articles/s41467-019-12552-4).

The smallest coherent policy needs the following distinctions. The work is included in F02/F05, not an additional feature estimate.

| Case | Evidence and response |
|---|---|
| Short segment or slow accuracy drill | Guides practice selection. Does not secure the full section or establish its performance tempo. |
| Qualifying full-span attempt | Updates that exact cell's pass evidence at its declared acceptable tempo and assistance setting. |
| Parts added or removed | Targets a different cell; easier-cell history informs a starting recommendation but does not transfer a pass. |
| Two consecutive qualifying passes at one rung | One upward step. Persist that rung's streak across interleaving; reset it after a rung change. |
| Two genuine failures at one rung | One easier recommendation, or a diagnosed short drill; never two separate controllers acting on the same result. |
| Technical interruption or incomplete capture | Preserve diagnostics and time spent; do not infer musical failure or success. |
| Abandoned ordinary practice attempt | No pass; no automatic staircase down-step; reset the pass streak. Retain its duration and abandonment marker. |
| Restart during a valid probe/Continuity test | Fails that test. A restart is not free evidence of continuity. |
| Due probe | Same declared full-texture target, after unrelated warm-up. Budget includes count-in, prediction, performance, and response time. |
| More probes than fit | Use a deterministic overdue/interval rule initially; the current record has no specified recall predictor. Defer overflow without lowering the test target. |
| Fewer than three eligible cells | Rotate what exists; allow an explicit exception or end the session. Do not invent meaningless exercises to satisfy the cap. |
| Very late failure | Offer a simpler drill or end the session. Suppressing the state down-step must not force repeated failure at the same difficulty. |

Two additional invariants matter. First, successful alignment of a short fragment is not successful completion of the requested passage. Pitch recall must use the required expected content, and full-span coverage must be checked independently of free head/tail alignment. Second, confirm which MIDI streams are available before deciding that silence means a missed part. Technical uncertainty and musical failure have different downstream effects.

For securing, keep the accepted two scored days / three self-reported days as provisional policy, with the evidence type visible. Define the mixed case explicitly: connecting MIDI cannot retroactively upgrade earlier reports into measured evidence. An instrument change should request a short setup check and begin collecting evidence for the new setup while preserving the historical achievement.

The blocked/interleaved study needs a written protocol, not just a config flag. Counterbalance lesson-to-condition assignment and order; measure baseline performance; hold exposure and test conditions comparable; record intervening practice; keep scoring, thresholds, calibration, and policy versions fixed. Compute the within-person outcome on device and export the paired summary, or use the existing consented manual-export route. No permanent server learner ID is necessary. Twenty participants is a feasible pilot, but "adequate" power cannot be asserted without an effect size, variability, and attrition assumption. Report uncertainty and use the pilot to choose the next experiment. **Protocol and analysis cost: 6-10 h, sharing collection work with F03.**

## A complete self-assessed product

The self-assessed route should help someone practise better even if its ratings never become interchangeable with MIDI scores. A comprehensible task, a useful model, a way to hear and diagnose a problem, and a sensible next exercise are already valuable.

For B1, use three single-performance anchors describing observable events: stopped/corrected; continued with identified problems; continued and met this exercise's stated criterion. Ask about only the parts being practised, and provide "not sure." Teach pitch/continuity judgments separately from touch and release judgments. A confident wrong performance must not automatically receive a universal "secure" label merely because it did not stop.

Prediction is a reflection prompt. On the self-assessed route, label its comparison as prediction versus self-report. The A/B listening tasks test discrimination of the authored examples; they do not establish a numerical correction for the person's entire practice history. A low listening score should prompt another example or an easier listening task, not secretly reduce unrelated keyboard scores.

Test recording at the actual console position, including loud registrations, clipping, background noise, and playback audibility. Keep recording optional. Refusing microphone permission, having no headphones, or being unable to obtain a useful recording must leave a complete lesson path. The reference performance and brief listening examples still work without recording the learner.

A sensible first validation is five non-MIDI adults attempting the onboarding and the same short lesson segment without coaching, followed by a delayed return. Ask them to explain their chosen rating and the next exercise. Use the teacher-reviewed sample from F03 to distinguish misunderstood language from disagreement with the rubric. Five people can expose usability failures; they cannot validate the rating model. **Usability work: 6-8 founder hours, overlapping onboarding and F03.**

## Is the launch subscription sellable?

**It is credible as a narrow paid pilot. It is not yet demonstrated as a subscription people renew.** I would preserve CHF 15/96 while testing actual use and payment behavior. The paid value must be the structured route through pieces, the editorial teaching, and the next useful practice decision. Four paid titles can provide that for some transition-stage learners. Neither a teacher-hour comparison nor an annual preselection establishes continued value after they finish their relevant material.

The sequence needs particular attention. A pianist who finishes the free grade-2 Bach lesson may find the paid grade-1 lessons behind their current needs, leaving fewer relevant next steps than the catalogue implies. A true pedal beginner may need those grade-1 lessons before they can finish the free piece. This does not require replacing BWV 639; it requires recommendations and an optional paid-grade-1 route before free-lesson completion, with the full free path still available. The 565 showcase should be labelled as a demonstration and should not silently place a novice on an advanced progression.

Show the actual included lesson titles, prerequisites, instrument requirements, and present availability before purchase. Keep requests and planned lessons distinct from shipped content. Do not depend on future authoring to rescue a customer who currently has no suitable next lesson. The self-assessed route must offer equivalent teaching materials and recommendations; MIDI contributes additional measurement.

Run a small paid pilot with both MIDI and non-MIDI users. Predeclare practical progression gates: can people complete the first useful session without help; do they return in a later week; can they identify and choose a suitable next paid lesson; do monthly customers voluntarily continue into a second billing period? Define a desired minimum and stop/revise rule before seeing results. Measure those outcomes separately by track. A pilot's observed conversion fraction is not a general market estimate.

**Cost:** 3-4 h to specify the pilot and decision rules; roughly 1 h/week for six weeks of follow-up within the existing distribution allocation, plus payment-flow work already budgeted. A catalogue comprehension test with eight target users costs 4-6 h including synthesis and can happen before billing exists.

The panel's audience-size, year-one subscriber, churn, and lifetime-value estimates have no supporting evidence in this record. Do not use them to declare the business viable. Simple gross-revenue scenarios are enough to set a founder target: 100 annual subscribers generate CHF 9,600/year; 250 generate CHF 24,000; 500 generate CHF 48,000, all before fees, tax, hosting, and refunds. Decide what success must earn relative to the 1,040 annual hours implied by twenty hours/week. **This financial goal-setting takes 1-2 h; it is planning, not a forecast.**

### The one feature I would cut

**Cut founding-member lifetime access from B3.** This explicitly challenges the lifetime portion of D-46 while preserving monthly and annual prices.

CHF 249 equals only about 2.59 annual payments. It creates a long-lived content/support promise before either cost is measured, adds a cap and upgrade/refund cases, and makes the most engaged cohort less useful for studying paid renewal. Lifetime customers can still stop practising; removing subscription cancellation does not remove product abandonment. Keep them as early subscribers, study their continued use, and reconsider lifetime only after support load and ongoing content delivery are understood.

**Cost/saving:** 0.5-1 h to revise the decision and copy; estimated 6-12 h of product setup, cap handling, upgrade cases, and QA avoided, with less recurring administration. The main saving is the future promise, not an enormous engineering reduction.

## Topics without an operational design

The record does mention onboarding, accessibility, localization, and crash tools. I do not call those topics completely absent. What is absent is the specific flow, lifecycle, or operating procedure identified here. The four panel reports do not supply these designs either.

| Gap and relevant location | Minimum useful treatment | Cost and timing |
|---|---|---|
| **First-session flow and permission recovery** — spec §§2, 7, 13; architecture §9 | Language -> "at an organ / exploring" -> choose piece/goal -> only the needed instrument questions -> optional MIDI setup -> short exercise -> rating example -> saved next step. Ask for microphone, Bluetooth, camera, notifications, or email only when used. Skipping each must work; connection setup must be resumable. Include changed-instrument return flow. | 2-3 h flow design; 8-12 h implementation within B1; user sessions shared with the 6-8 h self-assessed usability study. |
| **Practical accessibility and console ergonomics** — spec §§8, 16 | User-adjustable score scale, a stable pause/page control, cursor suppression, no meaning conveyed only by color, accessible textual analysis summaries, focus order, large text without clipped prices/buttons, captions/transcripts for spoken teaching if added. Test from a real bench at the user's actual viewing distance and with both hands occupied. Define honestly what score accessibility is supported. | 2 h criteria; 8-14 h implementation and audit beyond the one NFR line. Console checks share the spike visit; broader checks before B1. |
| **Session interruption and recovery** — architecture §§4-6, 9 | Calls, Bluetooth/USB loss, audio-route changes, permission revocation, process death, low storage, and phone lock. Stop accompaniment, clear sounding app notes, preserve previous attempts atomically, and offer resume/retry without inventing a musical failure. Recheck audio offset when the route changes. | 2 h lifecycle table; 8-12 h implementation/QA before scored beta, sharing invalid-attempt handling with F02/F05. |
| **Localization mechanics and musical terminology** — spec §16; architecture §§3, 6 | Stable message keys and locale-neutral data; an explicit fallback; DE/EN glossary for pedaling and touch; translated editorial layers/reasons and accessibility labels; language switching without resetting state; localized store prices. Test English B-natural/German H and English B-flat/German B, durations, dates, and long German labels. | 2 h glossary/policy; 6-10 h infrastructure/QA. Allow 1-2 h bilingual QA per lesson within a reconciled authoring budget. |
| **Support and operating capacity** — spec §§13-15; architecture §§10-12 | One support address and expected response time, "report a problem" with previewable device/console/version diagnostics, optional MIDI sample only by consent, restore/refund guide, known-device notes, incident triage, and a founder-absence plan. A crash service does not answer purchase or lesson questions. | 6-10 h before launch; reserve 2 h/week initially inside the 20 h, review against actual demand. Tutoring delivery and preparation must also be charged to the same budget. |
| **Content/OTA release and recovery lifecycle** — architecture §§3-4, 10, 12 | Minimum app/schema versions, staging and atomic activation, disk-space checks, a known-good package, compatibility between a JS rollback and database migrations, and a way to withdraw a faulty lesson update. Bound archive expansion as well as checking signatures/paths. Identify who can publish and how publishing-key loss is recovered. | 3 h design; 8-12 h implementation/rehearsal. Shared version work with F02 and baseline package installation. |
| **Asset provenance beyond the musical work** — catalogue §2; spec §§5, 7.4, 9 | Inventory notation fonts, impulse responses, pictures, ornaments/tables, recordings, videos, bought engraving, and any included source facsimiles. Record rights/permissions for the actual assets and selected storefronts, and reconcile a bought/CC0 engraving with the declared musical source. "Public-domain composition" alone does not document the shipped package. | 3-5 h inventory/template; asset-specific clearance and engraving reconciliation remain in authoring costs. Before public distribution. |
| **Shared-device and profile boundaries** — spec §12; architecture §§4, 10 | State that launch has one learner profile per installation, unless multiple local profiles are deliberately added. A store-account switch changes neither that learner's history nor consent automatically. Describe borrowing a phone, reinstalls, and importing another person's progress. | 1-2 h policy and help copy. Keep multiple-profile engineering out of launch unless institutional pilots prove it necessary. |

For touch targets, Android's current guidance uses at least 48 dp; this is a useful starting acceptance criterion, not a substitute for testing the organ-console interaction. [Android accessibility guidance](https://developer.android.com/guide/topics/ui/accessibility/views/apps-views).

## Commerce state cases to specify

This table is part of F09's work estimate. It deliberately accepts bounded offline abuse rather than adding accounts or elaborate DRM to the learning product.

| Situation | Recommended behavior |
|---|---|
| Subscription active, recent verified entitlement | Full downloaded access. |
| Subscription cancelled but its paid term is still active | Access continues to the known paid-through date. Cancellation is not immediate expiry. |
| Offline with a known paid-through date | State explicitly whether access follows that date or a shorter verification lease. I recommend honoring the known paid term, then the declared 14-day grace if status cannot refresh. This challenges any interpretation of A-7 as "lock every paid user fourteen days after last contact." |
| Grace ends or a confirmed expiry is received | Keep progress, personal recordings, repertoire history, and export available. Lock the paid teaching functions only as disclosed before purchase. Show a restore/reconnect route. |
| Refund or revocation confirmed while online | Update paid access, preserve learner data. Do not reset mastery as a consequence of a billing event. |
| No network during a paid attempt | Finish the attempt; access changes take effect at a safe boundary. |
| Reinstall or new Android device | Restore the store purchase explicitly, then restore/import progress separately. Test same-store-account and different-store-account cases. |
| Imported progress backup | Import permitted learning data only. Entitlement and trial eligibility do not come from an editable progress file. |
| Pending purchase, failed acknowledgment, duplicate request | Do not grant permanent access from a pending UI state; make finalization idempotent through the billing integration. |
| Shared/leaked institutional code | Apply the chosen eligibility policy; do not represent a reusable discount code as enforceable seat ownership. |
| Monthly subscriber attempts annual/lifetime upgrade | Show effective dates and explain whether the original renewal remains. Do not assume an independent lifetime purchase cancels a subscription. Lifetime is recommended for removal. |
| Future iOS account binding | User verifies the account identity and demonstrates a live store entitlement. Newsletter enrollment is optional and insufficient as ownership proof. |
| Changed device clock | Use trusted billing dates when available and conservative elapsed-time handling. Accept limited offline leakage as a product trade-off; never claim perfect device-local expiry enforcement. |

Paid lesson packages on a static CDN can also be copied. Signatures establish origin and integrity, not purchase authorization. Decide that this is an accepted launch trade-off; a costly anti-copying system is not justified by the record. **Decision/copy cost: 0.5-1 h, included in F09.**

## Assumptions audit: spec §19

"Unverified" means the evidence is absent or cannot exist before a device/user test. It does not mean the assumption is false. Costs below are included in the corresponding finding or named spike work unless stated otherwise.

| ID | Assessment | Closure evidence and cost |
|---|---|---|
| **A-1: thresholds/constants tuned in beta** | Technically plausible, method incomplete. Telemetry lacks calibration fields; changing thresholds while evaluating the mapping/experiment confounds the result. | Freeze a scorer/rubric, collect paired evidence, tune on one sample and check on another. Version every policy. F02/F03/F05; 3-4 h protocol specification, with study work separately costed above. |
| **A-2: unknown MIDI-capable share** | Correctly demoted from fact. A socket and a recruitment answer measure claimed capability, not successful scoring access. | Record claimed capability, actual connection success, channel observability, setup time, and chosen track separately; distinguish recruitment channels. 1-2 h to define fields, then use existing console/tester sessions. |
| **A-3: guided default** | Reasonable product choice, unvalidated usability assumption. | At first recommendation show a short reason and an obvious choice to select another task. Observe whether users understand both. 1-2 h of prototype changes, shared onboarding test. |
| **A-4: 30-minute default** | Reasonable preference, not a scientific dose. It is ambiguous whether it includes setup, listening, and rating. | Define it as total session time; offer simple short/standard/custom choices and measure how much is spent playing versus interacting. 2-3 h within session UI work. |
| **A-5: three self-rated days versus two scored** | Unverified heuristic. Extra days do not identify or remove systematic bias. | Keep visibly provisional; examine delayed qualifying performance and mixed-input histories. 1-2 h rule specification within F02; use F03's study. |
| **A-6: anchors understood without teacher** | Not ready as written: the highest anchor refers to two performances and a no-stop criterion cannot cover every musical dimension. | Single-attempt, task-specific anchors plus "not sure"; observe learners explaining them. Shared 6-8 h B1 study. |
| **A-7: 14-day entitlement grace** | Business policy, not an established RevenueCat default. The clock origin and relation to known paid expiry are undefined. | Choose the F09 state table and test the exact SDK/configuration at boundaries, offline and after restore. 3-4 h specification and 12-20 h billing lifecycle work already budgeted. |
| **A-8: Auto Backup quota fits** | Not safe under the proposed storage shape. Standard quota confirmed; a plausible event-only scenario exceeded it by more than twofold. | Separate/cap raw capture; measure actual serialized backup; restore after interruption and quota stress. F12, 6-10 h. |
| **A-9: Skia renders SVG correctly** | Still an empirical spike question. Outline paths are a fallback to test, not evidence of success. | Render final pipeline output, glyphs, pedaling layers, system offsets, and cursor on the Pixel; record timings and actual readability. Included in the 5 h rendering box below. |
| **A-10: vetted CC0 engravings exist** | Partially supported at discovery level, not closed. A CC0-labelled BWV 639 listing exists; its editable source, provenance, and agreement with the required edition were not verified. Other available typesettings use different licences. | Obtain the exact editable file, preserve its licence record, and compare it against the chosen musical source. Budget the fallback until this passes. 2-4 h for initial candidate checks, separate from final proofreading. [Candidate listing](https://www.free-scores.com/sheetmusic?p=aYGrp4JP2U). |
| **A-11: scheduler EU hosting and Stripe fit** | Not established. Cal.com's European-hosting page currently offers early access via enterprise sales; it does not establish availability on the intended solo plan. Its normal pricing page supports payment integration but does not resolve residency. | Get the exact plan, processing agreement, hosting scope, and payment terms before enabling booking. 2-3 h vendor check. Do not self-host a scheduler merely to preserve a tentative vendor choice. [European hosting](https://cal.com/europe), [pricing/features](https://cal.com/pricing). |
| **A-12: current Play closed-test rule** | Public policy verified: new personal accounts created after 13 November 2023 need at least 12 testers continuously opted in for 14 days before applying for production access. The founder's actual enrollment category remains to be verified. | Save current policy evidence and confirm Console requirements after enrollment. 0.5-1 h. Approval still requires the application process; meeting the numeric minimum is not automatic production approval. [Google's testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en). |

## Open items audit: spec §20

| ID | Assessment and concrete change | Cost / gate |
|---|---|---|
| **R-1: VAT and invoicing** | Keep the advisor consultation. An Einzelfirma or a store handling customer tax does not by itself answer the founder's full invoicing/tax position. Include tutoring, any direct institution sale, and store proceeds in the fact sheet given to the advisor. | 2-3 founder hours including preparation/meeting; professional fee additional. Close before the first relevant paid transaction, rather than assuming tutoring will be the first. |
| **R-2: trademark** | Still open. I have not performed trademark clearance. A web/name search would not close it. Preserve the existing gate before design spend. | 2-4 h for the preliminary named-register search and documenting results; professional assessment additional if conflicts appear. |
| **R-3: grouped verification list** | Split it into separate rows with evidence, deadline, and fallback. A-8/A-9 affect B1 architecture; A-10 affects each package; A-11 affects live bookings; A-12 affects distribution. "Their named gates" is not a useful single status. | 1 h register cleanup within F15. |

There is one positive policy result worth recording: Google's current guidance expressly exempts qualifying live 1:1 music lessons from mandatory Play billing where the stated conditions hold, including no replay in a Play-distributed app. The external tutoring link is therefore a defensible direction. Keep the offer truly within those conditions and verify the final listing/link before release. **Cost: 0.5-1 h, shared with A-11/R-1 preparation.** [Google's 1:1 services guidance](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en).

Add seven assumptions now: readable phone notation at a real console; adequate observable MIDI separation; non-MIDI rating validity; independent whole-piece performance after section practice; a suitable paid next lesson after the free route; demonstrated content throughput including localization and operations; and a realizable billing mechanism for each advertised tier. These are more consequential than the default session length. **Register cost: 1 h, shared with F15.**

## Enhancements worth their cost

These are optional improvements after the correctness fixes. Do not insert all of them into the spike.

| Enhancement | Why it earns its cost | Cost |
|---|---|---|
| **Matching printable score** from the in-house edition, with the same bar numbers and editorial layer | Lets a phone remain the coach while a learner reads a larger page. Also supports a church session where the screen position is poor. This preserves phone-first interaction and tests the notation-size risk cheaply. | 4-6 h export/share/QA setup plus 0.5 h per lesson; use the existing authoring renderer. |
| **A concise "what this result means" line** | State whether evidence was measured, self-reported, or unavailable, and whether it covers a short exercise or the complete section. Reduces false authority and support confusion. | 2-4 h UI/copy, largely shared with F01-F03. |
| **A readiness card for the next lesson** | Shows prerequisites, required instrument features, why it suits this learner, and what it teaches. Makes the small catalogue more usable and exposes missing next steps before purchase. | 4-6 h screen/template work plus 0.5 h per lesson; largely shared with existing catalogue detail. |
| **A simple goal-date option for an existing lesson** | An optional "I want this ready for a service/recital on..." can prioritize whole-piece checks and upcoming practice without a new trait model. Build only if the beta asks for it. | 4-6 h including local scheduling tests. It must not falsely promise readiness by the date. |

My order would be evidence labels first, the printable score second, then readiness cards. The goal date is conditional and has no place in the initial spike.

## A spike that fits the actual capacity

Two weeks provide **40 founder hours: 8 distribution and 32 technical hours**. Before starting that clock, use about **6-9 h** to settle the minimal input-capability and qualifying-performance contracts in F01/F02. The full later engine and commerce fixes do not need to be implemented now. This is additional pre-spike specification time, not hidden capacity inside the two weeks.

The following are timeboxes, not promises that every probe succeeds. A failed or blocked feasibility test is a result to document.

| Work | Technical hours | Required evidence |
|---|---:|---|
| Project/device/provisioning preparation | 2 | Dev-client build path, cables, console access, and actual iPhone availability confirmed. |
| Android MIDI capture and console visit | 9 | Native timestamps and note-offs retained; known-source timing comparison distinguished from human performance; same-manual hands, couplers, unisons, disconnect, and at least one multi-source case captured where hardware permits. Mark unavailable cases unresolved. |
| Authoring/rendering slice | 5 | One launch-relevant excerpt through the pipeline, two editorial variants, legal excerpt boundary/loop, note-position mapping, and real-distance readability. Include a dense Widor/565 excerpt as the stress case rather than fully authoring either work. |
| Audio proof | 4 | Scheduled onset/release behavior under representative polyphony; usable count-in; route change; MIDI/audio clock relation recorded. This tests scheduling, not a finished organ sound library. |
| iOS feasibility slice | 6 | Real-device render/audio and a minimal CoreMIDI input/timestamp path, or an explicit reason the test could not be completed. Reusing JS alone does not validate the native MIDI port. |
| Measurements and decision note | 4 | Reproducible fixtures; timings; failed cases; chosen fallback for each failed gate; update to the cost model. |
| Contingency | 2 | Build/provisioning friction. |
| **Total** | **32** | |

This converts D-42's unspecified "three days" into a six-hour feasibility box. If three full working days are required, extend the calendar rather than borrowing the distribution budget. Do not interpret a six-hour failure to finish CoreMIDI as proof that iOS is unsuitable; it may be insufficient time or unavailable provisioning.

Within the separately reserved eight distribution hours, recruit real target users and schedule the B1 usability/calibration work. Do not build commerce, telemetry infrastructure, an annotation-editor UI, or a learning experiment into this spike. It needs enough fixtures and evidence to decide whether the proposed technical path deserves those later investments.

Before B1, close onboarding/accessibility, storage/restore, recording lifecycle, and the exact free lesson package. Before B2, close observable scoring dimensions, attempt validity, and the calibration collection path. Before B3, close adaptation precedence, complete-piece progression, the promised paid catalogue, and the billing state cases. This ordering preserves the founder's capacity without treating missing release work as optional.

## Backup sizing method and limits

The sizing check used Python's SQLite library in the review environment. It created an ordinary rowid table with the following schema, then inserted 360 note events into each of 1,800 one-minute attempts. Attempt IDs were 26-character strings; `source` was `usb1`; `kind` was `on`/`off`; channel, pitch, sequence, and time were integers. The file was committed before its size was measured.

```sql
CREATE TABLE attempt_events (
  attempt_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  channel INTEGER NOT NULL,
  pitch INTEGER NOT NULL,
  t_ms INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, seq)
);
```

Rows = 90 days x 20 minutes/day x 60 seconds/minute x 3 note-ons/second x 2 events/note = **648,000**. Committed file size = **61,681,664 bytes = 58.82 MiB**. The composite primary-key index is included. Other application tables, audio, downloaded content, and WAL sidecars are not.

This is one transparent scenario, not a forecast of real user activity or the final Drizzle schema. Compression, integer foreign keys, a different SQLite layout, or shorter capture retention can reduce size. The conclusion is narrower: a retention period alone is insufficient to guarantee the standard backup quota. Durable progress must remain protected even if raw capture fills its allowed space.

## Evidence boundaries

The document/algorithm contradictions are deductions from the supplied record. Public policy/vendor facts were checked against the linked primary documentation on the review date. The Brahms finding includes direct visual inspection of the specified first edition. The CC0 candidate remains a discovery lead; its file and source chain were not verified. I did not perform trademark clearance, a full rights audit, device performance tests, or a user study. Numerical work estimates and pilot designs are recommendations, not measured project throughput or established learning-effect estimates.
