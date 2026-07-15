# Field Journal — Program Map + Slice 1 (Edge Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the reviewed field-journal design (spec v2) Slice 1: SQLite schema + catalog, the pure `osi-journal` module (validation, units, cascade, transaction lifecycle, context snapshot), authenticated REST routes, and the durable sync contract on the edge.

**Architecture:** One generic entry + typed-values model (farmOS pattern) with catalog-as-data (vocab/templates/layouts/products), a pure Node module doing all logic with thin Node-RED glue (osi-history-router pattern), whole-aggregate sync through the existing `sync_outbox`/pending-commands fabric with an atomic durable-record contract.

**Tech Stack:** SQLite (edge), Node.js ≥18 pure modules (no deps), Node-RED function nodes bound via `libs`, JSON-Schema sync contracts, repo verifier suite.

**Shipped correction (2026-07-15):** Slice 1 uses migrations `0018`–`0021`. Migration `0018` creates 13 tables, `0019` contains generated catalog v1, `0020` adds plot/group owner scope, and `0021` adds the canonical plot-first time/duplicate/sticky indexes. The task steps below use those final identifiers.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-12-field-journal-design.md` (v2). UX addendum U1–U5/P1–P9 and the Agroscope layout doc are companions.
- **REQUIRED SKILLS while executing:** `osi-schema-change-control` (before touching any SQL/schema file), `osi-flows-json-editing` (before touching flows.json — flows.json is edited ONLY via one-shot Node scripts, never by hand or text tools).
- Migration `0018` is DDL; catalog rows live in generated, idempotent migration `0019`; additive migrations `0020` and `0021` complete resource scope and plot lookup indexes. First line of every migration declares its risk class. Never edit a shipped migration.
- Both profiles (`bcm2712` canonical, `bcm2709` mirror) byte-identical for every shipped file; `node scripts/verify-profile-parity.js` must pass after every task that touches `conf/`.
- No journal DDL in the frozen `sync-init-fn` boot node.
- All timestamps stored as UTC `YYYY-MM-DDTHH:MM:SS.sssZ`.
- Uppercase sync names only: commands `UPSERT_JOURNAL_ENTRY`, `VOID_JOURNAL_ENTRY`, `UPSERT_JOURNAL_CUSTOM_VOCAB`, `UPSERT_JOURNAL_PLOT`, `UPSERT_JOURNAL_PLOT_GROUP`; aggregate types `JOURNAL_ENTRY`, `JOURNAL_VOCAB`, `JOURNAL_PLOT`, `JOURNAL_PLOT_GROUP`; event ops `JOURNAL_ENTRY_UPSERTED`, `JOURNAL_ENTRY_VOIDED`, `JOURNAL_VOCAB_UPSERTED`, `JOURNAL_PLOT_UPSERTED`, `JOURNAL_PLOT_GROUP_UPSERTED`.
- Plot-first anchoring (spec D10/D11): entries carry `plot_uuid` + `batch_uuid`; `journal_plots` registry with `UNIQUE(gateway_device_eui, plot_code)` and `station_code`; dynamic resolvable `journal_plot_groups` (+members) are **layout-homogeneous** (all member plots share one `journal_plot_settings.layout_code` — validated on create/edit); zone-backed plots auto-provision on first journal use; layout binding keys on `plot_uuid`; routes include `/api/journal/plots` and `/api/journal/plot-groups` (incl. resolve/un-resolve).
- Hard limits (server-level, template constraints may only be stricter): request 256 KiB, note 4000 chars, author_label 120, text value 4096 bytes, ≤128 values, ≤32 groups, context 64 KiB, aggregate 256 KiB.
- Commit per task: `feat(journal): <task summary>` on a fresh branch `feat/field-journal-slice1` off `main`. Do NOT branch off `feat/extract-history-router`.

---

## Program map (Slices 2–5 — each gets its own plan doc when scheduled; spec §11)

| Slice | Scope (spec §11) | Hard gates it must meet (spec §9) | Depends on |
|---|---|---|---|
| 2 — edge UI | U1 picker + honest save states + safe carry-forward + repeater/confirmation strip + Drafts queue + timeline + chart markers + layout-transition review + locale contract | Save-failure & rejected-draft recovery; layout-switch invalidation; locale coverage CI; marker density 0/1/50/500; ≤5-activation SLA at 320×568 | Slice 1 routes/catalog |
| 3 — cloud read | Postgres mirror + idempotent ingestion + resource watermarks + snapshot worker/reconciliation + cloud read UI + canonical research package | Equal-version hash rules; intact-edge→empty-cloud reconstruction under concurrent mutation | Slice 1 contract |
| 4 — cloud write | Capability-aware leasing, durable local command handling, exact replay, "Waiting for farm" tray, custom-field + farm-product creation | Old-edge leasing mismatch; poll→restart→lease-expiry recovery; rejected-payload preservation | Slices 1+3 |
| 5 — ADAPT exporter | Pinned 1.0.0 artifacts, OSI semantic profile, reference graph + conversions, linter + negative fixtures | Pinned hashes; semantic linter; negative mutations | Slice 1 only (parallel-safe) |

---

# Slice 1 tasks

## File structure (created/modified by this slice)

- `database/migrations/ordered/0018__field_journal.sql` — 13 journal tables plus initial indexes
- `database/migrations/ordered/0019__journal_catalog_v1.sql` — generated catalog data v1
- `database/migrations/ordered/0020__journal_resource_owner_scope.sql` — private owner scope for plots and plot groups
- `database/migrations/ordered/0021__journal_plot_lookup_indexes.sql` — canonical plot-first time, duplicate, and sticky indexes
- `scripts/generate-journal-catalog.js` — deterministic `0019` generator (reads core catalog def + Agroscope `catalog.json`)
- `scripts/journal-catalog-core.js` — hand-written core catalog definition (activities, attributes, units, templates, layouts, products)
- `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, bundled `farming.db` copies — change-control registration
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/{index.js,catalog.js,units.js,cascade.js,aggregate.js,lifecycle.js,context.js,index.test.js,package.json}` (+ bcm2709 mirror) — the pure module
- `conf/.../osi-lib/index.js` (both profiles) — `NAME_TO_PATH` entry
- `conf/.../srv/node-red/package.json` (both profiles) — `"osi-journal": "file:/usr/share/node-red/osi-journal"`
- `deploy.sh` — module deploy section
- `conf/.../usr/share/flows.json` (both profiles, via one-shot script) — `journal-api-router-fn` + command apply + bootstrap advertisement
- `docs/contracts/sync-schema/{commands,events,resources}.schema.json` — journal definitions
- `scripts/test-journal-schema.js`, `scripts/test-journal-lifecycle.js`, `scripts/test-journal-perf-fixture.js` — new test entry points
- `.github/workflows/field-journal.yml` — CI

### Task 1: Migration 0018 — schema

**Files:** Create `database/migrations/ordered/0018__field_journal.sql`; Modify `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql` (append same DDL), bundled DBs per `osi-schema-change-control`; Test: existing verifiers.

**Interfaces — Produces:** the 13 tables exactly as spec §4.1–§4.7 defines them; later tasks depend on these column names verbatim.

- [ ] **Step 1: read the `osi-schema-change-control` skill**, then write the failing check: `node scripts/verify-migrations.js` currently knows nothing of `0018` — run it to record the clean baseline. Expected: PASS (baseline).
- [ ] **Step 2: write `0018__field_journal.sql`** — complete DDL:

```sql
-- risk: additive
-- 0018: Field journal core schema (spec docs/superpowers/specs/2026-07-12-field-journal-design.md §4)

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_uuid TEXT UNIQUE NOT NULL,
  owner_user_uuid TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  author_principal_uuid TEXT NOT NULL,
  author_label TEXT,
  plot_uuid TEXT,
  zone_id INTEGER,
  zone_uuid TEXT,
  device_eui TEXT,
  season_uuid TEXT,
  season_crop TEXT,
  season_variety TEXT,
  campaign_uuid TEXT,
  protocol_code TEXT,
  protocol_version TEXT,
  observation_unit_code TEXT,
  pass_uuid TEXT,
  batch_uuid TEXT,
  activity_code TEXT NOT NULL,
  template_code TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  layout_code TEXT NOT NULL,
  layout_version INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL,
  occurred_start TEXT NOT NULL,
  occurred_end TEXT,
  occurred_timezone TEXT NOT NULL,
  occurred_utc_offset_minutes INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('edge-ui','cloud-ui')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','voided')),
  voided_at TEXT,
  voided_by_principal_uuid TEXT,
  void_reason TEXT,
  note TEXT,
  context_json TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_zone_time
  ON journal_entries(zone_id, occurred_start DESC, entry_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_gateway_time
  ON journal_entries(gateway_device_eui, occurred_start DESC, entry_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_duplicate
  ON journal_entries(zone_id, activity_code, occurred_start, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_sticky
  ON journal_entries(author_principal_uuid, zone_id, recorded_at DESC, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS journal_entry_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid) ON DELETE CASCADE,
  attribute_code TEXT NOT NULL,
  group_index INTEGER NOT NULL DEFAULT 0 CHECK (group_index >= 0),
  value_status TEXT NOT NULL DEFAULT 'observed'
    CHECK (value_status IN ('observed','not_observed','not_applicable','below_detection')),
  value_num REAL,
  value_text TEXT,
  unit_code TEXT,
  entered_value_num REAL,
  entered_unit_code TEXT,
  CHECK ( (value_status = 'observed' AND ((value_num IS NULL) <> (value_text IS NULL)))
       OR (value_status <> 'observed' AND value_num IS NULL AND value_text IS NULL) ),
  UNIQUE (entry_uuid, group_index, attribute_code)
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_values_entry ON journal_entry_values(entry_uuid);

CREATE TABLE IF NOT EXISTS journal_vocab (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('activity','attribute','unit','choice')),
  parent_code TEXT,
  value_type TEXT CHECK (value_type IN ('number','text','choice','date','boolean')),
  quantity_kind TEXT,
  basis TEXT,
  default_unit_code TEXT,
  labels_json TEXT NOT NULL DEFAULT '{}',
  icon_key TEXT,
  constraints_json TEXT,
  agrovoc_uri TEXT, icasa_code TEXT, adapt_code TEXT,   -- non-authoritative caches
  scope TEXT NOT NULL DEFAULT 'core' CHECK (scope IN ('core','custom')),
  owner_user_uuid TEXT,
  gateway_device_eui TEXT,
  custom_field_uuid TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_vocab_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_code TEXT NOT NULL REFERENCES journal_vocab(code),
  scheme_uri TEXT NOT NULL,
  scheme_version TEXT NOT NULL,
  mapping_role TEXT NOT NULL CHECK (mapping_role IN
    ('concept','variable','coded_value','operation_type','data_type_definition','unit_of_measure')),
  external_id TEXT NOT NULL,
  external_parent_id TEXT,
  mapping_relation TEXT NOT NULL DEFAULT 'exact'
    CHECK (mapping_relation IN ('exact','close','broad','narrow','related')),
  source_uri TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (term_code, scheme_uri, mapping_role, external_id)
);

CREATE TABLE IF NOT EXISTS journal_templates (
  code TEXT NOT NULL,
  version INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  definition_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (code, version)
);

CREATE TABLE IF NOT EXISTS journal_layouts (
  code TEXT NOT NULL,
  version INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  definition_json TEXT NOT NULL,          -- includes option_dependencies + supported_templates
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (code, version)
);

CREATE TABLE IF NOT EXISTS journal_plots (
  plot_uuid TEXT PRIMARY KEY,
  plot_code TEXT NOT NULL,
  name TEXT,
  zone_uuid TEXT,
  station_code TEXT,
  crop_hint TEXT,
  area_m2 REAL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sync_version INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  UNIQUE (gateway_device_eui, plot_code)
);

CREATE TABLE IF NOT EXISTS journal_plot_groups (
  group_uuid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  gateway_device_eui TEXT,
  created_by_principal_uuid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  resolved_by_principal_uuid TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_plot_group_members (
  group_uuid TEXT NOT NULL REFERENCES journal_plot_groups(group_uuid) ON DELETE CASCADE,
  plot_uuid TEXT NOT NULL REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  PRIMARY KEY (group_uuid, plot_uuid)
);

CREATE TABLE IF NOT EXISTS journal_plot_settings (
  plot_uuid TEXT PRIMARY KEY REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  layout_code TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_principal_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_products (
  product_uuid TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'core' CHECK (scope IN ('core','farm')),
  owner_user_uuid TEXT,
  gateway_device_eui TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mineral','organic_amendment','plant_protection','other')),
  composition_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_attachments (
  attachment_uuid TEXT PRIMARY KEY,
  entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo')),
  original_filename TEXT,
  mime TEXT,
  size_bytes INTEGER CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (length(sha256) = 64),
  blob_uuid TEXT,
  local_relpath TEXT,
  remote_object_key TEXT,
  transfer_state TEXT NOT NULL DEFAULT 'local_only'
    CHECK (transfer_state IN ('local_only','uploading','uploaded','failed')),
  captured_at TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_attachments_entry ON journal_attachments(entry_uuid, deleted_at);

CREATE TABLE IF NOT EXISTS journal_catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalog_version INTEGER NOT NULL,
  catalog_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 3: register in change control.** Append the identical DDL block to `database/seed-blank.sql`; add the `0018` SHA-256 to `CHECKSUMS.json` (`shasum -a 256 database/migrations/ordered/0018__field_journal.sql`); regenerate every bundled `farming.db` the `osi-schema-change-control` skill lists (repo root, `web/react-gui/`, profile DBs) with the repo's documented regeneration procedure.
- [ ] **Step 4: run the gates.** `node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-no-stray-ddl.js && node scripts/test-deploy-migration-wiring.js`. Expected: all PASS. Fix schemaContract/fingerprint updates the verifiers demand until green.
- [ ] **Step 5: commit** `feat(journal): 0018 field journal schema + change-control registration`.

### Task 2: Catalog v1 — core definition + generated 0019

**Files:** Create `scripts/journal-catalog-core.js`, `scripts/generate-journal-catalog.js`, `database/migrations/ordered/0019__journal_catalog_v1.sql` (generated, committed); Modify CHECKSUMS.json + seed-blank.sql + bundled DBs (same procedure as Task 1); Test: Create `scripts/test-journal-schema.js`.

**Interfaces — Produces:** catalog rows with `catalog_version = 1`; `journal-catalog-core.js` exports `{ activities, attributes, units, choices, templates, layouts, products }` plain objects (the single authoring surface for core catalog content).

- [ ] **Step 1: write the failing test** `scripts/test-journal-schema.js` (node:assert, opens a temp DB, applies seed-blank.sql): asserts (a) 16 activity rows exist matching spec §4.3's list verbatim (`irrigation, fertilization, fertigation, plant_protection_application, weed_control_nonchemical, seeding, planting_transplanting, pruning, crop_care, tillage_soil_work, mowing, harvest, sampling, general_observation, pest_disease_observation, equipment_maintenance`); (b) every numeric attribute has non-null `quantity_kind`, `basis`, `default_unit_code`; (c) 4 layouts (`open_field`, `greenhouse`, `lysimeter`, `agroscope_open_field`) at version 1, each `definition_json` parses and `agroscope_open_field.definition_json.option_dependencies` reproduces the counts from `docs/superpowers/specs/agroscope-open-field/catalog.json` (25 operations, 128 device slots, unit sets per device); (d) `journal_catalog_state.catalog_version = 1`. Run: `node scripts/test-journal-schema.js` → FAIL (no rows).
- [ ] **Step 2: write `journal-catalog-core.js`** — the hand-written core catalog: the 16 activities (icon_key, labels_json en at minimum, sort_order), shared attributes (e.g. `attr.amount` variants per quantity_kind: `area_rate_volume` L/ha·m³/ha, `area_rate_mass` kg/ha·t/ha, `nutrient_rate` kg-N/P₂O₅/K₂O…/ha with `basis:'nutrient'`, `depth_cm`, `count_area`, `duration_min`, `per_plant_volume`), units with `{dimension, basis, to_canonical:{scale,offset}}`, the 3 template definitions, the 3 generic layout definitions with their spec §4.5 minimum fields, and ~10 core products with `composition_json`. Mappings rows (AGROVOC/ICASA/ADAPT role-qualified) for every activity + unit where a mapping exists in the Agroscope catalog's `source`/provenance data.
- [ ] **Step 3: write `generate-journal-catalog.js`**: reads core def + `docs/superpowers/specs/agroscope-open-field/catalog.json`; emits deterministic idempotent SQL (`INSERT OR IGNORE`, fixed ordering, `-- risk: data` header, trailing `INSERT OR REPLACE INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at) …` where catalog_hash = sha256 of the emitted row content). Agroscope mapping: 7 categories → `choice` rows of `attr.agroscope.operation` parented per activity; devices → `choice` rows of `attr.agroscope.device`; cascade + device-unit sets → `option_dependencies` in the layout `definition_json`; quirk handling per layout doc §3 (seed `cleaning_cut→mower`, dedupe `mower`, no-unit devices get no unit family). Run it; commit generated migration `0019`; register it in CHECKSUMS + seed-blank + bundled DBs.
- [ ] **Step 4: run** `node scripts/test-journal-schema.js` → PASS; rerun the Task-1 gate suite → PASS. Regenerating `0019` twice must be byte-identical (determinism check: `node scripts/generate-journal-catalog.js --check`).
- [ ] **Step 5: commit** `feat(journal): catalog v1 (core + agroscope) as generated 0019 data migration`.

### Task 3: `osi-journal` module — catalog access + entry validation

**Files:** Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/{package.json,index.js,catalog.js,index.test.js}` (+ byte-identical bcm2709 mirror); Modify `osi-lib/index.js` NAME_TO_PATH (+ mirror), `files/srv/node-red/package.json` (+ mirror), `deploy.sh`.

**Interfaces — Produces:**
```js
// catalog.js
loadCatalog(db) -> { version, hash, vocabByCode, templates, layouts, products }  // cached per version
// index.js
validateEntry(catalog, layoutDef, templateDef, entryInput) -> { ok: true, normalized } | { ok: false, errors: [{field, code, message}] }
```
`entryInput` is the REST/command payload shape: `{ entry_uuid, zone_uuid, activity_code, template_code, layout_code, occurred_start_local, occurred_timezone, values: [{attribute_code, group_index, value, unit_code, value_status}], note, … }`.

- [ ] **Step 1: failing tests** in `index.test.js` (node:assert, in-memory catalog fixture built from a temp DB seeded by seed-blank.sql): unknown activity_code rejected; choice value not in vocabulary rejected; required-by-template field missing rejected; `constraints_json` min/max enforced; note > 4000 chars rejected with code `limit_exceeded`; >32 groups rejected; valid farmer_quick irrigation entry returns `ok:true` with normalized values. Run `node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js` → FAIL.
- [ ] **Step 2: implement** `catalog.js` (single query per table, build code-indexed maps, memoize on `journal_catalog_state.catalog_version`) and `validateEntry` (type checks per `value_type`, choice membership, constraints_json, template required/`required_if`/`visible_if` predicate evaluation — predicates are `{field, op:'eq'|'in', value}` objects, no eval — plus the SEC-3 hard limits table from Global Constraints). Run tests → PASS.
- [ ] **Step 3: register the module** exactly like `osi-history-router`: NAME_TO_PATH `'osi-journal': '/usr/share/node-red/osi-journal'` (both profiles), runtime package.json dependency `"osi-journal": "file:/usr/share/node-red/osi-journal"` (both profiles), deploy.sh helper-module section. Run `node scripts/verify-profile-parity.js` → PASS.
- [ ] **Step 4: commit** `feat(journal): osi-journal module — catalog loader + entry validation`.

### Task 4: units engine (quantity_kind/basis, entered→canonical)

**Files:** Create `osi-journal/units.js` (+ mirror); extend `index.test.js`.

**Interfaces — Produces:**
```js
// units.js
convertToCanonical(catalog, attribute_code, entered_value_num, entered_unit_code)
  -> { ok:true, value_num, unit_code } | { ok:false, code:'unit_incompatible'|'cross_basis_forbidden' }
allowedUnits(catalog, attribute_code, layoutDef, selections) -> [unit_code]   // device-scoped via cascade (Task 5 wires selections)
```

- [ ] **Step 1: failing tests**: t/ha → kg/ha scales ×1000; kg/ha entered for a `nutrient_rate` attribute with `basis:'nutrient'` when the attribute expects product basis → `cross_basis_forbidden`; L/ha valid for `area_rate_volume` but rejected for `depth_cm`; entered value/unit preserved in normalized output alongside canonical. Run → FAIL.
- [ ] **Step 2: implement** using each unit row's `{dimension, basis, to_canonical}` from catalog; an attribute's allowed family = units matching its `quantity_kind`+`basis`. Wire into `validateEntry` so numeric observed values always emerge with `{value_num, unit_code, entered_value_num, entered_unit_code}`. Run → PASS.
- [ ] **Step 3: commit** `feat(journal): quantity-kind/basis unit engine with entered-value audit`.

### Task 5: cascade engine (`option_dependencies`)

**Files:** Create `osi-journal/cascade.js` (+ mirror); extend `index.test.js`.

**Interfaces — Produces:**
```js
// cascade.js
resolveOptions(layoutDef, selections) -> { [attribute_code]: { choices:[...], units:[...] } }
validateSelections(layoutDef, values) -> { ok:true } | { ok:false, errors:[{field, code:'invalid_under_dependency'}] }
```
`option_dependencies` format (in layout `definition_json`): `[{ when:{attribute_code, equals}, restrict:{attribute_code, choices?:[], units?:[] } }]`.

- [ ] **Step 1: failing tests** against the seeded `agroscope_open_field` layout: selecting operation `mineral_fertilization` restricts `attr.agroscope.device` to its 6 devices; selecting device `solid_broadcast` restricts amount units to the 10 nutrient units; a device valid only under a different operation → `invalid_under_dependency`; devices with empty unit sets (e.g. `combine_harvester`) make the amount optional. Run → FAIL.
- [ ] **Step 2: implement** (pure filtering over the dependency list; `validateSelections` re-derives the allowed sets from the submitted values in dependency order and rejects any value outside them) and wire into `validateEntry`. Run → PASS.
- [ ] **Step 3: commit** `feat(journal): layout option_dependencies cascade engine`.

### Task 6: canonical aggregate + hashing

**Files:** Create `osi-journal/aggregate.js` (+ mirror); extend `index.test.js`.

**Interfaces — Produces:**
```js
buildAggregate(entryRow, valueRows) -> aggregateObj      // values canonical-sorted by (group_index, attribute_code)
aggregateHash(aggregateObj) -> sha256hex                 // stable stringify, sorted keys
```

- [ ] **Step 1: failing tests**: same values in different insert order hash identically; changing one value changes the hash; aggregate > 256 KiB rejected (`aggregate_too_large`); aggregate round-trips JSON.parse(JSON.stringify(x)) unchanged. Run → FAIL.
- [ ] **Step 2: implement** (recursive sorted-key stringify — reuse the canonicalization rules in `docs/contracts/sync-schema/canonicalization.md`), run → PASS, **commit** `feat(journal): canonical aggregate serialization + hashing`.

### Task 7: transaction lifecycle (draft/final/correction/void)

**Files:** Create `osi-journal/lifecycle.js` (+ mirror), `scripts/test-journal-lifecycle.js`.

**Interfaces — Produces:**
```js
// lifecycle.js — all take the osi-db-helper handle; every mutation runs inside BEGIN IMMEDIATE
saveDraft(db, catalog, input, principal)      -> { entry_uuid, sync_version }
finalize(db, catalog, input, principal)       -> { entry_uuid, sync_version, outbox_event_uuid }
finalizeBatch(db, catalog, input, plot_uuids, principal)   // one transaction, N entries sharing batch_uuid,
  -> { batch_uuid, entries: [{ entry_uuid, plot_uuid, sync_version, outbox_event_uuid }] }  // N aggregates; ≤100 plots; all-or-nothing
void_(db, catalog, entry_uuid, base_sync_version, reason, principal) -> { sync_version, outbox_event_uuid }
// finalize/correction contract: create requires base 0; update requires current == base; edge assigns base+1;
// full ordered value-set replacement; season resolution+freeze; context snapshot; ONE outbox aggregate row —
// all before COMMIT. Command-originated calls additionally pass {command_id, effect_key} and lifecycle writes
// applied_commands terminal result + command_ack_outbox row inside the same transaction.
```

- [ ] **Step 1: failing tests** in `scripts/test-journal-lifecycle.js` (temp DB from seed-blank.sql): `finalizeBatch` over plots [2,5,6,10,12] creates 5 independent entries sharing one `batch_uuid`, 5 outbox aggregates, each with `sync_version` 1 — and rolls back all 5 on injected failure at entry 4; batch of 101 plots rejected (`batch_too_large`); finalize inserts entry+values+outbox row atomically (`aggregate_type='JOURNAL_ENTRY'`, op `JOURNAL_ENTRY_UPSERTED`, payload = Task-6 aggregate); stale base version → rejected, nothing written; correction emits a new aggregate with version+1; void preserves values and emits `JOURNAL_ENTRY_VOIDED`; **crash simulation**: throw injected between value write and outbox insert → transaction rolls back, DB unchanged; season freeze picks the `zone_seasons` row covering `occurred_start`; UTC handling — local input `2026-03-29T02:30` Europe/Zurich (DST gap) rejected. Run → FAIL.
- [ ] **Step 2: implement** on `osi-db-helper`'s serialized BEGIN IMMEDIATE transaction API. Run → PASS.
- [ ] **Step 3: commit** `feat(journal): atomic entry lifecycle with outbox aggregates`.

### Task 8: context snapshot v1

**Files:** Create `osi-journal/context.js` (+ mirror); extend `scripts/test-journal-lifecycle.js`.

**Interfaces — Produces:** `buildContext(db, zoneRow, occurredStartUtc, occurredEndUtc) -> contextObj` — schema v1 per spec §4.8: per-channel `{value, unit, source_device, observed_at, statistic, window, sample_count, coverage, age_s}` for swt_1/2/3 (kPa), rain 24h (interval deltas), temp/RH, valve state (from events/actuation expectations); NULL+reason for stale/uncovered; called inside the finalize transaction; absence never blocks finalization.

- [ ] **Step 1: failing tests**: zone with no sensor data → every channel `{value:null, reason:'no_data'}` and finalize still succeeds; SWT reading 15 days old with 24h freshness threshold → `{value:null, reason:'stale', observed_at:…}`; rain window with no samples → null-with-reason, **not 0**; backdated occurred_start pulls historical rollups at that instant. Run → FAIL.
- [ ] **Step 2: implement** reading the same rollup/`device_data` sources the history API uses (reuse query shapes from `osi-history-helper`; do not duplicate aggregation math — import where exported). Run → PASS. **Commit** `feat(journal): provenance-rich context snapshot v1`.

### Task 9: sync contract schemas + parity

**Files:** Modify `docs/contracts/sync-schema/commands.schema.json`, `events.schema.json`, `resources.schema.json`; extend fixtures used by `scripts/test-contract-schemas.js` and `scripts/verify-sync-op-parity.js`.

**Interfaces — Produces:** five closed-enum, gateway-scoped commands with conditional payload schemas: `UPSERT_JOURNAL_ENTRY`, `VOID_JOURNAL_ENTRY`, `UPSERT_JOURNAL_CUSTOM_VOCAB`, `UPSERT_JOURNAL_PLOT`, and `UPSERT_JOURNAL_PLOT_GROUP`. `device_eui` remains mandatory for device commands and is not required for these five. The event set is `JOURNAL_ENTRY_UPSERTED`, `JOURNAL_ENTRY_VOIDED`, `JOURNAL_VOCAB_UPSERTED`, `JOURNAL_PLOT_UPSERTED`, and `JOURNAL_PLOT_GROUP_UPSERTED`. Resources and watermark keys are `JOURNAL_ENTRY → entry_uuid`, `JOURNAL_VOCAB → custom_field_uuid`, `JOURNAL_PLOT → plot_uuid`, and `JOURNAL_PLOT_GROUP → group_uuid`; every event binds its version to `payload.sync_version`. `effect-keys.md` defines the four effect-key families `journal_entry`, `journal_vocab`, `journal_plot`, and `journal_plot_group`, each ending in the originator's `base_sync_version`. `verify-sync-contract.js` pins these exact command and event semantic bindings.

- [ ] **Step 1: failing tests**: add fixtures — a valid `UPSERT_JOURNAL_ENTRY` command payload must validate; the same payload with `result:'APPLIED'` replay rules covered by verify-sync-op-parity fixture. Run `node scripts/test-contract-schemas.js && node scripts/verify-sync-op-parity.js` → FAIL.
- [ ] **Step 2: edit the three schema files** (conditional `device_eui`: keep required for device commands via `allOf/if/then`, exempt `*_JOURNAL_*`), add fixtures, rerun → PASS. Also run `node scripts/verify-sync-contract.js` → PASS.
- [ ] **Step 3: commit** `feat(journal): sync contract — journal commands, events, resources`.

### Task 10: REST routes in flows.json (one-shot script)

**Files:** Create `scripts/migrate-flows-journal-routes.js` (one-shot, follows the roundtrip-guard pattern in `osi-flows-json-editing`); Modify both `flows.json` profiles via the script only; extend `scripts/test-flows-wiring.js` expectations.

**Interfaces — Produces:** `journal-api-router-fn` has the sole Node-RED binding `libs: [{var:'osiLib',module:'osi-lib'}]`; it loads `osi-db-helper` and `osi-journal` through checked `osiLib.require(...)` results, returns 503 if either helper is unavailable, and delegates to `osiJournal.handleHttpRequest`. HTTP wiring covers catalog GET; entries GET/POST and item PUT/void POST; custom-vocab POST/item PUT; plots GET/POST/item PUT (including zone auto-provisioning); plot-groups GET/POST/item PUT; and GET exports for CSV, research package, JSON, and the ADAPT 501 stub. Bearer auth resolves the owner from the token; missing auth returns 401 and cross-owner resources return 404.

- [ ] **Step 1: read the `osi-flows-json-editing` skill.** Extend `scripts/test-flows-wiring.js` with expectations for the new node/routes (node exists, libs bound, routes wired in both profiles). Run → FAIL.
- [ ] **Step 2: write + run the one-shot script** (JSON parse → mutate → roundtrip-guard → write both profiles). The `func` body checks both helper loads, returns 503 if either is unavailable, and delegates to `osiJournal.handleHttpRequest`; routing and auth remain in the module. Run wiring tests + `node scripts/verify-profile-parity.js` → PASS.
- [ ] **Step 3: route-level tests**: add `scripts/test-journal-api.js` coverage for missing-token 401, foreign-resource 404, oversize-body 413, CRUD round trips, all plot/group ownership paths, and streamed exports. Run it with the wiring gate → PASS.
- [ ] **Step 4: commit** `feat(journal): edge REST routes with auth + limits`.

### Task 11: command apply path + exact-replay dedupe fix

**Files:** Extend the one-shot flows script (new `scripts/migrate-flows-journal-commands.js`); Modify both profiles; add `scripts/test-journal-command-path.js` coverage and wiring assertions.

**Interfaces — Produces:** pending-command handling for all five journal command types (`UPSERT_JOURNAL_ENTRY`, `VOID_JOURNAL_ENTRY`, `UPSERT_JOURNAL_CUSTOM_VOCAB`, `UPSERT_JOURNAL_PLOT`, `UPSERT_JOURNAL_PLOT_GROUP`) through the same `osi-journal` validation/mutation paths as REST; durable `REJECTED_PERMANENT/unsupported_command_type` ACKs for unknown journal subtypes; and shared-ledger deduplication that replays the exact stored terminal result (result, detail, applied version, effect key, and payload hash) instead of reclassifying it as APPLIED. The dedupe correction benefits every command type.

- [ ] **Step 1: failing tests**: cover accepted mutations for all five journal commands; apply `UPSERT_JOURNAL_ENTRY` → entry present + `applied_commands` terminal row + `command_ack_outbox` row all present (atomic — crash-injection between them must roll back all); **replay of a pre-seeded `REJECTED_PERMANENT` ledger row with no ACK row regenerates the same NACK, never APPLIED**; stale base version → NACK with current version/hash. Run → FAIL.
- [ ] **Step 2: implement** via the flows one-shot script (command router branch + dedupe-node fix). The dedupe fix changes shared behavior: run the full existing suite `node scripts/verify-sync-flow.js && node scripts/verify-command-safety.js` to prove no regression for existing command types. → PASS.
- [ ] **Step 3: commit** `feat(journal): command apply path; fix dedupe to replay exact stored results`.

### Task 12: bootstrap capability + catalog advertisement + feature flag

**Files:** One-shot flows script extension (`scripts/migrate-flows-journal-bootstrap.js`); Modify both profiles; extend bootstrap behavior and wiring tests.

**Interfaces — Produces:** normal and forced bootstrap advertise `field_journal_v1` only after all 12 journal readiness tables exist and catalog row `id=1` has a positive safe-integer version plus a lowercase 64-hex hash. Ready payloads carry `journal_catalog_version`, `journal_catalog_hash`, and `journal_manifest` with `version: 1`, `entries_count`, `custom_vocab_count`, `plots_count`, `plot_groups_count`, `resource_watermark_hash`, and `hash_scope: 'sorted aggregate_type\0aggregate_key\0sync_version tuples'`. The hash covers sorted journal aggregate-type/key/version tuples and distinguishes states with equal version sums. Any missing or malformed readiness fact suppresses the full journal advertisement while core bootstrap continues. `/api/system/features` returns `fieldJournalUxEnabled: false`; this flag controls UI visibility only, so reads, exports, sync, and ACKs remain active.

- [ ] **Step 1: add failing normal/forced bootstrap behavior tests and wiring assertions** for readiness, exact catalog facts, manifest counts/hash, fail-closed omission, feature response, and both profiles. Run → FAIL.
- [ ] **Step 2: implement via the one-shot script**, then run `node scripts/test-journal-bootstrap.js`, `node scripts/test-flows-wiring.js`, profile parity, and `node scripts/verify-sync-flow.js` → PASS.
- [ ] **Step 3: commit** `feat(journal): capability/catalog advertisement + fieldJournalUxEnabled flag`.

### Task 13: performance fixture + query-plan pinning

**Files:** Create `scripts/test-journal-perf-fixture.js`.

- [ ] **Step 1: write the test**: generate 10k entries / 150k values in a temp DB; assert `EXPLAIN QUERY PLAN` for five query shapes (legacy zone+time range, plot-scoped duplicate guard, plot-scoped sticky layout, gateway range, canonical plot+time list) each uses its intended index (`SEARCH … USING INDEX idx_journal_entries_…`). Migration `0018` supplies the legacy zone/gateway indexes; migration `0021` supplies the canonical plot duplicate/sticky/time indexes. Also assert a keyset-paged list of 50 completes under 100 ms and streamed CSV of 10k entries stays below 64 MiB RSS growth. Run → PASS expected when both migrations' indexes are correct; a failure is a real finding, so fix the owning index and never weaken the assertion.
- [ ] **Step 2: commit** `test(journal): 10k/150k perf fixture with pinned query plans`.

### Task 14: CI + full-suite gate

**Files:** Create `.github/workflows/field-journal.yml` with read-only permissions, checkout credentials disabled, and Node 22. Its authoritative run-step inventory is the complete command list in the workflow itself, not a duplicated subset in this plan; the current workflow covers both module mirrors, schema, lifecycle, API, command path, sync-contract registry, contract edge cases, command ledger, bootstrap, read-snapshot, catalog generator test/check, performance, and profile parity. Finish with every additional local gate named in Tasks 1–13.

- [ ] **Step 1: write the workflow** (mirror the structure of `.github/workflows/history-router.yml`).
- [ ] **Step 2: full suite locally** — run every command from `.github/workflows/field-journal.yml`, the complete Task-1 gate list, `node scripts/verify-sync-flow.js`, and the wiring/communication/op-parity gates. Expected: all exit 0. Record outputs.
- [ ] **Step 3: commit** `ci(journal): field-journal workflow`, then request review per `superpowers:requesting-code-review`.

## Self-review record

- **Spec coverage:** §4.1–4.8 → Tasks 1–2; §5.1 → 10; §5.2 → 7; §5.3 → 9; §5.4 → 11; §5.5 → 12 (snapshot *worker* is Slice 3 — manifest only here, per spec §11); §6 → Slice 2; §7 → 3/4/10; §8 package/JSON → 10 (ADAPT → Slice 5); §9 gates → 1/7/11/13/14; §10 flag → 12. No gaps in Slice-1 scope.
- **Placeholder scan:** clean — every step names files, code or exact commands, and expected outcomes. The two flows one-shot scripts are specified by pattern + contract because the skill (`osi-flows-json-editing`) mandates their structure; their observable behavior is fully pinned by the failing tests written first.
- **Type consistency:** module function names (`loadCatalog`, `validateEntry`, `convertToCanonical`, `resolveOptions`, `buildAggregate`, `aggregateHash`, `saveDraft`, `finalize`, `void_`, `buildContext`) used consistently across Tasks 3–11.
