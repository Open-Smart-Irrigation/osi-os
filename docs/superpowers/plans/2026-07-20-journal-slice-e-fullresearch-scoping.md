# Plan — Journal Slice E: Full/Research per-activity field scoping + progressive disclosure

**Spec:** [2026-07-20-journal-capture-streamlining-design.md](../specs/2026-07-20-journal-capture-streamlining-design.md) (D14, R5; §4-B)
**Branch:** `design-sync/agrolink` · **Risk:** medium · **Migration:** `0027__journal_catalog_v5.sql` (catalog v5) — LOCKED in spec §8.1

Per **R5**, this is **not** GUI-only. `full_record`'s `operation` section is a flat ~20-field list today (confirmed in `journal-catalog-core.js`); `activity_requirements` governs *requiredness*, not *visibility*. So Full/Research must gain per-activity **visibility** scoping, then the visible fields are grouped into collapsible sections.

## Goal

A Full-mode fertilization shows the fertilization-relevant operation fields (product, amount families, treated area, operator/method…) — not irrigation depth, plant count, or biological-agent count — organised into "Key" (open) and "More detail" (collapsed) groups. Research adds identity/protocol/custom-value sections, same scoping. No agronomically important field silently hidden or defaulted.

## Tasks

### Task E1 — Per-activity visibility for `full_record`
- **Files:** `scripts/journal-catalog-core.js` (`full_record` gains an activity→visible-fields map, analogous to BC's `quick_fields`, e.g. `operation_fields_by_activity`), generator emit + delta registration. Keep `full_record@1` byte-identical; ship **`full_record@5`** — version = the next GLOBAL catalog integer (v5, migration `0027`), **not** `@2` (v2 is frozen `farmer_quick@2`/`0022`; a `@2` row would collide and the generator will refuse). See spec §8.1.
- Derive the per-activity visible set from the existing `activity_requirements`/`conditional_groups` plus the operation fields that make sense for each activity (review the mapping as an agronomist during Fable review). Fields not in the activity's set are not rendered.
- **Tests:** generator asserts each activity resolves a non-empty visible set ⊆ the operation section; `full_record@1` bytes unchanged.

### Task E2 — Resolve scoping in the model
- **Files:** `web/react-gui/src/journal/catalogModel.ts` + `templateEngine` + tests.
- `full_record@2` (and `research_observation` where it reuses operation fields) resolves visible fields per activity. Preserve the P4 visibility guard and required/optional derivation.
- **Tests:** Full fertilization visible set excludes `attr.irrigation_depth`, `attr.amount_count_area`, `attr.amount_biological_count_area`; Full irrigation excludes product-mass fields; requiredness preserved.

### Task E3 — Progressive disclosure in the form
- **Files:** `web/react-gui/src/components/journal/capture/EntryForm.tsx` (+ a `CollapsibleSection` if none exists), i18n keys (7 locales).
- Group visible fields into "Key values" (open) and "More detail" (collapsed `<details>`-style, keyboard-accessible, ARIA). Research identity/protocol/custom-value sections rendered as their own groups. Required fields always visible (never hidden inside a collapsed group while required and empty).
- **Tests:** required fields render outside/above collapsed groups; expand/collapse a11y (role, aria-expanded, keyboard); nothing required is hidden.

## Verification

- Catalog `--check` OK, both-profile parity; `npm run test:unit` + generator tests green; `npm run build` clean.
- **Live (kaba100), pref=Full then Research:**
  1. Fertilization (Full) → product/amount/area/operator visible; no irrigation/plant-count/biological fields; extras under "More detail".
  2. Irrigation (Full) → irrigation amount + method; no product-mass fields.
  3. Research on `agroscope_open_field` → identity/protocol + scoped operation fields, still complete for a defensible record; carbon/nitrogen fields present where the activity warrants.
  4. Historical Full entries still resolve (`full_record@1` intact).

## Out of scope

Quick scoping (BC). Crop-cycle (D). Agronomy adds (F).
