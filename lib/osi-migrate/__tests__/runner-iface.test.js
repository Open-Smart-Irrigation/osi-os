'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner, nodeSqliteRunner, parseSqliteJsonOutput } = require('../runner-iface');
const { sqlQuote } = require('../ledger');
const { assertNoLegacyDeviceCatalog } = require('../legacy-device-catalog');

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-')), 'test.db');
}

test('legacy preflight accepts an absent CLI database without creating it', async () => {
  const db = tmpDb();
  await assertNoLegacyDeviceCatalog(cliRunner(db));
  assert.equal(fs.existsSync(db), false);
});

test('legacy preflight still refuses an incomplete repair when the database is absent', async () => {
  const db = tmpDb();
  fs.mkdirSync(db + '.legacy-device-fk-repair.lock');
  await assert.rejects(assertNoLegacyDeviceCatalog(cliRunner(db)), /Incomplete offline legacy device FK repair/);
  assert.equal(fs.existsSync(db), false);
});

test('legacy preflight accepts an existing healthy CLI database without changing its bytes', async () => {
  const db = tmpDb();
  const runner = cliRunner(db);
  await runner.exec('CREATE TABLE devices (id INTEGER PRIMARY KEY);');
  const before = fs.readFileSync(db);
  await assertNoLegacyDeviceCatalog(runner);
  assert.deepEqual(fs.readFileSync(db), before);
});

test('legacy preflight refuses an existing unreadable catalog and preserves its bytes', async () => {
  const db = tmpDb();
  const before = Buffer.from('not a SQLite database');
  fs.writeFileSync(db, before);
  await assert.rejects(assertNoLegacyDeviceCatalog(cliRunner(db)), /Cannot inspect legacy device catalog:.*not a database/s);
  assert.deepEqual(fs.readFileSync(db), before);
});

test('legacy preflight refuses a dangling database symlink without creating its target', async () => {
  const db = tmpDb();
  const target = db + '.missing';
  fs.symlinkSync(target, db);
  await assert.rejects(assertNoLegacyDeviceCatalog(cliRunner(db)), /Cannot inspect legacy device catalog/);
  assert.equal(fs.readlinkSync(db), target);
  assert.equal(fs.existsSync(target), false);
});

test('legacy preflight propagates an existing database read failure', async () => {
  const db = tmpDb();
  fs.writeFileSync(db, '');
  const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  await assert.rejects(assertNoLegacyDeviceCatalog({
    dbPath: db,
    readOnlyAll: async () => { throw cause; },
    all: async () => { assert.fail('must not retry a failed read through a writable connection'); },
  }), error => error.cause === cause && /Cannot inspect legacy device catalog: permission denied/.test(error.message));
});

test('native runner refuses before creating a database beside a committed orphan WAL', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = tmpDb();
  const source = new DatabaseSync(db + '.source');
  try {
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE history (id INTEGER); INSERT INTO history VALUES (42);');
    const wal = fs.readFileSync(db + '.source-wal');
    const shm = fs.readFileSync(db + '.source-shm');
    fs.writeFileSync(db + '-wal', wal);
    fs.writeFileSync(db + '-shm', shm);

    assert.throws(() => nodeSqliteRunner(db), /Missing database with retained SQLite sidecar -wal/);
    assert.equal(fs.existsSync(db), false);
    assert.deepEqual(fs.readFileSync(db + '-wal'), wal);
    assert.deepEqual(fs.readFileSync(db + '-shm'), shm);
  } finally {
    source.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

for (const suffix of ['-shm', '-journal', '.osi-recovery', '.legacy-device-fk-repair.lock', '.legacy-device-fk-writer-hold']) {
  test('native runner refuses an absent database with retained ' + suffix, () => {
    const db = tmpDb();
    const marker = db + suffix;
    try {
      if (suffix === '.osi-recovery') {
        fs.mkdirSync(marker);
      } else {
        fs.symlinkSync(db + '.missing', marker);
      }
      assert.throws(() => nodeSqliteRunner(db), error => error.message.includes(suffix));
      assert.equal(fs.existsSync(db), false);
      assert.ok(fs.lstatSync(marker));
    } finally {
      fs.rmSync(path.dirname(db), { recursive: true, force: true });
    }
  });
}

test('native legacy preflight refuses an existing unreadable catalog and preserves its bytes', async () => {
  const db = tmpDb();
  const before = Buffer.from('not a SQLite database');
  fs.writeFileSync(db, before);
  let runner;
  try {
    await assert.rejects(async () => {
      runner = nodeSqliteRunner(db);
      await assertNoLegacyDeviceCatalog(runner);
    }, /not a database/i);
    assert.deepEqual(fs.readFileSync(db), before);
  } finally {
    await runner?.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

test('legacy preflight inspects uncommitted catalog changes through the persistent runner handle', async () => {
  const db = tmpDb();
  const runner = nodeSqliteRunner(db);
  try {
    await runner.exec('BEGIN; CREATE TABLE child (id INTEGER REFERENCES devices_old(id));');
    await assert.rejects(assertNoLegacyDeviceCatalog(runner), { code: 'ERR_LEGACY_DEVICE_CATALOG' });
    await runner.exec('ROLLBACK;');
    await assertNoLegacyDeviceCatalog(runner);
  } finally {
    await runner.close();
  }
});

test('legacy preflight inspects an in-memory persistent database despite the absent file path', async () => {
  const runner = nodeSqliteRunner(':memory:');
  try {
    await runner.exec('CREATE TABLE child (id INTEGER REFERENCES devices_old(id));');
    await assert.rejects(assertNoLegacyDeviceCatalog(runner), { code: 'ERR_LEGACY_DEVICE_CATALOG' });
  } finally {
    await runner.close();
  }
});

test('cliRunner exec creates schema and all() returns rows as objects', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await r.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'),('b');");
  const rows = await r.all('SELECT id, name FROM t ORDER BY id');
  assert.deepEqual(rows, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
});

test('cliRunner all() returns [] for empty result', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await r.exec('CREATE TABLE t (id INTEGER);');
  assert.deepEqual(await r.all('SELECT * FROM t'), []);
});

test('cliRunner exec throws on bad SQL', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await assert.rejects(() => r.exec('CREATE TABLE ;'));
});

test('exec is fail-fast: a mid-script error rolls back the whole transaction (no partial commit)', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await assert.rejects(() =>
    r.exec('BEGIN;\nCREATE TABLE a (x);\nINSERT INTO nonexist VALUES (1);\nCREATE TABLE b (y);\nCOMMIT;'));
  const tables = await r.all("SELECT name FROM sqlite_master WHERE type='table'");
  assert.deepEqual(tables, [], 'neither table created — -bail prevented fall-through to COMMIT');
});

test('all() handles result sets larger than Node execFileSync default buffer', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  const payload = 'x'.repeat(2 * 1024 * 1024);
  await r.exec('CREATE TABLE t (payload TEXT);');
  await r.exec(`INSERT INTO t (payload) VALUES (${sqlQuote(payload)});`);
  const rows = await r.all('SELECT payload FROM t');
  assert.equal(rows[0].payload.length, payload.length);
});

test('all() is not polluted by the busy-timeout pragma', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await r.exec('CREATE TABLE t(x);');
  assert.deepStrictEqual(await r.all('SELECT 1 AS x'), [{ x: 1 }]);
});

test('functionArgLimit: a call with exactly N arguments passes, N+1 fails (inclusive-max, SQLite-enforced)', async () => {
  const db = tmpDb();
  const r = cliRunner(db, { functionArgLimit: 5 });
  await r.exec('CREATE TABLE t(x);');
  assert.deepStrictEqual(await r.all('SELECT json_array(1,2,3,4,5) AS c'), [{ c: '[1,2,3,4,5]' }]);
  await assert.rejects(() => r.all('SELECT json_array(1,2,3,4,5,6) AS c'), /too many arguments/);
});

test('all() is not polluted by the .limit dot-command under functionArgLimit (regression: CI sqlite3 build echoed "function_arg N" ahead of the JSON result and crashed JSON.parse)', async () => {
  const db = tmpDb();
  const r = cliRunner(db, { functionArgLimit: 127 });
  await r.exec('CREATE TABLE t(x);');
  assert.deepStrictEqual(await r.all('SELECT 1 AS x'), [{ x: 1 }]);
});

test('parseSqliteJsonOutput: parses clean -json output', () => {
  assert.deepEqual(parseSqliteJsonOutput('[{"c":1}]'), [{ c: 1 }]);
});

test('parseSqliteJsonOutput: empty output is an empty result set', () => {
  assert.deepEqual(parseSqliteJsonOutput(''), []);
  assert.deepEqual(parseSqliteJsonOutput('   \n  '), []);
});

test('parseSqliteJsonOutput: strips a leading dot-command echo line ("function_arg 127") ahead of the JSON', () => {
  assert.deepEqual(parseSqliteJsonOutput('function_arg 127\n[{"c":1}]'), [{ c: 1 }]);
});

test('parseSqliteJsonOutput: echo-only output is an empty result set (zero-row query prints no JSON at all)', () => {
  assert.deepEqual(parseSqliteJsonOutput('function_arg 127'), []);
  assert.deepEqual(parseSqliteJsonOutput('function_arg 127\n'), []);
});

test('parseSqliteJsonOutput: strips multiple leading dot-command echo lines', () => {
  assert.deepEqual(parseSqliteJsonOutput('timeout 30000\nfunction_arg 127\n[{"c":2}]'), [{ c: 2 }]);
  assert.deepEqual(parseSqliteJsonOutput('timeout 30000\nfunction_arg 127'), []);
});

test('parseSqliteJsonOutput: fails closed with a clear message on genuinely unrecognized output', () => {
  assert.throws(() => parseSqliteJsonOutput('not json at all'), /unrecognized sqlite3 output/);
  assert.throws(() => parseSqliteJsonOutput('Error: disk I/O error'), /unrecognized sqlite3 output/);
});

test('nodeSqliteRunner keeps one connection and closes it after an exec failure', async () => {
  const db = tmpDb();
  const r = nodeSqliteRunner(db);
  await r.exec('CREATE TABLE t (id INTEGER);');
  assert.deepEqual(await r.all('SELECT name FROM sqlite_master WHERE name = \'t\''), [{ name: 't' }]);
  await assert.rejects(() => r.exec('BEGIN; INSERT INTO t VALUES (1); SELECT * FROM missing; COMMIT;'));
  await assert.rejects(() => r.all('SELECT * FROM t'), /closed|database/i);
  const retry = nodeSqliteRunner(db);
  assert.deepEqual(await retry.all('SELECT * FROM t'), []);
  await retry.close();
});

test('nodeSqliteRunner falls back to cliRunner when node:sqlite is unavailable', async () => {
  const db = tmpDb();
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'node:sqlite') {
      const err = new Error('node:sqlite unavailable');
      err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
      throw err;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const r = nodeSqliteRunner(db);
    await r.exec('CREATE TABLE t (id INTEGER);');
    assert.deepEqual(await r.all('SELECT name FROM sqlite_master WHERE name = \'t\''), [{ name: 't' }]);
  } finally {
    Module._load = originalLoad;
  }
});

test('nodeSqliteRunner resets foreign_keys before calls after a destructive fence', async () => {
  const db = tmpDb();
  const r = nodeSqliteRunner(db);
  await r.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));');
  await r.exec('PRAGMA foreign_keys=OFF; BEGIN; ALTER TABLE parent ADD COLUMN label TEXT; COMMIT; PRAGMA foreign_keys=ON;');
  // A fresh cliRunner connection starts with foreign_keys=OFF. The persistent
  // adapter must match that behavior for the next independent call.
  await r.exec('INSERT INTO child (parent_id) VALUES (999);');
  assert.deepEqual(await r.all('PRAGMA foreign_keys'), [{ foreign_keys: 0 }]);
  await r.close();
});
