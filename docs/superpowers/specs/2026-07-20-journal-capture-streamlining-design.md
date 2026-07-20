# Field Journal — Capture Streamlining & Crop-Cycle Lifecycle

**Date:** 2026-07-20
**Status:** Draft — decisions D1–D14 settled 2026-07-19/20; crop list confirmed (§9); Fable UX/agronomy review folded in as revisions R1–R9 (§11), owner-adjudicated 2026-07-20. Ready to build Slice A.
**Parent spec:** [2026-07-12-field-journal-design.md](2026-07-12-field-journal-design.md) + [UX addendum](2026-07-12-field-journal-ux-addendum.md) (U1–U7, P1–P9)
**Trigger:** Live capture testing on kaba100 (2026-07-19). Choosing *Irrigation → sprinkler* (or any Quick activity) lands on a form full of unrelated fields; a fertilization on a lysimeter plot demands 12 water-balance readings. The taxonomy leaks into the interface. Two farmer/researcher personas both bounce off it.

---

## 1. Problem (evidence)

Live audit (`journal-ux-audit.js`, mobile UA, kaba100):

- **Quick is not activity-scoped.** `farmer_quick@2.key_values` = `[irrigation_depth, amount_mass_area_product, amount_volume_area_product, note]` for *every* activity. A sprinkler irrigation shows product-mass/volume fields; a fertilization shows irrigation depth. Only `full_record` has per-activity scoping (`activity_requirements` + `conditional_groups`).
- **Layout `minimum_fields` are forced on every activity, every template.** `open_field` adds 4, `greenhouse` 6, `lysimeter` 12 — regardless of what you're logging. Most lysimeter minimum_fields (`water_input, rain_input, drainage_volume, mass_start/end/tare, interval_minutes`) are *per-measurement readings*, not context; forcing them onto a fertilization is nonsense.
- **Detail level is a per-entry choice, defaulted by layout.** `agroscope_open_field` defaults to `research_observation` → the ~25-field research wall (carbon/nitrogen content, treatment factors) greets a farmer who just wanted to note irrigation.
- **Crop identity is re-entered every activity.** No carry-over: crop/variety must be re-selected on every fertilization. `attr.crop` *is* a choice, but its values today are only the 26 Agroscope crops surfaced via the Agroscope layout; there is no variety field and no cycle to carry either across activities.

## 2. Goal

The capture form shows **only the fields that pertain to the chosen activity, at the user's chosen level of detail, with plot-static context and crop identity carried for them** — while preserving the full research-grade record model underneath for `full_record`/`research_observation` and export.

---

## 3. Decisions ledger

| # | Decision | Source |
|---|---|---|
| D1 | **Detail level is a global per-user setting**, default `Quick`, changeable **only in Settings** (no per-entry dropdown, no per-entry escape hatch, no first-run prompt). Layout no longer defaults it. | owner #11 |
| D2 | **Quick becomes activity-scoped.** Each activity declares its own small Quick field set; non-pertinent fields never render in Quick. | owner (streamlining) |
| D3 | **Plot-static context moves to plot setup**; set per plot at creation, editable later, **bulk-settable for a whole station**, and **still snapshotted onto each entry** for the record. | owner #12 |
| D4 | **Per-measurement readings become activity-scoped**, not plot-static and not forced. (The lysimeter water-balance fields appear only on the measurement/sampling activity.) | derived from #12 + D2 |
| D5 | **Crop is a fixed controlled list**; only an **admin** account can add to it. Variety is free-text with **autocomplete from previously-used varieties** for that crop. | owner #1, #2 |
| D6 | **Crop cycle is a per-plot lifecycle.** Seeding a plot opens a cycle (crop + variety); the crop is **carried forward** to later activities on that plot until harvest, which closes it. | owner (crop-cycle) |
| D7 | **Groups are the multi-plot vehicle.** Flow: create a group (name it, e.g. "Winter Barley", enter `1,5,8,9,10-13`) → then log the activity. Later activities: **select the group**, then log — crop/variety inherited. | owner #5, #6 |
| D8 | **Inherited crop shows as a banner** on non-seeding activities: crop · variety · "seeded {date}". The crop·variety text is tappable → a **lightweight inline correction sheet** that writes the fix to the **seeding entry** (single edit source preserved); the seeded-date also links to the seeding entry. Revised from date-only-link per Fable R2. | owner #3/#4, R2 |
| D9 | **Re-seeding auto-closes** the prior open cycle on those plots, recorded as `reseed` (distinct from `harvest`). | owner #7 |
| D10 | **Partial harvest closes only the selected plots.** A cycle spanning plots `2,4,5,9,12` harvested on `2,4` closes those two; it stays open on `5,9,12`. | owner #3 |
| D11 | **Backdating is retroactive.** Seeding backdated 2 weeks retro-applies the crop to activities already logged in that window (resolution is live-by-date, §6). | owner #9 |
| D12 | **Intercropping is allowed but rare** — a plot may carry more than one open cycle; the capture form disambiguates when >1 covers the plot. | owner #10 |
| D13 | **Cycle is owned by its entries (my #8 recommendation, accepted pending objection).** Correcting a seeding's crop updates the open cycle live; voiding a seeding removes its cycle (warn if it has dependents); voiding a harvest re-opens it. **The one freeze point is harvest**: closing a cycle snapshots the covered entries' crop into `season_crop/season_variety` so a later re-seed can't rewrite closed records. | owner #8 (deferred to me) |
| D14 | **Progressive disclosure for Full/Research.** Their extra fields render in collapsible sections, not a flat wall. | owner (streamlining) |

---

## 4. Field resolution (new model)

Effective fields for an entry = **A ∪ B ∪ C**, deduped, in section order:

- **A — Activity Quick set** (D2): a new per-activity `quick_fields` map in the catalog. Example: `irrigation → [attr.irrigation_depth | attr.irrigation_volume_area]`, `fertilization → [product, one amount family]`, `seeding → [attr.crop, attr.variety, seed rate]`, `harvest → [yield]`. `note` always present.
- **B — Detail level** (D1): `Quick` = A only (+ carried context/crop as read-only). `Full` = A + `full_record` operation fields for the activity (progressive-disclosed, D14). `Research` = + identity/protocol/custom-value sections.
- **C — Plot-static context** (D3): rendered read-only from plot settings (block/bed/row, cover type, denominator default, greenhouse structure/root-zone, lysimeter experimental-unit/replicate/treatment/surface-area), editable via "edit plot", **snapshotted** onto the entry.

**Effective template guard (preserves U4):** effective detail level = the user's D1 setting **if the plot's layout `supported_templates` allows it**, else the layout's lowest supported template. So a Quick user on a researcher-only `agroscope_open_field` plot still gets research fields — the layout, not the person, floors it.

**Per-measurement readings (D4):** the lysimeter/greenhouse *reading* fields (`water_input, rain_input, drainage_volume, mass_start/end/tare, interval_minutes, ec, ph, wetted_area`) move from layout `minimum_fields` into the `quick_fields`/activity sets of the **measurement/sampling** activities only. They stop being universal minimum_fields.

---

## 5. Data model

All additive. Migrations start at **0023**; the catalog delta is **catalog v3** (current is v2 / migration 0022). Both hardware profiles stay byte-identical; gated by `osi-schema-change-control`.

### 5.1 Crop cycles (new tables)

```sql
-- 0023: crop-cycle lifecycle
CREATE TABLE journal_crop_cycles (
  cycle_uuid TEXT PRIMARY KEY,
  crop_code TEXT NOT NULL REFERENCES journal_vocab(code),   -- kind='choice', parent 'attr.crop'
  variety TEXT,
  group_uuid TEXT REFERENCES journal_plot_groups(group_uuid),  -- cohort that opened it, nullable
  opened_by_entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid),
  starts_on TEXT NOT NULL,                                  -- = seeding occurred date (local)
  gateway_device_eui TEXT,
  created_by_principal_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Per-plot membership carries the CLOSE state, so partial harvest (D10) and
-- per-plot re-seed (D9) are first-class. A plot's cycle is "open" when ends_on IS NULL.
CREATE TABLE journal_crop_cycle_plots (
  cycle_uuid TEXT NOT NULL REFERENCES journal_crop_cycles(cycle_uuid) ON DELETE CASCADE,
  plot_uuid  TEXT NOT NULL REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  ends_on TEXT,                                             -- NULL = open on this plot
  closed_by_entry_uuid TEXT REFERENCES journal_entries(entry_uuid),
  close_reason TEXT CHECK (close_reason IN ('harvest','reseed','manual')),
  PRIMARY KEY (cycle_uuid, plot_uuid)
);
CREATE INDEX idx_ccp_plot_open ON journal_crop_cycle_plots(plot_uuid) WHERE ends_on IS NULL;
```

Intercropping (D12) falls out for free: two open membership rows for the same `plot_uuid` in different cycles.

### 5.2 Crop list + variety (catalog v3)

- **The controlled crop list already exists**: the generator seeds 26 `agroscope.crop.*` choices under `attr.crop` (export-aligned to Agroscope). **Adopt these as the global controlled list** rather than seeding a parallel `choice.crop.*` set — this keeps Agroscope export codes stable and avoids a duplicate vocabulary. Add only the farmer-facing categories missing from it (§9). Admin-added crops = `scope='custom'` rows under `attr.crop` in `journal_vocab`, gated to the admin role at the write path (no new table). Farmer-friendly **display** labels (e.g. "Winter barley" for canonical "barley, winter") via `labels_json`, leaving the export code/label intact.
- Add `scalarAttribute('attr.variety', 'Variety', 'text', { maxlength: 120, autocomplete: 'variety_by_crop' })`. Autocomplete source = distinct `variety` from `journal_crop_cycles` for that `crop_code` on this gateway.

### 5.3 Detail-level preference

Reuse an existing per-user preference store if one exists; otherwise add:

```sql
CREATE TABLE journal_user_prefs (
  user_uuid TEXT PRIMARY KEY,
  detail_level TEXT NOT NULL DEFAULT 'farmer_quick'
    CHECK (detail_level IN ('farmer_quick','full_record','research_observation')),
  updated_at TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0
);
```

### 5.4 Plot-static context

Extend `journal_plot_settings` with `context_json TEXT` (the plot-static field values from §4-C). Bulk-set applies to all plots sharing `station_code`. Snapshot onto entries continues via existing `journal_entry_values`.

---

## 6. Crop resolution: live vs. frozen (D11, D13)

The displayed crop for an entry is resolved by rule, not by a single stored column:

1. **Open cycle covers the plot+date** → display **live** from `journal_crop_cycles` (join membership where `starts_on ≤ occurred_date` and `ends_on IS NULL OR ends_on ≥ occurred_date`). This makes backdating (D11) and mid-cycle crop correction (D13) propagate to every activity automatically, with no per-entry rewrite.
2. **> 1 open cycle covers the plot** (intercropping, D12) → the capture form asks which crop this activity applies to (or "all"); display shows the chosen one(s).
3. **Cycle closed (harvested)** → at close we **freeze**: write each covered entry's `season_crop/season_variety` (existing columns). After close, display reads the frozen snapshot, so a later re-seed can never rewrite the harvested crop's history.
4. **No cycle** → no crop banner; `attr.crop` is simply absent (crop is optional for cycle-less activities like tillage on fallow ground).

This supersedes the always-snapshot-at-write behaviour of edge `resolveSeason()` (osi-journal/lifecycle.js): while a cycle is open the snapshot is deferred; `resolveSeason` still governs the frozen write, now triggered at harvest close rather than at every entry.

**Consistency cascades (D13):**
- Correct seeding crop/variety → update the open cycle row (live displays follow).
- Void seeding → soft-delete its cycle; dependent activities fall back to any prior covering cycle or "no crop"; **warn** if the cycle has ≥1 dependent activity before voiding.
- Void harvest → clear the `ends_on/closed_by/close_reason` it set (re-open), and un-freeze the snapshots it wrote.

---

## 7. UX

- **Settings → Journal → "Detail level"** (D1): three-way Quick / Full / Research, per user, default Quick. Copy: "How much detail do you record? You can change this any time."
- **Group-first seeding (D7):** "Where?" step offers *Create group* → name + range input (`1,5,8,9,10-13`, reusing the U7 grid/range control) → proceed to the seeding form (crop dropdown + variety autocomplete). Groups are layout-homogeneous (U7). Single-plot seeding stays available (no group required).
- **Group-select for later activities (D7):** "Where?" lists active groups ("Winter Barley") as one-tap cohorts; selecting one carries its crop/variety.
- **Inherited-crop banner (D8):** non-seeding activities on a cropped plot show a read-only strip — `🌱 Winter Barley · Marlene · seeded 12 Jul` — the date is a link to the seeding entry (the only edit path for the crop). No crop field on the form.
- **Harvest (D10):** targets a plot/group; multi-select subset supported; closes only selected plots; after a whole-group harvest, offer to resolve the group (U7).
- **Progressive disclosure (D14):** Full/Research extra fields sit in collapsed `<details>`-style sections ("More detail", "Research fields") with the pertinent ones open by default.
- **Plot setup (D3):** plot create/edit gains the static-context fields; a station-level "apply to all plots in this station" affordance for bulk set.

All strings via i18n keys across the 7 locales (`en, de-CH, fr, it, es, pt, lg`), per the frontend-design skill.

---

## 8. Slice plan (build order, kaba100 re-test between each)

| Slice | Scope | Migration | Risk |
|---|---|---|---|
| **A** | Detail-level global setting (D1): pref store + Settings UI + capture flow reads it, drop the per-entry template picker; effective-template guard (U4). | maybe 5.3 | low |
| **BC** | **Merged per R1** — activity-scoped Quick + reading rescoping (D2/D4, catalog v3 `quick_fields`) **together with** plot-static context relocation (D3: `journal_plot_settings.context_json`, plot-form fields, bulk-per-station, read-only snapshot). Only both together actually clear the wall on a kaba100 re-test; B alone leaves the layout-forced Required fields. Irrigation amount-kind bound to plot (R6). | 0023 (catalog v3) + 0024 | medium-high |
| **D** | Crop-cycle lifecycle (D5–D13) + manual close (R3) + same-crop-reseed continuation (R4) + edge cases (R7): cycle tables, crop list + variety, seeding/harvest/reseed/partial-harvest, group flow, inline-correction banner (R2), live-vs-frozen resolution, edge `lifecycle.js`. **Largest — may split D-1/D-2/D-3.** | 0025 | high |
| **E** | **Full/Research field scoping + progressive disclosure (D14 + R5)** — per-activity visibility for `full_record` **plus** collapsible sections. Now carries a data-model change, not GUI-only. | catalog v3 (with BC) | medium |
| **F** | **Agronomy adds (R8):** structured BBCH growth stage; manual weather-at-application fallback for plant protection on sensor-less plots; tank-mix (multiple products per spray pass via the P8 pass mechanism). | 0026 | medium |

Order rationale: A first (cheapest, removes the detail-level surprise); **BC** delivers the real relief (the wall gone, verifiable on kaba100); D builds the crop-cycle value; E gives researchers a scoped (not just collapsed) Full/Research form; F closes the agronomy gaps. Each slice: implement → both-profile catalog regen + byte-parity check → deploy to kaba100 → live re-test the affected activities → owner sign-off.

### 8.1 LOCKED catalog-version & migration-slot assignment (Fable plan review, 2026-07-20)

The generator stamps each template/layout `version` as a **single global counter**, contiguous `1..N` across *every* row kind (templates, layouts, attributes, choices, units, products), asserted in `compileCatalog`. **v1/v2 are frozen** (`0019`, `0022`); a mis-numbered migration that is already written must be *superseded by a new one*, never edited. Every new template/layout version = the next **global** integer, not a per-code counter.

| Catalog ver | Migration slot | Slice | Contents |
|---|---|---|---|
| v1 | `0019` | — | baseline (frozen) |
| v2 | `0022` | — | frozen — `farmer_quick@2` |
| **v3** | `0023` | BC | `farmer_quick@3` **+** `open_field`/`greenhouse`/`lysimeter` layouts **@3** (not @2) |
| (schema) | `0024` | BC | `journal_plot_settings.context_json` ALTER |
| (schema) | `0025` | D | `journal_crop_cycles` + `journal_crop_cycle_plots` |
| **v4** | `0026` | D | `attr.crop` farmer additions + `attr.variety` (+ crop labels) |
| **v5** | `0027` | E | `full_record@5` (per-activity visibility) |
| **v6** | `0028` | F | `attr.growth_stage_bbch` + weather attrs + their units/choices (tank-mix reuses the P8 pass mechanism — no new attr) |

---

## 9. Controlled crop list (reconciled with Agroscope, D5 — owner-confirmed 2026-07-20)

The list is **already seeded** as the 26 Agroscope crops under `attr.crop` — adopt them as the global controlled list (keeps Agroscope export codes stable):

barley (spring/winter) · faba bean (spring/winter) · beet (fodder/sugar) · maize (grain/silage) · oat (spring/winter) · pea (spring/winter) · rapeseed (spring/winter) · rye (spring/winter) · triticale (spring/winter) · wheat (durum/spring/winter) · potato · sorghum · soybean · sunflower · **ley, temporary**

**Farmer-facing additions** (not in the Agroscope set — add as core `attr.crop` choices): Permanent grassland · Field vegetable · Green manure / cover crop · Fallow · Other.

- **Temporary ley** stays plain — no "clover-grass" qualifier, since ley mixtures vary (owner correction).
- Display labels localized farmer-friendly ("Winter barley") while the canonical Agroscope export code/label stays intact.
- Variety: free-text, per-crop autocomplete (D5) — no controlled variety list.
- Admin-only extension via `scope='custom'`.
- **Accepted v1 limitation (R8/F-AG-4):** the list is arable/ley-grade. "Field vegetable" is one bucket (no lettuce-vs-cabbage), and there is no orchard/vine granularity (no Chardonnay-vs-Pinot). Named here so it reads as a known gap, not coverage; horticulture/viticulture granularity is a future admin-list or follow-up spec.

---

## 10. Invariants (carried from parent specs / runbooks)

- No `flows.json` node-graph edits in this work (catalog + GUI + edge helper modules only).
- Both hardware-profile catalogs regenerate **byte-identical**; migrations gated by `osi-schema-change-control` (checksums, semantic compare, fingerprint stamping).
- Live kaba100 `farming.db` is never overwritten/reseeded — schema arrives via the ordered migration runner only.
- Historical entries keep resolving: existing template/layout versions stay byte-identical; new behaviour ships as new versions (farmer_quick@3, catalog v3), never edits to @1/@2.

---

## 11. Review-driven revisions (Fable UX/agronomy review, 2026-07-20 — owner-adjudicated)

| R | Revision | Amends |
|---|---|---|
| R1 | **Merge Slices B+C.** B alone leaves the layout-forced Required fields (block/bed/row, treated area, cover type, denominator) on every entry; only C removes them. Ship together so the first kaba100 re-test shows the wall actually gone. | §8 |
| R2 | **Banner crop edit is inline, not a navigation detour.** crop·variety text tappable → inline correction sheet that writes to the seeding entry (single edit source kept). Guards against people typing corrections into `note` (never load-bearing). | D8, §7 |
| R3 | **Manual cycle-close.** Expose "this ends the crop cycle" (writes `close_reason='manual'` with the activity's own date) on `tillage_soil_work`, `mowing`, `plant_protection_application` when they cover an open-cycle plot, and as a banner action. Fills the failed-crop / cover-crop-termination / ley plow-down gap the schema already anticipates. | §5.1, §6 |
| R4 | **Same-crop reseed continues the cycle.** D9's auto-close fires only when the seeded crop **differs** from the open cycle; a matching crop prompts "continue this cycle or start new?" (infill / gap-fill). | D9, §6 |
| R5 | **Full/Research gain per-activity field scoping**, not just collapsing. `full_record`'s flat operation section becomes activity-scoped for **visibility** (requiredness already is). Slice E carries a data-model change, not GUI-only. | §4-B, D14, §8 |
| R6 | **Irrigation amount-kind bound to plot.** mm vs m³/ha resolved from the plot's irrigation-method (plot-static context, D3); the farmer sees one field, never a pick. | §4, D3 |
| R7 | **Crop-cycle edge cases, now normative:** variety-change-in-one-drilling = two cycles from the start (disambiguation prompts show variety, not just crop); permanent grassland / perennials get an "assign crop" action that opens a cycle **without a fake seeding event** (or are scoped out as static plot metadata); void-harvest-after-reseed and void-seeding-after-freeze both get collision checks/warnings; harvest on an intercropped plot must name which cycle it closes. | §6 |
| R8 | **Agronomy adds folded in (Slice F):** structured **BBCH growth-stage** attribute (replaces free-text, which §4.1 bans as load-bearing); manual **weather-at-application** fields (wind/temp/humidity) for plant protection on sensor-less plots; **tank-mix** — multiple products in one spray pass via the existing pass mechanism (P8). New `attr.growth_stage_bbch`, weather attrs, and a per-pass product model land in the Slice F plan. | §5.2, §8 |
| R9 | **Minor:** dedicated `lysimeter_reading` activity (don't overload `sampling`; keeps SoilManageR export typing clean); per-attribute stepper `step` in the catalog (P6: depth ±1 cm, slurry ±5 m³/ha); group-creation surfaces each plot's replicate/treatment so trial-block collisions are visible. | catalog, §7 |
