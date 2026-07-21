# Plan — Journal capture-streamlining follow-ups (W1/W2/W3)

**Date:** 2026-07-21
**Branch:** design-sync/agrolink (worktree /home/phil/Repos/osi-os-agrolink)
**Owner decisions (all confirmed by the maintainer):**
- **W1** Full-mode irrigation required fields → **relax to essentials via the requiredness-rule change** (keep amount + unit + treated-area required; make measurement-source, denominator, block/bed/row, cover type optional-but-shown). Confirmed the maintainer wants the small GUI rule change, not the narrower catalog-only subset.
- **W2** Desktop capture modal → **widen for desktop**.
- **W3** Crop vocabulary → **add the full 16-vegetable open-field set**, English-only (consistent with all existing crops).

**REVISED after Fable plan review (verdict was REVISE — two blockers):** the original plan tagged the new `open_field` layout `version: 4` (would rewrite frozen migration `0026` — the generator sets `since: layout.version`) and trimmed `minimum_fields` while keeping `static_context_fields` (violates the subset invariant, and would strip block/bed/row + cover type from the Quick plot-context feature since those fields have no other render path in Full). Both are resolved below: **no layout version bump at all** (open_field stays `@3`), and requiredness is relaxed via a `templateEngine` decouple that leaves `static_context_fields` populated. Confirmed against the edge: `minimum_fields` requiredness is **GUI-only** (the edge `index.js` validator enforces only `conditional_groups`/`activity_requirements`, never layout `minimum_fields`), so this needs **no edge change** and the byte-identical edge modules are untouched.

Follows the live UX pass on kaba100 that closed P1 (activity-label leak) and P2 (desktop pass grouping) in commit `96b36da6`. These three are the product/scope decisions that pass surfaced.

---

## Grounding (from a read-only surface map — trust but re-verify in code)

- Catalog data authored in `scripts/journal-catalog-core.js`; emitted by `scripts/generate-journal-catalog.js` (SQL migration + per-profile bundled `farming.db` + seed-blank). Single **global** version counter; current max = **v6** (migration `0028`). `CATALOG_MIGRATIONS` registry maps version→migration filename (`generate-journal-catalog.js:31-38`).
- Requiredness for a full_record irrigation entry is **100% catalog-driven** — no GUI override. It comes from:
  - `full_record` template `conditional_groups[code='irrigation_details']` (byte-identical v1→v6): `required: ['attr.irrigation_amount_kind','attr.measurement_source','attr.denominator']`, `required_any: [['attr.irrigation_depth','attr.irrigation_volume_area','attr.per_plant_volume']]`, `optional: ['attr.actuation_expectation_id']`.
  - `open_field` layout `minimum_fields: ['attr.block_bed_row','attr.treated_area','attr.cover_type','attr.denominator']` (force-required for full_record; Quick skips minimum_fields).
- GUI resolves/enforces requiredness in `web/react-gui/src/journal/templateEngine.ts` (`deriveFieldStates` → `requiredFieldsSatisfied`) and `JournalCaptureFlow.tsx` `next()` gate; `EntryForm.tsx` reads `state.required` from the same derived states. **No GUI code change for W1** — it reflects new catalog data automatically once regenerated.
- `agroscope_open_field` layout is unaffected by W1: it only `supported_templates: ['research_observation']`, which has no conditional_groups/requirements — Full-mode on that layout forces research_observation and requires nothing today.
- Crop choices feed `attr.crop`; 26 Agroscope-aligned crops (`since=1`) + 5 v4 farmer additions (`since_version: 4`, `journal-catalog-core.js:389-393`). Row shape via `choice(code, parent_code, label, sort_order)` + optional `since_version`/`metadata`. Labels are **English-only** for every crop (generator hardcodes `labels_json: {en: label}`); GUI `catalogLabel()` falls back `[locale] ?? en ?? code`. `public/locales/*/journal.json` has **no** `crop.*` namespace — so vegetables need **no** locale-file edits.
- Desktop capture modal width lives at `web/react-gui/src/components/journal/desktop/JournalWorkspace.tsx:186` — `CaptureModal` inner panel className `... w-full max-w-lg ...` (stock Tailwind `max-w-lg` = 512px, no responsive variants). The capture form's own `sm:grid-cols-2/3` sections (`ActivityPicker`, `PlotForm`, `ConfirmStrip`, etc.) are viewport-gated at 640px and already active on a desktop viewport, but render cramped inside 512px. `lg:` (1024px) is the workspace's own breakpoint convention (`JournalWorkspace.tsx:330`).

---

## Global constraints (binding — copy verbatim into reviewer prompts)

1. **Never edit a frozen catalog version or its migration.** v1–v6 and migrations `0019`–`0028` are immutable. All new content is **catalog v7 / migration `0029__journal_catalog_v7.sql`**, appended to `CATALOG_MIGRATIONS`.
2. **Byte-parity gate is mandatory:** after editing `journal-catalog-core.js`, run `node scripts/generate-journal-catalog.js` to regenerate, then `node scripts/generate-journal-catalog.js --check` must pass (byte-identical). Never hand-edit generated SQL/DBs.
3. **Edge Node-RED `osi-journal` JS modules stay byte-identical across `bcm2712`/`bcm2709`** — W1/W2/W3 do **not** touch those `.js` modules. Verify with `diff -rq` on the two `osi-journal/` dirs (excluding the per-profile bundled `farming.db`, which the generator owns). The bundled seed DBs are regenerated by the generator for **both** profiles.
4. **Existing journal data must survive migration `0029`.** It is an additive catalog-data migration (INSERT new v7 rows + advance `journal_catalog_state` version/hash), same class as `0028`. No table drops, no destructive changes. On a live DB with entries, `migrate-cli.js` applies it forward without touching `journal_entries`.
5. **Crop labels English-only** (`labels_json: {en: …}`) — do **not** introduce a vegetables-only multi-locale path; full crop-vocab i18n is a separate follow-up. No `public/locales/*/journal.json` edits for crops.
6. **GUI code changes are limited to two, small and independent:** (i) W1's `templateEngine` requiredness-rule decouple (Task 1.1b), and (ii) W2's modal-width class (Slice 2). W3 requires **zero** `.tsx`/`.ts` edits beyond regenerated catalog fixtures. Do **not** touch the edge `osi-journal` JS modules (W1 is GUI-only; the edge does not enforce `minimum_fields`).
7. **`static_context_fields` stays populated.** The Quick plot-context feature (`PlotContextFields`, `plotContextDisplay`, `plotContextInputs`) reads `static_context_fields`; never empty it to change Full-mode requiredness. The decouple in Task 1.1b changes only how the *non-quick* branch treats those fields, leaving Quick untouched.
7. **Verification bar:** edge `index.test.js` per profile green (the established 157/157); GUI `npm run test:unit` fully green (vitest + tsx mirror); generator `--check` parity + any replay/consistency scripts green. Then deploy to kaba100 and live-verify.

---

## Slice 1 — Catalog v7 (W1 relax irrigation requiredness + W3 vegetables)

W1's catalog part (full_record@7) and W3 (16 crop choices) both regenerate the catalog, so they land in **one** version bump and **one** migration `0029`. Do the catalog data edits (Task 1.1a + 1.2), then regenerate once (Task 1.3). W1 also has a GUI-only `templateEngine` change (Task 1.1b) that needs no regeneration.

### Task 1.1 — W1: relax Full-mode irrigation requiredness (catalog `full_record@7` + GUI `templateEngine` decouple)

Part (a) is in `scripts/journal-catalog-core.js`; part (b) is in `web/react-gui/src/journal/templateEngine.ts`.

**(a) New `full_record` template row `version: 7`** — copy the current `version: 6` row verbatim, change `version` to `7` (and its `since`/global tag to the next global integer per the generator's mechanism — study how v6 was tagged and mirror it exactly), and change **only** the `irrigation_details` conditional group to:
```js
{
  code: 'irrigation_details',
  activity_codes: ['irrigation', 'fertigation'],
  required: ['attr.irrigation_amount_kind'],
  required_any: [['attr.irrigation_depth', 'attr.irrigation_volume_area', 'attr.per_plant_volume']],
  optional: ['attr.measurement_source', 'attr.denominator', 'attr.actuation_expectation_id'],
},
```
Rationale: `required_any` (one of depth/volume/per-plant) = the amount; `irrigation_amount_kind` = the unit/kind. Both stay required. `measurement_source` and `denominator` move to `optional` (still shown, not gated). Everything else in the row is unchanged from v6 (operation_fields_by_activity, other conditional groups, scoped_by_activity, etc.).

**(b) `templateEngine` requiredness-rule decouple (GUI, no layout change).** Do **not** create a new `open_field` layout version — leave `open_field@3` (and its `minimum_fields`/`static_context_fields`) exactly as-is. Instead, change how the non-quick branch of `deriveFieldStates` (`web/react-gui/src/journal/templateEngine.ts`, ~lines 156–186) force-requires layout `minimum_fields`:

- **Current:** for a template without `quick_fields`, every field in `layout.minimum_fields` is force-added required (`addField(field, true)`, ~line 184).
- **New rule:** force-require only `minimum_fields \ static_context_fields`; add the fields that ARE in `static_context_fields` as **visible-but-optional** (`addField(field, false)`). Concretely: `addField(field, !staticContextFields.includes(field))`, reading `staticContextFields` from `layout.definition.static_context_fields` (default `[]`). Confirm the exact accessor/variable names in the current code before editing.

Effect for open_field full_record: `minimum_fields = [block_bed_row, treated_area, cover_type, denominator]`, `static_context_fields = [block_bed_row, cover_type, denominator]` → `treated_area` stays **required** (not in static context); `block_bed_row`/`cover_type`/`denominator` become **visible-optional**. Combined with Task 1.1(a) (which drops `measurement_source`/`denominator` from the irrigation conditional group), the net Full-mode irrigation gate is: **required** = amount_kind + one-of(depth/volume/per-plant) + treated_area; **optional-but-shown** = measurement_source, denominator, block_bed_row, cover_type. Exactly the maintainer's "relax to essentials."

- This is a **uniform, data-driven** rule: it applies to every non-quick template/layout using its own `static_context_fields`, which resolves (rather than reintroduces) the greenhouse/lysimeter inconsistency — each layout's own static context becomes optional. Quick is unaffected (it already skips `minimum_fields`). The edge is unaffected (it never enforced `minimum_fields`).
- **Editing an existing frozen-version entry** (e.g. one pinned to `full_record@6`) now sees those fields as optional too — a pure relaxation, never a new block. Acceptable and consistent.

**`treated_area` stays required (Fable I1 — endorsed).** It is deliberately excluded from `static_context_fields` (core comment ~lines 1116–1119), so the decouple keeps it required; it is the field that scopes total-water accounting and was not on the maintainer's drop-list. Keep it required.

### Task 1.2 — W3: add 16 open-field vegetables

In `scripts/journal-catalog-core.js`, mirror the v4 crop-additions pattern (`journal-catalog-core.js:389-393`) with `since_version: 7`. Add these 16 rows (English-only labels; slugs shown):
```js
{ ...choice('choice.crop.carrot',        'attr.crop', 'Carrot',              <s>), since_version: 7 },
{ ...choice('choice.crop.onion',         'attr.crop', 'Onion',               <s>), since_version: 7 },
{ ...choice('choice.crop.leek',          'attr.crop', 'Leek',                <s>), since_version: 7 },
{ ...choice('choice.crop.cabbage',       'attr.crop', 'Cabbage',             <s>), since_version: 7 },
{ ...choice('choice.crop.cauliflower',   'attr.crop', 'Cauliflower',         <s>), since_version: 7 },
{ ...choice('choice.crop.broccoli',      'attr.crop', 'Broccoli',            <s>), since_version: 7 },
{ ...choice('choice.crop.lettuce',       'attr.crop', 'Lettuce',             <s>), since_version: 7 },
{ ...choice('choice.crop.spinach',       'attr.crop', 'Spinach',             <s>), since_version: 7 },
{ ...choice('choice.crop.celeriac',      'attr.crop', 'Celeriac',            <s>), since_version: 7 },
{ ...choice('choice.crop.fennel',        'attr.crop', 'Fennel',              <s>), since_version: 7 },
{ ...choice('choice.crop.table_beet',    'attr.crop', 'Table beet',          <s>), since_version: 7 },
{ ...choice('choice.crop.courgette',     'attr.crop', 'Courgette / zucchini',<s>), since_version: 7 },
{ ...choice('choice.crop.pumpkin_squash','attr.crop', 'Pumpkin / squash',    <s>), since_version: 7 },
{ ...choice('choice.crop.sweetcorn',     'attr.crop', 'Sweetcorn',           <s>), since_version: 7 },
{ ...choice('choice.crop.garden_pea',    'attr.crop', 'Garden pea',          <s>), since_version: 7 },
{ ...choice('choice.crop.green_bean',    'attr.crop', 'Green bean',          <s>), since_version: 7 },
```
**Sort order:** choose a contiguous block that groups vegetables with the crops. Suggested `<s>` = 3500,3504,…3560 (step 4) so vegetables sort **after** the Agroscope arable crops (~3000–3025) and **before** the generic v4 buckets (permanent_grassland/field_vegetable/fallow/other at 4000–4040). Do not renumber any frozen row. Confirm the crop step and read-only crop banner (`InheritedCropBanner`, `canonicalCropValue`) pick these up with no GUI change (they filter `parent_code==='attr.crop' && active===1`).

Codes distinct from existing crops: `garden_pea` ≠ the Agroscope `pea, spring/winter` (field pea); `table_beet` ≠ `beet, sugar/fodder`; `sweetcorn` ≠ `maize, grain/silage` — intentional (different crops agronomically). Reviewer with agronomy lens: confirm the set + labels are sensible for Central-European open-field production.

### Task 1.3 — Regenerate + register migration

1. Add `{ version: 7, name: '0029__journal_catalog_v7.sql' }` to `CATALOG_MIGRATIONS` in `generate-journal-catalog.js`.
2. `node scripts/generate-journal-catalog.js` to emit `database/migrations/ordered/0029__journal_catalog_v7.sql`, update `CHECKSUMS.json`, regenerate the per-profile bundled `farming.db` seeds and `seed-blank.sql`.
3. `node scripts/generate-journal-catalog.js --check` → must pass byte-parity.
4. Regenerate any GUI-embedded catalog fixture/snapshot the same way the v6 slice did (find how the GUI test suite obtains the catalog; if it reads a generated file, regenerate it).
5. Confirm migration `0029` is additive only (diff it: INSERTs of v7 rows + `journal_catalog_state` version/hash bump; no DROP/DELETE of existing rows).

### Task 1.4 — Tests

- Edge: run the `osi-journal` `index.test.js` for **both** profiles (bcm2712 + bcm2709) — expect the established pass count. Add/confirm a test that catalog v7 loads and that a full_record@7 irrigation entry validates (edge `validate`) as savable **without** measurement_source/denominator (they left the conditional group) given amount + amount_kind. (The edge never required block_bed_row/cover_type/treated_area via minimum_fields, so no edge change there — a test documenting that the edge accepts the entry is enough.)
- Generator: run existing catalog replay/consistency/parity scripts.
- GUI: `npm run typecheck` + `npm run test:unit` (vitest + tsx).
  - Add a `templateEngine` test: `deriveFieldStates` for **full_record@7 + open_field@3** irrigation marks measurement_source/denominator/block_bed_row/cover_type **visible but not required**, and amount_kind/amount(required_any)/treated_area required. Also assert a Quick (`farmer_quick`) capture is unchanged (still skips minimum_fields → block_bed_row not force-required there either) and that `PlotContextFields`/`plotContextInputs` still see `static_context_fields` (the decouple must not empty it).
  - Add a crop test: the `attr.crop` choice list exposes the 16 new vegetables (active, correct labels/sort).
  - **Fable I2 — fixtures that WILL need updating** (find + adjust expectations, do not just delete): `web/react-gui/src/components/journal/__tests__/JournalCaptureFlow.test.tsx` (~339–340, 365, 4472 — models `minimum_fields`/`static_context_fields` overlap and asserts block_bed_row behavior), `JournalPage.test.tsx` (~250–253 — registers block_bed_row/cover_type), `PlotForm.test.tsx` (~838–901 — context_json round-trip). Any assertion that block_bed_row/cover_type is **required** in a non-quick flow flips to **optional**; Quick prefill/round-trip assertions must stay green unchanged (if one breaks, the decouple touched Quick — that's a bug, fix the code not the test).

---

## Slice 2 — W2: widen the desktop capture modal

### Task 2.1

In `web/react-gui/src/components/journal/desktop/JournalWorkspace.tsx:186`, change the `CaptureModal` inner-panel width from `max-w-lg` (512px) to a desktop-comfortable width that clears the 640px `sm:` threshold so the form's existing `sm:grid-cols-2/3` sections lay out in columns. Target **`max-w-3xl`** (768px) to match the mobile full-page equivalent (`JournalPage.tsx` `<main className="mx-auto max-w-3xl …">`). If any capture step looks too sparse at 768px, `max-w-2xl` (672px) is the fallback — implementer picks and notes the choice with a screenshot rationale.

Keep the modal responsive/scroll behavior intact (`my-8 max-h-[calc(100vh-4rem)] overflow-y-auto`). No new breakpoints strictly required (fixed max-width is fine; the panel is already `w-full` up to the cap and the page only renders this modal on the UA-desktop path). Do not alter the mobile full-page path.

### Task 2.2 — Tests + visual

- `npm run typecheck` + `npm run test:unit` green (no assertion should hardcode `max-w-lg`; update if one does).
- Capture desktop screenshots (1440×900) of a multi-field step (e.g. an activity with a `sm:grid-cols-2` section) before/after to confirm columns now render and nothing overflows.

---

## Deploy + live verification (after both slices green)

1. Build GUI, bundle **fresh** (`tar` from the current `build/` — verify the tarball's hashed main chunk matches the fresh build before deploying; a stale tarball silently deploys old GUI), deploy to kaba100 via the reverse-tunnel `deploy.sh` flow. Migration `0029` applies on the live DB (pre-migration backup + integrity check are automatic).
2. Confirm on kaba100: `journal_catalog_state` at v7; existing journal entries preserved (count unchanged, integrity ok); edge catalog loads.
3. Live GUI (admin) checks:
   - **W1:** capture an **Irrigation** entry in **Full** mode on an open_field plot; confirm it saves with only amount + amount kind + treated area, leaving measurement source / denominator / block-bed-row / cover type blank (previously blocked).
   - **W3:** the crop step lists the 16 vegetables; selecting one (e.g. Carrot) seeds/records correctly and the read-only crop banner shows the label.
   - **W2:** the desktop capture modal is visibly wider and multi-field sections render in columns.
4. Commit path-scoped (catalog core + generator + migration `0029` + CHECKSUMS + regenerated bundled DBs/seed + edge tests + W2 GUI + GUI tests; **exclude** build artifacts and the pre-existing dirty feed assets/common/settings), push to `design-sync/agrolink`.

---

## Risks / watch-items

- **Version mechanics (Fable B1):** the generator sets a template/layout row's global `since` = its `version` field (`generate-journal-catalog.js` ~lines 727/736). So `full_record` MUST be tagged `version: 7` (→ global v7). There is **no** layout row this slice — do not add one (a `version: 4` layout would land in the frozen v4 delta and abort generation). Choice rows use `since_version: 7`. Confirm `compileCatalog`'s "distinct versions contiguous from 1, exactly one `CATALOG_MIGRATIONS` entry per version" invariant still holds with v7 added.
- **`static_context_fields` subset invariant (Fable B2):** never trim `minimum_fields` without also trimming `static_context_fields` (validator asserts subset) — this slice trims **neither**; requiredness is relaxed in `templateEngine`, so the invariant is untouched. Do not "fix" a generator error by emptying `static_context_fields`.
- **Decouple must not touch Quick (Fable B3):** the `templateEngine` change lives in the non-quick branch only. Verify the Quick plot-context tests stay green unchanged; if one breaks, fix the code, not the test.
- **Live migration on kaba100:** kaba100 already ran through 0028 (catalog v6, 26 entries). 0029 must apply cleanly forward; take the automatic pre-migration backup seriously and verify entry count post-migration.
- **Migration `0029` = full_record@7 + 16 crop choices only** (no layout row). Confirm the generated delta contains exactly those and the `journal_catalog_state` v6→v7 stamp — nothing touching existing rows.
