'use strict';
// #759: after a ledger renumber the applied versions are not a contiguous
// prefix (a foreign line's 81 moves to main's 84 while 81 to 83 are still
// pending). The drift reference, the boot-owned pending set and the boot's
// "interrupted" test work on the applied SET, not on 1..max.
//
// Synthetic corpus: 0005 stands in for the moved migration; the "gateway"
// applies 1, 2, 5 (the old line), then 3 commits without its stamp (state R3
// of the trace) while 4 is still pending.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixtureWrite } = require('./helpers/migration-fixture');
const { cliRunner } = require('../runner-iface');
const { applyPending, isBootOwnedTriggerBodyDrift, appliedVersionSet } = require('../runner');
const { loadMigrationCorpus, materializeMigrations } = require('../migrations-loader');
const { successInsertSql } = require('../ledger');
const { pendingBootOwnedFingerprints } = require('../boot-owned-fingerprints');
const { appliedReferencePlan } = require('../../../scripts/baseline-existing-db');
const swap = require('../../../scripts/deploy-payload-swap');
const { snapshotSchema, compareSchemas, indexSqlShape } = require('../../../scripts/semantic-schema-compare');

const { properSubset } = swap;

const BOOT_OWNED = new Set(['trg_boot_owned']);

function corpusDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-renumber-'));
  const dir = path.join(root, 'm');
  fs.mkdirSync(dir);
  for (const [name, sql] of Object.entries(files)) fixtureWrite(path.join(dir, name), sql);
  return { root, dir };
}

const BASE_FILES = {
  '0001__base.sql': '-- risk: additive\n'
    + 'CREATE TABLE devices (deveui TEXT PRIMARY KEY, gateway_device_eui TEXT);\n'
    + 'CREATE TABLE zones (id INTEGER PRIMARY KEY);\n'
    + 'CREATE TRIGGER trg_boot_owned AFTER UPDATE ON devices BEGIN SELECT 1; END;\n',
  '0002__a.sql': '-- risk: additive\nALTER TABLE devices ADD COLUMN a TEXT;\n',
  '0003__t3.sql': '-- risk: additive\nCREATE TABLE t3 (x INTEGER);\n',
  '0004__t4.sql': '-- risk: additive\nCREATE TABLE t4 (x INTEGER);\n',
  '0005__moved.sql': '-- risk: additive\nCREATE INDEX idx_moved ON zones(id);\n',
};

// The gateway: <first> applied and stamped by the runner (the old line), then
// each of <unstamped> committed with its ledger row and no stamp.
async function gatewayDb(files, first, unstamped) {
  const { root, dir } = corpusDir(files);
  const corpus = loadMigrationCorpus(dir);
  const db = path.join(root, 'farming.db');
  const oldLine = materializeMigrations(path.join(root, 'old-line'), corpus.migrations
    .filter((m) => first.includes(m.version)).map((m) => ({ corpus, name: m.name })));
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: oldLine.dir, corpus: oldLine, appVersion: 'old-line', writersStopped: true });
  for (const v of unstamped) {
    const m = corpus.migrations.find((x) => x.version === v);
    await r.exec(`BEGIN IMMEDIATE;\n${m.sql}\n${successInsertSql({ version: m.version, name: m.name, checksum: m.checksum, appVersion: 'cut' })}\nCOMMIT;`);
  }
  return { r, dir, db };
}

async function appliedOf(r) {
  return appliedVersionSet(await r.all('SELECT version, status FROM schema_migrations'));
}

test('appliedReferencePlan: an in-order set is its own prefix; a renumbered set is prefix plus extras', () => {
  const entries = [1, 2, 3, 4, 5].map((version) => ({ version }));
  assert.deepEqual(appliedReferencePlan(entries, [1, 2, 3]), { versions: [1, 2, 3], prefixHead: 3, extras: [] });
  assert.deepEqual(appliedReferencePlan(entries, [5, 1, 3, 2]), { versions: [1, 2, 3, 5], prefixHead: 3, extras: [5] });
  assert.deepEqual(appliedReferencePlan(entries, new Set([1, 2, 5])), { versions: [1, 2, 5], prefixHead: 2, extras: [5] });
  assert.throws(() => appliedReferencePlan(entries, [1, 2, 9]), /9 has no migration file/);
  assert.throws(() => appliedReferencePlan(entries, [2, 3]), /no applied prefix/);
});

test('appliedVersionSet keeps only applied rows, ascending', () => {
  assert.deepEqual(appliedVersionSet([
    { version: 84, status: 'applied' }, { version: 81, status: 'applied' }, { version: 82, status: 'failed' }, { version: 80, status: 'applied' },
  ]), [80, 81, 84]);
  assert.deepEqual(appliedVersionSet([]), []);
});

test('R3 shape: the reference built from the applied set explains the unstamped commit; 1..max does not', async () => {
  const { r, dir } = await gatewayDb(BASE_FILES, [1, 2, 5], [3]);
  const applied = await appliedOf(r);
  assert.deepEqual(applied, [1, 2, 3, 5]);
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, applied, { bootOwnedTriggerNames: BOOT_OWNED }), true);
  // The pre-#759 reading (a head number, 1..5) includes 0004, never applied.
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, 5, { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

test('R3 shape plus a boot-owned trigger rewritten by the old boot: still explained', async () => {
  const { r, dir } = await gatewayDb(BASE_FILES, [1, 2, 5], [3]);
  await r.exec('DROP TRIGGER trg_boot_owned; CREATE TRIGGER trg_boot_owned AFTER UPDATE ON devices BEGIN   select 1; END;');
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), true);
});

test('R3 shape with a real out-of-band change: refused', async () => {
  const { r, dir } = await gatewayDb(BASE_FILES, [1, 2, 5], [3]);
  await r.exec('ALTER TABLE zones ADD COLUMN sneaky INTEGER;');
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

test('a database missing an applied migration\'s object: refused (the set must be exactly what ran)', async () => {
  const { r, dir } = await gatewayDb(BASE_FILES, [1, 2, 5], [3]);
  await r.exec('DROP INDEX idx_moved;');
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

test('an applied version absent from the corpus, or no applied prefix: refused', async () => {
  const { r, dir } = await gatewayDb(BASE_FILES, [1, 2, 5], [3]);
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, [1, 2, 3, 5, 9], { bootOwnedTriggerNames: BOOT_OWNED }), false);
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, [2, 3, 5], { bootOwnedTriggerNames: BOOT_OWNED }), false);
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, [], { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

test('an in-order set builds the same reference as before: 1..3 applied, 3 unstamped', async () => {
  const { r, dir } = await gatewayDb(BASE_FILES, [1, 2], [3]);
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), true);
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, 3, { bootOwnedTriggerNames: BOOT_OWNED }), true);
});

test('the memoized reference is per applied set: R3 and R5 shapes on one corpus each get their own', async () => {
  const files = { ...BASE_FILES, '0006__t6.sql': '-- risk: additive\nCREATE TABLE t6 (x INTEGER);\n' };
  const r3 = await gatewayDb(files, [1, 2, 6], [3]);
  // Same corpus bytes, same chain: the second gateway's set differs.
  const r5 = await gatewayDb(files, [1, 2, 6], [3, 4]);
  assert.equal(await isBootOwnedTriggerBodyDrift(r3.r, r3.dir, await appliedOf(r3.r), { bootOwnedTriggerNames: BOOT_OWNED }), true);
  // One corpus directory for every call, so one shared chain and one memo.
  assert.equal(await isBootOwnedTriggerBodyDrift(r5.r, r3.dir, await appliedOf(r5.r), { bootOwnedTriggerNames: BOOT_OWNED }), true);
  // Crossed: each set's reference must not explain the other database.
  assert.equal(await isBootOwnedTriggerBodyDrift(r3.r, r3.dir, await appliedOf(r5.r), { bootOwnedTriggerNames: BOOT_OWNED }), false);
  assert.equal(await isBootOwnedTriggerBodyDrift(r5.r, r3.dir, await appliedOf(r3.r), { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

test('two migrations adding columns to one table, applied out of version order: explained, as semantic-schema-compare matches columns by name', async () => {
  const files = {
    ...BASE_FILES,
    '0003__t3.sql': '-- risk: additive\nALTER TABLE zones ADD COLUMN b INTEGER;\n',
    '0005__moved.sql': '-- risk: additive\nALTER TABLE zones ADD COLUMN c INTEGER;\n',
  };
  const { r, dir } = await gatewayDb(files, [1, 2, 5], [3]);
  const columns = (await r.all('PRAGMA table_info(zones)')).map((c) => c.name);
  assert.deepEqual(columns, ['id', 'c', 'b'], 'the live database got 0005 before 0003');
  // The reference applies the extras in version order (b before c). The
  // comparator is the same one baseline-existing-db and the in-order grace
  // path use; it does not make column position part of the schema, so the
  // order the out-of-order migration ran in does not matter to the decision.
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), true);
  // A column the corpus never adds still refuses.
  await r.exec('ALTER TABLE zones ADD COLUMN d INTEGER;');
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

test('boot-owned pending set: the corpus minus the applied set, not the versions above the maximum', () => {
  const flows = [{ id: 'sync-init-fn', func: 'db.exec("DROP TRIGGER IF EXISTS trg_gap; DROP TRIGGER IF EXISTS trg_moved;")' }];
  const migrations = [
    { version: 1, sql: 'CREATE TABLE t (x);' },
    { version: 2, sql: 'CREATE TRIGGER trg_gap AFTER INSERT ON t BEGIN SELECT 2; END;' },
    { version: 3, sql: 'CREATE TRIGGER trg_moved AFTER INSERT ON t BEGIN SELECT 3; END;' },
  ];
  const bySet = pendingBootOwnedFingerprints({ flows, migrations, applied: [1, 3], current: new Map() });
  assert.deepEqual(bySet.map((o) => `${o.version} ${o.name}`), ['2 trg_gap']);
  // The older head form stays available and means 1..head.
  assert.deepEqual(pendingBootOwnedFingerprints({ flows, migrations, appliedHead: 1, current: new Map() })
    .map((o) => o.version), [2, 3]);
  assert.deepEqual(pendingBootOwnedFingerprints({ flows, migrations, appliedHead: 3, current: new Map() }), []);
});

test('boot decision ledger relation: a proper subset by version and checksum', () => {
  assert.equal(properSubset('1:a,2:b', '1:a,2:b,3:c'), true, 'an in-order prefix');
  assert.equal(properSubset('1:a,2:b,5:e', '1:a,2:b,3:c,5:e'), true, 'a renumbered ledger filling its gap');
  assert.equal(properSubset('', '1:a'), true);
  assert.equal(properSubset('1:a,2:b', '1:a,2:b'), false, 'equal is not proper');
  assert.equal(properSubset('1:a,2:x', '1:a,2:b,3:c'), false, 'a checksum differs');
  assert.equal(properSubset('1:a,3:c', '1:a,2:b'), false);
  assert.equal(properSubset('1:a,2:b,3:c', '1:a,2:b'), false);
});

test('memo key: the same prefix with different extras gets its own reference ({1,2,3,5} vs {1,2,3,6})', async () => {
  const files = { ...BASE_FILES, '0006__t6.sql': '-- risk: additive\nCREATE TABLE t6 (x INTEGER);\n' };
  const a = await gatewayDb(files, [1, 2, 5], [3]);
  const b = await gatewayDb(files, [1, 2, 6], [3]);
  // One corpus directory for every call, so one shared chain and one memo.
  assert.equal(await isBootOwnedTriggerBodyDrift(a.r, a.dir, [1, 2, 3, 5], { bootOwnedTriggerNames: BOOT_OWNED }), true);
  assert.equal(await isBootOwnedTriggerBodyDrift(b.r, a.dir, [1, 2, 3, 6], { bootOwnedTriggerNames: BOOT_OWNED }), true);
  assert.equal(await isBootOwnedTriggerBodyDrift(b.r, a.dir, [1, 2, 3, 5], { bootOwnedTriggerNames: BOOT_OWNED }), false);
  assert.equal(await isBootOwnedTriggerBodyDrift(a.r, a.dir, [1, 2, 3, 6], { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

// Review of #762, P2-1: the moved migration and a gap migration create the
// same index name with different predicates. The gateway ran 5 (partial)
// before 3 (full, IF NOT EXISTS: a no-op); the version-order reference runs 3
// then 5 and gets the full index. Both must fail closed.
const ORDER_FILES = {
  ...BASE_FILES,
  '0001__base.sql': BASE_FILES['0001__base.sql'] + 'ALTER TABLE zones ADD COLUMN k TEXT;\n',
  '0003__t3.sql': '-- risk: additive\nCREATE INDEX IF NOT EXISTS idx_z ON zones(k);\n',
  '0005__moved.sql': '-- risk: additive\nCREATE INDEX IF NOT EXISTS idx_z ON zones(k) WHERE k IS NOT NULL;\n',
};

test('P2-1 counterexample: an out-of-order migration and a lower one name the same index: refused, with the reason', async () => {
  const { r, dir } = await gatewayDb(ORDER_FILES, [1, 2, 5], [3]);
  const live = await r.all("SELECT sql FROM sqlite_master WHERE name='idx_z'");
  assert.match(live[0].sql, /WHERE k IS NOT NULL/, 'the live index is the partial one the gateway created first');
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), false);
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => /applied migration 5 ran out of version order and touches index idx_z, as migration 3 does/.test(l)), logged.join('\n'));
});

test('P2-1: the comparator sees a partial index predicate, collation, direction and expression', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-index-shape-'));
  const snap = async (name, ddl) => {
    const r = cliRunner(path.join(root, `${name}.db`));
    await r.exec(`CREATE TABLE zones (id INTEGER PRIMARY KEY, k TEXT, j INTEGER);\n${ddl}`);
    return snapshotSchema(r);
  };
  const base = await snap('base', 'CREATE INDEX idx_z ON zones(k);');
  for (const [name, ddl] of [
    ['partial', 'CREATE INDEX idx_z ON zones(k) WHERE k IS NOT NULL;'],
    ['collate', 'CREATE INDEX idx_z ON zones(k COLLATE NOCASE);'],
    ['desc', 'CREATE INDEX idx_z ON zones(k DESC);'],
    ['expr', 'CREATE INDEX idx_z ON zones(lower(k));'],
    ['order', 'CREATE INDEX idx_z ON zones(k, j);'],
  ]) {
    const other = await snap(name, ddl);
    const res = compareSchemas(other, base);
    assert.equal(res.ok, false, name);
    assert.ok(res.diffs.some((d) => d.kind === 'index' && d.class === 'changed'), name);
  }
  const swapped = compareSchemas(await snap('kj', 'CREATE INDEX idx_z ON zones(k, j);'), await snap('jk', 'CREATE INDEX idx_z ON zones(j, k);'));
  assert.equal(swapped.ok, false, 'key column order');
  // Formatting alone (quoting, spacing, case, an explicit ASC) still compares equal.
  const same = compareSchemas(await snap('fmt', 'create index "idx_z" on "zones" ( K asc ) ;'), base);
  assert.equal(same.ok, true, JSON.stringify(same.diffs));
  assert.deepEqual(indexSqlShape("CREATE INDEX i ON t(a, lower(b)) WHERE c = '(x'"), { columns: 'a,lower(b)', where: "c='(x'" });
});

test('P2-1, in order: an out-of-band change of a partial index predicate is refused', async () => {
  const { r, dir } = await gatewayDb(ORDER_FILES, [1, 2], [3]);
  await r.exec('DROP INDEX idx_z; CREATE INDEX idx_z ON zones(k) WHERE k IS NOT NULL;');
  assert.equal(await isBootOwnedTriggerBodyDrift(r, dir, await appliedOf(r), { bootOwnedTriggerNames: BOOT_OWNED }), false);
});

test('migrationObjectNames: created, dropped and altered objects, not names read inside a body or a literal', () => {
  const { migrationObjectNames } = require('../../../scripts/baseline-existing-db');
  const names = migrationObjectNames("-- CREATE TABLE commented\nCREATE INDEX IF NOT EXISTS idx_z ON zones(k);\nALTER TABLE zones ADD COLUMN b INTEGER;\nALTER TABLE t RENAME TO u;\nDROP TRIGGER IF EXISTS \"trg_a\";\nCREATE TRIGGER trg_b AFTER INSERT ON zones BEGIN INSERT INTO q VALUES ('CREATE TABLE x'); END;");
  assert.deepEqual([...names].sort(), ['column zones.b', 'index idx_z', 'table t', 'table u', 'trigger trg_a', 'trigger trg_b']);
});

function stagePayload(root, stamp) {
  const flows = path.join(root, `flows-${stamp}.json`);
  const gui = path.join(root, `gui-${stamp}`);
  fs.writeFileSync(flows, JSON.stringify([{ id: 'x', stamp }]));
  fs.mkdirSync(gui);
  fs.writeFileSync(path.join(gui, 'index.html'), `<title>${stamp}</title>\n`);
  swap.stagePayload(root, stamp, flows, gui, 'staged');
}

test('boot without a pending-switch record: a database ahead of the active payload as a set holds', () => {
  // Removed at the end: the payload links are symlinks, which a test
  // harness's evidence retention refuses to keep.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-boot-norecord-'));
  try {
    const guiRoot = path.join(root, 'gui');
    fs.mkdirSync(path.join(root, 'payloads'));
    stagePayload(root, 'old');
    swap.writeCompatibility(root, 'old', '4', '1:a,2:b,4:d');
    swap.flipTo(root, 'old', guiRoot);
    swap.markHealthy(root, 'old');
    swap.writePayloadState(root, 'old', 'healthy', 'fixture');
    const line = swap.bootSchemaDecision(root, guiRoot, '4', '1:a,2:b,3:c,4:d', '');
    assert.match(String(line), /^HELD: .*no readable pending-switch record proves the retry can finish/);
    assert.equal(swap.readPayloadState(root).state, 'held');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
