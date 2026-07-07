# Schema-Driven Code Generation for osi-os ↔ osi-server

> **SUPERSEDED — do not implement.** Rejected by the accepted ADR
> [2026-06-30-schema-and-contract-ownership](../../adr/2026-06-30-schema-and-contract-ownership.md)
> after four independent expert reviews: no shared SQLite↔Postgres DDL generator;
> edge DDL is owned by ordered migrations, cloud DDL by Flyway, cross-repo
> compatibility by versioned sync contracts. Kept only as the reasoning record
> the ADR references. Its flip conditions are listed in the ADR.

**Status:** Superseded by ADR 2026-06-30 (was: Draft — spec)
**Created:** 2026-06-30
**Scope:** Both repos (osi-os canonical, osi-server mirror)

---

## 1. Problem

Every domain concept — device types, table columns, sync events, channel definitions, command types — is implemented twice: once in osi-os (SQLite + Node-RED JS + TypeScript) and once in osi-server (PostgreSQL + Flyway + Java + TypeScript). There is no single source of truth, no compile-time cross-check, and the partial sync contract (`docs/contracts/sync-schema/`) is incomplete and does not drive code generation.

Specific divergences found in audit:

| Area | Edge | Server | Risk |
|------|------|--------|------|
| Device types | 6 types in `CHECK`, `farming.ts` | 5 types in `DeviceType.java` | Missing types silently accepted (VARCHAR) |
| Sensor data | Flat `device_data` table, typed columns | Opaque `sensor_data` JSONB blob | Server can't validate column structure |
| Naming | `deveui`, `user_id`, `dendrometer_readings` | `device_eui`, `claimed_by_user_id`, `dendro_readings` | Manual mapping in sync layer, drift risk |
| Booleans | `INTEGER 0/1` | Mixed `BOOLEAN` / `INTEGER` | Type mismatch bugs |
| sync_outbox | Has v2 columns (`rejected_at`, etc.) | Does not have v2 columns | Schema drift within same concept |
| Channel manifest | None on edge | Identical copies in server backend + frontend `channels.json` | Adding a channel requires 2 manual edits |
| Dendro analytics | v5 TWD fields | v6 fields (`twd_rel`, `dendro_calibrations`) | Version skew |
| Sync contract | Partial: Zone, Device, Schedule only | Implements more event types than contract defines | Undocumented surface |

---

## 2. Decision

**Canonical YAML DSL** as single source of truth for all structural domain definitions. Generates SQLite DDL, Flyway migrations, Java entities, TypeScript types, JSON Schema contracts, and channel manifests. Generated artifacts are committed to both repos; no runtime dependency on the DSL or generators.

**Fallback:** JSON Schema extended to tables (option 4) is the alternative if the YAML DSL proves insufficient. The DSL is deliberately kept simple enough that migrating to JSON Schema would be a mechanical transformation of the same data, not a redesign.

**Excluded from scope:** Node-RED decoder logic (`codecs/*.js`), React components, Node-RED flows (`flows.json`), and any runtime business logic. These are behavioral, not structural.

---

## 3. Architecture

```
osi-os/
  schema/
    schema.yaml                    ← canonical source of truth
    generate.js                    ← parses schema.yaml, emits all artifacts
    verify-generated.js            ← CI guard: generated === committed
    type-mappings.js               ← shared mapping table (used by generate.js)
    
# Generated (committed, never edited by hand):
  database/seed-blank.sql          ← overwritten
  database/migrations/<ts>_gen.sql ← new migration when schema changes
  web/react-gui/src/types/farming.gen.ts
  docs/contracts/sync-schema/*.schema.json
  web/react-gui/src/channels/channels.json

osi-server/
  schema/
    schema.yaml                    ← byte-for-byte copy from osi-os
    generate.js                    ← byte-for-byte copy from osi-os
    verify-generated.js            ← byte-for-byte copy from osi-os
    type-mappings.js               ← byte-for-byte copy from osi-os

# Generated (committed, never edited by hand):
  backend/src/main/resources/db/migration/V<ts>__schema_gen.sql
  backend/src/main/java/org/osi/server/model/gen/*.java
  backend/src/main/resources/channels.json
  frontend/src/channels/channels.json
  docs/sync/*.schema.json
```

### Invariants

1. **schema.yaml is byte-identical across repos.** `verify-generated.js` checks this in both repos.
2. **Generated files are verified at CI time.** Any drift between generated and committed output fails the build.
3. **Hand-edited files that depend on generated content** (e.g., `flows.json` referencing `device_type` enum values) are checked by existing verify scripts — not by this tool. The generated enums provide compile-time signals but manual consumers remain manual.
4. **No runtime loading.** The `schema/` directory and `generate.js` are build/dev-time tools. Neither the Pi nor the VPS loads them.

---

## 4. YAML DSL Format

### 4.1 Type system

The DSL uses abstract type names. Generators map them to concrete types per target:

| DSL type | SQLite | PostgreSQL | TypeScript | Java |
|----------|--------|------------|------------|------|
| `pk` | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` | `number` | `Long` |
| `text` | `TEXT` | `VARCHAR(255)` | `string` | `String` |
| `integer` | `INTEGER` | `BIGINT` | `number` | `Long` |
| `real` | `REAL` | `DOUBLE PRECISION` | `number` | `Double` |
| `bool` | `INTEGER` | `BOOLEAN` | `boolean` | `Boolean` |
| `timestamp` | `TEXT` | `TIMESTAMPTZ` | `string` | `Instant` |
| `eui` | `TEXT UNIQUE NOT NULL` | `VARCHAR(32) UNIQUE NOT NULL` | `string` | `String` |
| `uuid` | `TEXT` | `VARCHAR(36)` | `string` | `String` |
| `fk` | `INTEGER` (plus FK clause) | `BIGINT` (plus FK clause) | `number` | `Long` |
| `json` | `TEXT` | `JSONB` | `object \| any` | `String` (JPA `@Column(columnDefinition="JSONB")`) |

Custom types (e.g., `text(100)` for VARCHAR(100)) are supported by the `precision` field on the column definition.

### 4.2 File structure

```yaml
# schema.yaml
meta:
  version: 1                          # increment on breaking DSL changes
  generated_at: auto                  # filled by generate.js

# --- ENUMS ---
enums:
  device_type:                        # generates: device_type enum in both repos
    values:
      - KIWI_SENSOR
      - TEKTELIC_CLOVER
      - DRAGINO_LSN50
      - SENSECAP_S2120
      - AQUASCOPE_LORAIN
      - STREGA_VALVE
      - GATEWAY
    annotations:                      # optional per-value metadata
      GATEWAY: { server_only: true }  # not emitted to edge TS/SQLite
      TEKTELIC_CLOVER: { edge_only: true }  # not emitted to server Java

  stress_level:
    values: [none, mild, moderate, significant, severe]

  trigger_metric:
    values: [SWT_1, SWT_2, SWT_3, SWT_AVG, SWT_WM1, SWT_WM2, DENDRO, VWC]

  # ... all other enums (see appendix)

# --- TABLES ---
tables:
  devices:
    server_name: devices              # only when different from key
    jpa_entity: Device                # Java entity class name
    ts_interface: Device              # TypeScript interface name
    description: "LoRaWAN device registry"

    columns:
      - name: id
        type: pk
        description: "Internal primary key"

      - name: deveui
        type: eui
        server_name: device_eui       # column name differs on server
        description: "LoRaWAN device EUI (16 hex chars)"

      - name: name
        type: text
        nullable: false
        default: "''"

      - name: type_id
        type: text(50)
        nullable: false
        check: "enum(device_type)"    # generates CHECK(type_id IN (...))

      - name: irrigation_zone_id
        type: integer
        nullable: true
        references: irrigation_zones.id
        on_delete: SET NULL

      - name: dendro_enabled
        type: bool
        default: false

      - name: sync_version
        type: integer
        nullable: false
        default: 0

      - name: deleted_at
        type: timestamp
        nullable: true
        description: "Soft-delete tombstone"

      # ... full column list

    indexes:
      - columns: [deveui]
        unique: true
      - columns: [irrigation_zone_id]
      - columns: [gateway_device_eui]

    # SQLite triggers (edge only — not emitted for server)
    triggers:
      sync_device_flags:
        on: UPDATE
        when: "OLD.sync_version IS NOT NULL AND OLD.sync_version <> NEW.sync_version"
        action: sync_outbox_enqueue
        params:
          aggregate_type: DEVICE
          aggregate_key_expr: "NEW.deveui"
          op: DEVICE_FLAGS_UPDATED

  # ... all other tables (~25 tables)

# --- CHANNELS ---
channels:
  swt_1:
    card_type: soil
    label: "SWT Channel 1"
    unit: kPa
    provided_by: [KIWI_SENSOR, TEKTELIC_CLOVER]   # device types that produce this
    legacy_aliases: [swt_wm1]

  ambient_temperature:
    card_type: environment
    label: "Ambient Temperature"
    unit: "°C"
    provided_by: [KIWI_SENSOR, TEKTELIC_CLOVER, DRAGINO_LSN50]
    legacy_aliases: [temperature]

  # ... all channels

# --- SYNC EVENTS ---
sync_events:
  - aggregate_type: DEVICE
    op: DEVICE_ASSIGNED
    source_table: devices
    trigger: "irrigation_zone_id changed"
    payload_shape: Device              # references table definition
    direction: edge_to_cloud

  - aggregate_type: DEVICE_DATA
    op: DEVICE_DATA_APPENDED
    source_table: device_data
    trigger: INSERT
    payload_shape: SensorData
    direction: edge_to_cloud

  # ... all event types

# --- COMMAND TYPES ---
commands:
  - type: OPEN_FOR_DURATION
    required_params: [duration_seconds]
    actuator: true
    direction: cloud_to_edge

  - type: REGISTER_DEVICE
    required_params: []
    actuator: false
    direction: cloud_to_edge

  # ... all command types
```

---

## 5. Generators

`generate.js` is a single Node.js script (~300-500 lines). It reads `schema.yaml`, validates it against a JSON Schema for the DSL itself, and calls emitter functions for each target.

### 5.1 Emitters (in order)

1. **sqlite-ddl.js** → `database/seed-blank.sql`
2. **flyway-migration.js** → `osi-server/.../V<timestamp>__schema_gen.sql`
3. **typescript-types.js** → `web/react-gui/src/types/farming.gen.ts`
4. **java-entities.js** → `osi-server/.../model/gen/*.java`
5. **json-schemas.js** → `docs/contracts/sync-schema/*.schema.json`
6. **channels-json.js** → `*/src/channels/channels.json` (both repos)

Each emitter gets the parsed and validated schema object. Emitters are pure functions: `(schema) => { filename: string, content: string }[]`.

### 5.2 Edge-only vs server-only filtering

Schema annotations (`server_only`, `edge_only`) are resolved during emission:
- A column marked `server_only: true` is omitted from SQLite DDL and TS types
- A column marked `edge_only: true` is omitted from Flyway SQL and Java entities
- An enum value with `server_only: true` is omitted from the edge TS enum

### 5.3 Migration generation (Flyway)

For Flyway, the generator produces **one migration per schema change** using a date-based version prefix (`V2026_06_30_001__schema_gen.sql`). The script diffs against the previous generation output to include only `ALTER TABLE ... ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` statements. Initial generation produces a full `CREATE TABLE` script.

For SQLite on the edge, the generator produces the full `seed-blank.sql` (used for fresh devices). Live-device schema updates continue to use `repair-pi-schema.js`, updated by hand, because idempotent repair involves environment-specific logic (checking if a Pi is provisioned, backing up before column adds, etc.).

---

## 6. Verification

### 6.1 `verify-generated.js`

Run in CI on both repos. It:

1. Runs `generate.js` in a temp directory
2. Diffs every generated file against the committed version
3. Fails if any diff exists — the generated file is stale

This prevents manual edits to generated files from persisting.

### 6.2 Parity check (cross-repo)

`verify-generated.js` in osi-os also:

1. Runs `sha256sum` on `schema/schema.yaml`
2. Runs `sha256sum` on `schema/generate.js` and `schema/type-mappings.js`
3. Compares against the same hashes in the osi-server repo
4. Fails if hashes differ — the contract has drifted

This replaces the current manual parity between `bcm2712/` and `bcm2709/` profiles (which are image-build artifacts, not schema artifacts) and extends the pattern to cross-repo sync.

### 6.3 Existing verifiers (unchanged)

- `scripts/verify-sync-flow.js` — validates sync logic in flows.json (stays)
- `scripts/verify-db-schema-consistency.js` — now checks that the live `farming.db` matches the generated `seed-blank.sql`
- `scripts/verify-profile-parity.js` — image profile parity (stays)
- `scripts/check-mqtt-topics.sh` — MQTT topic compliance (stays)

---

## 7. Migration Strategy

### Phase 1: Scaffold (1 PR per repo)

- Create `schema/` directory with `schema.yaml`, `generate.js`, `verify-generated.js`, `type-mappings.js`
- Populate `schema.yaml` from the current state — read existing `seed-blank.sql`, `farming.ts`, Java entities, `channels.json`, and sync contracts
- Run `generate.js` and commit the output
- Add `verify-generated.js` to CI
- **No functional change.** Generated output matches current state byte-for-byte (or as close as possible — nits like comment ordering, whitespace).

### Phase 2: Stabilize (1 PR per repo)

- Fix any generator bugs exposed by Phase 1
- Address naming inconsistencies (pick canonical name, add `server_name` / `edge_name` aliases)
- Ensure existing verifiers pass against generated output

### Phase 3: Cut over (1 PR per repo)

- Remove hand-maintained duplicate definitions:
  - `database/seed-blank.sql` → replaced by generated version
  - Hand-edited Flyway migrations stop; new migrations come from generator
  - `web/react-gui/src/types/farming.ts` → enums and entity shapes imported from `farming.gen.ts`
  - Java entity classes → moved to `model/gen/` directory, annotated `@Generated`
  - `channels.json` in both repos → replaced by generated version
- Update AGENTS.md in both repos

### Phase 4: Enforce (ongoing)

- `verify-generated.js` runs on every CI build in both repos
- Cross-repo hash check on `schema.yaml` detects contract drift immediately
- New device types, columns, or sync events go through `schema.yaml` first

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| DSL is too rigid for a future edge case | DSL has escape hatches: `raw_sql` column type, `custom_annotation` map for per-target overrides. Generators pass these through. |
| YAML grows too large (>1000 lines) | Split into per-domain files with includes (`schema/` directory, `schema.yaml` as index). The format supports this but Phase 1 uses a single file for simplicity. |
| Generator emits wrong SQL on edge → data loss | Phase 1 is byte-identical to current state. Phase 2-3 diffs are hand-reviewed before commit. `repair-pi-schema.js` remains the safety layer for live-device schema changes — it is updated by hand, not auto-generated. |
| Contributors edit generated files by mistake | `verify-generated.js` fails CI. Files have a `@generated` header comment. `.gitattributes` can mark them as generated in diffs. |
| Cross-repo schema.yaml divergence | Hash check in `verify-generated.js`. Also: `scripts/verify-sync-flow.js` already runs in CI and would catch protocol-level drift. |
| Java type mapping is lossy (e.g., `json` → `String`) | Acceptable. The JPA entity is the persistence layer. DTOs for API responses are hand-written and can use richer types. The generated entity is the lower bound, not the upper bound. |
| Flyway migration ordering conflicts with hand-written migrations | Generator uses date-based versioning with seconds precision. Phase 2 establishes the convention: all structural migrations go through the generator; behavioral migrations (data backfill, index tuning) remain hand-written with distinct version prefixes. |

### Fallback to Option 4 (JSON Schema extended to tables)

If the YAML DSL proves insufficient, the same data can be expressed as JSON Schema with table-level extensions. The generators would parse the JSON Schema instead of YAML. The architecture (generate → commit → verify) is identical; only the source format changes. This is a mechanical conversion, not a redesign, because:

1. The semantic content (tables, columns, types, enums, channels, events) is the same
2. The emitter pipeline is format-agnostic (it receives a parsed object, not raw YAML)
3. YAML and JSON Schema are both declarative key-value formats

The condition for switching: if a future requirement needs JSON Schema's native `$ref`, `allOf`, or `if/then` capabilities for validation logic that can't be cleanly expressed in the YAML DSL. The DSL already covers this via `check`, `when`, and `condition` fields; the fallback exists for edge cases those can't handle.

---

## 9. Appendix: Full enum and table inventory

### Enums (complete list from current state)

```
device_type, lsn50_mode, strega_model, dendro_mode_used,
dendro_baseline_mode_used, scheduling_mode, trigger_metric,
scheduler_type, stress_level, data_quality, irrigation_action,
prediction_run_status, prediction_day_phase, soil_profile_status,
command_status, sync_event_result_status, user_role,
linked_gateway_account_sync_status, gateway_location_status,
calibration_status, reconciliation_state, tree_state_v5,
card_type, bucket_level, coverage_confidence, scope_type,
valve_state (OPEN/CLOSED), response_mode
```

### Tables (complete list, ~28 tables)

```
users, farms, devices, device_data, irrigation_zones,
irrigation_schedules, irrigation_events, actuator_log,
dendrometer_readings, dendrometer_daily, dendro_baselines,
weather_station_zones, zone_daily_recommendations,
zone_daily_environment, zone_irrigation_state, zone_weather_cache,
zone_shared_environment, zone_irrigation_calibration, zone_seasons,
zone_season_configs, chameleon_readings, chameleon_calibrations,
chameleon_calibration_misses, valve_actuation_expectations,
applied_commands, command_ack_outbox, gateway_locations,
field_tester_uplinks, field_tester_rxinfo,
history_channel_rollups, history_card_preferences, history_workspaces,
sync_outbox, sync_inbox, sync_cursor, sync_link_state
```

Server-only tables: `zone_field_geometries`, `zone_sensor_anchors`, `zone_soil_profiles`, `linked_gateway_accounts`, `zone_prediction_configs`, `zone_prediction_runs`, `zone_prediction_days`, `zone_prediction_reference_*`, `zone_prediction_shadow_*`, `dendro_calibrations`, `edge_history_*`, `sync_resource_watermarks`, `analysis_views`

---

## 10. Rejected alternatives

### A. Protocol Buffers as source of truth
Protobuf excels at RPC message definitions but is poor at expressing SQL constraints (CHECK, FK cascades, indexes, default values). You'd need custom options for all of that, essentially building the same DSL inside protobuf comments. Rejected because the DSL's primary consumers are databases, not RPC transports.

### B. Prisma schema as source of truth
Prisma's schema language is SQL-database-aware and has a mature migration engine. However, it targets Node.js ORMs, not Java/JPA. Generating JPA entities from Prisma would require a custom reverse-engineering step. Also, Prisma migrations assume Prisma manages the DB lifecycle; osi-server uses Flyway. Rejected as too Node.js-centric for a cross-language project.

### C. GraphQL schema as source of truth
GraphQL SDL can express types and enums but not storage concerns at all (indexes, FKs, cascades, triggers). It would cover the TypeScript/Java type generation but leave database generation to a separate mechanism. Rejected because it doubles the number of source-of-truth files instead of reducing them.

### D. SQL standard as source of truth (parse both dialects)
Write canonical SQL and use a parser/transpiler to emit SQLite and PostgreSQL variants. Rejected because SQL dialects have fundamentally incompatible features (SQLite has no BOOLEAN, PostgreSQL has no INTEGER PRIMARY KEY AUTOINCREMENT, CHECK constraint syntax differs, trigger syntax differs completely). The result would be SQL with escape hatches — a DSL in disguise.

---

## 11. References

- [AGENTS.md § "Adding a new device type"](../../AGENTS.md#adding-a-new-device-type) — current 8-step manual process
- [ADR — Static device plugin registry](../../docs/adr/2026-05-28-static-device-plugin-registry.md) — plugin registry deferred
- [Sync schema contracts](../../docs/contracts/sync-schema/README.md) — existing partial contracts
- [History sync spec](./2026-06-28-edge-cloud-history-sync.md) — referenced cross-repo entity paths
