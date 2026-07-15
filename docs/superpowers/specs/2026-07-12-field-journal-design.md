# Field Journal / Activity Tracker — Design

**Date:** 2026-07-12 (v2; Slice 1 contract corrected 2026-07-15 after PR #141 review)
**Status:** Slice 1 edge contract implemented; later slices remain staged in §11
**Scope:** OSI OS (edge) + OSI Server (cloud)
**Companion docs:** [UX addendum](2026-07-12-field-journal-ux-addendum.md) (U1–U5 adjudicated, P1–P9 adopted per its §5) · [Agroscope open-field layout](2026-07-12-agroscope-open-field-layout-design.md)

## 1. Purpose

A standardized, machine-readable activity tracker / field journal for the OSI ecosystem, serving three jobs from day one on a single shared data model:

1. **Ground truth for sensor data** — entries (irrigation, pruning, fertilization, harvest, observations) explain what happened in the field so sensor curves and analytics (dendro v6, RDI) can be interpreted.
2. **Detailed farm record** — structured farm records per plot, with optional derived zone attribution, designed to support named compliance profiles later. v1 `full_record` is a **detailed record, not a certified ÖLN record or export**; any compliance-oriented requiredness and retention are explicit profile rules, never implied by the template name.
3. **Research data collection** — structured observations with standardized variables, campaign/protocol identity, and researcher-defined custom fields.

Goals: **standardized terms**, **input robustness**, **machine readability**, **reproducibility** — every final entry pins its occurrence instant, crop season where known, catalog/template/layout semantics, entered and canonical units, and the provenance needed to interpret it later — and a UX suitable for both farmers and agronomic researchers, with **switchable templates** (audience depth) and **layouts** (agronomic setting) that together determine which choices and options the form surfaces.

## 2. Research grounding

| Source | What we take |
|---|---|
| **farmOS log model** | Generic event ("log") core + typed quantity rows; small activity-type set; free text never load-bearing |
| **ICASA Data Dictionary** | Researcher-grade variable codes; role-qualified mappings per vocab term |
| **AGROVOC** | Multilingual concept URIs (versioned scheme); curation candidates for labels, not auto-approved farmer copy |
| **AgrO/AgroFIMS** | Annotate at collection time — machine-readable by construction |
| **Field Book (PhenoApps)** | User-defined typed custom fields; templates as data |
| **Spray-record apps** | Carry-forward defaults (safety-gated), select-don't-type, auto-context capture |
| **barto / 365FarmNet** | Swiss farmer expectations; future interchange target |
| **ODK/XLSForm** | Templates as declarative data with validation constraints and cascading selects |
| **ADAPT Standard 1.0.0** | One-way WorkRecord export target (pinned artifacts, semantic profile); role-qualified mapping per vocab term |
| **SoilManageR (Agroscope)** | Real research instrument driving the dependent-options mechanism and the Agroscope open-field layout |

**OSI's unique edge:** the journal lives next to live sensor data — entries freeze provenance-rich sensor context at the time the activity occurred, and render as event markers on existing history charts.

## 3. Adjudicated decisions

| # | Decision | Choice + review guardrails |
|---|---|---|
| D1 | Primary job of v1 | All three jobs; one generic model, template delivery staged. v1 acceptance contract: safe quick entry (farmer), conditional field matrix (detailed record), campaign/observation-unit identity (research). |
| D2 | Entry surface | Edge UI + cloud UI from day one; edge canonical; cloud writes via pending-commands. Cloud writes are capability/catalog gated; a rejected payload remains recoverable until explicit discard. |
| D3 | Vocabulary | Curated OSI vocab shipped as versioned catalog data. Core semantic codes are **immutable after use**; external mappings are role-qualified/versioned (§4.3); custom codes are globally unique and tenant-owned. |
| D4 | Templates | Declarative engine; 3 shipped families; researcher custom fields; **no authoring UI in v1**. The engine supports layout-scoped dependent choices/unit sets and minimal campaign/protocol/observation-unit identity. |
| D5 | Photos | Content-addressed, replica-aware **metadata-ready** schema in v1 (§4.7); no client-supplied filesystem paths; capture UI + resumable blob transport in v2. |
| D6 | Offline depth | Reach Pi or cloud at entry time; no on-phone queue; first-class backdating. The UI must distinguish server-confirmed draft save from volatile unsaved browser state (§6.1). Reopen only on field evidence of material record loss. |
| D7 | Storage model | Generic log + typed values. Typed values preserve entered and canonical quantity/unit, explicit missingness, repeat-group identity, and one deterministic cell per entry/group/attribute. |
| D8 | Layouts | Orthogonal to templates; v1 ships `open_field`, `greenhouse`, `lysimeter`, each with a reviewed minimum attribute/denominator contract and dependency map (§4.5). `orchard_berry_rows` enters v1 only on named-pilot evidence; none named as of 2026-07-12 → open_field documents its denominator representation and accepted limit. |
| D9 | ADAPT export | One-way exporter against **pinned ADAPT Standard 1.0.0 artifacts** and a named OSI semantic profile with semantic + negative-fixture validation (§8). All six operation-type mappings confirmed to exist in ADAPT 1.0. Fallback trigger: the semantic profile cannot be satisfied — not operation-type discovery. Observations excluded from the v1 ADAPT profile as deliberate scope control; ADAPT 1.0 `OBSERVATION_GENERAL` may be enabled later. |
| D10 | Land identity (added 2026-07-12) | **Plots are the canonical land unit** (`journal_plots`, §4.5c): unique `plot_code` per gateway; a plot *may* be backed by a sensor zone (1:1 link), and sensor-less fields are first-class plots. Entries anchor plot-first; zone attribution is optional. **Journal is a top-level nav surface** (next to "Data") with a general entry flow: no zone required; when no zone is linked, crop and activity suggestions come from recent use only (no season/sensor inference) and no context snapshot is captured. |
| D11 | Batch entry / multi-plot fan-out (added 2026-07-12) | One authoring action can target **multiple plots** (e.g. seeding barley on lysimeters 2, 5, 6, 10, 12): the form is filled once, finalization **fans out to one independent `journal_entries` row per plot** — own `entry_uuid`, own `sync_version`, own outbox aggregate — linked by a shared `batch_uuid` for grouping/provenance. Batch finalize is atomic (all N or none, one transaction, N aggregates); batch size ≤ 100. Corrections/voids apply per entry; the UI may offer "apply to all in batch," which executes N independent corrections. Selection scales two ways: **stations** (`station_code`, e.g. a 72-plot lysimeter facility) render as a numbered multi-select grid with range input ("2, 5, 6, 10-12"), never a list; **plot groups** (§4.5d) are custom-labeled, resolvable cohorts ("Barley 2026") selected in one tap, layout-homogeneous by rule, resolved after harvest (offered, never automatic). Exports carry N rows naturally. |

UX decisions U1–U5 (picker model, type-ahead, ranking transparency, Agroscope researcher-only, product-first fertilization) are adjudicated in the [UX addendum](2026-07-12-field-journal-ux-addendum.md) §2. Review open questions Q1–Q6 are resolved in §12.

## 4. Data model (edge SQLite, mirrored to cloud Postgres)

Slice 1 spans ordered migrations `0018`–`0021`, all registered through the full change-control surface (§9, SYS-12). Migration `0018__field_journal.sql` creates the 13 journal tables and initial indexes; `0019__journal_catalog_v1.sql` contains the generated catalog rows; `0020__journal_resource_owner_scope.sql` adds private owner scope to plots and groups; `0021__journal_plot_lookup_indexes.sql` adds the canonical plot-first lookup indexes. Later vocabulary/template/layout/product revisions use new idempotent data migrations or a governed importer. Shipped migrations are never edited.

### 4.1 `journal_entries`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | local rowid |
| `entry_uuid` | TEXT UNIQUE NOT NULL | sync identity |
| `owner_user_uuid` | TEXT NOT NULL | stable sync/access owner; derived from auth, never from request input |
| `user_id` | INTEGER NOT NULL | access owner on edge (`users`); always derived |
| `author_principal_uuid` | TEXT NOT NULL | immutable actor identity |
| `author_label` | TEXT NULL | display-only true-author name (e.g. cloud username) |
| `plot_uuid` | TEXT NULL | canonical land anchor → `journal_plots` (D10); zone-originated entries resolve it automatically; NULL = farm-level |
| `zone_id` / `zone_uuid` | INTEGER/TEXT NULL | optional sensor-zone attribution (derived from the plot's zone link when present) |
| `device_eui` | TEXT NULL | optional device/tree anchor (ownership validated) |
| `season_uuid` | TEXT NULL | resolved from `zone_seasons` at finalization by `occurred_start` and **frozen**; crop (+ variety/stage) snapshotted; explicit crop selection required if no season matches |
| `campaign_uuid` | TEXT NULL | opaque research campaign identity |
| `protocol_code` / `protocol_version` | TEXT NULL | protocol identity + version/hash |
| `observation_unit_code` | TEXT NULL | plot/replicate/tree/vessel/subject identity |
| `pass_uuid` | TEXT NULL | links entries recorded as one field pass (combined operations); exports derive SoilManageR `combination` integers from it |
| `batch_uuid` | TEXT NULL | links entries created by one multi-plot authoring action (D11); orthogonal to `pass_uuid` (pass = different operations, same plot; batch = same operation, many plots) |
| `activity_code` | TEXT NOT NULL | FK `journal_vocab` |
| `template_code` + `template_version` | TEXT + INTEGER NOT NULL | pinned semantics |
| `layout_code` + `layout_version` | TEXT + INTEGER NOT NULL | pinned semantics |
| `catalog_version` | INTEGER NOT NULL | vocab catalog version used |
| `occurred_start` / `occurred_end` | TEXT NOT NULL / NULL | **canonical UTC** `YYYY-MM-DDTHH:MM:SS.sssZ`; `start ≤ end` |
| `occurred_timezone` | TEXT NOT NULL | IANA display timezone snapshot |
| `occurred_utc_offset_minutes` | INTEGER NOT NULL | offset chosen when resolving local input; nonexistent local times rejected, ambiguous times require explicit offset choice |
| `recorded_at` | TEXT NOT NULL | server-stamped UTC |
| `origin` | TEXT NOT NULL | CHECK (`edge-ui`,`cloud-ui`) |
| `status` | TEXT NOT NULL DEFAULT `draft` | CHECK (`draft`,`final`,`voided`) |
| `voided_at` / `voided_by_principal_uuid` / `void_reason` | TEXT NULL | audit state; voided entries retain values/context/attachment metadata |
| `note` | TEXT NULL | free text, never load-bearing, bounded (§7) |
| `context_json` | TEXT NULL | versioned sensor snapshot (§4.8) |
| `sync_version` | INTEGER NOT NULL DEFAULT 0 | optimistic concurrency |
| `gateway_device_eui` | TEXT | standard sync column |
| `created_at` / `updated_at` | TEXT | standard conventions |
| `deleted_at` | TEXT NULL | reserved for an explicit administrative/sync tombstone contract; **v1 has no user hard-delete** — corrections use void |

### 4.2 `journal_entry_values`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `entry_uuid` | TEXT NOT NULL | FK → `journal_entries(entry_uuid)` ON DELETE CASCADE |
| `attribute_code` | TEXT NOT NULL | FK vocab |
| `group_index` | INTEGER NOT NULL DEFAULT 0 | CHECK ≥ 0; stable group ordinal within the aggregate; rows in one group (product+dose, nutrient+value) stay paired |
| `value_status` | TEXT NOT NULL DEFAULT `observed` | CHECK (`observed`,`not_observed`,`not_applicable`,`below_detection`) |
| `value_num` / `value_text` | REAL/TEXT NULL | canonical value; `observed` rows carry exactly one; non-observed rows carry neither |
| `unit_code` | TEXT NULL | canonical unit |
| `entered_value_num` | REAL NULL | original numeric input (audit) |
| `entered_unit_code` | TEXT NULL | unit the user selected |

Constraints/indexes: `UNIQUE(entry_uuid, group_index, attribute_code)`. Canonical entry lookups use `idx_journal_entries_plot_time (plot_uuid, occurred_start DESC, entry_uuid)`, `idx_journal_entries_plot_duplicate (plot_uuid, activity_code, occurred_start, entry_uuid)`, and `idx_journal_entries_plot_sticky (author_principal_uuid, plot_uuid, recorded_at DESC, entry_uuid)`. The zone-first time/duplicate/sticky indexes from `0018` remain for legacy-compatible queries; `idx_journal_entries_gateway_time` and `idx_journal_entry_values_entry (entry_uuid)` cover gateway and value lookups. Keyset pagination and streamed exports are pinned with `EXPLAIN QUERY PLAN` on a 10k-entry/150k-value fixture. Value-side indexes exist only for proven research predicates.

### 4.3 Vocabulary: `journal_vocab` + `journal_vocab_mappings`

`journal_vocab` — versioned catalog data:

| Column | Notes |
|---|---|
| `code` TEXT PK | stable snake_case; core codes; custom codes are `custom.<UUID>` (globally unique, edge/server-generated) |
| `kind` | `activity` \| `attribute` \| `unit` \| `choice` |
| `parent_code` | choices → their attribute |
| `value_type` | attributes: number/text/choice/date/boolean |
| `quantity_kind` / `basis` | numeric attributes and units: dimension (mass/area, volume/area, count/area, depth, total mass, total volume, per-plant amount, concentration, nutrient rate, yield/area, duration…) and basis (product vs nutrient, w/w vs w/v, per-ha vs per-tree/row) |
| `default_unit_code` | canonical storage unit; each numeric attribute names an **allowed unit family** (compatible dimension/basis) |
| `labels_json` | i18n label map (delivery contract §6.4) |
| `icon_key` | activities: identifier from a frontend allowlist |
| `constraints_json` | min/max/step/maxlength |
| `scope` | `core` (seeded) or `custom` |
| `owner_user_uuid` / `gateway_device_eui` / `custom_field_uuid` | custom rows only — tenant = gateway + owner (Q4) |
| `active`, `sort_order`, `sync_version`, `deleted_at` | lifecycle |

**Immutability:** `kind`, `parent_code`, `value_type`, `quantity_kind`, `basis`, `default_unit_code` are immutable after first use in a final entry. Unit rows define compatible dimension/basis and tested scale/offset conversions; cross-basis conversion requires all denominator/formulation facts, else rejected.

**`journal_vocab_mappings`** — role-qualified standard mappings: `(term_code, scheme_uri, scheme_version, mapping_role, external_id, external_parent_id, mapping_relation, source_uri, active)`. Roles: `concept | variable | coded_value | operation_type | data_type_definition | unit_of_measure`; relations: SKOS exact/close/broad/narrow/related. Choice rows map individually. The flat `agrovoc_uri`/`icasa_code`/`adapt_code` columns are retained only as non-authoritative caches.

**Irrigation semantics:** irrigation amounts carry `amount_kind`, `measurement_source`, the applicable denominator, and an optional `actuation_expectation_id` link — a journal entry that annotates an automatic/measured irrigation event references it and must **not** create a second water total.

**v1 activity seed list (final before Slice 1 implementation):** `irrigation`, `fertilization`, `fertigation` (carries both water and nutrient groups), `plant_protection_application` (herbicide/fungicide/insecticide/biological — product+rate always in scope), `weed_control_nonchemical` (method-coded), `seeding`, `planting_transplanting`, `pruning`, `crop_care` (thin/train/tie/de-leaf), `tillage_soil_work`, `mowing`, `harvest`, `sampling` (soil/plant), `general_observation`, `pest_disease_observation`, `equipment_maintenance`. Short farmer-verb labels; localized.

**Catalog delivery:** `journal_catalog_version` is monotonic. Every revision after catalog migration `0019` is a new idempotent ordered data migration or governed importer with cross-repo seed-row hashes; editing an old migration is forbidden. The edge advertises installed catalog version + definition hashes (§5.5).

### 4.4 `journal_templates`

PK **(code, version)** — append-only; old versions retained inactive; entry pins immutable. `definition_json`: sections → fields, required/`required_if`/`visible_if` predicates (deterministic, side-effect-free, enforced by the same edge validator), defaults, carry-forward classes (§6.1). Families: `farmer_quick`, `full_record`, `research_observation`. `full_record` ships an activity/profile matrix of conditionally required facts (product, application date/quantity, treated area, harvest crop/area/yield/unit; operator/equipment/wind/PHI classified operational unless a named profile requires them). No authoring UI in v1.

### 4.5 `journal_layouts` + plot binding

PK **(code, version)** — append-only. `definition_json` contract:

> `option_dependencies` constrain choices or unit sets by earlier field values (e.g. operation → device → allowed units); `required_if`/`visible_if` predicates are deterministic and enforced by the same edge validator. Server validation rejects choices hidden or invalid under the pinned activity/layout/template versions. `supported_templates` lists the template families the layout serves (U4: `agroscope_open_field` is researcher-only).

v1 layout minimums:
- **open_field** — block/bed/row identifier, treated area, cover type, denominator facts. Per-tree/row/canopy denominators are representable via `observation_unit_code` + per-plant quantity kinds; the accepted limit (no dedicated orchard layout) is documented per D8.
- **greenhouse** — structure/compartment, root-zone system (soil/container/substrate/hydroponic), plant/wetted area, drainage/recirculation, EC/pH only when applicable.
- **lysimeter** — experimental unit, replicate/treatment, surface area, interval, water/rain/drainage inputs, mass start/end/tare/method.

The Agroscope open-field layout (separate doc) is the fourth seeded layout; its category→operation→device→unit cascade is expressed with this same `option_dependencies` mechanism (resolved from its §5 proposal).

**Plot binding (P1 adopted, re-anchored by D10):** layout is a **plot** property in `journal_plot_settings` (`plot_uuid` PK, `layout_code`, `updated_at`, `updated_by_principal_uuid`, `sync_version`) — no daily switcher. First use requires an explicit, large layout choice; `open_field` is never a silent default. The entry screen shows the layout as a passive badge; a per-entry override exists for researchers, and any layout change that invalidates in-progress values triggers the review sheet (§6.2b).

### 4.5c `journal_plots` — land registry (D10)

| Column | Notes |
|---|---|
| `plot_uuid` TEXT PK | canonical land identity |
| `plot_code` TEXT NOT NULL | human-readable unique identifier, `UNIQUE (gateway_device_eui, plot_code)` — e.g. `P-07`, `Parzelle II` |
| `name` TEXT NULL | display name |
| `zone_uuid` TEXT NULL | optional 1:1 link to a sensor-equipped irrigation zone |
| `station_code` TEXT NULL | physical station/facility (e.g. `LYS` for a 72-plot lysimeter station); station plots render as a numbered multi-select grid (D11). Static structure — distinct from the dynamic plot groups in §4.5d |
| `crop_hint` TEXT NULL | last-used crop, for no-zone suggestion (recents-only rule) |
| `area_m2` REAL NULL | denominator fact |
| `active`, `sync_version`, `gateway_device_eui`, `created_at`/`updated_at`/`deleted_at` | standard lifecycle |

Rules: every zone gets an auto-provisioned plot on first journal use (1:1, `plot_code` derived from the zone name, editable); sensor-less fields are manually created plots (lightweight CRUD inside the Journal surface — not a zone). Anchoring precedence for an entry: plot → (derived) zone → farm-level. Sensor-context snapshots (§4.8) are captured **only** when the resolved plot links a zone. Carry-forward, shortlist ranking, and duplicate-guard scope key on `plot_uuid`. Plots are operational data, not catalog data: they sync as their own aggregate `JOURNAL_PLOT` with op `JOURNAL_PLOT_UPSERTED` and command `UPSERT_JOURNAL_PLOT`, under the same durability rules as entries (§5).

### 4.5d `journal_plot_groups` — dynamic, resolvable plot cohorts (D11)

A **plot group** is a custom-labeled selection of plots with a lifecycle — e.g. "Barley 2026" = lysimeters 2, 5, 6, 10, 12. It exists so a recurring cohort is selected in one tap for every activity on it, and is **resolved** when its purpose ends (typically after harvest).

| Table | Columns |
|---|---|
| `journal_plot_groups` | `group_uuid` PK, `label` (custom, user-supplied), `gateway_device_eui`, `created_by_principal_uuid`, `created_at`, `resolved_at` NULL, `resolved_by_principal_uuid` NULL, `sync_version`, `deleted_at` |
| `journal_plot_group_members` | `group_uuid`, `plot_uuid`, PK `(group_uuid, plot_uuid)` |

Rules:
- **Layout homogeneity:** all member plots must share one layout (`journal_plot_settings`), validated at creation/edit — a batch form renders under exactly one layout, so a mixed group could not produce a coherent form.
- **Resolve, don't delete:** resolving stamps `resolved_at`; the group disappears from pickers but remains queryable for provenance. Groups are a *selection tool*: entries do not reference the group (their plot anchors + `batch_uuid` + time window carry the same information derivably), so resolving is always safe and reversible (un-resolve clears the stamp).
- **Membership is editable while active** (add/remove plots); a plot may belong to many groups simultaneously (e.g. a crop cohort and an irrigation-treatment cohort).
- **Harvest nudge:** when a batch's activity is `harvest` and its selection covers an entire active group, the confirmation offers "Resolve group '<label>'?" — one tap, never automatic.
- Sync: aggregate `JOURNAL_PLOT_GROUP`, op `JOURNAL_PLOT_GROUP_UPSERTED`, command `UPSERT_JOURNAL_PLOT_GROUP` (same durability rules).

### 4.6 `journal_products` (product registry — U5)

| Column | Notes |
|---|---|
| `product_uuid` TEXT PK | |
| `scope` | `core` (seeded) or `farm` (tenant-owned: `owner_user_uuid` + `gateway_device_eui`) |
| `name`, `kind` | mineral / organic_amendment / plant_protection / other |
| `composition_json` | nutrient fractions (N/P₂O₅/K₂O/…); DMC, C, N content for organic amendments (matches SoilManageR `DMC`/`C_content`/`N_content`) |
| `active`, `sync_version`, `deleted_at`, `created_at` | lifecycle |

Composition is **immutable after first use**; corrections create a new product version row. Entries store the product reference + entered application rate; **derived nutrient rates are computed at display/export boundaries from the frozen composition** — never duplicated into stored values (single source of truth, no drift). Direct nutrient-rate entry (researcher mode) stores values normally. Both paths converge in exports.

### 4.7 `journal_attachments` (metadata-ready; activated v2)

`attachment_uuid` PK; `entry_uuid` FK; `kind` CHECK; `original_filename` display-only; `mime` allowlisted; `size_bytes` bounded non-negative; `sha256` lowercase 64-hex; `blob_uuid` content key; `local_relpath` system-generated, fixed-root, edge-local, non-synced; `remote_object_key`; `transfer_state` CHECK; `captured_at`; `sync_version`; `created_at`; `deleted_at`; index `(entry_uuid, deleted_at)`. No request may supply or receive an absolute filesystem path. v2 blob transfer is a separate authenticated resumable channel (temp → hash/fsync → atomic rename → metadata commit; final hash verification). Blob bytes never enter journal outbox aggregates or bootstrap JSON.

### 4.8 Sensor-context snapshot (`context_json`, schema v1)

Generated inside the successful promotion transaction. Each channel records value, unit, source device/key, `observed_at`, statistic + window, sample_count, coverage/status/quality, and freshness/age. Uncovered or stale data is NULL **with a reason** — absence is never zero. SWT uses canonical `swt_1/2/3` kPa; rain uses valid interval deltas (no duplicate/out-of-order aggregation); plant-protection context includes wind speed/direction/gust when available; historical valve state comes from events/actuation expectations, not current state. Duration activities capture start/end window aggregates. Sensor absence never blocks finalization. Context is recomputed if time/zone/device/duration changes before finalization and frozen only at commit.

## 5. Write paths & sync (durable-record contract)

### 5.1 Route/auth matrix (edge; `osi-journal` pure module + thin flows.json glue)

| Route | Method | Auth |
|---|---|---|
| `/api/journal/catalog` (vocab+templates+layouts+products, versioned) | GET | bearer |
| `/api/journal/entries` (list, keyset-paged) / create | GET/POST | bearer + owner-scoped |
| `/api/journal/entries/:uuid` / `…/void` | PUT/POST | bearer + owner-scoped |
| `/api/journal/custom-vocab` (+ deactivate) | POST/PUT | bearer + owner-scoped |
| `/api/journal/plots` (list/create/update, incl. zone auto-provisioning) | GET/POST/PUT | bearer + owner-scoped |
| `/api/journal/plot-groups` (list/create/update/resolve/un-resolve) | GET/POST/PUT | bearer + owner-scoped |
| `/api/journal/export.csv` · `/export.package` · `/export.json` · `/export.adapt.json` | GET | bearer + owner-scoped |

Bearer auth on **all** journal routes; owner derived from token/owned zone/gateway, never from request `user_id`; device ownership validated; 401 for missing auth, 404 for cross-owner resources; per-route auth/ownership tests.

### 5.2 Atomic edge transaction

draft→final, accepted final→final correction, and final→voided are **complete aggregate mutations**. Under one `BEGIN IMMEDIATE` transaction the edge: validates base version (create requires base 0; update requires current == base), assigns base+1, authoritatively validates and **replaces the complete ordered value set**, computes/freezes context + version pins + season snapshot, writes void state where applicable, inserts one full outbox aggregate — and, when command-originated, stores the exact terminal `applied_commands` result and `command_ack_outbox` row **before COMMIT**. Values are canonical-sorted by (group_index, attribute_code) before hashing.

**Batch fan-out (D11):** a multi-plot finalize runs as **one transaction creating N independent entries** (shared `batch_uuid`, per-plot context snapshots where a zone is linked, N outbox aggregates) — all N or none. Batch size ≤ 100. After creation, each entry lives an independent life (version, correction, void, sync); "apply to all in batch" is sugar for N separate correction transactions.

### 5.3 Sync contract names (uppercase, closed-enum compliant)

Commands: `UPSERT_JOURNAL_ENTRY`, `VOID_JOURNAL_ENTRY`, `UPSERT_JOURNAL_CUSTOM_VOCAB`, `UPSERT_JOURNAL_PLOT`, `UPSERT_JOURNAL_PLOT_GROUP`. Aggregates: `JOURNAL_ENTRY`, `JOURNAL_VOCAB`, `JOURNAL_PLOT`, `JOURNAL_PLOT_GROUP`. Event ops: `JOURNAL_ENTRY_UPSERTED`, `JOURNAL_ENTRY_VOIDED`, `JOURNAL_VOCAB_UPSERTED`, `JOURNAL_PLOT_UPSERTED`, `JOURNAL_PLOT_GROUP_UPSERTED`. Slice 1 extends the edge contract schemas in `docs/contracts/sync-schema/*` and their parity fixtures with conditional payload/resource definitions; the universal `device_eui` requirement is lifted for gateway-scoped commands. Resource watermarks bind `JOURNAL_ENTRY → entry_uuid`, `JOURNAL_VOCAB → custom_field_uuid`, `JOURNAL_PLOT → plot_uuid`, and `JOURNAL_PLOT_GROUP → group_uuid`; each event takes its version from `payload.sync_version`. The cloud schema mirror and ingestion path land with the Slice 3 cloud mirror described in §11. Custom vocab must arrive before dependent entries; missing parent is retryable.

### 5.4 Command apply, dedupe, and mismatch safety

- Unsupported command types receive a durable `REJECTED_PERMANENT / unsupported_command_type` ACK (never silently dropped).
- Terminal ledger result + ACK-outbox insertion are atomic; **dedupe replays the exact stored result** (result, detail, applied version, effect key, payload hash) — a stored rejection can never replay as APPLIED. Crash-state test required (pre-seeded REJECTED_PERMANENT, no ACK row → replay regenerates the same NACK).
- Lease expiry alone must not consume an explicit-failure retry.

### 5.5 Capabilities, catalog negotiation, bootstrap, snapshot

Bootstrap advertises `field_journal_v1` + installed catalog version/definition hashes + a journal manifest; the cloud leases journal commands only to compatible gateways and gates cloud form choices on the target edge's advertised catalog. Because delivered outbox rows prune (~30 days), a **resumable journal snapshot** (custom vocab first, then complete entry aggregates paged by count ≤100 and bytes ≤1 MiB, with snapshot ID, high-water mark, cursor, tombstones/voids, counts, reconciliation hashes) reconstructs an empty/rebuilt cloud mirror exactly, converging with concurrent mutations through ordinary watermarks. Replacement-Pi rehydration from cloud is **not** provided in v1.

### 5.6 Cloud mirror & conflicts

Cloud applies aggregates idempotently: higher version → atomic replace; equal version + same canonical hash → duplicate; equal version + different hash → conflict (surfaced, never silently resolved); lower → stale. Stale writes NACK with current version/hash and **preserve the submitted cloud payload across reloads** in a "Waiting for farm" tray (pending/rejected records excluded from canonical views/exports). The rejection sheet states "Farm record was not changed," retains every field, translates reasons, and offers: view diff (your change vs current edge record), edit & resend (new command/effect key), save as new entry where valid, or explicit discard. Rejected payloads are never auto-deleted.

## 6. UX & templates

Picker model, search, ranking, and product-first entry are governed by the UX addendum (U1–U5, P1–P9 adopted). This section carries the review-hardened contracts.

### 6.1 Entry, saving, carry-forward

- **Entry points:** (a) 56px "Log activity" CTA on each zone card — plot/zone/crop/time preselected; (b) a top-level **Journal** nav item next to "Data" — its New-entry flow attributes a plot optionally (picker offers zone-backed plots, sensor-less plots, or "no plot"); (c) Activity item in the dashboard Add menu. **No-zone rule (D10):** when the entry's plot links no zone, crop and activity suggestions come from recent use on that plot (falling back to farm recents) only — no season/sensor inference — and no context snapshot is captured.
- **Multi-plot selection (D11):** the "Where?" step supports selecting many plots. Station plots render as a numbered grid (tap to toggle) plus a range field accepting `2, 5, 6, 10-12`; select-all/invert per station. **Active plot groups appear as one-tap chips above the grid** ("Barley 2026 · 5") — tapping selects the members, which stay individually editable; any manual multi-selection offers "Save selection as group…" with a custom label. The confirmation strip reads "… on 5 plots (Lys 2, 5, 6, 10, 12)"; Finish fans out per D11. When a harvest batch covers an entire active group, the post-save sheet offers "Resolve group 'Barley 2026'?" (§4.5d). The timeline shows a batch as one grouped card ("Seeding — barley · 5 plots"), expandable to the individual entries.
- **Quick path:** six recent/common activities (2×3 icon+label grid, labelled ranking sections per U3) + More → shortlist/search/browse (U1). **SLA: ≤5 primary-control activations from zone CTA to acknowledged save for a common carried-forward entry** (not every cold entry); tested at 320×568 and 360×640, no horizontal scroll.
- **Honest save states:** `Saving…` / `Saved on farm gateway` / `Saved on OSI Server — waiting for farm gateway` / `Not saved — server unavailable`. Connectivity failure before editing → Retry screen, not an editable form; mid-edit failure → volatile memory only, sticky loss warning + leave-page guard, Finish retries the same entry UUID. Stable draft UUIDs, debounced serialized saves, a Drafts resume/discard queue (also serves two-phase capture→enrich, P7). Timelines/markers/exports/duplicate-guard/analytics default to final-only. No quiet IndexedDB/localStorage persistence.
- **Safe carry-forward (AGR-7):** source must be a compatible final entry at/before the chosen occurrence time, matching season and layout; recalculated on time/layout change. **Plant-protection product/authorization, target, dose/basis, treated area, and waiting period are never silently carried** — an explicit "Repeat last treatment" card shows source date/crop/product/rate and requires confirmation, invalidated on crop/season/layout change. Low-risk fields (operator, equipment, method) carry by default with visible prefill marking (P4).
- **Numeric entry:** locale decimal input, always label+number+unit together; the final confirmation strip (P2) repeats the interpreted value and unit.

### 6.2 Templates × layouts

Separate controls: **"Detail level: Quick | Full | Research"** (template) and **"Growing setting"** (layout — a plot property per §4.5, passive badge, changed in plot settings or explicit per-entry override). Template depth rule (P3): quick picks shortlist leaves with defaults auto-resolved and visible; full shows all in-scope attributes; research requires the full explicit path, no silent defaults, identity/treatment fields shown.

**Transition semantics (UX-3):** template switches retain valid hidden values and expose an "N extra details saved" drawer. Layout changes show a review sheet of now-disallowed activities/choices/values and **block finalization** until the user keeps the old setting, replaces the invalid item, or explicitly removes it. Plot + layout are repeated in the final confirmation strip.

### 6.3 Reading surfaces

- **Timeline:** reverse-chron, final-only default, filterable; pass-linked entries render as one stacked card (P8).
- **History-chart markers:** separate event lane, final-only default; rendered-distance clustering with counts; ≥48px hit targets opening a bottom sheet; activity + Journal on/off filters; icon/shape + color (not color alone); calendar overflow counts. Density tested at 0/1/50/500 events, 320px, 24h and season ranges.

### 6.4 Desktop layout (≥ ~1024px)

The Journal nav surface adapts from the mobile single-column flow to a **three-pane workspace** (this is where the P7 "enrich at desk" phase lives):

- **Left rail — scope & filters:** stations, active plot groups, and ungrouped plots with a search field — the rail lists a 72-plot station as **one collapsible row** ("Lysimeter station · 72"), never 72 items; selecting it opens the numbered plot grid in the center pane. Active groups list with member counts; resolved groups live under an archive toggle. Zone-backed plots show a sensor dot; sensor-less plots listed equally; plot CRUD lives here. Below: activity filter, status filter (Final / Drafts / Waiting for farm), date range, campaign/protocol filter in research contexts.
- **Center — journal table/timeline:** dense rows (date, activity, plot, key values, status chip); pass-linked entries group; sortable; keyset-paged; bulk selection for export.
- **Right — detail / entry panel:** selected entry's read-back sentence, context snapshot, values, void/correct actions — or the New-entry / enrichment form (same template engine as mobile, rendered as a persistent side panel instead of a full-screen flow). The Drafts "needs completion" queue opens here with field-level focus on what's missing.
- Exports (CSV / research package / JSON / ADAPT) sit on the table header, scoped to the active filters.
- Entry ergonomics are shared with mobile (same validation, same confirm-by-reading strip); desktop adds keyboard navigation between table rows and form fields. Mobile remains the primary capture surface; desktop is the primary review/enrichment/export surface.

### 6.5 i18n delivery contract

Every enabled journal term/template/layout/unit, validation message, and save/rejection state has reviewed labels in all enabled locales **or an explicit visible English fallback** — CI-checked key/content coverage with an identical-terms allowlist. `icon_key` comes from vocab data (frontend allowlist); every pictogram pairs with a short action label, never icon-only. AGROVOC labels are curation candidates, not auto-approved copy; native/agronomic review required for de-CH, fr, and lg. Type-ahead synonym index per U2.

## 7. Validation & input robustness

- **One rulebook, two layers:** template/layout-driven client validation + authoritative edge validation from the pinned catalog versions; cloud-origin entries traverse the same edge code path.
- **Quantity/unit contract (STD-1):** every numeric attribute has quantity_kind, basis, canonical unit, allowed unit family; entered value/unit stored alongside canonical; cross-basis conversion only with complete denominator/formulation facts; separate semantics preserved for totals, depths, flows, rates, counts, per-plant amounts, concentrations, nutrient rates, yields.
- **Hard server-side limits (SEC-3), independent of template constraints (which may only be stricter):** request 256 KiB; note 4,000 chars; author label 120; text value 4,096 UTF-8 bytes; ≤128 values, ≤32 groups per entry; context ≤64 KiB; aggregate ≤256 KiB; filename 255 bytes. Oversize → 413 before the transaction. Event batches capped by count and total bytes.
- **Output hardening:** RFC-4180 CSV encoding and formula-neutralization apply to every string cell. A leading apostrophe protects cells whose first non-space/NBSP character is `= + - @` or whose prefix is a tab/carriage return. Safe generated filenames and plain-text rendering apply throughout. Logs carry IDs/codes/lengths only, with no journal text or author names. Author labels are omitted from the default research export, and exact typed source strings remain available in `records.ndjson`.
- **Duplicate guard:** ±60 min per-activity default, scoped per plot (batch siblings on different plots never trip it); runs after activity/time selection and again at finalization; shows the matching entry (time + key values) with "Open existing" / "Save separately"; warns once per draft; Finish disabled while in flight.
- **Batch limits:** ≤ 100 plots per batch; the fan-out transaction respects all aggregate/outbox size caps per entry.
- **Timestamps:** UTC + timezone-snapshot contract per §4.1; Zurich DST gap/fold tested.

## 8. Exports & machine readability

- **Canonical research package** (`export.package`): formula-neutralized `entries.csv`, `values.csv`, and `vocab_mappings.csv`; lossless typed `records.ndjson` containing entry, value, and mapping records; and `manifest.json` with the schema descriptor, record counts, and SHA-256/byte length for every data member. The wide pivot (`export.csv`) uses the same CSV hardening and remains a convenience view, not the lossless source.
- **JSON export:** includes dataset/export UUID, generation + coverage times, source/gateway/farm/zone identifiers, exporter version/commit, schema/catalog/template/layout/context-generator versions and hashes, mapping sources/licenses, unit transformations, record counts, payload checksums. Author identity only per explicit access/pseudonymization policy.
- **SoilManageR export** (Agroscope layout doc): flattens repeat groups and pass links back to the template's one-value-per-row + `combination` format; derived nutrient rates computed from frozen product compositions.
- **ADAPT export:** zone-linked final operational entries against **pinned ADAPT Standard 1.0.0** (root/DTD/unit artifact hashes recorded in the review report §STD-3). Deterministic Catalog Field references, WorkRecords, Operations, Variables, SummaryValues, ACTUAL UTC TimeScopes. No centroid-as-Field (ADAPT Field has no point property); no productIds unless valid Catalog Products are emitted (product text goes to notes/descriptions). CI: schema validation through a root-definition wrapper + semantic linter (allowed codes, DTD units/conversions, resolvable references, UTC, start≤end, profile version) + negative mutation fixtures. No named external consumer exists yet (Q5) — the OSI semantic profile v1 is the acceptance contract; fallback to fast-follow only if that profile cannot be satisfied.

## 9. Testing (verification gates)

- **Durability:** transaction crash points; stale base versions; stored APPLIED/REJECTED replay exactness; equal-version same/different hash; deterministic value ordering; capability/catalog mismatch; old-edge leasing; poll→restart→lease-expiry recovery; intact-edge→empty-cloud snapshot reconstruction under concurrent mutation.
- **Data semantics:** DST gap/fold; unit/basis conversion tables; missingness; repeat-group pairing; unsafe carry-forward; layout-switch invalidation; save-failure and rejected-draft recovery.
- **Performance:** pinned query plans + streamed exports on the 10k/150k fixture.
- **Security:** per-route auth/ownership; body/text limits; PII-safe logs; CSV formula/header/filename hardening.
- **Change control (SYS-12):** `-- risk: additive` header; CHECKSUMS.json + deploy-wiring fixture registration; seed-blank.sql + all bundled farming.db copies (repo root, web/react-gui, five profile DBs); schemaContract/index/query-plan/seed-row-hash checks; sync schema + op parity; outbox-retention classification; profile parity; **no journal DDL in sync-init-fn**.
- **Modules:** `osi-journal` pure-module unit tests (validation, cascade resolution, serialization); flows wiring tests; React component tests (template rendering, transitions, carry-forward, repeater); cloud ingestion idempotency + command roundtrip; ADAPT pinned hashes + linter + negative fixtures; locale coverage; marker density 0/1/50/500.

## 10. Rollout & non-goals

- **Feature flag (Q6):** `fieldJournalUxEnabled` controls **UI visibility only**, defaults false until schema/module/catalog readiness. When false: stored data, authenticated reads/exports, edge→cloud sync, and ACKs continue. No separate writes kill switch in v1; capability/catalog advertisement prevents incompatible command leasing. Rollout gates (kaba100 → Silvan → Uganda): journal outbox pending/rejected/oldest-age, command pending/rejected, last snapshot/reconciliation, installed catalog version, capability mismatch — all non-PII.
- **v1 non-goals:** photo capture/blob sync (schema only), template/layout authoring UI, PWA on-phone offline queue, certified ÖLN export + retention promise (Q1: detailed record only; 7-day completion reminder is a v2 enhancement), ADAPT import/observation profile, barto/cantonal interchange, voice input, BLV product-register ingestion (v2), campaign registry UI (v2 — v1 preserves the identifiers), replacement-Pi rehydration from cloud.

## 11. Delivery staging

1. **Slice 1 — edge core:** migrations `0018`–`0021` through the change-control surface (`0018` creates 13 tables; `0019` carries generated catalog v1; `0020` adds private resource scope; `0021` adds plot-first indexes); unit/quantity + version contracts; catalog seeds (vocab incl. final activity list, templates, 3+1 layouts, core products) + hashes; `osi-journal` module (validation, cascade, transaction lifecycle); REST routes + auth; outbox aggregates; sync-contract schemas + capabilities; bounded snapshot manifest.
2. **Slice 2 — edge UI:** Journal nav surface (mobile flow + desktop three-pane per §6.4), entry flow (U1 picker, save states, safe carry-forward, repeater, confirmation strip), plot CRUD + no-zone entry, Drafts queue, timeline, chart markers, layout-transition review, locale contract, recent-activity personalization.
3. **Slice 3 — cloud read:** mirror tables + idempotent ingestion + resource watermarks; snapshot worker + reconciliation; cloud read UI; canonical research package export.
4. **Slice 4 — cloud write:** capability-aware command leasing, durable local command handling, exact replay results, recoverable rejected drafts ("Waiting for farm" tray), custom-field + farm-product creation.
5. **Slice 5 — ADAPT exporter:** pinned artifacts, OSI semantic profile, reference graph + conversions, linter + negative fixtures. Independent after Slice 1.

No slice is complete merely because its happy-path UI works; each must pass the relevant recovery and mismatch gates in §9.

## 12. Resolved review questions (adjudicated 2026-07-12, autonomous per product-owner instruction)

| Q | Decision |
|---|---|
| Q1 full_record promise | Detailed record, structurally future-ready; **not** certified ÖLN evidence; no 7-day reminder or 6-year retention promise in v1 (v2 enhancement, profile-gated). |
| Q2 orchard/berry pilots | No named v1 pilot records per tree/row/canopy volume; keep three layouts + Agroscope; open_field documents the denominator representation and accepted limit; `orchard_berry_rows` is a v2 seed on pilot evidence. |
| Q3 multiple campaigns per zone | Yes (Agroscope-style trials make this real) → campaign/protocol/observation-unit identity columns land in Slice 1. |
| Q4 custom-vocab tenant | Gateway (farm) + owner user: custom rows carry `gateway_device_eui` + `owner_user_uuid`; codes `custom.<UUID>`. |
| Q5 ADAPT consumer | None named yet → OSI semantic profile v1 (pinned artifacts + linter + negative fixtures) is the acceptance contract; fallback trigger is profile unsatisfiability. |
| Q6 feature flag | `fieldJournalUxEnabled` = UI visibility only; no v1 writes kill switch; compatibility enforced via capability/catalog gating. |
