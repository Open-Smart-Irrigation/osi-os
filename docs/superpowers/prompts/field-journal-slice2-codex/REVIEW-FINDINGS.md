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
