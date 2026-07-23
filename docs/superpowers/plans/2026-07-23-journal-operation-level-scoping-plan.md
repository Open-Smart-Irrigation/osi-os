# Plan — Operation-level field/requirement/product scoping + comment + device-anywhere (catalog v10)

**Date:** 2026-07-23 · **Branch:** design-sync/agrolink · **Base:** f8bfe3fe · **Target:** catalog **v10** / migration **0032**

> **AUTHORITATIVE SPEC:** `/tmp/claude-1000/-home-phil-Repos-osi-os/b7dc0d5d-af41-4ccc-9436-079ca414b6e2/scratchpad/v10-operation-spec.md` (Fable-produced, plan-reviewed). Its §0 mechanism rules + §1 25-operation table + §2 product kinds + §3 uncovered-activity list + §5 superset are the implementation authority — transcribe them; this plan is framing. **Three plan corrections folded from the Fable REVISE:** (1) the comment field is a **GUI-only** render of the top-level `note` field state (a textarea wired to the existing `input.note` payload slot) — `note` is NOT a map member (it fails the generator's attribute validator). (2) Product kinds are the frozen DB CHECK values `mineral | organic_amendment | plant_protection | other` — NOT `mineral_fertilizer`/`biocontrol_agent`/lime. (3) Task 3's "weather on a sensorless plot" is **expected** (the manual weather group is the sensorless fallback, already hidden when the zone has a source) — drop it; the real complaint (weather on weed_mechanical) is fixed by Task 1. Also: every operation field list must lead with `attr.agroscope.operation` + `attr.agroscope.device` (REPLACE semantics), and the engine must merge the live in-form operation value into deriveFieldStates' selections (spec §0.5) or in-form operation changes go stale.

## Problem (maintainer-reported, Fable-audited)
v9 gave detailed operation selection, but fields **and requirements** are still keyed by the 16 activities, not the 25 operations. So (verified live): mechanical weeding **requires** a product + dose from an unfiltered, fertilizer-heavy list; harvest ops (incl. `cleaning_cut`, cover-crop incorporation) **require a yield** that doesn't exist; every crop-protection op shows the full spray set (weather, waiting-period, tank-mix, BBCH); the product picker offers every kind for every operation (Compost/Glyphosate on weeding). ~25 controls render for weed_mechanical, ~6 relevant, 5 of 7 "key" fields wrong-required.

Full per-operation relevance table + target model: `/tmp/claude-1000/.../scratchpad/agro-audit/` and the audit in the conversation — that table is the field-set spec for this plan; follow it.

## Maintainer decisions (confirmed)
1. **Scope fields per operation, keeping only what makes agronomic sense** (mechanical weeding: no product/mass-per-area/volume-per-area/weather/waiting/tank-mix).
2. **Device is never removed:** scoped **dropdown** where the operation has predefined devices (all 25 covered operations do), **optional free-text** where it doesn't (the 9 uncovered activities — re-introduce a free-text equipment/device field for them).
3. **Don't over-minimize** — keep the sensible optional fields (treated_area, operator, depth where relevant, comment).
4. **A comment field on every operation** (Full mode currently shows `note` only on the two observation activities).
5. (Copy-an-entry feature = a **separate** slice, not this one.)

Open/deferred (flagged, not in v10 unless trivial): hiding legacy activities that operations now duplicate (`weed_control_nonchemical` vs `weed_mechanical`, etc.) — a taxonomy decision still awaiting the maintainer.

## Design — operation-level overrides (the mechanism)
Add operation-keyed maps to `full_record@10`, consulted **when `attr.agroscope.operation` is set**, falling back to the activity maps otherwise (so the 9 uncovered activities and any operation without an override keep today's behaviour):
- `operation_fields_by_operation`: `{ <operation_code>: [field codes] }` — the trimmed, sensible field list per operation (from the audit table). When present for the selected operation, it REPLACES the activity's `operation_fields_by_activity[activity]` for the operation section.
- `operation_requirements`: `{ <operation_code>: { required: [...], required_any: [[...]] } }` — REPLACES `activity_requirements[activity]` when the operation is set. This is what fixes the wrong-required product/dose/yield.
- The operation-section `fields` superset (the map⊆fields validators, `generate-journal-catalog.js` + `catalogModel.ts`) must contain the union of everything any operation map references — extend it.

**templateEngine (`web/react-gui/src/journal/templateEngine.ts`) + edge (`osi-journal/index.js`):** in the field/requirement resolution, when the selections carry `attr.agroscope.operation`, prefer `operation_fields_by_operation[op]` / `operation_requirements[op]` over the activity-keyed maps; else use the activity maps. Keep it generic and data-driven (no hardcoded operation codes in GUI/edge). The edge validator must enforce `operation_requirements` too (so requiredness holds server-side) — mirror the existing `activity_requirements` path.

## Task 1 — `full_record@10`: operation-scoped fields + requirements + comment + device-freetext
Copy `full_record@9`. Then:
1. **`operation_fields_by_operation`** for all 25 operations per the audit's target table. Rules baked in per op: drop fields marked IRRELEVANT/✗; keep RELEVANT; **every** operation's list includes a **comment** field (`note`) and the operation's **device** (`attr.agroscope.device` — the dropdown; it's scoped by op via the layout deps) + `treated_area` + `operator` where the audit keeps them. E.g. `weed_mechanical: [device, treated_area, attr.amount_operation_depth (remapped working depth), attr.growth_stage_bbch, operator, note]` — NO product/amounts/weather/waiting/tank-mix.
2. **`operation_requirements`** per op: only the genuinely required fields. weed_mechanical/weed_other → nothing hard-required (device optional-but-present); chem-spray ops → device + product⊕unregistered + mass⊕volume; fertilizer ops → product(kind-scoped)⊕unregistered + amount; harvest_main_crop → crop + yield; harvest_cover_crop/hay/straw/cleaning_cut → **do NOT require yield** (drop it). tillage/sowing keep their good sets.
3. **Comment everywhere:** ensure `note` is in every activity's `operation_fields_by_activity` list too (fallback path for uncovered activities), not just the observation ones.
4. **Device-freetext for the 9 uncovered activities:** re-add a free-text device/equipment attribute (reuse `attr.equipment`, still defined; method stays retired) to `operation_fields_by_activity` for pruning/mowing/weed_control_nonchemical/crop_care/fertigation/planting_transplanting/equipment_maintenance/(others with no operation). These have no device dropdown, so a free-text "Device / equipment" + note is the sensible minimum.
5. Add any newly-referenced field to the operation-section `fields` superset.

## Task 2 — product-kind scoping
Give the product picker an operation→allowed-kinds restriction so weeding stops offering fertilizers.
- **Data:** the cleanest home is a per-operation allowed-kinds list. Options (pick in implementation, state which): (a) a new `operation_product_kinds: { <op>: [kinds] }` on `full_record@10`; or (b) `product_kinds` on the operation vocab rows. Kind→family mapping from the audit: plant_protection ops → `plant_protection`; biocontrol → `biocontrol_agent` (kind may not exist yet — if so, scope to none/flag); organic_fertilization → `organic_amendment`; mineral_fertilization → `mineral_fertilizer`; other_fertilization → organic+mineral+lime; everything else → **no product field at all** (handled by Task 1 removing product from their field list).
- **GUI:** at `EntryForm.tsx:480`, additionally filter the product options to the allowed kinds for the selected operation (default: all kinds, so unchanged where no restriction). Keep generic. Note: kaba100 has only 9 `organic_amendment` + 1 `plant_protection` product seeded — so mineral/biocontrol operations will show an empty product list until those seeds exist (that's the OSI-terms follow-up, not this slice); the free-text "Unregistered product" remains the escape.

## Task 3 — context/weather leakage (include the clean wins; flag the rest)
- **Weather on a sensorless plot:** the audit saw the weather group render on a plot with no zone weather source — re-check the `zoneHasWeatherSource` gate (`buildFinalBatchPayload`/capture flow); if it's genuinely mis-gating, fix it. If it's layout-deep, flag and defer.
- **Denominator / cover-type / block-row leaking onto every operation:** these are layout static-context. Gating them per-operation is layout-level and larger — if a clean generic gate exists (e.g. denominator only when an amount field is present), do it; otherwise flag as a follow-up and keep this slice to fields/requirements/products. Do NOT expand scope silently.

## Task 4 — catalog mechanics + tests
- Tag `full_record@10` `version: 10`; add `{version:10, name:'0032__journal_catalog_v10.sql'}` to `CATALOG_MIGRATIONS`; regenerate; `--check` byte-parity; regenerate 7 bundled DBs; run the FULL gate set incl. `test-journal-schema.js` **and `verify-agroscope-linkage.js`** (must stay green — this doesn't touch the agroscope dependency structure, only full_record field maps). Migration 0032 additive-only. Edge modules byte-identical across profiles.
- **Tests:** edge (both profiles) — a `full_record@10` weed_mechanical entry validates **without** any product/dose (previously blocked); a `cleaning_cut` validates **without** yield; a chem-spray op still requires product+dose; `@9`-pinned entries keep old rules. GUI — templateEngine resolves the operation map when an operation is set and the activity map otherwise; the product picker filters by operation kind (fertilizer op shows only fertilizer kinds; weeding shows no product field); a comment field renders for every operation; uncovered activities show a free-text device field. `typecheck` + `test:unit` green.

## Deploy + live-verify (kaba100)
Migration 0032 → catalog_version 10 (verify entries preserved). Live (admin, Full): mechanical weeding shows device + treated-area + depth + operator + comment and **saves without a product/dose**; the product dropdown is gone there; a fertilization entry's product list shows only fertilizer kinds; pruning (uncovered) shows a free-text device + comment; harvest cover-crop saves without a yield. Commit path-scoped, push.

## Back-compat / risks
- Entries pin `template@version`; the ~30 kaba100 entries stay valid under `full_record@9`/earlier. v10 is additive.
- **Operation-map override precedence** is the core new mechanism — verify it does NOT change resolution for the 9 uncovered activities (no operation → activity map) or for an entry whose operation lacks an override. This is the highest-risk seam; test both branches explicitly, GUI and edge.
- **verify-agroscope-linkage** must stay green — confirm the operation/device dependency structure is untouched (this changes field *maps*, not `option_dependencies`).
- Empty product lists for mineral/biocontrol ops are expected (no seeds yet) — the "Unregistered product" free-text is the interim path; note in the PR, don't block.
