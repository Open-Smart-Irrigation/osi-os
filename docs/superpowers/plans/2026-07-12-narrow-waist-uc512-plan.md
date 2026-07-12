# Implementation Plan — Narrow-Waist Ingest with UC512 Pilot

**Spec:** [`2026-07-12-narrow-waist-uc512-design.md`](../specs/2026-07-12-narrow-waist-uc512-design.md)
**Refactor-program items:** 3.1 + 3.2 + 3.3
**Branch:** `feat/narrow-waist-uc512`
**Estimated tasks:** 14 (sequenced by dependency)

## Task sequence

### Task 1 — `ingest_quarantine` table (migration 0009)

**Files:**
- `database/migrations/ordered/0009__ingest_quarantine.sql` (CREATE)
- `database/migrations/ordered/CHECKSUMS.json` (UPDATE)
- `database/seed-blank.sql` (UPDATE — add table + index)
- All 7 bundled `farming.db` copies (REBUILD)
- `scripts/verify-db-schema-consistency.js` (UPDATE — add ingest_quarantine assertions)

**Steps:**
1. Write migration SQL per spec §C (table + index, `-- risk: additive`). Note: NO FK on `deveui` — quarantine must accept data from unregistered devices.
2. Add to `seed-blank.sql` after the existing tables.
3. Rebuild all 7 bundled DBs: `node scripts/rebuild-bundled-dbs.js` (or manual `sqlite3` apply).
4. Update CHECKSUMS.json with the new migration's SHA-256.
5. Extend `verify-db-schema-consistency.js` to assert `ingest_quarantine` exists with the correct columns in all bundled DBs and seed-blank.
6. Run `node scripts/verify-db-schema-consistency.js` — must pass.

**Verification:** `verify-db-schema-consistency.js` green; `node --test` on any new tests.

### Task 2 — `MILESIGHT_UC512` device type (migration 0010)

**Files:**
- `database/migrations/ordered/0010__add_milesight_uc512_type.sql` (CREATE)
- `database/migrations/ordered/CHECKSUMS.json` (UPDATE)
- `database/seed-blank.sql` (UPDATE — CHECK constraint)
- All 7 bundled `farming.db` copies (REBUILD)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` — `sync-init-fn` `REQUIRED_TYPES` (UPDATE, both profiles)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` — mirror
- `scripts/verify-runtime-schema-parity.js` (UPDATE)
- `scripts/verify-db-schema-consistency.js` (UPDATE)
- `scripts/verify-devices-rebuild-fence.js` (UPDATE)
- `scripts/rehearse-devices-rebuild.test.js` (UPDATE)

**Steps:**
1. Write destructive migration: rebuild `devices` table with new CHECK including `'MILESIGHT_UC512'`. Mark `-- risk: destructive`.
2. Update `seed-blank.sql` CHECK constraint.
3. Write one-shot Node script (scratchpad) to update `sync-init-fn` on both profile flows.json copies — THREE surfaces (C3 sanctioned exception):
   - `REQUIRED_TYPES` array: add `'MILESIGHT_UC512'`
   - `DEVICES_NEW_DDL`: add `'MILESIGHT_UC512'` to the CHECK constraint in the `CREATE TABLE IF NOT EXISTS devices_new` string
   - `DEVICES_COPY_SQL`: verify column list matches seed-blank (no new device columns in this item, but confirm)
   Roundtrip-guard before and after.
4. Rebuild all 7 bundled DBs.
5. Update CHECKSUMS.json.
6. Extend all 4 verifiers/rehearse tests to include `MILESIGHT_UC512`.
7. Run: `verify-db-schema-consistency.js`, `verify-runtime-schema-parity.js`, `verify-devices-rebuild-fence.js`, `rehearse-devices-rebuild.test.js`, `verify-sync-flow.js`.

**Verification:** All 5 verification scripts green; profile parity check green.

### Task 3 — Channel-per-zone schema (migration 0011)

**Files:**
- `database/migrations/ordered/0011__zone_valve_assignments.sql` (CREATE)
- `database/migrations/ordered/CHECKSUMS.json` (UPDATE)
- `database/seed-blank.sql` (UPDATE)
- All 7 bundled `farming.db` copies (REBUILD)
- `scripts/verify-db-schema-consistency.js` (UPDATE)

**Steps:**
1. Write additive migration per spec §F: `CREATE TABLE IF NOT EXISTS zone_valve_assignments (...)` (junction table with zone_id, deveui, valve_channel), indexes, and `ALTER TABLE valve_actuation_expectations ADD COLUMN valve_channel INTEGER;`.
2. Update seed-blank.sql: add the `zone_valve_assignments` CREATE TABLE + indexes, and add `valve_channel` column to `valve_actuation_expectations` CREATE TABLE.
3. Rebuild bundled DBs. Update CHECKSUMS.
4. Extend `verify-db-schema-consistency.js` for the new table and column.

**Verification:** `verify-db-schema-consistency.js` green.

### Task 4 — UC512 `device_data` columns (migration 0012)

**Files:**
- `database/migrations/ordered/0012__uc512_device_data_columns.sql` (CREATE)
- `database/migrations/ordered/CHECKSUMS.json` (UPDATE)
- `database/seed-blank.sql` (UPDATE)
- All 7 bundled `farming.db` copies (REBUILD)
- `scripts/verify-db-schema-consistency.js` (UPDATE)

**Steps:**
1. Write additive migration: 5 ALTER TABLE statements per spec §G.
2. Update seed-blank.sql CREATE TABLE for device_data.
3. Rebuild bundled DBs. Update CHECKSUMS.
4. Extend `verify-db-schema-consistency.js`.

**Verification:** `verify-db-schema-consistency.js` green.

### Task 5 — LSN50 shadow diff table (migration 0013)

**Files:**
- `database/migrations/ordered/0013__lsn50_shadow_diff.sql` (CREATE)
- `database/migrations/ordered/CHECKSUMS.json` (UPDATE)
- `database/seed-blank.sql` (UPDATE)
- All 7 bundled `farming.db` copies (REBUILD)

**Steps:**
1. Write additive migration per spec §K.
2. Update seed-blank, rebuild DBs, update CHECKSUMS.

**Verification:** `verify-db-schema-consistency.js` green.

### Task 6 — `channels.json` expansion (UC512 + LSN50 unmapped)

**Files:**
- `web/react-gui/src/channels/channels.json` (UPDATE — ~23 new entries)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js` — `ALLOWED_DEVICE_DATA_CHANNELS` and `LEGACY_CHANNEL_ALIASES` if affected
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js` — mirror
- Possibly `web/react-gui/src/channels/registry.ts` if the registry needs updating

**Steps:**
1. Add 5 UC512 channel entries per spec §G table.
2. Enumerate all 18 unmapped LSN50 columns from `lsn50-sql-fn` (spec §ground truth 3). For each, add a manifest entry with appropriate `unit`, `category`, `cardType`, and `exportable` (diagnostic columns → `false`; flow/rain counters → `true`).
3. Update `ALLOWED_DEVICE_DATA_CHANNELS` in `osi-history-helper` to include the new channel keys.
4. **Update `VALID_EXPORT_CHANNEL_KEYS`** in the CSV export route (flows.json) for any new `exportable: true` channels (e.g. `pipe_pressure_kpa`). (M8)
5. **Update `analysis.js CHANNELS`** list if it gates on a hardcoded channel set. (M8)
6. Mirror history helper to bcm2709.
7. Run `node scripts/verify-channel-manifest-parity.js` — must pass.

**Verification:** `verify-channel-manifest-parity.js` green; `node scripts/test-history-helper.js` green.

### Task 7 — Edge manifest build + delivery

**Files:**
- `scripts/build-edge-manifest.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/edge-channels.json` (CREATE — generated)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/edge-channels.json` (CREATE — mirror)
- `scripts/verify-channel-manifest-parity.js` (UPDATE — add edge manifest parity check)
- `deploy.sh` (UPDATE — deliver edge-channels.json)

**Steps:**
1. Write `build-edge-manifest.js`: reads `channels.json`, writes `edge-channels.json` with `{ key, edgeField, unit }` for entries where `edgeField ≠ null`.
2. Run the build to generate both profile copies.
3. Extend `verify-channel-manifest-parity.js` to assert edge copy matches source.
4. Add `edge-channels.json` delivery to `deploy.sh` alongside helper modules.
5. Add `edge-channels.json` to `98_osi_node_red_seed` for fresh-image seeding (M10).
6. Add `build-edge-manifest.js` to CI (or a pre-commit check).

**Verification:** `verify-channel-manifest-parity.js` green with edge manifest check.

### Task 8 — `osi-device-writer` module

**Files:**
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/package.json` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/` (MIRROR)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js` (UPDATE — add `NAME_TO_PATH` entry)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.js` (MIRROR)
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/package.json` (UPDATE — add local dep)
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/package-lock.json` (REGENERATE)
- `conf/.../files/etc/init.d/98_osi_node_red_seed` (UPDATE — seed helper on fresh image, M9)
- `deploy.sh` (UPDATE — deliver osi-device-writer, M9)
- `scripts/verify-helper-registration.js` (UPDATE if needed)

**Steps:**
1. Implement `writeDeviceData(db, manifest, normalizeResult, meta, options)` per spec §B:
   - Resolve channels → manifest → edgeField → column
   - Centralized `clampRecordedAt` (same floor/skew as KIWI)
   - Parameterized INSERT with `?` placeholders
   - Column validation against cached `PRAGMA table_info(device_data)`
   - Dead-letter to `ingest_quarantine` for unmapped/unknown/server-only channels
   - Row-cap eviction (~1000)
   - Shadow mode: compute without INSERT when `options.shadow === true`
   - `node.error()` on hard errors
2. Write co-located tests (`index.test.js`) using `node:test`:
   - Happy path: known channels written correctly
   - Unknown channel dead-lettered
   - Server-only channel dead-lettered
   - Non-existent edgeField → hard error
   - Timestamp clamp applied
   - Shadow mode returns row without INSERT
   - SQL-hostile values handled correctly (parameterization)
   - Row-cap eviction works
3. Register in `osi-lib/index.js` `NAME_TO_PATH`: `'device-writer': 'osi-device-writer'`.
4. Add to `package.json` as a local dependency; regenerate `package-lock.json`.
5. Add to `98_osi_node_red_seed` init script and `deploy.sh` delivery section (M9).
6. Mirror all files to bcm2709.
7. Run `node --test` on the test file; run `verify-helper-registration.js`.

**Verification:** `node --test conf/.../osi-device-writer/index.test.js` green; `verify-helper-registration.js` green; `verify-profile-parity.js` green.

### Task 9 — UC512 codec

**Files:**
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/milesight_uc512_decoder.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/milesight_uc512_decoder.js` (MIRROR)
- `scripts/fixtures/device-integration/uc512/` (CREATE — golden vectors)
- `deploy.sh` (UPDATE — add `fetch_required` for UC512 codec, H7)

**Steps:**
1. Adapt Milesight's public `uc512-decoder.js` to the OSI codec pattern:
   - Keep the `decodeUplink(input)` → `{ data: decoded }` interface (matches existing codecs)
   - Strip non-essential helper functions if they don't affect decode correctness
   - Add header citing Milesight source + MIT license
2. Create golden vector fixtures from Milesight docs: at least 3 vectors covering battery + valve states, pulse counters, pressure, and a multi-field combined uplink.
3. Write a downlink encode function (for the command path): `encodeValveTask({ valve_index, valve_status, duration, sequence_id })` → byte array. Include a guard that rejects `duration === 0` for `valve_status === 'open'` (DD17 safety, M3).
4. Add `fetch_required` line for `codecs/milesight_uc512_decoder.js` in `deploy.sh` alongside existing codec deliveries (H7).
5. Mirror codec to bcm2709.

**Verification:** Golden vectors decode correctly; downlink encode produces expected bytes; `duration=0` rejected.

### Task 10 — UC512 normalizer (`osi-uc512-normalize`)

**Files:**
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.test.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/package.json` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-uc512-normalize/` (MIRROR)
- `conf/.../osi-lib/index.js` (UPDATE — add `NAME_TO_PATH` entry, both profiles)
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/package.json` (UPDATE — add local dep)
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/package-lock.json` (REGENERATE)
- `conf/.../files/etc/init.d/98_osi_node_red_seed` (UPDATE — seed helper, M9)
- `deploy.sh` (UPDATE — deliver module, M9)

**Steps:**
1. Implement `normalize(decoded, meta)` → `{ channels, unknown }` per spec §E table.
2. Map UC512 decoded fields to manifest keys: `battery → bat_pct`, `valve_1 → valve_1_state`, etc.
3. Route GPIO, task status, and device metadata to `unknown`.
4. Write co-located tests with golden vectors (reuse from Task 9).
5. Register in `osi-lib`: `'uc512-normalize': 'osi-uc512-normalize'`.
6. Add to `package.json`, `98_osi_node_red_seed`, `deploy.sh` (M9).
7. Mirror to bcm2709.

**Verification:** `node --test` green; `verify-helper-registration.js` green.

### Task 11 — LSN50 normalizer (`osi-lsn50-normalize`)

**Files:**
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/package.json` (CREATE)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lsn50-normalize/` (MIRROR)
- `conf/.../osi-lib/index.js` (UPDATE — add `NAME_TO_PATH` entry, both profiles)
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/package.json` (UPDATE — add local dep)
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/package-lock.json` (REGENERATE)
- `conf/.../files/etc/init.d/98_osi_node_red_seed` (UPDATE — seed helper, M9)
- `deploy.sh` (UPDATE — deliver module, M9)

**Steps:**
1. **Before writing:** capture golden vectors from the existing `lsn50-sql-fn` node. Extract at least 4 representative `msg.formattedData` snapshots covering: (a) standard soil mode (SWT channels), (b) dendro mode, (c) rain/flow mode (detectedMode=9), (d) Chameleon-attached.
2. Implement `normalize(decoded, meta)` reproducing the exact same field mapping as `lsn50-sql-fn` (all 36 columns → manifest keys, using the expanded manifest from Task 6).
3. This is behavior-preserving extraction — the test suite asserts output-equivalence with the golden vectors.
4. Register in `osi-lib`: `'lsn50-normalize': 'osi-lsn50-normalize'`.
5. Add to `package.json`, `98_osi_node_red_seed`, `deploy.sh` (M9).
6. Mirror to bcm2709.

**Verification:** `node --test` green; golden vector output matches old path exactly.

### Task 12 — Flows.json: UC512 ingest + command wiring + LSN50 shadow

**Files:**
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (UPDATE via one-shot script)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (MIRROR)
- `scripts/verify-flows-size-ratchet-allowances.json` (UPDATE — allowances for new nodes)
- `scripts/test-flows-wiring.js` (UPDATE — add UC512 wiring assertions)

**Steps:**
1. Write one-shot Node mutation script (scratchpad) to add/modify:
   - **UC512 Normalize + Write** function node: classification by `CHIRPSTACK_PROFILE_UC512`, loads normalizer + writer via `osiLib`, opens/closes `osiDb.Database`. Wire from MQTT device-type classification.
   - **UC512 Command Encode** function node: builds `setValveTask` payload from command infrastructure, encodes to ChirpStack downlink. Reads `valve_channel` from `zone_valve_assignments`.
   - **Update 3 existing command-path choke points (C2):**
     (a) `Build actuator_command + DB writes` (`dde8e1ef265e96d7`): accept `MILESIGHT_UC512` alongside `STREGA_VALVE`, read `valve_channel` from `zone_valve_assignments` for UC512.
     (b) `Route Command` (`934bf2bc19a8ce22`): at the `OPEN_FOR_DURATION` branch, detect UC512 device type and route to UC512 encode output.
     (c) Valve endpoint flow: allow UC512 type through the type gate.
   - **Write UC512 expectation node:** new node or extension of `write-strega-expectation` to write VAE rows with `valve_channel` for UC512 commands (M11).
   - **LSN50 Shadow Compare** function node: wired SEQUENTIALLY after `lsn50-sql-fn` output (not in parallel, H4). Runs LSN50 normalizer, compares normalize-level output against old path's `msg.formattedData`, writes per-field diffs to `lsn50_shadow_diff`.
   - **Update scheduler query** (`Build zones query`, `a0a61f4b7dca1c2e`): extend to look up UC512 valve via `zone_valve_assignments` alongside the existing STREGA subquery, returning `valve_channel`.
2. Roundtrip guard before and after mutation. Write both profiles.
3. Add Command Type Registry entry: `UC512_OPEN_FOR_DURATION` with `actuator: true, requires_duration: true`. Update all `COMMAND_TYPES_FALLBACK` copies.
4. Update `verify-flows-size-ratchet-allowances.json` with allowances for the new/modified nodes.
5. Update `test-flows-wiring.js` with UC512 wiring assertions (valve endpoint accepts UC512, route command has UC512 output, expectation node writes valve_channel).
6. Run: `verify-sync-flow.js`, `test-flows-wiring.js`, `verify-profile-parity.js`, `verify-command-safety.js`, `verify-flows-size-ratchet.js`.

**Verification:** All 5 flow verification scripts green.

### Task 13 — ChirpStack bootstrap + React minimal surface

**Files:**
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js` (UPDATE)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js` (MIRROR)
- `web/react-gui/src/types/farming.ts` (UPDATE — `DeviceType` union)
- `conf/.../flows.json` — `catalog-response` node (UPDATE via one-shot script)

**Steps:**
1. Add to `chirpstack-bootstrap.js`:
   - `UC512_CODEC_PATH` env var → `codecs/milesight_uc512_decoder.js`
   - `CS_PROFILE_UC512_NAME` → `'Milesight UC512'`
   - `getOrCreateProfileWithCodec()` call for UC512
   - `CHIRPSTACK_PROFILE_UC512` output in `.chirpstack.env`
2. Add `'MILESIGHT_UC512'` to `DeviceType` union in `farming.ts`.
3. Update `catalog-response` node via one-shot script to include UC512 in the catalog list.
4. Update `AddDeviceModal` / `IrrigationZoneCard` to show valve_channel selector when UC512 is selected.
5. Mirror bootstrap to bcm2709.

**Verification:** `npm run build` in `web/react-gui` succeeds; `npm run test:unit` green (if any type tests); profile parity green.

### Task 14 — `verify-device-integration.js` round-trip gate (3.2)

**Files:**
- `scripts/verify-device-integration.js` (CREATE)
- `scripts/fixtures/device-integration/uc512/*.json` (from Task 9)
- `scripts/fixtures/device-integration/lsn50/*.json` (from Task 11)
- `.github/workflows/migrations.yml` (UPDATE — add CI step)

**Steps:**
1. Implement the 6-assertion round-trip gate per spec §N:
   - For each registered device (UC512, LSN50): load codec golden vectors, run through normalize → writeDeviceData against a scratch DB seeded from `seed-blank.sql`.
   - Assert: closed vocabulary, exact column set (per-vector, not global — LSN50 has mode-dependent column counts, L15), empty unknown on valid vectors, zero DDL, parameterization safety, downlink encoding (UC512 only).
   - LSN50 must have at least one golden vector per mode: soil, dendro, rain/flow (L15).
2. Wire into CI: add `node scripts/verify-device-integration.js` to `migrations.yml`.
3. Run locally and confirm green.

**Verification:** `node scripts/verify-device-integration.js` green; CI workflow updated.

## Task dependency graph

```
Task 1 (quarantine) ──┐
Task 2 (device type) ─┤
Task 3 (valve_channel)┤
Task 4 (DD columns) ──┤── Tasks 1-5 are schema (sequential, each rebuilds DBs)
Task 5 (shadow diff) ─┘
                        │
Task 6 (channels.json) ─┤── Task 6 can start after Task 4 (needs column names)
Task 7 (edge manifest) ─┤── Task 7 depends on Task 6
                        │
Task 8 (writer) ────────┤── Task 8 depends on Tasks 1, 6, 7 (quarantine table, manifest)
Task 9 (UC512 codec) ───┤── Task 9 is independent
Task 10 (UC512 norm) ───┤── Task 10 depends on Tasks 6, 9
Task 11 (LSN50 norm) ───┤── Task 11 depends on Task 6
                        │
Task 12 (flows.json) ───┤── Task 12 depends on Tasks 8, 9, 10, 11 (all modules ready)
Task 13 (ChirpStack+React)─┤── Task 13 depends on Task 9 (codec file exists)
                        │
Task 14 (round-trip gate)──── Task 14 depends on Tasks 8, 9, 10, 11 (all modules + vectors)
```

**Parallelizable:** Tasks 1-5 are sequential (each rebuilds DBs). Task 9 (codec) is independent and can start immediately. After schema tasks complete, Tasks 6-7 and 8 can overlap. Tasks 10, 11 can overlap after 6 and 9 are done.

## PR strategy

Given the L size, consider splitting into 2-3 stacked PRs:

1. **PR A (schema + manifest):** Tasks 1-7 — all migrations, channels.json expansion, edge manifest. Pure additive schema + config, no behavioral change.
2. **PR B (modules + flows + gate):** Tasks 8-14 — writer, normalizers, codec, flows.json wiring, ChirpStack, React surface, round-trip gate. The behavioral change.

Or a single PR if review capacity allows — the item is designed as one indivisible delivery.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migration 0010 (destructive CHECK rebuild) fails on live DB | Rehearse on gateway DB copy before any deploy (DD9 runner) |
| UC512 uplink format differs from public decoder | Golden vectors from Milesight docs; verify against real hardware when available |
| LSN50 shadow produces non-zero diffs | Expected — the ~18 unmapped columns need manifest rows first (Task 6). After Task 6, diffs should converge to zero. Shadow compares at normalize level to avoid clampRecordedAt divergence noise (H4) |
| Edge manifest delivery gap (deploy.sh not updated) | Task 7 explicitly adds deploy.sh delivery; Task 9 adds codec delivery (H7); round-trip gate catches manifest-code divergence |
| `sync-init-fn` boot-node edit | Sanctioned exception: REQUIRED_TYPES + DEVICES_NEW_DDL CHECK + DEVICES_COPY_SQL verification (C3); no other boot-node changes |
| UC512 telemetry not synced to cloud | Intentional: outbox trigger update deferred to 3.4 (server applier). UC512 data is edge-only until then (H6) |
| Command path choke points block UC512 actuation | Three existing nodes must be updated (C2): valve endpoint type gate, Route Command routing, Build actuator_command |
| `json_object` arg count approaching SQLite limit | Currently ~102 args; 5 new columns would push to ~112. OpenWrt default is 127 (L14). Verify at implementation time |
