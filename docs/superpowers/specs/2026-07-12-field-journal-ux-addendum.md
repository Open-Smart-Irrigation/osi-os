# Field Journal — UX Addendum: Entry Interaction, Cascades, and Picker Design

**Date:** 2026-07-12
**Status:** Consolidated 2026-07-12 — U1–U5 settled; P1–P9 adjudicated in §4 below during the Phase-1 review consolidation (the Phase-2 review was never run; its questions were decided autonomously per product-owner instruction). Normative contracts live in the parent spec v2.
**Parent spec:** [2026-07-12-field-journal-design.md](2026-07-12-field-journal-design.md) (§6 UX)
**Trigger:** the Agroscope open-field layout ([design](2026-07-12-agroscope-open-field-layout-design.md)) surfaced deep dependent cascades (category → operation → device → unit) as a general UX problem, not a per-layout one.

## 1. Guiding reframes

1. **The cascade is a classification problem, not a navigation problem.** The user knows what they did; the taxonomy exists so the *system* can classify it. The tree is the data model — it should almost never be the interface.
2. **Usage is brutally skewed.** A farm performs the same ~8–12 operation·device pairs all season out of 128 possible. The primary surface is a personalized shortlist; the full tree is long-tail fallback.
3. **OSI can initiate entries.** `actuator_log` / `irrigation_events` / sensors already know when irrigation or rain happened. The journal proposes prefilled drafts ("Valve Zone North ran 45 min yesterday — log it?"); the human confirms. The most common entry type approaches zero typing.

## 2. Adjudicated UX decisions (settled 2026-07-12)

| # | Decision | Detail |
|---|---|---|
| U1 | **Picker model: smart shortlist + search; guided tree as fallback** | Entry opens on a card grid of *leaf* choices (operation·device pairs) ranked by plot recents → season likelihood when the plot links a zone → layout defaults. Type-ahead search over flattened labelled paths below. "Browse all…" opens a guided one-level-per-screen tree (ODK-style) — the fallback and cold-start mode, never the default. A sentence-builder ("mad-libs") input was rejected for i18n grammar cost; its *output* is kept as the confirmation strip (P2). |
| U2 | **Type-ahead is the search mechanism** | Search matches localized labels **and a curated synonym index** per language ("Gülle" → `liquid_organic_broadcast`; AGROVOC labels as the base layer, colloquialisms curated on top). Synonym curation is a v1 deliverable for shipped vocab, per-language. |
| U3 | **Ranking must be transparent** | Shortlist sections are visibly labelled ("Recent on this plot", "Common this season", "All options") — never an unexplained ranking, or trust in the picker dies. |
| U4 | **Agroscope open-field layout is researcher-only** | No `farmer_quick × agroscope_open_field` combination exists; no cascade-collapse logic is designed for it. Layouts therefore declare which template families they support (`supported_templates` in layout definition). The depth-pruning rule (P3) still applies to layouts that *do* serve both audiences (generic open_field, greenhouse). |
| U6 | **Plot-first anchoring + general Journal entry (added post-consolidation, 2026-07-12)** | Journal is a top-level nav item next to "Data"; its entry flow attributes a plot optionally. Plots (`journal_plots`, unique `plot_code` per gateway) are the canonical land unit; sensor-less fields are first-class plots; zone attribution is derived, optional. No-zone entries: crop + activity suggestions from recent use only, no context snapshot. Desktop = three-pane review/enrichment workspace (spec §6.4); mobile stays the capture surface. |
| U7 | **Multi-plot batch entry + resolvable groups (added 2026-07-12)** | One authoring pass, N database rows: the "Where?" step multi-selects plots (numbered grid + range input `2, 5, 6, 10-12` for stations like a 72-lysimeter facility); finalize fans out to one independent entry per plot sharing a `batch_uuid` (spec D11). **Custom-labeled plot groups** ("Barley 2026") select a recurring cohort in one tap, are layout-homogeneous by rule, editable while active, and **resolved** (archived, reversible) when done — offered automatically after a harvest batch covering the whole group. Pickers never render a station as a long list — one collapsible row expanding to a grid. |
| U5 | **Product-first fertilization entry is designed in from v1** | Farmers think in product terms ("300 kg/ha of 27.5 % N"); SoilManageR and research exports need nutrient rates. v1 stores the product registry in `journal_products`, including nutrient composition (N/P₂O₅/K₂O/… per unit of product and DMC/C/N for organic amendments). Entry supports product + application rate or direct nutrient rates. Composition-derived values are computed for display and export from the frozen product facts; they are not duplicated as stored derived values. |

## 3. Proposal record (resolved in §4)

**P1 — Layout is a plot property, not a daily switch.** Bind layout at plot setup, change it in plot settings, and show it as a passive badge on the entry screen. This removes the two-dimensional daily switcher while keeping sensor-zone attribution optional. Template remains the only routine depth control.

**P2 — Confirm-by-reading strip.** Before save, one generated journal sentence — "Slurry (drag hose) · 25 m³/ha · Plot P-07 · Open field · today" — every token tappable to edit. This is what makes carry-forward safe: prefills are *read* in one glance, not buried in collapsed sections.

**P3 — Template depth rule (one rule for all layouts).** Template depth = *termination level + defaulting*: `farmer_quick` picks shortlist leaves with device auto-resolved (zone equipment profile / last-used; visible in the sentence, editable under "details"); `full_record` adds all context fields; `research_observation` requires the full explicit path, no silent device defaults, treatment/plot fields shown.

**P4 — Two-class prefill rule.** Consequential-if-wrong fields (product, dose) prefill as *hollow* chips requiring a confirming tap; cosmetic-if-wrong fields (depth, machine) prefill solid. One visual rule everywhere.

**P5 — Units are structurally unmistakable.** Single-unit devices: unit is a fixed suffix inside the number field. Two-unit devices: segmented toggle. Mineral fertilization: no unit picker at all — a nutrient chip repeater `[+N] [+P₂O₅] [+K₂O] [⋯]`, each adding a value field with fixed suffix (backed by `group_index`, parent §4.2).

**P6 — Steppers over keyboards.** Numeric entry via large steppers with per-attribute increments anchored on last value (depth ±1 cm, slurry ±5 m³/ha); keyboard fallback. Gloves-friendly; anchoring doubles as plausibility check.

**P7 — Two-phase entry: capture in field, enrich at desk.** Skeleton entry (<10 s, phone, `draft`) → "needs completion" queue for evening/desktop enrichment (DMC, C-content, comments, treatment factors). Splits across people too: farmer captures, researcher enriches the same entry. Uses existing draft/final status; adds a queue view.

**P8 — Passes, not rows, for combined operations.** "Add another operation to this pass" creates linked entries sharing date/plot, rendered as one stacked timeline card; SoilManageR's `combination` integer falls out at export.

**P9 — System-initiated drafts.** Auto-draft journal entries from `actuator_log`/`irrigation_events` (and later rain events), surfaced as "log this?" proposals. OSI's unique advantage; candidate for v1-slice-2 or fast-follow — cost/benefit to be weighed in planning.

## 4. Proposal verdicts (consolidation, 2026-07-12)

| P | Verdict | Notes |
|---|---|---|
| P1 layout = plot property | **Adopted** | `journal_plot_settings` binds `layout_code` to `plot_uuid`; no `journal_zone_settings` table exists. First use requires an explicit choice, `open_field` is never a silent default, per-entry override remains allowed, and layout changes trigger the UX-3 review sheet (parent §6.2). |
| P2 confirm-by-reading strip | **Adopted** | Also carries the STD-1 requirement: interpreted value + unit repeated before finalization; plot + layout shown. |
| P3 template depth rule | **Adopted** | With UX-3 transition semantics and the separate "Detail level" / "Growing setting" controls. |
| P4 two-class prefill | **Adopted, strengthened by AGR-7** | Plant-protection product/authorization/target/dose/area/waiting-period are never silently carried — explicit "Repeat last treatment" confirmation card; carry-forward source must match season/layout and precede the occurrence time. |
| P5 unit ergonomics | **Adopted** | Backed by the STD-1 quantity_kind/basis model; entered value/unit stored for audit. |
| P6 steppers | **Adopted** | Plus locale decimal input (STD-1). |
| P7 capture→enrich queue | **Adopted** | The Drafts resume/discard queue also satisfies UX-4's honest-save requirements. |
| P8 passes | **Adopted** | Entry-level `pass_uuid`; SoilManageR `combination` integers derived at export. |
| P9 system-initiated drafts | **Deferred to fast-follow after Slice 2** | The schema hook (`actuation_expectation_id` on irrigation amounts, STD-1) lands in Slice 1 so proposals need no migration. Wrong-attribution risk (valve ran, irrigation failed) and proposal fatigue to be designed with field evidence. |

## 5. Parent-spec impact (applied in parent spec v2, 2026-07-12)

- §4.4/§4.5: layouts gain `supported_templates` (U4); `journal_plot_settings.plot_uuid` carries layout binding (P1).
- §4.3/§4.6: `journal_products` is the stored registry; composition-derived nutrient values are computed for display/export (U5).
- §6.1–6.2b: replace the segmented template×layout switching text with U1/P1–P3; add prefill classes (P4), unit rules (P5), confirmation strip (P2).
- §6.3: timeline pass-cards (P8); "needs completion" queue (P7).
- §11: synonym-index curation (U2) lands in Slice 1 seeds; system-initiated drafts (P9) scheduled in planning.
