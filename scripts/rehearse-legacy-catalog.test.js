'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rehearse, functionText, retiredFunction } = require('./rehearse-legacy-catalog');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { buildFixture } = require('./fixtures/legacy-devices-catalog');
const ROOT = path.resolve(__dirname, '..');
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function withFixture(shape, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-repair-'));
  try {
    const file = path.join(dir, 'farm.db');
    const db = new DatabaseSync(file);
    try { buildFixture(db, shape); } finally { db.close(); }
    return await fn(file, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('option B deploy preflight refuses populated dangling FKs before checkpoint and changes nothing', async () => {
  await withFixture('quoted', async file => {
    const deploy = process.env.EB19_DEPLOY_REF
      ? execFileSync('git', ['show', `${process.env.EB19_DEPLOY_REF}:deploy.sh`], { cwd: ROOT, encoding: 'utf8' })
      : fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    const fn = name => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(deploy)[0];
    const before = digest(file);
    const result = spawnSync('sh', ['-c', `${fn('check_live_db_readonly')}\nDB_PATH="$1"\ncheck_live_db_readonly`, 'check', file], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'the existing integrity-only probe incorrectly accepts this populated catalog');
    assert.match(result.stderr, /repair-legacy-device-fk\.js/);
    assert.match(result.stderr, /repair\.md#legacy-device-foreign-key-repair/);
    assert.equal(digest(file), before);
  });
});

// These characterize the unsafe base and reject deletion alone. They do not
// claim that a migration or runtime fix has shipped. See the EB19 stop report.
function assertPreserved(r) {
  assert.equal(r.rowsPreserved, true, JSON.stringify(r));
  assert.ok(r.children.length >= 13, 'all direct devices FK children must have witnesses');
  for (const [table, counts] of Object.entries(r.counts)) {
    assert.deepEqual(counts, [2, 2], `${table}: every row and column must survive`);
  }
  assert.equal(r.exitPragmas.foreign_keys, 1, 'check the same connection, before close');
  assert.equal(r.exitPragmas.legacy_alter_table, 0);
  assert.deepEqual(r.integrityCheck, [{ integrity_check: 'ok' }]);
}

test('both profiles carry the same function and the candidate removes only surgery and silent catches', () => {
  assert.equal(functionText(0), functionText(1));
  const candidate = retiredFunction(functionText());
  assert.doesNotMatch(candidate, /writable_schema|UPDATE sqlite_master|PRAGMA schema_version=/);
  assert.doesNotMatch(candidate, /catch \(_\) \{\}/);
  assert.ok(candidate.length <= functionText().length, 'the handoff must never grow sync-init-fn');
  assert.equal(retiredFunction(candidate), candidate, 'the suite must survive applying the handoff');
  assert.doesNotThrow(() => new Function('osiDb', 'env', 'node', 'msg', candidate));
});

test('healthy populated catalog: both full boot variants preserve all device children', async () => {
  for (const mode of ['legacy', 'retired']) {
    const r = await rehearse({ shape: 'healthy', mode, wholeBoot: true });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, true, JSON.stringify(r));
    assert.equal(r.writeProbe.ok, true);
    assert.deepEqual(r.catalogWrites, []);
  }
});

for (const shape of ['quoted', 'unquoted']) {
  test(`${shape}: legacy surgery repairs populated FKs but changes sealed table fingerprints`, async () => {
    const r = await rehearse({ shape });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, true, JSON.stringify(r));
    assert.ok(r.matched.length >= 13);
    assert.deepEqual(r.pending, []);
    assert.equal(r.fingerprintsChanged, true);
    assert.equal(r.catalogWrites.length, 4);
    assert.equal(r.exitPragmas.schema_version, r.beforePragmas.schema_version + 1);
  });
  test(`${shape}: retirement alone leaves every populated child FK broken after full boot`, async () => {
    const r = await rehearse({ shape, mode: 'retired', wholeBoot: true });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, false);
    assert.match(r.writeProbe.error, /devices_old/);
    assert.ok(r.foreignKeyCheck.error || r.foreignKeyCheck.rows.length >= 26, JSON.stringify(r));
    assert.deepEqual(r.catalogWrites, []);
    assert.deepEqual(r.pending, r.matched);
  });
}

for (const shape of ['bracketed', 'lowercase']) {
  test(`${shape}: LIKE probe fires but the literal REPLACE does not repair valid SQL spellings`, async () => {
    const r = await rehearse({ shape });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, false);
    assert.deepEqual(r.pending, r.matched);
    assert.ok(r.warnings.some(w => /Self-healed/.test(w)), 'the success warning is misleading');
    assert.equal(r.fingerprintsChanged, false);
    assert.equal(r.exitPragmas.schema_version, r.beforePragmas.schema_version + 1);
  });
}

test('broad text matching also mutates a DEFAULT literal unrelated to any FK', async () => {
  const r = await rehearse({ shape: 'literal-only' });
  assert.equal(r.rowsPreserved, true, 'existing stored values survive, but future defaults change');
  assert.deepEqual(r.matched, ['legacy_note']);
  assert.equal(r.fingerprintsChanged, true);
  assert.match(r.legacyNoteDdl, /DEFAULT 'REFERENCES devices'/);
  assert.equal(r.exitPragmas.foreign_keys, 1);
});

test('actual unfenced historical rename produces populated damage; surgery leaves trigger references behind', async () => {
  const r = await rehearse({ shape: 'rename-damage' });
  assertPreserved(r);
  assert.ok(r.matched.length >= 13);
  assert.deepEqual(r.pending, []);
  assert.equal(r.fingerprintsChanged, true);
  assert.ok(r.triggerRefsBefore.length > 0);
  assert.deepEqual(r.triggerRefsAfter, r.triggerRefsBefore, 'table surgery does not repair trigger bodies');
});

for (const fault of ['catalog-update', 'schema-bump']) {
  test(`legacy surgery ${fault} failure is visible but has no atomic rollback/finally fence`, async () => {
    const r = await rehearse({ fault });
    assertPreserved(r);
    assert.ok(r.warnings.some(w => w.includes(`injected ${fault}`)));
    if (fault === 'catalog-update') {
      assert.equal(r.exitPragmas.writable_schema, 1, 'existing safety defect: OFF is skipped on error');
      assert.deepEqual(r.pending, r.matched);
      assert.equal(r.dataAndFkChecksPassed, false);
    } else {
      assert.equal(r.exitPragmas.writable_schema, 0);
      assert.equal(r.fingerprintsChanged, true, 'the catalog UPDATE already committed');
      assert.equal(r.exitPragmas.schema_version, r.beforePragmas.schema_version);
    }
  });
}

for (const fault of [null, 'legacy-on', 'transaction-open', 'copy', 'rename', 'before-commit']) {
  test(`full boot retirement candidate: FK restored after rebuild ${fault || 'success'}`, async () => {
    const r = await rehearse({ shape: 'rebuild', mode: 'retired', wholeBoot: true, fault });
    assertPreserved(r);
    assert.equal(r.exitPragmas.writable_schema, 0);
    assert.deepEqual(r.foreignKeyCheck, { rows: [], error: null });
    if (fault) assert.ok(r.errors.some(e => /rebuild ABORTED/.test(e)), JSON.stringify(r));
    else assert.equal(r.dataAndFkChecksPassed, true, JSON.stringify(r));
  });
}

const tool = () => require('./repair-legacy-device-fk');
const options = (file, dir) => ({ dbPath: file, apply: true, writersStopped: true, backupDir: path.join(dir, 'backups') });
for (const shape of ['quoted', 'unquoted', 'bracketed', 'lowercase']) {
  test(`option B ${shape}: report is immutable; apply preserves every table, then retired boot works on both profiles`, async () => {
    await withFixture(shape, async (file, dir) => {
      const before = digest(file);
      const report = await tool().repair({ dbPath: file });
      assert.equal(report.needed, true);
      assert.equal(report.tables.length, 13);
      assert.equal(report.fieldCount, 'unknown');
      assert.equal(digest(file), before);
      assert.deepEqual(fs.readdirSync(dir), ['farm.db'], 'report creates no artifacts beside the source');
      const repaired = await tool().repair(options(file, dir));
      assert.equal(repaired.applied, true);
      assert.equal(digest(repaired.original), before);
      assert.equal(digest(repaired.backup), before);
      const db = new DatabaseSync(file);
      try {
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(db.prepare("SELECT count(*) n FROM device_data").get().n, 2);
        assert.doesNotThrow(() => db.exec("INSERT INTO device_data(deveui,recorded_at) VALUES ('FFFF000000000001','2026-02-01')"));
      } finally { db.close(); }
      for (const profile of [0, 1]) {
        const { makeFacadeShim } = require('./rehearse-devices-rebuild');
        const shim = makeFacadeShim(file);
        const errors = [];
        await new Function('osiDb','env','node','msg', retiredFunction(functionText(profile)))(
          { Database: function () { return shim; } }, { get: () => '' },
          { error: e => errors.push(e), warn() {}, log() {}, status() {} }, {});
        assert.deepEqual(errors, []);
      }
      assert.equal((await tool().repair({ dbPath: file })).needed, false);
    });
  });
}

test('option B healthy catalog passes deploy preflight and both profile boot functions', async () => {
  await withFixture('healthy', async file => {
    const before = digest(file);
    assert.equal((await tool().repair({ dbPath: file })).needed, false);
    const { assertNoLegacyDeviceCatalog } = require('../lib/osi-migrate/legacy-device-catalog');
    const db = new DatabaseSync(file);
    try { await assertNoLegacyDeviceCatalog({ all: async sql => db.prepare(sql).all() }); }
    finally { db.close(); }
    assert.equal(digest(file), before);
    const deploy = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    const check = /^check_live_db_readonly\(\) \{\n[\s\S]*?\n\}\n/m.exec(deploy)[0];
    const r = spawnSync('sh', ['-c', `${check}\nDB_PATH="$1"\ncheck_live_db_readonly`, 'healthy', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(digest(file), before);
    for (const profile of [0, 1]) {
      const { makeFacadeShim } = require('./rehearse-devices-rebuild');
      const shim = makeFacadeShim(file), errors = [];
      await new Function('osiDb','env','node','msg', retiredFunction(functionText(profile)))(
        { Database: function () { return shim; } }, { get: () => '' },
        { error: e => errors.push(e), warn() {}, log() {}, status() {} }, {});
      assert.deepEqual(errors, []);
    }
  });
});

for (const shape of ['rename-damage', 'literal-only']) {
  test(`option B refuses unproven ${shape} catalog without source changes or backup`, async () => {
    await withFixture(shape, async (file, dir) => {
      const before = digest(file);
      await assert.rejects(tool().repair(options(file, dir)), /unknown|divergent|unproven/);
      assert.equal(digest(file), before);
      assert.deepEqual(fs.readdirSync(dir), ['farm.db']);
    });
  });
}

test('option B refuses unknown columns, surviving old parent, live handles, absent assertion, and sidecars', async () => {
  for (const kind of ['column', 'old-parent', 'handle', 'assertion', 'sidecar']) {
    await withFixture('quoted', async (file, dir) => {
      let open;
      if (kind === 'column' || kind === 'old-parent') {
        const db = new DatabaseSync(file);
        try {
          db.exec(kind === 'column' ? 'ALTER TABLE device_data ADD COLUMN future_value TEXT' : 'CREATE TABLE devices_old AS SELECT * FROM devices');
        } finally { db.close(); }
      }
      if (kind === 'handle') open = new DatabaseSync(file);
      if (kind === 'sidecar') fs.writeFileSync(file + '-wal', 'retained evidence');
      const before = digest(file);
      try {
        await assert.rejects(tool().repair({ ...options(file, dir), writersStopped: kind !== 'assertion' }), /unknown|divergent|surviving|handle|writers-stopped|sidecar/);
        assert.equal(digest(file), before);
        assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
      } finally { if (open) open.close(); }
    });
  }
});

for (const phase of ['child-copied', 'before-commit', 'verified', 'prepared', 'published', 'before-unlock']) {
  test(`option B SIGKILL at ${phase} keeps the original, and only verified copies can occupy the DB path`, async () => {
    await withFixture('quoted', async (file, dir) => {
      const before = digest(file);
      const script = `const {repair}=require(process.argv[1]);repair({dbPath:process.argv[2],apply:true,writersStopped:true,backupDir:process.argv[3],checkpoint:async p=>{if(p===process.argv[4])process.kill(process.pid,'SIGKILL')}}).catch(e=>{console.error(e);process.exitCode=1})`;
      const r = spawnSync(process.execPath, ['-e', script, path.join(ROOT, 'scripts/repair-legacy-device-fk.js'), file, path.join(dir, 'backups'), phase], { encoding: 'utf8' });
      assert.equal(r.signal, 'SIGKILL', r.stdout + r.stderr);
      assert.ok(fs.existsSync(file + '.legacy-device-fk-repair.lock'));
      if (!['published', 'before-unlock'].includes(phase)) assert.equal(digest(file), before);
      else {
        const stage = fs.readFileSync(path.join(file + '.legacy-device-fk-repair.lock', 'stage'), 'utf8').trim();
        assert.equal(digest(path.join(stage, 'original.db')), before);
        const db = new DatabaseSync(file);
        try { assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); }
        finally { db.close(); }
      }
      await assert.rejects(tool().repair(options(file, dir)), /multiply-linked|EEXIST/);
    });
  });
}

for (const phase of ['child-copied', 'before-commit', 'verified', 'prepared', 'published']) {
  test(`option B caught ${phase} error preserves the original DB bytes`, async () => {
    await withFixture('quoted', async (file, dir) => {
      const before = digest(file);
      let flags;
      await assert.rejects(tool().repair({ ...options(file, dir), checkpoint: async (p, state) => {
        if (p === 'fence-restored') flags = state;
        if (p === phase) throw new Error('injected failure');
      } }), /injected failure/);
      assert.equal(digest(file), before);
      assert.deepEqual(flags, { foreignKeys: 1, legacyAlterTable: 0 }, 'inspect the same connection on the error exit');
    });
  });
}

for (const kind of ['table', 'trigger', 'index']) {
  test(`option B ${kind}: migration and verify preflights refuse before ledger creation and preserve bytes`, async () => {
    await withFixture(kind === 'table' ? 'quoted' : 'healthy', async file => {
      if (kind !== 'table') {
        const db = new DatabaseSync(file);
        try {
          db.exec(kind === 'trigger'
            ? 'CREATE TRIGGER legacy_ref AFTER INSERT ON device_data BEGIN SELECT count(*) FROM devices_old; END'
            : "CREATE INDEX legacy_ref ON device_data(recorded_at) WHERE recorded_at <> 'devices_old'");
        } finally { db.close(); }
      }
      const before = digest(file);
      const { cliRunner } = require('../lib/osi-migrate/runner-iface');
      const { applyPending, verifyHead } = require('../lib/osi-migrate');
      const migrationsDir = path.join(ROOT, 'database/migrations/ordered');
      for (const fn of [applyPending, verifyHead]) {
        await assert.rejects(fn(cliRunner(file), { migrationsDir, writersStopped: true }), /repair-legacy-device-fk\.js.*repair\.md#legacy-device-foreign-key-repair/);
        assert.equal(digest(file), before);
      }
    });
  });
}

test('option B preserves 64-bit rowids and AUTOINCREMENT high-water values above the surviving rows', async () => {
  await withFixture('quoted', async (file, dir) => {
    let db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA foreign_keys=OFF; UPDATE device_data SET id=9223372036854775700 WHERE id=2; UPDATE sqlite_sequence SET seq=9223372036854775800 WHERE name='device_data'");
    } finally { db.close(); }
    await tool().repair(options(file, dir));
    db = new DatabaseSync(file);
    try {
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='device_data'"); seq.setReadBigInts(true);
      assert.equal(seq.get().seq, 9223372036854775800n);
      const ids = db.prepare('SELECT id FROM device_data ORDER BY id'); ids.setReadBigInts(true);
      assert.deepEqual(ids.all().map(r => r.id), [1n, 9223372036854775700n]);
    } finally { db.close(); }
  });
});

test('option B source changes and candidate changes before publication are detected without overwriting the source', async () => {
  for (const changed of ['source', 'candidate']) await withFixture('quoted', async (file, dir) => {
    let expected = digest(file);
    await assert.rejects(tool().repair({ ...options(file, dir), checkpoint: async phase => {
      if (phase !== 'verified') return;
      let target = file;
      if (changed === 'candidate') {
        const stage = fs.readFileSync(path.join(file + '.legacy-device-fk-repair.lock', 'stage'), 'utf8').trim();
        target = path.join(stage, 'candidate.db');
      }
      const db = new DatabaseSync(target);
      try { db.exec("PRAGMA foreign_keys=OFF; UPDATE device_data SET swt_1=123.125 WHERE id=1"); }
      finally { db.close(); }
      if (changed === 'source') expected = digest(file);
    } }), /source changed|candidate changed/);
    assert.equal(digest(file), expected);
  });
});

test('option B refreshes fingerprints on the proven copy and preserves all migration ledger rows', async () => {
  await withFixture('quoted', async (file, dir) => {
    const { ensureLedger } = require('../lib/osi-migrate/ledger');
    const { syncFingerprints, verifyHead } = require('../lib/osi-migrate/runner');
    const { loadMigrationCorpus } = require('../lib/osi-migrate/migrations-loader');
    const migrationsDir = path.join(ROOT, 'database/migrations/ordered');
    let db = new DatabaseSync(file);
    try {
      await ensureLedger({ exec: async sql => db.exec(sql) });
      const insert = db.prepare("INSERT INTO schema_migrations(version,name,checksum,status) VALUES (?,?,?,'applied')");
      for (const m of loadMigrationCorpus(migrationsDir).migrations) insert.run(m.version, m.name, m.checksum);
      await syncFingerprints({ all: async sql => db.prepare(sql).all(), exec: async sql => db.exec(sql) });
    } finally { db.close(); }
    await tool().repair(options(file, dir));
    const { cliRunner } = require('../lib/osi-migrate/runner-iface');
    assert.deepEqual(await verifyHead(cliRunner(file), { migrationsDir }), { ok: true });
  });
});

test('option B CLI report is read-only and apply requires an explicit stopped-writers assertion', async () => {
  await withFixture('quoted', async (file, dir) => {
    const script = path.join(ROOT, 'scripts/repair-legacy-device-fk.js');
    const before = digest(file);
    const report = spawnSync(process.execPath, [script, file, '--report'], { encoding: 'utf8' });
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout).needed, true);
    assert.equal(digest(file), before);
    const refused = spawnSync(process.execPath, [script, file, '--apply', '--backup-dir', path.join(dir, 'backups')], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--writers-stopped/);
    assert.equal(digest(file), before);
    const applied = spawnSync(process.execPath, [script, file, '--apply', '--writers-stopped', '--backup-dir', path.join(dir, 'backups')], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).applied, true);
  });
});

test('option B read-only migration refusal preserves committed WAL bytes before any checkpoint', async () => {
  await withFixture('quoted', async (file, dir) => {
    const copy = path.join(dir, 'wal-copy.db');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=OFF; UPDATE device_data SET swt_1=29.125 WHERE id=1');
      fs.copyFileSync(file, copy); fs.copyFileSync(file + '-wal', copy + '-wal');
    } finally { db.close(); }
    const before = [digest(copy), digest(copy + '-wal')];
    const { applyPending } = require('../lib/osi-migrate');
    const { cliRunner } = require('../lib/osi-migrate/runner-iface');
    await assert.rejects(applyPending(cliRunner(copy), { migrationsDir: path.join(ROOT, 'database/migrations/ordered'), writersStopped: true }), /Legacy devices_old/);
    assert.deepEqual([digest(copy), digest(copy + '-wal')], before);
  });
});

test('option B deploy uses the shared catalog predicate and refuses before stop, pruning and payload mutation', () => {
  const { LEGACY_CATALOG_SQL } = require('../lib/osi-migrate/legacy-device-catalog');
  const deploy = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  assert.ok(deploy.includes(LEGACY_CATALOG_SQL), 'shell and runner must detect the same objects');
  const start = deploy.indexOf('\nrun_schema_migration() {');
  const guard = deploy.indexOf('if ! check_live_db_readonly; then', start);
  assert.ok(guard > start && guard < deploy.indexOf('if ! fetch_migration_runner;', start));
  const early = deploy.indexOf('\ncheck_live_db_readonly || exit 1\n');
  assert.ok(early > 0 && early < deploy.indexOf('cp "$SWAP_JS" /srv/node-red/.payload-swap.js.tmp'));
});

test('option B repairs a proven trigger-only legacy reference without rebuilding healthy child tables', async () => {
  await withFixture('healthy', async (file, dir) => {
    const db = new DatabaseSync(file);
    try {
      const trigger = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%FROM devices%' ORDER BY name LIMIT 1").get();
      assert.ok(trigger, 'the real seed must provide the trigger witness');
      const damaged = trigger.sql.replace(/\bFROM devices\b/g, 'FROM "devices_old"');
      assert.notEqual(damaged, trigger.sql);
      db.exec('DROP TRIGGER "' + trigger.name.replace(/"/g, '""') + '"');
      db.exec(damaged);
    } finally { db.close(); }
    const report = await tool().repair({ dbPath: file });
    assert.equal(report.needed, true);
    assert.deepEqual(report.tables, []);
    const repaired = await tool().repair(options(file, dir));
    assert.equal(repaired.applied, true);
    assert.deepEqual(repaired.tables, []);
    assert.equal((await tool().repair({ dbPath: file })).needed, false);
  });
});

test('option B post-commit cleanup failure keeps the verified replacement and retained original', async () => {
  await withFixture('quoted', async (file, dir) => {
    const before = digest(file);
    await assert.rejects(tool().repair({ ...options(file, dir), checkpoint: async phase => {
      if (phase === 'before-unlock') throw new Error('injected cleanup failure');
    } }), /Verified repair is published; cleanup is incomplete/);
    const stage = fs.readFileSync(path.join(file + '.legacy-device-fk-repair.lock', 'stage'), 'utf8').trim();
    const receipt = JSON.parse(fs.readFileSync(path.join(stage, 'receipt.json'), 'utf8'));
    assert.equal(receipt.phase, 'published');
    assert.equal(digest(path.join(stage, 'original.db')), before);
    assert.equal(digest(file), receipt.candidateSha256);
    const db = new DatabaseSync(file);
    try { assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); }
    finally { db.close(); }
  });
});

test('option B rejects replacement of the verified staging inode even with identical bytes', async () => {
  await withFixture('quoted', async (file, dir) => {
    const before = digest(file);
    await assert.rejects(tool().repair({ ...options(file, dir), checkpoint: async phase => {
      if (phase !== 'prepared') return;
      const stage = fs.readFileSync(path.join(file + '.legacy-device-fk-repair.lock', 'stage'), 'utf8').trim();
      const candidate = path.join(stage, 'candidate.db');
      fs.copyFileSync(candidate, candidate + '.replacement');
      fs.renameSync(candidate + '.replacement', candidate);
    } }), /candidate changed before atomic swap/);
    assert.equal(digest(file), before);
  });
});

test('option B named-service gate accepts stopped services and refuses running or unknown procd state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-procd-'));
  try {
    // Simulated gateway path and fixture ubus executable; no gateway is opened.
    fs.writeFileSync(path.join(dir, 'ubus'), '#!/bin/sh\nprintf "%s\\n" "$EB19_PROCD_FIXTURE"\n', { mode: 0o700 });
    const gatewayRoot = require('./fixtures/legacy-device-gateway').makeGateway(path.join(dir, 'gateway'));
    require('./lib/legacy-device-repair-ops').prepareOffline({ root: gatewayRoot });
    const cases = [
      [{}, true],
      [{ 'node-red': { instances: {} }, 'osi-identityd': { instances: { main: { running: false } } } }, true],
      [{ 'node-red': { instances: { main: { running: true } } } }, false],
      [{ 'node-red': { instances: {} }, 'osi-identityd': { instances: { main: { running: true } } } }, false],
      [{ 'node-red': { instances: { main: {} } } }, false],
      [{ 'node-red': { instances: [] } }, false],
      [{ 'node-red': {} }, false],
      [[], false],
    ];
    for (const [state, accepted] of cases) {
      const r = spawnSync(process.execPath, ['-e', "require(process.argv[1]).assertGatewayStopped(process.argv[3],process.argv[2])", path.join(ROOT, 'scripts/repair-legacy-device-fk.js'), gatewayRoot, path.join(gatewayRoot, 'data/db/farming.db')], {
        encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, EB19_PROCD_FIXTURE: JSON.stringify(state) },
      });
      assert.equal(r.status === 0, accepted, JSON.stringify(state) + ': ' + r.stderr);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ['trigger', 'index']) {
  test(`Sol review sqliteX ${kind}: refuse unknown object without losing it or source bytes`, async () => {
    await withFixture('quoted', async (file, dir) => {
      const db = new DatabaseSync(file);
      const sql = kind === 'trigger'
        ? 'CREATE TRIGGER sqliteX_audit AFTER INSERT ON device_data BEGIN SELECT 1; END'
        : 'CREATE INDEX sqliteX_audit ON device_data(recorded_at)';
      db.exec(sql); db.close();
      const before = digest(file);
      await assert.rejects(tool().repair(options(file, dir)), /unknown or divergent catalog object/);
      assert.equal(digest(file), before);
      const after = new DatabaseSync(file);
      try { assert.equal(after.prepare("SELECT count(*) n FROM sqlite_master WHERE name='sqliteX_audit'").get().n, 1); }
      finally { after.close(); }
    });
  });
}
function shellFunction(name) {
  const source = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  return new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(source)[0];
}
for (const kind of ['partial-healing-view', 'benign-substring', 'benign-unicode-substring', 'benign-dollar-substring']) {
  test(`Sol review shared preflight ${kind} is consistent in library and deploy shell`, async () => {
    await withFixture('healthy', async (file, dir) => {
      if (kind === 'partial-healing-view') file = path.join(dir, 'historical-view.db');
      const db = new DatabaseSync(file);
      if (kind === 'partial-healing-view') {
        db.exec('CREATE TABLE devices(id INTEGER PRIMARY KEY); CREATE TABLE child(device_id INTEGER REFERENCES devices(id)); CREATE VIEW retained_device_history AS SELECT * FROM devices; INSERT INTO devices VALUES(1),(2); INSERT INTO child VALUES(1),(2)');
        db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=OFF; ALTER TABLE devices RENAME TO devices_old; CREATE TABLE devices(id INTEGER PRIMARY KEY); INSERT INTO devices SELECT * FROM devices_old; DROP TABLE devices_old');
        // Partial old-healer run: the child was corrected, the renamed view was not.
        db.exec('PRAGMA writable_schema=ON');
        db.exec("UPDATE sqlite_master SET sql=replace(sql,'REFERENCES \"devices_old\"','REFERENCES devices') WHERE name='child'");
        db.exec('PRAGMA writable_schema=OFF; PRAGMA schema_version=100');
      } else {
        const column = kind === 'benign-unicode-substring' ? 'devices_oldé' : kind === 'benign-dollar-substring' ? 'devices_old$seen' : 'devices_oldest_seen_at';
        db.exec('ALTER TABLE devices ADD COLUMN ' + column + ' TEXT');
      }
      db.close();
      const before = digest(file);
      const { assertNoLegacyDeviceCatalog } = require('../lib/osi-migrate/legacy-device-catalog');
      const { cliRunner } = require('../lib/osi-migrate/runner-iface');
      const probe = assertNoLegacyDeviceCatalog(cliRunner(file));
      if (kind === 'partial-healing-view') await assert.rejects(probe, /Legacy devices_old.*view:retained_device_history/);
      else await probe;
      const shell = spawnSync('sh', ['-c', shellFunction('check_live_db_readonly') + '\nDB_PATH="$1"; check_live_db_readonly', 'probe', file], { encoding: 'utf8' });
      assert.equal(shell.status === 0, kind !== 'partial-healing-view', shell.stderr);
      if (kind === 'partial-healing-view') await assert.rejects(tool().repair({ dbPath: file }), /legacy view requires separate qualification/);
      assert.equal(digest(file), before);
    });
  });
}
for (const suffix of ['-wal', '-shm', '-journal', '.osi-recovery', '.legacy-device-fk-repair.lock', '.legacy-device-fk-writer-hold']) {
  for (const link of [false, true]) {
    test(`Sol review absent main + ${suffix} ${link ? 'dangling link' : 'file'} refuses library, deploy and seeding`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-absent-evidence-'));
      const file = path.join(dir, 'farming.db');
      const evidence = file + suffix;
      try {
        if (link) fs.symlinkSync(path.join(dir, 'missing'), evidence);
        else fs.writeFileSync(evidence, 'committed recovery evidence');
        const { applyPending } = require('../lib/osi-migrate');
        const { cliRunner } = require('../lib/osi-migrate/runner-iface');
        await assert.rejects(applyPending(cliRunner(file), { migrationsDir: path.join(ROOT, 'database/migrations/ordered') }), /recovery|repair|sidecar/i);
        for (const fn of ['check_live_db_readonly', 'seed_db_if_missing']) {
          const r = spawnSync('sh', ['-c', shellFunction(fn) + '\nDB_PATH="$1"; ' + fn, 'probe', file], { encoding: 'utf8' });
          assert.notEqual(r.status, 0, fn + ': ' + r.stderr);
          assert.equal(fs.existsSync(file), false);
        }
        if (link) assert.equal(fs.readlinkSync(evidence), path.join(dir, 'missing'));
        else assert.equal(fs.readFileSync(evidence, 'utf8'), 'committed recovery evidence');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
test('Sol review committed orphan WAL survives applyPending without a main database', async () => {
  await withFixture('healthy', async (file, dir) => {
    const writer = spawnSync(process.execPath, ['-e', "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"PRAGMA journal_mode=WAL; INSERT INTO device_data(deveui,recorded_at) VALUES ('FFFF000000000001','2026-07-01')\");process.kill(process.pid,'SIGKILL')", file]);
    assert.equal(writer.signal, 'SIGKILL');
    fs.renameSync(file, path.join(dir, 'retained-main.db'));
    const before = digest(file + '-wal');
    const { applyPending } = require('../lib/osi-migrate');
    const { cliRunner } = require('../lib/osi-migrate/runner-iface');
    await assert.rejects(applyPending(cliRunner(file), { migrationsDir: path.join(ROOT, 'database/migrations/ordered') }), /sidecar/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(digest(file + '-wal'), before);
  });
});
test('Sol review orphan data rolls staged catalog back before COMMIT and report refuses eligibility', async () => {
  await withFixture('quoted', async (file, dir) => {
    const bad = new DatabaseSync(file); bad.exec("PRAGMA foreign_keys=OFF; UPDATE device_data SET deveui='missing-device' WHERE rowid=(SELECT min(rowid) FROM device_data)"); bad.close();
    const before = digest(file);
    const reportError = await tool().repair({ dbPath: file }).then(() => null, e => e);
    await assert.rejects(tool().repair(options(file, dir)), /foreign_key_check/);
    const stage = fs.readFileSync(path.join(file + '.legacy-device-fk-repair.lock', 'stage'), 'utf8').trim();
    const candidate = new DatabaseSync(path.join(stage, 'candidate.db'));
    try { assert.ok(candidate.prepare('PRAGMA foreign_key_list(device_data)').all().some(f => f.table === 'devices_old')); }
    finally { candidate.close(); }
    assert.match(reportError && reportError.message || '', /foreign_key_check failed before COMMIT/);
    assert.equal(digest(file), before);
  });
});
test('Sol review mixed partially healed children preserve every row and both FK spellings', async () => {
  await withFixture('bracketed', async (file, dir) => {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA writable_schema=ON');
    db.exec('UPDATE sqlite_master SET sql=replace(sql,\'[devices_old]\',\'"devices_old"\') WHERE name=\'device_data\'');
    db.exec('UPDATE sqlite_master SET sql=replace(replace(sql,\'REFERENCES "devices_old"\',\'REFERENCES devices\'),\'REFERENCES devices_old\',\'REFERENCES devices\') WHERE type=\'table\' AND sql LIKE \'%devices_old%\'');
    db.exec('PRAGMA writable_schema=OFF; PRAGMA schema_version=101');
    db.close();
    const r = await tool().repair(options(file, dir));
    assert.equal(r.applied, true);
    assert.equal(r.tables.length, 12);
    const repaired = new DatabaseSync(file);
    try { assert.equal(repaired.prepare('SELECT count(*) n FROM device_data').get().n, 2); assert.deepEqual(repaired.prepare('PRAGMA foreign_key_check').all(), []); }
    finally { repaired.close(); }
  });
});
test('Sol review prepared power loss keeps independent originals and disables the real OpenWrt boot entries', async () => {
  await withFixture('quoted', async (file, dir) => {
    const { makeGateway, reboot } = require('./fixtures/legacy-device-gateway');
    const { prepareOffline, assertHold } = require('./lib/legacy-device-repair-ops');
    const root = makeGateway(path.join(dir, 'gateway'));
    reboot(root);
    assert.match(fs.readFileSync(path.join(root, 'started'), 'utf8'), /node-red/);
    fs.unlinkSync(path.join(root, 'started'));
    const gatewayFile = path.join(root, 'data/db/farming.db');
    fs.copyFileSync(file, gatewayFile);
    await assert.rejects(tool().repair({ ...options(gatewayFile, dir), gatewayRoot: root }), /writer-hold|receipt|hold/);
    assert.equal(digest(gatewayFile), digest(file));
    const held = prepareOffline({ root });
    assert.ok(held.services.every(s => s.enabled));
    const before = digest(gatewayFile);
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ubus'), '#!/bin/sh\nprintf \'{}\\n\'\n', { mode: 0o700 });
    const script = `require(process.argv[1]).repair({dbPath:process.argv[2],apply:true,writersStopped:true,backupDir:process.argv[3],gatewayRoot:process.argv[4],checkpoint:async p=>{if(p==='prepared')process.kill(process.pid,'SIGKILL')}}).catch(e=>{console.error(e);process.exitCode=1})`;
    const child = spawnSync(process.execPath, ['-e', script, path.join(ROOT, 'scripts/repair-legacy-device-fk.js'), gatewayFile, path.join(dir, 'backup'), root], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    reboot(root); // fresh shell dispatch, no state retained from prepareOffline
    assert.equal(fs.existsSync(path.join(root, 'started')), false, 'old writer must not enter its boot path');
    assertHold(root);
    const stage = fs.readFileSync(path.join(gatewayFile + '.legacy-device-fk-repair.lock', 'stage'), 'utf8').trim();
    const original = path.join(stage, 'original.db');
    assert.notEqual(fs.statSync(gatewayFile).ino, fs.statSync(original).ino);
    assert.equal(fs.statSync(original).nlink, 1);
    assert.equal(digest(original), before);
    assert.equal(digest(gatewayFile), before);
  });
});
test('Sol review strict online backup verifies DB and runtime together and never stops/restarts on failure', async () => {
  await withFixture('healthy', async (file, dir) => {
    const { makeGateway } = require('./fixtures/legacy-device-gateway');
    const { backupOnline } = require('./lib/legacy-device-repair-ops');
    const root = makeGateway(path.join(dir, 'gateway'));
    fs.copyFileSync(file, path.join(root, 'data/db/farming.db'));
    const live = new DatabaseSync(path.join(root, 'data/db/farming.db'));
    let r;
    try {
      live.exec("PRAGMA journal_mode=WAL; INSERT INTO device_data(deveui,recorded_at) VALUES ('FFFF000000000001','2026-07-02')");
      const wal = digest(path.join(root, 'data/db/farming.db-wal'));
      r = backupOnline({ root, backupDir: path.join(dir, 'online-backup') });
      assert.equal(digest(path.join(root, 'data/db/farming.db-wal')), wal);
      const snapshot = new DatabaseSync(path.join(r.backup, 'farming.db'));
      try { assert.equal(snapshot.prepare('SELECT count(*) n FROM device_data').get().n, 3, 'online backup includes committed WAL pages'); }
      finally { snapshot.close(); }
    } finally { live.close(); }
    assert.equal(r.integrity, 'ok');
    for (const name of ['farming.db','flows.json','settings.js','flows_cred.json','gui']) assert.ok(fs.existsSync(path.join(r.backup, name)));
    const bad = new DatabaseSync(path.join(root, 'data/db/farming.db')); bad.close();
    fs.writeFileSync(path.join(root, 'data/db/farming.db'), 'broken');
    assert.throws(() => backupOnline({ root, backupDir: path.join(dir, 'failed-backup') }), /strict online backup failed/);
    assert.equal(fs.existsSync(path.join(root, 'started')), false);
    assert.equal(fs.readdirSync(path.join(root, 'etc/rc.d')).filter(p => /^S/.test(p)).length, 2, 'failure changes no service enablement');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'failed-backup/receipt.json'))).phase, 'failed');
  });
});
for (const profile of ['bcm2712', 'bcm2709']) {
  test(`Sol review stock Node 20.18.3 report and repair are runnable for ${profile}`, async () => {
    await withFixture('quoted', async (file, dir) => {
      const large = new DatabaseSync(file);
      large.exec('UPDATE device_data SET id=9223372036854775806 WHERE id=(SELECT min(id) FROM device_data); UPDATE sqlite_sequence SET seq=9223372036854775807 WHERE name=\'device_data\'');
      large.close();
      const config = fs.readFileSync(path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/.config`), 'utf8');
      assert.match(config, /^CONFIG_PACKAGE_sqlite3-cli=y$/m, 'the shipped profile must include the recovery CLI');
      if (/^CONFIG_BUSYBOX_CUSTOM=y$/m.test(config)) assert.match(config, /^CONFIG_BUSYBOX_CONFIG_MKFIFO=y$/m);
      else assert.match(fs.readFileSync(path.join(ROOT, 'openwrt/package/utils/busybox/Config-defaults.in'), 'utf8'), /config BUSYBOX_DEFAULT_MKFIFO\n\s*bool\n\s*default y/);
      const node = process.env.EB19_STOCK_NODE;
      assert.ok(node, 'set EB19_STOCK_NODE to the qualified Node 20.18.3 executable');
      assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), 'v20.18.3');
      const ciHarness = spawnSync(process.execPath, ['-e', `
        const assert=require('node:assert/strict');
        process.getuid=()=>1000;process.env.GITHUB_ACTIONS='true';
        require('node:child_process').spawnSync=(command,args)=>{
          assert.equal(command,'sudo');
          assert.ok(args.includes('--preserve-env=EB19_STOCK_NODE,TMPDIR'));
          assert.ok(args.includes(process.execPath));
          console.log('CI runtime environment is preserved');return {status:0};
        };
        require(process.argv[1]);`, path.join(ROOT, 'scripts/run-legacy-catalog-rehearsal.js')], { encoding: 'utf8' });
      assert.equal(ciHarness.status, 0, ciHarness.stderr);
      assert.match(ciHarness.stdout, /CI runtime environment is preserved/);

      const toolPath = path.join(ROOT, 'scripts/repair-legacy-device-fk.js');
      const run = args => {
        const r = spawnSync(node, [toolPath, ...args], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
      };
      assert.equal(run(['--check-runtime']).adapter, 'sqlite3-cli');
      assert.equal(run([file, '--report']).dataEligible, true);
      assert.equal(run([file, '--apply', '--writers-stopped', '--backup-dir', path.join(dir, 'backups')]).applied, true);
      assert.equal(execFileSync('sqlite3', ['-readonly', file, "SELECT cast(max(id) AS TEXT) FROM device_data"], { encoding: 'utf8' }).trim(), '9223372036854775806');
      const payload = fs.readFileSync(path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`), 'utf8');
      const init = JSON.parse(payload).find(n => n.id === 'sync-init-fn').func;
      const shimSource = require('./rehearse-devices-rebuild').makeFacadeShim.toString();
      const bootScript = `
        const {DatabaseSync}=require(process.argv[1]);
        const {witness}=require(process.argv[2]);
        const makeShim=new Function('DatabaseSync','return ('+process.argv[5]+')')(DatabaseSync);
        (async()=>{
          let d=new DatabaseSync(process.argv[3]);
          const children=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(substr(name,1,7)) <> 'sqlite_'").all().filter(r=>d.prepare('PRAGMA foreign_key_list("'+r.name+'")').all().some(f=>f.table==='devices')).map(r=>r.name);
          const before=witness(d);d.close();
          const shim=makeShim(process.argv[3]); const errors=[];
          try { await new Function('osiDb','env','node','msg',process.argv[4])({Database:function(){return shim;}},{get:()=>''},{warn:()=>{},error:e=>errors.push(String(e)),log:()=>{},status:()=>{}},{}); } finally { shim.close(); }
          if(errors.length)throw new Error(errors.join(';'));
          d=new DatabaseSync(process.argv[3]);const after=witness(d);
          for(const name of children)if(JSON.stringify(before[name])!==JSON.stringify(after[name]))throw new Error('history changed: '+name);
          if(d.prepare('PRAGMA foreign_key_check').all().length)throw new Error('FK check failed');
          d.close();console.log('stock Node 20 full boot and populated child witnesses passed');
        })().catch(e=>{console.error(e.stack);process.exitCode=1});`;
      const boot = spawnSync(node, ['-e', bootScript, path.join(ROOT, 'scripts/lib/repair-sqlite-cli.js'), toolPath, file, retiredFunction(init), shimSource], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
      assert.equal(boot.status, 0, boot.stderr);
      assert.match(boot.stdout, /full boot and populated child witnesses passed/);
    });
  });
}

test('Sol review writer hold release refuses old payload and failed validation, then restores recorded enablement only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-hold-release-'));
  try {
    const { makeGateway } = require('./fixtures/legacy-device-gateway');
    const { prepareOffline, releaseHold, assertHold } = require('./lib/legacy-device-repair-ops');
    const root = makeGateway(path.join(dir, 'gateway'));
    execFileSync(path.join(root, 'etc/init.d/osi-identityd'), ['disable'], { env: { ...process.env, IPKG_INSTROOT: root } });
    const r = prepareOffline({ root });
    assert.deepEqual(r.services.map(s => s.enabled), [false, true]);
    const flows = path.join(root, 'srv/node-red/flows.json');
    fs.writeFileSync(flows, JSON.stringify([{ id: 'sync-init-fn', func: 'PRAGMA writable_schema=ON' }]));
    await assert.rejects(releaseHold({ root, verify: async () => {} }), /retired boot surgery/);
    require('./fixtures/legacy-device-gateway').acceptRetiredPayload(root);
    await assert.rejects(releaseHold({ root, verify: async () => { throw new Error('invalid ledger'); } }), /invalid ledger/);
    assertHold(root);
    const released = await releaseHold({ root, verify: async () => {} });
    assert.equal(released.released, true);
    assert.equal(fs.existsSync(r.hold), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'etc/rc.d')).filter(f => /^S/.test(f)), ['S99node-red']);
    assert.equal(fs.existsSync(path.join(root, 'started')), false);
    assert.equal(JSON.parse(fs.readFileSync(released.receipt)).phase, 'released');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Sol review refusal text accounts for WAL index creation and sends locked recovery to receipts', () => {
  const { RECOVERY } = require('../lib/osi-migrate/legacy-device-catalog');
  assert.doesNotMatch(RECOVERY, /Nothing was changed/);
  assert.match(RECOVERY, /no database repair or migration/);
  assert.match(RECOVERY, /WAL index/);
  const shell = shellFunction('check_live_db_readonly');
  assert.doesNotMatch(shell, /Nothing was changed/);
  assert.match(shell, /inspect its retained receipt; follow/);
  assert.doesNotMatch(shell, /retained receipt with scripts\/repair/);
});

test('Sol review stock transport preserves binary, NUL text, Unicode and exact real values', async () => {
  await withFixture('quoted', async (file, dir) => {
    const db = new DatabaseSync(file);
    db.exec("UPDATE device_data SET lsn50_mode_label=x'00fffe8000', swt_1=1.2345678901234567 WHERE id=1; UPDATE device_data SET lsn50_mode_label=CAST(x'00c2b5f09f8cb1' AS TEXT), swt_1=-0.000000000000000123456789 WHERE id=2");
    const before = db.prepare('SELECT id,typeof(lsn50_mode_label) t,hex(lsn50_mode_label) h,swt_1 FROM device_data ORDER BY id').all(); db.close();
    await tool().repair(options(file, dir));
    const after = new DatabaseSync(file);
    try { assert.deepEqual(after.prepare('SELECT id,typeof(lsn50_mode_label) t,hex(lsn50_mode_label) h,swt_1 FROM device_data ORDER BY id').all(), before); }
    finally { after.close(); }
  });
});

test('Sol review a persistent handle also refuses missing-main WAL evidence before migration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-open-orphan-'));
  const file = path.join(dir, 'farming.db');
  const { nodeSqliteRunner } = require('../lib/osi-migrate/runner-iface');
  const { applyPending } = require('../lib/osi-migrate');
  const runner = nodeSqliteRunner(file);
  try {
    await runner.exec('PRAGMA journal_mode=WAL; CREATE TABLE history(id); INSERT INTO history VALUES(1)');
    fs.renameSync(file, file + '.preserved');
    const wal = digest(file + '-wal');
    await assert.rejects(applyPending(runner, { migrationsDir: path.join(ROOT, 'database/migrations/ordered') }), /sidecar/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(digest(file + '-wal'), wal);
  } finally { await runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const suffix of ['.legacy-device-fk-repair.lock', '-wal', '.legacy-device-fk-writer-hold']) {
  test(`Sol review recovery evidence arriving during seed staging (${suffix}) refuses the final move`, async () => {
    await withFixture('healthy', async (seed, dir) => {
      const target = path.join(dir, 'new-farming.db');
      const scratch = path.join(dir, 'stage'); fs.mkdirSync(scratch);
      const script = shellFunction('seed_db_if_missing') + '\nDB_PATH="$1"; TMP_DIR="$2"; SEED_SOURCE="$3"; SUFFIX="$4"; SEED_DB_REL=seed\nfetch() { cp "$SEED_SOURCE" "$2"; : > "$DB_PATH$SUFFIX"; }\nseed_db_if_missing';
      const r = spawnSync('sh', ['-c', script, 'seed', target, scratch, seed, suffix], { encoding: 'utf8' });
      assert.notEqual(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(target), false);
      assert.ok(fs.existsSync(target + suffix));
      assert.equal(digest(path.join(scratch, 'farming.db')), digest(seed));
    });
  });
}
test('Sol review missing stock SQLite refuses before any offline preparation or service change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-runtime-missing-'));
  try {
    const root = require('./fixtures/legacy-device-gateway').makeGateway(path.join(dir, 'gateway'));
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const r = spawnSync(process.env.EB19_STOCK_NODE, ['-e', 'require(process.argv[1]).prepareOffline({root:process.argv[2]})', path.join(ROOT, 'scripts/lib/legacy-device-repair-ops.js'), root], { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sqlite3.*ENOENT|ENOENT.*sqlite3/);
    assert.equal(fs.existsSync(path.join(root, 'data/db/farming.db.osi-recovery')), false);
    assert.equal(fs.readdirSync(path.join(root, 'etc/rc.d')).filter(f => /^S/.test(f)).length, 2);
    assert.equal(fs.existsSync(path.join(root, 'started')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Sol review a pending boot enable script refuses before autostart changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-pending-enable-'));
  try {
    const root = require('./fixtures/legacy-device-gateway').makeGateway(path.join(dir, 'gateway'));
    fs.writeFileSync(path.join(root, 'etc/uci-defaults/94_enable'), '/etc/init.d/osi-identityd enable\n');
    assert.throws(() => require('./lib/legacy-device-repair-ops').prepareOffline({ root }), /pending service enablement/);
    assert.equal(fs.existsSync(path.join(root, 'data/db/farming.db.osi-recovery')), false);
    assert.equal(fs.readdirSync(path.join(root, 'etc/rc.d')).filter(f => /^S/.test(f)).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Sol review strict backup as last reader preserves the main file and committed WAL evidence', async () => {
  await withFixture('healthy', async (file, dir) => {
    const root = require('./fixtures/legacy-device-gateway').makeGateway(path.join(dir, 'gateway'));
    const source = path.join(root, 'data/db/farming.db'); fs.copyFileSync(file, source);
    const writer = spawnSync(process.execPath, ['-e', "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"PRAGMA journal_mode=WAL;INSERT INTO device_data(deveui,recorded_at) VALUES ('FFFF000000000001','2026-07-03')\");process.kill(process.pid,'SIGKILL')", source]);
    assert.equal(writer.signal, 'SIGKILL');
    const before = [digest(source), digest(source + '-wal')];
    const r = require('./lib/legacy-device-repair-ops').backupOnline({ root, backupDir: path.join(dir, 'online-backup') });
    assert.deepEqual([digest(source), digest(source + '-wal')], before);
    const snapshot = new DatabaseSync(path.join(r.backup, 'farming.db'));
    try { assert.equal(snapshot.prepare('SELECT count(*) n FROM device_data').get().n, 3); }
    finally { snapshot.close(); }
  });
});
