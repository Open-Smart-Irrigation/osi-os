# Plan — Detailed activity vocabulary for the farmer path (catalog v9)

**Date:** 2026-07-22
**Branch:** design-sync/agrolink (worktree /home/phil/Repos/osi-os-agrolink)
**Base:** 677eb137 · **Target:** catalog **v9** / migration **0031__journal_catalog_v9.sql**

## Problem (maintainer-reported, Fable-confirmed)
The Agroscope SoilManageR template's value is a **fixed 3-level controlled vocabulary** — 7 categories → **25 operations** → **82 devices** (units bound per device). OSI's farmer path exposes only the **16 category-level activities** and offers **free-text** `attr.equipment` / `attr.method` / `attr.machine` where the controlled terms belong. Free text destroys uniformity — and in practice is simply skipped (kaba100: 31 entries, **zero** equipment/method/machine values ever recorded), so today the result is *no* detail rather than inconsistent detail.

The full vocabulary already ships in every DB (`attr.agroscope.operation` = 25 choices, `attr.agroscope.device` = 82, with activity→operation→device→unit `option_dependencies` built in `generate-journal-catalog.js:465-560`). It is reachable **only** via layout `agroscope_open_field`, gated `supported_templates: ['research_observation']` (`generate-journal-catalog.js:585`). The GUI is already generic: `deriveActivityLeaves` (`catalogModel.ts:824-859`) expands **any** layout's `option_dependencies` into searchable picker leaves.

## Maintainer decisions (confirmed)
1. **Picker depth = operation.** Search lands on the detailed operation (e.g. "Seedbed preparation"); the category tap never happens because the leaf carries the activity. Device is chosen separately on the form. Search space stays a scannable 25 operations (not ~137 activity×operation×device leaves).
2. **Device required where the list genuinely covers it** — `tillage_soil_work`, `seeding`, `plant_protection_application`. Optional for `fertilization`, `harvest`, `irrigation`, `general_observation`.
3. **Retire free-text** `attr.equipment` / `attr.method` / `attr.machine` from farmer templates in v9.
4. **Agroscope vocabulary now; OSI-authored terms next.** The 9 activities with no Agroscope coverage keep today's behaviour. A follow-up slice authors `osi.operation.*` / `osi.device.*` for manual/smallholder tools, richer irrigation, and horticulture.

## Coverage (verified)
| Activity | Agroscope category | Operations | Device policy |
|---|---|---|---|
| tillage_soil_work | tillage | 3 (primary_tillage, seedbed_preparation, stubble_cultivation) | **required** |
| seeding | sowing | 2 (sowing_main_crop, sowing_cover_crop) | **required** |
| plant_protection_application | crop_protection | 9 (fungicide, insecticide, weed_herbicide, total_herbicide, weed_mechanical, weed_other, biocontrol, growth_regulator, pest_control) | **required** |
| fertilization | fertilizer_application | 3 (organic, mineral, other) | optional |
| harvest | harvest | 5 (incl. `cleaning_cut`, which has exactly **1** device — `mower`, injected by `repairedDevices`, `generate-journal-catalog.js:181-190`) | optional |
| irrigation | irrigation | 1 (watering; only sprinkler/trickle) | optional |
| general_observation | other | 2 (sampling, note) | optional |
| *(other 9 activities)* | — | none | unchanged |

**Dead ends are structurally impossible** (Fable-verified): `parseDependencies` rejects an empty choice list (`catalogModel.ts:410`), so a 0-device operation cannot ship at all — hence the `mower` repair for `cleaning_cut`. Every operation therefore has ≥1 device, and the required-device policy cannot strand a farmer.

## Global constraints (binding)
1. **Frozen versions immutable.** v1–v8 and migrations `0019`–`0030` are never edited. All new content = **v9 / `0031__journal_catalog_v9.sql`**; add `{version: 9, name: '0031__journal_catalog_v9.sql'}` to `CATALOG_MIGRATIONS`. A template/layout row's global `since` = its `version` field, so both new rows are tagged `version: 9`.
2. **Byte-parity gate:** `node scripts/generate-journal-catalog.js` then `--check` must pass. Regenerate all 7 bundled DBs; run the FULL gate set **including `node scripts/test-journal-schema.js`** (the row-content gate).
3. **The research layout's behaviour must not change.** `agroscope_open_field` keeps expanding to device depth in the picker; the new depth knob is opt-in.
4. **Edge `osi-journal` `.js` modules stay byte-identical** across bcm2712/bcm2709 (`diff -rq`).
5. **Labels stay English-only** (`labels_json {en}`, `humanize(code)`), consistent with every existing catalog term incl. crops. Full catalog i18n (25 operations + 82 devices ≈ 107 farmer-facing terms × 7 locales, with `lg` the Uganda ship gate) is a **known separate follow-up** — call it out in the PR body; do NOT introduce a vocabulary-only multi-locale path here.

## Task 1 — Generator: share the dependency build
`scripts/generate-journal-catalog.js` currently builds the activity→operation→device `option_dependencies` inside `buildAgroscope` and attaches them to `agroscope_open_field` only (`:465-560`, `:573-600`). Refactor so the same dependency set can be attached to a second layout without duplicating the build. Keep the emitted agroscope layout **byte-identical** — `--check` will catch drift.

**Byte-order hazards (Fable):** `definition_json` is `JSON.stringify` in **insertion order** (`:736`). The shared build must preserve (a) key insertion order, (b) the `categoryDeps → operationDeps → unitDeps` array order (`:612-616`), and (c) the `operationSort`/`deviceSort` counter sequence (`:470-471`). `writeGeneratedArtifacts` refuses to rewrite frozen `0019` if bytes shift (`:966`).

**Injection seam (Fable — under-specified before):** `open_field@9`'s row lives in `journal-catalog-core.js`, but its `option_dependencies` are derived from the source JSON inside `buildAgroscope` (generator-side). Do the attach **generator-side, after `buildAgroscope`, purely** — `compileCatalog` may run multiple times in one process (tests), so never mutate module-level core state. Note `validateCore` runs on `coreDef` before the source is consulted.

## Task 2 — `open_field@9` (layout)
New `open_field` row `version: 9` (copy of `@8`) that additionally declares:
- `option_dependencies`: the shared activity→operation and operation→device restrictions, **scoped to the 7 covered activities only** (the other 9 declare none, so their picker leaves stay bare activities exactly as today).
- **HARD RULE (Fable P2) — do NOT copy the device→unit dependencies.** `resolveDependencies` seeds a target entry for every dependency unconditionally (`catalogModel.ts:708-713`) and `allowedUnits` then filters to that (empty) set (`:782-785`). If the unit deps ride along, **every bound amount attribute gets an empty unit dropdown whenever no device is selected**, breaking amount entry on all optional-device activities (and `EntryForm.tsx:283-285` would reject the unit). It only works on the research layout because its leaves always carry a device. Attach **only** the activity→operation and operation→device groups.
- **Picker depth knob:** declare that the picker expands only to `attr.agroscope.operation` (e.g. `picker_targets: ['attr.agroscope.operation']`). Absent ⇒ current deepest-expansion behaviour (so `agroscope_open_field`, a frozen `version: 1` row, is unaffected). Parse spec (follow file convention): `stringArray`, reject-as-`null` on malformed, and validate each entry is actually a choice-target attribute of that layout's dependencies (mirror `validDependencyReferences` rigor). Safe on old readers — GUI `parseLayout` (`catalogModel.ts:567-617`) and edge `semanticDefinitionErrors` (`definition.js:219-300`) both ignore unknown keys.
- `minimum_fields` / `static_context_fields` unchanged from `@8` (subset invariant holds).

## Task 3 — `full_record@9` (template)
New `full_record` row `version: 9` (copy of `@8`):
- **MUST FIRST (Fable P2):** add `attr.agroscope.operation` + `attr.agroscope.device` to the **`operation` section's own `fields` superset**. Both the generator (`validateOperationFieldsByActivity`, `generate-journal-catalog.js:409-424`) and the GUI twin (`parseOperationFieldsByActivity`, `catalogModel.ts:218-235`) enforce map ⊆ section `fields` — without this, **generation fails**.
- **Add** `attr.agroscope.operation` and `attr.agroscope.device` to `operation_fields_by_activity` for the **7 covered activities**.
- **Remove** `attr.equipment` and `attr.method` from **every** activity's `operation_fields_by_activity` **and from the section superset** (leaving orphaned superset entries is legal but invites drift). Post-removal every activity still has a non-empty list (worst case `pruning`/`equipment_maintenance` keep `['attr.operator']`), so the non-empty guards don't trip. **Note:** `attr.machine` appears in **no** farmer template (only the agroscope layout's `fields`) — its "retirement" is a no-op; don't hunt for it.
- **Add to `activity_requirements[...].required` for `tillage_soil_work`, `seeding`, `plant_protection_application` only:** `attr.agroscope.device` **and `attr.agroscope.operation`** (Fable P2c). Requiring the operation is a no-op on the happy path (the picker always sets it) but closes a stale-draft dead end: a bare-activity draft resumed under `@9` would otherwise show device as visible+required while `allowedChoices(device)` is empty (no operation selected) — an unsatisfiable field. Requiring the operation renders it as a fixable form field instead, and hardens the edge contract.
- Everything else copied verbatim from `@8`.

## Task 4 — `farmer_quick@9` (Quick path) — REVISED per Fable P1
**The operation persists on Quick with no bump** (verified): `payloadValues` pushes `activityDependencyInputs(leaf)` unconditionally for every template (`JournalCaptureFlow.tsx:1164-1171`) and `sanitizeValues` retains leaf-carried codes via the `dependencyCodes` carve-out (`:706/:715`). A Quick tillage entry records the operation, and Quick's own `activity_requirements` govern it, so no device is demanded. Keep a test for this.

**BUT a bump is still required for decision 3:** `farmer_quick@6` renders free-text `attr.equipment`/`attr.method` for every activity via its `carried_forward_details` section and `carry_forward` (`journal-catalog-core.js:712-725`; sections are processed for quick templates too, `templateEngine.ts:135-154`). Leaving it would keep free text alive on the Quick form, contradicting decision 3 and failing this plan's own Task 6 / deploy checks. So: add **`farmer_quick@9`** — copy of `@6` with `attr.equipment`/`attr.method` dropped from `carried_forward_details` **and** `carry_forward`; **keep `attr.operator`** (the parse carry-forward-visibility guard, `catalogModel.ts:303-304`, stays satisfied). Tag `version: 9` so it joins the same v9 delta.

## Task 5 — GUI: picker depth knob (small, generic) — TWO call sites
`deriveActivityLeaves` (`catalogModel.ts:824-859`) currently expands to the deepest choice target. Make it honour the optional layout-declared target list: expand only through the declared targets, then emit the leaf. Default (undeclared) = today's behaviour. Thread the new field through the layout-definition parse/type. Business-logic-free — **no hardcoded `attr.agroscope.*` in the GUI**.

**CRITICAL (Fable P1a) — the knob must ALSO govern `activityShortlist.ts`.** `choiceTargetCodes` (`:99-104`) returns *all* the layout's choice targets and `leafMatchesEntry` (`:126-137`) requires `entry value === leaf expected` for **every** target. With operation-depth leaves the device target's `expected` is `null`, so any entry that *records* a device (i.e. every entry for the 3 required-device activities, permanently) matches **no** leaf — "Recent on plot" / "farm recent" would be permanently empty for the highest-traffic activities. Filter `choiceTargetCodes` by the same declared picker targets (default: all ⇒ `agroscope_open_field` unchanged).

The device restriction still applies on the form regardless of picker depth: `resolveDependencies`/`allowedChoices` (`catalogModel.ts:704-767`) and `sanitizeValues` (`JournalCaptureFlow.tsx:686-732`) consume the full dependency list, and `EntryForm.tsx:269-278` rejects a device outside the operation's set.

## Task 6 — Tests (iterate to green)
- **Generator:** `--check` byte-parity; `verify-migrations`, `verify-seed-replay`, `verify-db-schema-consistency`, `verify-profile-parity`, `verify-no-stray-ddl`, **`test-journal-schema.js`**; `test-journal-catalog-generator.js` (bump pinned versions as prior slices did).
- **Edge:** `osi-journal` `index.test.js` BOTH profiles — a `full_record@9` tillage entry **without** a device fails `required`; **with** one validates; a `fertilization` entry validates without a device (optional); entries pinned to `full_record@8` keep their old rules. Expect the established count + new tests; `diff -rq` clean.
- **GUI:** `typecheck` + `test:unit` fully green. Add:
  - `deriveActivityLeaves` stops at the declared target for `open_field@9` (leaf = activity+operation; **exactly 25 operation leaves + 9 bare = 34**) and still expands to device for `agroscope_open_field` (unchanged). If you get ~137, the knob isn't honoured.
  - Picker **search** matches an operation label ("seedbed" → Seedbed preparation, a single result).
  - **Shortlist (P1a):** a tillage entry that *records a device* still matches its operation-depth leaf under `open_field@9` (guards the permanent-empty-recents regression), and `agroscope_open_field` matching is unchanged.
  - **Unit deps (P2b):** on `open_field@9`, a fertilization amount attribute's **unit dropdown is non-empty with no device selected**.
  - Device dropdown is scoped by the chosen operation; `attr.equipment`/`attr.method` no longer render on **either** farmer template (full_record@9 **and** farmer_quick@9).
  - Update fixtures asserting the old flat activity list.

## Deploy + live-verify
1. Build GUI fresh, verify the tarball's hashed chunk matches the build, deploy to kaba100 (migration 0031 → catalog_version 9; verify entries preserved + integrity ok).
2. Live (admin, Full): search **"seedbed"** → a single "Seedbed preparation" result → tap → the form shows a **device** dropdown scoped to seedbed devices, and the entry cannot be saved without one; a **fertilization** entry saves without a device; **equipment/method/machine** no longer appear; a Quick tillage entry records the operation.
3. Commit path-scoped (catalog core + generator + migration 0031 + CHECKSUMS + 7 bundled DBs + seed-blank + edge tests + GUI catalogModel/tests + this plan), push.

## Risks / watch-items
- **Picker-depth knob is the only real GUI risk.** It must not change `agroscope_open_field` behaviour (research path) — assert that explicitly in a test.
- **Leaf-count sanity:** with depth=operation the 7 covered activities contribute 25 leaves; the other 9 stay bare → ~34 leaves total. If the implementation yields ~137, the knob is not being honoured.
- **`cleaning_cut` (0 devices)** must never be required to have a device (it's in optional `harvest`, but assert no dead end).
- **Back-compat:** entries pin `template@version` + `layout@version`; the 31 kaba100 entries stay valid under their pinned versions. There is **no defensible automatic mapping** from a stored category-level activity to an operation — old entries honestly stay coarse. Do not attempt a backfill.
- **Picker shortlist — NOT cosmetic** (Fable P1a, corrected): without the knob governing `choiceTargetCodes`, recents break **permanently** for every device-carrying entry, not just until new ones accrue. Task 5 fixes it; the test is mandatory. Separately, old bare-category recents from `@8` won't match the new operation leaves — *that* part is a genuine one-time reset and is fine.
- **Stale drafts:** drafts persist their leaf and aren't revalidated against the new leaf set; Task 3's operation-requirement makes the resumed form fixable rather than dead-ended.
- **Research template on `open_field@9` never surfaces the device field** (research sections don't include core-scope attrs and the layout declares no `fields`), so device requiredness is Full-only by construction — consistent with decision 2, noted so it isn't filed as a bug.
- **Label collision to eyeball at deploy:** the picker will show both a bare **"Sampling"** activity (uncovered OSI activity) and a **"General observation → Sampling"** operation leaf. Vocabulary is settled; just confirm it doesn't read as a duplicate.
- **English-only labels** for ~107 new farmer-facing terms; `lg` translation is the Uganda gate. Follow-up, flagged in the PR body.
