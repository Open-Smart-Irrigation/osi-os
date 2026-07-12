# Layout: "Agroscope open field" — Design & Faithful Template Duplication

**Date:** 2026-07-12
**Status:** Draft for review
**Parent spec:** [2026-07-12-field-journal-design.md](2026-07-12-field-journal-design.md) (decision D8 — layouts)
**Source:** SoilManageR management-data template **v2.6** (23.12.2024), Agroscope SoilX project
**Source files in repo:** [`agroscope-open-field/SoilManageR_mgmt_data_template_V2.6.xlsx`](agroscope-open-field/SoilManageR_mgmt_data_template_V2.6.xlsx) · full machine-readable extraction [`agroscope-open-field/catalog.json`](agroscope-open-field/catalog.json)
**Origin:** https://zenodo.org/records/14546261 — License **CC BY** (attribution: Wittwer, Heller, Turek — Agroscope)

## 1. What this layout is

`agroscope_open_field` is the first concrete **layout** (agronomic setting) under the field-journal design. It faithfully duplicates the categories and input options of the SoilManageR management-data template, so an OSI journal running this layout produces records compatible with Agroscope's SoilManageR R package (which derives management indices: tillage intensity, soil-cover duration, C inputs, model input).

The template's vocabulary follows, in decreasing priority: **AGROVOC → KTBL (2020) → NRCS (2017) → Mohler et al. (2021) → Blanchy et al. (2023)**, with custom terms only where those sources lacked an option. Every operation/device carries a source attribution in `catalog.json` (`source` field), preserving that provenance.

## 2. Template structure (as extracted)

The template is **not** a flat activity list. Each management operation is a **4-level dependent cascade**, plus a numeric value, plus optional context fields:

```
category  ──▶  operation  ──▶  device  ──▶  unit(s)     +  value (numeric)
(7)            (25 total)      (82 uniq)     (19 distinct)
```

Each level's options **depend on the parent selection** (Excel `INDIRECT()` validation): choosing `category = fertilizer_application` restricts `operation` to {organic_fertilization, mineral_fertilization, other_fertilization}; choosing `device = solid_broadcast` restricts `unit` to the 10 nutrient units. This is the defining characteristic to reproduce.

### 2.1 Counts (authoritative, from `catalog.json`)

| Level | Count |
|---|---|
| Categories | 7 |
| Operations (across categories) | 25 |
| Device slots (operation×device) | 128 |
| Unique devices | 82 |
| Distinct units | 19 |
| Crop options | 26 |
| Product suggestions (optional) | 24 |

### 2.2 Categories → operations

| Category | Operations |
|---|---|
| `tillage` | primary_tillage, seedbed_preparation, stubble_cultivation |
| `sowing` | sowing_cover_crop, sowing_main_crop |
| `fertilizer_application` | organic_fertilization, mineral_fertilization, other_fertilization |
| `crop_protection` | biocontrol, fungicide, insecticide, growth_regulator, weed_herbicide, total_herbicide, weed_mechanical, weed_other, pest_control |
| `harvest` | harvest_main_crop, harvest_cover_crop, hay_removal, straw_removal, cleaning_cut |
| `irrigation` | watering |
| `other` | sampling, note |

Full operation→device→unit expansion (with definitions and source attribution) is in `catalog.json` under `categories[].operations[].devices[]`. It is duplicated in full — 128 device slots — not summarized away.

### 2.3 Row-level fields (per management operation)

| Field | Type | Notes |
|---|---|---|
| `crop` | choice (26) | main crop; cover-crop operations attributed to the **next** main crop |
| `date` | date | operation date |
| `year` | integer | optional; not used by the R package |
| `category` / `operation` / `device` | dependent choices | the cascade above |
| `value` | numeric | e.g. tillage depth (cm), application rate |
| `unit` | choice (device-scoped) | valid set depends on device |
| `machine` | free text | type/manufacturer/tool |
| `product` | free text (+24 optional suggestions) | e.g. amendment/PPP name, C content |
| `combination` | integer | links combined operations on the same date |
| `comments` | free text | |
| **Organic-fertilization optional** | numeric | `DMC` (dry matter kg/t or kg/m³), `C_content` (gC/kgDM), `N_content` (gN/kgDM) |
| **Harvest optional** | numeric | `crop_product` (t/ha DM), `crop_residue` (t/ha DM), `Cc_product` (gC/kgDM), `Cc_residue` (gC/kgDM) |

### 2.4 Distinct units

`cm`, `kg/ha`, `plants/ha`, `m3/ha`, `t/ha`, `l/ha`, `g/ha`, `unit/ha`, `hours/ha`, and the mineral-nutrient set `kg N/ha`, `kg P2O5/ha`, `kg K2O/ha`, `kg Mg/ha`, `kg S/ha`, `kg Ca/ha`, `kg B/ha`, `kg Na/ha`, `kg Mn/ha`, `kg CaO/ha`.

### 2.5 Treatment factors (trial design, optional)

The template's `Choice_list` also carries Oberacker-trial treatment factors: plot/`Parzelle` (I, II, III, IV, V, VI, all), `Tillage_System` (Plough, No-till, all), `Fertilization` regime (GRUD, Kinsey, all). These describe **experiment design**, not a single operation. They map to the researcher plot/replicate-identifier need and are modeled as optional layout-level fields (§4.4), not per-entry activity attributes.

## 3. Source quirks (found during extraction) and handling

Faithful duplication preserves source values; these 26 quirks are recorded in `catalog.json.quirks` and handled as noted (we do **not** silently mutate the source):

1. **`cleaning_cut` has an empty device dropdown** in the source (named range missing). The Description sheet defines `cleaning_cut > mower`. → Seed `cleaning_cut` with device `mower`; flag to Agroscope.
2. **`harvest_main_crop` lists `mower` twice.** → De-duplicated to one.
3. **Device `note` unit range is self-referential** (points back to note/frost_kill_cover_crop). → Treat `note`/`frost_kill_cover_crop` as no-value operations.
4. **Devices with no unit set** (value/unit not expected): all harvest devices, `pest_control` (slug/rodent), `sampling` (soil/plants), `weed_other > burning`/`electric`, `weed_herbicide > sprayer_spot`, `sowing_main_crop > potato_planter`. → Value optional for these; no unit dropdown.
5. **`seedbed_preparation` and `stubble_cultivation` share an identical 21-device list** in the source dropdown even though semantically distinct. → Reproduced as-is (faithful); noted for possible future refinement with Agroscope.

## 4. Mapping onto the OSI journal model

Category → activity; the deeper cascade levels → dependent attributes. This keeps the activity set small and reuses the journal's typed-value model.

### 4.1 Activities (`journal_vocab.kind='activity'`, layout-scoped)

`agroscope.tillage`, `agroscope.sowing`, `agroscope.fertilization`, `agroscope.crop_protection`, `agroscope.harvest`, `agroscope.irrigation`, `agroscope.other` — labels from the source category names; `agrovoc_uri`/source carried from `catalog.json`.

### 4.2 Attributes (`journal_vocab.kind='attribute'`)

| Journal attribute | From template | value_type | Notes |
|---|---|---|---|
| `attr.operation` | operation | choice | options depend on activity (dependent choice) |
| `attr.device` | device | choice | options depend on operation |
| `attr.amount` | value + unit | number + `unit_code` | unit options depend on device; **repeatable group** for multi-nutrient events |
| `attr.crop` | crop | choice | default from `irrigation_zones.crop_type`; overridable |
| `attr.machine` | machine | text | |
| `attr.product` | product | text | 24 optional suggestions as `choice` hints |
| `attr.combination_group` | combination | number | groups combined same-date operations |
| `attr.dmc` / `attr.c_content` / `attr.n_content` | organic optional | number | shown only for `organic_fertilization` |
| `attr.crop_product` / `attr.crop_residue` / `attr.cc_product` / `attr.cc_residue` | harvest optional | number | shown only for harvest operations |

`comments` → the entry-level `note`. `date` → `occurred_start`. `year` is derivable, not stored separately.

### 4.3 Multi-nutrient events — an improvement over the Excel

In SoilManageR, recording N+P+K for one `solid_broadcast` fertilization needs three rows (or the `combination` column). With the journal's repeatable `group_index` values (parent spec §4.2), **one** fertilization entry holds multiple `(attr.amount, unit_code)` pairs — {120 kg N/ha, 30 kg P2O5/ha, 80 kg K2O/ha}. The layout renders one "add nutrient" repeater. Export flattens back to SoilManageR's one-value-per-row on demand, preserving round-trip compatibility.

### 4.4 Treatment/plot fields (layout-level, optional)

`layout.plot` (Parzelle), `layout.tillage_system`, `layout.fertilization_regime` as optional entry fields surfaced only in this layout, defaulting from zone/trial config. These satisfy the researcher plot/replicate-identifier need without polluting the generic model.

## 5. Design implication for the parent spec — RESOLVED 2026-07-12

**Resolution (post Phase-1 review consolidation):** the cascade lives in the layout's `definition_json` as `option_dependencies` (choices and allowed-unit sets constrained by earlier field values), enforced by the same edge validator — exactly the recommendation below, independently corroborated by review finding AGR-3. Device-scoped units use the same mechanism. Additional resolutions: combined operations use an entry-level `pass_uuid` (exports derive SoilManageR `combination` integers); multi-nutrient events use the repeatable value groups; product/DMC/C/N map to the `journal_products` registry (parent spec §4.6) with derived nutrient rates computed at export from frozen compositions. Parent spec §4.5 now carries the normative contract. Original analysis retained below for provenance.

### Original analysis (superseded by the resolution above)

Duplicating this template surfaces a capability the parent journal spec (§4.3–4.5) does **not** yet fully express: **dependent (cascading) choice options**, where an attribute's valid choices depend on the value selected in another field. The parent spec's vocab model has `parent_code` (choice → its attribute) but no "options-of-B depend on selected-value-of-A."

**Proposed addition to the parent design** (to be folded in after the spec review):
- Add an optional `depends_on_code` + `depends_on_value` to `journal_vocab` choice rows (a choice is offered only when the named parent attribute currently holds the given value), **or** express the cascade in the layout's `definition_json` as an explicit option-dependency map. Recommendation: **layout `definition_json`**, because the cascade is layout-specific (SoilManageR's operation→device tree is an Agroscope construct, not universal), keeping the shared vocab flat.
- Add **device-scoped unit sets**: valid `unit_code`s for `attr.amount` depend on the selected `attr.device`. Same mechanism (dependency map in `definition_json`).

`catalog.json` remains the faithful, machine-readable source of record for the cascade; the Slice-1 seed generator derives the layout's `option_dependencies` map from it.

## 6. Deliverables produced now

1. **`catalog.json`** — complete, faithful, machine-readable duplication of every category, operation, device, unit, crop, product suggestion, treatment factor, row-field, and quirk. This is the authoritative input for the eventual `agroscope_open_field` layout seed + associated vocab rows.
2. **This design doc** — structure, mapping to the journal model, quirks, and the dependent-options design implication.

## 7. Not done now (correctly deferred)

- No schema, seed, `flows.json`, or GUI changes — the parent journal design is still under review; this layout depends on decisions (dependent-options mechanism) that the review may influence.
- German/French labels: `catalog.json` carries the canonical English/technical codes; `labels_json` localization is a Slice-2 concern tied to i18n (#47). AGROVOC provides reference translations for mapped terms.
- Reconciliation of the dependent-options mechanism into the parent spec (§5) — pending review outcome.
