# Plan — Journal Slice BC: Activity-scoped Quick + reading rescoping + plot-static context

**Spec:** [2026-07-20-journal-capture-streamlining-design.md](../specs/2026-07-20-journal-capture-streamlining-design.md) (D2, D4, D3, R1, R6; field resolution §4)
**Branch:** `design-sync/agrolink` · **Risk:** medium-high · **Migrations:** `0023__journal_catalog_v3.sql` (catalog v3) + `0024__journal_plot_context.sql`

Merged B+C per **R1**: activity-scoping alone (B) leaves the layout-forced Required fields on every entry; only the plot-context move (C) removes them. Ship together so the first kaba100 re-test shows the wall genuinely gone.

> Follow **osi-schema-change-control** for both migrations (risk class, checksums, `journal_catalog_state` bump, both-profile byte-parity). Regenerate + verify with `node scripts/generate-journal-catalog.js` then `--check`.

## Goal

The capture form for a Quick entry shows **only the fields that pertain to the chosen activity**, with plot-static context rendered read-only (carried from plot setup, snapshotted onto the entry). Per-measurement readings (lysimeter water balance, greenhouse EC/pH) stop being universal `minimum_fields` and appear only on the measurement activity.

## Field-resolution target (§4)

Effective per-entry fields = **A (activity Quick set) ∪ C (plot-static context, read-only)**; measurement readings live in the activity set of the measurement/sampling activity only (see R9 `lysimeter_reading` in Slice-D/agronomy note — for BC, route them onto `sampling` unless D lands first).

## Part 1 — Catalog v3 (migration 0023)

### Task BC1 — Author `farmer_quick@3` with per-activity `quick_fields`
- **Files:** `scripts/journal-catalog-core.js` (add `farmer_quick` v3; keep v1/v2 byte-identical), `scripts/generate-journal-catalog.js` (register `{ version: 3, name: '0023__journal_catalog_v3.sql' }` in the MIGRATIONS registry; extend template emit to carry a `quick_fields` map if not already in `definition_json`).
- `farmer_quick@3.definition` gains `quick_fields: { <activity_code>: [field codes] }` covering all 16 activities. Baseline sets (refine during review):
  - `irrigation` → `[<one irrigation amount, R6-resolved>, note]`
  - `fertilization`/`fertigation` → `[attr.product_uuid|attr.product, one amount family (mass/volume/nutrient), note]`
  - `plant_protection_application` → `[product, amount, attr.target, attr.waiting_period_days, note]`
  - `seeding`/`planting_transplanting` → `[attr.crop, attr.variety, seed/plant rate, note]` (crop/variety land fully in Slice D; in BC they may be plain fields)
  - `harvest` → `[attr.harvest_yield_area, note]`
  - `tillage_soil_work` → `[attr.amount_operation_depth, note]`
  - `mowing`/`pruning`/`crop_care`/`weed_control_nonchemical`/`equipment_maintenance` → `[note]` (+ operator/equipment carry-forward)
  - `sampling` → measurement readings for the plot's layout (lysimeter water balance / greenhouse EC-pH) + `note`
  - `general_observation`/`pest_disease_observation` → `[attr.observation_text|note]`
- `what_where_when` (activity/plot/date) + carried_forward_details (operator/equipment/method) unchanged.
- **Tests:** `scripts/test-journal-catalog-generator.js` + a new assertion that every activity has a `quick_fields` entry and every referenced field code exists in `attributes`/vocab; `farmer_quick@1/@2` bytes unchanged (`--check`).

### Task BC2 — Resolve `quick_fields` in the model
- **Files:** `web/react-gui/src/journal/templateEngine.ts` (`deriveFieldStates` — **this is the real resolution axis**: today it iterates `template.sections[].fields` unconditionally and force-adds `layout.minimum_fields` at ~L139 regardless of activity, so activity-conditioned visibility is a genuine new axis, not a small tweak — size accordingly), `web/react-gui/src/journal/catalogModel.ts` (`parseTemplate`/`parseSections`/`visibleFieldCodes`), + tests (`__tests__/catalogModel.test.ts`, `templateEngine` tests).
- For `farmer_quick@3`, field visibility = `quick_fields[activity_code]` (fall back to a small default set for activities without a mapping). Preserve the P4 visibility guard (carry-forward fields must be in a visible section). Full/Research resolution unchanged in BC (their scoping is Slice E).
- **Tests:** irrigation Quick shows only irrigation amount + note (NOT product mass/volume); fertilization Quick shows product + amount (NOT irrigation depth); unknown activity falls back safely; **regression: `full_record`/`research_observation` resolution is unaffected by the `deriveFieldStates` activity-conditioning change** (assert their field sets unchanged for a sample activity).

### Task BC3 — Rescope reading fields out of layout `minimum_fields`
- **Files:** `scripts/journal-catalog-core.js` layouts.
- Split each layout's `minimum_fields` into: **static context** (→ plot settings, Part 2) and **measurement readings** (→ `sampling` quick set, BC1). `lysimeter.minimum_fields` (12) → static: `[experimental_unit, replicate, treatment, surface_area]`; readings: `[interval_minutes, water_input, rain_input, drainage_volume, mass_start, mass_end, tare_mass, mass_method]`. `greenhouse` → static: `[structure_compartment, root_zone_system, plant_area]`; readings/conditional: `[wetted_area, drainage_volume, recirculation, ec, ph]`. `open_field` → static: `[block_bed_row, cover_type, denominator]`; `treated_area` is activity-variable → moves into activity Quick sets where relevant (fertilization/plant-protection), not plot-static.
- **Bump affected layout `version` to 3** (the next GLOBAL catalog version — see spec §8.1; the generator uses one shared counter, NOT a per-code one — a `version: 2` layout would collide with the frozen `0022`/v2 delta and the generator will refuse). The layout@3 rows land in the **same `0023` v3 delta** as `farmer_quick@3`. v1 layout bytes stay untouched.
- **Tests:** generator asserts no reading field remains in any layout `minimum_fields`; `0019`/`0022` bytes unchanged (`--check`); layout v1 rows unchanged.

## Part 2 — Plot-static context (migration 0024)

### Task BC4 — `journal_plot_settings.context_json`
- **Files:** `database/migrations/ordered/0024__journal_plot_context.sql` (additive: `ALTER TABLE journal_plot_settings ADD COLUMN context_json TEXT`), CHECKSUMS update per osi-schema-change-control.
- **Tests:** migration applies on a v0018+ DB; existing rows get NULL context; runner dry-run green.

### Task BC5 — Plot create/edit form gains static-context fields + bulk-per-station
- **Files:** the plot form/settings component under `web/react-gui/src/components/journal/where/` (PlotPicker/PlotForm) + edge `osi-journal/api.js` write path for `journal_plot_settings`.
- Render the layout's static-context fields (from BC3) on plot create/edit, persisted to `context_json`. Add "apply to all plots in this station" (writes the same context to every plot sharing `station_code`). Editable later.
- Surface each plot's `attr.replicate`/`attr.treatment` at group creation (R9/F-UX-5) — visibility only.
- **Tests:** create plot with context; edit persists; bulk-apply writes all station plots; loading/empty/error states.

### Task BC6 — Capture flow: drop static/reading fields, render context read-only, snapshot on save
- **Files:** `web/react-gui/src/components/journal/capture/{JournalCaptureFlow,EntryForm,ConfirmStrip}.tsx` + edge `osi-journal/api.js` entry-write.
- Per-entry form no longer renders plot-static context as inputs; shows them **read-only** (from `context_json`) and **snapshots** them into `journal_entry_values` on save (record integrity preserved). Reading fields only render for `sampling`. R6: irrigation amount-kind (mm vs m³/ha) chosen from the plot's irrigation-method context, so the farmer sees one field.
- **Tests:** open_field fertilization renders product+amount+read-only context, NOT block/bed/row as an input; saved entry still carries the context values; lysimeter fertilization no longer shows the 8 reading fields.

## Verification

- **Catalog:** `node scripts/generate-journal-catalog.js` then `--check` OK; `git diff` shows only v3/layout-v2 rows added, v1/v2 bytes untouched; both hardware profiles byte-parity per osi-schema-change-control.
- **Migrations:** runner applies 0023+0024 on a copy of a real DB; `PRAGMA integrity_check` OK.
- **Unit:** `npm run test:unit` + generator tests green; `npm run build` clean.
- **Live (kaba100), re-run the audit cases from spec §1:**
  1. `irrigation` on `open_field` Quick → water field + note only (was: + product mass/volume + 4 layout fields).
  2. `fertilization` on `lysimeter` Quick → product + amount + read-only context (was: 12 reading fields).
  3. `general_observation` → observation/note only.
  4. Plot-static context appears in plot setup, bulk-set across a station, and is snapshotted onto a saved entry (verify a row in `journal_entry_values`).

## Out of scope

Crop identity/cycle (Slice D) — `attr.crop`/`attr.variety` may appear as plain fields on seeding here but gain lifecycle in D. Full/Research per-activity scoping (Slice E). Agronomy adds (Slice F).
