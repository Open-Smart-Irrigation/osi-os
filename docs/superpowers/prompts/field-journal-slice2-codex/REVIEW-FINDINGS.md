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

---

# Task 13 external review — ACCEPTED (2026-07-16)

Reviewed `52cc8637` (feature), `7343540d` (R1), `a3f59dc8` (notes). Every claimed gate was
re-run independently and matched: tsx-runner 93/93, Vitest 887/887 across 120 files,
TypeScript clean, production build green, edge 45/45, worktree clean.

R1 is correctly closed: the assertion now proves a non-empty definition and a non-empty
English label. R2 was correctly honoured — carry-forward stayed definition-driven through
`declaredCarryForward` with no `full_record` fallback. N1 and N2 were correctly left alone
with no spurious hard stop.

The 5-tap SLA is absent from Task 13 by correct scoping: Task 14 owns it.

**Verdict: Task 13 is accepted and ready to merge. Task 14 may proceed.**

## F5 — ACCEPTED DEVIATION, do not re-litigate

The UX addendum P2 (verdict: Adopted) specifies the confirmation as "one generated journal
sentence … every token tappable to edit", whose stated purpose is that prefills are "read in
one glance". The shipped `ConfirmStrip` renders a two-column grid of labelled tokens
instead. It satisfies STD-1 (interpreted value + unit repeated), §6.2 (plot and layout
shown), tappable tokens, and the in-flight Finish lock; it does not deliver the glanceable
sentence.

Origin: the amended Task 13 plan reworded P2 to "plain-language … tokens" and never used the
word "sentence". The implementation followed the plan faithfully. This is plan-to-spec
drift, not an implementation defect.

**Adjudication (product owner, 2026-07-16): accepted as-is. Revisit later.** A generated
sentence needs localised labels to be worth anything, and catalog labels are English-only
today (N2), so the sentence is naturally sequenced after the label work. The token model
already carries `label`/`value`/`unit`/`step`, so rendering a sentence later is contained to
`ConfirmStrip`.

**Required behaviour:** do not rewrite `ConfirmStrip` into a sentence during Slice 2. Do not
raise this as a finding again. It is scheduled for the live-verification and enhancement
round after the firmware image is built.

## Note for the remaining phases

sol reviews against the plan, so when the plan itself drifts from the source spec (the design
doc and UX addendum), sol will not catch it — F5 is an instance. Where an amended task
reworders an adopted U- or P- decision, keep the addendum's wording in the task text so the
drift is visible at review time.
