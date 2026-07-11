# Refactor-program intake — 2026-07-11 mobile-history review & rollup analysis

> **Audience:** the refactor-program orchestrator. This is a scheduling/adjudication request, not a work order — nothing below executes until you slot it. Written by the review session that produced the two plans referenced here.

## Prompt to the orchestrator

You own sequencing for the 2026 refactor program (`docs/architecture/refactor-program-2026.md`). Two new plans exist that touch program-owned seams (`osi-history-helper`, `history-api-router-fn`). Your job with this intake:

1. **Slot both plans into the program schedule as serialized work — no parallel execution** with each other, with 4.2, or with anything else touching `osi-history-helper` / `history-api-router-fn` / the history locale files. Both plans assume single-owner execution.
2. **Enforce the hard ordering constraint below** (everything before 4.2's golden-vector capture).
3. **Adjudicate the three decision points** (or route them to Phil where they are product calls).
4. Record the outcome in the program table / open-decisions doc as you normally would.

Do not re-derive the findings — evidence trails are linked. Verify claims only where they gate your decisions.

## The two plans

| Plan | Scope | State |
|---|---|---|
| `docs/superpowers/plans/2026-07-11-mobile-history-review-fixes.md` | 13 tasks fixing the 2026-07-11 live mobile review findings: 12 frontend (react-gui only), Task 5 backend (helper + router call site, both profiles), Task 13 live kaba100 verification | Written, not executed |
| `docs/superpowers/plans/2026-07-11-rollup-hardening.md` | 5 tasks: `rollupRowsToResult` invariant guard + contract docs, multi-device merged-scope golden tests, coverage-denominator clamp at `now`, expose `aggregation.source` on the card-data payload, draft P1/P2 decision entries | Written, not executed |

Supporting evidence: review findings + verification history in `docs/ux/history-data-visualization-kaba100-issues.md` (pre-existing) and the analysis summarized in the hardening plan's header; screenshots `/home/phil/playwright-osi/screenshots-mobile-gesture-review-2026-07-11/`; reusable CDP gesture driver `/home/phil/playwright-osi/mobile-gesture-suite/`.

Facts you can rely on without re-checking (verified 2026-07-11): `osi-history-helper/index.js` is byte-identical on `main`, `feat/refactor-and-forge-handoff`, and across both profile mirrors; the suspected rollup overwrite bug does **not** exist (merged cards store union aggregates under one `logical_source_key`; confirmed live on kaba100); rollup write/read paths are tested in `scripts/test-history-helper.js` but only with single-device scopes.

## Hard sequencing constraint (the reason this intake exists)

**All of the following must land before 4.2 (Extract History API Router) captures its pre-extraction golden vectors:**

- Mobile plan Task 5 (changes `buildLocalInterpretations` output — the false "Sensor data is incomplete" banner),
- Hardening Task 3 (changes coverage values for in-progress windows),
- Hardening Task 4 (changes the card-data payload shape: adds `aggregation.source`).

DD4 requires vectors captured **before** extraction; captured too early they enshrine the buggy interpretation output, the future-inflated coverage denominators, and the pre-`source` payload shape — 4.2 would then freeze bugs as the contract. 2.2 and 2.4 are done and 4.2 is next in the DD4 order with spec+plan ready, so this is a live constraint, not theoretical. Inside that boundary the natural order is: **mobile plan → hardening plan → 4.2** (hardening Task 3 assumes mobile Task 5 landed; both plans document the alternative order if you choose it).

Secondary interaction: mobile plan Tasks 1–4 and 6–12 are react-gui-only and conflict with nothing in the program; they can precede everything else whenever a deploy window to kaba100 exists (Task 13 rides the runbook deploy flow).

## Decision points needing adjudication

1. **P1 — per-source rollup key scheme** (drafted into `refactor-program-2026-open-decisions.md` by hardening Task 5). Gates the future "environment per-source series split" spec (the sawtooth fix). Decide the key scheme before that spec is written. Recommendation in the draft: per-source rows alongside merged rows, dendro-pattern keys, additive.
2. **P2 — 1.A3 residue.** The 1.A3 plan specced "relocate the 2,141-line suite + retire the scripts copy"; what landed is a 446-line co-located suite plus the un-retired scripts suite, both CI-wired, with all rollup coverage living only in the scripts copy. The program table says "1.A3 done". Options in the draft; recommendation: finish the relocation at the next helper touch and amend the table wording. This also decides where the hardening plan's new tests eventually live (they append to the scripts suite for now, deliberately).
3. **Interim-fix supersession order.** Mobile Task 5 (interpretation-layer rescale, ships with the user-facing batch) is superseded by hardening Task 3 (aggregation-layer clamp). Default: mobile first, hardening reverts the rescale. Alternative (fewer total changes, delays the user-visible banner fix until hardening lands): run hardening first and execute mobile Task 5 with the reduced code — both plans carry explicit instructions for either order. Your call; the plans just must not both be active in their unreconciled forms.

## Program-slotting suggestion (non-binding)

The hardening plan is a natural Phase-1-style ratchet item (guard + tests + honesty fixes on an already-extracted module) — e.g., a new `1.A6 osi-history-helper rollup hardening` row, dependency "before 4.2 vectors". The mobile plan is a product-fix stream outside the program proper; it only intersects via Task 5, which the ordering constraint already covers. The deferred "environment per-source series split" should NOT be scheduled until P1 is adjudicated.
