# Field Journal PR 141 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct every merge-relevant PR 141 review finding, preserve the intentional Slice 1 contracts, and produce a locally and remotely green branch that can be merged into `main`.

**Architecture:** Keep the edge journal implementation modular: lifecycle owns transactional entry validation, the command ledger owns generic ACK durability, API owns streaming exports, and executable verifiers prove the schema/sync boundaries. Flow mutations remain exact one-shot transformations, while current specifications receive corrections and historical records receive supersession annotations.

**Tech Stack:** Node.js 22, Node-RED flow JSON, SQLite, JSON Schema Draft-07 subset, GitHub Actions, shell verification scripts.

## Global Constraints

- Work only in `/home/phil/Repos/osi-os/.claude/worktrees/feat+field-journal-slice1` on `feat/field-journal-slice1`.
- Preserve the existing staged `.superpowers/sdd/progress.md`; task commits must use `git commit --only` with that task's complete file list and must not include unrelated staged content.
- Follow red-green-refactor: add one focused regression, run it and capture the expected failure, then change production code and rerun the focused and neighboring suites.
- The bcm2712 runtime payload is canonical; copy each changed runtime helper byte-for-byte to bcm2709 and finish each runtime task with `node scripts/verify-profile-parity.js`.
- Modify `flows.json` only through an idempotent Node.js migration script that checks exact input seams, proves byte-stable JSON round-trip before mutation, writes both maintained profiles identically, and proves a second application is a no-op.
- Migration 0018 is not on `origin/main`; correct it in place, update `CHECKSUMS.json`, the seed, and all seven bundled databases in the same task.
- Keep `journal_entry:<uuid>:<base_sync_version>` semantics. Do not add a `+1` offset to schema or replay binding.
- Keep canonical timestamp contract version 1 at millisecond output precision in both repositories.
- Preserve historical prompts and reports; add dated supersession notes instead of rewriting historical claims.
- Do not access live gateways, deploy, or connect to `osicloud.ch`.
- Before every task commit run `git diff --check` on the task files and inspect `git status --short`.

---

### Task 1: Transactional journal reference and season correctness

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/lifecycle.js`
- Modify: `scripts/test-journal-lifecycle.js`
- Modify: `scripts/test-journal-command-path.js`

**Interfaces:**
- Consumes: resolved plot `{ zone_id, gateway_device_eui }`, trusted principal `{ user_id, gateway_device_eui }`, and catalog reference key `valve_actuation_expectations.expectation_id`.
- Produces: `referenceValuesForFinalization(tx, plot, principal) -> Map<string, Set<string>>`; create, promotion, and correction pass this map into `validateEntry`.

- [ ] **Step 1: Add failing lifecycle regressions.** Add tests that seed one owned same-zone expectation, one foreign-zone expectation, and one foreign-owner expectation. Exercise final create, draft promotion, and correction with `attr.actuation_expectation_id`. The owned value must succeed; missing and foreign values must reject with `invalid_reference` and leave entries, values, outbox, and command ledger unchanged. Add a correction test where the UTC instant is unchanged but timezone changes across a local-date season boundary and assert that the new covering season is selected.

```js
const actuationValue = (expectationId) => ({
  attribute_code: 'attr.actuation_expectation_id',
  group_index: 0,
  value: expectationId,
  value_status: 'observed',
});

await db.run(
  'INSERT INTO valve_actuation_expectations(' +
    'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
    'expected_close_at,volume_source,reconciliation_state,created_at' +
  ') VALUES (?,?,?,?,?,?,?,?,?)',
  ['expectation-owned', VALVE_DEVICE_EUI, 1, now, 60, later,
    'unknown', 'OBSERVED_RUNNING', now]
);
```

- [ ] **Step 2: Add a failing command-path regression.** Submit an `UPSERT_JOURNAL_ENTRY` carrying the owned expectation and require terminal APPLIED state; change only the reference to a foreign expectation and require a permanent validation rejection with no journal write.

- [ ] **Step 3: Run the focused tests and confirm red.**

Run:

```bash
node scripts/test-journal-lifecycle.js
node scripts/test-journal-command-path.js
```

Expected: the new reference tests fail with `reference_unresolved`; the timezone-only correction preserves the old season incorrectly.

- [ ] **Step 4: Implement the allow-listed resolver and timezone determinant.** Add the following helper beside `validationDefinitions` and pass its result to every final validation call:

```js
const ACTUATION_REFERENCE_KEY = 'valve_actuation_expectations.expectation_id';

async function referenceValuesForFinalization(tx, plot, principal) {
  const allowed = new Set();
  if (plot.zone_id != null) {
    const rows = await tx.all(
      'SELECT vae.expectation_id FROM valve_actuation_expectations AS vae ' +
      'JOIN devices AS d ON UPPER(d.deveui)=UPPER(vae.device_eui) ' +
      'WHERE vae.zone_id=? AND d.user_id=? AND d.gateway_device_eui=? ' +
        'AND d.deleted_at IS NULL ORDER BY vae.expectation_id',
      [plot.zone_id, principal.user_id, principal.gateway_device_eui]
    );
    for (const row of rows) allowed.add(row.expectation_id);
  }
  return new Map([[ACTUATION_REFERENCE_KEY, allowed]]);
}
```

Use `{ referenceValues }` for create and promotion, and `{ mode: 'correction', originalEntry, referenceValues }` for correction. Extend `sameDeterminants` with:

```js
existing.occurred_timezone === occurrence.timezone
```

- [ ] **Step 5: Mirror and verify green.** Copy the canonical lifecycle module to bcm2709, then run:

```bash
node scripts/test-journal-lifecycle.js
node scripts/test-journal-command-path.js
node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js
node scripts/verify-profile-parity.js
```

Expected: all pass; lifecycle output includes the increased test count.

- [ ] **Step 6: Commit only Task 1 files.**

```bash
git commit --only \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/lifecycle.js \
  scripts/test-journal-lifecycle.js scripts/test-journal-command-path.js \
  -m "fix(journal): resolve scoped actuation references"
```

---

### Task 2: Durable command ACK and snapshot cleanup semantics

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.js`
- Modify: `scripts/test-osi-db-helper-read-snapshot.js`
- Modify: `scripts/test-journal-command-path.js`

**Interfaces:**
- Produces: `classifyAckResult('EXPIRED') === 'EXPIRED'`; exact delivery returns the first normalized durable ACK; malformed payload after a permissive injected validator returns `{ handled: false }`; `readSnapshot` preserves every thrown JavaScript value when close also fails.

- [ ] **Step 1: Add failing ledger tests.** Change the existing EXPIRED expectations to terminal and add an exact replay assertion. Add a raw ACK with `result: 'SUCCESS'`, complete-looking `status/result/duplicate`, and no `appliedAt`; require the first returned ACK, queued outbox JSON, stored `result_detail`, and exact replay ACK to be deeply equal and normalized. Add an injected validator that returns true for `payload: null` and require `{ handled: false }` without an exception.

```js
assert.equal(ledger.classifyAckResult('EXPIRED'), 'EXPIRED');
assert.equal((await db.get(
  'SELECT result FROM applied_commands WHERE command_id=?', ['802']
)).result, 'EXPIRED');
```

- [ ] **Step 2: Add failing snapshot close tests.** Extend the sqlite adapter with a per-test injected close error. Cover executor success, `throw new Error`, `throw 'primitive'`, `throw null`, and `throw undefined`. Success must reject with close error; every executor failure must remain the rejection reason, with `closeError` attached only to object/function failures.

- [ ] **Step 3: Run focused tests and confirm red.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node scripts/test-osi-db-helper-read-snapshot.js
node scripts/test-journal-command-path.js
```

Expected: EXPIRED is retryable, raw ACK replay differs, permissive validator dereferences null, and primitive snapshot failures are replaced.

- [ ] **Step 4: Implement ledger corrections.** Use explicit EXPIRED classification, store `JSON.stringify(initial)` rather than raw `ack`, invoke the terminal hook with `initial`, and guard payload after `validEffectBinding`:

```js
if (result === 'EXPIRED') return 'EXPIRED';
if (['FAILED_RETRYABLE', 'RETRYABLE_ERROR'].includes(result)) return 'FAILED_RETRYABLE';

if (!envelope.payload || typeof envelope.payload !== 'object' ||
    Array.isArray(envelope.payload)) return { handled: false };
```

- [ ] **Step 5: Refactor `readSnapshot` cleanup outside `finally`.** Track `operationFailed` separately so falsy thrown values are distinguishable from success:

```js
let operationFailed = false;
let failure;
let result;
try {
  // pragmas, BEGIN, executor, COMMIT
  result = await executor(createTransactionScope(database));
} catch (error) {
  operationFailed = true;
  failure = error;
  // rollback and attach rollbackError when possible
}
let closeError = null;
try { await closeDatabase(database); } catch (error) {
  closeError = error;
  setLastError(error);
}
if (operationFailed) {
  if (closeError && failure &&
      (typeof failure === 'object' || typeof failure === 'function')) {
    failure.closeError = closeError;
  }
  throw failure;
}
if (closeError) throw closeError;
return result;
```

- [ ] **Step 6: Mirror and verify green.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node scripts/test-osi-db-helper-read-snapshot.js
node scripts/test-journal-command-path.js
node scripts/verify-profile-parity.js
```

- [ ] **Step 7: Commit only Task 2 files.**

```bash
git commit --only \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.js \
  scripts/test-osi-db-helper-read-snapshot.js scripts/test-journal-command-path.js \
  -m "fix(commands): preserve terminal ACK replay semantics"
```

---

### Task 3: Safe and lossless research package

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js`
- Modify: `scripts/test-journal-api.js`

**Interfaces:**
- Produces: package members `entries.csv`, `values.csv`, `vocab_mappings.csv`, `records.ndjson`, `manifest.json`; CSV strings are formula-neutralized; NDJSON preserves typed row values exactly.

- [ ] **Step 1: Replace the unsafe-package test with failing dual-contract tests.** For the dangerous strings `=1`, `+1`, `-1`, `@cmd`, tab, carriage return, leading spaces before `=`, and a source apostrophe, require safe CSV values and exact NDJSON values. Require negative numeric values to remain JSON numbers and unquoted CSV numbers.

```js
assert.deepEqual(memberNames, [
  'entries.csv', 'values.csv', 'vocab_mappings.csv', 'records.ndjson', 'manifest.json',
]);
assert.equal(csvEntry.note, "'=1");
assert.deepEqual(JSON.parse(ndjsonLine), {
  record_type: 'entry',
  data: expectedEntryRow,
});
```

- [ ] **Step 2: Run API tests and confirm red.**

```bash
node scripts/test-journal-api.js
```

Expected: CSV remains raw and `records.ndjson` is absent.

- [ ] **Step 3: Add a chunked NDJSON writer and enable CSV protection.** Keep the 64 KiB chunk discipline:

```js
async function writeNdjsonRows(member, recordType, rows) {
  let chunk = '';
  for (const row of rows) {
    const line = JSON.stringify({ record_type: recordType, data: row }) + '\n';
    if (chunk && Buffer.byteLength(chunk, 'utf8') + Buffer.byteLength(line, 'utf8') > 64 * 1024) {
      await member.write(chunk);
      chunk = '';
    }
    chunk += line;
  }
  if (chunk) await member.write(chunk);
}
```

Call `csvLine(columns, row, true)`. After the three CSV members, stream entry and value rows page-by-page and mappings once into `records.ndjson`. Add its finished checksum record to `dataMembers`. Update `RESEARCH_SCHEMA_DESCRIPTOR.package_members` and manifest metadata with:

```js
csv_string_safety: 'formula-prefix apostrophe; exact source strings are in records.ndjson',
lossless_member: 'records.ndjson',
```

Assert that the published research schema hash reflects the descriptor with the
new member and that the manifest carries the finished `records.ndjson` checksum.

- [ ] **Step 4: Mirror and verify.**

```bash
node scripts/test-journal-api.js
node --no-warnings scripts/test-journal-perf-fixture.js
node scripts/verify-profile-parity.js
```

- [ ] **Step 5: Commit only Task 3 files.**

```bash
git commit --only \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js \
  scripts/test-journal-api.js \
  -m "fix(journal): make research exports safe and lossless"
```

---

### Task 4: Honest journal operation and ACK verifiers

**Files:**
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-sync-op-parity.js`
- Modify: `scripts/verify-sync-op-parity.test.js`

**Interfaces:**
- Produces: ACK SQL assertion against `commandLedgerSource`; journal op discovery accepts only the third argument of exact `emitJournalOutbox(...)` calls plus the one audited direct SQL emitter.

- [ ] **Step 1: Add failing parity fixtures.** Add fixtures for an unused JOURNAL constant, `fakeOutboxMetric('JOURNAL_ENTRY_UPSERTED')`, an operation literal in the wrong argument position, and a dynamic third argument. Each must fail to satisfy `edgeModuleOwned` or emit a clear verifier error.

```js
const NEVER_EMITTED = 'JOURNAL_ENTRY_VOIDED';
fakeOutboxMetric('JOURNAL_ENTRY_UPSERTED');
emitJournalOutbox('JOURNAL_ENTRY_UPSERTED', source, tx);
emitJournalOutbox(tx, source, operation);
```

- [ ] **Step 2: Confirm red.**

```bash
node --test scripts/verify-sync-op-parity.test.js
```

Expected: at least the unused constant and misleading outbox call are accepted incorrectly.

- [ ] **Step 3: Restrict call parsing.** Initialize `ops` empty. Split call arguments at top-level commas using the masked source. For callee `emitJournalOutbox`, require exactly three arguments and require argument index 2 to be one static `JOURNAL_*_(UPSERTED|VOIDED)` string literal. Any other callee whose normalized name contains `outbox` is an unaudited call error. Continue excluding the exact function definition and requiring one audited direct SQL insert in `lifecycle.js`.

- [ ] **Step 4: Correct the ACK source assertion.** Replace the line-1574 call with:

```js
expectFileIncludes(
  'osi-command-ledger/index.js',
  commandLedgerSource,
  'INSERT INTO command_ack_outbox',
  'queues durable REST command ACKs in the shared transaction helper'
);
```

- [ ] **Step 5: Verify green.**

```bash
node --test scripts/verify-sync-op-parity.test.js
node scripts/verify-sync-op-parity.js /home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java
node scripts/verify-sync-flow.js
```

- [ ] **Step 6: Commit only Task 4 files.**

```bash
git commit --only scripts/verify-sync-flow.js scripts/verify-sync-op-parity.js \
  scripts/verify-sync-op-parity.test.js \
  -m "fix(verify): prove journal outbox emission sites"
```

---

### Task 5: Contract schemas, validator semantics, and CI reachability

**Files:**
- Modify: `docs/contracts/sync-schema/events.schema.json`
- Modify: `docs/contracts/sync-schema/resources.schema.json`
- Modify: `scripts/test-contract-schemas.js`
- Modify: `.github/workflows/field-journal.yml`

**Interfaces:**
- Produces: required journal `occurredAt`; canonical command identities; dependency-free validation with JSON deep equality and code-point lengths; CI execution of sync-contract and command-ledger suites.

- [ ] **Step 1: Add failing contract fixtures.** For every journal event, delete `occurredAt` and set it to null; both must fail. For entry, vocab, plot, and plot-group commands, use compact and uppercase nested owner UUIDs; each must fail while the corresponding aggregate sample remains accepted.

- [ ] **Step 2: Add validator self-tests that fail at current head.** Exercise an emoji against `maxLength: 1`, object-valued `const` and `enum`, duplicate objects under `uniqueItems`, and malformed schemas using a negative length, non-array enum, non-boolean `uniqueItems`, or duplicate type array.

```js
reportCheck(validationErrors({ type: 'string', maxLength: 1 }, '😀').length === 0,
  'maxLength counts Unicode code points', 'maxLength counts UTF-16 code units');
```

- [ ] **Step 3: Confirm red.**

```bash
node scripts/test-contract-schemas.js
```

- [ ] **Step 4: Correct schemas.** Add `required: ['occurredAt']` inside the journal-event conditional `then`. In each command wrapper, add a second `allOf` object that narrows only compared identities:

```json
{
  "properties": {
    "owner_user_uuid": {"$ref": "#/definitions/CanonicalUuid"},
    "author_principal_uuid": {"$ref": "#/definitions/CanonicalUuid"}
  }
}
```

Entry narrows owner and author; vocab, plot, and plot-group narrow owner. Do not narrow aggregate definitions.

- [ ] **Step 5: Harden the dependency-free validator.** Import `isDeepStrictEqual` from `node:util`. Validate supported keyword shapes in `schemaStructureErrors`; use `Array.from(value).length` for string lengths; use deep equality for `const`, `enum`, and pairwise `uniqueItems`.

- [ ] **Step 6: Chain the missing gates in CI.** Add these steps to `.github/workflows/field-journal.yml`:

```yaml
      - name: Sync contract registry and semantic bindings
        run: node scripts/verify-sync-contract.js
      - name: Contract schema edge cases
        run: node scripts/test-contract-schemas.js
      - name: Command ledger tests
        run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
```

- [ ] **Step 7: Verify green.**

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
```

- [ ] **Step 8: Commit only Task 5 files.**

```bash
git commit --only docs/contracts/sync-schema/events.schema.json \
  docs/contracts/sync-schema/resources.schema.json scripts/test-contract-schemas.js \
  .github/workflows/field-journal.yml \
  -m "fix(contracts): close journal schema validation gaps"
```

---

### Task 6: Immutable catalog migration recovery

**Files:**
- Modify: `scripts/generate-journal-catalog.js`
- Modify: `scripts/test-journal-catalog-generator.js`

**Interfaces:**
- Produces: a missing migration may be restored only when its generated SHA-256 equals the recorded manifest entry; refusal is atomic for migration, seed, and manifest.

- [ ] **Step 1: Add failing temp-directory tests.** Remove the generated migration while keeping a recorded hash, then compile changed bytes. Require `writeGeneratedArtifacts` to throw and leave the missing migration, seed, and manifest untouched. Also prove that matching generated bytes restore the missing file.

- [ ] **Step 2: Confirm red.**

```bash
node scripts/test-journal-catalog-generator.js
```

Expected: mismatching generated bytes recreate 0019 and rewrite the manifest.

- [ ] **Step 3: Guard before `expectedArtifacts` writes.** Parse the current manifest, compute `sha256(compiled.migration)`, and before creating a missing migration enforce:

```js
const recordedChecksum = manifest[MIGRATION_NAME];
const generatedChecksum = sha256(compiled.migration);
if (recordedChecksum && recordedChecksum !== generatedChecksum) {
  fail(`${MIGRATION_NAME} has a different recorded checksum; restore it or create a new migration`);
}
```

Compute all expected strings before the first filesystem write.

- [ ] **Step 4: Verify green.**

```bash
node scripts/test-journal-catalog-generator.js
node scripts/generate-journal-catalog.js --check
node scripts/verify-migrations.js
```

- [ ] **Step 5: Commit only Task 6 files.**

```bash
git commit --only scripts/generate-journal-catalog.js \
  scripts/test-journal-catalog-generator.js \
  -m "fix(migrations): protect journal catalog recovery"
```

---

### Task 7: Journal plot-settings referential integrity

**Files:**
- Modify: `database/migrations/ordered/0018__field_journal.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`
- Modify: `database/seed-blank.sql`
- Modify: `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
- Modify: `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
- Modify: `database/farming.db`
- Modify: `web/react-gui/farming.db`
- Modify: `scripts/test-journal-schema.js`

**Interfaces:**
- Produces: `journal_plot_settings.plot_uuid REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE` on migration replay, seed replay, and every bundled database.

- [ ] **Step 1: Add failing schema checks.** For the seed scratch database, migration scratch database, and every bundled database, inspect `PRAGMA foreign_key_list(journal_plot_settings)` and require the exact cascade. In a scratch database with foreign keys enabled, reject an orphan and delete settings when its plot is deleted.

- [ ] **Step 2: Confirm red.**

```bash
node scripts/test-journal-schema.js
```

Expected: the foreign-key list is empty and orphan insertion succeeds.

- [ ] **Step 3: Correct migration and seed.** Change the table column in both SQL sources to:

```sql
plot_uuid TEXT PRIMARY KEY REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
```

Recompute only the 0018 entry in `CHECKSUMS.json` with the exact SHA-256 of the edited migration.

- [ ] **Step 4: Rebuild the table in all seven bundled databases.** Use a checked temporary SQL script with `PRAGMA foreign_keys=OFF`, `BEGIN IMMEDIATE`, a `journal_plot_settings_new` table with the corrected FK, lossless `INSERT ... SELECT`, old-table drop, rename, `COMMIT`, and `PRAGMA foreign_keys=ON`. Apply it with `sqlite3 -bail` to the six non-mirror databases, then copy the canonical full bcm2712 DB over full bcm2709. Confirm row counts before and after.

- [ ] **Step 5: Verify all schema gates.**

```bash
node scripts/test-journal-schema.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-profile-parity.js
```

- [ ] **Step 6: Commit only Task 7 files.** Include all seven binary DB paths explicitly and use:

```bash
git commit --only database/migrations/ordered/0018__field_journal.sql \
  database/migrations/ordered/CHECKSUMS.json database/seed-blank.sql \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db web/react-gui/farming.db scripts/test-journal-schema.js \
  -m "fix(schema): enforce journal plot settings ownership"
```

---

### Task 8: Fail-closed sync outbox and calibration flow hardening

**Files:**
- Create: `scripts/harden-sync-outbox-json.js`
- Create: `scripts/test-sync-outbox-json-guard.js`
- Modify: `scripts/migrate-flows-journal-bootstrap.js`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` through the one-shot script
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` through the one-shot script

**Interfaces:**
- Produces: strict outbox payload object parsing in Build Cloud Bootstrap, Build Edge Event Batch, and Run Force Sync; only the missing calibration table is a tolerated STREGA fallback.

- [ ] **Step 1: Add a failing shipped-source behavior test.** Extract `parseJsonValue` from each of the three function nodes and evaluate it. Valid object JSON must parse; invalid JSON, `null`, arrays, strings, and numbers must throw with `event_uuid`. Assert that delivery mapping calls the strict parser and has no inline `{}` fallback. Assert the STREGA catch checks `no such table: zone_irrigation_calibration`, calls `node.warn`, and rethrows other failures.

- [ ] **Step 2: Confirm red.**

```bash
node scripts/test-sync-outbox-json-guard.js
```

- [ ] **Step 3: Write the exact one-shot transformer.** Pin SHA-256 of the four current nodes. Before mutation, prove both flows are byte-identical and each file equals its pretty-printed parse round-trip. Replace the fallback helper with:

```js
function parseJsonValue(raw, eventUuid) {
  let value;
  try { value = JSON.parse(raw); } catch (cause) {
    const error = new Error('Malformed sync_outbox payload_json for ' + String(eventUuid));
    error.cause = cause;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sync_outbox payload_json must be an object for ' + String(eventUuid));
  }
  return value;
}
```

Remove the local catches around gateway-reference rewriting so transaction rollback runs. Replace normal/force delivery inline parse fallbacks with `parseJsonValue(r.payload_json, r.event_uuid)`. Change the calibration catch to tolerate only the missing-table regex, warn visibly, and rethrow otherwise. Prove the transformer is idempotent and writes identical maintained flows.

- [ ] **Step 4: Keep the journal-bootstrap migration template safe.** Apply the same strict helper and rewrite semantics in `migrate-flows-journal-bootstrap.js` so replaying its generated source cannot reintroduce the fallback.

- [ ] **Step 5: Record the reviewed flow growth and run flow verification.** Set the
  `sync-bootstrap-build`, `sync-outbox-build`, and `sync-force-build` node allowances
  to their exact post-change deltas from `origin/main`, retaining the earlier reasons
  and appending the malformed-payload hardening reason. Increase the total allowance
  only by the exact additional per-profile growth. Do not regenerate the documentary
  baseline.

```bash
node scripts/harden-sync-outbox-json.js
node scripts/test-sync-outbox-json-guard.js
node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js
node scripts/verify-flows-fn-parse.js
node scripts/flows-bare-require-scan.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-profile-parity.js
```

- [ ] **Step 6: Commit only Task 8 files.**

```bash
git commit --only scripts/harden-sync-outbox-json.js \
  scripts/test-sync-outbox-json-guard.js scripts/migrate-flows-journal-bootstrap.js \
  scripts/test-flows-wiring.js scripts/verify-flows-size-ratchet-allowances.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  -m "fix(sync): reject malformed outbox payloads"
```

---

### Task 9: Load journal flow helpers through `osi-lib`

**Files:**
- Modify: both profile copies of `osi-lib/index.js` and `osi-lib/index.test.js`
- Modify: `scripts/migrate-flows-journal-commands.js`
- Modify: `scripts/migrate-flows-journal-routes.js`
- Create: `scripts/migrate-flows-journal-helper-loading.js`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: both maintained `flows.json` files through the new one-shot script

**Interfaces:**
- Produces: loader names `osi-db-helper`, `osi-command-ledger`, and existing `osi-journal`; four journal nodes declare only `{ var: 'osiLib', module: 'osi-lib' }` and fail closed on unavailable helpers without hanging HTTP requests.

- [ ] **Step 1: Add failing loader and wiring tests.** Require the two new loader mappings and cached successful loads under `OSI_LIB_BASE`. Update flow expectations so dedupe, apply, ACK queue, and API router declare only `osiLib`, call `osiLib.require` for every dependency, inspect `.ok`, and emit `node.error` before their existing null/fall-through output on failure.

- [ ] **Step 2: Confirm red.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node scripts/test-flows-wiring.js
```

- [ ] **Step 3: Register loader mappings.** Add:

```js
'osi-db-helper': 'osi-db-helper',
'osi-command-ledger': 'osi-command-ledger',
```

to `NAME_TO_PATH`, then mirror `osi-lib` files.

- [ ] **Step 4: Define the fail-closed flow prelude and node-specific output.** Each generated function uses the dependencies it needs from this pattern:

```js
const dbLoad = osiLib.require('osi-db-helper');
const journalLoad = osiLib.require('osi-journal');
if (!dbLoad.ok || !journalLoad.ok) {
  const detail = [dbLoad, journalLoad].filter(function(load) { return !load.ok; })
    .map(function(load) { return load.error; }).join('; ');
  node.error('Journal helpers unavailable: ' + detail, msg);
  return NODE_SPECIFIC_FAILURE_OUTPUT;
}
const osiDb = dbLoad.value;
const osiJournal = journalLoad.value;
```

Dedupe loads DB, journal hooks, and command ledger and returns `[null, null]` on
loader failure. Apply loads DB and journal and returns `[null, null]`. ACK queue
loads DB and command ledger and returns `null`. API router loads DB and journal;
on loader failure it sets status 503 and payload
`{ error: 'journal_helpers_unavailable', message: detail }`, then returns `msg` so
the existing response node terminates the request. Add wiring simulations for all
four shapes, including the HTTP 503 response path.

- [ ] **Step 5: Update generators and apply an exact one-shot transformer.** Update both existing migration templates and their collision/idempotence checks. The new one-shot script performs the flow-safety checks from Global Constraints, pins exact current node hashes after Task 8, changes only the four nodes, and proves a second application is byte-identical.

- [ ] **Step 6: Record flow growth and verify green.** Set the
  `command-dedupe-dispatch` and `command-ack-queue-rest` node allowances to their
  exact post-change deltas from `origin/main`, retaining prior reasons and appending
  the helper-loader reason. Increase the total allowance only by Task 9's exact
  additional per-profile growth. The two new nodes must stay below the fixed
  4096-character ceiling and receive no node allowance.

```bash
node scripts/migrate-flows-journal-helper-loading.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node scripts/test-flows-wiring.js
node scripts/verify-helper-registration.js
node scripts/verify-sync-flow.js
node scripts/verify-flows-fn-parse.js
node scripts/flows-bare-require-scan.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-profile-parity.js
```

- [ ] **Step 7: Commit only Task 9 files.**

```bash
git commit --only \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.test.js \
  scripts/migrate-flows-journal-commands.js scripts/migrate-flows-journal-routes.js \
  scripts/migrate-flows-journal-helper-loading.js scripts/test-flows-wiring.js \
  scripts/verify-flows-size-ratchet-allowances.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  -m "refactor(journal): load flow helpers through osi-lib"
```

---

### Task 10: Correct current documentation and annotate history

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-field-journal-design.md`
- Modify: `docs/superpowers/specs/2026-07-12-field-journal-ux-addendum.md`
- Modify: `docs/superpowers/specs/2026-07-12-agroscope-open-field-layout-design.md`
- Modify: `docs/superpowers/prompts/field-journal-spec-review/consolidation.md`
- Modify: `docs/superpowers/plans/2026-07-12-field-journal-slice1.md`
- Modify: `docs/superpowers/prompts/field-journal-slice1-codex/prompt.md`
- Modify: `.superpowers/sdd/task-12-report.md`
- Modify: `.superpowers/sdd/task-14-report.md`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Produces: current documents consistently describe 0018-0021, 13 schema tables, plot-scoped settings, safe/lossless package members, full CSV hardening, and plot indexes; historical files carry dated supersession notes.

- [ ] **Step 1: Search and create the four deferred follow-ups.** Search open and
  closed issues for bootstrap advertisement extraction, command registry duplication,
  dynamic sync-outbox SQL verification, and canonical timestamp precision. Create a
  narrowly scoped issue only where no equivalent exists and record the four resulting
  issue URLs or existing equivalents for the documentation pass.

- [ ] **Step 2: Correct authoritative current documents.** Apply these exact decisions:

```text
- journal_products is the stored registry; composition-derived nutrient values are computed for display/export.
- journal_plot_settings is keyed by plot_uuid; no journal_zone_settings table exists.
- migrations 0018-0021 are the Slice 1 migration range.
- migration 0018 creates 13 tables; 0019 contains generated catalog data.
- package CSV is formula-neutralized; records.ndjson is the lossless typed member.
- plot-first duplicate, sticky, and time indexes are canonical; zone indexes remain legacy-compatible.
- option_dependencies is resolved, not pending.
```

Label the Agroscope diagram fence `text` and replace remaining authoritative “zone layout” phrasing with “plot layout”.

- [ ] **Step 3: Annotate historical artifacts without rewriting them.** Add a dated note near the top of the handover prompt, consolidation decision, and task 12/14 reports. State the original snapshot remains below, name the superseding current design or final correction report, and identify current migration/gate/layout facts. Do not alter the historical consultant report's Slice 1/Slice 3 recommendation.

- [ ] **Step 4: Record deferred follow-ups in the progress ledger.** Append completed hardening task/review ranges and the issue numbers found or created for bootstrap-helper extraction, command-registry consolidation, dynamic-SQL verifier coverage, and canonical timestamp v2.

- [ ] **Step 5: Run prose and consistency checks.**

```bash
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/superpowers/specs/2026-07-12-field-journal-design.md \
  docs/superpowers/specs/2026-07-12-field-journal-ux-addendum.md \
  docs/superpowers/specs/2026-07-12-agroscope-open-field-layout-design.md \
  docs/superpowers/prompts/field-journal-spec-review/consolidation.md \
  docs/superpowers/plans/2026-07-12-field-journal-slice1.md \
  docs/superpowers/prompts/field-journal-slice1-codex/prompt.md \
  .superpowers/sdd/task-12-report.md .superpowers/sdd/task-14-report.md
rg -n 'journal_zone_settings|generated 0010|nine tables exactly|pending review' \
  docs/superpowers/specs docs/superpowers/plans docs/superpowers/prompts
git diff --check
```

Expected: slop check passes; remaining old terms occur only inside clearly marked historical quotations where retention is intentional.

- [ ] **Step 6: Commit Task 10 documents and the previously staged progress ledger.** Confirm the cached progress diff is journal-only, then commit the listed files with:

```bash
git commit --only docs/superpowers/specs/2026-07-12-field-journal-design.md \
  docs/superpowers/specs/2026-07-12-field-journal-ux-addendum.md \
  docs/superpowers/specs/2026-07-12-agroscope-open-field-layout-design.md \
  docs/superpowers/prompts/field-journal-spec-review/consolidation.md \
  docs/superpowers/plans/2026-07-12-field-journal-slice1.md \
  docs/superpowers/prompts/field-journal-slice1-codex/prompt.md \
  .superpowers/sdd/task-12-report.md .superpowers/sdd/task-14-report.md \
  .superpowers/sdd/progress.md \
  -m "docs(journal): align Slice 1 contracts with shipped behavior"
```

---

### Task 11: Whole-branch verification and merge

**Files:**
- No repository file modifications are planned. A concrete verifier or review defect becomes a new scoped correction task before this closeout resumes.
- GitHub: PR 141 and non-duplicate follow-up issues.

**Interfaces:**
- Produces: task reviews approved, full local suite green, remote required checks green, PR merged with a merge commit, and verified `origin/main` containment.

- [ ] **Step 1: Run the full local gate from a clean task diff.** At minimum:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
node scripts/verify-sync-contract.js
node --test scripts/verify-sync-op-parity.test.js
node scripts/verify-sync-op-parity.js /home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java
node scripts/test-contract-schemas.js
node scripts/test-journal-schema.js
node scripts/test-journal-catalog-generator.js
node scripts/generate-journal-catalog.js --check
node scripts/test-journal-lifecycle.js
node scripts/test-journal-api.js
node scripts/test-journal-command-path.js
node scripts/test-journal-bootstrap.js
node scripts/test-osi-db-helper-read-snapshot.js
node scripts/test-sync-outbox-json-guard.js
node scripts/test-flows-wiring.js
node scripts/verify-helper-registration.js
node scripts/verify-flows-fn-parse.js
node scripts/flows-bare-require-scan.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node --no-warnings scripts/test-journal-perf-fixture.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Dispatch a fresh whole-branch reviewer.** Generate a review package from `git merge-base origin/main HEAD` to `HEAD`. Require separate spec-compliance and code-quality verdicts. Fix every Critical/Important finding in one correction wave and re-review until approved.

- [ ] **Step 3: Push and publish the adjudication.** Push the branch, post a concise PR comment grouping accepted fixes, rejected suggestions with contract evidence, and linked follow-ups. Re-fetch CodeRabbit/GitHub review state and address any new actionable comment.

- [ ] **Step 4: Monitor required checks to terminal success.** Poll `gh pr checks 141` without long blocking waits. For any failure, load `github:gh-fix-ci`, reproduce locally when possible, fix test-first, push, and restart this step. Confirm the checked SHA equals the pushed head.

- [ ] **Step 5: Merge and verify.** When the PR is mergeable, review-approved, and every required check is successful, merge with a merge commit:

```bash
gh pr merge 141 --merge
git fetch origin main
gh pr view 141 --json state,mergedAt,mergeCommit,url
pushed_head=$(git rev-parse HEAD)
git merge-base --is-ancestor "$pushed_head" origin/main
```

Expected: PR state `MERGED`, a non-null merge commit and timestamp, and ancestor check exit 0.
