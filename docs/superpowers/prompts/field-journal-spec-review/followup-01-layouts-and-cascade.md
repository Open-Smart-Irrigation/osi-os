# Follow-up Review Prompt (Phase 2) — Layouts, Cascading Options, and the Agroscope Open-Field Integration

You are the same **orchestrator** consultant from `prompt.md` (Phase 1). This is a second review phase. Same rules: you do not implement; you spawn specialists, verify their findings yourself before accepting, and synthesize a prioritized report. Run this **after** Phase 1, or concurrently if you keep the outputs separate.

Repo context: `/home/phil/Repos/osi-os`

## Why this phase exists

Phase 1 reviewed the journal design in the abstract. Since then, one concrete, demanding layout has been fully specified from a real research instrument: the **SoilManageR / Agroscope open-field** template. Integrating it stress-tests the layout engine (parent spec decision D8) and surfaces a capability the parent spec does not yet express: **dependent / cascading options** — where the valid choices for one field depend on the value selected in another.

Your job in Phase 2: decide **how best to integrate this specific layout**, and — more importantly — **what the general, correct approach is** for dependent options and deep layout taxonomies across the whole journal, as **both a data-model problem and a UX problem**. Treat the two as equally load-bearing. A data model that is clean but produces a 4-dropdown drill-down no farmer will complete is a failed design; a slick UX that cannot round-trip to SoilManageR or carry standard codes is also a failed design.

## Read first (orchestrator)

New material (the subject of this phase):
1. `docs/superpowers/specs/2026-07-12-agroscope-open-field-layout-design.md` — the layout design + mapping + the dependent-options finding in its §5
2. `docs/superpowers/specs/agroscope-open-field/catalog.json` — the complete, faithful machine-readable duplication of the template (7 categories → 25 operations → 82 unique devices → 19 units; crops, product suggestions, treatment factors, row-fields, and 26 recorded source quirks)
3. `docs/superpowers/specs/agroscope-open-field/SoilManageR_mgmt_data_template_V2.6.xlsx` — the original instrument. **Inspect it directly** (unzip the .xlsx; read `xl/worksheets/`, the `Choice_list` sheet, and the data-validation `INDIRECT()` rules). Do not take the extraction on faith — verify the catalog faithfully represents the source, and flag any option, dependency, or field the extraction missed or distorted.

4. `docs/superpowers/specs/2026-07-12-field-journal-ux-addendum.md` — the product owner's UX position, written after the layout design. Its §2 decisions (U1–U5) are **adjudicated** — challenge them only with the same higher bar as D1–D9. Its §3 proposals (P1–P9) are exactly what this phase must pressure-test.

Re-read from Phase 1:
5. Parent spec `docs/superpowers/specs/2026-07-12-field-journal-design.md`, especially §4.2 (values + `group_index`), §4.3–4.5 (vocab / templates / layouts), §6.1–6.2b (UX + layouts×templates composition), §7 (validation), §8 (export).

Grounding (consistency, not review): `AGENTS.md`, the existing React GUI under `web/react-gui/src/`, and the i18n setup.

Do not use production access. Do not modify any repo file except your report.

## The core problem, stated precisely

The SoilManageR operation is a **4-level dependent cascade**: `category → operation → device → unit(s)`, plus a numeric `value`, plus optional context fields. Options at each level are constrained by the parent choice. 82 devices and 25 operations exist. **Settled since this prompt was first drafted:** the Agroscope layout is **researcher-only** (UX addendum U4) — no farmer-quick collapse logic is needed *for this layout*. The general problem remains: other layouts (generic open field, greenhouse) serve both audiences and still need the depth-pruning rule, and even researchers must not be condemned to four nested dropdowns per entry.

The layout design proposes (its §5) putting the cascade in the layout's `definition_json` (keeping shared vocab flat) plus device-scoped unit sets, and using the journal's repeatable `group_index` values to record multi-nutrient fertilization (N+P+K) in one entry. These are proposals to pressure-test, not settled decisions.

## Track A — Data model / architecture

Assign to the **distributed-systems/embedded designer** and the **data-standards expert**, with the orchestrator adjudicating. Questions:

1. **Where does the cascade live?** Compare, with a recommendation: (a) layout `definition_json` option-dependency map; (b) `depends_on_code`/`depends_on_value` fields on `journal_vocab` choice rows; (c) a dedicated option-dependency table; (d) a hybrid. Judge each against: keeping shared vocab reusable across layouts, sync payload size, edge SQLite query cost, i18n, custom-field interaction, and the fact that this particular tree is Agroscope-specific (greenhouse/lysimeter layouts will have different trees).
2. **Device-scoped units.** Is "valid units depend on selected device" best expressed in the same mechanism as A1, or separately? What happens on edit when the device changes and the old unit is now invalid?
3. **Multi-nutrient via `group_index`.** Verify the parent spec's value model (§4.2) actually supports {120 kg N/ha, 30 kg P2O5/ha, …} in one entry, and that export can flatten it back to SoilManageR's one-value-per-row without loss. Name the failure cases.
4. **Standard-code granularity.** SoilManageR terms carry AGROVOC/KTBL/NRCS/Mohler/Blanchy provenance per operation and device. Does the parent spec's per-term `agrovoc_uri`/`icasa_code`/`adapt_code` (§4.3) attach at the right nodes, or do operation- and device-level codes need distinct homes? What does a faithful **export back to SoilManageR** (CSV matching its columns, or its R package's expected input) require that the current export design (§8) lacks?
5. **Round-trip & versioning.** SoilManageR is versioned (this is v2.6, with a change history). How should the layout seed track upstream template versions, and what happens to old entries when the template updates (renamed/removed devices)?
6. **Quirk handling.** Review the 26 recorded source quirks (`catalog.json.quirks`) and the layout doc §3 decisions (e.g. seeding `cleaning_cut → mower`, de-duping `mower`). Are those the right calls, or should the seed mirror the source's flaws for fidelity and fix upstream?
7. **Product registry (adjudicated U5 — design it, don't debate it).** v1 must support product-first fertilization entry: a product registry with nutrient composition (N/P₂O₅/K₂O/…; DMC/C/N for organic amendments) from which nutrient rates are derived, alongside direct nutrient-rate entry. Recommend the storage shape (vocab `kind='product'` vs. dedicated table), how derived values carry provenance (entered vs. computed), how farm-specific products (their slurry analysis) coexist with shipped defaults, and how this maps to SoilManageR's `product`/`DMC`/`C_content`/`N_content` columns and its default-values behavior.

## Track B — UX (the emphasis of this phase)

Assign to the **field-mobile UX expert**, the **agronomist**, and the **agronomic researcher**. Questions:

1. **Deep-cascade entry pattern.** The picker model is adjudicated (U1: smart shortlist of leaf pairs + type-ahead search + guided tree as fallback; U2: type-ahead with localized synonym index; U3: labelled ranking sections). Your job is to **stress-test and concretize** it, not reopen it: shortlist size and composition, cold-start behavior, synonym-index curation workflow and cost, search behavior for researchers vs. farmers, and where the model breaks (ambiguous leaves, near-duplicate devices like the two cultivator/sweeps variants). Benchmark against **ODK/XLSForm cascading selects, KoboToolbox, farmOS, PhenoApps Field Book, CGIAR AgroFIMS** — say where U1 is weaker than what they do and how to fix it within the model.
2. **Depth-pruning rule for dual-audience layouts.** Agroscope is researcher-only (U4), but generic open-field and greenhouse layouts serve both audiences. Evaluate proposal P3 (template depth = termination level + defaulting) as the general rule: does it hold for those layouts, and for researchers who still deserve speed (does `research_observation` get the shortlist too, with the full path made explicit)? Define the exact rule text for parent spec §6.2b.
3. **Defaults, carry-forward, speed.** Pressure-test proposals P2 (confirm-by-reading sentence strip), P4 (two-class prefill: hollow chips for consequential fields, solid for cosmetic), P5 (units as fixed suffix / segmented toggle / nutrient repeater — never a 19-item dropdown), and P6 (steppers with per-attribute increments). Where do they fail — long sentences on small screens, prefill-class ambiguity (is depth consequential in a tillage-intensity study?), stepper increments for exotic units?
4. **Multi-nutrient repeater + product-first entry UX.** Design the interaction for both adjudicated modes (U5): product + rate with derived nutrients shown live, and direct nutrient rates via the chip repeater (P5). How does the user see and trust the derivation? What happens when the product is not in the registry mid-entry?
5. **Layout binding.** Evaluate P1 (layout is a zone property set at zone setup, passive badge on entry, no daily switcher) against the parent spec's per-entry stickiness (§4.5, §6.2b). Failure cases to check: one physical zone hosting both ordinary farming and a trial; a zone converted mid-season; a researcher visiting many zones. If P1 survives, write the exact replacement text for §4.5/§6.2b; if not, name the concrete counterexample.
6. **Treatment/plot fields.** How should plot/replicate/treatment factors (layout doc §4.4) be captured — per entry, or set once per zone/session — so researchers get clean replicate structure? (Farmers never see this layout — U4 — so optimize purely for researcher throughput, e.g. repeated entries across plots of the same trial.)
7. **Two-phase entry & system-initiated drafts.** Evaluate P7 (capture-in-field → enrich-at-desk queue, splitting work across people) and P9 (auto-drafted entries from `actuator_log`/`irrigation_events`). For P9: proposal fatigue, wrong-attribution risk (valve ran but irrigation failed), and whether it belongs in v1 or fast-follow.
8. **General principle.** Derive the reusable UX rule for *any* future layout with a deep taxonomy (greenhouse, lysimeter), so this is solved once, not per layout.

## Track C — Generalization

Orchestrator-led synthesis: from the specific integration, state the **general approach** OSI should adopt for layouts + dependent options + audience-scoped depth, such that greenhouse and lysimeter layouts (and researcher custom trees) drop in without re-litigating the mechanism. Name what must change in the parent spec §4.3–4.5 and §6.2b, and whether decision D8 (layouts) and D4 (templates/custom fields) survive intact, need revision, or need merging. Fold the UX addendum into this synthesis: for each proposal P1–P9, give a verdict (`adopt` / `adopt with changes` / `reject`, with the concrete change or counterexample), and confirm the adjudicated U1–U5 are implementable as stated or name what blocks them.

## Deliverables (write to `docs/superpowers/prompts/field-journal-spec-review/report-phase2.md` and return as final message)

1. **Executive verdict** — is the Agroscope layout integrable under the current design with additive changes, or does it force a parent-spec revision? One paragraph, one headline risk.
2. **Extraction fidelity check** — does `catalog.json` faithfully match the .xlsx? List any missed/distorted options, dependencies, or fields, with cell references.
3. **Dependent-options decision** — a single recommended mechanism (Track A1–A2) with the rejected alternatives and why, and the exact parent-spec change to adopt it.
4. **Cascade UX recommendation** — the concretized U1 picker (Track B1–B3), a wireframe-in-words of the researcher entry flow for an Agroscope operation including product-first fertilization (Track B4), the exact depth-pruning rule text (Track B2), and P1–P9 verdicts (Track C).
5. **Agroscope integration plan** — concrete steps to add `agroscope_open_field` (seed shape, vocab rows, dependency map, export-to-SoilManageR path), sequenced against the parent spec's slices (§11), with the round-trip/versioning and quirk decisions resolved.
6. **General layout-engine guidance** — the reusable approach (Track C) and the precise parent-spec edits.
7. **Findings by severity** — Blockers/Majors/Minors in the Phase-1 finding schema, attributed to specialists.
8. **Open questions for Phil / for Agroscope** — only decision-blocking ones (e.g. quirks to raise upstream). Already settled — do not re-ask: Agroscope layout is researcher-only (U4); product-first fertilization is in v1 (U5); type-ahead is the search mechanism (U2); ranking must be labelled (U3).

## Rules

- Verify the .xlsx yourself; do not trust the extraction blindly. Cite sheet/cell/named-range references.
- Weigh data model and UX as co-equal. A recommendation that solves one and breaks the other is not a recommendation.
- Preserve edge-canonical sync, the "vocabulary evolution = data change" principle, and machine-readability/standard-code fidelity. Faithful SoilManageR round-trip is a hard requirement for this layout's research value — treat loss of it as a Blocker.
- Prefer additive changes to the parent spec; if you propose reworking D4/D8, name the concrete failure that forces it and the evidence that would make you reverse the call.
- Farmer-facing use of the Agroscope layout is out of scope (U4) — do not design for that user. But do not let that leak into the *general* mechanism: other layouts serve both audiences.
- Keep specific-integration findings and general-approach findings clearly separated so Phil can adopt one without the other.
