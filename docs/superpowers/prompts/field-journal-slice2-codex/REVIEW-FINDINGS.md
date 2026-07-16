# Reviewer findings for the Slice 2 controller

Independent review of commits `f651b0ec..6c6fc453` (Phases 0–3 Task 12), 2026-07-16.
Full analysis: `docs/superpowers/plans/2026-07-16-journal-catalog-completeness.md`.

Read this once, act only on the IN-SCOPE items, and record the outcome in `RUN-NOTES.md`.

## Verified independently — no action

Edge 45/45; both profile `api.js` copies byte-identical; GUI TypeScript clean; 222/223
journal tests (the single red was the live Task 11 cycle, since resolved). The Phase 0
deviation, the Phase 1 contract corrections, and the Task 11 `attr.amount_*` fix were all
correct. Nothing in the committed work needs reverting.

## IN SCOPE — act on these

**R1 — strengthen the Phase 0 assertion (small, do when convenient).**
`scripts/test-journal-api.js`, the `include=definitions` test, asserts
`assert.ok(template.definition && typeof template.definition === 'object')`. An empty `{}`
passes that, so if `labels_json` were ever dropped upstream of `catalogDto` the definitions
would silently return empty and the gate would stay green. Add non-emptiness, for example
`assert.ok(Object.keys(template.definition).length > 0)` plus an `en` label check. Real
values today: `farmer_quick.definition` 3 keys, `agroscope_open_field.definition` 6 keys.
Mirror any edit to both profiles only if you touch module code; this is a test-only change.

**R2 — do not compensate in the GUI for `full_record` carrying nothing.**
Shipped definitions: `farmer_quick.carry_forward = ["attr.operator","attr.equipment","attr.method"]`;
`full_record` and `research_observation` declare none. `research_observation` is correct
(P3 forbids silent defaults). Whether `full_record` should declare the low-risk trio is an
open product question owned by the human, and its answer is catalog data, not GUI code. Keep
reading `carry_forward` from the definition as you do now. Do not hardcode a template-specific
fallback list to "fix" it.

## OUT OF SCOPE — do NOT act, do NOT hard stop on these

**N1 — every core product ships an empty `composition_json`, and no `mineral` product exists.**
All 10 products carry `{}` with no parse errors. This means U5 product-first nutrient
derivation and the SoilManageR derived rates produce nothing against the real catalog, while
your fixture-based tests pass. **This is known, it is a Slice 1 catalog-data gap, and a human
owns it** (remediation is an additive migration `0022`, which your mission forbids you from
attempting).

Required behaviour: keep implementing the nutrient-derivation path against the contract and
your fixtures exactly as planned. Do **not** weaken, skip, or stub the feature because live
compositions are empty. Do **not** author or edit a migration. Do **not** raise a hard stop
for this — it is expected and already owned.

**N2 — catalog labels exist for `en` only** (266 vocab, 3 templates, 4 layouts; 6 shipped
locales missing). Also known and human-owned: spec §6.4 requires native agronomic review for
de-CH, fr, and lg, so labels cannot be auto-translated. Continue resolving labels from
`labels_json` with an English fallback as the engine already does. Do **not** generate,
machine-translate, or seed catalog label translations. Do **not** hard stop for this.

## Summary

Continue Phase 3 at Task 13 on the current path. The only change requested is R1.
