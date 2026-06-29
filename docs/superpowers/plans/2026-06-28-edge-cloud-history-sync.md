# Edge Cloud History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the new edge-authoritative history sync protocol so linked hubs converge to cloud parity while never-linked hubs generate no sync outbox or history dirty-key rows.

**Architecture:** Implement the protocol in stages: server contract and hash fixtures first, then edge schema/link gates, then shadow raw-history upload, then parity and controlled trigger removal. Raw history uses id-cursor insert tailing plus dirty keys for post-insert corrections; structural/config changes stay on a link-gated `sync_outbox`.

**Tech Stack:** OSI OS Node-RED flows, SQLite, bundled seed DBs, Node.js verifier scripts, OSI Server Spring Boot 3.4/Java 17, Flyway, Spring MVC tests, JUnit.

---

## Scope Check

The spec spans two repositories and several independent runtime planes. Execute it as paired branch work:

- `osi-server`: protocol contract, Flyway schema, endpoint, server mappers, manifest comparison, compatibility tests.
- `osi-os`: hash fixtures, SQLite schema, link-gated triggers, history uploader, shadow mode, parity manifests, trigger removal.

Do not remove existing telemetry/history outbox triggers until the shadow uploader, correction dirty keys, and hash parity tests pass for the affected table family.

## File Map

### OSI OS Files

- Create: `docs/sync/history-hash-v1-fixtures.json`
- Create: `scripts/lib/history-hash-v1.js`
- Create: `scripts/verify-history-hash-fixtures.js`
- Create: `scripts/test-sync-history-schema.js`
- Create: `scripts/test-sync-history-worker.js`
- Create: `database/migrations/2026-06-28-history-sync-v1.sql`
- Modify: `database/seed-blank.sql`
- Modify: `scripts/verify-db-schema-consistency.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Exclude flow edits by default: `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json`
  unless the baseline check finds active sync nodes in that profile.
- Modify or create helper: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Mirror helper: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Modify packaged DBs listed in `scripts/verify-db-schema-consistency.js`

### OSI Server Files

- Create: `../osi-server/docs/sync/history-sync-v1.md`
- Mirror: `../osi-server/docs/sync/history-hash-v1-fixtures.json`
- Create: `../osi-server/backend/src/main/resources/db/migration/V2026_06_28_001__edge_history_sync_v1.sql`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryHashV1.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryBatchRequest.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryBatchResponse.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryManifestRequest.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryRowIndexRepository.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`
- Modify: `../osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`
- Modify: `../osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Create: `../osi-server/backend/src/test/java/org/osi/server/sync/history/HistoryHashV1Test.java`
- Create: `../osi-server/backend/src/test/java/org/osi/server/sync/history/EdgeHistoryIngestServiceTest.java`
- Modify: `../osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`

## Task 0: Create Clean Worktrees

**Files:**
- No source changes.

- [ ] **Step 1: Confirm dirty state in both repos**

Run:

```bash
cd /home/phil/Repos/osi-os
git status --short --branch
cd /home/phil/Repos/osi-server
git status --short --branch
```

Expected: Any existing dirty files are identified before implementation starts. Do not stage them unless they belong to the current task.

- [ ] **Step 2: Create paired feature branches or worktrees**

Run:

```bash
cd /home/phil/Repos/osi-os
git switch -c feat/history-sync-v1-edge
cd /home/phil/Repos/osi-server
git switch -c feat/history-sync-v1-server
```

Expected: Two feature branches exist. If either repo is dirty, create separate worktrees instead of switching the dirty checkout.

- [ ] **Step 3: Baseline verification**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
! rg -q "Sync Init Schema \\+ Triggers|/api/v1/sync/edge|sync_outbox" conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests '*sync*'
```

Expected: Existing baseline state is known. The bcm2708 flow check should return
no matches; if it finds sync nodes, update this plan before implementation
instead of silently skipping or half-migrating that profile. If a baseline test
fails before any edit, record it in the task notes and do not attribute it to
this work.

## Task 1: Hash Contract and Shared Fixtures

**Files:**
- Create: `docs/sync/history-hash-v1-fixtures.json`
- Create: `scripts/lib/history-hash-v1.js`
- Create: `scripts/verify-history-hash-fixtures.js`
- Mirror: `../osi-server/docs/sync/history-hash-v1-fixtures.json`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryHashV1.java`
- Create: `../osi-server/backend/src/test/java/org/osi/server/sync/history/HistoryHashV1Test.java`

- [ ] **Step 1: Write OSI OS fixture file**

Create `docs/sync/history-hash-v1-fixtures.json` with this structure:

```json
{
  "fixtureSet": "history-hash-v1",
  "hashVersion": 1,
  "fixtures": [
    {
      "name": "device-data-null-and-real",
      "tableName": "device_data",
      "historyKey": "DEVICE_DATA|0016C001F11715E2|123",
      "sourceRow": {
        "id": 123,
        "deveui": "A84041CAFECAFE01",
        "recorded_at": "2026-06-28T10:00:00Z",
        "swt_1": 1,
        "swt_2": null,
        "dendro_valid": 1
      },
      "expectedColumns": [
        ["id", "INTEGER", "123"],
        ["deveui", "TEXT", "A84041CAFECAFE01"],
        ["recorded_at", "TIMESTAMP", "2026-06-28T10:00:00.000Z"],
        ["swt_1", "REAL", "3ff0000000000000"],
        ["swt_2", "REAL", null],
        ["dendro_valid", "BOOLEAN", true]
      ],
      "expectedSha256": "39eb29940bfb23a1d5b84a573daf646e48c5e4e768d2068385fa5083fd62a371"
    },
    {
      "name": "json-sorted-keys",
      "tableName": "zone_daily_recommendations",
      "historyKey": "ZONE_RECOMMENDATION|zone-uuid-1|2026-06-28",
      "sourceRow": {
        "zone_uuid": "zone-uuid-1",
        "date": "2026-06-28",
        "recommendation_json": "{\"b\":null,\"a\":1}"
      },
      "expectedColumns": [
        ["zone_uuid", "TEXT", "zone-uuid-1"],
        ["date", "TEXT", "2026-06-28"],
        ["recommendation_json", "JSON", "{\"a\":1,\"b\":null}"]
      ],
      "expectedSha256": "96c335b96ef460e48f55ecb04b4b58d76d43007fa1f973e24a0ced6fe29c6b71"
    }
  ]
}
```

These hashes are generated from the canonicalization code in Step 2. The
verification step proves that row-to-column conversion, JSON key sorting, REAL
encoding, and Node.js/Java digest generation agree. If any canonicalization code
changes, regenerate the expected hashes in the same commit and review the byte
input printed by the verifier.

- [ ] **Step 2: Implement OSI OS hash verifier**

Create `scripts/lib/history-hash-v1.js`:

```js
const crypto = require('crypto');

const TABLE_COLUMNS = {
  device_data: [
    ['id', 'INTEGER'],
    ['deveui', 'TEXT'],
    ['recorded_at', 'TIMESTAMP'],
    ['swt_1', 'REAL'],
    ['swt_2', 'REAL'],
    ['dendro_valid', 'BOOLEAN']
  ],
  zone_daily_recommendations: [
    ['zone_uuid', 'TEXT'],
    ['date', 'TEXT'],
    ['recommendation_json', 'JSON']
  ]
};

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function encodeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp ${value}`);
  return date.toISOString();
}

function encodeReal(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid REAL ${value}`);
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(Object.is(number, -0) ? 0 : number, 0);
  return buffer.toString('hex');
}

function encodeJson(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return canonicalJson(parsed);
}

function encodeValue(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'TEXT') return String(value);
  if (type === 'INTEGER') return String(Number.parseInt(value, 10));
  if (type === 'REAL') return encodeReal(value);
  if (type === 'BOOLEAN') return !!Number(value);
  if (type === 'TIMESTAMP') return encodeTimestamp(value);
  if (type === 'JSON') return encodeJson(value);
  throw new Error(`unsupported hash type ${type}`);
}

function buildCanonicalColumns(tableName, row) {
  const spec = TABLE_COLUMNS[tableName];
  if (!spec) throw new Error(`unsupported history table ${tableName}`);
  return spec.map(([name, type]) => [name, type, encodeValue(type, row[name])]);
}

function columnsForHash(row) {
  return row.columns || row.expectedColumns || buildCanonicalColumns(row.tableName, row.sourceRow || row.payload || {});
}

function encodeHashInput(row) {
  return JSON.stringify({
    hashVersion: 1,
    tableName: row.tableName,
    historyKey: row.historyKey,
    columns: columnsForHash(row)
  });
}

function hashRow(row) {
  return crypto.createHash('sha256').update(Buffer.from(encodeHashInput(row), 'utf8')).digest('hex');
}

module.exports = { buildCanonicalColumns, encodeHashInput, hashRow };
```

Create `scripts/verify-history-hash-fixtures.js`:

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildCanonicalColumns, encodeHashInput, hashRow } = require('./lib/history-hash-v1');

const fixturePath = path.resolve(__dirname, '..', 'docs', 'sync', 'history-hash-v1-fixtures.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
let ok = true;

for (const row of fixture.fixtures) {
  const columns = buildCanonicalColumns(row.tableName, row.sourceRow);
  if (JSON.stringify(columns) !== JSON.stringify(row.expectedColumns)) {
    console.error(`${row.name}: canonical columns mismatch`);
    console.error(JSON.stringify(columns));
    ok = false;
  }
  console.log(`${row.name}.hashInput=${encodeHashInput(row)}`);
  const actual = hashRow(row);
  if (actual !== row.expectedSha256) {
    console.error(`${row.name}: expected ${row.expectedSha256}, got ${actual}`);
    ok = false;
  }
}

const fixtureSetSha256 = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
console.log(`fixtureSetSha256=${fixtureSetSha256}`);
if (!ok) process.exit(1);
```

- [ ] **Step 3: Run fixture verifier red-green**

Run:

```bash
node scripts/verify-history-hash-fixtures.js
```

Expected: PASS and prints `fixtureSetSha256=...`.

- [ ] **Step 4: Mirror fixtures and implement Java verifier**

Copy the finalized fixture file:

```bash
mkdir -p ../osi-server/docs/sync
cp docs/sync/history-hash-v1-fixtures.json ../osi-server/docs/sync/history-hash-v1-fixtures.json
```

Create `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryHashV1.java`:

```java
package org.osi.server.sync.history;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

public final class HistoryHashV1 {
    public static final int VERSION = 1;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private HistoryHashV1() {
    }

    public static String hash(JsonNode row) {
        JsonNode columns = row.has("columns") ? row.get("columns") : row.get("expectedColumns");
        return hash(row.get("tableName").asText(), row.get("historyKey").asText(), columns);
    }

    public static String hash(String tableName, String historyKey, JsonNode columns) {
        try {
            ObjectNode root = MAPPER.createObjectNode();
            root.put("hashVersion", VERSION);
            root.put("tableName", tableName);
            root.put("historyKey", historyKey);
            root.set("columns", columns);
            byte[] bytes = MAPPER.writeValueAsBytes(root);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalArgumentException("cannot hash history row", e);
        }
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalArgumentException("cannot hash bytes", e);
        }
    }
}
```

Create `../osi-server/backend/src/test/java/org/osi/server/sync/history/HistoryHashV1Test.java`:

```java
package org.osi.server.sync.history;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class HistoryHashV1Test {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void fixturesMatchExpectedHashes() throws Exception {
        Path fixturePath = Path.of("..", "docs", "sync", "history-hash-v1-fixtures.json");
        JsonNode fixture = MAPPER.readTree(Files.readString(fixturePath));
        for (JsonNode row : fixture.get("fixtures")) {
            assertThat(HistoryHashV1.hash(row)).isEqualTo(row.get("expectedSha256").asText());
        }
        System.out.println("fixtureSetSha256=" + HistoryHashV1.sha256(Files.readAllBytes(fixturePath)));
    }
}
```

- [ ] **Step 5: Run both fixture test suites**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-history-hash-fixtures.js
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests 'org.osi.server.sync.history.HistoryHashV1Test'
```

Expected: Both pass and print the same fixture set SHA-256.

- [ ] **Step 6: Commit**

Run:

```bash
cd /home/phil/Repos/osi-os
git add docs/sync/history-hash-v1-fixtures.json scripts/lib/history-hash-v1.js scripts/verify-history-hash-fixtures.js
git commit -m "feat(sync): add history hash v1 fixtures"
cd /home/phil/Repos/osi-server
git add docs/sync/history-hash-v1-fixtures.json backend/src/main/java/org/osi/server/sync/history/HistoryHashV1.java backend/src/test/java/org/osi/server/sync/history/HistoryHashV1Test.java
git commit -m "feat(sync): add history hash v1 fixtures"
```

## Task 2: Server History Index and Batch Endpoint Skeleton

**Files:**
- Create: `../osi-server/docs/sync/history-sync-v1.md`
- Create: `../osi-server/backend/src/main/resources/db/migration/V2026_06_28_001__edge_history_sync_v1.sql`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryBatchRequest.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryBatchResponse.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryManifestRequest.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryRowIndexRepository.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`
- Modify: `../osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`
- Modify: `../osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`

- [ ] **Step 1: Write server protocol pointer**

Create `../osi-server/docs/sync/history-sync-v1.md`:

```markdown
# Edge History Sync V1

Source of truth: `../osi-os/docs/superpowers/specs/2026-06-28-sync-architecture-redesign.md`.

Server responsibilities:

- Accept `POST /api/v1/sync/edge/history/batches`.
- Accept `POST /api/v1/sync/edge/history/manifests`.
- Store idempotency in `edge_history_row_index`.
- Use `hashVersion=1` and the shared fixture file `docs/sync/history-hash-v1-fixtures.json`.
- Return explicit `ackedThroughId` or `ackedThroughKey` for committed prefixes.
- Keep legacy `/api/v1/sync/edge/events` and `/api/v1/sync/edge/bootstrap` compatibility paths.
```

- [ ] **Step 2: Add Flyway migration**

Create `../osi-server/backend/src/main/resources/db/migration/V2026_06_28_001__edge_history_sync_v1.sql`:

```sql
CREATE TABLE IF NOT EXISTS edge_history_row_index (
    gateway_eui VARCHAR(32) NOT NULL,
    table_name VARCHAR(80) NOT NULL,
    history_key VARCHAR(180) NOT NULL,
    natural_key VARCHAR(240),
    hash_version INTEGER NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    server_table VARCHAR(80) NOT NULL,
    server_row_id VARCHAR(80),
    conflict_state VARCHAR(30),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (gateway_eui, table_name, history_key)
);

CREATE INDEX IF NOT EXISTS idx_edge_history_row_index_gateway_table
    ON edge_history_row_index(gateway_eui, table_name);

CREATE TABLE IF NOT EXISTS edge_history_quarantine (
    gateway_eui VARCHAR(32) NOT NULL,
    table_name VARCHAR(80) NOT NULL,
    history_key VARCHAR(180) NOT NULL,
    hash_version INTEGER NOT NULL,
    payload_hash VARCHAR(64),
    reason TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (gateway_eui, table_name, history_key)
);

CREATE TABLE IF NOT EXISTS edge_history_segment_state (
    gateway_eui VARCHAR(32) NOT NULL,
    table_name VARCHAR(80) NOT NULL,
    segment_key VARCHAR(180) NOT NULL,
    hash_version INTEGER NOT NULL,
    canonical_row_count BIGINT NOT NULL,
    syncable_row_count BIGINT NOT NULL,
    quarantined_count BIGINT NOT NULL,
    syncable_payload_hash VARCHAR(64) NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (gateway_eui, table_name, segment_key, hash_version)
);
```

- [ ] **Step 3: Add DTO records**

Create `HistoryBatchRequest.java`:

```java
package org.osi.server.sync.history;

import java.util.List;
import java.util.Map;

public record HistoryBatchRequest(
        int protocolVersion,
        String gatewayDeviceEui,
        String batchId,
        String tableName,
        String phase,
        int hashVersion,
        Cursor cursor,
        List<Row> rows
) {
    public record Cursor(Long fromId, Long toId, String fromKey, String toKey) {}
    public record Row(String historyKey, String naturalKey, String payloadHash, Map<String, Object> payload) {}
}
```

Create `HistoryBatchResponse.java`:

```java
package org.osi.server.sync.history;

import java.util.List;

public record HistoryBatchResponse(
        String batchId,
        String tableName,
        int hashVersion,
        Long ackedThroughId,
        String ackedThroughKey,
        Integer recommendedBatchSize,
        Integer minIntervalMs,
        List<RowResult> results
) {
    public enum Status {
        APPLIED,
        DUPLICATE,
        UPDATED,
        QUARANTINED,
        REJECTED_PERMANENT,
        RETRYABLE_ERROR
    }

    public record RowResult(String historyKey, Status status, String reason) {}
}
```

Create `HistoryManifestRequest.java`:

```java
package org.osi.server.sync.history;

import java.util.List;

public record HistoryManifestRequest(
        String gatewayDeviceEui,
        String generatedAt,
        List<Segment> segments
) {
    public record Segment(
            String tableName,
            String segmentKey,
            int hashVersion,
            long canonicalRowCount,
            long syncableRowCount,
            long quarantinedCount,
            String syncablePayloadHash
    ) {}
}
```

- [ ] **Step 4: Add repository and service skeleton**

Create `HistoryRowIndexRepository.java`:

```java
package org.osi.server.sync.history;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.Map;
import java.util.Optional;

@Repository
@RequiredArgsConstructor
public class HistoryRowIndexRepository {
    private final NamedParameterJdbcTemplate jdbc;

    public Optional<Map<String, Object>> find(String gatewayEui, String tableName, String historyKey) {
        var rows = jdbc.queryForList("""
                SELECT gateway_eui, table_name, history_key, hash_version, payload_hash, server_table, server_row_id
                FROM edge_history_row_index
                WHERE gateway_eui = :gatewayEui AND table_name = :tableName AND history_key = :historyKey
                """, new MapSqlParameterSource()
                .addValue("gatewayEui", gatewayEui)
                .addValue("tableName", tableName)
                .addValue("historyKey", historyKey));
        return rows.stream().findFirst();
    }

    public void upsert(String gatewayEui, String tableName, String historyKey, String naturalKey, int hashVersion, String payloadHash, String serverTable, String serverRowId, String conflictState) {
        jdbc.update("""
                INSERT INTO edge_history_row_index(
                    gateway_eui, table_name, history_key, natural_key, hash_version, payload_hash,
                    server_table, server_row_id, conflict_state, last_seen_at
                ) VALUES (
                    :gatewayEui, :tableName, :historyKey, :naturalKey, :hashVersion, :payloadHash,
                    :serverTable, :serverRowId, :conflictState, now()
                )
                ON CONFLICT (gateway_eui, table_name, history_key)
                DO UPDATE SET
                    natural_key = EXCLUDED.natural_key,
                    hash_version = EXCLUDED.hash_version,
                    payload_hash = EXCLUDED.payload_hash,
                    server_table = EXCLUDED.server_table,
                    server_row_id = EXCLUDED.server_row_id,
                    conflict_state = EXCLUDED.conflict_state,
                    last_seen_at = now()
                """, new MapSqlParameterSource()
                .addValue("gatewayEui", gatewayEui)
                .addValue("tableName", tableName)
                .addValue("historyKey", historyKey)
                .addValue("naturalKey", naturalKey)
                .addValue("hashVersion", hashVersion)
                .addValue("payloadHash", payloadHash)
                .addValue("serverTable", serverTable)
                .addValue("serverRowId", serverRowId)
                .addValue("conflictState", conflictState));
    }
}
```

Create `EdgeHistoryIngestService.java`:

```java
package org.osi.server.sync.history;

import lombok.RequiredArgsConstructor;
import org.osi.server.user.AuthController;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Map;
import java.util.Objects;

@Service
@RequiredArgsConstructor
public class EdgeHistoryIngestService {
    private final HistoryRowIndexRepository rowIndexRepository;

    @Transactional
    public HistoryBatchResponse applyBatch(HistoryBatchRequest request) {
        String gatewayEui = AuthController.normalizeGatewayDeviceEui(request.gatewayDeviceEui());
        if (gatewayEui == null) {
            throw new IllegalArgumentException("gatewayDeviceEui is required");
        }
        if (request.hashVersion() != HistoryHashV1.VERSION) {
            return stopBeforeFirstRow(request, "unsupported_hash_version");
        }
        if ("shadow".equalsIgnoreCase(String.valueOf(request.phase()))) {
            return shadowAccepted(request);
        }

        var results = new ArrayList<HistoryBatchResponse.RowResult>();
        Long ackedThroughId = null;
        String ackedThroughKey = null;

        for (HistoryBatchRequest.Row row : request.rows()) {
            var existing = rowIndexRepository.find(gatewayEui, request.tableName(), row.historyKey());
            if (existing.isPresent() && Objects.equals(existing.get().get("payload_hash"), row.payloadHash())) {
                results.add(new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.DUPLICATE, null));
            } else {
                String conflictState = existing.isPresent() ? "EDGE_OVERWROTE_SERVER" : null;
                rowIndexRepository.upsert(gatewayEui, request.tableName(), row.historyKey(), row.naturalKey(), request.hashVersion(), row.payloadHash(), request.tableName(), row.historyKey(), conflictState);
                results.add(new HistoryBatchResponse.RowResult(row.historyKey(), existing.isPresent() ? HistoryBatchResponse.Status.UPDATED : HistoryBatchResponse.Status.APPLIED, null));
            }
            ackedThroughId = maxCursorId(ackedThroughId, row.historyKey());
            ackedThroughKey = row.historyKey();
        }

        return new HistoryBatchResponse(request.batchId(), request.tableName(), request.hashVersion(), ackedThroughId, ackedThroughKey, 500, 30000, results);
    }

    private HistoryBatchResponse shadowAccepted(HistoryBatchRequest request) {
        var results = request.rows().stream()
                .map((row) -> new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.APPLIED, "shadow_only"))
                .toList();
        return new HistoryBatchResponse(request.batchId(), request.tableName(), request.hashVersion(), null, null, 500, 30000, results);
    }

    private HistoryBatchResponse stopBeforeFirstRow(HistoryBatchRequest request, String reason) {
        var result = request.rows().isEmpty()
                ? java.util.List.<HistoryBatchResponse.RowResult>of()
                : java.util.List.of(new HistoryBatchResponse.RowResult(request.rows().get(0).historyKey(), HistoryBatchResponse.Status.REJECTED_PERMANENT, reason));
        return new HistoryBatchResponse(request.batchId(), request.tableName(), request.hashVersion(), null, null, 500, 30000, result);
    }

    private Long maxCursorId(Long previous, String historyKey) {
        int pos = historyKey.lastIndexOf('|');
        if (pos < 0) return previous;
        try {
            long id = Long.parseLong(historyKey.substring(pos + 1));
            return previous == null ? id : Math.max(previous, id);
        } catch (NumberFormatException ignored) {
            return previous;
        }
    }
}
```

This skeleton only indexes non-shadow rows. Shadow uploads must not populate
`edge_history_row_index`, because Task 8 mappers would otherwise see unwritten
rows as duplicates. Later tasks replace table-name-as-server-table behavior with
explicit table mappers before durable ACK cursoring is enabled.

- [ ] **Step 5: Wire controller endpoints**

Modify `EdgeSyncController` constructor dependencies:

```java
private final org.osi.server.sync.history.EdgeHistoryIngestService edgeHistoryIngestService;
```

Add endpoints:

```java
@PostMapping("/edge/history/batches")
public ResponseEntity<?> applyHistoryBatch(
        @AuthenticationPrincipal UserDetails userDetails,
        @RequestHeader(value = "Authorization", required = false) String authorization,
        @RequestBody org.osi.server.sync.history.HistoryBatchRequest request) {
    if (!isAuthorizedForGateway(userDetails, authorization, request.gatewayDeviceEui())) {
        return ResponseEntity.status(403).build();
    }
    return ResponseEntity.ok(edgeHistoryIngestService.applyBatch(request));
}

@PostMapping("/edge/history/manifests")
public ResponseEntity<?> applyHistoryManifest(
        @AuthenticationPrincipal UserDetails userDetails,
        @RequestHeader(value = "Authorization", required = false) String authorization,
        @RequestBody org.osi.server.sync.history.HistoryManifestRequest request) {
    if (!isAuthorizedForGateway(userDetails, authorization, request.gatewayDeviceEui())) {
        return ResponseEntity.status(403).build();
    }
    return ResponseEntity.accepted().body(Map.of("success", true));
}
```

- [ ] **Step 6: Add controller test**

Add to `EdgeSyncControllerTest`:

```java
@Mock private org.osi.server.sync.history.EdgeHistoryIngestService edgeHistoryIngestService;

@Test
void historyBatch_acceptsMatchingSyncTokenForOwnedGateway() {
    org.osi.server.user.User user = org.osi.server.user.User.builder().id(7L).username("alice").build();
    Device gateway = Device.builder().deviceEui("GW-1234").type("GATEWAY").claimedBy(user).build();
    UserDetails principal = new User("alice", "ignored", List.of());
    var request = new org.osi.server.sync.history.HistoryBatchRequest(
            1,
            "GW-1234",
            "batch-1",
            "device_data",
            "backfill",
            1,
            new org.osi.server.sync.history.HistoryBatchRequest.Cursor(100L, 101L, null, null),
            List.of(new org.osi.server.sync.history.HistoryBatchRequest.Row(
                    "DEVICE_DATA|GW-1234|101",
                    "sensor|2026-06-28T10:00:00.000Z|101",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    Map.of("id", 101)
            ))
    );
    var batchResponse = new org.osi.server.sync.history.HistoryBatchResponse(
            "batch-1",
            "device_data",
            1,
            101L,
            null,
            500,
            30000,
            List.of()
    );

    when(jwtTokenProvider.validateToken("sync-token")).thenReturn(true);
    when(jwtTokenProvider.isSyncToken("sync-token")).thenReturn(true);
    when(jwtTokenProvider.getGatewayDeviceEuiFromToken("sync-token")).thenReturn("gw-1234");
    when(jwtTokenProvider.getUsernameFromToken("sync-token")).thenReturn("alice");
    when(jwtTokenProvider.getUserIdFromToken("sync-token")).thenReturn(7L);
    when(userService.findByUsername("alice")).thenReturn(user);
    when(deviceService.findByEui("GW-1234")).thenReturn(gateway);
    when(edgeHistoryIngestService.applyBatch(request)).thenReturn(batchResponse);

    var response = edgeSyncController.applyHistoryBatch(principal, "Bearer sync-token", request);

    assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
    assertThat(response.getBody()).isSameAs(batchResponse);
    verify(edgeHistoryIngestService).applyBatch(request);
}
```

- [ ] **Step 7: Run server tests**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests 'org.osi.server.sync.EdgeSyncControllerTest' --tests 'org.osi.server.sync.history.*'
```

Expected: Tests pass.

- [ ] **Step 8: Commit**

Run:

```bash
cd /home/phil/Repos/osi-server
git add docs/sync/history-sync-v1.md backend/src/main/resources/db/migration/V2026_06_28_001__edge_history_sync_v1.sql backend/src/main/java/org/osi/server/sync backend/src/test/java/org/osi/server/sync
git diff --cached --check
git commit -m "feat(sync): add edge history batch endpoint"
```

## Task 3: Edge SQLite Schema

**Files:**
- Create: `database/migrations/2026-06-28-history-sync-v1.sql`
- Modify: `database/seed-blank.sql`
- Create: `scripts/test-sync-history-schema.js`
- Modify: `scripts/verify-db-schema-consistency.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add SQLite migration**

Create `database/migrations/2026-06-28-history-sync-v1.sql`:

```sql
CREATE TABLE IF NOT EXISTS sync_link_state (
  peer_node TEXT PRIMARY KEY,
  linked INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  cloud_user_id TEXT,
  gateway_device_eui TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_history_cursors (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'backfill',
  snapshot_high_id INTEGER,
  last_acked_id INTEGER,
  last_acked_key TEXT,
  backfill_started_at TEXT,
  backfill_completed_at TEXT,
  last_batch_id TEXT,
  last_batch_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name)
);

CREATE TABLE IF NOT EXISTS sync_history_dirty_keys (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  change_kind TEXT NOT NULL DEFAULT 'correction',
  source_row_id INTEGER,
  changed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name, row_key)
);

CREATE TABLE IF NOT EXISTS sync_history_segments (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  hash_version INTEGER NOT NULL,
  canonical_row_count INTEGER NOT NULL,
  syncable_row_count INTEGER NOT NULL,
  syncable_payload_hash TEXT NOT NULL,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  covered_max_id INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (peer_node, table_name, segment_key, hash_version)
);

CREATE TABLE IF NOT EXISTS sync_history_quarantine (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  history_key TEXT NOT NULL,
  payload_hash TEXT,
  reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (peer_node, table_name, history_key)
);

ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_irrigation_events_event_uuid
  ON irrigation_events(event_uuid);
```

For SQLite seed files that already have `event_uuid`, wrap the `ALTER TABLE` in the existing runtime migration helper instead of executing it twice. The seed SQL should define the column directly.

- [ ] **Step 2: Add schema to `database/seed-blank.sql`**

Insert the tables after `sync_cursor`. Add `event_uuid TEXT` to `irrigation_events` and add `idx_irrigation_events_event_uuid`.

- [ ] **Step 3: Write schema regression test**

Create `scripts/test-sync-history-schema.js`:

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const schema = fs.readFileSync(path.resolve(__dirname, '..', 'database', 'seed-blank.sql'), 'utf8');
const db = new sqlite3.Database(':memory:');

function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

function exec(sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
}

(async () => {
  await exec(schema);
  const tables = await all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sync_history_%' OR name='sync_link_state'");
  const names = new Set(tables.map((row) => row.name));
  for (const name of ['sync_link_state', 'sync_history_cursors', 'sync_history_dirty_keys', 'sync_history_segments', 'sync_history_quarantine']) {
    if (!names.has(name)) throw new Error(`missing ${name}`);
  }
  const irrigationColumns = await all("PRAGMA table_info(irrigation_events)");
  if (!irrigationColumns.some((row) => row.name === 'event_uuid')) throw new Error('missing irrigation_events.event_uuid');
  console.log('OK sync history schema');
  db.close();
})().catch((err) => {
  console.error(err.stack || err.message || err);
  db.close();
  process.exit(1);
});
```

- [ ] **Step 4: Extend verifiers**

Modify `scripts/verify-db-schema-consistency.js` `schemaContract` to include:

```js
sync_link_state: ['peer_node', 'linked', 'server_url', 'cloud_user_id', 'gateway_device_eui', 'updated_at'],
sync_history_cursors: ['peer_node', 'table_name', 'state', 'snapshot_high_id', 'last_acked_id', 'last_acked_key', 'backfill_started_at', 'backfill_completed_at', 'last_batch_id', 'last_batch_at', 'retry_count', 'next_attempt_at', 'last_error'],
sync_history_dirty_keys: ['peer_node', 'table_name', 'row_key', 'change_kind', 'source_row_id', 'changed_at', 'status', 'attempts', 'next_attempt_at', 'last_error'],
sync_history_segments: ['peer_node', 'table_name', 'segment_key', 'hash_version', 'canonical_row_count', 'syncable_row_count', 'syncable_payload_hash', 'quarantined_count', 'covered_max_id', 'computed_at'],
sync_history_quarantine: ['peer_node', 'table_name', 'history_key', 'payload_hash', 'reason', 'first_seen_at', 'last_seen_at', 'attempts'],
```

Modify `scripts/verify-sync-flow.js` to execute the new test:

```js
execFileSync(process.execPath, [path.resolve(__dirname, 'test-sync-history-schema.js')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.resolve(__dirname, 'verify-history-hash-fixtures.js')], { stdio: 'inherit' });
```

- [ ] **Step 5: Apply schema to packaged DBs**

Run the migration against every DB path from `scripts/verify-db-schema-consistency.js`:

```bash
for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do
  sqlite3 "$db" < database/migrations/2026-06-28-history-sync-v1.sql
done
```

Expected: SQLite exits 0 for each database. If `event_uuid` already exists in a database, update the migration to use a runtime column-existence guard before rerunning.

- [ ] **Step 6: Run edge verifiers**

Run:

```bash
node scripts/test-sync-history-schema.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: All pass. This task does not assert zero raw-history outbox rows yet,
because the old raw outbox triggers intentionally remain active until Task 10.

- [ ] **Step 7: Commit**

Run:

```bash
git add database scripts docs/sync conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db web/react-gui/farming.db
git diff --cached --check
git commit -m "feat(sync): add edge history sync schema"
```

## Task 4: Link-State Lifecycle and Link-Gated Structural Outbox Triggers

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-sync-history-schema.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add link-state lifecycle verifier expectations**

Modify `scripts/verify-sync-flow.js` to require that the existing account-link
nodes populate the new link gate before any structural triggers depend on it:

```js
expectIncludes('Finalize linked account state', 'INSERT INTO sync_link_state', 'persists sync_link_state on successful account link');
expectIncludes('Finalize linked account state', "flow.set('account_linked', true)", 'sets account_linked flow flag on successful account link');
expectIncludes('Clear linked account state', 'UPDATE sync_link_state', 'marks sync_link_state unlinked during unlink');
expectIncludes('Clear linked account state', "flow.set('account_linked', false)", 'clears account_linked flow flag during unlink');
expectIncludes('Build History Batch', "flow.get('account_linked')", 'history worker uses populated account_linked flag');
```

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected before implementation: FAIL because `sync_link_state` is not written by
the account-link finalization path.

- [ ] **Step 2: Persist link state on link and unlink**

In `Finalize linked account state`, after the linked user/token update succeeds,
open `/data/db/farming.db` and upsert link state:

```js
const now = new Date().toISOString();
const db = new osiDb.Database('/data/db/farming.db');
const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params || [], (err) => err ? reject(err) : resolve()));
const close = () => new Promise((resolve) => db.close(() => resolve()));
try {
  await run([
    'INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at)',
    "VALUES('cloud', 1, ?, ?, ?, ?)",
    'ON CONFLICT(peer_node) DO UPDATE SET',
    'linked=1, server_url=excluded.server_url, cloud_user_id=excluded.cloud_user_id,',
    'gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at'
  ].join(' '), [
    String(flow.get('al_server_url') || '').trim(),
    String(flow.get('al_cloud_user_id') || '').trim(),
    String(flow.get('al_gateway_device_eui') || '').trim().toUpperCase(),
    now
  ]);
} finally {
  await close();
}
flow.set('account_linked', true);
flow.set('history_sync_v1_confirmed', false);
```

In `Clear linked account state`, mark the peer unlinked before clearing `al_*`
flow values:

```js
const db = new osiDb.Database('/data/db/farming.db');
const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params || [], (err) => err ? reject(err) : resolve()));
const close = () => new Promise((resolve) => db.close(() => resolve()));
try {
  await run("UPDATE sync_link_state SET linked=0, updated_at=? WHERE peer_node='cloud'", [new Date().toISOString()]);
  await run("DELETE FROM sync_history_dirty_keys WHERE peer_node='cloud'");
} finally {
  await close();
}
flow.set('account_linked', false);
flow.set('history_sync_v1_confirmed', false);
```

Do not delete canonical history. Do not clear history cursors unless the unlink
flow no longer has enough account identity to prove same-account relink.

- [ ] **Step 3: Run link-state verifier**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: The link lifecycle expectations pass.

- [ ] **Step 4: Write failing link-gate test**

Extend `scripts/test-sync-history-schema.js` after schema creation:

```js
await exec("INSERT INTO users(id, username, password_hash, user_uuid) VALUES(1, 'local', 'x', 'user-1')");
await exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(1, 1, 'Zone 1', 'zone-1', '0016C001F11715E2', 1)");
let outbox = await all("SELECT COUNT(*) AS count FROM sync_outbox");
if (Number(outbox[0].count) !== 0) throw new Error('unlinked structural insert created outbox row');
await exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES('cloud', 1, '0016C001F11715E2', '2026-06-28T10:00:00.000Z')");
await exec("UPDATE irrigation_zones SET name='Zone linked', sync_version=2 WHERE id=1");
outbox = await all("SELECT COUNT(*) AS count FROM sync_outbox WHERE aggregate_type='ZONE'");
if (Number(outbox[0].count) !== 1) throw new Error('linked structural update did not create outbox row');
```

Run:

```bash
node scripts/test-sync-history-schema.js
```

Expected before trigger edits: FAIL because unlinked structural changes still create outbox rows.

- [ ] **Step 5: Add link gate to structural triggers**

In `database/seed-blank.sql`, add this predicate to structural outbox triggers:

```sql
EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
```

For triggers with an existing `WHEN` clause, wrap existing predicates:

```sql
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND (
    COALESCE(NEW.user_id,'') <> COALESCE(OLD.user_id,'') OR
    COALESCE(NEW.irrigation_zone_id,'') <> COALESCE(OLD.irrigation_zone_id,'') OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
  )
```

For triggers without a `WHEN` clause, add:

```sql
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
```

Apply the same generated trigger SQL inside the `Sync Init Schema + Triggers` Node-RED function in both Pi flow files.

- [ ] **Step 6: Verify expected structural trigger set**

Modify `scripts/verify-sync-flow.js` to assert the structural trigger bodies include `sync_link_state`:

```js
for (const triggerName of [
  'trg_sync_zones_outbox_ai',
  'trg_sync_zones_outbox_au',
  'trg_sync_devices_outbox_au',
  'trg_sync_schedules_outbox_au',
  'trg_gateway_locations_outbox_ai',
  'trg_gateway_locations_outbox_au'
]) {
  expectFileIncludes('seed-blank.sql', seedSql, triggerName, `defines ${triggerName}`);
}
expectFileIncludes('seed-blank.sql', seedSql, 'sync_link_state', 'link-gates sync triggers');
```

- [ ] **Step 7: Run edge verifiers**

Run:

```bash
node scripts/test-sync-history-schema.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: All pass and the schema test confirms never-linked structural inserts do not write `sync_outbox`.

- [ ] **Step 8: Commit**

Run:

```bash
git add database/seed-blank.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-schema.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat(sync): gate structural outbox triggers by link state"
```

## Task 5: Raw Correction and Derived Dirty-Key Triggers

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-sync-history-schema.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add failing dirty-key tests**

Extend `scripts/test-sync-history-schema.js`:

```js
await exec("INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, changed_at) SELECT 'cloud', 'sentinel', 'sentinel', '2026-06-28T10:00:00.000Z' WHERE 0");
await exec("INSERT INTO devices(deveui, type_id, user_id, irrigation_zone_id, gateway_device_eui) VALUES('A84041CAFECAFE01', 'DRAGINO_LSN50', 1, 1, '0016C001F11715E2')");
await exec("INSERT INTO device_data(id, deveui, recorded_at, swt_1) VALUES(101, 'A84041CAFECAFE01', '2026-06-28T10:00:00.000Z', 10.0)");
await exec("UPDATE device_data SET swt_1=11.0 WHERE id=101");
let dirty = await all("SELECT COUNT(*) AS count FROM sync_history_dirty_keys WHERE table_name='device_data' AND row_key='DEVICE_DATA|0016C001F11715E2|101'");
if (Number(dirty[0].count) !== 1) throw new Error('linked raw correction did not create dirty key');
await exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(1, '2026-06-28', 2.5, '2026-06-28T10:00:00.000Z')");
dirty = await all("SELECT COUNT(*) AS count FROM sync_history_dirty_keys WHERE table_name='zone_daily_environment' AND row_key='ZONE_ENVIRONMENT|zone-1|2026-06-28'");
if (Number(dirty[0].count) !== 1) throw new Error('zone environment dirty key did not use zone_uuid');
```

Run:

```bash
node scripts/test-sync-history-schema.js
```

Expected before implementation: FAIL because dirty-key triggers are absent.

- [ ] **Step 2: Add raw update dirty-key triggers**

Add triggers to `database/seed-blank.sql` and the `Sync Init Schema + Triggers` Node-RED SQL:

```sql
CREATE TRIGGER trg_sync_device_data_dirty_au
AFTER UPDATE ON device_data
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node='cloud' AND linked=1)
  AND COALESCE(
    (SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')
  ) IS NOT NULL
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'device_data',
    'DEVICE_DATA|' || COALESCE(
      (SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')
    ) || '|' || NEW.id,
    'correction',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    changed_at=excluded.changed_at,
    status='pending',
    attempts=0,
    last_error=NULL;
END;
```

Add equivalent triggers for:

- `chameleon_readings`: `CHAMELEON_READING|<gateway_eui>|<id>`
- `dendrometer_readings`: `DENDRO_READING|<gateway_eui>|<id>`

- [ ] **Step 3: Add derived upsert dirty-key triggers**

Add triggers for derived tables:

```sql
CREATE TRIGGER trg_sync_zone_env_dirty_ai
AFTER INSERT ON zone_daily_environment
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node='cloud' AND linked=1)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, changed_at)
  VALUES(
    'cloud',
    'zone_daily_environment',
    'ZONE_ENVIRONMENT|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id), '') || '|' || NEW.date,
    'upsert',
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    changed_at=excluded.changed_at,
    status='pending',
    attempts=0,
    last_error=NULL;
END;
```

Add `AFTER UPDATE` companion triggers for `zone_daily_environment`.
Add `AFTER INSERT` and `AFTER UPDATE` triggers for:

- `zone_daily_recommendations`: `ZONE_RECOMMENDATION|<zone_uuid>|<date>`
- `dendrometer_daily`: `DENDRO_DAILY|<deveui>|<date>`

- [ ] **Step 4: Run dirty-key tests and verifiers**

Run:

```bash
node scripts/test-sync-history-schema.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: All pass. The test proves raw correction and zone UUID dirty keys.

- [ ] **Step 5: Commit**

Run:

```bash
git add database/seed-blank.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-schema.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat(sync): track history dirty keys"
```

## Task 6: Edge History Sync Helper and Shadow Worker

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/package.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/package.json`
- Create: `scripts/test-sync-history-worker.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

- [ ] **Step 1: Write helper unit test**

Create `scripts/test-sync-history-worker.js`:

```js
#!/usr/bin/env node
const assert = require('assert');
const helper = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper');

const row = { id: 123, deveui: 'A84041CAFECAFE01', recorded_at: '2026-06-28T10:00:00Z', swt_1: 1, swt_2: null, dendro_valid: 1 };
assert.strictEqual(helper.historyKey('device_data', '0016C001F11715E2', row), 'DEVICE_DATA|0016C001F11715E2|123');
assert.strictEqual(helper.nextRawQuery('device_data'), 'SELECT * FROM device_data WHERE id > ? ORDER BY id ASC LIMIT ?');
assert.deepStrictEqual(helper.buildCanonicalColumns('device_data', row), [
  ['id', 'INTEGER', '123'],
  ['deveui', 'TEXT', 'A84041CAFECAFE01'],
  ['recorded_at', 'TIMESTAMP', '2026-06-28T10:00:00.000Z'],
  ['swt_1', 'REAL', '3ff0000000000000'],
  ['swt_2', 'REAL', null],
  ['dendro_valid', 'BOOLEAN', true]
]);
assert.strictEqual(
  helper.hashHistoryRow('device_data', 'DEVICE_DATA|0016C001F11715E2|123', row),
  '39eb29940bfb23a1d5b84a573daf646e48c5e4e768d2068385fa5083fd62a371'
);
const response = {
  ackedThroughId: 123,
  results: [{ historyKey: 'DEVICE_DATA|0016C001F11715E2|123', status: 'APPLIED' }]
};
assert.deepStrictEqual(helper.cursorPatchFromResponse(response), { last_acked_id: 123, last_error: null, retry_count: 0 });
assert.deepStrictEqual(helper.cursorPatchFromResponse({
  results: [{ historyKey: 'DEVICE_DATA|0016C001F11715E2|124', status: 'REJECTED_PERMANENT', reason: 'unsupported_hash_version' }]
}), { last_error: 'permanent: unsupported_hash_version', next_attempt_at: '9999-12-31T00:00:00.000Z' });
console.log('OK sync history worker helper');
```

Run:

```bash
node scripts/test-sync-history-worker.js
```

Expected before implementation: FAIL because the helper module does not exist.

- [ ] **Step 2: Implement helper**

Create `index.js`:

```js
const crypto = require('crypto');

const TABLE_COLUMNS = {
  device_data: [
    ['id', 'INTEGER'],
    ['deveui', 'TEXT'],
    ['recorded_at', 'TIMESTAMP'],
    ['swt_1', 'REAL'],
    ['swt_2', 'REAL'],
    ['dendro_valid', 'BOOLEAN']
  ],
  zone_daily_recommendations: [
    ['zone_uuid', 'TEXT'],
    ['date', 'TEXT'],
    ['recommendation_json', 'JSON']
  ]
};

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function encodeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp ${value}`);
  return date.toISOString();
}

function encodeReal(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid REAL ${value}`);
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(Object.is(number, -0) ? 0 : number, 0);
  return buffer.toString('hex');
}

function encodeJson(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return canonicalJson(parsed);
}

function encodeValue(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'TEXT') return String(value);
  if (type === 'INTEGER') return String(Number.parseInt(value, 10));
  if (type === 'REAL') return encodeReal(value);
  if (type === 'BOOLEAN') return !!Number(value);
  if (type === 'TIMESTAMP') return encodeTimestamp(value);
  if (type === 'JSON') return encodeJson(value);
  throw new Error(`unsupported hash type ${type}`);
}

function buildCanonicalColumns(tableName, row) {
  const spec = TABLE_COLUMNS[tableName];
  if (!spec) throw new Error(`unsupported history table ${tableName}`);
  return spec.map(([name, type]) => [name, type, encodeValue(type, row[name])]);
}

function hashHistoryRow(tableName, historyKey, row) {
  const input = JSON.stringify({
    hashVersion: 1,
    tableName,
    historyKey,
    columns: buildCanonicalColumns(tableName, row)
  });
  return crypto.createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex');
}

function historyKey(tableName, gatewayEui, row) {
  const gateway = String(gatewayEui || '').trim().toUpperCase();
  if (tableName === 'device_data') return `DEVICE_DATA|${gateway}|${row.id}`;
  if (tableName === 'chameleon_readings') return `CHAMELEON_READING|${gateway}|${row.id}`;
  if (tableName === 'dendrometer_readings') return `DENDRO_READING|${gateway}|${row.id}`;
  if (tableName === 'dendrometer_daily') return `DENDRO_DAILY|${row.deveui}|${row.date}`;
  if (tableName === 'zone_daily_environment') return `ZONE_ENVIRONMENT|${row.zone_uuid}|${row.date}`;
  if (tableName === 'zone_daily_recommendations') return `ZONE_RECOMMENDATION|${row.zone_uuid}|${row.date}`;
  if (tableName === 'irrigation_events') return `IRRIGATION_EVENT|${row.event_uuid}`;
  throw new Error(`unsupported history table ${tableName}`);
}

function nextRawQuery(tableName) {
  if (!['device_data', 'chameleon_readings', 'dendrometer_readings'].includes(tableName)) {
    throw new Error(`not a raw id-cursor table ${tableName}`);
  }
  return `SELECT * FROM ${tableName} WHERE id > ? ORDER BY id ASC LIMIT ?`;
}

function cursorPatchFromResponse(response) {
  const first = Array.isArray(response.results) ? response.results[0] : null;
  if (first && first.status === 'REJECTED_PERMANENT') {
    return { last_error: `permanent: ${first.reason || 'rejected'}`, next_attempt_at: '9999-12-31T00:00:00.000Z' };
  }
  if (response.ackedThroughId == null && response.ackedThroughKey == null) {
    return { last_error: 'missing ACK boundary' };
  }
  if (response.ackedThroughId != null) {
    return { last_acked_id: String(response.ackedThroughId), last_error: null, retry_count: 0 };
  }
  return { last_acked_key: String(response.ackedThroughKey), last_error: null, retry_count: 0 };
}

module.exports = { buildCanonicalColumns, hashHistoryRow, historyKey, nextRawQuery, cursorPatchFromResponse };
```

The packaged Node-RED helper remains self-contained because it ships under
`/usr/share/node-red`. To keep the duplicate hash implementation honest, the
verifier must run the same golden fixtures through `scripts/lib/history-hash-v1.js`
and both profile helper copies, and must assert byte-for-byte helper parity
between `bcm2712` and `bcm2709`.

Create `package.json`:

```json
{
  "name": "osi-history-sync-helper",
  "version": "1.0.0",
  "description": "Edge-to-cloud history sync protocol helper; separate from osi-history-helper GUI/history API helper.",
  "main": "index.js"
}
```

- [ ] **Step 3: Run helper test**

Run:

```bash
node scripts/test-sync-history-worker.js
```

Expected: PASS.

- [ ] **Step 4: Add Node-RED shadow worker nodes**

In both Pi `flows.json` files, add a 60-second inject node and function nodes named:

- `Build History Batch`
- `POST History Batch`
- `Mark History Batch ACK`

The `Build History Batch` function must:

```js
const helper = require('/usr/share/node-red/osi-history-sync-helper');
const batchSize = 250;
const tableName = 'device_data';
const gatewayEui = String(flow.get('gateway_device_eui') || flow.get('al_gateway_device_eui') || '').trim().toUpperCase();
const linked = !!flow.get('account_linked');
if (!linked || !gatewayEui) return null;
msg.historyTable = tableName;
msg.payload = {
  protocolVersion: 1,
  gatewayDeviceEui: gatewayEui,
  batchId: Date.now().toString(36),
  tableName,
  phase: 'shadow',
  hashVersion: 1,
  cursor: {},
  rows: []
};
return msg;
```

This first worker is shadow scaffolding only. It proves link gating, scheduling, and response handling before reading live history rows.

- [ ] **Step 5: Extend flow verifier**

Modify `scripts/verify-sync-flow.js`:

```js
expectIncludes('Build History Batch', "require('/usr/share/node-red/osi-history-sync-helper')", 'loads history sync helper');
expectIncludes('Build History Batch', "phase: 'shadow'", 'runs history sync in shadow mode first');
expectIncludes('Build History Batch', 'hashVersion: 1', 'uses history hash v1');
```

- [ ] **Step 6: Run verifiers**

Run:

```bash
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: All pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-worker.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat(sync): add shadow history batch worker"
```

## Task 7: Raw Insert Shadow Upload and Explicit ACK Parsing

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Modify: `scripts/test-sync-history-worker.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add cursor handoff test**

Extend `scripts/test-sync-history-worker.js`:

```js
assert.strictEqual(helper.isBackfillComplete({ snapshot_high_id: 123, last_acked_id: 123 }), true);
assert.strictEqual(helper.isBackfillComplete({ snapshot_high_id: 124, last_acked_id: 123 }), false);
```

Run:

```bash
node scripts/test-sync-history-worker.js
```

Expected before implementation: FAIL because `isBackfillComplete` is missing.

- [ ] **Step 2: Implement cursor helpers**

Add to helper:

```js
function isBackfillComplete(cursor) {
  return cursor && cursor.snapshot_high_id != null && Number(cursor.last_acked_id || 0) >= Number(cursor.snapshot_high_id);
}

function batchPhase(cursor) {
  return isBackfillComplete(cursor) ? 'tail' : 'backfill';
}

module.exports = { buildCanonicalColumns, hashHistoryRow, historyKey, nextRawQuery, cursorPatchFromResponse, isBackfillComplete, batchPhase };
```

- [ ] **Step 3: Implement live raw batch query in Node-RED, still shadow-only**

Replace the shadow `Build History Batch` placeholder with logic that:

1. Ensures `sync_history_cursors('cloud','device_data')` exists.
2. Sets `snapshot_high_id` once using `SELECT max(id) FROM device_data`.
3. Reads `SELECT * FROM device_data WHERE id > ? ORDER BY id ASC LIMIT ?`.
4. Sends rows to `/api/v1/sync/edge/history/batches`.
5. Includes `payloadHash` from `helper.hashHistoryRow(...)` and the canonical `payload`.
6. Records `last_batch_id`, `last_batch_at`, and `last_error` from the response,
   but does not update `last_acked_id` while the worker is still `phase: 'shadow'`.

Use this SQL shape in the function:

```js
const rows = await q('SELECT * FROM device_data WHERE id > ? ORDER BY id ASC LIMIT ?', [Number(cursor.last_acked_id || 0), batchSize]);
msg.payload.rows = rows.map((row) => {
  const key = helper.historyKey(tableName, gatewayEui, row);
  return {
    historyKey: key,
    naturalKey: `${row.deveui}|${new Date(row.recorded_at).toISOString()}|${row.id}`,
    payloadHash: helper.hashHistoryRow(tableName, key, row),
    payload: row
  };
});
```

The matching `Mark History Batch ACK` node must leave `last_acked_id` unchanged
in this task. Durable ACK cursoring is enabled in Task 9 after the server mapper
recomputes the hash from the payload and writes the real mirror table.

- [ ] **Step 4: Add verifier checks**

Modify `scripts/verify-sync-flow.js`:

```js
expectIncludes('Build History Batch', 'SELECT * FROM device_data WHERE id > ? ORDER BY id ASC LIMIT ?', 'uses id cursor for device_data history');
expectIncludes('Build History Batch', 'helper.hashHistoryRow', 'hashes raw rows through shared helper');
expectIncludes('Mark History Batch ACK', "phase === 'shadow'", 'keeps raw cursor non-durable while shadowing');
expectIncludes('Build History Batch', 'snapshot_high_id', 'captures raw backfill high-water mark');
```

- [ ] **Step 5: Run verifiers**

Run:

```bash
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: All pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-worker.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat(sync): shadow-upload raw history by id cursor"
```

## Task 8: Server Table Mappers and Idempotent Updates

**Files:**
- Modify: `../osi-server/backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryTableMapper.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryColumnEncoder.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/HistoryQuarantineRepository.java`
- Create: `../osi-server/backend/src/main/java/org/osi/server/sync/history/DeviceDataHistoryMapper.java`
- Create: `../osi-server/backend/src/test/java/org/osi/server/sync/history/EdgeHistoryIngestServiceTest.java`
- Create: `../osi-server/backend/src/test/java/org/osi/server/sync/history/DeviceDataHistoryMapperTest.java`

- [ ] **Step 1: Add failing service tests**

Create `EdgeHistoryIngestServiceTest.java`:

```java
package org.osi.server.sync.history;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class EdgeHistoryIngestServiceTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final JsonNode DEVICE_COLUMNS = MAPPER.valueToTree(List.of(
            List.of("id", "INTEGER", "101")
    ));
    private static final String DEVICE_HASH = HistoryHashV1.hash("device_data", "DEVICE_DATA|GW1234|101", DEVICE_COLUMNS);

    private final HistoryRowIndexRepository rowIndexRepository = mock(HistoryRowIndexRepository.class);
    private final HistoryTableMapper mapper = mock(HistoryTableMapper.class);

    @Test
    void duplicateHashReturnsDuplicateAndAdvancesAck() {
        when(mapper.tableName()).thenReturn("device_data");
        when(mapper.canonicalColumns(Map.of("id", 101))).thenReturn(DEVICE_COLUMNS);
        when(rowIndexRepository.find("GW1234", "device_data", "DEVICE_DATA|GW1234|101"))
                .thenReturn(Optional.of(Map.of("payload_hash", DEVICE_HASH)));
        var service = new EdgeHistoryIngestService(rowIndexRepository, List.of(mapper));

        var response = service.applyBatch(batch(DEVICE_HASH));

        assertThat(response.ackedThroughId()).isEqualTo(101L);
        assertThat(response.results()).extracting(HistoryBatchResponse.RowResult::status)
                .containsExactly(HistoryBatchResponse.Status.DUPLICATE);
    }

    @Test
    void differentHashUpdatesIndexAndReturnsUpdated() {
        when(mapper.tableName()).thenReturn("device_data");
        when(mapper.canonicalColumns(Map.of("id", 101))).thenReturn(DEVICE_COLUMNS);
        when(rowIndexRepository.find("GW1234", "device_data", "DEVICE_DATA|GW1234|101"))
                .thenReturn(Optional.of(Map.of("payload_hash", "old-hash")));
        when(mapper.apply("GW1234", batch(DEVICE_HASH).rows().get(0)))
                .thenReturn(new HistoryTableMapper.ApplyResult("sensor_data", "101"));
        var service = new EdgeHistoryIngestService(rowIndexRepository, List.of(mapper));

        var response = service.applyBatch(batch(DEVICE_HASH));

        assertThat(response.results()).extracting(HistoryBatchResponse.RowResult::status)
                .containsExactly(HistoryBatchResponse.Status.UPDATED);
        verify(rowIndexRepository).upsert("GW1234", "device_data", "DEVICE_DATA|GW1234|101",
                "sensor|2026-06-28T10:00:00.000Z|101", 1, DEVICE_HASH, "sensor_data", "101", "EDGE_OVERWROTE_SERVER");
    }

    @Test
    void hashMismatchStopsAckBeforeMapperApply() {
        when(mapper.tableName()).thenReturn("device_data");
        when(mapper.canonicalColumns(Map.of("id", 101))).thenReturn(DEVICE_COLUMNS);
        var service = new EdgeHistoryIngestService(rowIndexRepository, List.of(mapper));

        var response = service.applyBatch(batch("bad-hash"));

        assertThat(response.ackedThroughId()).isNull();
        assertThat(response.results()).extracting(HistoryBatchResponse.RowResult::status)
                .containsExactly(HistoryBatchResponse.Status.REJECTED_PERMANENT);
        assertThat(response.results().get(0).reason()).isEqualTo("hash_mismatch");
    }

    @Test
    void retryableMapperFailureStopsAckBeforeFailedRow() {
        when(mapper.tableName()).thenReturn("device_data");
        when(mapper.canonicalColumns(Map.of("id", 101))).thenReturn(DEVICE_COLUMNS);
        when(rowIndexRepository.find("GW1234", "device_data", "DEVICE_DATA|GW1234|101"))
                .thenReturn(Optional.empty());
        when(mapper.apply("GW1234", batch(DEVICE_HASH).rows().get(0)))
                .thenThrow(new IllegalStateException("database unavailable"));
        var service = new EdgeHistoryIngestService(rowIndexRepository, List.of(mapper));

        var response = service.applyBatch(batch(DEVICE_HASH));

        assertThat(response.ackedThroughId()).isNull();
        assertThat(response.results()).extracting(HistoryBatchResponse.RowResult::status)
                .containsExactly(HistoryBatchResponse.Status.RETRYABLE_ERROR);
    }

    private HistoryBatchRequest batch(String hash) {
        return new HistoryBatchRequest(
                1,
                "GW1234",
                "batch-1",
                "device_data",
                "backfill",
                1,
                new HistoryBatchRequest.Cursor(100L, 101L, null, null),
                List.of(new HistoryBatchRequest.Row(
                        "DEVICE_DATA|GW1234|101",
                        "sensor|2026-06-28T10:00:00.000Z|101",
                        hash,
                        Map.of("id", 101)
                ))
        );
    }
}
```

Expected before Step 3: FAIL because `EdgeHistoryIngestService` does not accept a mapper registry and does not call mappers.

Create `DeviceDataHistoryMapperTest.java` so the real mapper also exercises the
row-to-canonical-column path:

```java
package org.osi.server.sync.history;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.HashMap;

import static org.assertj.core.api.Assertions.assertThat;

class DeviceDataHistoryMapperTest {
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final DeviceDataHistoryMapper mapper = new DeviceDataHistoryMapper(new HistoryColumnEncoder(objectMapper));

    @Test
    void buildsCanonicalColumnsFromPayload() throws Exception {
        var payload = new HashMap<String, Object>();
        payload.put("id", 123);
        payload.put("deveui", "A84041CAFECAFE01");
        payload.put("recorded_at", "2026-06-28T10:00:00Z");
        payload.put("swt_1", 1.0);
        payload.put("swt_2", null);
        payload.put("dendro_valid", 1);

        assertThat(mapper.canonicalColumns(payload)).isEqualTo(objectMapper.readTree("""
                [
                  ["id", "INTEGER", "123"],
                  ["deveui", "TEXT", "A84041CAFECAFE01"],
                  ["recorded_at", "TIMESTAMP", "2026-06-28T10:00:00.000Z"],
                  ["swt_1", "REAL", "3ff0000000000000"],
                  ["swt_2", "REAL", null],
                  ["dendro_valid", "BOOLEAN", true]
                ]
                """));
    }
}
```

- [ ] **Step 2: Introduce mapper interface**

Create `HistoryTableMapper.java`:

```java
package org.osi.server.sync.history;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;

public interface HistoryTableMapper {
    String tableName();
    JsonNode canonicalColumns(Map<String, Object> payload);
    ApplyResult apply(String gatewayEui, HistoryBatchRequest.Row row);

    record ApplyResult(String serverTable, String serverRowId) {}
}
```

Create `HistoryColumnEncoder.java`:

```java
package org.osi.server.sync.history;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.nio.ByteBuffer;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;

@Component
@RequiredArgsConstructor
public class HistoryColumnEncoder {
    private static final DateTimeFormatter UTC_MILLIS = DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC);

    private final ObjectMapper objectMapper;

    public ArrayNode columns(Object... triples) {
        ArrayNode root = objectMapper.createArrayNode();
        for (int i = 0; i < triples.length; i += 3) {
            root.add(column((String) triples[i], (String) triples[i + 1], triples[i + 2]));
        }
        return root;
    }

    public ArrayNode column(String name, String type, Object value) {
        ArrayNode column = objectMapper.createArrayNode();
        column.add(name);
        column.add(type);
        Object encoded = encode(type, value);
        if (encoded == null) {
            column.add(NullNode.getInstance());
        } else if (encoded instanceof Boolean bool) {
            column.add(bool);
        } else {
            column.add(String.valueOf(encoded));
        }
        return column;
    }

    private Object encode(String type, Object value) {
        if (value == null) return null;
        return switch (type) {
            case "TEXT" -> String.valueOf(value);
            case "INTEGER" -> String.valueOf(((Number) value).longValue());
            case "REAL" -> HexFormat.of().formatHex(ByteBuffer.allocate(8).putDouble(((Number) value).doubleValue()).array());
            case "BOOLEAN" -> ((Number) value).intValue() != 0;
            case "TIMESTAMP" -> UTC_MILLIS.format(Instant.parse(String.valueOf(value)));
            case "JSON" -> encodeJson(value);
            default -> throw new IllegalArgumentException("unsupported hash type " + type);
        };
    }

    private String encodeJson(Object value) {
        try {
            return canonicalJson(objectMapper.readTree(String.valueOf(value)));
        } catch (Exception e) {
            throw new IllegalArgumentException("invalid JSON value", e);
        }
    }

    private String canonicalJson(JsonNode node) {
        if (node == null || node.isNull()) return "null";
        if (node.isArray()) {
            ArrayList<String> values = new ArrayList<>();
            node.forEach((child) -> values.add(canonicalJson(child)));
            return "[" + String.join(",", values) + "]";
        }
        if (node.isObject()) {
            ArrayList<String> names = new ArrayList<>();
            node.fieldNames().forEachRemaining(names::add);
            Collections.sort(names);
            ArrayList<String> pairs = new ArrayList<>();
            for (String name : names) {
                pairs.add(jsonString(name) + ":" + canonicalJson(node.get(name)));
            }
            return "{" + String.join(",", pairs) + "}";
        }
        return jsonString(node);
    }

    private String jsonString(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalArgumentException("cannot encode JSON value", e);
        }
    }
}
```

Create `DeviceDataHistoryMapper.java`:

```java
package org.osi.server.sync.history;

import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
@RequiredArgsConstructor
public class DeviceDataHistoryMapper implements HistoryTableMapper {
    private final HistoryColumnEncoder encoder;

    @Override
    public String tableName() {
        return "device_data";
    }

    @Override
    public JsonNode canonicalColumns(Map<String, Object> payload) {
        return encoder.columns(
                "id", "INTEGER", payload.get("id"),
                "deveui", "TEXT", payload.get("deveui"),
                "recorded_at", "TIMESTAMP", payload.get("recorded_at"),
                "swt_1", "REAL", payload.get("swt_1"),
                "swt_2", "REAL", payload.get("swt_2"),
                "dendro_valid", "BOOLEAN", payload.get("dendro_valid")
        );
    }

    @Override
    public ApplyResult apply(String gatewayEui, HistoryBatchRequest.Row row) {
        Object id = row.payload().get("id");
        if (id == null) {
            throw new IllegalArgumentException("device_data.id is required");
        }
        return new ApplyResult("sensor_data", row.historyKey());
    }
}
```

This first mapper validates the contract, recomputes the hash from canonical
columns, and records the index. It must not trust the edge-provided
`payloadHash` without recomputation. In the next slice, it writes the real
mirror table fields.

- [ ] **Step 3: Wire mapper registry**

Create `HistoryQuarantineRepository` with an idempotent `upsert(...)` against
`edge_history_quarantine`, then modify `EdgeHistoryIngestService` to accept
`List<HistoryTableMapper>` and build a `Map<String, HistoryTableMapper>`.

Apply this exception/status taxonomy:

| Condition | Status | ACK behavior | Edge behavior |
|-----------|--------|--------------|---------------|
| Unsupported `hashVersion`, unsupported `tableName`, hash mismatch | `REJECTED_PERMANENT` | Stop before row | Store permanent error and stop immediate retries |
| Mapper validation failure for a single source row | `QUARANTINED` | ACK through row after quarantine row is persisted | Exclude from syncable parity; dirty-key correction can resend |
| Duplicate hash already indexed | `DUPLICATE` | ACK through row | Advance normally |
| Successful insert/update | `APPLIED` / `UPDATED` | ACK through row | Advance normally |
| `TransientDataAccessException`, lock timeout, connection failure, unexpected runtime failure | `RETRYABLE_ERROR` | Stop before row | Retry with backoff |

Inside the row loop, recompute and compare the hash before reading or updating
`edge_history_row_index`:

```java
HistoryTableMapper mapper = mappers.get(request.tableName());
if (mapper == null) {
    return stopBeforeFirstRow(request, "unsupported_table");
}

for (HistoryBatchRequest.Row row : request.rows()) {
    JsonNode canonicalColumns;
    try {
        canonicalColumns = mapper.canonicalColumns(row.payload());
    } catch (IllegalArgumentException validationFailure) {
        quarantineRepository.upsert(gatewayEui, request.tableName(), row.historyKey(), request.hashVersion(), row.payloadHash(), validationFailure.getMessage());
        results.add(new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.QUARANTINED, validationFailure.getMessage()));
        // Safe to include in the ACK prefix only if this transaction commits.
        ackedThroughId = maxCursorId(ackedThroughId, row.historyKey());
        ackedThroughKey = row.historyKey();
        continue;
    }

    String computedHash = HistoryHashV1.hash(request.tableName(), row.historyKey(), canonicalColumns);
    if (!computedHash.equals(row.payloadHash())) {
        results.add(new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.REJECTED_PERMANENT, "hash_mismatch"));
        break;
    }

    try {
        var existing = rowIndexRepository.find(gatewayEui, request.tableName(), row.historyKey());
        if (existing.isPresent() && Objects.equals(existing.get().get("payload_hash"), row.payloadHash())) {
            results.add(new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.DUPLICATE, null));
        } else {
            var applied = mapper.apply(gatewayEui, row);
            rowIndexRepository.upsert(gatewayEui, request.tableName(), row.historyKey(), row.naturalKey(), request.hashVersion(), row.payloadHash(), applied.serverTable(), applied.serverRowId(), existing.isPresent() ? "EDGE_OVERWROTE_SERVER" : null);
            results.add(new HistoryBatchResponse.RowResult(row.historyKey(), existing.isPresent() ? HistoryBatchResponse.Status.UPDATED : HistoryBatchResponse.Status.APPLIED, null));
        }
        ackedThroughId = maxCursorId(ackedThroughId, row.historyKey());
        ackedThroughKey = row.historyKey();
    } catch (org.springframework.dao.TransientDataAccessException retryable) {
        results.add(new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.RETRYABLE_ERROR, retryable.getClass().getSimpleName()));
        break;
    } catch (RuntimeException unexpected) {
        results.add(new HistoryBatchResponse.RowResult(row.historyKey(), HistoryBatchResponse.Status.RETRYABLE_ERROR, unexpected.getClass().getSimpleName()));
        break;
    }
}
```

Do not return an ACK boundary from a transaction that has rolled back. In this
implementation, retryable failures are represented as row results only when the
method can return normally and commit prior row-index/quarantine writes. If a
later failure marks the transaction rollback-only or propagates, no response
body should be used by the edge to advance its cursor.

The server must return `REJECTED_PERMANENT` for `unsupported_hash_version`; the
edge helper in Task 6 turns that into a non-immediate retry so an unsupported
software pair does not spin every scheduler tick.

- [ ] **Step 4: Run server tests**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests 'org.osi.server.sync.history.EdgeHistoryIngestServiceTest' --tests 'org.osi.server.sync.EdgeSyncControllerTest'
```

Expected: Tests pass.

Do not enable durable edge cursor ACKs until these mapper/hash-recompute tests
pass and the server endpoint deployed to the target environment is confirmed to
run this mapper code, not only the Task 2 endpoint skeleton.

- [ ] **Step 5: Commit**

Run:

```bash
cd /home/phil/Repos/osi-server
git add backend/src/main/java/org/osi/server/sync/history backend/src/test/java/org/osi/server/sync/history
git diff --cached --check
git commit -m "feat(sync): add history table mapper registry"
```

## Task 9: Enable Durable Raw ACKs, Parity Manifests, and Safe Trigger Removal Gates

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `../osi-server/backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`

- [ ] **Step 1: Add durable ACK gate test**

Extend `scripts/test-sync-history-worker.js`:

```js
assert.strictEqual(helper.shouldApplyDurableAck({ phase: 'shadow' }, { history_mirror_write_v1_confirmed: true }), false);
assert.strictEqual(helper.shouldApplyDurableAck({ phase: 'backfill' }, { history_mirror_write_v1_confirmed: false }), false);
assert.strictEqual(helper.shouldApplyDurableAck({ phase: 'backfill' }, { history_mirror_write_v1_confirmed: true }), true);
```

Run:

```bash
node scripts/test-sync-history-worker.js
```

Expected before implementation: FAIL because `shouldApplyDurableAck` is missing.

- [ ] **Step 2: Implement durable ACK gate**

Add:

```js
function shouldApplyDurableAck(batch, capabilities) {
  return batch &&
    batch.phase !== 'shadow' &&
    capabilities &&
    capabilities.history_mirror_write_v1_confirmed === true;
}

module.exports.shouldApplyDurableAck = shouldApplyDurableAck;
```

Use this helper in `Mark History Batch ACK`:

```js
const durableHistoryAck = helper.shouldApplyDurableAck(
  { phase: msg.payload?.phase || msg.historyPhase },
  { history_mirror_write_v1_confirmed: !!flow.get('history_mirror_write_v1_confirmed') }
);
if (!durableHistoryAck) {
  // Shadow responses update observability fields only; they never advance last_acked_id.
  await run("UPDATE sync_history_cursors SET last_batch_id=?, last_batch_at=?, last_error=NULL WHERE peer_node='cloud' AND table_name=?", [msg.payload.batchId, new Date().toISOString(), msg.historyTable]);
  return msg;
}
```

Only the durable branch may apply `ackedThroughId` / `ackedThroughKey` to
`last_acked_id` / `last_acked_key`.

- [ ] **Step 3: Add segment helper test**

Extend `scripts/test-sync-history-worker.js`:

```js
const segment = helper.segmentKey('device_data', { deveui: 'A84041CAFECAFE01', recorded_at: '2026-06-28T10:00:00.000Z' });
assert.strictEqual(segment, 'A84041CAFECAFE01|2026-06-28');
```

Run:

```bash
node scripts/test-sync-history-worker.js
```

Expected before implementation: FAIL because `segmentKey` is missing.

- [ ] **Step 4: Implement segment helper**

Add:

```js
function segmentKey(tableName, row) {
  if (tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings') {
    return `${row.deveui}|${String(row.recorded_at).slice(0, 10)}`;
  }
  if (tableName === 'zone_daily_environment' || tableName === 'zone_daily_recommendations') {
    return `${row.zone_uuid}|${row.date}`;
  }
  if (tableName === 'dendrometer_daily') {
    return `${row.deveui}|${row.date}`;
  }
  throw new Error(`unsupported segment table ${tableName}`);
}

module.exports.segmentKey = segmentKey;
```

- [ ] **Step 5: Add manifest worker in Node-RED**

Add function node `Build History Manifest` that reads cached segments and sends:

```js
const rows = await q([
  'SELECT table_name, segment_key, hash_version, canonical_row_count,',
  '       syncable_row_count, quarantined_count, syncable_payload_hash',
  'FROM sync_history_segments',
  "WHERE peer_node = 'cloud'",
  'ORDER BY table_name, segment_key',
  'LIMIT 500'
].join('\n'));
msg.payload = {
  gatewayDeviceEui: gatewayEui,
  generatedAt: new Date().toISOString(),
  segments: rows.map((row) => ({
    tableName: row.table_name,
    segmentKey: row.segment_key,
    hashVersion: Number(row.hash_version),
    canonicalRowCount: Number(row.canonical_row_count),
    syncableRowCount: Number(row.syncable_row_count),
    quarantinedCount: Number(row.quarantined_count),
    syncablePayloadHash: row.syncable_payload_hash
  }))
};
return msg;
```

- [ ] **Step 6: Add trigger-removal verifier gate**

Modify `scripts/verify-sync-flow.js` with a gate that fails if raw outbox triggers are removed before the history worker checks exist:

```js
expectIncludes('Build History Batch', 'ackedThroughId', 'history batch worker handles explicit ACK before raw trigger removal');
expectIncludes('Mark History Batch ACK', 'history_mirror_write_v1_confirmed', 'durable ACK requires confirmed server mirror writes');
expectFileIncludes('seed-blank.sql', seedSql, 'trg_sync_device_data_dirty_au', 'raw correction dirty-key trigger exists before raw trigger removal');
```

- [ ] **Step 7: Run verifiers**

Run:

```bash
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: All pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-worker.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat(sync): gate durable history ACKs and manifests"
```

## Task 10: Controlled Raw Trigger Removal

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-sync-history-schema.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add removal expectation test**

Update `scripts/test-sync-history-schema.js` so a never-linked raw insert still leaves `sync_outbox` at zero and linked raw insert also leaves `sync_outbox` at zero:

```js
await exec("DELETE FROM sync_outbox");
await exec("INSERT INTO device_data(id, deveui, recorded_at) VALUES(202, 'A84041CAFECAFE01', '2026-06-28T11:00:00.000Z')");
outbox = await all("SELECT COUNT(*) AS count FROM sync_outbox WHERE aggregate_type='DEVICE_DATA'");
if (Number(outbox[0].count) !== 0) throw new Error('raw device_data insert still creates outbox row');
```

Run:

```bash
node scripts/test-sync-history-schema.js
```

Expected before trigger removal: FAIL if raw insert triggers still exist.

- [ ] **Step 2: Remove raw insert outbox triggers**

Drop these from `database/seed-blank.sql` and the `Sync Init Schema + Triggers` SQL:

- `trg_dp_device_data_outbox_ai`
- `trg_dp_chameleon_readings_outbox_ai`
- `trg_dp_dendro_readings_outbox_ai`

Keep raw update dirty-key triggers from Task 5.

- [ ] **Step 3: Verify no raw trigger references remain**

Add to `scripts/verify-sync-flow.js`:

```js
expectFileExcludes('seed-blank.sql', seedSql, 'trg_dp_device_data_outbox_ai', 'removed device_data raw outbox trigger');
expectFileExcludes('seed-blank.sql', seedSql, 'trg_dp_dendro_readings_outbox_ai', 'removed dendrometer raw outbox trigger');
expectExcludesForEach([findNodeByName('Sync Init Schema + Triggers')], 'trg_dp_device_data_outbox_ai', 'runtime raw outbox trigger creation');
```

- [ ] **Step 4: Run full edge verification**

Run:

```bash
node scripts/test-sync-history-schema.js
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
git diff --check
```

Expected: All pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add database/seed-blank.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-schema.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat(sync): remove raw history outbox triggers"
```

## Task 11: Derived Tables, Irrigation Event UUID, and Bootstrap Narrowing

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-sync-history-schema.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add irrigation UUID regression test**

Extend `scripts/test-sync-history-schema.js`:

```js
await exec("INSERT INTO irrigation_events(id, irrigation_zone_id, action, payload_json, event_uuid) VALUES(1, 1, 'OPEN', '{}', 'irrig-0016C001F11715E2-000000000001')");
const irrig = await all("SELECT event_uuid FROM irrigation_events WHERE id=1");
if (irrig[0].event_uuid !== 'irrig-0016C001F11715E2-000000000001') throw new Error('irrigation event uuid mismatch');
await exec("INSERT INTO irrigation_events(id, irrigation_zone_id, action, payload_json) VALUES(2, 1, 'CLOSE', '{}')");
const backfilled = await all("SELECT event_uuid FROM irrigation_events WHERE id=2");
if (backfilled[0].event_uuid !== 'irrig-0016C001F11715E2-000000000000002') throw new Error('irrigation event uuid trigger mismatch');
```

- [ ] **Step 2: Backfill existing irrigation event UUIDs**

Add an idempotent runtime migration in the Node-RED startup migration path before
any irrigation history sync reads:

```js
const gatewayEui = String(flow.get('al_gateway_device_eui') || flow.get('gateway_device_eui') || process.env.DEVICE_EUI || '').trim().toUpperCase();
if (!/^[0-9A-F]{16}$/.test(gatewayEui)) {
  throw new Error('Cannot backfill irrigation event UUIDs without canonical gateway EUI');
}
await run([
  "UPDATE irrigation_events",
  "SET event_uuid = 'irrig-' || ? || '-' || printf('%015d', id)",
  "WHERE event_uuid IS NULL OR event_uuid = ''"
].join(' '), [gatewayEui]);
```

Do not move `irrigation_events` to history sync if this migration cannot prove
the gateway EUI. Leaving those rows on the legacy event path is safer than
inventing unstable identities.

- [ ] **Step 3: Remove derived outbox triggers after parity proof**

Only after parity manifests are clean for derived tables, remove:

- `trg_dp_dendro_daily_outbox_ai`
- `trg_dp_dendro_daily_outbox_au`
- `trg_dp_zone_env_outbox_ai`
- `trg_dp_zone_env_outbox_au`
- `trg_dp_zone_recs_outbox_ai`
- `trg_dp_zone_recs_outbox_au`

Keep dirty-key triggers from Task 5.

- [ ] **Step 4: Keep irrigation events on event path until UUID backfill is verified**

Add verifier assertion:

```js
expectFileIncludes('seed-blank.sql', seedSql, 'idx_irrigation_events_event_uuid', 'irrigation events have stable sync identity');
```

Move `irrigation_events` to history sync only after `event_uuid` is present in all seed DBs and the server mapper exists.

- [ ] **Step 5: Narrow bootstrap history arrays after history sync capability is live**

In `Build Cloud Bootstrap`, keep structural arrays and remove raw/derived history arrays only when the local capability check confirms `history_sync_v1`. The transition condition in the function should read:

```js
const historySyncActive = syncCapabilities.includes('history_sync_v1') && !!flow.get('history_sync_v1_confirmed');
```

When `historySyncActive` is true, set:

```js
sensorData: [],
dendroReadings: [],
chameleonReadings: [],
dendroDaily: [],
zoneRecommendations: [],
zoneEnvironments: []
```

- [ ] **Step 6: Run verification**

Run:

```bash
node scripts/test-sync-history-schema.js
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: All pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add database/seed-blank.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sync-history-schema.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat(sync): move derived history to history sync"
```

## Task 12: End-to-End Verification and Rollout Notes

**Files:**
- Modify: `docs/operations/edge-history-retention.md`
- Modify: `docs/superpowers/specs/2026-06-28-sync-architecture-redesign.md` only if implementation changes the protocol contract.

- [ ] **Step 1: Run OSI OS verification bundle**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-history-hash-fixtures.js
node scripts/test-sync-history-schema.js
node scripts/test-sync-history-worker.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
git diff --check
```

Expected: All pass.

- [ ] **Step 2: Run OSI Server verification bundle**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests 'org.osi.server.sync.*' --tests 'org.osi.server.sync.history.*'
```

Expected: All pass.

- [ ] **Step 3: Document rollout constraints**

`docs/operations/edge-history-retention.md` already exists. Add this checklist
as a new section:

```markdown
## History Sync V1 Rollout Guardrails

- Do not remove raw history outbox triggers on a field gateway until shadow history sync has completed a full raw-table backfill.
- Do not import recovered outbox history into `/data/db/farming.db` without a timestamped backup of `/data/db/`, `/srv/node-red/`, and `/usr/lib/node-red/gui/`.
- Do not prune server-extra edge-sourced rows without two manifest confirmations or explicit operator approval.
- Keep legacy `/edge/events` and `/edge/bootstrap` compatibility until every supported OSI OS image advertises `history_sync_v1`.
```

- [ ] **Step 4: Commit documentation**

Run:

```bash
cd /home/phil/Repos/osi-os
git add docs/operations/edge-history-retention.md docs/superpowers/specs/2026-06-28-sync-architecture-redesign.md
git diff --cached --check
git commit -m "docs(sync): document history sync rollout guardrails"
```

## Self-Review Checklist

- Spec coverage:
  - Link state and never-linked behavior: Tasks 3 and 4.
  - Hash version and fixtures: Task 1.
  - Server history index and batch endpoint: Tasks 2 and 8.
  - Raw id cursor and explicit ACK: Tasks 6 and 7.
  - Raw correction dirty keys: Task 5.
  - Derived dirty keys and zone UUID joins: Tasks 5 and 11.
  - Quarantine-aware manifests: Tasks 2 and 9.
  - Safe migration and rollout guardrails: Task 12.
- File-boundary check:
  - Server protocol code stays in `org.osi.server.sync.history` and controller wiring stays in `EdgeSyncController`.
  - Edge protocol helpers stay in `osi-history-sync-helper`; `flows.json` orchestrates but does not own hash/cursor helper logic.
  - Verifiers pin behavior before trigger removal.
- Execution order:
  - Hash fixtures precede repair.
  - Dirty keys and shadow sync precede raw trigger removal.
  - Derived parity precedes derived trigger removal.
  - Bootstrap narrowing is last.
