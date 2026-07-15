# Field Journal / Activity Tracker — Consultant Review

## 1. Executive verdict

**Not ready for implementation, but the architecture is worth keeping.** The generic entry-plus-typed-values model, edge authority, and data-driven vocabulary/template/layout principle are sound. The single biggest risk is the incomplete durable-record contract: an entry, its values, its version, its outbox event, and the command result are not yet specified as one atomic and recoverable unit. As written, a crash, replay, stale cloud edit, or cloud rebuild can lose an entry, diverge the mirror, or falsely report that a rejected record was confirmed. The design should proceed after the Blockers below are incorporated; it does not need a new datastore or a replacement architecture.

_Review basis: working-tree spec docs/superpowers/specs/2026-07-12-field-journal-design.md, SHA-256 1e0eb6f076fefcc65ea7c8d10f5657310bc3b22b4658db6eb3f271dcd7a2ecda. Repo and official standards/legal sources were inspected directly. No production host or live gateway was accessed._

## 2. Decision matrix

| Decision | Verdict | Main risk | Required spec change |
|---|---|---|---|
| D1 — all three jobs, one model | **keep** | A lowest-common-denominator form could satisfy none of the three jobs. | State the minimum v1 acceptance contract for farmer, detailed-record, and research use: safe quick entry; a named conditional field matrix; and campaign/observation-unit identity. |
| D2 — edge and cloud writes, edge canonical | **keep** | Mixed-version commands, stale edits, and rejected cloud drafts can remain pending or be falsely confirmed. | Add capability-gated leasing, transactional apply/ACK semantics, preserved rejected drafts, and lossless edge-to-empty-cloud reconstruction. |
| D3 — curated seeded vocabulary with AGROVOC/ICASA | **revise** | One flat mapping per term, mutable seed semantics, and global custom codes can mis-map or collide. | Keep curated codes, but add role-qualified/versioned mappings, immutable semantic codes, globally unique tenant-owned custom codes, and catalog hashes/version negotiation. |
| D4 — declarative templates/custom fields, no authoring UI | **revise** | Flat custom fields do not express dependent choices, protocol identity, or repeated experimental units. | Keep the declarative engine and no-authoring-UI boundary; add layout-scoped dependency maps, stable research identity fields, explicit missingness, and repeat-group rules. |
| D5 — attachment metadata now, blobs later | **revise** | stored_path and one sync_state do not form a safe future blob contract. | Reserve an opaque blob/storage key, local-versus-remote state, parent FK, sync version/tombstone, hash constraints, and a separate resumable v2 blob transport. |
| D6 — no phone queue; backdating instead | **keep** | “Autosaved” can be false when neither Pi nor cloud is reachable. | Define Saving/Saved/Not saved states, volatile mid-edit recovery and leave-page warning, and time-aware carry-forward. Reopen D6 only if field evidence shows these semantics still cause material record loss. |
| D7 — generic log plus typed values | **keep** | Ambiguous quantity bases, duplicate EAV cells, and unpinned definitions can silently reinterpret records. | Add quantity dimension/basis and entered-unit audit, uniqueness/FKs/indexes, semantic version pins, and atomic full-aggregate replacement. |
| D8 — orthogonal layouts; three v1 layouts | **revise** | The principle is good, but the definitions are too thin and orchard/berry quantities may not fit open_field. | Keep orthogonality. Specify dependency rules and minimum attributes for each layout. Reopen the three-layout list only if a named v1 pilot needs per-tree/row/canopy denominators; otherwise document how open_field represents them and the accepted limit. |
| D9 — scoped ADAPT 1.0 exporter | **revise** | JSON Schema success alone permits wrong units, dangling references, invalid codes, non-UTC dates, and a non-standard Field point. | Keep D9: all six operation types exist in ADAPT 1.0. Pin the 1.0.0 artifacts, define the exact reference graph and conversions, omit centroid-as-Field, and add semantic plus negative-fixture validation. |

No adjudicated decision should be rejected. D8 is the only decision whose v1 option set may need reopening. Evidence that closes it again would be confirmation from every named v1 pilot that no operation is recorded per tree, planted row, or canopy/tree-row volume and that the proposed open-field denominator fields are adequate.

## 3. Findings by severity

### Blockers

#### SYS-1 — Distributed-systems / embedded designer

- **ID:** SYS-1
- **Severity:** Blocker
- **Spec ref:** §5.1–§5.3, §9–§10
- **Claim:** The named journal commands/events are absent from the real sync contract, and the draft has no capability-safe mixed-version path.
- **Evidence:** §5.3 names lowercase dotted commands. The source-of-truth docs/contracts/sync-schema/commands.schema.json accepts an uppercase closed enum, requires device_eui for every command, and disallows extra properties; docs/contracts/sync-schema/events.schema.json and docs/contracts/sync-schema/resources.schema.json contain no journal definitions. The “Reject Indefinite Open” and “Command Type Registry” nodes in conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json drop unknown types, while “Build Cloud Bootstrap” advertises only linked_auth_sync_v1 and force_edge_sync_v1. The sister cloud lease service retries expired leases and terminally NACKs after five attempts at ../osi-server/backend/src/main/java/org/osi/server/command/CommandLeaseService.java.
- **Failure mode / lost value:** A new cloud can lease a journal mutation to an old Pi, which drops it without a durable ACK; an edge event can be rejected as unknown_op; repeated restarts can consume the lease budget without one apply attempt. The UI then remains pending or an edge-saved entry never reaches the mirror.
- **Suggestion:** Specify uppercase contracts: UPSERT_JOURNAL_ENTRY, VOID_JOURNAL_ENTRY, UPSERT_JOURNAL_CUSTOM_VOCAB; aggregates JOURNAL_ENTRY/JOURNAL_VOCAB; and ops JOURNAL_ENTRY_UPSERTED, JOURNAL_ENTRY_VOIDED, JOURNAL_VOCAB_UPSERTED. Add conditional payload/resource definitions, remove the universal device_eui requirement for gateway/entry commands, map journal watermarks by entry_uuid or custom-vocab UUID, update both repo contract copies and parity fixtures, advertise field_journal_v1 plus catalog hashes, and lease only to compatible gateways. Unsupported commands must receive a durable REJECTED_PERMANENT/unsupported_command_type ACK. Persist leased journal commands locally before dispatch or ensure lease expiry alone does not consume an explicit-failure retry.

#### SYS-2 — Distributed-systems / embedded designer

- **ID:** SYS-2
- **Severity:** Blocker
- **Spec ref:** §5.1–§5.4
- **Claim:** The aggregate is not safe unless the edge version check, entry/value mutation, outbox event, command ledger, and ACK row share one SQLite transaction.
- **Evidence:** §5.1 only says “On final save” enqueue an aggregate and §5.4 says writes carry a base sync_version. In conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json, “Build UPDATE SQL” performs unconditional upserts with incoming versions and “Queue REST Command ACK” writes applied_commands and command_ack_outbox separately. conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js already exposes a serialized BEGIN IMMEDIATE transaction. On the cloud, ../osi-server/backend/src/main/java/org/osi/server/sync/SyncEventTxExecutor.java has equal-version/same-hash protection, but EventResourceRef in ../osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java must explicitly map journal ops to the entry rather than the per-event fallback.
- **Failure mode / lost value:** A stale cloud edit can overwrite a newer local correction; a crash can commit values without the event or ledger; a final-entry correction or void can remain edge-only; two events for the same entry/version can be applied under different watermarks.
- **Suggestion:** Define one transaction: read current entry; accept create only with base_sync_version=0 and update only when current.sync_version equals the base; have the edge assign base+1; authoritatively validate and replace the complete ordered value set; compute context; update status/void metadata; insert one full aggregate; and, for cloud commands, insert the terminal applied_commands result and command_ack_outbox row before COMMIT. Emit a new aggregate for draft→final, every accepted final→final correction, and final→voided. In cloud, atomically replace values only for a higher version, treat equal version/same canonical hash as duplicate, equal version/different hash as conflict, and lower version as stale. Canonical-sort values by group_index and attribute_code before hashing.

#### SYS-3 — Distributed-systems / embedded designer

- **ID:** SYS-3
- **Severity:** Blocker
- **Spec ref:** §5.3
- **Claim:** The inherited dedupe path can turn a previously rejected command into an APPLIED acknowledgement.
- **Evidence:** In conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json, “Queue REST Command ACK” stores terminal results including REJECTED_PERMANENT in applied_commands. “Deduplicate Pending Command” reads that result but ignores it and always emits result/status=APPLIED; the ledger and ACK-outbox writes are not atomic.
- **Failure mode / lost value:** A stale or invalid journal command can be rejected, crash before its NACK is queued, then replay as APPLIED. The cloud reports confirmed custody although the edge never accepted the record.
- **Suggestion:** Make terminal ledger result and ACK-outbox insertion atomic. Dedupe must replay the exact stored result, result_detail, applied version, effect key, and payload hash. Add a crash-state test with a pre-seeded REJECTED_PERMANENT ledger row and no ACK row; replay must regenerate the same NACK, never APPLIED.

#### SYS-7 — Distributed-systems / embedded designer

- **ID:** SYS-7
- **Severity:** Blocker
- **Spec ref:** §5.1–§5.2, §9–§11
- **Claim:** Incremental outbox delivery cannot reconstruct the journal mirror because neither bootstrap path includes journal state.
- **Evidence:** “Build Cloud Bootstrap” and “Run Force Sync” in conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json explicitly serialize users, devices, zones, schedules, and bounded history sets; new tables are not discovered automatically. docs/operations/edge-history-retention.md documents a default 30-day prune for delivered outbox rows. §5.1–§5.2 specifies only new final-save events.
- **Failure mode / lost value:** After delivered events age out, an empty or rebuilt cloud receives none of the edge-canonical historical entries, values, voids, or custom fields. The cloud mirror is permanently incomplete even though the Pi still has the source data.
- **Suggestion:** Add a journal manifest to normal and forced bootstrap plus a resumable snapshot worker: send custom vocab first, then pages of complete entry aggregates bounded by both count (for example 100) and bytes (for example 1 MiB), with snapshot ID, high-water mark, cursor, tombstones/voids, counts, and reconciliation hashes. Test intact-edge→empty-cloud exact reconstruction while concurrent mutations converge through ordinary outbox watermarks. State separately that replacement-Pi rehydration is not supplied unless a verified cloud-to-edge restore path is deliberately added.

#### SYS-8 — Distributed-systems / embedded designer

- **ID:** SYS-8
- **Severity:** Blocker
- **Spec ref:** §4.3–§4.5, §5.3, §10
- **Claim:** Global custom.* codes and release-local mutable seeds allow cross-farm collisions, historical reinterpretation, and newer-cloud/older-edge rejection.
- **Evidence:** journal_vocab.code is the global PK; custom rows have no tenant owner; entries store template/layout codes without versions; and §4.3–§4.5 says both sides ship identical seeds. deploy.sh::seed_db_if_missing preserves an existing Pi DB, so later seed-file changes do not reach provisioned gateways. scripts/verify-seed-replay.js checks schema, not catalog rows.
- **Failure mode / lost value:** Two farms can define the same custom code with different types/units and overwrite or expose one shared-cloud row. Changing a default unit or template in place silently changes the meaning of historical data. A new cloud can send a code an old Pi cannot validate, leaving an unrecoverable pending record.
- **Suggestion:** Generate globally unique tenant-owned codes such as custom.UUID, with owner, sync_version, active, and deleted_at metadata. Forbid changes to kind, value_type, quantity kind, default unit, or semantic parent after first use. Make template/layout definitions append-only by (code, version), store vocab/template/layout versions or definition hashes on each entry, and retain old definitions. Deliver every catalog revision through a new idempotent ordered data migration or governed importer—not by editing 0009—and verify seed-row hashes across edge/cloud. Gate cloud form choices and writes on the target edge’s advertised catalog version/hashes.

#### STD-1 — Agricultural data-standards expert, corroborated by agronomist and researcher

- **ID:** STD-1
- **Severity:** Blocker
- **Spec ref:** §4.2–§4.3, §7–§8
- **Claim:** default_unit_code alone cannot distinguish totals, depths, rates, concentrations, nutrient bases, and per-tree/per-row quantities, so valid-looking records can be numerically wrong.
- **Evidence:** §7 promises canonical conversion but defines no dimension, basis, compatible-unit set, or conversion metadata. docs/superpowers/specs/2026-07-12-agroscope-open-field-layout-design.md lists kg/ha, L/ha, m³/ha, plants/ha, and nutrient-specific kg N/P₂O₅/K₂O per ha. Existing database/seed-blank.sql deliberately distinguishes flow_liters_per_min, flow_liters_delta, and rain channels. In pinned [ADAPT 1.0.0](https://github.com/ADAPT/Standard/tree/1.0.0), AppliedVolumePerAreaActual fixes its unit as L/ha; emitting 1 stored mm unchanged would mean 1 L/ha instead of 10,000 L/ha and still pass the permissive schema.
- **Failure mode / lost value:** A farmer enters “10” and the system stores the wrong basis; kg product/ha is interpreted as kg N/ha; percent loses w/w versus w/v; ADAPT exports silently differ by factors of 100 or 10,000. This corrupts compliance and research data without an obvious error.
- **Suggestion:** Give numeric attributes a quantity_kind/dimension and basis; give unit rows compatible dimensions/bases plus tested scale/offset conversions; constrain each attribute to an allowed unit family. Store entered_value_num and entered_unit_code alongside canonical value_num and unit_code. Reject cross-basis conversion unless required denominators/formulation facts exist. Preserve separate semantics for total mass/volume, depth, flow, mass/area, volume/area, count/area, per-plant/tree/row amount, concentration, nutrient rate, yield, and yield/area. Irrigation also requires amount_kind, measurement_source, the applicable denominator, and an optional actuation_expectation_id; a linked journal annotation must not create a second water total. The UI must always show label+number+unit together, accept locale decimal input, and confirm the interpreted value and unit before finalization.

#### UX-4 — Field-first mobile UX expert

- **ID:** UX-4
- **Severity:** Blocker
- **Spec ref:** §3 D6, §6.1
- **Claim:** “Every change persists as draft” is a false assurance whenever neither the Pi nor cloud is reachable.
- **Evidence:** D6 explicitly requires reaching one server and forbids an on-phone queue, while §6.1 unconditionally promises draft autosave.
- **Failure mode / lost value:** A farmer closes or reloads a form believing the activity is saved when it exists only in volatile browser state. The field record is lost.
- **Suggestion:** Keep D6, but specify visible states: Saving…, Saved on farm gateway, Saved on OSI Server—waiting for farm gateway, and Not saved—server unavailable. If connectivity fails before editing, show Retry rather than an editable form. If it fails mid-edit, retain the form only in volatile memory, show a sticky close/reload-loss warning, install a leave-page guard, and make Finish retry the same UUID. Define stable draft UUID creation, debounced serialized saves, a Drafts resume/discard queue, and final-only defaults for timelines, markers, exports, duplicate matching, and analytics. Do not quietly introduce IndexedDB/localStorage persistence.

#### UX-7 — Field-first mobile UX expert

- **ID:** UX-7
- **Severity:** Blocker
- **Spec ref:** §5.3–§5.4
- **Claim:** A rejection badge and “reload” do not preserve or recover a cloud-authored edit.
- **Evidence:** §5.3 promises pending→confirmed/rejected and §5.4 says stale edits surface “changed elsewhere—reload”; it never says the submitted payload survives. The existing valve/device confirmation patterns cover commands, not multi-field editorial recovery.
- **Failure mode / lost value:** A validation or concurrency rejection can discard a researcher’s complete entry. This is exactly an unrecoverable rejected write, which is a release blocker.
- **Suggestion:** Persist the submitted payload, base version, target gateway, and rejection state with the cloud pending item across reloads. Keep pending/rejected records outside canonical charts and exports. A rejection sheet must say “Farm record was not changed,” retain every field, translate technical reasons, focus validation errors, and show “Your change” versus the current edge record for conflicts. Offer Edit and resend with a new command/effect key, Save as a new entry where valid, or explicit Discard; never delete the rejected payload automatically.

#### STD-3 — Agricultural data-standards expert

- **ID:** STD-3
- **Severity:** Blocker
- **Spec ref:** §3 D9, §8–§9
- **Claim:** One positive fixture validated only against adapt-root-schema.json cannot establish ADAPT 1.0 conformance.
- **Evidence:** Independent inspection of official tag [ADAPT Standard 1.0.0](https://github.com/ADAPT/Standard/tree/1.0.0), commit 555fe554, confirms all six operation codes exist. It also shows that the top-level schema has no required property; codes, references, and timestamps are mostly unconstrained strings; WorkRecord requires a Field reference and operations; Field has no point-location property; and FieldBoundary requires Polygon/MultiPolygon. SummaryValue references a Variable, whose DTD fixes the unit. The root, DTD, and unit artifacts hash to c25db1602f8e9378f6103592db1b9ad65815f06626c4debf79744c92c20ae248, c51894bf08dad6b8c0b104bf95688d86bb8813bdfd643f640e8dd711a0d79dd2, and 985432d6892abef934010dfabd960cbe1fec80df27454354af555b349380d59c respectively.
- **Failure mode / lost value:** An empty object, unknown operation/DTD code, dangling field/variable/product reference, non-UTC timestamp, wrong unit conversion, or non-standard Field center point can pass the planned CI gate. A consumer then rejects or silently misreads a nominally “schema-valid” export.
- **Suggestion:** Pin the three 1.0.0 artifacts and full hashes; validate through a wrapper that references the intended root definition; then run a semantic linter for allowed/status/scope-correct codes, DTD units/conversions, unique/resolvable references, UTC and start≤end, and exact profile version. Add negative mutation fixtures. Define the minimum graph: deterministic Catalog Field IDs, WorkRecord, one or more Operations, Variables, SummaryValues, and ACTUAL TimeScopes. Export only zone-linked entries; omit zone centroid from ADAPT until a polygon exists; keep it in full-fidelity JSON. Put product text in notes/descriptions unless valid Catalog Product objects are generated. All six activity mappings are already clean, so revise the fallback to semantic-profile acceptance rather than operation-type discovery.

### Major findings

#### RES-1 — Agronomic researcher

- **ID:** RES-1
- **Severity:** Major
- **Spec ref:** §4.1, §4.7, §7–§8
- **Claim:** “ISO, zone-local timezone” is not a sortable, reproducible timestamp contract for backdating, sensor lookup, or ADAPT.
- **Evidence:** §4.1 stores occurrence times as zone-local text and the mutable zone timezone separately. docs/contracts/sync-schema/canonicalization.md requires canonical UTC millisecond timestamps, existing outbox triggers use Z timestamps, and ADAPT TimeScope defines start/end as UTC. Mixed-offset ISO text does not sort chronologically in SQLite, and offset-less local time is ambiguous at DST folds/gaps.
- **Failure mode / lost value:** A backdated entry can attach the wrong sensor context, miss or trigger the duplicate guard incorrectly, move on a chart/export after timezone changes, or serialize as a different instant.
- **Suggestion:** Store occurred_start/end as canonical UTC YYYY-MM-DDTHH:MM:SS.sssZ. Snapshot occurred_timezone (IANA name) and occurred_utc_offset_minutes on the entry for faithful display. Resolve local input explicitly, reject nonexistent times, disambiguate repeated times, query context/duplicates in UTC, and test Zurich DST gap/fold plus start≤end.

#### SEC-1 — Security & operations reviewer

- **ID:** SEC-1
- **Severity:** Major
- **Spec ref:** §5.1, §8
- **Claim:** Authentication and tenant ownership are explicit only for CSV, leaving the rest of the journal surface under-specified.
- **Evidence:** §5.1 labels only GET /api/journal/export.csv “auth-gated”; §8 adds JSON and ADAPT exports, and custom-field creation has no route. The existing “history-api-router-fn” verifies bearer auth before protected history routes and getOwnedZoneContext filters irrigation_zones by both zone ID and auth.userId.
- **Failure mode / lost value:** A literal implementation can disclose entries/custom research vocab across local users or mutate another user’s zone/device. Cloud fallback author mapping can also conflate access ownership with authorship.
- **Suggestion:** Add a route matrix covering vocab/catalog, entries, custom-vocab create/deactivate, CSV, JSON, and ADAPT. Require bearer auth for every /api/journal/* route; derive the owner from the token/owned zone/gateway rather than request user_id; validate device ownership; return 401 for missing auth and 404 for cross-owner resources. Separate immutable owner_user_uuid from author_principal_uuid and optional display-only author_label. Add per-route auth/ownership tests.

#### SEC-3 — Security & operations reviewer

- **ID:** SEC-3
- **Severity:** Major
- **Spec ref:** §4.1–§4.6, §5, §7–§8
- **Claim:** Untrusted text, context, repeat groups, and aggregate payloads have no hard size, privacy, logging, or output-escaping contract.
- **Evidence:** author_label, note, value_text, labels_json, filename, values/groups, and context_json are unbounded. By contrast, the “Improvement Requests API Router” in conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json bounds input and redacts secrets/PII. conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js neutralizes spreadsheet formulas in values and conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.js provides safeFilenamePart, but journal custom fields create dynamic CSV headers too. “Build Edge Event Batch” selects up to 100 oldest events without a byte budget.
- **Failure mode / lost value:** One accidental/hostile record can exhaust Node-RED memory or create a permanently failing outbox head; names/notes can leak into logs/default exports; custom headers or cells can trigger spreadsheet formulas or malformed downloads.
- **Suggestion:** Add server-level limits independent of template constraints: request 256 KiB, note 4,000 characters, author label 120, text value 2,000–4,096 UTF-8 bytes, 128 values, 32 groups, context 32–64 KiB, aggregate 256 KiB, filename 255 bytes. Reject with 413 rather than truncate and cap event batches by count and total bytes. Derive author labels from authenticated metadata; log only IDs/codes/lengths; omit author labels from default research export. RFC-4180-encode headers and cells, formula-neutralize the first non-whitespace equals, plus, hyphen-minus, or at-sign character, use safe generated filenames, and render all labels/notes as plain text.

#### SYS-9 — Distributed-systems / embedded designer

- **ID:** SYS-9
- **Severity:** Major
- **Spec ref:** §4.1–§4.2, §4.5, §6.3, §7–§8
- **Claim:** Pi 5 capacity is adequate for 10k entries/150k values, but the proposed constraints and indexes do not cover actual queries or deterministic EAV identity.
- **Evidence:** The draft provides entry indexes on zone/time, activity/time, and status, plus values(entry_uuid), but no unique EAV cell or parent FK. Duplicate guard, final-only timeline, sticky layout, gateway range, and CSV queries use multiple predicates. The repo already pins schema/index/query-plan behavior in scripts/verify-db-schema-consistency.js.
- **Failure mode / lost value:** Duplicate entry/group/attribute rows make pivot output nondeterministic. Range/duplicate/sticky queries scan unnecessary rows, and backdating can choose the wrong “last-used” layout if occurrence time is confused with interaction recency.
- **Suggestion:** Add FK entry_uuid→journal_entries(entry_uuid) ON DELETE CASCADE, CHECK(group_index≥0), and UNIQUE(entry_uuid, group_index, attribute_code). Add partial/composite indexes for zone+occurred_start on non-deleted rows, final duplicate guard by zone+activity+occurred_start, gateway+occurred_start, and sticky layout by user+zone+recorded_at for final rows. Use keyset paging and streaming CSV. Pin EXPLAIN QUERY PLAN results and performance with a 10k-entry/150k-value fixture. Add attribute/value indexes only for queryable research predicates; do not index every EAV column by reflex.

#### SYS-12 — Distributed-systems / embedded designer

- **ID:** SYS-12
- **Severity:** Major
- **Spec ref:** §4, §9, §11
- **Claim:** 0009 is the correct next additive migration, but the stated gates omit required schema, seed, profile, and contract surfaces.
- **Evidence:** The current ordered head is database/migrations/ordered/0008__sync_outbox_eviction_index.sql. Migration loading requires a first-line risk header; database/migrations/ordered/CHECKSUMS.json, scripts/test-deploy-migration-wiring.js, the hand-maintained schemaContract/index checks, database/seed-blank.sql, and seven bundled farming.db copies all participate. AGENTS.md freezes sync-init-fn and requires profile parity. §9 names only seed replay, runtime parity, and fingerprints.
- **Failure mode / lost value:** A fresh image, upgraded Pi, alternate profile, or cloud contract can ship a different schema/catalog; the feature flag can expose routes before tables/module readiness.
- **Suggestion:** Require “-- risk: additive”; register 0009 in database/migrations/ordered/CHECKSUMS.json and the deploy-wiring fixture; update database/seed-blank.sql, database/farming.db, web/react-gui/farming.db, and the five maintained profile DBs; update schemaContract, required indexes/SQL fragments, query-plan and seed-row-hash tests; update sync schemas/op parity and both maintained flows profiles. Run migration verification, seed replay, DB consistency, runtime parity, contract/op parity, outbox-retention classification, and profile parity. Do not put journal DDL in sync-init-fn. Expose the feature only after schema/module readiness.

#### RES-2 — Agronomic researcher

- **ID:** RES-2
- **Severity:** Major
- **Spec ref:** §1, §4.1–§4.4, §6.2, §8
- **Claim:** Zone+layout+date and flat custom fields do not identify a protocol, campaign, experimental unit, replicate, or subject, so research observations cannot be joined reliably.
- **Evidence:** research_observation is only “protocol-oriented”; the entry has no campaign/protocol/observation-unit columns. The repo-local Agroscope follow-on spec contains plot, tillage-system, fertilization-regime, repeatable nutrient, and treatment factors, demonstrating that physical zone alone is not the experimental unit.
- **Failure mode / lost value:** Two trials in one zone/date are pooled; per-tree or replicate observations cannot be separated; a protocol revision silently changes meaning; blank values cannot distinguish not measured from not applicable.
- **Suggestion:** Make the smallest v1 addition: nullable campaign_uuid, protocol_code, protocol_version/hash, and observation_unit_code on journal_entries; seed standard plot, replicate, treatment, subject/tree, sample ID, and method attributes. Add value_status (observed, not_observed, not_applicable, below_detection) so missingness is explicit. A campaign registry/authoring UI can remain v2, but exports and filters must preserve these stable identifiers now; doing so also preserves a future MIAPPE-adjacent study/event linkage.

#### RES-5 — Agronomic researcher

- **ID:** RES-5
- **Severity:** Major
- **Spec ref:** §4.2, §8
- **Claim:** One wide CSV row per entry is not a lossless analysis format for repeat groups, custom fields, and mixed layouts.
- **Evidence:** §4.2 permits two spray-product groups and the Agroscope layout uses repeated nutrient amounts. §8 does not define group suffixes, column ordering, missingness, or how layout-specific attributes coexist. Existing web/react-gui/src/analysis/csv.ts intentionally uses a tidy one-observation-per-row shape and renders null as blank, illustrating why semantics need an explicit manifest.
- **Failure mode / lost value:** Product/dose pairs detach, group order becomes a column-name convention, sparse mixed-layout files become unstable across catalog versions, and blank means multiple incompatible things.
- **Suggestion:** Make a canonical research package: entries.csv (one row per entry), values.csv (one row per typed value with entry_uuid, attribute_code, group_index, value_status, entered/canonical units), vocab_mappings.csv, and manifest.json. Keep the wide pivot only as a convenience view with deterministic escaped names and explicit template/layout/catalog version. Never call the wide file full fidelity.

#### STD-2 — Agricultural data-standards expert

- **ID:** STD-2
- **Severity:** Major
- **Spec ref:** §2, §4.3, §8
- **Claim:** One agrovoc_uri/icasa_code/adapt_code per row lacks scheme version, mapping role/relation, and coded-choice context.
- **Evidence:** §4.3 uses adapt_code for both activity operation types and unit/DTD references, even though ADAPT separates OperationType, Variable.definitionCode, and DTD-fixed units. [FAO’s AGROVOC release process](https://www.fao.org/agrovoc/releases) timestamps a mutable ConceptScheme. The official [DSSAT ICASA Dictionary](https://github.com/DSSAT/ICASA-Dictionary/tree/2168f366b7c35ce6997c8fb0055dc259e9341ad3) distinguishes a variable (for example irrigation method) from child coded values. AgrO is cited in §2 but has no mapping field.
- **Failure mode / lost value:** An exporter cannot tell whether a code is a variable, coded value, operation type, DTD, unit, or merely a related concept; later releases and curation judgments are irreproducible.
- **Suggestion:** Add journal_vocab_mappings(term_code, scheme_uri, scheme_version, mapping_role, external_id/uri, external_parent_id, mapping_relation, source_uri, active). Support roles concept, variable, coded_value, operation_type, data_type_definition, unit_of_measure and SKOS exact/close/broad/narrow/related relations. Map choice rows individually. Treat existing flat columns, if retained, as non-authoritative caches. Include mapping/catalog versions, definition hashes, source/license, exporter version, and unit-conversion provenance in JSON/research manifests.

#### AGR-1 — Agronomist / field practitioner

- **ID:** AGR-1
- **Severity:** Major
- **Spec ref:** §4.3, §6.2
- **Claim:** The “~12, curated during implementation” activity list merges or ambiguously separates operations that require different agronomic records.
- **Evidence:** §4.3 merges planting/seeding; separates generic weeding from spray/plant-protection without saying where herbicides go; and omits fertigation and sampling. The Agroscope follow-on catalog explicitly distinguishes sowing, crop protection including herbicide versus mechanical weed control, irrigation, fertilization, and sampling. The [Swiss BLV register](https://www.blv.admin.ch/de/pflanzenschutzmittelverzeichnis) attaches permitted uses, rates, and restrictions to plant-protection products.
- **Failure mode / lost value:** A herbicide logged as “weeding” bypasses product/rate fields; sowing and transplanting share the wrong density fields; fertigation loses either water or nutrient semantics; samples and crop-care work fall into notes.
- **Suggestion:** Finalize seeds before Slice 1. Use activity.plant_protection_application for herbicide/fungicide/insecticide/biological applications and activity.weed_control_nonchemical for hoe/hand/flame/mechanical work with a method. Split seeding from planting/transplanting. Add sampling and either a first-class fertigation activity carrying both irrigation and nutrient groups or an explicit linked-entry rule. Add crop_care (thin/train/tie/de-leaf) and layout-scoped climate/frost control only where pilots need them. Use short farmer verbs for labels; do not make free text load-bearing.

#### AGR-3 — Agronomist / field practitioner

- **ID:** AGR-3
- **Severity:** Major
- **Spec ref:** §3 D8, §4.5, §6.2b
- **Claim:** The three layout names are not yet implementable definitions, and the engine cannot express the dependent choices already required by the Agroscope layout.
- **Evidence:** §4.5 gives only examples for greenhouse and lysimeter. docs/superpowers/specs/2026-07-12-agroscope-open-field-layout-design.md specifies a four-level category→operation→device→unit cascade and states that the parent model lacks cross-field choice dependencies. Existing zones carry area/crop but no structure, compartment, substrate, experimental-unit, bed/row, or canopy facts. OSI already supports reference trees/dendrometry. [Agroscope orchard guidance](https://www.agroscope.admin.ch/dam/agroscope/de/dokumente/themen/pflanzenbau/obstbau/Applikation%20von%20Pflanzenschutzmitteln%20im%20Hochstammobstbau%20definitiv.pdf.download.pdf/Applikation%20von%20Pflanzenschutzmitteln%20im%20Hochstammobstbau%20definitiv.pdf) calculates water/product amounts from tree/canopy volume.
- **Failure mode / lost value:** Invalid device/unit combinations remain selectable; greenhouse litres per floor area versus plant/container are indistinguishable; lysimeter replicates and water balance are pooled; orchard per-tree/canopy quantities masquerade as ordinary field-area rates.
- **Suggestion:** Add a layout definition schema with option_dependencies and allowed-unit dependencies, enforced by the same edge validator. Name v1 minimums: open field—block/bed/row, treated area, cover type; greenhouse—structure/compartment, soil/container/substrate/hydroponic root zone, plant/wetted area, drainage/recirculation, conditional EC/pH; lysimeter—experimental-unit/replicate/treatment, surface area, interval, water/rain/drainage inputs, mass start/end/tare/method. Reopen D8’s list only if a named launch farm needs per-tree/row/canopy recording; then add orchard_berry_rows as data. Otherwise document its denominator representation in open_field and validate it with those users.

#### AGR-7 — Agronomist / field practitioner

- **ID:** AGR-7
- **Severity:** Major
- **Spec ref:** §4.1, §6.1, §7
- **Claim:** Maximal carry-forward is unsafe across backdating and crop seasons, especially for plant-protection records.
- **Evidence:** §6.1 copies the last final activity+zone before the occurrence time may be changed. irrigation_zones crop/variety/stage are mutable, while database/seed-blank.sql already has zone_seasons with stable season_uuid and dated crop/variety. The [Swiss BLV register](https://www.blv.admin.ch/de/pflanzenschutzmittelverzeichnis) is updated and records crop/use/rate restrictions.
- **Failure mode / lost value:** Today’s product, authorization, target, dose, treated area, or waiting period is copied into yesterday’s or a previous crop’s entry; research export later associates work with the current rather than historical crop.
- **Suggestion:** Add frozen season_uuid to final entries and snapshot crop plus optional variety/stage; resolve by occurred_start, requiring crop selection if no season matches. Select carry-forward only from a compatible final entry at or before the chosen occurrence time and matching season/layout. Never silently carry plant-protection product/authorization, target, dose/basis, treated area, or waiting period. Offer an explicit “Repeat last treatment” card showing source date/crop/product/rate and require confirmation; invalidate it when crop/season/layout changes. Carry only lower-risk fields such as operator/equipment/method by default.

#### AGR-9 — Agronomist / field practitioner

- **ID:** AGR-9
- **Severity:** Major
- **Spec ref:** §1, §4.4, §6.2, §8, §10
- **Claim:** full_record’s “compliance” positioning is hand-waving until the spec defines a conditional Swiss record profile and retention promise.
- **Evidence:** §6.2 lists products, doses, area, equipment, operator, and conditions without requiredness. Current [AGRIDEA ÖLN guidance](https://agripedia.ch/oeln/startseite/allgemeine-bedingungen/) names product, Swiss authorization number, application date/quantity, monitoring/count results, harvest dates/yields, and—on arable farms—variety, rotation, and tillage; it says update within one week and retain records six years. §10 correctly excludes certified ÖLN export.
- **Failure mode / lost value:** Users omit facts that cannot be reconstructed later while the product implies compliance-grade completeness. Conversely, universally requiring operator, wind, PHI, nozzle, or batch data without a named rule burdens farmers and may still miss the actual scheme requirement.
- **Suggestion:** Rename the promise to “detailed farm record; not certified compliance.” Add an activity/profile matrix of conditionally required facts. At minimum cover the fields above, fertilization material/quantity/basis/area and nutrient quantities where known, and harvest crop/area/yield/unit. Classify operator, equipment/nozzle/calibration, carrier water, weather/wind, waiting period, batch, cost, and photos as operational or scheme/product-specific unless an authoritative profile makes them mandatory. If ÖLN evidence is a v1 intent, commit to a seven-day completion reminder and six-year retention/export; otherwise say explicitly that v1 is only structurally future-ready.

#### AGR-12 — Agronomist / field practitioner

- **ID:** AGR-12
- **Severity:** Major
- **Spec ref:** §4.7, §6.2
- **Claim:** A frozen “latest” sensor snapshot without source, freshness, coverage, aggregation, and missing-data semantics turns stale or absent data into plausible context.
- **Evidence:** §4.7 names latest SWT, 24h rain, temperature/RH, and valve state but no schema. database/seed-blank.sql has recorded_at, canonical swt_1/2/3, wind/gust, rain status, and interval/cumulative channels. AGENTS.md says SWT canonical values are kPa, LoRain is interval rain that must not double aggregate, and historical valve evidence belongs in actuation expectations rather than current state. docs/engineering-playbook.md requires missing to remain missing.
- **Failure mode / lost value:** A two-week-old tension reading appears contemporaneous; a no-sample rain window becomes 0 mm; duplicate cumulative rain is counted; a multi-hour spray gets start-only weather; a current valve state is presented as historical truth.
- **Suggestion:** Version context_json. Represent every channel with value, unit, source device/key, observed_at, statistic/window, sample_count, coverage/status/quality, and age/freshness threshold. Store null plus reason for uncovered/stale windows. Use canonical SWT kPa, valid rain deltas with no-data distinct from zero, wind speed/direction/gust for plant protection, and actuation expectations/events for historical valve context. For duration activities capture start/end and operation-window summaries. Recompute context if time, zone, device, or duration changes before finalization; freeze only after successful final commit.

#### UX-1 — Field-first mobile UX expert

- **ID:** UX-1
- **Severity:** Major
- **Spec ref:** §4.3, §6.1–§6.2, §9
- **Claim:** The ≤5-tap promise is untestable and unlikely on the cold path because the launch point and interaction count are undefined.
- **Evidence:** The form combines roughly 12 activities, zone/date, one to three values, and Finish. web/react-gui/src/components/DashboardHeader.tsx offers Add only for zone/device; web/react-gui/src/components/farming/IrrigationZoneCard.tsx exposes Configure/Assign/Data/Delete but no log action; web/react-gui/src/index.css defines a 48px baseline target.
- **Failure mode / lost value:** Farmers hunt for the feature, reselect the zone, scroll a large grid, or mistap in gloves/glare; “five taps” cannot be an acceptance gate.
- **Suggestion:** Put a visible 56px “Log activity” CTA on each collapsed zone card and an Activity item in the dashboard Add menu. Preselect zone/crop/time, show six recent/common activities in a 2×3 icon+label grid with More, use a locale-aware numeric keypad with always-visible unit, and keep a sticky 56px Finish. Define the SLA as ≤5 primary-control activations from zone CTA to acknowledgement for a common carried-forward entry, not every cold entry. Test 320×568 and 360×640 with no horizontal scroll and conduct sun/glove field trials.

#### UX-3 — Field-first mobile UX expert

- **ID:** UX-3
- **Severity:** Major
- **Spec ref:** §6.2–§6.2b
- **Claim:** Preserving attribute-keyed values is insufficient when a layout change invalidates the activity, choices, or hidden layout-only values.
- **Evidence:** §6.2 promises preservation on template switch; §6.2b says layouts remove activities, filter choices, and add attributes, but defines no transition behavior.
- **Failure mode / lost value:** A farmer submits greenhouse choices under open_field, silently loses lysimeter values, or sees an unexplained server rejection caused by a hidden invalid field.
- **Suggestion:** Use separate controls: “Detail level: Quick | Full | Research” and a prominent “Growing setting: …” context button, with zone/layout repeated in the final summary. Template switches retain valid hidden values and expose an “N extra details saved” drawer. Layout switches must show a review sheet of disallowed activity/choices/values and block finalization until the user keeps the old setting, changes/replaces the invalid item, or explicitly removes it.

#### UX-9 — Field-first mobile UX expert

- **ID:** UX-9
- **Severity:** Major
- **Spec ref:** §4.3–§4.5, §6.4, §9
- **Claim:** labels_json plus an AGROVOC URI is not a translation or low-literacy delivery contract.
- **Evidence:** web/react-gui/src/i18n/config.ts enables en, de-CH, fr, it, es, pt, and lg. Current locale coverage is incomplete: for example web/react-gui/public/locales/lg/history.json retains extensive English, while web/react-gui/src/history/__tests__/historyLocaleKeys.test.ts checks only three new keys across non-English locales. §4.3 has no data-level icon identifier. AGROVOC is a reference vocabulary, not farmer-reviewed UI copy.
- **Failure mode / lost value:** Users receive mixed-language or ontology-style labels, choose the wrong activity, and new data-driven activities require hardcoded frontend icon logic.
- **Suggestion:** Add an allowlisted icon_key to activity vocab. Require every enabled journal term/template/layout/unit, validation message, save/rejection state, and error action to have reviewed labels in all enabled locales or an explicit visible English fallback. Add CI key/content coverage with an allowlist for legitimate identical terms. Pair every culturally reviewed pictogram with a short action label—never icon-only—and obtain native/agronomic review, especially for de-CH, French, and Luganda.

#### SYS-13 — Distributed-systems / embedded designer

- **ID:** SYS-13
- **Severity:** Major
- **Spec ref:** §3 D5, §4.6
- **Claim:** stored_path plus an unspecified sync_state does not pre-commit to a safe or usable v2 blob path.
- **Evidence:** §4.6 has no parent FK, deletion/version fields, local-versus-remote distinction, constrained transfer states, or upload protocol. An absolute Pi path is meaningless in cloud, and blob bytes cannot safely ride in the bounded JSON outbox.
- **Failure mode / lost value:** Path traversal or local-path disclosure becomes possible; a crash creates orphan/missing files; replicas disagree about upload/delete state; adding v2 requires another avoidable schema redesign.
- **Suggestion:** Define entry_uuid FK; original_filename as display-only; opaque blob_uuid/content hash and remote_object_key; local_relpath as system-generated, fixed-root, non-synced metadata; size/hash/MIME checks; transfer_state; sync_version; deleted_at; and an entry/deleted index. State that v2 writes temp→hash/fsync→atomic rename→metadata commit, then uses separate authenticated resumable chunk upload with final hash verification. Never place blob bytes in the journal aggregate/bootstrap.

### Minor findings

#### SEC-5 — Security & operations reviewer

- **ID:** SEC-5
- **Severity:** Minor
- **Spec ref:** §9–§10
- **Claim:** The field_journal flag has no off-state, schema-readiness rule, or non-PII rollout signal.
- **Evidence:** /api/system/features is currently a public hardcoded literal in history-api-router-fn; the React feature hook expects typed camelCase fields and fails closed. There is no existing UCI journal toggle.
- **Failure mode / lost value:** “Off” can hide data while writes/sync behave inconsistently, or enable a route before migration readiness; operators cannot distinguish unused from stuck/rejected on Uganda connectivity.
- **Suggestion:** Define fieldJournalUxEnabled as UI visibility only: false must retain authenticated reads/exports, edge→cloud sync, ACKs, and stored data. If needed, add separate fieldJournalWritesEnabled enforced identically in REST and commands with stable 503 feature_disabled. Enable only after schema/module/catalog readiness. Add non-PII pending/rejected/oldest-age, last-bootstrap/reconciliation, catalog-version, and capability-mismatch signals as kaba100→Silvan→Uganda gates.

#### UX-8 — Field-first mobile UX expert

- **ID:** UX-8
- **Severity:** Minor
- **Spec ref:** §6.3, §9
- **Claim:** Chart markers lack a density, clustering, hit-target, and default-filter contract.
- **Evidence:** web/react-gui/src/components/history/mobile/HistoryRangeSegmentedControl.tsx spans 12h through season; web/react-gui/src/components/history/visualizations/DendroGrowthTimelineView.tsx draws a ReferenceLine per event; web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx renders only markers.slice(0, 5) without an overflow count.
- **Failure mode / lost value:** Journal events obscure curves, overlap into untappable marks, or disappear at season scale.
- **Suggestion:** Put journal markers in a separate event lane, final-only by default; cluster by rendered distance and show counts; give markers/clusters a 48px hit area opening a bottom sheet; add activity and Journal on/off filters; distinguish type by icon/shape plus color. Test 0, 1, 50, and 500 events at 320px over 24h and season ranges.

#### STD-6 — Agricultural data-standards expert

- **ID:** STD-6
- **Severity:** Minor
- **Spec ref:** §3 D9, §8
- **Claim:** Excluding observations from v1 ADAPT is valid, but “ADAPT models operations, not observations” is factually wrong.
- **Evidence:** The official [ADAPT 1.0 data-type definitions](https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json) include OBSERVATION_GENERAL for scouting/soil testing.
- **Failure mode / lost value:** The rationale incorrectly closes a future standards path and may encourage a custom representation later.
- **Suggestion:** Replace it with: “Observations are excluded from the v1 ADAPT profile as deliberate scope control; ADAPT 1.0 OBSERVATION_GENERAL may be enabled later once observation-variable mapping is specified.”

## 4. Enhancement suggestions

These are prioritized product improvements after the required design corrections above. Items marked v2 are intentionally not argued into v1.

| Priority | Enhancement | Value | Cost | Placement |
|---|---|---|---|---|
| 1 | **Conditional orchard/berry-row layout** | Preserves per-tree, planted-row, and canopy/tree-row-volume denominators for farms that actually use them. | M | **v1 Slice 1–2 only if a named launch pilot confirms the need**; otherwise v2 seed addition. |
| 2 | **Linked irrigation suggestion/annotation** | Let a farmer annotate an existing valve_actuation_expectation or measured irrigation event instead of creating a second water total; reduces duplicate accounting and entry effort. | M | v1 fast-follow or v2 after Slice 2. |
| 3 | **ÖLN completion reminder/profile status** | If detailed records are intended as evidence, a seven-day reminder and per-entry “missing required facts” status prevent irrecoverable omissions without claiming certification. | S–M | v1 Slice 2, conditional on Phil’s compliance answer. |
| 4 | **Date-stamped farm product library backed by the BLV register** | Reduces wrong-product/authorization/rate entry and supports explicit repeat-treatment review. Must preserve source date and never imply a recommendation. | L | v2; separate data-ingest/licensing work. |
| 5 | **Campaign/protocol registry and observation-unit roster** | Adds names, protocol documents/hashes, treatment assignment, subject/tree rosters, and researcher defaults around the minimal v1 identifiers. | M | v2; the v1 schema should preserve the identifiers now. |
| 6 | **Photo capture and content-addressed blob sync** | Field evidence for pests, equipment, treatments, and trials, using the metadata contract reserved in v1. | L | v2, as D5 intends. |
| 7 | **Repository-grade research deposit bundle** | Adds dataset UUID, creators/ORCID/ROR where supplied, license, coverage, record counts, file hashes, exporter commit, vocab/template/layout/context-generator versions, and transformation provenance; makes DOI deposits reusable rather than merely downloadable. | M | v2 export profile; can wrap the required v1 canonical CSV/JSON package. |
| 8 | **ADAPT observation profile** | Exports scouting/soil-testing observations through OBSERVATION_GENERAL once variable mapping and consumer demand are known. | M | v2 or Slice 5 fast-follow, not v1 D9. |
| 9 | **Prepackaged tap-to-hear labels** | Helps low-literacy users identify activities and review values without speech recognition or a phone queue. | M | v2, only after native-language usability testing. |
| 10 | **Template/layout authoring UI** | Lets researchers manage forms without release engineering once the declarative schema, versioning, and migration rules have proven stable. | L | v2+, consistent with D4’s v1 exclusion. |
| 11 | **On-phone offline queue** | Helps only if field evidence shows Pi/cloud reachability plus backdating still causes substantial loss; otherwise it adds conflict/security/support cost. | L | v2+ evidence-gated reconsideration of D6. |
| 12 | **Recent-activity personalization** | Six recent/common activities per user+zone makes the quick SLA realistic without changing the curated vocabulary. | S | v1 Slice 2. |

## 5. Spec patch suggestions

Apply these top-to-bottom so later sections refer to fields/contracts already introduced.

### Patch 1 — §1 Purpose: narrow the compliance promise

Replace “barto-Feldkalender-style activity records per zone, growing toward ÖLN-grade completeness” with:

> Structured farm records per zone, designed to support named compliance profiles later. v1 full_record is a detailed record, not a certified ÖLN record or export; any compliance-oriented requiredness and retention are explicit profile rules, never implied by the template name.

Add one goal:

> **Reproducibility:** every final entry pins its occurrence instant, crop season where known, catalog/template/layout semantics, entered and canonical units, and provenance needed to interpret it later.

### Patch 2 — §3 Adjudicated decisions: preserve choices but add guardrails

Amend the affected rows as follows:

- **D2:** append “Cloud writes are capability/catalog gated; a rejected payload remains recoverable until explicit discard.”
- **D3:** append “Core semantic codes are immutable after use; external mappings are role-qualified/versioned; custom codes are globally unique and tenant-owned.”
- **D4:** append “The engine supports layout-scoped dependent choices/unit sets and minimal campaign/protocol/observation-unit identity; no v1 authoring UI.”
- **D5:** replace “metadata-ready” with “content-addressed, replica-aware metadata-ready; no client-supplied filesystem paths.”
- **D6:** append “The UI must distinguish server-confirmed draft save from volatile unsaved browser state.”
- **D7:** append “Typed values preserve entered and canonical quantity/unit, explicit missingness, repeat-group identity, and one deterministic cell per entry/group/attribute.”
- **D8:** append “Each shipped layout has a reviewed minimum attribute/denominator contract and dependency map. Orchard/berry rows enters v1 only on named-pilot evidence.”
- **D9:** append “Target the pinned ADAPT 1.0.0 artifacts and a named OSI profile with semantic validation; all six operation-type mappings are already confirmed.”

### Patch 3 — §4.1 journal_entries: correct identity, time, versions, research, and void semantics

Change user_id’s note to “access owner on edge; always derived, never accepted from request input.” Add:

| Column | Type | Notes |
|---|---|---|
| owner_user_uuid | TEXT NOT NULL | stable sync/access owner |
| author_principal_uuid | TEXT NOT NULL | immutable actor identity; author_label is display-only |
| season_uuid | TEXT NULL | resolved at finalization and frozen; no FK to the current partial unique index |
| campaign_uuid | TEXT NULL | opaque research campaign identity |
| protocol_code / protocol_version | TEXT NULL | protocol identity/version or hash |
| observation_unit_code | TEXT NULL | plot/replicate/tree/vessel/subject identity |
| template_version / layout_version / catalog_version | INTEGER NOT NULL | semantic definitions used |
| occurred_timezone | TEXT NOT NULL | IANA display timezone snapshot |
| occurred_utc_offset_minutes | INTEGER NOT NULL | offset chosen when resolving local input |
| voided_at / voided_by_principal_uuid / void_reason | TEXT NULL | retained correction/audit state |

Replace occurrence notes with:

> occurred_start and occurred_end are canonical UTC instants with millisecond precision and Z. Local entry is resolved using occurred_timezone; nonexistent local times are rejected and repeated times require an explicit offset choice. recorded_at is server-stamped UTC.

State:

> v1 has no user hard-delete. voided retains values, context, and attachment metadata. deleted_at is reserved for an explicit administrative/sync tombstone contract and is otherwise NULL.

Add indexes for owner/gateway range access, but defer exact SQL to the §4.2/index patch below.

### Patch 4 — §4.2 journal_entry_values: make EAV deterministic and unit-auditable

Add these columns:

| Column | Type | Notes |
|---|---|---|
| value_status | TEXT NOT NULL DEFAULT 'observed' | observed, not_observed, not_applicable, below_detection |
| entered_value_num | REAL NULL | original numeric input |
| entered_unit_code | TEXT NULL | unit selected by the user |

Replace the current value CHECK with:

> observed rows contain exactly one typed value; non-observed status rows contain neither. Numeric observed rows carry entered value/unit and canonical value/unit.

Add:

- FK entry_uuid→journal_entries(entry_uuid) ON DELETE CASCADE.
- CHECK group_index≥0.
- UNIQUE(entry_uuid, group_index, attribute_code).
- idx_journal_entries_zone_time on zone_id, occurred_start DESC, entry_uuid for non-deleted rows.
- idx_journal_entries_gateway_time on gateway_device_eui, occurred_start DESC, entry_uuid for non-deleted rows.
- idx_journal_entries_duplicate on zone_id, activity_code, occurred_start, entry_uuid for final non-deleted rows.
- idx_journal_entries_sticky on author_principal_uuid, zone_id, recorded_at DESC, entry_uuid for final non-deleted rows.
- Keyset pagination and streamed export; a 10k/150k query-plan fixture.

Clarify that group_index is the stable group ordinal inside the complete aggregate and that product/dose or nutrient/value rows in one group must remain paired.

### Patch 5 — §4.3 vocabulary: split semantics, mappings, units, ownership, and catalog delivery

Add journal_vocab columns/constraints:

- owner_user_uuid and gateway_device_eui for custom rows; NULL for core.
- custom_field_uuid for custom rows.
- icon_key for activities, from a frontend allowlist.
- quantity_kind and basis for numeric attributes/units.
- immutable_after_use semantic fields: kind, parent_code, value_type, quantity_kind, basis, default_unit_code.

Replace the custom-code paragraph with:

> Custom fields use a globally unique server/edge-generated code such as custom.UUID, have an explicit owner, sync_version, active and deleted_at lifecycle, and cannot change type/unit semantics after first use.

Add a new table:

> journal_vocab_mappings(term_code, scheme_uri, scheme_version, mapping_role, external_id, external_parent_id, mapping_relation, source_uri, active), with roles concept/variable/coded_value/operation_type/data_type_definition/unit_of_measure and SKOS exact/close/broad/narrow/related relations. Flat agrovoc_uri/icasa_code/adapt_code fields, if retained, are caches only.

Add unit wording:

> Every numeric attribute names a quantity kind, basis, canonical unit, and allowed unit family. Unit rows define compatible dimension/basis and tested conversion. Cross-basis conversion requires all denominators/formulation facts.

For irrigation, require amount_kind, measurement_source, the matching area/count/row denominator, and an optional actuation_expectation_id. A linked entry annotates the automatic/measured event and does not add a second water total.

Replace the activity paragraph with a decided v1 seed list before Slice 1. At minimum distinguish plant_protection_application from weed_control_nonchemical; seeding from planting/transplanting; add sampling; and decide explicit fertigation semantics. Use short localized action labels.

Add catalog delivery:

> journal_catalog_version is monotonic. Every post-0009 catalog revision is an idempotent ordered data migration or governed importer with cross-repo seed hashes; editing an old migration is forbidden. The edge advertises installed version and definition hashes.

### Patch 6 — §4.4–§4.5 templates/layouts: append-only versions and dependent choices

Change each primary key from code alone to (code, version), retain inactive old definitions, and state that entry version pins are immutable.

Add this definition_json contract:

> option_dependencies constrain choices or unit sets by earlier field values; required_if/visible_if predicates are deterministic, side-effect-free, and enforced by the same edge validator. Server validation rejects choices hidden or invalid under the pinned activity/layout/template versions.

Name minimum layout fields:

- open_field: block/bed/row, treated area, cover type, denominator facts.
- greenhouse: structure/compartment, root-zone system, plant/wetted area, drainage/recirculation; EC/pH only when applicable.
- lysimeter: experimental unit, replicate/treatment, surface area, interval, water/rain/drainage inputs, mass start/end/tare/method.

Replace the defaulting rule with:

> Reuse the layout from the user’s most recently recorded final entry for the zone, ordered by recorded_at, not the backdated occurred_start. First use requires an explicit large layout choice; fallback open_field is not silent.

Add the D8 evidence gate for orchard_berry_rows described in the decision matrix.

### Patch 7 — §4.6 attachments: reserve a workable v2 contract

Replace the one-line schema with:

> attachment_uuid PK; entry_uuid FK; kind CHECK; original_filename display-only; mime allowlisted; size_bytes bounded and non-negative; sha256 lowercase 64-hex; blob_uuid/content key; local_relpath system-generated and edge-local; remote_object_key; transfer_state CHECK; captured_at; sync_version; created_at; deleted_at; index(entry_uuid, deleted_at). No request may supply or receive an absolute filesystem path.

Add:

> v2 blob transfer is a separate authenticated resumable channel with final hash verification. Blob bytes never enter journal outbox aggregates or bootstrap JSON.

### Patch 8 — §4.7 sensor context: define the snapshot schema

Replace the paragraph with:

> On the successful promotion transaction, generate context schema version 1. Each channel records value, unit, source device/key, observed_at, statistic and window, sample_count, coverage/status/quality, and freshness/age. Uncovered or stale data is NULL with a reason; absence is never zero. SWT uses swt_1/2/3 kPa; rain uses valid interval deltas without duplicate/out-of-order aggregation; plant-protection context includes wind speed/direction/gust when available; historical valve state comes from events/actuation expectations. Duration activities capture start/end and window aggregates. Sensor absence never blocks finalization. Context is recomputed if time/zone/device/duration changes before finalization and frozen only at commit.

### Patch 9 — §5: write the actual durable sync contract

Add a route/auth matrix:

- GET catalog/vocab/templates/layouts.
- GET/POST/PUT/void entries.
- POST/PUT/deactivate custom vocab.
- CSV, canonical package/JSON, and ADAPT exports.
- Bearer auth on all; token-derived owner; zone/device ownership; 401 missing token and 404 cross-owner tests.

Replace “On final save” with:

> draft→final, accepted correction, and void are complete aggregate mutations. Under one BEGIN IMMEDIATE transaction the edge validates base version, assigns the next version, replaces values, freezes context/version pins, writes void state where applicable, inserts the outbox aggregate, and—when command-originated—stores the exact terminal command result and ACK-outbox row.

Add the exact command/event names from SYS-1, effect-key formats, payload schemas, and JOURNAL_ENTRY/ENTRY_UUID resource-watermark mapping. Define canonical value ordering/hash equality. Require custom vocab to arrive before dependent entries; parent missing is retryable.

Add:

> Bootstrap advertises field_journal_v1, catalog/version hashes and journal manifest; cloud leases only compatible commands. A resumable, count+byte-bounded journal snapshot reconstructs an empty mirror and reconciles counts/hashes.

Replace conflict UX with:

> Stale writes NACK with current version/hash and preserve the submitted cloud payload. Reload never discards it. The UI offers diff, edit/resend, valid save-as-new, or explicit discard.

### Patch 10 — §6: make the field workflow testable and safe

Add:

- A 56px zone-card Log activity CTA and dashboard Activity action.
- Six recent/common icon+label activities plus More; zone/crop/time preselected.
- The ≤5 activation SLA applies to a common carried-forward path from zone CTA to acknowledged save; test at 320×568 and 360×640.
- Numeric input always displays unit and repeats interpreted value/unit in final confirmation.
- Save-state wording and Drafts resume/discard behavior from UX-4.
- Carry-forward source must be at/before selected time and match season/layout; recalculate on time/layout change.
- No silent plant-protection product/rate/target/area/waiting-period carry-forward; use explicit Repeat last treatment.
- Separate Detail level and Growing setting controls. Template-hidden values remain inspectable. Layout-incompatible values require explicit resolution before finalization.
- Pending/rejected cloud records live in a Waiting for farm tray and are excluded from canonical views/exports.

### Patch 11 — §6.3–§6.4: define reading density and localization

Add:

- Final-only event lane; rendered-distance clustering with counts; 48px hit targets; activity and Journal visibility filters; icon/shape plus color; overflow counts in calendar.
- icon_key on activity data.
- Complete reviewed journal labels, units, validation/save/rejection messages in all enabled locales or an explicit visible fallback.
- AGROVOC labels are curation candidates, not automatically approved farmer copy.
- Native/agronomic review and CI coverage tests.

### Patch 12 — §7: add global robustness limits

Add the server-level caps from SEC-3 and state that template constraints can only be stricter. Reject oversize writes before the transaction; cap event batches by count and bytes.

Replace the canonical-unit bullet with the dimension/basis/entered-unit contract from Patch 5.

Replace the duplicate rule with:

> ±60 minutes is a per-activity default. Run after activity/time selection and again at finalization; show the matching entry’s time/key values with Open existing or Save separately; warn once per draft and disable duplicate submissions while Finish is in flight.

Replace “occurred_start zone-local” with the UTC+timezone snapshot contract.

### Patch 13 — §8: separate canonical research export from convenience pivot

Replace the CSV bullet with:

> Canonical package: entries.csv, values.csv, vocab_mappings.csv, manifest.json. values.csv preserves typed value, value_status, group_index, entered/canonical units, and pinned catalog/template/layout versions. Optional wide.csv is a convenience pivot with deterministic escaped columns and is not full fidelity.

Expand JSON:

> Include dataset/export UUID, generation and coverage times, source/gateway/farm/zone identifiers, edge-canonical provenance, exporter version/commit, schema/catalog/template/layout/context-generator versions and hashes, mapping sources/licenses, unit transformations, record counts, and payload/file checksums. Author identity is included only according to an explicit access/pseudonymization policy.

Replace the ADAPT bullet with:

> Export zone-linked final operational entries using pinned ADAPT Standard 1.0.0. Generate deterministic Catalog Field references, WorkRecords, Operations, Variables, SummaryValues, and ACTUAL UTC TimeScopes. Omit centroid coordinates because ADAPT Field has no point property; omit productIds unless valid Catalog Products are emitted. Validate the pinned root/DTD/unit artifacts plus semantic rules and negative fixtures. The six v1 operation codes are confirmed; fallback is triggered only if the named semantic profile cannot be satisfied by the target consumer.

Replace the observation rationale with the STD-6 wording.

### Patch 14 — §9: expand verification gates

Add tests for:

- Transaction crash points and stale base versions.
- Replay of stored APPLIED and REJECTED results.
- Equal-version same/different hash; lower/higher version; deterministic array order.
- Capability/catalog mismatch and old-edge command leasing.
- Poll→restart→lease-expiry recovery.
- Intact edge→empty cloud snapshot reconstruction with concurrent mutation.
- 10k entries/150k values query plans and streamed exports.
- DST gap/fold, unit/basis conversions, missingness, repeat groups, unsafe carry-forward, layout switch invalidation, save failure, and rejected-draft recovery.
- Auth/ownership, body/text limits, PII-safe logs, CSV formula/header/filename hardening.
- All migration/profile/seed/contract/outbox-retention gates from SYS-12.
- ADAPT pinned hashes, semantic linter, and negative mutations.
- Locale completeness and 0/1/50/500 marker-density cases.

### Patch 15 — §10: define feature-off and rollout semantics

Replace the feature-flag bullet with:

> fieldJournalUxEnabled controls UI visibility only and defaults false until schema/module/catalog readiness. When false, stored data, authenticated reads/exports, edge→cloud sync, and ACKs continue. A separate fieldJournalWritesEnabled kill switch, if needed, is enforced in REST and command apply with 503 feature_disabled. Capabilities/catalog versions prevent incompatible command leasing.

Add rollout gates: journal outbox pending/rejected/oldest age; command pending/rejected; last journal snapshot/reconciliation; installed catalog version; capability mismatch; no journal text or author names in diagnostics.

### Patch 16 — §11: move gates into the right slices

- **Slice 1:** includes the complete 0009/change-control work, unit and version contracts, transaction/outbox lifecycle, contracts/capabilities, bounded snapshot/recovery, auth module, and catalog seeds/hashes.
- **Slice 2:** includes the explicit save/rejection/draft workflow, safe carry-forward, layout-switch review, locale contract, and marker-density behavior.
- **Slice 3:** includes exact mirror/resource-watermark behavior, canonical research package/manifest, snapshot reconciliation, and cloud read access.
- **Slice 4:** includes capability-aware command leasing, durable local command handling, exact replay results, and recoverable rejected drafts.
- **Slice 5:** includes the pinned ADAPT profile, conversions/reference graph, semantic linter, and negative fixtures.

No slice is complete merely because its happy-path UI works; each must meet the relevant recovery and mismatch cases above.

## 6. Open questions for Phil

1. **What does full_record promise in v1?** Is it intended to serve as six-year ÖLN evidence with a seven-day completion rule, or only as a detailed record structurally ready for future profiles? This decides requiredness, reminders, and retention.
2. **Do any named v1 pilots record orchard/berry work per tree, row, or canopy/tree-row volume?** If yes, add orchard_berry_rows in D8 now; if no, confirm the open_field denominator fields and explicitly accept the limitation.
3. **Can v1 research contain two campaigns/protocol versions or multiple experimental units in the same zone and date range?** If yes, campaign/protocol/observation-unit identity is required in Slice 1; if no, document the one-campaign-per-zone limitation and its migration trigger.
4. **What is the tenant boundary for custom vocabulary—farm, linked user, or gateway?** A globally unique code is required regardless, but ownership/access and cloud sharing cannot be specified cleanly until this is chosen.
5. **Which named consumer must accept the ADAPT 1.0 export?** The standard permits several shapes; a target importer/profile is needed to settle product representation, required catalog objects, and the semantic acceptance fixture.
6. **Is field_journal a runtime per-gateway kill switch or a build/capability rollout marker?** The current feature endpoint is hardcoded; choosing one determines whether a new UCI setting is warranted and what “off” must enforce.

## 7. What is solid

Do not churn these parts:

- **Edge canonicality and the REST pending-command direction.** It matches the repo’s actual authority model.
- **One generic entry plus typed values.** With the added constraints, it handles the stated scale without another datastore or plugin subsystem.
- **Vocabulary/template/layout evolution as data.** Keep this principle; make catalog delivery/versioning explicit rather than reverting to schema-per-activity.
- **Orthogonal template × layout composition.** The missing piece is dependency/transition semantics, not a different abstraction.
- **Whole-entry aggregate sync and whole-entry conflict policy.** Atomicity, watermarks, and recovery need tightening; per-field merge does not.
- **Explicit draft→final and void-not-delete audit posture.**
- **Frozen sensor context next to human-entered typed values.** Add provenance/freshness; do not move context into load-bearing EAV fields.
- **Honest occurred versus recorded time and first-class backdating.** Store the occurrence as UTC plus its local-time context.
- **Pure osi-journal module with thin Node-RED glue and staged PR slices.**
- **D6’s no-phone-queue boundary.** It is defensible once save failure is honest.
- **D9’s six operational mappings.** ADAPT 1.0 contains all six; improve the profile and validation rather than dropping the exporter.
