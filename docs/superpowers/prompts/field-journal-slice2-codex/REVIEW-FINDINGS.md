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

---

# Task 14 external review — CHANGES REQUIRED (2026-07-16)

Reviewed `6ede2ff2` (feature) and `31082aae` (notes). Every claimed gate was re-run
independently and matched exactly: tsx-runner 93/93, Vitest 921/921 across 121 files,
TypeScript clean, production build green, preview suite 7/7, edge 45/45, worktree clean.
The reported numbers are accurate.

**The browser-evidence blocker is resolved.** The controller could not drive its in-app
browser (`browser-client is not trusted`). The reviewer ran the required verification
externally with Playwright/Chromium against the committed preview at both required
viewports. Task 14's own scope passes:

- 320x568 and 360x640, journal timeline and zone-preselected capture: **no horizontal page
  scroll** (scrollWidth == clientWidth at both).
- Capture flow: 8 controls at >=56px; confirmation content visible.
- Keyboard focus order is sane and fully visible: Close, Search activities, activity grid,
  Browse all, Back. No focus traps, no off-screen stops.
- No page errors on the journal path.

The preview harness itself is sound: it compiles the **real** Agroscope catalog and runs
final payloads through the shipped edge validator, and it refuses to start without an
explicit `TASK14_PREVIEW=1` opt-in. Screenshots are reviewer-side artifacts, not committed.

**Verdict: Task 14 is NOT ready to merge. F6 must be fixed. The phase-gate hold was correct.**

## F6 — IMPORTANT, Task 14's own code: a user's crop edit is silently discarded

`JournalCaptureFlow.tsx` `payloadValues` (the `if (cropValue)` block, added by `6ede2ff2`)
unconditionally overwrites `attr.crop:0` with the zone-derived crop **after** form
validation. The full-record layout renders `attr.crop` as an editable choice control seeded
with that same value, and no path syncs a form edit back to `crop` state.

Reproduced with a temporary probe against the committed code (probe removed; worktree left
clean):

| step | observed |
|---|---|
| seeded from zone | `agroscope.crop.barley_winter` |
| user edits the control to | `agroscope.crop.barley_spring` (control displays the edit) |
| **sent in the final payload** | **`agroscope.crop.barley_winter`** |

Failure scenario: a zone-linked plot whose zone crop label says winter barley, a farmer
using Full record who corrects the crop to spring barley. The control accepts and shows the
correction, then the payload reverts it. The farm record stores the wrong crop. This record
is intended to support compliance profiles later, so a wrong crop is a real-world data
defect, not a cosmetic one. The confirmation step does render the payload value, so an
attentive user can catch it — that is a mitigation, not a fix: the control is a dead end
that accepts input and throws it away.

Required: the zone crop must **seed** the field, not **override** it. Apply the zone value
as an initial form value and let the form own it thereafter, or apply the override only when
the form supplies no explicit `attr.crop`. Keep the existing label-to-code mapping and the
unmatched-label fallback to `season_crop` exactly as they are — that part is correct.

Missing regression to add: edit the seeded full-record crop control, finalize, and assert
the **edited** code reaches the payload. The current test
(`seeds a mapped zone crop into the editable full-record crop choice`) asserts the seed and
never edits it, which is why the defect passed 921 green tests.

## F7 — IMPORTANT, evidence gap: the 5-tap SLA is not evidenced for the shipped default layout

The five-activation test counts genuine user activations on role-visible controls, ends on a
rendered `Saved on farm gateway` receipt, and asserts a single final write. The counting
method is honest. Its **fixture** is not representative:

- The test fixture declares `minimum_fields: []` and empty template `requirements`.
- `templateEngine` marks layout `minimum_fields` as **required** (`addField(field, true)`).
- Shipped layouts: `open_field` **4** required minimum_fields
  (`attr.block_bed_row`, `attr.treated_area`, `attr.cover_type`, `attr.denominator`),
  `greenhouse` **6**, `lysimeter` **12**, `agroscope_open_field` **0**.
- `farmer_quick.carry_forward` is only `operator`/`equipment`/`method` — it prefills **none**
  of those minimum_fields.
- Task 14's **own preview fixture uses `layout_code: 'open_field'`**, i.e. the run's own
  realistic default is a layout the SLA test does not model.

So `<=5` is demonstrated only for a zero-minimum-field layout. On `open_field` the user must
additionally satisfy four required fields that nothing prefills, and the gate cannot detect
the gap. This is not necessarily a code defect — it may be a catalog/product question about
whether `open_field` is the right default or whether those fields should carry forward — but
the headline SLA claim is currently unevidenced for the default path.

Required: re-run the activation counter against an `open_field`-shaped fixture (4 required
minimum_fields, `farmer_quick` carry-forward) and report the true count. Do **not** edit
catalog data or migrations to make the number smaller (N1/N2 remain out of scope). If the
count exceeds five on the shipped default, stop and report it as a product question with the
measured number; that is a legitimate hard stop.

## Minor — no action required this task, recorded for later

- `canonicalCropValue` returns raw free text when `attr.crop` is absent or non-choice, while
  `withCanonicalContextCrop` gates on `value_type === 'choice'`. The payload injection does
  not gate. Unreachable with the shipped catalog (0019 ships a choice-typed `attr.crop`), and
  the edge rejects `invalid_choice` regardless. Fixing F6 likely removes this seam anyway.
- The confirm-layout assertions use `not.toHaveClass('flex-nowrap', 'overflow-x-auto')`, a
  negated conjunction that passes when only one forbidden class is present. The positive
  `flex flex-wrap` and inline `minHeight` checks carry the real weight. jsdom cannot prove
  computed layout — the reviewer's browser pass now covers that.

## Not Task 14's — reviewer-owned, FIXED, do NOT act on these

The browser pass surfaced two defects in the **shared AppHeader** (design work that predates
this run; `6ede2ff2` did not touch `AppHeader.tsx` and changed only the Add menu's navigate
target). The reviewer fixed them; they are recorded here so the run does not re-report them:

- The AppHeader actions row did not wrap while its parent container did. On the Zones page
  the extra Add button pushed the row to 373px, so the page scrolled horizontally below
  ~389px: 320px `+65px`, 360px `+29px`, 375px `+14px`. The Journal page, same header without
  an extra action, never overflowed — which isolated the cause.
- Header tabs measured 38.5px tall, below the 44px touch minimum the capture flow honours.

Fixed together, because wrapping alone traded the overflow for a 207px sticky header on a
568px screen: header buttons now run compact below `sm`, Settings is icon-only on phones with
its full label as the accessible name, tabs take a 44px minimum under `pointer: coarse` only,
and the action row wraps as a safety net. Verified in-browser: Zones and Journal both 137px
with no overflow at 320/360/375/390/414 across **all seven locales** (English alone fitted
before; German `Einstellungen` was what forced the third row), desktop unchanged at 79px with
the compact 38.5px pill. `DashboardHeader.test.tsx` gains two red-verified regressions.

Do not "fix" the AppHeader further, and do not revert the icon-only Settings.

## Note for the remaining phases

Two review blind spots compound, and both showed up here:

1. sol reviews against the plan, so plan-to-spec drift is invisible to it (F5).
2. sol reviews against the **fixtures the task itself defines**, so a fixture that is easier
   than the shipped catalog makes a green gate meaningless (F7). Where a task asserts a
   product SLA, the fixture must match shipped catalog data, or the assertion proves nothing.

F6 is a third pattern worth naming: a test that asserts a value is *seeded* into an editable
control, without ever editing it, will not notice that the control is a dead end. When a
field is both prefilled and user-editable, the regression must edit it and assert the edited
value survives to the payload.

---

# Label decision: "Growing setting" is now "Layout" (2026-07-16)

Product-owner decision, applied by the reviewer in `journal.json` (all seven locales),
`JournalCaptureFlow.tsx` and the locale tests. **Do not revert it toward the spec's old
wording**, and do not re-report it as spec drift — the spec §6.2 has been updated to match.

The i18n keys `capture.where.growingSetting` and `capture.form.growingSetting` are renamed to
`capture.where.layout` / `capture.form.layout`. `capture.confirm.layout` keeps its key and
gains the new value. The embedded phrase in `capture.picker.unsupported`,
`capture.validation.layoutTemplateMismatch` and `capture.carry.invalidated` now reads
"layout" in every locale.

**Nothing below the GUI changes.** `layout_code`, the `layouts[]` REST payload, the catalog
codes and `templateEngine`'s signature were already correct and are untouched — the code name
was right all along and the UI label was the outlier.

Rationale, so it is not re-litigated: a layout is a neutral container. v1 happens to ship
cultivation settings, but a future layout may mean something else, so the label must not bake
"growing" into the axis. "Growing setting" was also untranslatable — "setting" reads as
either *configuration* or *environment*, and six independent translators split evenly between
those two readings. "Layout" is deliberately the same word in all seven locales and is
recorded in the `SHARED_WITH_ENGLISH` allowlist.

If Task 14's follow-up work touches `JournalCaptureFlow.tsx`, rebase onto this rather than
resolving the two `t()` call sites back to the old keys.

## F7 — Product-owner adjudication (2026-07-17)

The product owner accepted a two-tier activation target. The shipped uncached
`open_field` capture path may require at most nine primary-control activations
from the zone CTA through the rendered `Saved on farm gateway` receipt. Five
activations remains a conditional target only when every required field has a
safe, explicit default from current plot state or a compatible confirmed record
under an approved policy.

The current release has no approved safe-default policy for
`attr.block_bed_row`, `attr.treated_area`, `attr.cover_type`, or
`attr.denominator`. Catalog rows, migrations, and carry-forward behavior remain
unchanged. The durable Task 14 test therefore uses the shipped `open_field`
definition from migration `0019__journal_catalog_v1.sql`, starts all four
minimum-field controls empty, enters their shipped value types and codes, and
asserts the nine-activation bound. F7 is resolved by this two-tier target; the
conditional five-activation tier is not claimed as current support.

---

# Phase 3 review — Tasks 8–12 (2026-07-17)

Tasks 8–12 previously received gate verification only; my findings then (R1/R2/N1/N2) were all
about catalog data, not their code. This is the code review they did not get. F5 and F6 were
both found only by looking properly, and Tasks 8–12 have exactly what F6 had: a green gate.

## Verified clean — no action

**Occurrence / DST (Task 8) is correct and honestly tested.** `occurrence.test.ts` uses the
real Europe/Zurich transitions, and I checked those dates against the IANA database rather
than against the test's own assumptions: on 2026-03-29 the offset moves +01:00 to +02:00 and
local 01:30 jumps to 03:30, so 02:30 does not exist; on 2026-10-25 the offset drops
+02:00 to +01:00 and both 00:30Z and 01:30Z render as local 02:30, so the fold is real. The
fold offsets are arithmetically right (120 to 00:30Z, 60 to 01:30Z). Nothing to do.

**The protected-code set is complete for the shipped catalog.** The shipped
`plant_protection_application` requirement is `attr.treated_area` plus `required_any` over
`attr.product_uuid`/`attr.product` and
`attr.amount_mass_area_product`/`attr.amount_volume_area_product`/`attr.amount_biological_count_area`.
Every one is in `PLANT_PROTECTION_PROTECTED_CODES`. `attr.agroscope.crop_product` and
`attr.agroscope.cc_product` look like products by name but are numbers ("Exported crop
product", "Product carbon concentration"), and `attr.amount_nutrient_rate` is fertilisation,
which AGR-7 does not cover. The Task 11 prefix fix did not leave a shipped hole.

## P1 — IMPORTANT: the protected set was written from imagination, not from the catalog

`carryForward.ts` protects twelve codes that **do not exist in the catalog** (`attr.dose`,
`attr.rate`, `attr.application_rate`, `attr.authorization`, `attr.authorization_number`,
`attr.dose_basis`, `attr.basis`, `attr.application_basis`, `attr.area_treated`,
`attr.waiting_period`, `attr.phi`, `attr.phi_days`) while **missing `attr.denominator`**, the
only dose-*basis* code the catalog actually ships (per-area / per-plant / per-row) and a
required `open_field` minimum field.

Latent today: no shipped template lists `attr.denominator` in `carry_forward`. It bites when a
tenant or custom template does — `parseTemplate` validates `carry_forward` only against
`knownField`, so `attr.denominator` would flow into `automaticValues` and silently prefill the
basis. Source "per plant", farmer applying "per area", no confirmation: the dose is wrong by
the plant-count factor.

Required: add `attr.denominator` to the protected set. Drop or comment the phantom codes —
they cost nothing at runtime but they are why nobody noticed the real one was missing. Then
add a test that derives the expected protected set **from the compiled catalog** rather than
from a hand-written list, so this cannot drift again.

## P2 — IMPORTANT (mechanism confirmed by inspection; NOT reproduced end-to-end)

**Be honest about this one: I could not reproduce it in a probe, and I am not claiming it is
proven. Verify it before you fix it, and if it turns out unreachable, say so and close it.**

The claim: confirmed "Repeat last treatment" values survive a plot switch without
re-confirmation, violating AGR-7's "invalidated on crop/season/layout change".

What I did confirm by reading:
- `RepeatTreatmentCard.tsx` has exactly one `useEffect` and **no cleanup function**, so
  unmounting the card never calls `onInvalidate`.
- `selectPlot` retains any value **not** in `automaticPrefillRef`, and confirmed repeat values
  never enter that ref — only `applyAutomaticPrefill` writes it.
- `selectPlot` then sets `carryForwardCandidate` to null, which unmounts the card.
- No test covers it: exactly one test clicks `capture.carry.useValues`, and none switches plot
  afterwards.

Why I could not prove it: `protectedCatalog` never renders a `useValues` button (its preview
is deliberately incomplete), and the fixture that does render one (`invalidRepeatCatalog`) is
built around a max-exceeded value. A probe needs a third fixture: a complete, valid
plant-protection source whose preview renders.

Reproduce with: confirm the repeat card on plot-1, go Back to Where, switch to plot-2,
continue, and assert the protected values are **gone** from the payload. `chooseLayout` is
likely a second path to the same hole (it nulls `leaf`, which nulls `carryForwardContext`).

## P3 — MINOR, unverified: tank-mix confirmation may under-disclose

Card facts appear to use only the first row per code, while the confirmed set carries every
protected row across all `group_index`. A source with product A (group 0) and product B
(group 1) would show A, and confirming would land B unseen. Unverified by me; no shipped
multi-group source exists to trigger it today.

## Minor — record, do not chase

- Float drift in canonical conversion: 0.07 ha yields 700.0000000000001 m². Entered facts stay
  exact; the drift reaches sync and exports. Cosmetic until someone diffs an export.
- `min`/`max` are checked against the **entered** value while constraints are defined in
  canonical units. Harmless today (multi-unit attributes only carry `min: 0`), but the first
  `max` on a multi-unit attribute will mis-validate across units.
- One malformed final entry anywhere nulls the whole carry-forward page, disabling AGR-7
  farm-wide. Fail-closed, so safe, but silent.

## Scope note

Tasks 9, 10 and 12 (ActivityPicker, entry controls, drafts queue) remain **unreviewed**. Do
not read this section as a clean bill for Phase 3.

---

# Task 14 external re-review — ACCEPTED (2026-07-17)

**Record correction first.** The run's notes state "the user reports that Task 14 is externally
approved". No such external acceptance had been issued — the standing verdict in this file was
still CHANGES REQUIRED from 2026-07-16. The run proceeded on a relayed verbal approval that the
review record did not contain. That gap is closed by this section; the acceptance below is now
the record. Relayed approval is not a review artefact — if a future phase needs the external
reviewer's sign-off, wait for it in writing here.

**F6 is fixed, and I proved it rather than taking the claim.** The probe that previously showed
a discarded edit now shows it surviving: seeded `barley_winter`, user edits to `barley_spring`,
payload carries `barley_spring`; `season_crop` correctly keeps the raw zone label as context.
The fix shape is right — `formOwnsCrop` gates the injection so the zone crop seeds only paths
with no crop control, and the form wins wherever it owns the field.

**F7's evidence gap is closed in substance.** I verified the pinned SLA fixture against the
**compiled catalog**, not against its own assertions: `farmer_quick@1` sections,
`max_primary_fields: 5` and `carry_forward: [operator, equipment, method]`, plus `open_field@1`
`minimum_fields: [block_bed_row, treated_area, cover_type, denominator]` all match the real
generator output exactly. The nine is therefore an honest measurement of the shipped default,
and `expect(primaryActivations).toBe(9)` is an exact pin rather than a `<=` that could rot
upward. The two-tier target is recorded in spec §257.

**Verdict: Task 14 is accepted.** Gates re-run independently on the current tree: TypeScript
clean, 939/939 Vitest across 122 files.

## F8 — MINOR follow-up: the SLA fixture is not linked to the catalog it claims to pin

`captureCatalog` (`JournalPage.test.tsx:153`) is hand-built and never imports
`journal-catalog-core` / `catalog.json`. The test asserts hand-built fixture **equals a
hand-written expectation** — both authored in the same commit. Today both happen to match the
real catalog (I checked). But nothing links them to it: add a fifth `minimum_field` to
`open_field` and the fixture and its expectation stay in sync with each other, the test keeps
passing at nine, and the SLA claim silently becomes false.

This is the same shape as P1's protected-code set: a hand-maintained mirror of catalog data,
validated against another hand-written copy rather than against the source of truth. Same fix
for both — derive the expectation from the compiled catalog (`scripts/journal-catalog-core.js`
+ `generate-journal-catalog.js`, as `scripts/task14-journal-preview.js` already does), so drift
in the real catalog breaks the test that depends on it. Not urgent; do it when P1 is done, and
do both the same way.

## Phase 4 sequencing

Phase 4 was authorised by the product owner while Phase 3 review is still open. The run recorded
that scope correctly: it does not mark Phase 3 complete or waive findings. Standing constraints
for Task 21 and anything else touching capture:

- P1, P2 and P3 stay Phase 3-owned. Do not fix them inside Phase 4 commits, and do not overwrite
  a landed Phase 3 fix.
- Tasks 9, 10 and 12 (ActivityPicker, entry controls, drafts queue) are **still unreviewed**.
  Phase 4 building on them is a sequencing risk the product owner accepted, not a clean bill.

---

# Phase 3 review — Tasks 9, 10, 12 (2026-07-19)

The three Phase 3 tasks that had gate verification only. Reviewed against the spec and the
compiled catalog, not against the plan. One Important finding, one refuted suspicion, one
honest scope gap.

## Task 9 — ActivityPicker: CLEAN (verified)

I hunted one plausible correctness bug: prefix-leaf shadowing. `openActivity` (line 197) and
`chooseDependency` (line 210) auto-pick a leaf that is "complete at the current depth", so if
the catalog produced both `[activity, a]` and `[activity, a, b]`, choosing `a` would fire the
short leaf and the user could never reach the long one.

It is not reachable. `deriveActivityLeaves` (`catalogModel.ts:681`) emits only maximal-depth
leaves — `expand` pushes a leaf only when there is no further target, so no leaf is ever a
prefix of another. I verified this empirically against the real research layout
(`agroscope_open_field`, the only one with dependencies — 122 option_dependencies, 32
choice-restricting): 129 derived leaves, all at depth 2, **0 prefix violations**. So the
cascade is live (not dead code) and the auto-pick is safe. Icon collisions (`mowing` and
`weed_control` both `⌁`) are cosmetic.

## Task 12 — useCaptureDraft / SaveState: sound; one refuted suspicion, one minor

The honest-save logic is correct: `draft-saved-gateway` is set only after the gateway
confirms the write (line 142); `final-saved-gateway` requires both HTTP success and a
non-empty `outbox_event_uuid` (lines 252-260); writes are serialized through
`requestTailRef` so an update cannot race its create; `finish` is idempotent; partial
failure over-warns (`not-saved` + lossWarning) rather than under-warns. Good.

**Refuted:** I suspected the hardcoded `base_sync_version: 0` on every write (lines 110, 231)
would collide with edge optimistic concurrency on repeated debounced draft saves. It does
not. The edge `saveDraft` (`lifecycle.js:1322`) requires **both** `existing.sync_version === 0`
and `input.base_sync_version === 0`, and draft updates deliberately never bump the version
(written back with `sync_version: 0`, line 1320) — the version only moves to 1 on
finalization. Sending 0 every time is exactly the contract. Verified against the edge, not
filed as a finding.

**P5 — MINOR:** `cloud-waiting` is a declared `CaptureSaveState` (line 17) that `SaveState.tsx`
renders (`capture.save.cloudWaiting`) but this hook never sets. It is the D6 "saved on OSI
Server — waiting for farm gateway" state, i.e. the cloud write path (D2, pending-commands),
which is a later slice. So it is likely correct-for-now, but the type and renderer imply a
completeness the hook does not deliver: a future dev could assume the cloud-waiting path works
when nothing exercises it. Either wire it when the cloud write path lands, or comment why it
is intentionally unreachable in the edge hook.

## P4 — IMPORTANT: low-risk carry-forward is inert on the shipped catalog, both templates

The run flagged "attr.method carry-forward is mapped but form pruning prevents retention in
the final payload" and deferred it. It is broader than method, and broader than a retention
bug: AGR-7 / P4's "operator, equipment, method carry by default with visible prefill marking"
works for **neither** shipped template.

`EntryForm` builds the payload from **visible** attributes only:
`visibleInputs = inputs.filter((i) => visibleCodes.has(i.attribute_code))` then
`buildEntryValues(model, visibleInputs)` (EntryForm.tsx:234-236, 326). A carried value for a
field the template does not display is silently pruned.

Against the compiled catalog:
- **farmer_quick** declares `carry_forward: [attr.operator, attr.equipment, attr.method]` but
  displays **none** of the three (its fields are activity/plot/occurrence + irrigation depth +
  two product-amount fields + note). All three are carried into state and then pruned. The
  low-risk carry is a no-op for the most common template.
- **full_record** displays all three as fields but declares **empty** `carry_forward`. So it
  shows them but never carries them.

The two templates are mismatched in opposite directions, so the feature fires in neither.

Root cause is a catalog/engine mismatch, not (only) the GUI: `parseTemplate` validates
`carry_forward` against `knownField`, never against the template's own visible field set, so a
template can declare carry-forward for a field it does not show and nothing catches it. This
is the same class as P1 — the catalog declares something the engine silently cannot honour.

Fix options (product + catalog owned): make `farmer_quick` display operator/equipment/method
as prefill-marked fields (satisfies P4's "visible prefill marking"), or move the carry_forward
onto `full_record` where they are already fields, or reject at parse time any carry_forward
code not in the visible field set so the mismatch cannot ship silently. The GUI's
prune-to-visible behaviour is itself defensible — do not "fix" it by emitting invisible
values.

## Honest scope gap — NOT reviewed

**NutrientRepeater derived-nutrient math (Task 10) was not deep-reviewed.** The Fable subagent
assigned to Task 10's unit/nutrient math terminated on a credit limit before reaching it. I
confirmed the two concrete leads myself (P4 pruning above; the min/max-against-entered-value
issue stays latent — 0 shipped attributes are both multi-unit and carry a `max`), but I did
not independently verify the composition→rate arithmetic, unit-basis alignment, or reactivity
on product/rate change. Because compositions ship empty (N1), that path produces nothing
against the real catalog and is fixture-only today, so the risk is deferred rather than live —
but it should be reviewed together with the composition-population work (migration 0022), not
assumed correct.

---

# Phase 4 review — partial (2026-07-19)

Reviewed the committed Phase 4 logic (Tasks 15–23) while Task 25 owns browser acceptance.
Gates cited for Task 24/25 re-verified on the current tree: 1182/1182 Vitest across 133
files, edge 45/45. **Task 25's own code (its preview harness, browser test) is not in this
checkout**, so this is not a Task 25 review — it covers the batch/plot logic Task 25 verifies.

## rangeSelection — CLEAN (verified)

`parseStationRange` (`rangeSelection.ts`) implements D11's `2, 5, 6, 10-12` input correctly. I
traced the one subtle part — the DoS-bounded range expansion. `lastValueToCheck =
min(end, start + availableNumbers.size)` caps the loop so `10-999999999` cannot spin, and it
can never truncate a *valid* range: for the loop to reach `start + size` without hitting
`out_of_station`, the station would need `size + 1` distinct consecutive members in a size-N
set, which is impossible. So an oversized range always resolves to `out_of_station`, and the
`formatStationRange` round-trip holds. Duplicate/reversed/non-integer/non-positive all fail
closed. One UX note, not a defect: overlaps like `1-5, 5` error as `duplicate` rather than
merging — strict, but defensible for catching typos.

## P6 — IMPORTANT: batch finalize is not retry-idempotent, unlike single-plot

D11 requires atomic all-N-or-none finalize. That holds *within* one request. It does not hold
*across* a retry, and batch differs from single-plot in a way that can silently duplicate a
farm record on every plot.

- **Single-plot** capture sends a stable client `entry_uuid` (`useCaptureDraft` generates it
  once, line 101, and sends it on every write). A retry after a lost response re-sends the
  same UUID, so the edge upserts — no duplicate. Retry is truly idempotent.
- **Batch** finalize sends `plot_uuids` only (`JournalCaptureFlow.tsx:190`,
  `buildFinalBatchPayload.ts:55`) — **no client `entry_uuid`, no client `batch_uuid`, no
  idempotency key**. The edge generates all of them. The only retry protection is the
  duplicate-guard (`findDuplicateCandidate`: plot + activity + occurrence + `status='final'`).

Failure scenario: a farmer finalizes a seeding batch over 5 lysimeters. The edge writes all 5
final entries, but the HTTP response is lost (a plausible farm-gateway network drop). The GUI
shows an error and a retry. The farmer retries; the edge's duplicate preflight now finds 5
matching finals and returns them as candidates; the GUI surfaces "a similar activity already
exists". Reasonably believing the first attempt failed, the farmer acknowledges and chooses
"save separately" — whose semantics (from Task 13) are *create a distinct record anyway* — and
the edge writes 5 more entries. Result: 10 entries, 5 spurious, one per plot.

The snapshot/`savePromiseRef` guards in `finalizeBatch` are correct — they prevent
double-submit from rapid clicks and keep the retry payload byte-stable. They do not close the
lost-response window, because the duplicate-guard defers to user judgment and the user's mental
model ("it failed") is wrong.

This may be the intended tradeoff — the Phase 4 preflight deliberately chose edge-generated
UUIDs ("the path does not use a client-generated UUID"), and the duplicate-guard is the
designed mitigation. But it leaves batches materially less retry-safe than single-plot, and the
weaker mitigation (guard + user judgment vs. stable UUID + no judgment) is exactly inverted
from where the blast radius is larger. Decision for the human: either accept the duplicate-guard
as sufficient for batches, or give each batch member a stable client `entry_uuid` (or the batch
a client `batch_uuid` used as an idempotency key) so a lost-response retry is a no-op the way
single-plot already is. Edge is 45/45 + 99/99, so this is a design question, not a failing test.

## Honest scope — NOT reviewed

Partial review. Still unreviewed by me: the rendering/interaction of `StationGrid`,
`PlotPicker`, `PlotGroupChips`, `PlotForm`, `HarvestGroupNudge`; the plot/group CRUD SWR seams;
and Task 25's browser acceptance (screenshots + keyboard at mobile widths), whose harness is
not in this checkout. The station grid at 72 plots is the highest untested mobile-layout risk
(horizontal scroll, 44px touch targets) and is exactly what Task 25's browser pass should cover
— worth confirming Task 25 actually exercised 72-plot widths, not a small fixture.

---

# P6 RESOLUTION — batch must be idempotent like single-plot (product owner, 2026-07-19)

**Decision:** "A batch should have the same behaviour as a single plot. The batch is only a
collection of single plots and should be handled by the backend the same way."

This reverses the Phase 4 preflight choice ("the path does not use a client-generated UUID").
It is now a required Phase 4 follow-up, owned by the run because it is the run's code, touches
the shipped edge contract, and needs edge-parity + sync discipline. **This is not a GUI-only
change** — a GUI patch alone is worse than nothing, because the edge would ignore client UUIDs
and still mint its own (`lifecycle.js:1433`).

## Target semantics (what "same as single-plot" means, verified)

Single-plot is retry-safe because the client generates one stable `entry_uuid`
(`useCaptureDraft.ts:101`) and re-sends it on every write; the edge upserts by it, so a
lost-response retry either no-ops or returns `stale_version` — never a duplicate. Batch must
match: a lost-response retry of the same finalize must not create a second set of N entries.

## Required change

1. **GUI** — generate one stable client `entry_uuid` per selected plot when the batch payload
   is first built, and snapshot them with `batchPayloadSnapshotRef` (the snapshot already
   exists for byte-stable retry — extend it to carry the UUIDs). Send them, e.g.
   `members: [{ plot_uuid, entry_uuid }, …]` or an `entry_uuids` array parallel to
   `plot_uuids`. `buildFinalBatchPayload` and `finalizeBatch` in `JournalCaptureFlow.tsx`.

2. **Edge `finalizeBatch`** (`lifecycle.js:1372`) — use the supplied per-plot `entry_uuid`
   instead of `crypto.randomUUID()` at line 1433. Route each member through the SAME
   idempotent create/upsert `createFinalInTransaction` already uses for single-plot: if an
   entry with that `entry_uuid` already exists as a final, the retry returns the existing
   receipt (or a safe `stale_version`), it does NOT create a duplicate and does NOT surface it
   as a `duplicate_candidates` 409. Input validation must accept and require the per-member
   `entry_uuid` (canonical UUID, unique within the batch).

3. **Duplicate-guard interaction** — this must stay correct. A *same-UUID* retry is idempotent
   (no prompt). A *genuinely new* batch (fresh UUIDs) targeting plots that already have a
   matching final still triggers the duplicate-guard for the user to ack "save separately" —
   that path is unchanged and is the legitimate "two real activities same day" case. The bug
   being fixed is only the lost-response retry where the user wrongly believes the first
   attempt failed.

4. **Atomicity preserved** — the batch stays one transaction (all-N-or-none), so there is no
   partial-persist case; the only lost-response case is full success, which the stable UUIDs
   turn into a clean no-op.

5. **Edge discipline** — mirror both profile copies byte-identical (bcm2712 + bcm2709), keep
   sync/outbox parity, update the batch edge tests (currently 99/99) to assert the retry is a
   no-op, and add a GUI regression proving a re-finalize with the same snapshot sends the same
   entry_uuids and produces no second write. Follow `osi-schema-change-control`.

## Verdict

P6 is adjudicated: **fix it**, do not accept the duplicate-guard as sufficient. Sequence it as
a Phase 4 correction; it may run alongside remaining Phase 4/5 work but must land before Slice
2 is called done, because it is a live data-integrity gap on farm records.

---

# Design decisions confirmed (product owner, 2026-07-19)

Three open decisions adjudicated in one pass. Do not re-litigate these.

## F7 — two-tier tap SLA: CONFIRMED

The product owner confirms the two-tier target was their decision: `<=9` primary activations on
the shipped `open_field` default, `<=5` only under a future approved safe-default policy. The
run's 2026-07-17 record is legitimate. Spec §257 and the pinned SLA test are unchanged. (F8 —
derive the SLA fixture from the compiled catalog rather than a hand-written copy — is still a
worthwhile hardening, but the number itself is accepted.)

## P4 — low-risk carry-forward: show AND carry in farmer_quick

Decision: `farmer_quick` gains `attr.operator`, `attr.equipment`, `attr.method` as **visible,
prefill-marked fields**, and keeps its existing `carry_forward` for the three. This satisfies
AGR-7 / P4 ("low-risk fields carry by default with visible prefill marking") for the common
quick-entry path, and it makes the carried values survive EntryForm's prune-to-visible step
(the reason they were dropped — see the Tasks 9/10/12 review).

Catalog-data change, owned by the run (same domain as P1): add the three codes to
`farmer_quick`'s section fields in `journal-catalog-core.js`, regenerate, mirror both profile
copies, keep sync/catalog-version parity, and add a regression proving the three carried values
reach the final payload for a quick entry. `full_record` is unchanged (it already shows them;
leaving its `carry_forward` empty is acceptable). Also do the P4 hardening: have `parseTemplate`
reject a `carry_forward` code that is not in the template's visible field set, so this class of
"declared but never shown" mismatch cannot ship silently again.

## F1 — product compositions: DEFERRED to the post-image round (risk accepted)

Decision: do **not** prioritize migration 0022 now. Populate composition_json (Agroscope
reference values) and add a mineral fertiliser in the post-image live-verification round.

Risk acknowledged by the product owner: composition is immutable after first use (spec §4.6),
so if any farm logs a fertilisation against these products before 0022 lands, the fix becomes a
product-version exercise with live references rather than a clean populate. **Guardrail on the
deferral:** 0022 must land before any real fertilisation entry is recorded on a deployed image
— i.e. populate during the live-verification round *before* the journal is used for a real
fertilisation, not after. Until then, product-first nutrient derivation and SoilManageR derived
rates render nothing against the real catalog; this is expected, not a defect (N1 stays as the
standing note). No hard stop for empty compositions.

## Still open — NOT decided here

Translation native-review sign-off: who approves de-CH / fr / **lg** GUI copy before farmers
see it, especially the newly-coined Luganda vocabulary on the live Uganda gateway. Needs a named
reviewer, not a menu choice. Carried forward.
