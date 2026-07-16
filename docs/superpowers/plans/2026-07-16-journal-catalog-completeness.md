# Field Journal — catalog completeness: findings and remediation

**Date:** 2026-07-16
**Status:** findings recorded; remediation needs one decision (label sourcing) before it can be task-decomposed
**Scope:** OSI OS edge catalog data (`journal_vocab`, `journal_templates`, `journal_layouts`, `journal_products`)
**Trigger:** independent review of the Slice 2 autonomous run (`design-sync/agrolink`, commits `f651b0ec..6c6fc453`)

The Slice 2 GUI is being built correctly against the Slice 1 contract. These findings are
about the **catalog data Slice 1 seeded**, which the GUI cannot fix and which the Slice 2
run will not notice: its tests use synthetic fixtures, so the features pass green while the
shipped catalog gives them nothing to work with.

## Evidence

Probed by loading `database/seed-blank.sql` into a temp SQLite database and calling
`journal.loadScopedCatalog(db, principal, { includeDefinitions: true })`.

| Check | Result |
|---|---|
| Core products | 10 |
| Products with a non-empty `composition_json` | **0** (all `{}`, no parse errors) |
| Products of kind `mineral` | **0** (9 `organic_amendment`, 1 `plant_protection`) |
| Vocab rows | 266, labels present for **`en` only** |
| Templates / layouts | 3 / 4, labels **`en` only** |
| Locales the GUI ships | 7 (`en`, `de-CH`, `fr`, `it`, `es`, `pt`, `lg`) |

## F1 — Product compositions are empty; no mineral product exists

The Slice 1 plan (`2026-07-12-field-journal-slice1.md`, line 299) required "~10 core
products with `composition_json`". Ten products shipped; every composition is the column
default `{}`.

**Impact.** U5 product-first entry derives nutrient rates from the frozen composition
(spec §4.6: "derived nutrient rates are computed at display/export boundaries from the
frozen composition"). Against the shipped catalog every product derives nothing, so the
Phase 3 nutrient repeater renders empty for every product a farmer can pick, and the
SoilManageR export’s derived rates (§8) are empty. No mineral product exists at all, so
the canonical U5 case — a mineral fertiliser entered as product + rate, yielding N/P₂O₅/K₂O
— has neither product nor composition.

**Why this is time-sensitive.** Spec §4.6 makes composition **immutable after first use**;
corrections require a new product version row. Populating it today is a data migration.
After one farm logs a fertilisation against those products, it becomes a versioning
exercise with live references. **Fix before the journal reaches a farm.**

## F2 — Catalog labels exist in English only

All 266 vocab rows, 3 templates, and 4 layouts carry `{"en": …}` and nothing else, against
7 shipped locales: roughly 1,640 missing labels.

Product decision (2026-07-16): labels must exist in **all supported languages**; an English
fallback is not accepted, even though spec §6.4 permits "an explicit visible English
fallback".

**Constraint that blocks a purely automated fix.** Spec §6.4: *"AGROVOC labels are
curation candidates, not auto-approved copy; native/agronomic review required for de-CH,
fr, and lg."* These are agronomic terms entering a farm record intended to support
compliance profiles later. A wrong translation is a real-world hazard, not a cosmetic bug
— the de-CH distinction between *Gülle* and *Mist*, or plant-protection terminology,
cannot be machine-translated and shipped as "reviewed labels". An agent may draft; a native
agronomic reviewer must approve de-CH, fr, and lg before those labels ship.

**Decision needed before task decomposition:** where do the translations come from, and who
signs off de-CH / fr / lg? Options: (a) Agroscope-supplied terminology per language;
(b) AGROVOC-derived drafts (the catalog already carries `journal_vocab_mappings` with
AGROVOC URIs) plus native review; (c) draft in-house, review by a named speaker per
language. Until this is answered, F2 cannot be planned into executable tasks without
violating §6.4.

## F3 — Minor: the Phase 0 gate cannot fail on an empty payload

`scripts/test-journal-api.js` asserts the full catalog variant with
`assert.ok(template.definition && typeof template.definition === 'object')`. An empty `{}`
satisfies that. If `labels_json` were ever dropped upstream of `catalogDto`, definitions
would silently return empty and the gate would stay green — on the exact payload Phase 0
exists to deliver.

Real values are healthy today (`farmer_quick.definition` has 3 keys,
`agroscope_open_field.definition` has 6), so this is a regression-detection gap, not a
live defect. Strengthen with a non-emptiness assertion, for example
`assert.ok(Object.keys(template.definition).length > 0)` and an `en` label check.

## F4 — Question: `full_record` declares no `carry_forward`

Shipped definitions: `farmer_quick.carry_forward = ["attr.operator","attr.equipment","attr.method"]`;
`full_record` and `research_observation` declare none.

`research_observation` having none is correct — P3 requires the full explicit path with no
silent defaults. `full_record` is ambiguous. Spec §6.1 states the low-risk carry rule
generally ("Low-risk fields (operator, equipment, method) carry by default with visible
prefill marking"), not scoped to `farmer_quick`, so a Full-record user currently re-types
operator, equipment, and method on every entry. Intended rigour, or a seed omission?

Note this is not a safety problem: because the catalog only ever lists cosmetic codes,
carry-forward is **fail-closed** — protected plant-protection fields are never offered for
automatic carry, and the GUI’s protected-code set is defence in depth on top. That part of
the design is sound.

## Remediation outline

One additive, idempotent catalog data migration (`0022__journal_catalog_completeness.sql`)
under `osi-schema-change-control`, plus its verifier updates. Never edit a shipped
migration; `0019` stays as-is.

- **Part A — products (F1).** Populate `composition_json` for the 10 core products with
  SoilManageR-shaped facts (`DMC`, `C_content`, `N_content` for organic amendments;
  nutrient fractions for mineral). Add at least one mineral fertiliser so the canonical U5
  path is demonstrable. Sourcing: Agroscope reference values. Gate: a test asserting every
  active core product has a non-empty composition and that a known product derives the
  expected N rate at a known application rate.
- **Part B — labels (F2).** Populate `labels_json` for 266 vocab + 3 templates + 4 layouts
  across the 6 missing locales, **after the sourcing decision**, with a native-review gate
  for de-CH / fr / lg. Gate: a locale-parity test asserting every active catalog row has a
  non-empty label for every shipped locale (the GUI already has a seven-locale parity test
  for its own namespace files — mirror that shape for catalog rows).
- **Part C — F3/F4.** Strengthen the Phase 0 assertion; add `carry_forward` to
  `full_record` if F4 is confirmed as an omission.

Parts A and C are specifiable now. Part B waits on the sourcing decision.

## What the Slice 2 run got right

Recorded because it bears on trust in the run’s output: sol caught that the accepted Phase 1
plan’s client contract was wrong (create/void return receipts, not aggregates; `status` is
required; plot collections are wrapped; plot groups expose `members`), and the Phase 0
deviation — `catalog.js` pre-parses rows, so the light response must delete the parsed
fields rather than the raw ones — was a defect in the accepted plan that the run diagnosed
and fixed correctly. The Task 11 hard stop caught a genuine AGR-7 safety defect: a broad
`attr.amount_*` prefix classified every amount as protected, suppressing shipped
non-protected fields; the fix replaced the heuristic with an explicit protected-code set.
Independent re-verification at review time: edge 45/45, both profile modules identical,
GUI TypeScript clean, 222/223 journal tests green (the single failure was the live
in-flight Task 11 red, since resolved).
