'use strict';
// Direct tests for the durable-transaction and fail-stop primitives added to
// the shared osi-db-helper facade:
//   - db.durableTransaction(work)       — serialized FULL-synchronous intent
//                                          barrier ahead of an external effect.
//   - osiDb.createDedicatedDatabase(path) — a connection independent of the
//                                          module-global shared facade.
//   - osiDb.enterFailStop(name, dedicatedDb, reason) — process-lifetime write
//                                          gate used by later callers (not
//                                          wired to any flow producer yet).
//
// These exercise the real sqlite3 module against temp-file databases (no
// mocks). Fail-stop poisons the *whole module instance* permanently for the
// life of the process, so every test that calls enterFailStop gets its own
// freshly-required module instance (via a require-cache bust) to avoid
// contaminating the rest of the suite; the strong-reference/GC proof goes
// one step further and runs in a real child process so `--expose-gc`
// behavior doesn't depend on how this suite itself was invoked.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const MODULE_PATH = path.join(__dirname, 'index.js');

function freshModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-db-helper-test-'));
let tempDbCounter = 0;
function tempDbPath(label) {
  tempDbCounter += 1;
  return path.join(scratchRoot, `${tempDbCounter}-${label || 'db'}.sqlite`);
}

test.after(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// db.durableTransaction(work)
// ---------------------------------------------------------------------------

test('durableTransaction commits and the result is visible after resolve', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('commit'));
  await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');

  const result = await db.durableTransaction(async (tx) => {
    await tx.run('INSERT INTO t (id, val) VALUES (1, ?)', ['hello']);
    return 'work-result';
  });

  assert.equal(result, 'work-result');
  const rows = await db.all('SELECT * FROM t');
  assert.deepEqual(rows, [{ id: 1, val: 'hello' }]);
});

test('durableTransaction rolls back on throw and preserves the original error', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('rollback'));
  await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');

  const boom = new Error('boom-work-failure');
  await assert.rejects(
    () => db.durableTransaction(async (tx) => {
      await tx.run('INSERT INTO t (id) VALUES (1)');
      throw boom;
    }),
    (err) => err === boom
  );

  const rows = await db.all('SELECT * FROM t');
  assert.deepEqual(rows, []);
});

test('durableTransaction round-trips synchronous mode NORMAL -> FULL -> NORMAL', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('syncmode'));
  await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');

  const before = await db.all('PRAGMA synchronous');
  assert.equal(Number(before[0].synchronous), 1); // NORMAL, set by the module's own startup PRAGMAs

  let observedDuring = null;
  await db.durableTransaction(async (tx) => {
    const rows = await tx.all('PRAGMA synchronous');
    observedDuring = Number(rows[0].synchronous);
    await tx.run('INSERT INTO t (id) VALUES (1)');
  });

  assert.equal(observedDuring, 2); // FULL while work() runs

  const after = await db.all('PRAGMA synchronous');
  assert.equal(Number(after[0].synchronous), 1); // restored to the saved NORMAL mode
});

test('durableTransaction round-trips synchronous mode starting from OFF', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('syncmode-off'));
  await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  await db.run('PRAGMA synchronous=OFF');

  const before = await db.all('PRAGMA synchronous');
  assert.equal(Number(before[0].synchronous), 0);

  let observedDuring = null;
  await db.durableTransaction(async (tx) => {
    const rows = await tx.all('PRAGMA synchronous');
    observedDuring = Number(rows[0].synchronous);
  });

  assert.equal(observedDuring, 2);
  const after = await db.all('PRAGMA synchronous');
  assert.equal(Number(after[0].synchronous), 0);
});

test('durableTransaction poisons the facade when restoring synchronous mode fails, then recovers', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('poison'));
  await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');

  const sqlite3 = require('sqlite3');
  const originalExec = sqlite3.Database.prototype.exec;
  // Fail the *first two* restore-to-NORMAL attempts: the first happens inside
  // durableTransaction's own trailing restore, the second happens inside the
  // next queued operation's recovery attempt. The third succeeds, proving
  // "a subsequent successful internal restore attempt" clears the poison.
  let failuresRemaining = 2;
  sqlite3.Database.prototype.exec = function patchedExec(sql, callback) {
    if (failuresRemaining > 0 && /PRAGMA\s+synchronous\s*=\s*NORMAL/i.test(sql)) {
      failuresRemaining -= 1;
      const err = new Error('synthetic-restore-failure');
      process.nextTick(() => callback && callback(err));
      return this;
    }
    return originalExec.call(this, sql, callback);
  };

  try {
    const result = await db.durableTransaction(async (tx) => {
      await tx.run('INSERT INTO t (id) VALUES (1)');
      return 'ok';
    });
    // Requirement: "the returned promise resolves with work's return value"
    // even though the trailing restore failed and poisoned the facade.
    assert.equal(result, 'ok');

    // New work rejects with a bounded error naming the cause while poisoned.
    await assert.rejects(
      () => db.run('INSERT INTO t (id) VALUES (2)'),
      (err) => /synchronous/i.test(err.message) && /synthetic-restore-failure/.test(err.message)
    );

    // The id=2 insert above never reached sqlite (it was rejected before
    // running), and the failing-twice patch is now exhausted, so this next
    // call's internal recovery attempt succeeds and clears the poison.
    const rows = await db.all('SELECT id FROM t ORDER BY id');
    assert.deepEqual(rows.map((r) => r.id), [1]);

    // Facade is healthy again: new writes go through normally.
    await db.run('INSERT INTO t (id) VALUES (3)');
    const rowsAfter = await db.all('SELECT id FROM t ORDER BY id');
    assert.deepEqual(rowsAfter.map((r) => r.id), [1, 3]);

    const mode = await db.all('PRAGMA synchronous');
    assert.equal(Number(mode[0].synchronous), 1);
  } finally {
    sqlite3.Database.prototype.exec = originalExec;
  }
});

test('durableTransaction rejects a nested durableTransaction/transaction call from within work', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('nested'));
  await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');

  let nestedDurableError = null;
  let nestedTransactionError = null;

  const result = await db.durableTransaction(async (tx) => {
    await tx.run('INSERT INTO t (id) VALUES (1)');
    try {
      await db.durableTransaction(async () => {});
      assert.fail('nested durableTransaction should have rejected');
    } catch (error) {
      nestedDurableError = error;
    }
    try {
      await db.transaction(async () => {});
      assert.fail('nested transaction should have rejected');
    } catch (error) {
      nestedTransactionError = error;
    }
    return 'outer-ok';
  });

  assert.equal(result, 'outer-ok');
  assert.ok(nestedDurableError);
  assert.match(nestedDurableError.message, /nested/i);
  assert.ok(nestedTransactionError);
  assert.match(nestedTransactionError.message, /nested/i);

  const rows = await db.all('SELECT id FROM t');
  assert.deepEqual(rows.map((r) => r.id), [1]);

  // The outer transaction committed cleanly and the guard flag was released
  // afterward — an ordinary follow-up transaction still works.
  await db.durableTransaction(async (tx) => {
    await tx.run('INSERT INTO t (id) VALUES (2)');
  });
  const rowsAfter = await db.all('SELECT id FROM t ORDER BY id');
  assert.deepEqual(rowsAfter.map((r) => r.id), [1, 2]);
});

test('durableTransaction serializes concurrent calls without interleaving their SQL', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('serialize'));
  await db.run('CREATE TABLE probe (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');

  async function labeledWork(tx, label) {
    await tx.run('INSERT INTO probe (label) VALUES (?)', [`${label}-start`]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await tx.run('INSERT INTO probe (label) VALUES (?)', [`${label}-end`]);
  }

  await Promise.all([
    db.durableTransaction((tx) => labeledWork(tx, 'A')),
    db.durableTransaction((tx) => labeledWork(tx, 'B'))
  ]);

  const rows = await db.all('SELECT label FROM probe ORDER BY seq');
  const labels = rows.map((row) => row.label);
  assert.equal(labels.length, 4);
  const groupedAB = labels[0] === 'A-start' && labels[1] === 'A-end' && labels[2] === 'B-start' && labels[3] === 'B-end';
  const groupedBA = labels[0] === 'B-start' && labels[1] === 'B-end' && labels[2] === 'A-start' && labels[3] === 'A-end';
  assert.ok(groupedAB || groupedBA, `expected non-interleaved groups, got ${JSON.stringify(labels)}`);
});

test('durableTransaction rejects a non-function work argument', async () => {
  const osiDb = freshModule();
  const db = new osiDb.Database(tempDbPath('bad-arg'));
  assert.throws(() => db.durableTransaction(null), TypeError);
});

// ---------------------------------------------------------------------------
// osiDb.createDedicatedDatabase(path)
// ---------------------------------------------------------------------------

test('createDedicatedDatabase opens a connection distinct from the shared facade', async () => {
  const osiDb = freshModule();
  const dbPath = tempDbPath('dedicated-distinct');

  const dedicated = osiDb.createDedicatedDatabase(dbPath);
  await dedicated.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  await dedicated.run('BEGIN EXCLUSIVE');
  await dedicated.run('INSERT INTO t (id) VALUES (1)');

  const sqlite3 = require('sqlite3');
  const second = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(database)));
  });

  await assert.rejects(
    () => new Promise((resolve, reject) => {
      second.run('INSERT INTO t (id) VALUES (2)', (err) => (err ? reject(err) : resolve()));
    }),
    (err) => /SQLITE_BUSY/.test(err.code || err.message || '')
  );

  await new Promise((resolve) => second.close(() => resolve()));
  await dedicated.run('ROLLBACK');
  await dedicated.close();
});

test('createDedicatedDatabase supports manual BEGIN EXCLUSIVE/COMMIT and close', async () => {
  const osiDb = freshModule();
  const dbPath = tempDbPath('dedicated-manual');
  const dedicated = osiDb.createDedicatedDatabase(dbPath);

  await dedicated.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
  await dedicated.run('BEGIN EXCLUSIVE');
  await dedicated.run('INSERT INTO t (id, val) VALUES (1, ?)', ['a']);
  await dedicated.run('COMMIT');

  const rows = await dedicated.all('SELECT * FROM t');
  assert.deepEqual(rows, [{ id: 1, val: 'a' }]);
  const row = await dedicated.get('SELECT * FROM t WHERE id = 1');
  assert.deepEqual(row, { id: 1, val: 'a' });

  await dedicated.close();

  const reopened = osiDb.createDedicatedDatabase(dbPath);
  const rowsAfterReopen = await reopened.all('SELECT * FROM t');
  assert.deepEqual(rowsAfterReopen, [{ id: 1, val: 'a' }]);
  await reopened.close();
});

// ---------------------------------------------------------------------------
// osiDb.enterFailStop(name, dedicatedDb, reason)
// ---------------------------------------------------------------------------

test('enterFailStop poisons existing and newly constructed facades before enqueue, with a bounded name/reason error', async () => {
  const osiDb = freshModule();
  const dbPath = tempDbPath('failstop-basic');

  const sqlite3 = require('sqlite3');
  const recorded = [];
  const originals = {};
  for (const method of ['run', 'all', 'exec']) {
    originals[method] = sqlite3.Database.prototype[method];
    sqlite3.Database.prototype[method] = function patched(...args) {
      recorded.push(method);
      return originals[method].apply(this, args);
    };
  }

  try {
    const existingDb = new osiDb.Database(dbPath);
    await existingDb.run('CREATE TABLE probe (id INTEGER PRIMARY KEY)');

    const dedicated = osiDb.createDedicatedDatabase(tempDbPath('failstop-basic-dedicated'));
    await dedicated.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await dedicated.run('BEGIN EXCLUSIVE');
    await dedicated.run('INSERT INTO t (id) VALUES (1)');

    let settled = false;
    const failStopPromise = osiDb.enterFailStop('unit-test-fail-stop', dedicated, 'synthetic-unit-reason');
    failStopPromise.then(() => { settled = true; }, () => { settled = true; });

    const newDb = new osiDb.Database(dbPath);
    const recordedBefore = recorded.length;

    async function expectBoundedRejection(promiseFactory) {
      await assert.rejects(promiseFactory, (err) =>
        err instanceof Error &&
        err.message.includes('unit-test-fail-stop') &&
        err.message.includes('synthetic-unit-reason'));
    }

    await expectBoundedRejection(() => existingDb.run('INSERT INTO probe (id) VALUES (1)'));
    await expectBoundedRejection(() => existingDb.all('SELECT * FROM probe'));
    await expectBoundedRejection(() => existingDb.get('SELECT * FROM probe'));
    await expectBoundedRejection(() => existingDb.exec('UPDATE probe SET id = 1'));
    await expectBoundedRejection(() => existingDb.transaction(async () => {}));
    await expectBoundedRejection(() => existingDb.readSnapshot(async () => {}));
    await expectBoundedRejection(() => existingDb.durableTransaction(async () => {}));

    await expectBoundedRejection(() => newDb.run('INSERT INTO probe (id) VALUES (2)'));
    await expectBoundedRejection(() => newDb.all('SELECT * FROM probe'));
    await expectBoundedRejection(() => newDb.exec('UPDATE probe SET id = 2'));
    await expectBoundedRejection(() => newDb.transaction(async () => {}));
    await expectBoundedRejection(() => newDb.readSnapshot(async () => {}));
    await expectBoundedRejection(() => newDb.durableTransaction(async () => {}));

    // DML-through-all/exec negatives: method name is not a read/write classifier.
    await expectBoundedRejection(() => existingDb.all('INSERT INTO probe (id) VALUES (3)'));
    await expectBoundedRejection(() => existingDb.exec('DELETE FROM probe'));

    assert.equal(recorded.length, recordedBefore, 'no SQL should reach sqlite3 for a poisoned call (reject-before-enqueue)');

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, 'enterFailStop promise must never settle');

    // Idempotent second call: the ORIGINAL name/reason keeps being reported,
    // and the second dedicated handle is retained too (proven via its own
    // lock further down as part of the GC test; here we just check the
    // reported identity does not change).
    const dedicated2 = osiDb.createDedicatedDatabase(tempDbPath('failstop-basic-dedicated-2'));
    await dedicated2.run('CREATE TABLE t2 (id INTEGER PRIMARY KEY)');
    osiDb.enterFailStop('second-name', dedicated2, 'second-reason').then(() => {}, () => {});

    try {
      await existingDb.run('INSERT INTO probe (id) VALUES (5)');
      assert.fail('expected rejection');
    } catch (err) {
      assert.match(err.message, /unit-test-fail-stop/);
      assert.doesNotMatch(err.message, /second-name/);
    }
  } finally {
    for (const method of ['run', 'all', 'exec']) {
      sqlite3.Database.prototype[method] = originals[method];
    }
  }
});

const CHILD_SCRIPT_SOURCE = [
  "'use strict';",
  "const assert = require('node:assert/strict');",
  '',
  'const MODULE_PATH = process.argv[2];',
  'const SHARED_DB_PATH = process.argv[3];',
  'const DEDICATED_DB_PATH = process.argv[4];',
  'const DEDICATED_DB_PATH_2 = process.argv[5];',
  '',
  '(async () => {',
  '  if (typeof global.gc !== "function") {',
  '    throw new Error("global.gc is not available; expected to run with --expose-gc");',
  '  }',
  '',
  "  const sqlite3 = require('sqlite3');",
  '  const recorded = [];',
  "  for (const method of ['run', 'all', 'exec']) {",
  '    const original = sqlite3.Database.prototype[method];',
  '    sqlite3.Database.prototype[method] = function patched(...args) {',
  '      recorded.push(method);',
  '      return original.apply(this, args);',
  '    };',
  '  }',
  '',
  '  const osiDb = require(MODULE_PATH);',
  '',
  '  const existingDb = new osiDb.Database(SHARED_DB_PATH);',
  "  await existingDb.run('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');",
  '',
  '  let dedicated = osiDb.createDedicatedDatabase(DEDICATED_DB_PATH);',
  "  await dedicated.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');",
  "  await dedicated.run('BEGIN EXCLUSIVE');",
  "  await dedicated.run('INSERT INTO t (id) VALUES (1)');",
  '',
  '  let dedicated2 = osiDb.createDedicatedDatabase(DEDICATED_DB_PATH_2);',
  "  await dedicated2.run('CREATE TABLE t2 (id INTEGER PRIMARY KEY)');",
  "  await dedicated2.run('BEGIN EXCLUSIVE');",
  "  await dedicated2.run('INSERT INTO t2 (id) VALUES (2)');",
  '',
  '  let settled = false;',
  "  const p1 = osiDb.enterFailStop('primary-fail-stop', dedicated, 'synthetic-primary-reason');",
  '  p1.then(() => { settled = true; }, () => { settled = true; });',
  '',
  '  // Idempotent second call with a different name/reason/handle.',
  "  const p2 = osiDb.enterFailStop('secondary-fail-stop', dedicated2, 'synthetic-secondary-reason');",
  '  p2.then(() => { settled = true; }, () => { settled = true; });',
  '',
  '  // Drop OUR references; only the module-internal strong-reference Set',
  '  // should keep these dedicated connections alive from here on.',
  '  dedicated = null;',
  '  dedicated2 = null;',
  '',
  '  const newDb = new osiDb.Database(SHARED_DB_PATH);',
  '  const recordedBefore = recorded.length;',
  '',
  '  async function expectBlocked(promiseFactory, label) {',
  '    let threw = false;',
  '    let err;',
  '    try {',
  '      await promiseFactory();',
  '    } catch (e) {',
  '      threw = true;',
  '      err = e;',
  '    }',
  "    assert.equal(threw, true, `${label} should reject`);",
  "    assert.match(String(err.message), /primary-fail-stop/, `${label} error should carry the first fail-stop name`);",
  "    assert.match(String(err.message), /synthetic-primary-reason/, `${label} error should carry the first fail-stop reason`);",
  '  }',
  '',
  "  await expectBlocked(() => existingDb.run('INSERT INTO probe (id) VALUES (1)'), 'existing.run');",
  "  await expectBlocked(() => existingDb.all('SELECT * FROM probe'), 'existing.all');",
  "  await expectBlocked(() => existingDb.get('SELECT * FROM probe'), 'existing.get');",
  "  await expectBlocked(() => existingDb.exec('UPDATE probe SET id = 1'), 'existing.exec');",
  "  await expectBlocked(() => existingDb.transaction(async () => {}), 'existing.transaction');",
  "  await expectBlocked(() => existingDb.readSnapshot(async () => {}), 'existing.readSnapshot');",
  "  await expectBlocked(() => existingDb.durableTransaction(async () => {}), 'existing.durableTransaction');",
  '',
  "  await expectBlocked(() => newDb.run('INSERT INTO probe (id) VALUES (2)'), 'new.run');",
  "  await expectBlocked(() => newDb.all('SELECT * FROM probe'), 'new.all');",
  "  await expectBlocked(() => newDb.exec('UPDATE probe SET id = 2'), 'new.exec');",
  "  await expectBlocked(() => newDb.transaction(async () => {}), 'new.transaction');",
  "  await expectBlocked(() => newDb.readSnapshot(async () => {}), 'new.readSnapshot');",
  "  await expectBlocked(() => newDb.durableTransaction(async () => {}), 'new.durableTransaction');",
  '',
  "  await expectBlocked(() => existingDb.all('INSERT INTO probe (id) VALUES (3)'), 'existing.all-DML');",
  "  await expectBlocked(() => existingDb.exec('DELETE FROM probe'), 'existing.exec-DML');",
  '',
  "  assert.equal(recorded.length, recordedBefore, 'no SQL should reach sqlite after fail-stop');",
  "  assert.equal(settled, false, 'enterFailStop promise must never settle');",
  '',
  '  global.gc();',
  '  await new Promise((resolve) => setTimeout(resolve, 20));',
  '  global.gc();',
  '  await new Promise((resolve) => setTimeout(resolve, 20));',
  '',
  "  assert.equal(settled, false, 'enterFailStop promise must still not settle after forced GC');",
  '',
  '  const probe1 = new sqlite3.Database(DEDICATED_DB_PATH);',
  '  await new Promise((resolve, reject) => {',
  "    probe1.run('INSERT INTO t (id) VALUES (99)', (err) => {",
  '      if (err && /SQLITE_BUSY/.test(err.code || err.message || "")) resolve();',
  "      else reject(err || new Error('expected SQLITE_BUSY for primary dedicated lock'));",
  '    });',
  '  });',
  '  await new Promise((resolve) => probe1.close(() => resolve()));',
  '',
  '  const probe2 = new sqlite3.Database(DEDICATED_DB_PATH_2);',
  '  await new Promise((resolve, reject) => {',
  "    probe2.run('INSERT INTO t2 (id) VALUES (99)', (err) => {",
  '      if (err && /SQLITE_BUSY/.test(err.code || err.message || "")) resolve();',
  "      else reject(err || new Error('expected SQLITE_BUSY for secondary dedicated lock'));",
  '    });',
  '  });',
  '  await new Promise((resolve) => probe2.close(() => resolve()));',
  '',
  "  process.stdout.write('OK\\n');",
  '  process.exit(0);',
  '})().catch((error) => {',
  '  process.stderr.write(String((error && error.stack) || error) + "\\n");',
  '  process.exit(1);',
  '});',
  ''
].join('\n');

test('enterFailStop retains the dedicated connection through forced GC (child process, --expose-gc)', async () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-db-helper-failstop-gc-'));
  const sharedDbPath = path.join(scratchDir, 'shared.sqlite');
  const dedicatedDbPath = path.join(scratchDir, 'dedicated.sqlite');
  const dedicatedDbPath2 = path.join(scratchDir, 'dedicated-2.sqlite');
  const childScriptPath = path.join(scratchDir, 'child.js');
  fs.writeFileSync(childScriptPath, CHILD_SCRIPT_SOURCE, 'utf8');

  const result = spawnSync(
    process.execPath,
    ['--expose-gc', childScriptPath, MODULE_PATH, sharedDbPath, dedicatedDbPath, dedicatedDbPath2],
    { encoding: 'utf8', env: process.env }
  );

  try {
    if (result.error) {
      assert.fail(`failed to spawn child: ${result.error.message}`);
    }
    if (result.status !== 0) {
      assert.fail(
        `child fail-stop/GC scenario exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
      );
    }
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
