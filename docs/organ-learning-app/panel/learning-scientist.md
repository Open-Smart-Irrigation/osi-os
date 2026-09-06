# Panel seat: learning scientist (verbatim report)

Reviewed 2026-09-06 against spec 0.6, catalogue 0.1, architecture 0.2.
Persona: learning scientist in motor-skill acquisition, adaptive systems, and
music practice research. Verbatim transcript; the adjudication is in
[../panel-review-2026-09-06.md](../panel-review-2026-09-06.md).

## 1. Verdict

Yes, this would plausibly produce learning — the design has already made several of the decisions that matter most, and made them correctly: distributed practice is structurally enforced (securing requires passes on *separate days*), exercises are short passages rather than whole-piece run-throughs, feedback is withheld during the attempt, difficulty adapts, and the learner chooses between guided and self-directed control. Those five things carry most of the variance, and a lot of ed-tech gets none of them. Where it is on shaky ground is the part the documents are proudest of. The adaptivity engine servos on acquisition-phase success rate, which is precisely the quantity Bjork's desirable-difficulties work identifies as the least trustworthy index of learning; it borrows its central mechanism (Levitt's 2-down-1-up staircase) from psychophysics, whose convergence proof assumes a *stationary* observer and enough trials to converge — both violated here; it structurally enforces blocked, massed practice through an ordered scheduler and then calls a template-repeat cap a "variety guard"; it treats self-report *bias* as if it were self-report *noise* and corrects it with a smaller learning rate, which cannot work; and it delivers rich augmented feedback after 100% of attempts, the textbook guidance-hypothesis error. None of this is fatal and almost none of it is architectural — it is scheduling policy inside a pure function with a constants module, which is a genuinely good place for it to be. Fix the policy before B3 and this is a defensible piece of instructional design. Ship it as written and the engine will reliably produce fluency in the practice room that does not survive to next week, and it will do so while reporting healthy numbers.

## 2. Findings, strongest first

### F1 — Self-assessment bias is modelled as noise. (blocker)
**architecture.md 6.1, 6.4; spec.md 5.3, 6.1**

Forty percent of users drive the engine entirely from a three-point self-rating, and the whole of the "self-reports count less" policy is `alpha = 0.15` instead of `0.35`. A lower learning rate slows convergence toward an estimate; it does not move the estimate. If self-ratings are biased — and every reason to expect they are — the engine converges to the wrong value more slowly.

The bias is not hypothetical, and this design maximises it. Judgments of learning are driven by processing fluency, not by memory strength (Koriat's cue-utilisation account), and the two dissociate exactly under massed, blocked repetition — which is what the scheduler produces (see F2). Simon and Bjork (2001, *JEP:LMC*) is the direct hit: learners in blocked practice predicted *higher* future performance than learners in random practice, while actually retaining *less*. Kruger and Dunning (1999) adds that the least skilled are the most overconfident, and this cohort is by definition the one without objective feedback. So the self-assessed track is systematically biased toward premature "secure" ratings, premature tempo advancement, and premature securing.

Three further problems compound it:
- **The 0 / 0.6 / 1.0 mapping is invented and mis-scaled.** Scored attempts are rescaled so the pass threshold lands at 0.75, so a scored attempt that barely passes yields 0.75 and a strong one perhaps 0.9. A self-rated "secure" yields 1.0 — above anything the scored track can realistically produce — and "mostly" yields 0.6, below pass. The self-assessed mastery EMA therefore has a wider dynamic range and saturates faster than the scored one. The two tracks are not on the same axis.
- **Three penalties stack, none of them calibrated.** Self-raters get half the EMA rate, *and* half-size tempo steps (confidence stays low: at 0.4 evidence points per rating against a saturation of 20, a dimension needs 50 self-ratings to reach full confidence), *and* three secure-days instead of two. Whether the net is too conservative or too permissive is unknown, and nothing in the design will ever find out.
- **No calibration mechanism exists anywhere.**

**Fix.** (a) Replace the adjectival scale with behaviourally anchored criteria the learner can apply without expertise — "stopped or corrected at least once" / "played through, some unevenness" / "played through twice consecutively at this tempo with no stop". Behavioural anchors are far more reliable than "not yet / mostly / secure". (b) Ask for the rating as a *prediction before* the attempt as well as a judgment after, and show the learner the gap; calibration feedback is the standard remedy and it costs one screen. (c) Take at least one judgment *delayed* — rate the cell at the start of its next probe, before replaying it. The delayed-JOL effect (Nelson and Dunlosky 1991) is one of the largest and most reliable calibration manipulations known, and it is free here because the probe already exists. (d) Derive the 0/0.6/1.0 constants from data rather than intuition — see Enhancement E1. (e) Stop treating bias as variance: if measurement shows systematic over-rating, subtract it, don't damp it.

### F2 — The scheduler enforces blocked practice; the variety guard does not fix it. (blocker)
**architecture.md 6.3 (rules 3-5), 6.2; spec.md 6.3**

Rule 4 selects the section with the largest tempo gap and, within it, the least-combined unpassed configuration. The staircase then requires *two consecutive passes* before advancing. A fail streak of three on the same bars spawns a loop drill on exactly those bars. Net behaviour: the learner repeats one cell until it passes twice, then repeats it again at the next tempo. That is massed, blocked practice with a repetition drill bolted on for the hard bits.

Contextual interference (Shea and Morgan 1979; Magill and Hall 1990) is among the more robust findings in motor learning, and its signature is precisely that blocked practice looks better during acquisition and worse at retention and transfer. Guadagnoli and Lee's (2004) challenge-point framework is the right theory for this whole engine and is absent from both documents: functional task difficulty should track skill level, and it is manipulated through practice *structure* and information load, not only through task speed. I will be honest about the boundary conditions — CI benefits shrink and can reverse for high-complexity tasks and low-skill learners, and the music-specific replications are thinner than the lab literature — but "shrinks for novices on complex tasks" is an argument for a blocked-then-interleaved progression, not for pure blocking forever. <!-- slop-allow: quoted panel transcript -->

The variety guard is cosmetic against this: it caps *template* repeats at two in a row and requires a session to touch two *sections*. Neither creates interference between the things that need to be discriminated. You can satisfy both while running the same cell twelve times.

**Fix.** Make schedule structure a first-class engine parameter with three regimes, selected per cell by its state: **blocked** on first exposure (acquisition — this is where blocking legitimately helps), **serial/interleaved** once the cell is `in_progress` (rotate among 3-4 active cells, one or two attempts each, rather than running to pass), **random** among passed-not-yet-secured cells. Add a hard cap on consecutive attempts per cell within a session (3 is a reasonable default) and force a switch. Rewrite the variety guard as an interleaving policy over *cells*, not templates. This also cleanly separates the two roles blocking and interleaving play, which the current single rule conflates.

### F3 — The 71% figure is a misapplied psychophysics result, and ~71% is not the right target for motor learning anyway. (major)
**architecture.md 6.2, 6.5; spec.md 6, 6.3 rule 4**

Two separate problems, both worth fixing.

**The mechanism.** Levitt (1971) proves that a 2-down-1-up transformed up-down rule converges on the 70.7% point of a psychometric function, under assumptions: a monotone psychometric function, a *stationary* observer, and enough trials that the estimate (conventionally the mean of reversals, not the current level) converges. Every one of those is compromised here. The learner is nonstationary by design — improvement during the run is the entire product. A cell may see five to fifteen attempts across a session, not the dozens a staircase needs; over that horizon the level is dominated by its starting point and step size, not by the asymptote. And pass/fail here is a threshold over a *composite* of pitch, timing and articulation, where a learner can fail for reasons orthogonal to tempo — a memory lapse, a wrong manual, a fingering that fell apart. Those are lapses in the psychophysical sense, and lapse rate is well known to bias adaptive procedures (Wichmann and Hill 2001), asymmetrically downward for N-down-1-up rules: one lapse at a comfortable tempo costs a step down, and two clean passes are needed to recover it. Expect a slow downward ratchet across a session. Correcting the earlier inverted rule was right and the note explaining it is good practice; the remaining claim that the corrected rule "settles where about 71% of attempts succeed" is still unearned as stated.

**The target.** Even granting convergence, 70.7% is an artifact of the update rule, not a learning optimum. The nearest principled result points the other way: Wilson, Shenhav, Straccia and Cohen (2019, *Nat Commun*) derive ~85% as the accuracy that maximises learning rate for a broad class of learners. Bandura's self-efficacy work says mastery experiences are the dominant source of efficacy beliefs, which argues higher still for adult amateurs early in a cell. And the errorless-learning line (Maxwell, Masters and colleagues) finds that low-error acquisition produces performance that holds up better under pressure — which matters for an instrument played in front of a congregation. Against that, Bjork's desirable difficulties argue for conditions that *depress* acquisition performance — but achieved through spacing, interleaving, variability, retrieval and reduced feedback, never by servoing a raw success rate to a number. Bjork's central point is that acquisition performance is an unreliable index of learning; an engine whose governing objective *is* acquisition performance has adopted the metric the theory warns about.

**Fix.** Separate the two roles the number is currently playing. Keep a success band as a **motivational guardrail** (and shift it up — 75-90% early in a cell, relaxing toward 65-80% for consolidation and probes), stated as such, with self-efficacy as the rationale. Drive **learning** with the structural levers (F2, F5, F7). Mechanically: stop asserting convergence, measure realised success rate over a sliding window per cell and correct explicitly if it leaves the band; take the tempo estimate as a mean over recent reversals rather than the instantaneous level; and add a lapse guard — require two consecutive fails to step down, or let the learner mark an attempt "restart, don't score it".

### F4 — Retention probes will starve progress, and the 21-day cap contradicts the product's own retention goal. (major)
**architecture.md 6.3 rule 2, 6.5**

The scheduler is ordered and first-match-wins, with probes at rank 2, above all progress. Each secured cell probes at least every 21 days at the cap, so steady-state probe load is roughly *N*/21 probes per day for *N* secured cells. A cell is a section x part configuration: BWV 645 alone has five sections and up to seven configurations, so a single lesson contributes on the order of 30 cells and six lessons a few hundred. At three minutes per probe with the analysis and rating step, 200 secured cells is ~9.5 probes/day, about 30 minutes — the entire session budget, permanently, with nothing left for rule 4. This is not a theoretical worry; it is arithmetic that one diligent learner working the launch catalogue will reach.

The cap is also the wrong number in the other direction. Cepeda et al. (2008) found optimal gaps scale with the target retention interval at roughly 10-20% of it; a 21-day ceiling implies you are optimising for retention over a few months. The repertoire list, styled as a concert programme, implies you want pieces held for years. And the doubling schedule itself is folk SR rather than evidence: Karpicke and Roediger (2007) found expanding schedules help short-term retention while *equal-interval* spacing was better at long delays — the reliable ingredient is successful retrieval at long absolute gaps, not the expansion pattern.

Finally, probe granularity is wrong. Motor memory for a passage consolidates at the level of the passage, not "LH of bars 17-24 in isolation". Probing every part configuration separately multiplies load by roughly four for no retention benefit.

**Fix.** (a) Probe at **section level, full texture**, and decompose to part configurations only as a diagnostic *after* a section probe fails. This cuts load ~4x and probes the thing you actually want retained. (b) Give probes a **budget share** (<=25% of session minutes) rather than absolute priority; when due probes overflow, defer by lowest predicted recall rather than by due date. (c) Raise the cap substantially (90-180 days) or make it a function of a stated target retention interval; note in the constants table which retention horizon the cap encodes. (d) Since a probe *is* retrieval practice (Roediger and Karpicke 2006), let a passed probe contribute to mastery, not just reset a timer.

### F5 — Augmented feedback after 100% of attempts is the guidance-hypothesis error. (major)
**spec.md 3 (principle 4), 7.3; architecture.md 8 (Analysis)**

Withholding feedback *during* the attempt is well judged and well argued. What happens *after* is unexamined: every attempt produces a heat map, a timing plot against the beat grid, an articulation profile against the reference, and overlay of the last three attempts. That is maximal augmented knowledge of results and knowledge of performance at 100% relative frequency.

The guidance hypothesis (Salmoni, Schmidt and Walter 1984; Winstein and Schmidt 1990) is that frequent, immediate augmented feedback improves acquisition and *degrades retention*, because learners come to depend on the external signal and stop processing their own intrinsic feedback — which for a musician is the thing you are trying to build. Reduced relative frequency, faded schedules, summary feedback and bandwidth feedback all outperform 100% at retention. Learner-controlled feedback (Chiviacowsky and Wulf 2002) does as well or better and is simultaneously autonomy-supportive, which fits this product's stated principles.

**Fix.** Fade it. Full analysis on first exposure to a cell; once a cell is `in_progress`, default to a one-line verdict with detail **on request**, plus an automatic summary every third attempt. Before revealing the heat map, ask the learner where they think the errors were (one tap on the bar map). That single interaction does three jobs: it preserves intrinsic feedback processing, it generates the calibration data of F1 for the *scored* cohort too, and it converts a passive readout into retrieval.

### F6 — Isolation-before-combination is asserted; the part/whole literature says it should be a default, not a gate. (major)
**spec.md 6.3 rule 3, 5.2; architecture.md 6.3 rule 4**

"Combine only when isolation is secure" is a hard prerequisite. The part/whole practice literature makes a distinction the spec doesn't: Naylor and Briggs (1963) and Wightman and Lintern's (1985) review separate task **complexity** from task **organization**. Part practice helps for tasks that are complex but *loosely organized* — components largely independent. It helps little or hurts for *highly organized* tasks, where the components are temporally interdependent. Three-voice organ texture with shared metre and voice-leading is about as highly organized as motor tasks get, and the target skill — hand/foot independence — *does not exist* in any isolated part. Practising the pedal line alone trains the pedal line; it does not train the coordination, which is the actual difficulty, and gating on "secure" delays first exposure to it.

Wightman and Lintern also distinguish the three part-practice methods. **Segmentation** (a short span, all parts) is the best supported. **Simplification** is next. **Fractionization** (splitting concurrently performed components — exactly RH-alone, LH-alone, pedal-alone) is the least supported for highly organized tasks. The design's primary lever is fractionization; its templates offer segmentation almost incidentally.

**Fix.** (a) Demote the gate: allow full texture once isolation has *passed*, not once it is *secure*, and introduce a short full-texture segment early in every section regardless, at reduced tempo and length. (b) Make **segmentation the primary simplification** — 2-4 bars, all parts — which the phone-first "2 to 16 bars" design already supports beautifully and which nothing in the scheduler currently prefers. (c) Where fractionizing, use **progressive-part** (add a part and replay the accumulated set) rather than isolated-part; the pairing sequence RH+ped, LH+ped, manuals is close to this already and should be stated as the rule.

### F7 — Tempo is the only difficulty lever, and it is the one with the worst transfer properties. (major)
**architecture.md 6.2, 6.4**

Everything the engine can do to change difficulty is `tempoRatio`. Two problems. First, slow practice changes the control structure of the movement, not just its rate: the motor-chunking literature finds chunk boundaries are rate-dependent, and Fitts and Posner's associative-to-autonomous transition is about the shift from feedback-controlled to pre-programmed execution. Repeated practice at 60% of target — the cold-start floor — can build a chunk structure that does not transfer upward, which is the familiar phenomenon of a passage that is clean at 60 and falls apart at 100 no matter how many times you climb through the middle. Second, the design already has better levers sitting unused: passage length, part combination, score availability (the Memory template), rhythm variation, starting-point randomization, and above all scheduling.

**Fix.** Make difficulty a small **vector with an ordered ladder of rungs**, mixing tempo with passage length and part combination, and have the staircase step along the ladder rather than along tempo alone. Raise the tempo floor for rate-dependent material (annotate it — `annotations.json` already carries a technique tag) to ~75% of target, and reframe genuinely slow work as a distinct accuracy drill rather than a rung of the same staircase, so the engine never treats a slow pass as evidence about fast performance.

### F8 — The nine skill dimensions are not nine measurable, independent constructs. (major)
**spec.md 6.1; architecture.md 6.4**

- **One dimension is unmeasurable for 40% of users.** Legato control is explicitly "not estimated" on the self-assessed track, yet cold start averages over "each dimension the cell's annotations tag". What the prediction does with a null is undefined — a spec gap, not just a design quibble, and legato is tagged on the free lesson.
- **Several are collinear.** Pedal accuracy and pedal timing draw on the same exercises. Hand independence and voice independence are both operationalized as "error rise when parts are combined". You will not identify four parameters from evidence that only distinguishes two.
- **One is not a scalar.** "Tempo ceiling per texture" is defined as highest tempo passed *per texture class* — that is a vector occupying one slot in a nine-vector.
- **One is not a trait.** Retention is an outcome of the schedule, and the engine already models it structurally via probe intervals. Having it also as an EMA double-counts.
- **Exposure confound.** Highest tempo passed is partly a measure of how many attempts the cell has had, since the engine itself controls the tempo. Nothing normalizes for exposure.
- **It arrives too late to do its job.** At rate 0.1 with 2-4 dimensions tagged per attempt, and confidence saturating at 20 points (50 self-ratings), a self-assessed learner needs most of a lesson before the profile is trustworthy — but the profile's only stated job is cold start, which happens at the beginning.

**Fix.** See section 4 — I would cut this from v1. If it stays: reduce to four dimensions with distinguishable evidence (pedal facility, independence/combination cost, reading fluency, tempo headroom), drop retention, define the null-dimension behaviour explicitly, and normalize tempo ceiling by attempt count.

### F9 — The simulated-learner assertions are circular where they matter and cannot fail. (major)
**architecture.md 7, 11**

Read the emulator's parameter table: skill per part, jitter, drift, slip rate, miss/extra, independence penalty, fatigue. Nothing updates. **The simulated learner does not learn.** Consequences for the four CI assertions:

- *"Success rate lands in the 60-85% band after warm-up"* — this tests the staircase against a stationary observer, which is exactly the condition under which Levitt's theorem holds. It will pass, and it validates nothing about the nonstationary real case. The assumption that makes the psychophysics valid is baked into the test.
- *"Time-to-secure falls as ability rises"* — near-tautological given the model. Higher skill means lower error rate means more passes means fewer attempts. It cannot fail unless something is badly broken.
- *"Every unlocked cell is eventually reached"* and *"the budget is respected"* — these are genuine liveness and safety properties, exactly what simulation is good for, and they are the right instinct. Note that a stronger version of the second would have caught F4.

No simulation can validate whether learning occurs, whether retention improves, whether the self-rating mapping is right, or whether one schedule beats another. Only humans can.

**Fix.** (a) Give the emulator an actual learning rule: per-cell skill gain from practice, a forgetting term over days, and an interference/spacing term. Then the simulation can *differentiate policies* and a CI assertion like "interleaved policy yields higher simulated day-30 retention than blocked" becomes capable of failing. It is still model-dependent — say so in the doc. (b) Add assertions that can fail on the real design: probe load never exceeds X% of budget; no cell's tempo declines monotonically over a long run (the lapse ratchet of F3); a plateaued learner does not oscillate indefinitely; consecutive attempts per cell respect the cap. (c) State in 11 that simulation validates mechanism, not pedagogy, and name the human study that will (Enhancement E2).

### F10 — Retrieval practice is in the template list and unreachable by the scheduler. (minor)
**spec.md 5.2; architecture.md 6.3**

The Memory template ("score hidden progressively") is retrieval practice, which is arguably the best-evidenced learning intervention in the whole literature (Roediger and Karpicke 2006). Nothing in the ordered scheduler ever selects it: rule 4 chooses the least-combined *part configuration*, not a template, and the variety guard only caps repeats. Memory work happens only if the organist hand-authors it into `exercises.json`.

**Fix.** Give retrieval templates a scheduled role: once a cell is `passed` but not `secured`, prefer Memory and reduced-score variants over another full-score repetition. This costs one rule and converts the strongest available lever from decoration into policy.

### F11 — A weekly *minutes* goal rewards time-on-task, which is the wrong target. (minor)
**spec.md 10**

The calendar's design is otherwise good — no streak, no penalty display, minutes total rather than streak count, all consistent with autonomy support. But a learner-set weekly *minute* goal incentivizes the long comfortable playthrough, which is exactly what the adaptivity engine exists to prevent. Ericsson's argument was always that structure, not duration, is what distinguishes deliberate practice, and Macnamara, Hambrick and Oswald's (2014) meta-analysis found accumulated practice explains only about a fifth of performance variance in music. Duke, Simmons and Cash (2009) is the most on-point study: among advanced pianists, what distinguished the best was not repetitions or time but *how errors were handled*.

**Fix.** Make the learner-set goal **sessions per week**, not minutes. Frequency is what distributed practice actually needs, it is harder to game, and it is the variable the spacing evidence supports. Keep minutes as a displayed statistic, not a target.

### F12 — Per-piece achievements with announced conditions risk the undermining effect. (minor)
**spec.md 10; architecture.md 3 (`achievements.json`)**

Awarding "quietly at session end" is the right instinct and worth keeping: Deci, Koestner and Ryan's (1999) meta-analysis finds the undermining of intrinsic motivation is driven by rewards that are *expected*, *tangible* and *task-contingent*. Unexpected, informational rewards are largely benign. The risk sits in the per-piece achievements, which carry an explicit condition ("tempo reached", "exercise passed without error") — the moment those are visible as a checklist in advance, they become expected performance-contingent goals, which is the undermining case, and they will compete with the engine's own recommendation for the learner's attention.

**Fix.** Do not display unearned per-piece achievements. Frame them retrospectively as records of what happened ("you played the pedal solo at 100 on 4 March"), never as targets. Keep the concert-programme register, which already pushes in the right direction.

### F13 — Two construct-validity leaks in the templates. (minor)
**spec.md 5.2, 5.3, 6.1; architecture.md 5.5**

- **Sight-reading is not sight-reading here.** The learner reaches a section after the orientation reader, the reference performance, and the technical preview. First-attempt accuracy on that is not a reading measure, and the cell persists so the engine can reselect a template that is definitionally once-only. Either restrict it to sections deliberately withheld from orientation, or drop the dimension.
- **Articulation is scored as conformity to one take.** 5.5 measures gap/overlap against `reference.mid` and scores the share of pairs within tolerance of the reference value. The spec itself says articulation is *the* main expressive parameter on the organ. Scoring the principal expressive dimension as deviation from one organist's single take confuses accuracy with stylistic conformity, and it will be the least reliable of the three metrics. Widen it to a defensible band (legato = no audible gap; detached = gap within a range), reserve conformity scoring for passages where the annotation says articulation is prescriptive, and say in the analysis view that the reference is *an* interpretation.

### F14 — No within-session position or fatigue covariate, though the emulator models fatigue. (minor)
**architecture.md 6, 7**

The emulator explicitly degrades error rates over an attempt's duration, and the session budget is 30 minutes — but the scheduler treats a fail at minute 28 identically to one at minute 3. Combined with the single-fail down-step (F3), end-of-session fatigue will systematically ratchet tempo down, and that depressed tempo is carried into the next session as the cell's state.

**Fix.** Suppress staircase *down*-steps (or down-weight the EMA) for the last few minutes of the budget and after the third consecutive attempt on a cell, and record within-session attempt index on the `attempts` row so the effect is measurable in beta.

### F15 — "No wrong pedal note" is an absolute criterion inside a probabilistic threshold. (minor)
**spec.md 5.3**

Pass requires 95% pitch accuracy *and* zero wrong pedal notes. Zero-tolerance criteria make pass probability fall with passage length, so longer sections will systematically settle at lower staircase tempi than short ones for reasons that have nothing to do with the learner. Either scale it (no more than one wrong pedal note per 16 bars) or move it out of the pass condition and into the analysis view as a highlighted diagnostic.

## 3. Enhancements

**E1 — Collect self-ratings from MIDI users, before revealing the score.** On the scored track, prompt for the same per-part rating, then show the analysis. This costs one screen and one column, and it buys: the empirical mapping constants that replace the invented 0/0.6/1.0 (F1); a per-population bias estimate; a per-user calibration statistic you can feed back ("you tend to rate one step high on pedal"); and the only available validation of the entire self-assessed track, which is 40% of your users and currently unvalidatable. It also implements the pre-reveal prediction that F5 wants. Ship it in B2, before the thresholds are tuned, not after.

**E2 — Run one real experiment during the closed beta.** You have twenty recruited testers, two comparable grade-1/2 lessons, and an engine whose scheduling policy is a constant. Run a within-subject A/B: blocked scheduling on one lesson, interleaved on the other, counterbalanced, with a **7-day delayed retention probe as the primary outcome** — not acquisition success rate, which is the metric Bjork shows will favour the wrong arm. Twenty within-subject participants is adequate for a CI-sized effect. This is the only evidence that can settle F2, it costs one config flag, and it turns "adaptive learning" from a claim into a finding you can put in the store listing honestly.

**E3 — Give the emulator a learning rule.** Add per-cell skill gain from practice, day-scale forgetting, and a spacing/interference term to the learner model in 7. It is perhaps forty lines, it costs nothing at runtime, and it upgrades the CI suite from "the engine did not crash" to "policy A beats policy B on simulated retention" (F9). It also gives you a sandbox to sanity-check the probe cap of F4 before a learner discovers it.

**E4 — One-tap failure-cause tagging on loop drills.** When a fail streak spawns a drill, offer five buttons: wrong note, coordination, reading, fingering/pedalling, tempo. This is cheap and does two things at once. It gives the engine the diagnostic signal it currently lacks — right now every failure is the same undifferentiated event, so the only response available is "lower the tempo", which is wrong for four of those five causes. And it prompts the learner to diagnose rather than repeat, which is the distinction Duke, Simmons and Cash (2009) found separated the best pianists from the rest.

**E5 — Make the probe a delayed judgment before it is a performance.** At probe time, ask "how well do you think this will go?" before the learner plays. Delayed JOLs are dramatically better calibrated than immediate ones (Nelson and Dunlosky 1991), the probe gives you the delay for free, and the prediction-versus-outcome gap is a better retention signal than the outcome alone. It also gives the self-assessed track one genuinely well-calibrated data point per cell per interval, which is more than it currently has anywhere.

## 4. One thing to cut from v1

**The nine-dimension skill profile** (spec 6.1, architecture 6.4, and the Profile screen's skill view).

It is the largest parameter surface in the engine and the one with the least evidence behind it. Its only stated job is predicting a cold-start tempo for an untried cell — a prediction the document itself says "is corrected by real attempts within a handful of tries". It needs roughly 50-90 attempts before it is trustworthy, which is most of a lesson, so it is at its least reliable exactly when it is used. One of its dimensions cannot be estimated at all for 40% of users, several are collinear, one is not a scalar, and one double-counts a mechanism modelled elsewhere. Nothing in the test strategy can validate it — the simulated learner's skill parameters are stipulated, so the profile will always recover them and always look correct.

The same job is done by two lines with no free parameters: start at 70% of target tempo, or at the tempo this learner has previously reached on cells sharing the same annotation tags — a nearest-neighbour over data you already store, which is more predictive than a nine-dimensional trait vector and is falsifiable against attempt history. Cutting the profile removes a package's worth of tuning surface before there is any data to tune it on, and it removes a screen that shows the learner nine numbers no one can check. That is exactly the kind of authority-by-dashboard this audience will see through, and the rest of the product is admirably free of it.
