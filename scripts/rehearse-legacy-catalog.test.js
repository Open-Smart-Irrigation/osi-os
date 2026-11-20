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
      const r = spawnSync(process.execPath, ['-e', "require(process.argv[1]).assertGatewayStopped('/data/db/farming.db')", path.join(ROOT, 'scripts/repair-legacy-device-fk.js')], {
        encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, EB19_PROCD_FIXTURE: JSON.stringify(state) },
      });
      assert.equal(r.status === 0, accepted, JSON.stringify(state) + ': ' + r.stderr);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
