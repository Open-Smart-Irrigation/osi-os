# History Sync Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate the review findings without weakening edge/server data parity: legacy event/bootstrap paths remain the durable sync path until the new history batch path performs real durable mirror writes.

**Architecture:** Treat this as a stabilization patch, not the durable cutover. Restore/gate legacy outbox coverage for every table that the new batch path does not durably mirror, keep history batches in shadow validation mode, make shadow progress observable without advancing durable ACKs, and fail closed on missing auth or unsupported protocol states. Only after these fixes pass should a later plan remove legacy telemetry outbox triggers.

**Tech Stack:** Node-RED `flows.json`, SQLite seed/migration SQL, Node helper scripts, Java Spring Boot sync controller/service/repositories, Gradle/JUnit/Mockito.

---

## Current Decision

Do **not** remove any legacy telemetry/derived/irrigation outbox trigger in this remediation. The new history batch path does not yet durably write cloud mirrors for all raw tables, and the server-side durable apply path is incomplete. The safe state is:

- Offline/unlinked hubs produce **zero** `sync_outbox` messages.
- Linked hubs continue to use legacy event/bootstrap paths as the durable sync path.
- The new history batch path runs as shadow validation only, with its own shadow cursor.
- Durable history ACKs are impossible until the server explicitly advertises and implements `history_mirror_write_v1_confirmed`.

## File Map

Edge repo, branch `feat/history-sync-v1-edge`:

- Modify `database/seed-blank.sql`
  - Gate all legacy outbox triggers by `sync_link_state`.
  - Restore link-gated raw telemetry insert outbox triggers for `device_data`, `chameleon_readings`, and `dendrometer_readings`.
  - Repair irrigation event UUID trigger/outbox sequencing.
- Modify `database/migrations/2026-06-28-history-sync-v1.sql`
  - Backfill `irrigation_events.event_uuid`.
  - Install stable UUID trigger logic for upgraded hubs.
  - Add shadow cursor columns.
- Modify packaged DB copies after schema changes:
  - `database/farming.db`
  - `web/react-gui/farming.db`
  - `conf/*/files/usr/share/db/farming.db`
- Modify both flow copies:
  - `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
  - `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify both helper copies:
  - `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js`
  - `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Modify `scripts/lib/history-hash-v1.js`
- Modify `scripts/test-sync-history-schema.js`
- Modify `scripts/test-sync-history-worker.js`
- Modify `scripts/verify-sync-flow.js`
- Modify `scripts/verify-db-schema-consistency.js`
- Modify `docs/operations/edge-history-retention.md`

Server repo, branch `feat/history-sync-v1-server`:

- Modify `backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`
- Modify `backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`
- Modify `backend/src/main/java/org/osi/server/sync/history/HistoryBatchRequest.java`
- Modify `backend/src/main/java/org/osi/server/sync/history/HistoryBatchResponse.java` only if a `shadowAccepted` field is added.
- Modify `backend/src/main/java/org/osi/server/sync/history/DeviceDataHistoryMapper.java`
- Modify `backend/src/main/java/org/osi/server/sync/history/HistoryColumnEncoder.java`
- Modify `backend/src/main/java/org/osi/server/sync/history/HistoryHashV1.java`
- Create `backend/src/main/java/org/osi/server/sync/history/HistorySegmentStateRepository.java`
- Create `backend/src/main/java/org/osi/server/sync/history/HistoryManifestIngestService.java`
- Modify `backend/src/main/resources/db/migration/V2026_06_28_001__edge_history_sync_v1.sql`
- Modify tests under `backend/src/test/java/org/osi/server/sync/**`
- Modify `docs/sync/history-sync-v1.md`

---

## Task 1: Restore Durable Parity and Offline Outbox Gating

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-sync-history-schema.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Write failing edge schema tests**

In `scripts/test-sync-history-schema.js`, split the current linked raw insert/update assertion into explicit assertions:

```js
exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES('cloud', 1, '0016C001F11715E2', '2026-06-28T10:00:00.000Z')");

exec("INSERT INTO device_data(id, deveui, recorded_at, swt_1) VALUES(101, 'A84041CAFECAFE01', '2026-06-28T10:00:00.000Z', 10.0)");
if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';") !== 1) {
  throw new Error('linked device_data insert lost legacy durable outbox coverage');
}

exec("INSERT INTO chameleon_readings(id, deveui, recorded_at) VALUES(11, 'A84041CAFECAFE01', '2026-06-28T10:01:00.000Z')");
if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='CHAMELEON_READING';") !== 1) {
  throw new Error('linked chameleon_readings insert lost legacy durable outbox coverage');
}

exec("INSERT INTO dendrometer_readings(id, deveui, recorded_at) VALUES(12, 'A84041CAFECAFE01', '2026-06-28T10:02:00.000Z')");
if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DENDRO_READING';") !== 1) {
  throw new Error('linked dendrometer_readings insert lost legacy durable outbox coverage');
}

exec("UPDATE device_data SET swt_1=11.0 WHERE id=101");
if (scalar("SELECT COUNT(*) FROM sync_history_dirty_keys WHERE table_name='device_data' AND row_key='DEVICE_DATA|0016C001F11715E2|101';") !== 1) {
  throw new Error('linked raw correction did not create dirty key');
}
```

Add an unlinked derived/irrigation assertion before inserting into `sync_link_state`:

```js
exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(1, '2026-06-27', 1.0, '2026-06-28T09:00:00.000Z')");
exec("INSERT INTO zone_daily_recommendations(zone_id, date, recommendation_json, computed_at) VALUES(1, '2026-06-27', '{}', '2026-06-28T09:00:00.000Z')");
exec("INSERT INTO dendrometer_daily(deveui, date, computed_at) VALUES('A84041CAFECAFE01', '2026-06-27', '2026-06-28T09:00:00.000Z')");
exec("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, payload_json) VALUES(1, 1, 'OPEN', '{}')");
if (scalar('SELECT COUNT(*) FROM sync_outbox;') !== 0) {
  throw new Error('unlinked derived or irrigation insert created outbox row');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/history-sync-v1-edge
node scripts/test-sync-history-schema.js
```

Expected: FAIL on missing linked raw durable coverage or unlinked derived outbox gating.

- [ ] **Step 3: Restore link-gated legacy outbox triggers**

In `database/seed-blank.sql`, ensure these triggers exist and each starts with:

```sql
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
```

Required trigger set:

```text
trg_dp_device_data_outbox_ai
trg_dp_chameleon_readings_outbox_ai
trg_dp_dendro_readings_outbox_ai
trg_dp_dendro_daily_outbox_ai
trg_dp_dendro_daily_outbox_au
trg_dp_irrigation_events_outbox_ai
trg_dp_zone_env_outbox_ai
trg_dp_zone_env_outbox_au
trg_dp_zone_recs_outbox_ai
trg_dp_zone_recs_outbox_au
trg_gateway_locations_outbox_ai
trg_gateway_locations_outbox_au
```

In the Node-RED sync init function, do the same runtime migration:

- Stop dropping `trg_dp_device_data_outbox_ai`, `trg_dp_chameleon_readings_outbox_ai`, and `trg_dp_dendro_readings_outbox_ai` without recreating them.
- Recreate all required triggers with the same link gate.
- Keep dirty-key update triggers for corrections.

Do not add raw insert dirty-key triggers in this task. Raw inserts are still durable through legacy outbox until the batch path is truly durable.

- [ ] **Step 4: Update verifier trigger expectations**

In `scripts/verify-sync-flow.js`, require the restored trigger names in both seed SQL and runtime sync init:

```js
for (const triggerName of [
  'trg_dp_device_data_outbox_ai',
  'trg_dp_chameleon_readings_outbox_ai',
  'trg_dp_dendro_readings_outbox_ai',
  'trg_dp_dendro_daily_outbox_ai',
  'trg_dp_dendro_daily_outbox_au',
  'trg_dp_irrigation_events_outbox_ai',
  'trg_dp_zone_env_outbox_ai',
  'trg_dp_zone_env_outbox_au',
  'trg_dp_zone_recs_outbox_ai',
  'trg_dp_zone_recs_outbox_au',
]) {
  expectIncludes('Sync Init Schema + Triggers', triggerName, `creates ${triggerName} at runtime`);
  expectFileIncludes('seed-blank.sql', seedSqlSource, triggerName, `defines ${triggerName}`);
}
```

Also require link-gate SQL near these trigger definitions:

```js
expectIncludes('Sync Init Schema + Triggers', "WHERE peer_node = 'cloud' AND linked = 1", 'outbox triggers are link-gated');
```

- [ ] **Step 5: Run edge tests**

Run:

```bash
node scripts/test-sync-history-schema.js
node scripts/verify-sync-flow.js
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add database/seed-blank.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-schema.js scripts/verify-sync-flow.js
git commit -m "fix(sync): restore link-gated telemetry outbox coverage"
```

---

## Task 2: Fix Edge Auth Fail-Closed and Link-State Cleanup

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add verifier expectations**

In `scripts/verify-sync-flow.js`, add string checks for both batch and manifest builders:

```js
expectIncludes('Build History Batch', "if (!syncToken)", 'history batch fails closed without sync token');
expectIncludes('Build History Manifest', "if (!syncToken)", 'history manifest fails closed without sync token');
expectIncludes('Build History Batch', "return null", 'history batch stops before unauthenticated post');
expectIncludes('Build History Manifest', "return null", 'history manifest stops before unauthenticated post');
expectIncludes('Persist Linked Account State', 'normalizeGatewayDeviceEui', 'linked account state normalizes gateway EUI');
expectIncludes('Unlink Account', 'server_url=NULL', 'unlink clears sync_link_state server URL');
expectIncludes('Unlink Account', 'gateway_device_eui=NULL', 'unlink clears sync_link_state gateway identity');
```

- [ ] **Step 2: Run verifier to verify it fails**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: FAIL on missing auth fail-closed or identity cleanup checks.

- [ ] **Step 3: Update history batch builder**

In `sync-history-build`, after computing `syncToken`, fail closed before setting `msg.method`:

```js
if (!syncToken) {
  setSyncState({
    lastHistorySyncError: {
      at: new Date().toISOString(),
      source: 'history-build',
      message: 'missing sync token'
    },
    updatedAt: new Date().toISOString()
  });
  await close();
  return null;
}
```

- [ ] **Step 4: Update manifest builder**

In `sync-history-manifest-build`, after computing `syncToken`, fail closed before setting `msg.method`:

```js
if (!syncToken) {
  setSyncState({
    lastHistoryManifestError: {
      at: new Date().toISOString(),
      message: 'missing sync token'
    },
    updatedAt: new Date().toISOString()
  });
  await close();
  return null;
}
```

- [ ] **Step 5: Normalize gateway EUI when finalizing account link**

In the linked-account finalization function, replace raw uppercase handling with:

```js
function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}
const gatewayDeviceEui = normalizeGatewayDeviceEui(flow.get('al_gateway_device_eui') || env.get('DEVICE_EUI'));
```

Keep the existing incomplete-state `500` path when `gatewayDeviceEui` is empty.

- [ ] **Step 6: Clear cloud identity on unlink**

Replace the unlink `sync_link_state` update with:

```js
await run(
  "UPDATE sync_link_state SET linked=0, server_url=NULL, cloud_user_id=NULL, gateway_device_eui=NULL, updated_at=? WHERE peer_node='cloud'",
  [new Date().toISOString()]
);
await run("DELETE FROM sync_history_dirty_keys WHERE peer_node='cloud'", []);
```

- [ ] **Step 7: Run verifier**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-sync-flow.js
git commit -m "fix(sync): fail closed for unauthenticated history posts"
```

---

## Task 3: Make Shadow Progress Safe and Observable

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `database/migrations/2026-06-28-history-sync-v1.sql`
- Modify: both `osi-history-sync-helper/index.js` copies
- Modify: both `flows.json` copies
- Modify: `scripts/test-sync-history-worker.js`
- Modify: `scripts/test-sync-history-schema.js`
- Modify server: `backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`
- Modify server tests: `backend/src/test/java/org/osi/server/sync/history/EdgeHistoryIngestServiceTest.java`

- [ ] **Step 1: Add failing helper tests**

In `scripts/test-sync-history-worker.js`, add:

```js
assert.deepStrictEqual(helper.cursorPatchFromResponse({
  ackedThroughId: 123,
  results: [
    { historyKey: 'DEVICE_DATA|0016C001F11715E2|123', status: 'APPLIED' },
    { historyKey: 'DEVICE_DATA|0016C001F11715E2|124', status: 'REJECTED_PERMANENT', reason: 'hash_mismatch' }
  ]
}), {
  last_acked_id: 123,
  last_error: 'permanent: hash_mismatch',
  next_attempt_at: '9999-12-31T00:00:00.000Z'
});
```

Add schema assertions for new shadow cursor columns:

```js
const cursorColumns = columnNames('sync_history_cursors');
for (const name of ['last_shadow_acked_id', 'last_shadow_acked_key', 'last_shadow_error']) {
  if (!cursorColumns.includes(name)) throw new Error(`missing sync_history_cursors.${name}`);
}
```

- [ ] **Step 2: Run failing edge tests**

Run:

```bash
node scripts/test-sync-history-worker.js
node scripts/test-sync-history-schema.js
```

Expected: FAIL on missing helper behavior and schema columns.

- [ ] **Step 3: Add shadow cursor columns**

Add to `sync_history_cursors` in seed and migration:

```sql
last_shadow_acked_id INTEGER,
last_shadow_acked_key TEXT,
last_shadow_error TEXT,
```

Runtime sync init must also attempt:

```sql
ALTER TABLE sync_history_cursors ADD COLUMN last_shadow_acked_id INTEGER
ALTER TABLE sync_history_cursors ADD COLUMN last_shadow_acked_key TEXT
ALTER TABLE sync_history_cursors ADD COLUMN last_shadow_error TEXT
```

- [ ] **Step 4: Update helper permanent-rejection handling**

Replace `cursorPatchFromResponse()` in both helper copies with:

```js
function cursorPatchFromResponse(response) {
  const results = Array.isArray(response.results) ? response.results : [];
  const permanent = results.find((result) => result && result.status === 'REJECTED_PERMANENT');
  const patch = {};
  if (response.ackedThroughId != null) {
    patch.last_acked_id = Number(response.ackedThroughId);
  } else if (response.ackedThroughKey != null) {
    patch.last_acked_key = String(response.ackedThroughKey);
  }
  if (permanent) {
    patch.last_error = `permanent: ${permanent.reason || 'rejected'}`;
    patch.next_attempt_at = '9999-12-31T00:00:00.000Z';
    return patch;
  }
  if (response.ackedThroughId == null && response.ackedThroughKey == null) {
    return { last_error: 'missing ACK boundary' };
  }
  patch.last_error = null;
  patch.retry_count = 0;
  return patch;
}
```

- [ ] **Step 5: Update edge shadow builder/marker**

In `sync-history-build`, use shadow progress while phase is `shadow`:

```js
const lastShadowAckedId = Number(cursor.last_shadow_acked_id || 0);
const rows = await q('SELECT * FROM device_data WHERE id > ? ORDER BY id ASC LIMIT ?', [lastShadowAckedId, batchSize]);
```

In `sync-history-mark`, never set `history_sync_v1_confirmed` in the non-durable branch. Instead update shadow cursor fields:

```js
const patch = helper.cursorPatchFromResponse(responsePayload);
await run(
  "UPDATE sync_history_cursors SET last_shadow_acked_id=COALESCE(?, last_shadow_acked_id), last_shadow_acked_key=COALESCE(?, last_shadow_acked_key), last_shadow_error=?, last_batch_id=?, last_batch_at=?, retry_count=? WHERE peer_node='cloud' AND table_name=?",
  [
    patch.last_acked_id != null ? patch.last_acked_id : null,
    patch.last_acked_key != null ? patch.last_acked_key : null,
    patch.last_error || null,
    batch.batchId || responsePayload.batchId || null,
    now,
    patch.next_attempt_at ? 0 : Number(patch.retry_count || 0),
    tableName
  ]
);
```

If `patch.next_attempt_at` is present, also set `next_attempt_at`.

- [ ] **Step 6: Add failing server shadow tests**

In `EdgeHistoryIngestServiceTest`, change the shadow test expectation:

```java
assertThat(response.ackedThroughId()).isEqualTo(101L);
assertThat(response.results()).extracting(HistoryBatchResponse.RowResult::status)
        .containsExactly(HistoryBatchResponse.Status.APPLIED);
verifyNoInteractions(rowIndexRepository);
```

Add a two-row hash mismatch test where row 1 is valid and row 2 is rejected; expected response has `ackedThroughId=101L` and includes `REJECTED_PERMANENT` on row 2.

- [ ] **Step 7: Update server shadow logic**

In `EdgeHistoryIngestService.applyBatch`, for shadow rows that validate, advance the ACK boundary but skip row-index writes:

```java
if (shadow) {
    results.add(new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.APPLIED, "shadow_only"));
    ackedThroughId = maxCursorId(ackedThroughId, row.historyKey());
    ackedThroughKey = row.historyKey();
    continue;
}
```

Keep hash mismatch as `REJECTED_PERMANENT` and stop before that row.

- [ ] **Step 8: Run tests**

Edge:

```bash
node scripts/test-sync-history-worker.js
node scripts/test-sync-history-schema.js
```

Server:

```bash
cd /home/phil/Repos/osi-server/.worktrees/history-sync-v1-server/backend
./gradlew test --tests 'org.osi.server.sync.history.EdgeHistoryIngestServiceTest'
```

Expected: PASS.

- [ ] **Step 9: Commit in each repo**

Edge:

```bash
git add database/seed-blank.sql database/migrations/2026-06-28-history-sync-v1.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-worker.js scripts/test-sync-history-schema.js
git commit -m "fix(sync): track shadow history progress separately"
```

Server:

```bash
git add backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java backend/src/test/java/org/osi/server/sync/history/EdgeHistoryIngestServiceTest.java
git commit -m "fix(sync): return shadow history ack boundaries"
```

---

## Task 4: Harden Hash Canonicalization

**Files:**
- Modify edge: `scripts/lib/history-hash-v1.js`
- Modify edge: both `osi-history-sync-helper/index.js` copies
- Modify edge: `docs/sync/history-hash-v1-fixtures.json`
- Modify edge: `scripts/verify-history-hash-fixtures.js`
- Modify edge: `scripts/test-sync-history-worker.js`
- Modify server: `HistoryColumnEncoder.java`
- Modify server: `HistoryHashV1.java`
- Modify server tests: `HistoryHashV1Test.java`, `DeviceDataHistoryMapperTest.java`

- [ ] **Step 1: Add fixture cases**

Add a `device_data` fixture with:

```json
{
  "id": 124,
  "deveui": "A84041CAFECAFE01",
  "recorded_at": "2026-06-28T10:05:00Z",
  "swt_1": -0.0,
  "swt_2": 0,
  "dendro_valid": 0
}
```

Expected columns must include:

```json
["swt_1", "REAL", "0000000000000000"],
["swt_2", "REAL", "0000000000000000"],
["dendro_valid", "BOOLEAN", false]
```

- [ ] **Step 2: Add invalid encoding tests**

Edge helper test:

```js
assert.throws(() => helper.buildCanonicalColumns('device_data', {
  id: '12x',
  deveui: 'A84041CAFECAFE01',
  recorded_at: '2026-06-28T10:00:00Z'
}), /invalid INTEGER/);

assert.throws(() => helper.buildCanonicalColumns('device_data', {
  id: 125,
  deveui: 'A84041CAFECAFE01',
  recorded_at: '2026-06-28T10:00:00Z',
  dendro_valid: 'maybe'
}), /invalid BOOLEAN/);
```

Server `HistoryColumnEncoder` test:

```java
assertThatThrownBy(() -> encoder.columns("dendro_valid", "BOOLEAN", "maybe"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("invalid BOOLEAN");
assertThatThrownBy(() -> encoder.columns("id", "INTEGER", "12x"))
        .isInstanceOf(RuntimeException.class);
```

- [ ] **Step 3: Run tests to verify failure**

Edge:

```bash
node scripts/test-sync-history-worker.js
node scripts/verify-history-hash-fixtures.js
```

Server:

```bash
./gradlew test --tests 'org.osi.server.sync.history.HistoryHashV1Test' --tests 'org.osi.server.sync.history.DeviceDataHistoryMapperTest'
```

Expected: FAIL until encoders are strict and fixture hashes are updated.

- [ ] **Step 4: Implement strict edge encoders**

Use the same implementation in `scripts/lib/history-hash-v1.js` and both helper copies:

```js
function encodeInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) throw new Error(`INTEGER exceeds safe range ${value}`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) throw new Error(`invalid INTEGER ${value}`);
    return BigInt(trimmed).toString();
  }
  throw new Error(`invalid INTEGER ${value}`);
}

function encodeBoolean(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error(`invalid BOOLEAN ${value}`);
}

function encodeJson(value) {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return canonicalJson(parsed);
}
```

Then route `INTEGER` and `BOOLEAN` through these functions.

- [ ] **Step 5: Implement strict server encoders**

In `HistoryColumnEncoder`:

```java
private long asLong(Object value) {
    if (value instanceof Number number) {
        double raw = number.doubleValue();
        if (!Double.isFinite(raw) || raw % 1 != 0) throw new IllegalArgumentException("invalid INTEGER " + value);
        return number.longValue();
    }
    String text = String.valueOf(value).trim();
    if (!text.matches("-?\\d+")) throw new IllegalArgumentException("invalid INTEGER " + value);
    return Long.parseLong(text);
}

private boolean asBoolean(Object value) {
    if (value instanceof Boolean bool) return bool;
    if (value instanceof Number number) {
        int normalized = number.intValue();
        if (normalized == 0 || normalized == 1) return normalized == 1;
        throw new IllegalArgumentException("invalid BOOLEAN " + value);
    }
    String normalized = String.valueOf(value).trim();
    if ("true".equalsIgnoreCase(normalized) || "1".equals(normalized)) return true;
    if ("false".equalsIgnoreCase(normalized) || "0".equals(normalized)) return false;
    throw new IllegalArgumentException("invalid BOOLEAN " + value);
}
```

Keep negative-zero normalization as:

```java
if (number == 0.0d) number = 0.0d;
```

This is valid in Java and normalizes `-0.0d` to positive zero.

- [ ] **Step 6: Make canonical JSON codec explicit**

Do not use the application-wide Spring mapper for hash bytes. Add a dedicated canonical mapper utility inside `HistoryHashV1` or a new package-private class, and use it consistently from hash tests and column encoding. The implementation must preserve fixture byte output:

```java
private static final ObjectMapper CANONICAL_MAPPER = new ObjectMapper();
```

If `HistoryColumnEncoder` still needs an injected mapper for Spring construction, only use the canonical mapper for `writeValueAsString` and JSON value conversion used in hash columns.

- [ ] **Step 7: Regenerate expected fixture hashes**

Run:

```bash
node scripts/verify-history-hash-fixtures.js --update
```

If the script does not support `--update`, update the expected hashes by running a small one-off Node script that imports `scripts/lib/history-hash-v1.js` and prints each fixture hash. Do not leave the one-off script in the repo.

- [ ] **Step 8: Run tests**

Edge:

```bash
node scripts/test-sync-history-worker.js
node scripts/verify-history-hash-fixtures.js
```

Server:

```bash
./gradlew test --tests 'org.osi.server.sync.history.HistoryHashV1Test' --tests 'org.osi.server.sync.history.DeviceDataHistoryMapperTest'
```

Expected: PASS.

- [ ] **Step 9: Commit in each repo**

Edge:

```bash
git add scripts/lib/history-hash-v1.js docs/sync/history-hash-v1-fixtures.json scripts/verify-history-hash-fixtures.js scripts/test-sync-history-worker.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js
git commit -m "fix(sync): reject malformed history hash values"
```

Server:

```bash
git add backend/src/main/java/org/osi/server/sync/history/HistoryColumnEncoder.java backend/src/main/java/org/osi/server/sync/history/HistoryHashV1.java backend/src/test/java/org/osi/server/sync/history/HistoryHashV1Test.java backend/src/test/java/org/osi/server/sync/history/DeviceDataHistoryMapperTest.java docs/sync/history-hash-v1-fixtures.json
git commit -m "fix(sync): harden history hash canonicalization"
```

---

## Task 5: Make Server Durable Phase Fail Closed

**Files:**
- Modify: `backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`
- Modify: `backend/src/main/java/org/osi/server/sync/history/HistoryBatchRequest.java`
- Modify: `backend/src/main/java/org/osi/server/sync/history/DeviceDataHistoryMapper.java`
- Modify: `backend/src/test/java/org/osi/server/sync/history/EdgeHistoryIngestServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/sync/history/DeviceDataHistoryMapperTest.java`

- [ ] **Step 1: Add failing tests**

Add to `EdgeHistoryIngestServiceTest`:

```java
@Test
void nonShadowBatchIsRejectedUntilDurableMirrorIsImplemented() {
    when(mapper.tableName()).thenReturn("device_data");
    var service = new EdgeHistoryIngestService(rowIndexRepository, quarantineRepository, List.of(mapper));

    var response = service.applyBatch(batch(DEVICE_HASH, "backfill"));

    assertThat(response.ackedThroughId()).isNull();
    assertThat(response.results()).extracting(HistoryBatchResponse.RowResult::status)
            .containsExactly(HistoryBatchResponse.Status.REJECTED_PERMANENT);
    assertThat(response.results().get(0).reason()).isEqualTo("durable_mirror_not_enabled");
    verifyNoInteractions(rowIndexRepository);
}
```

Add to `DeviceDataHistoryMapperTest`:

```java
@Test
void applyResultNormalizesPayloadId() {
    var row = new HistoryBatchRequest.Row("DEVICE_DATA|GW|101", "sensor|t|101", "hash", Map.of("id", "00101"));

    var result = mapper.apply("GW", row);

    assertThat(result.serverTable()).isEqualTo("sensor_data");
    assertThat(result.serverRowId()).isEqualTo("101");
}
```

- [ ] **Step 2: Run tests to verify failure**

```bash
./gradlew test --tests 'org.osi.server.sync.history.EdgeHistoryIngestServiceTest' --tests 'org.osi.server.sync.history.DeviceDataHistoryMapperTest'
```

Expected: FAIL.

- [ ] **Step 3: Validate protocol version**

In `EdgeHistoryIngestService.applyBatch`, before `hashVersion`:

```java
if (request.protocolVersion() != 1) {
    return stopBeforeFirstRow(request, "unsupported_protocol_version");
}
```

- [ ] **Step 4: Reject non-shadow phase**

Before row processing:

```java
boolean shadow = "shadow".equalsIgnoreCase(String.valueOf(request.phase()));
if (!shadow) {
    return stopBeforeFirstRow(request, "durable_mirror_not_enabled");
}
```

This is intentionally conservative. Legacy event/bootstrap paths remain the durable path after Task 1.

- [ ] **Step 5: Normalize mapper apply ID**

Even though durable is disabled, make the mapper deterministic:

```java
public ApplyResult apply(String gatewayEui, HistoryBatchRequest.Row row) {
    Object rawId = row.payload().get("id");
    if (rawId == null) throw new IllegalArgumentException("device_data.id is required");
    long normalizedId;
    if (rawId instanceof Number number) {
        double raw = number.doubleValue();
        if (!Double.isFinite(raw) || raw % 1 != 0) throw new IllegalArgumentException("device_data.id must be an integer");
        normalizedId = number.longValue();
    } else {
        String text = String.valueOf(rawId).trim();
        if (!text.matches("\\d+")) throw new IllegalArgumentException("device_data.id must be an integer");
        normalizedId = Long.parseLong(text);
    }
    return new ApplyResult("sensor_data", Long.toString(normalizedId));
}
```

- [ ] **Step 6: Run tests**

```bash
./gradlew test --tests 'org.osi.server.sync.history.EdgeHistoryIngestServiceTest' --tests 'org.osi.server.sync.history.DeviceDataHistoryMapperTest'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java backend/src/main/java/org/osi/server/sync/history/DeviceDataHistoryMapper.java backend/src/test/java/org/osi/server/sync/history/EdgeHistoryIngestServiceTest.java backend/src/test/java/org/osi/server/sync/history/DeviceDataHistoryMapperTest.java
git commit -m "fix(sync): fail closed before durable history mirror"
```

---

## Task 6: Repair Irrigation Event UUIDs

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `database/migrations/2026-06-28-history-sync-v1.sql`
- Modify: both `flows.json` copies
- Modify: `scripts/test-sync-history-schema.js`
- Modify: `scripts/verify-db-schema-consistency.js`

- [ ] **Step 1: Add failing migration/seed tests**

In `scripts/test-sync-history-schema.js`, assert:

```js
exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(2, 1, 1, 'CLOSE', '{}')");
const eventUuid = text('SELECT event_uuid FROM irrigation_events WHERE id=2;');
if (!/^irrig-0016C001F11715E2-000000000002$/.test(eventUuid)) {
  throw new Error('irrigation event uuid trigger did not use zone gateway EUI');
}
```

Add a second zone with null gateway and assert the fallback does not contain the production EUI:

```js
exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(2, 1, 'No Gateway', 'zone-2', NULL, 1)");
exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(3, 1, 2, 'OPEN', '{}')");
const fallbackUuid = text('SELECT event_uuid FROM irrigation_events WHERE id=3;');
if (fallbackUuid.includes('0016C001F11715E2')) {
  throw new Error('irrigation event uuid used hardcoded production fallback');
}
```

- [ ] **Step 2: Run failing test**

```bash
node scripts/test-sync-history-schema.js
```

Expected: FAIL on fallback or migration coverage.

- [ ] **Step 3: Change UUID trigger fallback**

Use this expression in seed and runtime trigger:

```sql
SELECT CASE WHEN COALESCE(
  (SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
  (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
) IS NULL THEN RAISE(ABORT, 'missing_gateway_device_eui') END;

UPDATE irrigation_events
SET event_uuid = 'irrig-' || COALESCE(
  (SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
  (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
) || '-' || printf('%015d', NEW.id)
WHERE id = NEW.id;
```

- [ ] **Step 4: Avoid outbox/UUID trigger ordering risk**

Use two outbox triggers:

1. `AFTER INSERT ON irrigation_events WHEN NEW.event_uuid IS NOT NULL AND NEW.event_uuid <> ''`
2. `AFTER UPDATE OF event_uuid ON irrigation_events WHEN (OLD.event_uuid IS NULL OR OLD.event_uuid = '') AND NEW.event_uuid IS NOT NULL AND NEW.event_uuid <> ''`

Both triggers must be link-gated and must use `NEW.event_uuid` in the payload:

```sql
'event_uuid', NEW.event_uuid
```

- [ ] **Step 5: Backfill migration**

In `database/migrations/2026-06-28-history-sync-v1.sql`, after adding the column and before the unique index:

```sql
UPDATE irrigation_events
SET event_uuid = 'irrig-' || COALESCE(
  (SELECT gateway_device_eui FROM irrigation_zones WHERE irrigation_zones.id = irrigation_events.irrigation_zone_id AND deleted_at IS NULL),
  (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
) || '-' || printf('%015d', id)
WHERE (event_uuid IS NULL OR event_uuid = '')
  AND COALESCE(
    (SELECT gateway_device_eui FROM irrigation_zones WHERE irrigation_zones.id = irrigation_events.irrigation_zone_id AND deleted_at IS NULL),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
  ) IS NOT NULL;
```

Runtime sync init should also run the same backfill after attempting `ALTER TABLE`.

- [ ] **Step 6: Verify unique index definition**

In `scripts/verify-db-schema-consistency.js`, assert `idx_irrigation_events_event_uuid` SQL contains `CREATE UNIQUE INDEX`.

- [ ] **Step 7: Run tests**

```bash
node scripts/test-sync-history-schema.js
node scripts/verify-db-schema-consistency.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add database/seed-blank.sql database/migrations/2026-06-28-history-sync-v1.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-schema.js scripts/verify-db-schema-consistency.js
git commit -m "fix(sync): repair irrigation event stable ids"
```

---

## Task 7: Make Manifest Handling Honest

**Files:**
- Modify edge: both `flows.json` copies
- Modify server: `EdgeSyncController.java`
- Create server: `HistorySegmentStateRepository.java`
- Create server: `HistoryManifestIngestService.java`
- Modify server tests: `EdgeSyncControllerTest.java`

- [ ] **Step 1: Add server tests**

In `EdgeSyncControllerTest`, add a manifest endpoint test that verifies a successful response calls the ingest service and returns exact `200 OK` or exact `202 Accepted`, whichever contract is chosen. Choose `200 OK` if persistence happens synchronously.

Expected assertion:

```java
assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
verify(historyManifestIngestService).applyManifest(request);
```

- [ ] **Step 2: Add repository**

Create `HistorySegmentStateRepository`:

```java
@Repository
@RequiredArgsConstructor
public class HistorySegmentStateRepository {
    private final NamedParameterJdbcTemplate jdbc;

    public void upsert(String gatewayEui, HistoryManifestRequest.Segment segment) {
        jdbc.update("""
                INSERT INTO edge_history_segment_state(
                    gateway_eui, table_name, segment_key, hash_version,
                    canonical_row_count, syncable_row_count, quarantined_count,
                    syncable_payload_hash, last_seen_at
                ) VALUES (
                    :gatewayEui, :tableName, :segmentKey, :hashVersion,
                    :canonicalRowCount, :syncableRowCount, :quarantinedCount,
                    :syncablePayloadHash, now()
                )
                ON CONFLICT (gateway_eui, table_name, segment_key, hash_version)
                DO UPDATE SET
                    canonical_row_count = EXCLUDED.canonical_row_count,
                    syncable_row_count = EXCLUDED.syncable_row_count,
                    quarantined_count = EXCLUDED.quarantined_count,
                    syncable_payload_hash = EXCLUDED.syncable_payload_hash,
                    last_seen_at = now()
                """, new MapSqlParameterSource()
                .addValue("gatewayEui", gatewayEui)
                .addValue("tableName", segment.tableName())
                .addValue("segmentKey", segment.segmentKey())
                .addValue("hashVersion", segment.hashVersion())
                .addValue("canonicalRowCount", segment.canonicalRowCount())
                .addValue("syncableRowCount", segment.syncableRowCount())
                .addValue("quarantinedCount", segment.quarantinedCount())
                .addValue("syncablePayloadHash", segment.syncablePayloadHash()));
    }
}
```

- [ ] **Step 3: Add manifest service**

```java
@Service
@RequiredArgsConstructor
public class HistoryManifestIngestService {
    private final HistorySegmentStateRepository repository;

    @Transactional
    public int applyManifest(HistoryManifestRequest request) {
        String gatewayEui = AuthController.normalizeGatewayDeviceEui(request.gatewayDeviceEui());
        if (gatewayEui == null || gatewayEui.isBlank()) {
            throw new IllegalArgumentException("gatewayDeviceEui is required");
        }
        if (request.segments() == null) return 0;
        request.segments().forEach(segment -> repository.upsert(gatewayEui, segment));
        return request.segments().size();
    }
}
```

- [ ] **Step 4: Wire controller**

After authorization:

```java
int stored = historyManifestIngestService.applyManifest(request);
return ResponseEntity.ok(Map.of("success", true, "stored", stored));
```

- [ ] **Step 5: Fix edge manifest SQL separator and empty-post behavior**

In `sync-history-manifest-build`, change:

```js
].join('\\n')
```

to an actual newline separator in the function source:

```js
].join('\n')
```

After loading rows:

```js
if (!rows.length) {
  setSyncState({ lastHistoryManifestIdleAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await close();
  return null;
}
```

- [ ] **Step 6: Run tests**

Server:

```bash
./gradlew test --tests 'org.osi.server.sync.EdgeSyncControllerTest'
```

Edge:

```bash
node scripts/verify-sync-flow.js
```

Expected: PASS.

- [ ] **Step 7: Commit in each repo**

Edge:

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-sync-flow.js
git commit -m "fix(sync): make history manifest posts fail closed"
```

Server:

```bash
git add backend/src/main/java/org/osi/server/sync/EdgeSyncController.java backend/src/main/java/org/osi/server/sync/history/HistorySegmentStateRepository.java backend/src/main/java/org/osi/server/sync/history/HistoryManifestIngestService.java backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java
git commit -m "fix(sync): persist edge history manifests"
```

---

## Task 8: Close Verification Gaps

**Files:**
- Modify: `scripts/test-sync-history-schema.js`
- Modify: `scripts/test-sync-history-worker.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify server tests: Mockito extension/style only where already touching test classes.
- Modify server: `docs/sync/history-sync-v1.md`

- [ ] **Step 1: Add migration-path schema test**

In `scripts/test-sync-history-schema.js`, refactor the assertions into:

```js
function assertHistorySchemaAndTriggers(dbPath) {
  // existing assertions move here
}
```

Run it twice:

1. Fresh DB from `database/seed-blank.sql`.
2. Upgrade DB built from `main:database/seed-blank.sql`, then apply `database/migrations/2026-06-28-history-sync-v1.sql`.

Use:

```bash
git show main:database/seed-blank.sql
```

inside the script through `execFileSync('git', ['show', 'main:database/seed-blank.sql'], { encoding: 'utf8' })`.

- [ ] **Step 2: Test both helper copies**

In `scripts/test-sync-history-worker.js`:

```js
for (const helperPath of [
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper',
  '../conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper'
]) {
  const helper = require(helperPath);
  runHelperAssertions(helper);
}
```

- [ ] **Step 3: Add helper test to umbrella verifier**

In `scripts/verify-sync-flow.js` near the existing history checks:

```js
execFileSync(process.execPath, [path.resolve(__dirname, 'test-sync-history-worker.js')], { stdio: 'inherit' });
```

- [ ] **Step 4: Fix server test conventions while touching files**

For test classes that use Mockito mocks, add:

```java
@ExtendWith(MockitoExtension.class)
```

and replace manual mock fields with `@Mock`. Do this for `EdgeHistoryIngestServiceTest`.

Do not add Mockito extension to pure value/fixture tests unless the repo convention strictly requires it; it adds no value to `HistoryHashV1Test`.

- [ ] **Step 5: Fix brittle fixture path**

Copy `docs/sync/history-hash-v1-fixtures.json` into server test resources:

```text
backend/src/test/resources/sync/history-hash-v1-fixtures.json
```

Load it in `HistoryHashV1Test` with:

```java
try (InputStream stream = getClass().getResourceAsStream("/sync/history-hash-v1-fixtures.json")) {
    assertThat(stream).isNotNull();
    JsonNode fixture = MAPPER.readTree(stream);
    ...
}
```

- [ ] **Step 6: Fix docs source-of-truth link**

In `docs/sync/history-sync-v1.md`, replace the sibling repo path with a local contract summary. Include:

```markdown
History sync v1 is shadow-only in this branch. Legacy `/edge/events` and `/edge/bootstrap` remain the durable mirror path until durable batch mirror writes are implemented and advertised.
```

- [ ] **Step 7: Run verification**

Edge:

```bash
node scripts/test-sync-history-schema.js
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
git diff --check
```

Server:

```bash
./gradlew test --tests 'org.osi.server.sync.*' --tests 'org.osi.server.sync.history.*'
git diff --check
```

Expected: all PASS.

- [ ] **Step 8: Commit in each repo**

Edge:

```bash
git add scripts/test-sync-history-schema.js scripts/test-sync-history-worker.js scripts/verify-sync-flow.js
git commit -m "test(sync): cover history sync upgrade and helper parity"
```

Server:

```bash
git add backend/src/test/java/org/osi/server/sync backend/src/test/resources/sync/history-hash-v1-fixtures.json docs/sync/history-sync-v1.md
git commit -m "test(sync): tighten history sync review coverage"
```

---

## Task 9: Regenerate Packaged Databases and Final Verification

**Files:**
- Modify generated DB copies:
  - `database/farming.db`
  - `web/react-gui/farming.db`
  - `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
  - `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`

- [ ] **Step 1: Rebuild DB copies from seed**

Use the repo’s existing DB regeneration workflow. If no dedicated script exists, run the existing schema consistency verifier first to identify expected DB targets, then update each packaged SQLite DB from `database/seed-blank.sql` using the same method used in the prior implementation.

- [ ] **Step 2: Verify DB schema consistency**

Run:

```bash
node scripts/verify-db-schema-consistency.js
```

Expected: PASS and all DB copies include the new cursor columns, UUID logic, and link-gated trigger definitions.

- [ ] **Step 3: Run full edge verification**

Run:

```bash
node scripts/verify-history-hash-fixtures.js
node scripts/test-sync-history-schema.js
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
git diff --check
```

Expected: all PASS.

- [ ] **Step 4: Run full server verification**

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/history-sync-v1-server/backend
./gradlew test --tests 'org.osi.server.sync.*' --tests 'org.osi.server.sync.history.*'
git diff --check
```

Expected: all PASS.

- [ ] **Step 5: Final status check**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/history-sync-v1-edge && git status --short --branch
cd /home/phil/Repos/osi-server/.worktrees/history-sync-v1-server && git status --short --branch
cd /home/phil/Repos/osi-os && git status --short --branch
```

Expected:

- Edge feature worktree clean.
- Server feature worktree clean.
- Original `/home/phil/Repos/osi-os` checkout still only has unrelated pre-existing dirty files unless the user explicitly asked to touch it.

- [ ] **Step 6: Commit packaged DB updates**

```bash
git add database/farming.db web/react-gui/farming.db conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
git commit -m "chore(sync): refresh packaged DB history schema"
```

---

## Deferred Follow-Up: Durable History Batch Cutover

Do not do this in the remediation patch.

Future cutover requires a separate plan that implements real durable mirror writes for:

- `device_data -> sensor_data`
- `chameleon_readings -> chameleon_readings`
- `dendrometer_readings -> dendro_readings`
- derived daily/environment/recommendation rows
- irrigation events or a deliberate decision to keep them event-based

Only after that plan passes parity manifests and replay tests should we remove legacy telemetry outbox triggers or narrow bootstrap history arrays.

## Self-Review

- Spec coverage: all consolidated critical findings are addressed by Tasks 1-7. Verification/style findings are addressed by Task 8. Packaged DB parity is addressed by Task 9.
- Placeholder scan: no placeholder markers or open-ended implementation gaps remain. The only deferred work is explicitly out of scope and named as a separate future cutover.
- Type consistency: `last_shadow_acked_id`, `last_shadow_acked_key`, and `last_shadow_error` are used consistently in schema, migration, builder, marker, and tests. `history_sync_v1_confirmed` is not used as a durable mirror flag.
