# Plan — Journal Slice F: Agronomy adds (BBCH growth stage · weather-at-application · tank-mix)

**Spec:** [2026-07-20-journal-capture-streamlining-design.md](../specs/2026-07-20-journal-capture-streamlining-design.md) (R8; Fable F-AG-1/2/3)
**Branch:** `design-sync/agrolink` · **Risk:** medium · **Migration:** `0028__journal_catalog_v6.sql` (catalog v6) — LOCKED in spec §8.1 (slot is **after E's `0027`**, not after D; D took `0026`, E took `0027`)

Three independent, additive agronomy gaps the Fable review surfaced and the owner chose to fold in now (not defer). Each is its own testable unit; ship together as Slice F, deploy + kaba100 re-test once.

## F1 — Structured BBCH growth stage

Replaces the "put BBCH in free text" workaround (free text is banned as load-bearing per spec §4.1).

- **Decision (settled in Fable plan review): `attr.growth_stage_bbch` is a NUMBER (0–99), not a choice.** BBCH's two-digit principal+secondary structure carries agronomically meaningful granularity (e.g. flowering sub-stages 60–69 for pollinator-safe spray timing) that a principal-only choice list would lose. The labelled principal-stage quick-pick is a **UI convenience that writes the number**, not a parallel choice-typed field.
- **Files:** `scripts/journal-catalog-core.js` — add `attr.growth_stage_bbch` as a number attribute `{ min: 0, max: 99, step: 1 }` **plus its companion `units` entry** (`validateCore()` requires every number attribute's `quantity_kind`/`basis` to match a unit whose `default_unit_code` resolves to a canonical root — e.g. a dimensionless `unit.bbch_stage`). Add to the relevant activity sets (Quick optional; Full/Research visible) for `general_observation`, `pest_disease_observation`, `plant_protection_application`, `crop_care`, `harvest`.
- **Tests:** attribute validates 0–99; resolves into the named activities' field sets; generator `validateCore()` passes with the new unit; catalog `--check` OK.

## F2 — Manual weather-at-application fallback (plant protection)

Auto weather capture only exists where a weather station is present (parent §4.8); a plant-protection application on a **sensor-less** plot must record conditions manually for drift/compliance.

- **Files:** `scripts/journal-catalog-core.js` — add `attr.wind_speed` (number, m/s), `attr.wind_direction` (choice N/NE/…/NW), `attr.air_temperature` (number, °C), `attr.rel_humidity` (number, %). **Each of the three number attributes needs a companion `units` entry** satisfying `validateCore()` (matching `quantity_kind`/`basis`, `default_unit_code` → canonical root: `unit.m_per_s`, `unit.deg_c`, `unit.percent`); `wind_direction` is a choice (add `choice.wind.*`), not a unit. Wire as a **conditional group** on `plant_protection_application` that appears only when the plot has no linked weather source (resolved in the model/edge); pre-filled from the zone weather snapshot when one exists.
- **Files (edge/GUI):** resolution of "has weather source?" in `catalogModel`/edge `context.js`; `EntryForm.tsx` renders the group.
- **Tests:** group shown for plant protection on a sensor-less plot, hidden when a weather source exists (auto-snapshot path unchanged); units/ranges validated.

## F3 — Tank-mix (multiple products per pass)

Multiple products in one spray pass (herbicide + adjuvant + micronutrient) — common Swiss practice. Reuse the existing **pass mechanism** (P8, `pass_uuid`) rather than a new table.

- **Files (retargeted per Fable):** the pass vehicle is `pass_uuid` in `web/react-gui/src/journal/buildFinalBatchPayload.ts` (+ `entryCorrection.ts`) and the batch/pass creation in `JournalCaptureFlow.tsx` — **NOT** `RepeatTreatmentCard.tsx` (that is the carry-forward "repeat last values" component, unrelated to passes). "Add product to this pass" adds another product+dose row, all sharing one `pass_uuid`; renders as one stacked card. Edge `osi-journal/api.js` accepts N product rows under a pass. Confirm the SoilManageR `combination` integer derivation at export still holds.
- **Tests:** two products under one `pass_uuid` persist as linked entries/values; export combination integer correct; single-product path unchanged.

## Verification

- Catalog `--check` OK, both-profile parity; migration runner dry-run + `integrity_check`; `npm run test:unit` + generator + edge tests green; `npm run build` clean; both edge profiles byte-identical.
- **Live (kaba100):**
  1. Observation entry → BBCH stage selectable, stored structured (not in note).
  2. Plant protection on a sensor-less plot → manual wind/temp/humidity group appears; on a plot with a weather source → auto-captured, no manual group.
  3. Spray pass with herbicide + adjuvant → both recorded under one pass, shown as one card; CSV/export shows the combination correctly.

## Out of scope

Anything in A/BC/D/E. Orchard/vine/vegetable crop granularity (named as an accepted v1 limitation in spec §9) — not addressed here.
