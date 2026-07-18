# LSN50 writer runtime recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manifest-driven device writer compatible with the shipped asynchronous SQLite facade, stop production-shaped LSN50 messages from generating false quarantine rows, surface ingest failures through the edge error counter, retain a working fallback until live evidence clears the cutover, and make the deploy pipeline fail when ChirpStack receives an uplink that the edge database does not store.

**Architecture:** `osi-device-writer` will consume only the public `osi-db-helper` contract: Promise-returning `all(sql, params)` and `run(sql, params)`. The normalizer will distinguish inactive, undefined fields from populated unknown fields using the union of the two shipped LSN50 source maps. The LSN50 flow will await the writer, report failures through its Catch path, and route fallback through a sequential `ingest_quarantine` marker before the retained SQL insert. Deployment verification starts after the new payload passes its health probe, correlates ChirpStack `device.last_seen_at` with `device_data.recorded_at`, and rejects fallback or false-dead-letter evidence from that window.

**Tech Stack:** Node.js 22 tests, Node-RED function nodes, `osi-db-helper`, SQLite, OpenWrt UCI/procd, Python 3 pipeline checks, pytest.

## Global constraints

- Work from current `main`; confirm `HEAD == origin/main` before implementation.
- Base implementation on `origin/main` containing merged [OSI OS PR #146](https://github.com/Open-Smart-Irrigation/osi-os/pull/146), merge commit `f50950b1767a1aa6302ef2553d68a4e379b5b142` or a verified descendant. Preserve `node-red.init`'s `gateway_identity_heal`, the identity restart sentinel in the touched flow, identityd quiescence before migration, Node-RED-before-identityd EXIT restoration, final identityd enable/start/readiness, and the merged identity lifecycle/deploy/flow-size tests. The writer flag integration extends this lifecycle; it never creates a competing restart owner.
- Under `2026-07-15-refactor-repair-program.md`, use this plan's Kaba100 steps as checks inside the single Train A deployment, not as a separate deploy or restart.
- In that program mode, export `OSI_REPAIR_PROGRAM_MODE=1` and do not stage OSI OS `AGENTS.md` in a source-slice commit. Record the reviewed invariant fragment in the execution report; the program orchestrator owns the single integrated A1 documentation checkpoint.
- Do not overwrite `/data/db/farming.db`. Back up Kaba100 before every payload change.
- Treat `bcm2712` as canonical and make every changed runtime payload byte-identical in `bcm2709`.
- Edit each `flows.json` through a parse-mutate-serialize script with byte-identical round-trip guards.
- Restore the old LSN50 SQL nodes in Task 3; commit `e5852033` deleted them, so at the pinned base there is nothing to keep. Retain the restored nodes and the UCI kill switch through Task 7 and the later 14-day-or-500-uplink cleanup threshold.
- The `scripts/verify-flows-size-ratchet-allowances.json` edits in this plan target the absolute `max_chars`/`max_total` schema created by repair-program Task A0. At the pinned base the file still holds base-relative deltas, so standalone execution outside the program must land A0's ratchet-format migration first (or an equivalent reviewed migration) before changing any ceiling.
- Limit the normalization change to inactive-mode placeholders: a key known to either shipped LSN50 mode is ignored only when it is outside the selected mode and its value is `null` or `undefined`. Do not change channel names, units, dendrometer conversion, or daily analytics.
- Do not add schema DDL to `sync-init-fn` or the Daily Dendrometer Analytics function node.
- Do not access `osicloud.ch` during implementation or verification.
- Preserve unrelated worktree files, including the existing untracked 2026-07-14 and 2026-07-15 plan/spec documents.
- Keep the Device API repair in separate commits and tests. If both plans are locally green before live rollout, deploy one combined payload and run both plans' Kaba100 evidence gates against that exact commit.
- Complete this plan before `2026-07-15-refactor-boundary-hardening.md`. That companion plan consumes this plan's ISO verification boundary and then hardens the wider deploy, rollback, target-routing, and profile-export contracts.

---

## Confirmed incident facts

The production writer contract is asynchronous. `osi-db-helper` exposes `all`, `get`, `run`, `transaction`, and `readSnapshot`; it does not expose `prepare`. Current `osi-device-writer/index.js` calls `db.prepare(...)` four times, and both flow consumers call `writeDeviceData(...)` without `await`.

The test doubles hid the mismatch. `osi-device-writer/index.test.js` and `scripts/verify-device-integration.js` pass a synchronous `node:sqlite` `DatabaseSync`, which does expose `prepare`. `verify-sync-flow.js` treats failure to load the shipped helper because local `sqlite3` is missing as a successful source-only fallback.

The real LSN50 flow object always contains both default-mode and MOD9 properties. Inactive properties are `undefined`, but `osi-lsn50-normalize` compares them only with the selected mode map and reports the other mode's known keys as unknown. A production-shaped default message creates 15 false `ingest_quarantine` rows; MOD9 creates 14. At the 1,000-row cap, routine uplinks can evict the `writer_fallback` records needed to prove which persistence path ran.

The writer's documented hard schema error is not hard. A missing manifest column is quarantined, the remaining columns are inserted, and the result reports `inserted: true`. Its module-global column cache also retains the first observed schema until restart. This plan makes `column_missing` abort the `device_data` row and invalidate the cache so an in-place schema repair can be observed on the next call.

Writer failures are not reliably counted. The LSN50 node calls `node.error` without the triggering message, and the UC512 tab has no Catch path to `Record Error`. Module-load failures only warn. The repaired flow passes `msg` to `node.error`, adds the UC512 Catch link, and proves `global.error_counts` changes in an executable flow test.

The documented integration gate was not a CI gate. Item 3.2 in `docs/architecture/refactor-program-2026.md` says the writer and normalizer round trip runs in CI, but no workflow invokes `verify-device-integration.js`, the writer suite, or either normalizer suite. The history-router extraction has explicit workflow steps for its module and golden-vector tests; the narrow-waist path needs the same executable wiring.

The LSN50 shadow measured normalizer parity, not writer execution. The design at `docs/superpowers/specs/2026-07-12-narrow-waist-uc512-design.md` explicitly compares normalizer output while the old SQL path writes. During commit `cf68c5e8`, every primary writer call could fail and the second output still inserted through `lsn50-sql-fn` and `lsn50-sqlite`. Fresh rows and zero dead letters therefore did not prove the new writer.

Commit `e5852033` removed the fallback 13 minutes 35 seconds after cutover. The current one-output LSN50 node catches the runtime error and returns `null`, which drops the message before `device_data`, `dendrometer_readings`, aggregation, API, and GUI consumers.

The pipeline had two independent false-pass paths. `controller.py` passes a compact stamp such as `20260715T083000Z` to SQL that compares it lexically with ISO timestamps such as `2026-07-15T08:30:00Z`. `checks/ingest.py` then returns `passed=True` after 120 seconds with no rows. Kaba100 dendrometers normally report about every 20 minutes.

## File map

| File | Responsibility after this plan |
|---|---|
| `scripts/lib/database-sync-async-facade.js` | Async-only test adapter over `node:sqlite` without a `prepare` method. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.js` | Promise-returning manifest writer using `db.all` and `db.run`. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js` | Writer behavior tests against the async-only adapter. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.test.js` | Byte-identical test mirror required by profile parity. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.js` | Ignores only known inactive-mode nullish placeholders and retains populated unknown fields. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js` | Production-shaped default/MOD9 fixtures and populated-unknown controls. |
| `scripts/verify-device-integration.js` | Codec to normalizer to asynchronous writer to database integration gate. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Awaited UC512/LSN50 consumers and retained LSN50 fallback wiring. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` | Default `osi-server.cloud.lsn50_writer_disable=0` on new images. |
| `scripts/test-osi-server-uci-defaults.sh` | Proves the kill-switch default is absent-only, preserves an operator override, and is idempotent. |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` | UCI-to-procd export as `LSN50_WRITER_DISABLE`. |
| `scripts/verify-sync-flow.js` | Actual helper-to-writer contract test plus executable flow and structural pins. |
| `scripts/test-error-recording-flow.js` | LSN50 and UC512 failures reach `Record Error` with their triggering message. |
| `.github/workflows/verify-sync-flow.yml` | Runs the writer, both normalizers, and the round-trip gate in CI instead of relying on documentation. |
| `scripts/test-ci-guard-wiring.js` | Pins all four direct writer commands in the required workflow with remove-one controls. |
| `scripts/pipeline/checks/__init__.py` | Verification context fields for ingest policy. |
| `scripts/pipeline/checks/ingest.py` | ChirpStack-to-edge correlation gate. |
| `scripts/pipeline/config.py` and `scripts/pipeline/bundles.json` | Per-gateway ingest requirement and observation window. |
| `scripts/pipeline/controller.py` and `scripts/pipeline/deploy.py` | Separate backup stamp and post-health verification boundary. |
| `scripts/pipeline/checks/canary.py` and `scripts/pipeline/checks/daily.py` | Use the renamed post-health verification boundary. |
| `scripts/pipeline/tests/test_checks.py` and `scripts/pipeline/tests/test_controller.py` | Regression tests for the hard ingest gate and timestamp formats. |
| `docs/architecture/refactor-program-2026.md` | Corrected 3.3/4.1 status and recovery exit gate. |
| `docs/operations/kaba100-lsn50-writer-outage-2026-07-15.md` | Incident evidence, repair state, and lost-data boundary. |
| `AGENTS.md` | Runtime database-contract invariant for future extractions. |
| `.claude/skills/osi-config-and-flags/SKILL.md` | Durable catalog entry for the new LSN50 fallback flag. |

### Task 1: Pin the asynchronous database contract

**Files:**

- Create: `scripts/lib/database-sync-async-facade.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lsn50-normalize/index.test.js`
- Modify: `scripts/verify-device-integration.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/test-error-recording-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `deploy.sh`
- Modify/Test: `scripts/test-deploy-sh.sh`
- Modify/Test: `scripts/test-deploy-atomic-payload-wiring.js`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `scripts/test-ci-guard-wiring.js`

**Interfaces:**

- Produces: `createAsyncDatabaseFacade(databaseSync) -> { all(sql, params): Promise<object[]>, get(sql, params): Promise<object|undefined>, run(sql, params): Promise<void>, close(): void }`.
- Produces: tests that pass an object with no `prepare` member to `writeDeviceData`.
- Produces: production-shaped LSN50 fixtures with both mode key sets present.
- Produces: negative tests for partial-row insertion, stale column cache, and missing error-accounting wiring.

- [ ] **Step 1: Add the async-only test adapter**

Create `scripts/lib/database-sync-async-facade.js` with this implementation:

```js
'use strict';

function values(params) {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}

function createAsyncDatabaseFacade(databaseSync) {
  return Object.freeze({
    async all(sql, params) {
      return databaseSync.prepare(sql).all(...values(params));
    },
    async get(sql, params) {
      return databaseSync.prepare(sql).get(...values(params));
    },
    async run(sql, params) {
      databaseSync.prepare(sql).run(...values(params));
    },
    close() {},
  });
}

module.exports = { createAsyncDatabaseFacade };
```

- [ ] **Step 2: Convert one writer test to the async contract and prove the current code fails**

Keep `DatabaseSync` for fixture setup and assertion queries. Pass `createAsyncDatabaseFacade(syncDb)` to the writer, mark the test `async`, and await the call:

```js
const repoRoot = path.resolve(__dirname, '../../../../../../..');
const { createAsyncDatabaseFacade } = require(
  path.join(repoRoot, 'scripts/lib/database-sync-async-facade.js')
);

it('inserts known channels through the shipped async database contract', async () => {
  const facade = createAsyncDatabaseFacade(db);
  assert.equal(facade.prepare, undefined);
  const result = await writeDeviceData(
    facade,
    minimalManifest(),
    { channels: { swt_1: 42.5, ambient_temperature: 23.1 }, unknown: {} },
    { deveui: TEST_DEVEUI },
    { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
  );
  assert.equal(result.inserted, true);
});
```

- [ ] **Step 3: Run the focused test and capture the red signal**

Run:

```bash
node --test --test-name-pattern='shipped async database contract' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
```

Expected: FAIL with `TypeError: db.prepare is not a function`.

- [ ] **Step 4: Convert every writer and round-trip call to await the async facade**

Use a separate `syncDb` for seed setup/assertions and a `writerDb` for the call:

```js
const syncDb = createTestDb();
const writerDb = createAsyncDatabaseFacade(syncDb);
assert.equal(writerDb.prepare, undefined);
const result = await writer.writeDeviceData(
  writerDb,
  manifest,
  normalizeResult,
  { deveui: TEST_DEVEUI },
  {}
);
```

Mark each enclosing `it(...)` callback `async`. Close only `syncDb` in `finally` or `afterEach`. Mirror the modified test file into bcm2709 before running profile parity.

- [ ] **Step 5: Add production-shaped normalizer and integration failures**

Build fixtures from the actual object shape assembled by node `460e0bfd95f89e67`. Every fixture must define both mode key sets. The inactive set uses `undefined`.

```js
test('default mode ignores known undefined MOD9 placeholders', () => {
  const result = normalize(productionDecoded({ detectedMode: 1 }));
  assert.deepEqual(result.unknown, {});
});

test('MOD9 ignores known undefined default placeholders', () => {
  const result = normalize(productionDecoded({ detectedMode: 9 }));
  assert.deepEqual(result.unknown, {});
});

test('default mode preserves a populated MOD9-only key as unknown', () => {
  const result = normalize(productionDecoded({ detectedMode: 1, rainCountCumulative: 7 }));
  assert.deepEqual(result.unknown, { rainCountCumulative: 7 });
});

test('MOD9 preserves a populated default-only key as unknown', () => {
  const result = normalize(productionDecoded({ detectedMode: 9, adcV: 1.25 }));
  assert.deepEqual(result.unknown, { adcV: 1.25 });
});

test('a populated field outside both shipped maps remains unknown', () => {
  const result = normalize({ ...productionDecoded({ detectedMode: 1 }), futureProbe: 7 });
  assert.deepEqual(result.unknown, { futureProbe: 7 });
});
```

Pass both undefined-placeholder production fixtures through `scripts/verify-device-integration.js` and assert `deadLettered.length === 0` and `SELECT COUNT(*) FROM ingest_quarantine` remains zero. Pass each populated inactive-mode fixture separately and require exactly its named field to produce one `unknown_channel` row; this proves inactive known keys are ignored only when absent/undefined, not silently discarded when unexpectedly populated. The populated `futureProbe` control must also produce one `unknown_channel` row.

Do not stop at calling the normalizer and writer modules directly. Extend the shared flow-function harness to execute the actual shipped node `460e0bfd95f89e67` with its real assembly code, real shipped normalizer, real writer, real manifest fixture, and async-only database facade. Run default and MOD9 payloads with every inactive placeholder first `undefined` and then `null`; require the node to await the writer, emit only its primary success output, insert the expected canonical row, and leave `ingest_quarantine` empty. Run the populated inactive-mode and `futureProbe` controls through that same node and require the exact quarantine facts. Add a mutation control that bypasses the node's assembly object and calls the module fixture directly; the integration gate must detect that the shipped node was not executed.

- [ ] **Step 6: Pin fail-closed schema behavior and cache refresh**

Add one manifest entry whose `edgeField` is absent from the first `PRAGMA table_info(device_data)` result. Assert that `writeDeviceData` rejects with code `DEVICE_DATA_SCHEMA_MISMATCH`, no `device_data` row is inserted, and one `column_missing` quarantine row remains. Extend the fake facade so the next schema read includes the repaired column, call the writer again without restarting the module, and require the second call to insert successfully.

```js
await assert.rejects(
  writer.writeDeviceData(facade, driftedManifest, normalized, meta, { node: mockNode() }),
  (error) => error.code === 'DEVICE_DATA_SCHEMA_MISMATCH'
);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 0);
assert.equal(schemaReadCount, 1);

schemaHasRepairedColumn = true;
const retried = await writer.writeDeviceData(facade, driftedManifest, normalized, meta, { node: mockNode() });
assert.equal(retried.inserted, true);
assert.equal(schemaReadCount, 2);
```

- [ ] **Step 7: Add red observability guards**

Extend `scripts/test-error-recording-flow.js` so `record-error-catch-lsn50` and a new `record-error-catch-uc512` are both wired to the existing `Record Error` link target. In `scripts/verify-sync-flow.js`, execute the two writer nodes with a rejected writer Promise and require `node.error(error, msg)` to receive the exact input object. Also require red node status and no success output. Run both tests before changing the flows; they must fail on the current message-less error calls and absent UC512 Catch node.

For UC512 node `6b28e0d879808dd9`, add table-driven executable failures for normalizer load, writer load, missing/invalid manifest, empty identity, normalizer throw, database constructor/open failure, rejected writer, and database close failure. Every operational failure uses a fixed allowlisted stage/code, calls `node.error(<bounded-error>, msg)`, sets red status, emits no success, and reaches `record-error-catch-uc512`; raw exception messages, paths, payloads, SQL, and secret sentinels are absent. Profile mismatch and absent non-UC512 payload remain intentional no-op cases and must not increment an error. Remove one stage from the table and bypass the Catch wire as negative controls.

- [ ] **Step 8: Exercise the writer through the actual shipped helper facade**

Extend the existing `loadCommonJsFromSource` and `createFakeSqlite3ForTransactionVerification` harness in `scripts/verify-sync-flow.js`; do not create a second CommonJS loader or fake SQLite implementation. Add the narrow SQL cases needed for `PRAGMA table_info(device_data)`, the `device_data` insert, and `ingest_quarantine` insert/eviction. Then add `verifyDeviceWriterDbContract(...)` that:

1. loads the shipped `osi-db-helper/index.js` with that fake `sqlite3` module;
2. loads the shipped `osi-device-writer/index.js`;
3. constructs `new helper.Database(...)` and asserts `database.prepare === undefined`;
4. awaits `writeDeviceData(...)` with a minimal manifest; and
5. asserts the fake database recorded the expected `device_data` row.

Queue this Promise in the existing `pendingChecks` array next to `verifyDbHelperTransactionBehavior`. The test must run even when native `sqlite3` is absent locally; the source-only success branch is not sufficient evidence for this contract.

- [ ] **Step 9: Wire every narrow-waist suite into CI**

Add one workflow step immediately after `node scripts/verify-sync-flow.js` in `.github/workflows/verify-sync-flow.yml`:

```yaml
- name: Verify narrow-waist device runtime contracts
  run: |
    node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
    node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js
    node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.test.js
    node scripts/verify-device-integration.js
```

Do not hide these calls behind the source-only helper branch in `verify-sync-flow.js`. The workflow must name all four commands so a missing, renamed, or non-executable suite fails visibly.
Extend `scripts/test-ci-guard-wiring.js` in the same slice with these exact four commands and one remove-one negative per command, then run the guard. A green aggregate verifier does not satisfy this ownership check.

- [ ] **Step 10: Preserve red evidence without creating a broken commit**

Record the focused failures in the execution report or review notes. Keep the test, facade, verifier, and workflow edits uncommitted until Task 3 makes the writer, normalizer, and flow-observability paths green. Do not push a deliberately red CI commit.

### Task 2: Make `osi-device-writer` asynchronous

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lsn50-normalize/index.js`
- Test: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js`
- Test: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js`
- Test: `scripts/verify-device-integration.js`

**Interfaces:**

- Consumes: the async-only facade from Task 1.
- Produces: `async writeDeviceData(db, manifest, normalizeResult, meta, options) -> Promise<WriteResult>`.
- Produces: `WriteResult = { inserted: boolean, deadLettered: Array<{channel: string, reason: string}>, columns: string[], shadowRow?: object }`.
- Produces: a `DEVICE_DATA_SCHEMA_MISMATCH` rejection before the final insert whenever any selected `edgeField` is absent.
- Produces: normalizer behavior that ignores only nullish, known inactive-mode placeholders.

- [ ] **Step 1: Convert the writer's database helpers to Promise-returning functions**

Replace the synchronous helper bodies with:

```js
async function getDeviceDataColumns(db) {
  if (columnCache) return columnCache;
  const rows = await db.all('PRAGMA table_info(device_data)');
  columnCache = new Set(rows.map((row) => row.name));
  return columnCache;
}

async function evictQuarantine(db) {
  await db.run(
    'DELETE FROM ingest_quarantine WHERE id NOT IN ' +
      '(SELECT id FROM ingest_quarantine ORDER BY id DESC LIMIT ?)',
    [QUARANTINE_CAP]
  );
}

async function deadLetter(db, deveui, channel, reason, rawValue) {
  await db.run(
    'INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value) VALUES (?, ?, ?, ?)',
    [deveui, channel, reason, rawValue != null ? String(rawValue) : null]
  );
}
```

Keep `resetColumnCache()` for deterministic tests. In production, set `columnCache = null` before throwing `DEVICE_DATA_SCHEMA_MISMATCH`; do not add a timer or schema-version registry.

- [ ] **Step 2: Await every operation in `writeDeviceData`**

Change the signature to `async function writeDeviceData(...)`. Await column discovery, each dead-letter insert, quarantine eviction, and the final insert:

```js
const dbCols = await getDeviceDataColumns(db);
await deadLetter(db, deveui, key, 'unmapped_channel', value);
await deadLetter(db, deveui, key, 'server_only_channel', value);
await deadLetter(db, deveui, key, 'column_missing', value);
await deadLetter(db, deveui, key, 'unknown_channel', value);
await evictQuarantine(db);
await db.run(sql, vals);
```

Collect missing-column facts while validating channels. Write their quarantine rows, call `await evictQuarantine(db)` so the forensic table remains bounded, then abort before constructing or executing the `device_data` insert:

```js
if (missingColumns.length) {
  await evictQuarantine(db);
  columnCache = null;
  const error = new Error(
    'osi-device-writer: device_data schema missing ' + missingColumns.join(',')
  );
  error.code = 'DEVICE_DATA_SCHEMA_MISMATCH';
  error.missingColumns = missingColumns.slice();
  throw error;
}
```

Do not add `.prepare`, callback wrappers, DDL, or a transaction abstraction. The forensic quarantine write may commit; the measurement row must not.

- [ ] **Step 3: Correct only nullish inactive-mode classification**

Create a union lookup without changing either channel map:

```js
var KNOWN_SOURCE_KEYS = Object.assign({}, DEFAULT_MAP, MODE9_MAP);
```

In the unknown-field loop, ignore an out-of-mode key only when the union recognizes it and its value is nullish. A populated out-of-mode key remains unknown, as does every populated key outside both maps.

```js
if (!map[key]) {
  var knownInactiveNullish = Object.prototype.hasOwnProperty.call(KNOWN_SOURCE_KEYS, key)
    && decoded[key] == null;
  if (!knownInactiveNullish) unknown[key] = decoded[key];
}
```

- [ ] **Step 4: Run the writer, normalizer, and integration gates**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js
node scripts/verify-device-integration.js
```

Expected: all writer tests pass; UC512 and both LSN50 round-trip suites pass; no test facade exposes `prepare`.

- [ ] **Step 5: Mirror both modules byte-for-byte**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lsn50-normalize/index.js
cmp -s \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.js
cmp -s \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lsn50-normalize/index.js
```

Expected: `cmp` exits 0.

- [ ] **Step 6: Checkpoint the green writer/normalizer subset**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js
node scripts/verify-device-integration.js
```

Do not commit yet; the error-accounting cases from Task 1 remain red until Task 3.

### Task 3: Restore the LSN50 safety path and real UCI flag

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config`
- Create: `scripts/test-osi-server-uci-defaults.sh`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/test-error-recording-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces:**

- Consumes: `writeDeviceData(...) -> Promise<WriteResult>` from Task 2.
- Produces: `LSN50_WRITER_DISABLE`, sourced from `osi-server.cloud.lsn50_writer_disable`, with truthy values limited to `1`, `true`, `yes`, and `on`.
- Produces: LSN50 primary output 1 and fallback output 2.
- Produces: `ingest_quarantine` row `{ channel: '__writer__', reason: 'writer_fallback', raw_value: <stage> }` before every forced or automatic fallback insert.
- Produces: LSN50 and UC512 Catch paths that increment `global.error_counts` for writer, loader, manifest, and identity failures.

- [ ] **Step 1: Add a failing flow contract pin**

Update `scripts/verify-sync-flow.js` so the current one-output flow fails these assertions:

```js
expectEqual(findNodeById('460e0bfd95f89e67').outputs, 2,
  'LSN50 writer retains primary and legacy fallback outputs');
expectWireById('460e0bfd95f89e67', 'lsn50-fallback-marker-fn',
  'routes writer failures through observable fallback');
expectIncludesById('460e0bfd95f89e67', 'await writerRes.value.writeDeviceData(',
  'awaits the asynchronous writer contract');
expectIncludesById('6b28e0d879808dd9', 'await writerRes.value.writeDeviceData(',
  'UC512 awaits the asynchronous writer contract');
expectIncludesById('lsn50-fallback-marker-fn', "'writer_fallback'",
  'records every LSN50 fallback before the legacy insert');
```

Parse `QUARANTINE_CAP` from `osi-device-writer/index.js` and the numeric `LIMIT` from `lsn50-fallback-evict-fn`; assert they are equal. This verifier is required because the temporary legacy path cannot load the writer constant when module loading itself caused the fallback.

Replace the current `expectMissingNodeById` assertions for `lsn50-sql-fn` and `lsn50-sqlite` with exact existence/wiring assertions for:

```text
LSN50 writer output 2 -> lsn50-fallback-marker-fn
lsn50-fallback-marker-fn -> lsn50-fallback-marker-sqlite
lsn50-fallback-marker-sqlite -> lsn50-fallback-evict-fn
lsn50-fallback-evict-fn -> lsn50-fallback-evict-sqlite
lsn50-fallback-evict-sqlite -> lsn50-sql-fn
lsn50-sql-fn -> lsn50-sqlite
lsn50-sqlite -> lsn50-zone-agg-fn
```

Add a generic assertion over every maintained function node containing `writeDeviceData(`: each call site must contain `await ...writeDeviceData(`. Add file-content pins for the UCI default and procd export.

- [ ] **Step 2: Run the structural verifier and capture the red signal**

```bash
node scripts/verify-sync-flow.js
```

Expected: FAIL because the fallback nodes are absent and both consumers omit `await`.

- [ ] **Step 3: Restore only the two required legacy insert nodes**

The mutation script must parse the current canonical flow and `git show cf68c5e8:<canonical-flow-path>`. Copy only `lsn50-sql-fn` and `lsn50-sqlite` from the historical flow. Assert those IDs are absent before insertion and unique after insertion. Do not restore `093d7832e89c4027`: it compares normalizer coverage, already proved by the prior shadow run, and cannot prove writer execution. Do not copy the historical writer node because its database call is the broken synchronous version.

Use this node selection logic inside the one-shot mutation:

```js
const fallbackIds = ['lsn50-sql-fn', 'lsn50-sqlite'];
const fallbackNodes = fallbackIds.map((id) => {
  const node = historical.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`historical fallback node missing: ${id}`);
  if (current.some((candidate) => candidate.id === id)) {
    throw new Error(`current flow already contains fallback node: ${id}`);
  }
  return node;
});
current.push(...fallbackNodes);
```

The script must perform the skill-mandated no-op round-trip check before mutation and assert that all untouched node IDs serialize byte-identically.

- [ ] **Step 4: Make both writer consumers asynchronous**

Wrap each function body in `return (async () => { ... })();` and change the call to:

```js
const result = await writerRes.value.writeDeviceData(
  db,
  edgeManifest,
  normalizeResult,
  { deveui },
  { node }
);
```

For UC512, keep its existing failure behavior after awaiting: emit `node.error(error, msg)`, set red node status, do not claim success, and do not add an unrelated fallback. Keep each database close in `finally`. Pass `{ node, msg }` to the writer so module-level validation errors retain the triggering message.

Track the primary writer outcome separately from cleanup. If the LSN50 insert succeeds and `db.close()` then rejects, preserve output 1 and the single inserted row, emit `node.error('LSN50 writer cleanup failed code=DB_CLOSE_FAILED', msg)`, set red status, and increment the error counter; never enter legacy fallback or insert a duplicate. If the writer already failed, retain its original fallback stage and attach only the fixed cleanup error without replacing or invoking the fallback twice. UC512 uses the same fixed cleanup code and never claims writer failure was success. Add deferred-close tests for success-plus-close-failure, writer-failure-plus-close-failure, and successful close, asserting call counts and exact outputs.

- [ ] **Step 5: Make every LSN50 fallback explicit and sequentially observable**

At the start of the LSN50 node, parse the flag without treating string `"0"` as true:

```js
const writerDisabled = ['1', 'true', 'yes', 'on'].includes(
  String(env.get('LSN50_WRITER_DISABLE') || '').trim().toLowerCase()
);
if (writerDisabled) {
  node.status({ fill: 'yellow', shape: 'ring', text: 'legacy fallback forced' });
  msg.osiWriterFallbackStage = 'forced_flag';
  return [null, msg];
}
```

Use one local fallback helper. Route these stages through it: `normalizer_load`, `writer_load`, `manifest_load`, `normalize_run`, `db_open`, and `writer_run`.

```js
function useFallback(stage, error) {
  const codes = {
    normalizer_load: 'NORMALIZER_LOAD_FAILED',
    writer_load: 'WRITER_LOAD_FAILED',
    manifest_load: 'MANIFEST_LOAD_FAILED',
    normalize_run: 'NORMALIZE_RUN_FAILED',
    db_open: 'DB_OPEN_FAILED',
    writer_run: 'WRITER_RUN_FAILED'
  };
  msg.osiWriterFallbackStage = stage;
  msg.osiWriterFallbackCode = codes[stage];
  node.warn('LSN50 writer fallback [' + stage + '] code=' + codes[stage]);
  if (error) node.error('LSN50 writer failed [' + stage + '] code=' + codes[stage], msg);
  return [null, msg];
}
```

Reject any stage outside the allowlist before mutating `msg`. Do not attach raw exception text, stack, cause, errno, SQL, path, or payload to the message passed into the legacy chain or to Node-RED logs. Add a thrown secret-sentinel error for every stage and prove the sentinel is absent from the returned message, warnings/errors, fallback marker SQL, and downstream legacy output; the stage and fixed code are the complete cross-boundary facts.

Create `lsn50-fallback-marker-fn` and `lsn50-fallback-marker-sqlite` with fresh unique IDs. The marker function rejects a missing/unknown stage and builds a literal, escaped insert into the existing table:

```sql
INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value)
VALUES ('<uppercase-deveui>', '__writer__', 'writer_fallback', '<stage>');
```

The marker SQLite node uses the same database configuration and `msg.topic` query mode as `lsn50-sqlite`. Add `lsn50-fallback-evict-fn` and `lsn50-fallback-evict-sqlite` after it; the function emits the writer's existing cap statement:

```sql
DELETE FROM ingest_quarantine
WHERE id NOT IN (
  SELECT id FROM ingest_quarantine ORDER BY id DESC LIMIT 1000
);
```

Wire the path sequentially so an unrecorded or unbounded fallback cannot write a fresh `device_data` row:

```text
writer output 2
  -> fallback marker function
  -> fallback marker SQLite
  -> fallback cap function
  -> fallback cap SQLite
  -> legacy SQL builder
  -> legacy SQLite insert
  -> zone aggregation
```

Set the writer node to two outputs. Output 1 remains `lsn50-zone-agg-fn`; output 2 begins the chain above. Remove the historical shadow wire from `lsn50-sql-fn`.

- [ ] **Step 6: Add executable flow-path and error-counter tests**

Use the existing `executeFunctionNodeById(...)` harness in `scripts/verify-sync-flow.js`. Supply narrow fake `osiLib`, `osiDb`, `fs`, `env`, and `node` interfaces and assert:

- flag value `1` returns only output 2 with stage `forced_flag` and never calls the writer;
- flag value `0` reaches an async writer, waits for it, and returns only output 1;
- loader failure and rejected writer Promise return only output 2 with their exact stages;
- the marker function emits `reason='writer_fallback'`, the cap function retains only the newest 1,000 quarantine rows, and both run before the legacy path; and
- the UC512 node waits for a rejected writer Promise and reports the error instead of claiming success.
- the actual LSN50 node assembly runs both null and undefined inactive-placeholder payloads through the real normalizer/writer/database facade with no quarantine; and
- every UC512 loader, manifest, identity, normalization, database-open, writer, and database-close failure reaches its Catch/error counter with only the fixed stage/code.
- an LSN50 database-close rejection after a successful insert returns only the primary success output, reaches the error counter once with `DB_CLOSE_FAILED`, and never reaches the legacy insert; writer-failure plus close-failure retains the writer fallback exactly once;
- both writer nodes pass the original `msg` to `node.error` on a rejected writer Promise; and
- `record-error-catch-uc512` and `record-error-catch-lsn50` both reach `Record Error`, with an executable catch message incrementing the expected counter.

Add `record-error-catch-uc512` on the UC512 tab and wire it through the existing error-recording link-out pattern. Include both catch IDs in `scripts/test-error-recording-flow.js`. The successful-writer fake must resolve on a later microtask and set a flag before resolving; assert the node returns only after that flag is set. Execute the real `Record Error` target for every UC512 failure stage and assert the intended counter increases once. Source-substring assertions do not replace these executable cases.

- [ ] **Step 7: Add the UCI default and procd export**

In canonical `96_osi_server_config`, add an absent-only default outside the unconditional batch, then mirror the whole file. A rerun must never reset an operator-enabled kill switch:

```sh
uci -q get osi-server.cloud.lsn50_writer_disable >/dev/null 2>&1 || \
  uci set osi-server.cloud.lsn50_writer_disable='0'
uci commit osi-server
```

Create `scripts/test-osi-server-uci-defaults.sh` with a temporary fake `uci`. Start with `lsn50_writer_disable=1`, run the extracted defaults block twice, and require it remains `1`; start absent and require exactly one default assignment to `0`. This test is extended by the later boundary-hardening plan for retention settings.

In `node-red.init`, resolve and export the value:

```sh
local lsn50_writer_disable=$(uci -q get osi-server.cloud.lsn50_writer_disable 2>/dev/null || echo "0")
```

```sh
LSN50_WRITER_DISABLE="$lsn50_writer_disable" \
```

On an existing gateway, the deploy procedure must create the key if absent before restarting Node-RED:

```sh
uci -q get osi-server.cloud.lsn50_writer_disable >/dev/null 2>&1 || {
  uci set osi-server.cloud.lsn50_writer_disable='0'
  uci commit osi-server
}
```

Apply that absent-only UCI mutation through the merged Train A deploy lifecycle after `quiesce_identityd_for_deploy` has proved the daemon and `/var/run/osi-identityd.lock` absent, while Node-RED is stopped, and before the guarded Node-RED start. A present `0` remains byte/semantics-equivalent; any present truthy/operator value is preserved and causes the plan's preflight decision rather than being overwritten. Extend the real deploy/atomic tests with absent, false, true override, UCI set/commit failure, crash after set before commit, failed identityd quiescence, and recovery cases. Require one commit only when absent and prove a failed mutation starts or restarts neither Node-RED nor identityd.

- [ ] **Step 8: Mirror and verify**

Copy the canonical changed runtime files to the bcm2709 profile. Use `scripts/flows-size-scan.js` against the fixed integrated Task 3 base and final canonical flow. Replace only the absolute `max_chars` ceilings for existing nodes `460e0bfd95f89e67` and `6b28e0d879808dd9`, add exact ceilings for new fallback nodes, and set absolute `max_total` to the measured final total, with bounded temporary-fallback reasons. Do not round up or add general headroom. Extend `verify-sync-flow.js` with owned-node/reason and extra-character failure controls; the general ratchet owns the numeric ceilings. Then run:

```bash
node scripts/verify-sync-flow.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.test.js
node scripts/verify-device-integration.js
node scripts/verify-no-new-silent-catch.js
node scripts/test-error-recording-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
scripts/check-mqtt-topics.sh
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config
sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config
sh scripts/test-osi-server-uci-defaults.sh
/bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
node --test scripts/test-deploy-atomic-payload-wiring.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
node scripts/test-journal-bootstrap.js
node scripts/test-ci-guard-wiring.js
```

Expected: all commands exit 0; the flow verifier executes the async and fallback paths, reports two LSN50 outputs, and confirms UCI/procd flag plumbing.

- [ ] **Step 9: Commit the green writer repair slice**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lsn50-normalize/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lsn50-normalize/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config \
  scripts/test-osi-server-uci-defaults.sh \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
  scripts/lib/database-sync-async-facade.js scripts/verify-device-integration.js \
  scripts/verify-sync-flow.js scripts/test-error-recording-flow.js \
  scripts/verify-flows-size-ratchet-allowances.json scripts/test-ci-guard-wiring.js \
  deploy.sh scripts/test-deploy-sh.sh scripts/test-deploy-atomic-payload-wiring.js \
  .github/workflows/verify-sync-flow.yml
git commit -m "fix: restore guarded async LSN50 writer path"
```

### Task 4: Make the deployment ingest gate correlate ChirpStack with edge rows

**Files:**

- Modify: `scripts/pipeline/checks/__init__.py`
- Modify: `scripts/pipeline/checks/ingest.py`
- Modify: `scripts/pipeline/checks/canary.py`
- Modify: `scripts/pipeline/checks/daily.py`
- Modify: `scripts/pipeline/config.py`
- Modify: `scripts/pipeline/controller.py`
- Modify: `scripts/pipeline/deploy.py`
- Modify: `scripts/pipeline/bundles.json`
- Modify: `scripts/pipeline/tests/test_checks.py`
- Modify: `scripts/pipeline/tests/test_config.py`
- Modify: `scripts/pipeline/tests/test_controller.py`

**Interfaces:**

- Produces: `VerifyContext.ingest_wait_seconds: int` and `VerifyContext.require_ingest: bool`.
- Produces: `VerifyContext.ingest_max_clock_skew_seconds: int`, default 30, for timestamp correlation when ChirpStack exposes no durable event identifier.
- Produces: a compact `backup_stamp` for filenames and an ISO-8601 `verification_started_at` read from the gateway after the deployed payload passes its health probe.
- Consumes: ChirpStack SQLite at `/srv/chirpstack/chirpstack.sqlite`, table `device(dev_eui, last_seen_at)`.
- Produces: `remote_sql(..., db_path=None)`, which defaults to the farming database and can query the ChirpStack database explicitly.

- [ ] **Step 1: Add failing tests for the observed false-pass paths**

Add deterministic tests with mocked remote SQL, UCI, clock, and sleep calls for these cases:

```python
def test_ingest_fails_when_chirpstack_is_fresh_but_edge_has_no_row(ctx):
    ctx.ingest_wait_seconds = 0
    ctx.require_ingest = True
    result = check_ingest(ctx)
    assert not result.passed
    assert "ChirpStack uplink" in result.detail

def test_ingest_passes_only_when_same_deveui_reaches_edge(ctx):
    # ChirpStack returns A8404101FD5ECF41; edge max timestamp is inside the symmetric skew bound.
    result = check_ingest(ctx)
    assert result.passed
    assert result.evidence["deveui"] == "A8404101FD5ECF41"

def test_required_ingest_fails_when_observation_window_expires(ctx):
    ctx.ingest_wait_seconds = 0
    ctx.require_ingest = True
    result = check_ingest(ctx)
    assert not result.passed
    assert "no ChirpStack uplink" in result.detail

def test_ingest_fails_when_fallback_marker_exists(ctx):
    result = check_ingest(ctx)
    assert not result.passed
    assert "writer_fallback" in result.detail

def test_ingest_runs_one_probe_when_wait_is_zero(ctx):
    ctx.ingest_wait_seconds = 0
    result = check_ingest(ctx)
    assert remote_sql_mock.call_count > 0

def test_post_boundary_edge_row_older_than_selected_uplink_does_not_pass(ctx):
    # Edge has a post-boundary row, but it predates the latest selected ChirpStack observation.
    result = check_ingest(ctx)
    assert not result.passed
    assert "predates selected ChirpStack uplink" in result.detail

def test_post_boundary_edge_row_too_far_after_selected_uplink_does_not_pass(ctx):
    # A future-dated edge row cannot prove persistence of the selected uplink.
    result = check_ingest(ctx)
    assert not result.passed
    assert "exceeds selected ChirpStack uplink" in result.detail
```

The mock must branch on `db_path` and recognizable SQL, not on a fragile call count. Return these exact shapes: newline-separated edge DevEUIs, `A8404101FD5ECF41|2026-07-15T09:00:00Z` from ChirpStack, integer strings for both counts, and a normalized UCI value. Add hard-failure cases for malformed ChirpStack output, invalid edge DevEUI, SQL failure, and SSH/UCI failure.

Add a controller test with an event list. Mock backup, deploy, `gateway_utc_now`, and `run_all_checks`; assert the order is `backup`, `deploy`, `gateway_clock`, `checks`. Capture the constructed context and assert:

```python
assert re.fullmatch(r"\d{8}T\d{6}Z", backup_timestamp)
assert ctx.verification_started_at == "2026-07-15T09:00:00Z"
```

- [ ] **Step 2: Run the focused pytest cases and capture the red signal**

```bash
python -m pytest scripts/pipeline/tests/test_checks.py scripts/pipeline/tests/test_controller.py -q
```

Expected: the new tests fail because the current check knows only `device_data`, treats zero rows as pass, receives the compact backup stamp, and never checks fallback use.

- [ ] **Step 3: Start verification after the deployed payload is healthy**

Add `gateway_utc_now(gateway) -> tuple[str | None, str | None]` to `deploy.py`. It must run `date -u +%Y-%m-%dT%H:%M:%SZ` through the existing SSH helper, catch timeout/process-start errors, reject nonzero exit, and validate the exact 20-character UTC format.

In `controller.py`, capture the backup stamp before backup. Read the verification boundary only after `deploy_to_gateway(...)` has returned success:

```python
backup_epoch = time.time()
backup_stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(backup_epoch))
backup = pre_deploy_backup(kaba100, backup_stamp)
# deploy_to_gateway(...) succeeds and its GUI health probe has passed here
verification_started_at, clock_error = gateway_utc_now(kaba100)
```

Restore and halt if the gateway clock read fails. Rename `VerifyContext.deploy_timestamp` to `verification_started_at` and update `canary.py`, `daily.py`, `ingest.py`, and all fixtures. A row written by the old payload during backup or deployment must not satisfy any post-deploy check. Do not change the backup-script filename validation.

- [ ] **Step 4: Add explicit ingest policy to configuration**

Extend the gateway dataclass and `VerifyContext` with defaults that preserve tests for inactive gateways:

```python
ingest_wait_seconds: int = 120
ingest_quiet_seconds: int = 10
require_ingest: bool = False
ingest_max_clock_skew_seconds: int = 30
```

Pass the selected gateway policy into the verification context:

```python
ctx = VerifyContext(
    gateway_host=kaba100.host,
    ssh_user=kaba100.ssh_user,
    ssh_key=kaba100.ssh_key,
    db_path=kaba100.db_path,
    gui_url=kaba100.gui_url,
    verification_started_at=verification_started_at,
    pre_deploy_baselines=backup.baselines,
    canary_gate_available=(i >= 1),
    is_extraction_bundle=bundle.id in ("B8", "B10"),
    ingest_wait_seconds=kaba100.ingest_wait_seconds,
    ingest_quiet_seconds=kaba100.ingest_quiet_seconds,
    require_ingest=kaba100.require_ingest,
    ingest_max_clock_skew_seconds=kaba100.ingest_max_clock_skew_seconds,
)
```

Set Kaba100 in `bundles.json` to:

```json
"require_ingest": true,
"ingest_wait_seconds": 1500,
"ingest_quiet_seconds": 60,
"ingest_max_clock_skew_seconds": 30
```

The 1,500 second window covers one 20-minute dendrometer cadence plus five minutes of scheduling/network margin. The 60-second quiet interval begins only after every currently fresh ChirpStack EUI has a correlated edge row and resets when the fresh EUI set or any latest timestamp changes. Validate `0 <= ingest_quiet_seconds < ingest_wait_seconds`. The 30-second correlation tolerance covers bounded clock/serialization skew in either direction; it is not a substitute for an edge row correlated to the selected uplink.

`limits.verification_timeout_s` is unused by the controller and conflicts with that window at 900 seconds. Delete the dead key from `bundles.json`; do not replace it with another inert value. Add configuration tests for the exact Kaba100 wait/quiet values, invalid negative/equal/longer quiet intervals, and default inactive-gateway behavior.

- [ ] **Step 5: Replace the soft count with a DevEUI correlation loop**

Import `shlex` and extend the existing helper without changing current callers:

```python
def remote_sql(ctx, sql: str, timeout: int = 30, extra_args: str = "", db_path: str | None = None):
    path = shlex.quote(db_path or ctx.db_path)
    sql_arg = shlex.quote(sql)
    args = f"{extra_args} " if extra_args else ""
    result, error = remote(ctx, f"sqlite3 {args}{path} {sql_arg}", timeout)
    if error:
        return None, error
    stderr = filtered_stderr(result.stderr)
    if stderr:
        return None, f"sqlite reported errors despite exit 0: {stderr[:300]}"
    return result.stdout.strip(), None
```

In `checks/ingest.py`, first query the configured farming database for devices registered as `DRAGINO_LSN50`:

```sql
SELECT upper(deveui)
FROM devices
WHERE type_id = 'DRAGINO_LSN50'
ORDER BY deveui;
```

Validate every result against `^[0-9A-F]{16}$`; fail on malformed values or on an empty set when ingest is required. Build the ChirpStack `IN (...)` list only from those validated values, then query its database through `db_path='/srv/chirpstack/chirpstack.sqlite'` and `extra_args='-separator "|"'`:

```sql
SELECT upper(hex(dev_eui)) AS deveui, last_seen_at
FROM device
WHERE upper(hex(dev_eui)) IN (<validated_euis>)
  AND datetime(last_seen_at) > datetime('<verification_started_at>')
ORDER BY upper(hex(dev_eui));
```

Parse every nonempty row into exactly two fields. Reject malformed EUI/timestamp values, duplicate EUI rows, an unregistered EUI, or an empty fresh set when `require_ingest` is true. Do not select one newest device: one healthy LSN50 must never hide another fresh dendrometer uplink that failed edge storage.

On every poll, reread the complete fresh ChirpStack set and query the edge maximum for each exact EUI:

```sql
SELECT MAX(recorded_at)
FROM device_data
WHERE deveui = '<uppercase_deveui>'
  AND datetime(recorded_at) > datetime('<verification_started_at>');
```

Parse all timestamps as UTC. For every fresh ChirpStack row, require the same EUI edge maximum inside the closed interval `chirpstack_last_seen_at - ingest_max_clock_skew_seconds <= edge_recorded_at <= chirpstack_last_seen_at + ingest_max_clock_skew_seconds`. Record each EUI, both timestamps, and signed delta. Probe once before the deadline check so a zero-second unit window still executes. Keep polling while any fresh EUI is missing or outside the interval; reread the whole set so a newly fresh device joins the obligation. Accept only after at least one fresh observation exists, zero fresh observations are unmatched, and the `ingest_quiet_seconds` interval passes without the set or latest timestamps changing. If the `ingest_wait_seconds` deadline expires, report the sorted unmatched EUI/timestamp facts. With `require_ingest=false`, only an entirely empty ChirpStack set may degrade to the explicit demo warning; a present but unmatched uplink always fails.

Add unit and adapter tests for two devices where the newest is healthy but a second fresh EUI is absent from `device_data`, two healthy devices, a late second uplink that resets the quiet interval, malformed and duplicate rows, unregistered EUI, far-future edge time, stale edge time, empty fresh set, and database stderr with exit zero.

- [ ] **Step 6: Reject fallback use and a forced kill switch**

Before returning PASS, require:

```sql
SELECT COUNT(*)
FROM ingest_quarantine
WHERE reason = 'writer_fallback'
  AND datetime(received_at) > datetime('<verification_started_at>');
```

The count must be zero. Read `uci -q get osi-server.cloud.lsn50_writer_disable` through `checks.remote`; the Kaba100 gate fails unless the value normalizes to `0`, `false`, `no`, `off`, or empty. A command failure is a hard failure, not an empty setting.

- [ ] **Step 7: Run the pipeline suite**

```bash
python -m pytest scripts/pipeline/tests -q
```

Expected: all tests pass, including fresh-ChirpStack/no-edge failure, same-DevEUI timestamp-correlated success, post-boundary edge too old, post-boundary edge too far in the future, both inclusive skew boundaries, required-window failure, fallback rejection, one-probe zero window, and post-health timestamp ordering.

- [ ] **Step 8: Commit the pipeline gate**

```bash
git add scripts/pipeline/checks/__init__.py scripts/pipeline/checks/ingest.py \
  scripts/pipeline/checks/canary.py scripts/pipeline/checks/daily.py \
  scripts/pipeline/config.py scripts/pipeline/controller.py scripts/pipeline/deploy.py \
  scripts/pipeline/bundles.json \
  scripts/pipeline/tests/test_checks.py scripts/pipeline/tests/test_config.py \
  scripts/pipeline/tests/test_controller.py
git commit -m "fix: hard-fail missing edge ingest after ChirpStack uplink"
```

### Task 5: Correct the refactor record and document the outage

**Files:**

- Create: `docs/operations/kaba100-lsn50-writer-outage-2026-07-15.md`
- Modify: `docs/architecture/refactor-program-2026.md`
- Modify: `AGENTS.md`
- Modify: `.claude/skills/osi-config-and-flags/SKILL.md`

**Interfaces:**

- Produces: a dated incident record with verified hashes, timestamps, backup location, recovery payload, and data-loss boundary.
- Produces: a repository invariant that any helper consuming `osi-db-helper` must test against `all/get/run` without `prepare`.

- [ ] **Step 1: Write the incident record from measured evidence**

Record these facts without claiming historical payload recovery:

```text
First confirmed edge gap: after 2026-07-12T13:08:07.366Z.
Repair payload activated: 2026-07-15, /srv/node-red/payloads/20260715T083105Z-lsn50-fallback-repair.
Backup: /data/db/backups/pre-lsn50-writer-repair-20260715-082814, quick_check=ok.
Failure: TypeError: db.prepare is not a function.
First post-repair Temp1 row: 2026-07-15T08:34:43.253Z.
First post-repair Dendro 3 row: 2026-07-15T08:43:29.280Z.
```

State that ChirpStack's local database preserves `last_seen_at` and frame counters but not the missing application payload history. Recovery of the July 12 to July 15 gap requires an external MQTT/application log if one exists.

- [ ] **Step 2: Correct items 3.2, 3.3, and 4.1 in the refactor program**

Correct item 3.2 so its CI claim is tied to the workflow step added in Task 1. Record the four invoked commands by name. The item remains regressed until the async-only facade case fails on the old writer, passes on the repaired writer, and the workflow is green on a pull request.

Change the status from completed cutover to regressed/recovery in progress. Separate the evidence:

```text
Normalizer evidence: 621 shadow uplinks, zero mapping diffs.
Writer evidence: invalid; the live facade mismatch caused every primary write to throw.
Fresh-row evidence during the initial cutover: fallback-backed and therefore not primary-writer proof.
```

Retain DD7's original exit bar. Add zero `writer_fallback` rows and path-correlated ChirpStack-to-edge proof as required evidence.

- [ ] **Step 3: Add the database helper invariant to `AGENTS.md`**

Add this rule near the Node-RED helper conventions:

```text
`osi-db-helper` is asynchronous. Consumers use and await `all`, `get`, `run`,
`transaction`, or `readSnapshot`; they do not call `prepare`. Tests for a
consumer must pass an async-only facade without a `prepare` member.
```

- [ ] **Step 4: Record the new UCI flag in its source-of-truth catalog**

Add `osi-server.cloud.lsn50_writer_disable` to section 1 of `.claude/skills/osi-config-and-flags/SKILL.md`: default `0`, exported by `node-red.init` as `LSN50_WRITER_DISABLE`, accepted true values `1/true/yes/on`, and temporary ownership by the LSN50 recovery path. Add the new key and environment variable to that skill's re-verification commands. Do not copy the full recovery procedure into the flag catalog.

- [ ] **Step 5: Run prose and repository checks**

```bash
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/operations/kaba100-lsn50-writer-outage-2026-07-15.md \
  docs/architecture/refactor-program-2026.md AGENTS.md \
  .claude/skills/osi-config-and-flags/SKILL.md
git diff --check
```

Expected: `slop-check: PASS (no tier-1 findings)` and `git diff --check` exits 0.

- [ ] **Step 6: Commit the corrected record**

```bash
git add docs/operations/kaba100-lsn50-writer-outage-2026-07-15.md \
  docs/architecture/refactor-program-2026.md \
  .claude/skills/osi-config-and-flags/SKILL.md
if [ "${OSI_REPAIR_PROGRAM_MODE:-0}" != "1" ]; then
  git add AGENTS.md
fi
git commit -m "docs: correct LSN50 cutover evidence after Kaba100 outage"
```

### Task 6: Run local release gates

**Files:**

- No new files.
- Verify all files changed in Tasks 1 through 5.

**Interfaces:**

- Consumes: the asynchronous writer, guarded fallback, pipeline gate, and corrected documentation.
- Produces: a clean verification report tied to the exact commit under test.

- [ ] **Step 1: Run the focused writer and dendro gates**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.test.js
node scripts/verify-device-integration.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/index.test.js
node scripts/test-dendro-contract.js
```

Expected: all commands exit 0. Dendro tests are regression guards only; this recovery does not alter their expected values.

- [ ] **Step 2: Run the flow, profile, and pipeline gates**

```bash
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/test-flows-wiring.js
node scripts/test-error-recording-flow.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
scripts/check-mqtt-topics.sh
python -m pytest scripts/pipeline/tests -q
```

Expected: all commands exit 0.

- [ ] **Step 3: Check the final diff**

```bash
git diff --check
git status --short --branch
git log -5 --oneline
```

Expected: no whitespace errors; only the planned files differ from `main`; unrelated untracked user files remain untouched.

### Task 7: Deploy to Kaba100 and collect path-specific evidence

**Files:**

- Runtime only on `root@100.93.68.86`.
- Evidence: `pipeline-evidence/` through the existing pipeline collector.

**Interfaces:**

- Consumes: the exact locally verified commit from Task 6.
- Produces: matching ChirpStack and edge timestamps, zero fallback markers, and fresh dendrometer rows for all five live devices.

When invoked by `2026-07-15-refactor-repair-program.md`, this task is a verification leg of the single Train A Task A4 deployment on the merged identity baseline. Consume A4's deployment ID, backup manifest, compatibility/runtime manifest hashes, deployment receipt, and shared verification boundary; do not take a second backup, redeploy, restart outside the guarded identityd lifecycle, or require a `payloads/current` symlink that Train A compatibility mode may not create. The standalone backup/deploy instructions apply only when this source plan is explicitly authorized outside the program.

- [ ] **Step 1: Record pre-deploy identity and take a verified backup**

Record `git rev-parse HEAD`, the active flow/control stamp or sealed-release symlink when present, Node-RED status, database row counts, and latest per-device timestamps. In standalone mode, use the live-ops backup procedure and require `PRAGMA quick_check=ok` before deployment. Under the repair program, reverify and consume A4's existing backup and receipt without creating another backup.

- [ ] **Step 2: Require explicit authority before changing a preexisting writer override**

Read and record the existing non-secret value first. If the key is absent, create the default `0`. If a preexisting value normalizes to `1`, `true`, `yes`, or `on`, stop before deployment and request explicit current-turn authorization to change the operator kill switch; the repair plan itself does not grant that authority. Do not normalize an unreadable command failure to “absent.” After authorization, record the old/new value in evidence, set `0`, and verify the resolved Node-RED environment after restart. Do not restore the true override after claiming the primary writer path accepted, because that would immediately disable the repaired path; the authorized change is an operator configuration decision.

For an absent key or an explicitly authorized reset only:

```sh
if ! uci -q get osi-server.cloud.lsn50_writer_disable >/dev/null 2>&1; then
  uci set osi-server.cloud.lsn50_writer_disable='0'
  uci commit osi-server
fi
```

When and only when the evidence record contains the explicit authorization for the preexisting true value, run:

```sh
uci set osi-server.cloud.lsn50_writer_disable='0'
uci commit osi-server
```

In standalone mode, deploy the staged payload through the merged identityd-aware lifecycle. Under the repair program, do not deploy again; verify the already active A4 flow/control stamp and four-role state. Do not remove the fallback nodes.

After Node-RED reports `running` and `/gui` passes its health probe, record `verification_started_at` from `date -u +%Y-%m-%dT%H:%M:%SZ` on Kaba100. Use this boundary for every SQL and ChirpStack query below; do not reuse the pre-deploy backup stamp.

- [ ] **Step 3: Prove the runtime module contract before waiting for radio data**

On Kaba100, require:

```js
const db = new (require('/srv/node-red/node_modules/osi-db-helper').Database)('/data/db/farming.db');
console.log(typeof db.prepare, typeof db.all, typeof db.get, typeof db.run);
```

Expected output: `undefined function function function`.

- [ ] **Step 4: Observe one full dendrometer cadence**

Wait up to 1,500 seconds. Poll `/srv/chirpstack/chirpstack.sqlite` and `/data/db/farming.db` every 15 seconds. Require at least one post-deploy LSN50 uplink to have the same uppercase DevEUI in both databases, with the edge timestamp inside the configured symmetric ChirpStack observation-skew window.

- [ ] **Step 5: Require all five Kaba100 dendrometers to advance**

Within the observation window, compare each pre-deploy latest row with the post-deploy row for:

```text
A84041A171826642 Dendro1
A8404141175E7CF8 Dendro 2
A8404101FD5ECF41 Dendro 3
A840411A1B5CFF85 Dendro 4
A84041CCB55CFF8A Dendro 5
```

Require `device_data` and `dendrometer_readings` to advance for every device. Record raw position, calibrated position, stem change, validity, saturation, and timestamp. Do not convert saturated or low-confidence values into a stress recommendation.

- [ ] **Step 6: Prove the primary path, API, and database health**

Require all of the following:

```sql
PRAGMA quick_check;
SELECT COUNT(*) FROM ingest_quarantine
WHERE reason='writer_fallback'
  AND datetime(received_at) > datetime('<verification_started_at>');

SELECT COUNT(*) FROM ingest_quarantine
WHERE reason='unknown_channel'
  AND raw_value IS NULL
  AND datetime(received_at) > datetime('<verification_started_at>');
```

Expected: `ok`, `0`, and `0`. Also require Node-RED `running`, `/gui` in `200/301/302`, the UC512 and LSN50 error counters unchanged during successful ingest, and the authenticated device API to return the same latest dendro timestamps as SQLite.

- [ ] **Step 7: Verify dendro QA without forcing a live recommendation**

Run the deterministic analytics and shared contract tests from Task 6. On live data, inspect the next scheduled `dendrometer_daily` rows after a complete local day. Require `valid_readings_count`, `qa_flags_json`, `low_confidence_day`, and `confidence_score` to agree with saturation and sample-window evidence. The current observed 25 mm high-saturated sensors must remain excluded from actionable zone stress while confidence is low.

- [ ] **Step 8: Keep the fallback until the evidence bar is met**

Do not delete the fallback marker chain, `lsn50-sql-fn`, `lsn50-sqlite`, or the UCI flag in this deployment. Open a separate cleanup change only after either 14 days or 500 live LSN50 uplinks per gateway, with:

```text
zero normalizer diffs
zero ingest dead letters
zero writer_fallback rows
matching ChirpStack-to-edge rows on every observed gateway
```

The cleanup change must rerun all Task 6 gates and another full Kaba100 observation window.

## Plan boundary

This plan repairs the live writer regression, false quarantine, and false-green ingest evidence that allowed it through. It does not change ChirpStack device assignments; execute `docs/superpowers/plans/2026-07-15-chirpstack-device-reconciliation.md` for existing-device profile/application repair. It does not claim that refactor-program deployment safety is complete. Continue with `docs/superpowers/plans/2026-07-15-refactor-boundary-hardening.md` for the full Node-RED release unit, verified rollback result, bundle target routing, pipeline resume behavior, and ChirpStack profile export contract.
