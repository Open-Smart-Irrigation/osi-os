# External review: consolidation and adjudication (2026-09-07)

The external reviewer's report ([external-review-2026-09-06.md](external-review-2026-09-06.md),
verbatim) examined spec 0.7, catalogue 0.2, architecture 0.3, and the full
panel record. This document is the adjudication of its fifteen findings and
supporting sections: what is accepted into the next revision, what awaits
the product owner, and what the review changes about the plan.

## 1. Overall judgment, adjudicated

The reviewer's central verdict is accepted in full: draft 0.7 is not an
implementation-ready freeze, and the scoring and progression contracts
(F01, F02) must be specified before the spike's clock starts. The review is
of unusual quality — it verified claims against primary sources (the
Simrock first edition of the Brahms, the RevenueCat DPA, Google's account
and testing policies, a reproduced SQLite sizing scenario) and each
challenge to a prior decision is argued from evidence, not taste. Two of
its findings correct factual errors that survived four interview rounds and
a four-seat panel, which is exactly what an external reviewer is for.

## 2. Dispositions

All fifteen findings are accepted. None is rejected; two carry notes.

| Finding | Disposition | What changes |
|---|---|---|
| F01 channel is not a hand | Accepted, blocker | The scoring model separates musical voices, hands, manuals, and observable MIDI streams; combined-manuals scoring when hand attribution is ambiguous; "not measured" is a first-class result; coupler de-duplication only on observed routes; the console visit adds same-manual two-hand and cross-manual unison captures. |
| F02 no qualifying performance | Accepted, blocker | Each cell gets an authored qualifying task (full span, stated parts, tempo range); shorter or easier exercises guide but never pass it; attempts record span, parts, assistance, instrument revision, and policy versions; checkpoint rules at policy-version boundaries. |
| F03 calibration overreach | Accepted | No individual bias subtraction without independent evidence; ratings stay explicit reports at B1; paired on-device aggregates and consented export; small teacher-rubric validation study; scorer frozen before any mapping is fitted. |
| F04 no tested whole | Accepted | Boundary exercises across section joins; a complete-piece Continuity task with click-free performance allowed; "all sections practised" and "piece played through" become distinct states. |
| F05 precedence, not constants | Accepted, including its challenge to the panel's band-correction rule | The reviewer's transition table becomes the normative core of the engine spec; one difficulty controller; success bands demoted to diagnostics during beta; single-performance rating anchors; defined fallbacks for the attempt cap and late-session cases. |
| F06 effort model contradiction | Accepted | The first lesson is timed through the real pipeline before any date is promised; the first-quarter list becomes a prioritised queue; the spike is restated as 32 technical hours with a 6-hour iOS box; a 2 h/week operations reserve joins the budget. |
| F07 Brahms has no pedal part | Accepted — a factual error of ours, verified by the reviewer against the first edition | Brahms op. 122 no. 8 is relabelled manualiter (the design mockups already say "manuals · legato"); the exact first-pedal work must be committed (a named Franck piece with its bass treatment declared editorial, or a verified replacement); BWV 553's attribution gets its "formerly ascribed" qualifier. |
| F08 offer codes are not seats | Accepted | No seat entitlement is advertised before the billing route is proven in sandbox; institutional recruitment proceeds on ordinary individual subscriptions. Amends D-46; owner note below. |
| F09 entitlement lifecycle | Accepted | The reviewer's commerce state table is adopted wholesale; A-7 is reinterpreted as honoring the known paid-through date plus grace, never "lock 14 days after last contact"; restore is user-triggered; lifetime, if it existed, would be a non-consumable. |
| F10 false processing boundary | Accepted | The claim becomes the narrower true one — no hosted learner-progress database — with a data inventory naming every processor, purpose, and transfer; the absolute Swiss/EU-only NFR is dropped or the vendors change. |
| F11 organization address | Accepted | The address-privacy rationale for the organization account is deleted; a publishable business address is chosen deliberately; the D-U-N-S 30-day lead time enters the plan; Apple's sole-proprietor rule noted for the port. |
| F12 pruning is not a size strategy | Accepted — the reviewer's 58.8 MiB scenario disproves A-8 as written | Durable progress and raw capture split into separate stores; events and downloaded lessons excluded from Auto Backup; byte caps and retention for recordings; quota and restore tests become a B1 gate. |
| F13 render/task joining contract | Accepted | Generated tasks restricted to authored legal boundaries; stable note/bar/variant/system IDs, excerpt offsets, repeat-occurrence maps; boundary-note rules; the spike's rendering slice tests this contract, not just a static render. |
| F14 acoustic switch limits | Accepted | The acoustic switch applies to synthetic sound and labelled MIDI reconstructions only; microphone and reference audio play in their recorded acoustic. |
| F15 incomplete decision record | Accepted | The next spec revision carries the full consolidated decision table with superseded entries marked; architecture assumptions get their own prefix (AA-n); grouped open item R-3 splits into gated rows. |

## 3. Supporting sections, adjudicated

- **The learning-policy table** is adopted as the normative statement of
  the engine's evidence semantics, replacing the looser prose of
  architecture section 6. Its two invariants (fragment alignment is not
  span completion; absent streams are not missed notes) become scoring
  requirements.
- **The self-assessed product section** is adopted: single-performance
  observable anchors plus "not sure", prediction labelled as reflection,
  listening tasks never silently adjusting keyboard scores, recording
  optional with a complete path without it, and the five-person usability
  check.
- **Sellability**: adopted. The paid pilot with predeclared gates and a
  stop/revise rule replaces any implied launch-scale claim; the sequencing
  fix (recommendations so a free-lesson finisher always sees a suitable
  next step, and the 565 exercise labelled a demonstration) enters the
  catalogue and app requirements; the panel's market and churn numbers are
  demoted to unevidenced colour. The revenue scenarios are kept as
  goal-setting, not forecasts.
- **Gap table** (onboarding, accessibility and console ergonomics,
  interruption and recovery, localisation mechanics, support capacity,
  content/OTA lifecycle, asset provenance, shared-device policy): all
  eight adopted as gated work items at the reviewer's stated gates
  (before B1 / scored beta / B3 / public distribution).
- **Assumptions and open-items audits**: adopted, including the seven new
  assumptions and the verified Play policy facts. The Google 1:1
  music-lesson billing exemption is recorded as the confirmed basis for
  the tutoring link.
- **The 32-hour spike plan** replaces the phase 0 row: it is the same
  spike, honestly budgeted, with the 6-9 pre-spike specification hours
  (F01/F02) explicitly outside it.
- **Enhancements**: evidence labels, the printable score, and the
  readiness card are adopted in that order; the goal-date option stays
  conditional on beta demand.

## 4. Two decisions for the product owner

Both amend D-46, which was an owner decision; the adjudication recommends
accepting the reviewer on both, and neither blocks the pre-spike work.

1. **Cut the founding-member lifetime tier.** The reviewer's case: CHF 249
   is ~2.6 annual payments traded for an unbounded content and support
   promise, made exactly when the most engaged cohort's renewal behaviour
   is the thing worth studying. Recommendation: accept; revisit lifetime
   only after support load and content cadence are measured.
2. **Defer the institutional seat tier until its billing mechanism is
   proven.** Recruit through institutions on ordinary subscriptions
   meanwhile; promise no seat entitlement the app cannot deliver.
   Recommendation: accept.

## 5. What happens next

1. The owner rules on the two D-46 amendments.
2. The three documents are revised (spec 0.8, catalogue 0.3, architecture
   0.4) folding sections 2 and 3 above; the decision table is consolidated
   per F15. The reviewer prices the essential pre-spike share of this at
   6-9 hours of founder attention — the revision drafts can be prepared
   here, but the qualifying-task definitions per lesson and the
   input-capability contract need the organist's judgment.
3. The spike runs on the reviewer's 32-hour budget with its evidence
   requirements as exit criteria.
4. The design canvas needs three small copy corrections flagged by this
   round: the catalogue mockup already labels Brahms as manuals (correct);
   the 565 entry's "demonstration exercise" label is confirmed correct;
   nothing else in the mockups contradicts the adjudication.
