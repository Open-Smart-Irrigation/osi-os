'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSqlite3Adapter } = require('./lib/sqlite3-node-adapter');

const helperPath = path.resolve(__dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js');

function fixture(t, faults = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-db-nested-begin-'));
  const filename = path.join(dir, 'farm.db');
  const adapter = createSqlite3Adapter();
  const BaseDatabase = adapter.Database;
  const events = [];
  const handles = [];
  adapter.Database = class extends BaseDatabase {
    constructor(...args) {
      super(...args);
      handles.push(this);
    }
    exec(sql, callback) {
      const event = sql.trim().replace(/;$/, '').toUpperCase();
      events.push(event);
      const error = faults[event] && faults[event]();
      if (error) return callback.call(this, error);
      return super.exec(sql, callback);
    }
  };
  const original = Module._load;
  let helper;
  Module._load = function(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) return adapter;
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[helperPath];
    helper = require(helperPath);
  } finally {
    Module._load = original;
  }
  t.after(() => {
    for (const handle of handles) handle.native.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = new helper.Database(filename);
  return { helper, db, filename, events };
}

test('a transaction retries after a queued manual COMMIT without deadlock', { timeout: 2000 }, async (t) => {
  const { helper, db, filename, events } = fixture(t);
  const other = new helper.Database(filename);
  await db.exec('CREATE TABLE sample(value TEXT)');
  await db.run('BEGIN IMMEDIATE');
  let executions = 0;
  const pending = other.transaction(async (tx) => {
    executions += 1;
    await tx.run("INSERT INTO sample VALUES ('retried')");
    return 'result';
  });
  const manualWrite = db.run("INSERT INTO sample VALUES ('manual')");
  const manualCommit = db.run('COMMIT');
  const [result] = await Promise.all([pending, manualWrite, manualCommit]);
  assert.equal(result, 'result');
  assert.equal(executions, 1);
  assert.equal(events.filter((event) => event === 'BEGIN IMMEDIATE').length, 2);
  assert.equal(events.filter((event) => event === 'ROLLBACK').length, 0);
  assert.deepEqual((await db.all('SELECT value FROM sample ORDER BY rowid')).map((row) => row.value),
    ['manual', 'retried']);
});

test('persistent nested BEGIN failure stops at ten attempts and preserves the last error', { timeout: 2000 }, async (t) => {
  const errors = [];
  const { helper, db, events } = fixture(t, {
    'BEGIN IMMEDIATE': () => {
      const error = Object.assign(new Error('SQLITE_ERROR: CANNOT START A TRANSACTION WITHIN A TRANSACTION'),
        { code: 'SQLITE_ERROR', attempt: errors.length + 1 });
      errors.push(error);
      return error;
    }
  });
  const delays = [];
  helper._setTransactionRetryDelayForTests(async (ms) => { delays.push(ms); });
  let executions = 0;
  await assert.rejects(db.transaction(() => { executions += 1; }), (error) => {
    assert.strictEqual(error, errors[errors.length - 1]);
    return true;
  });
  assert.equal(errors.length, 10);
  assert.deepEqual(delays, [100, 200, 300, 400, 500, 600, 700, 800, 900]);
  assert.equal(delays.reduce((sum, ms) => sum + ms, 0), 4500);
  assert.equal(executions, 0);
  assert.equal(events.filter((event) => event === 'ROLLBACK').length, 0);
  assert.equal((await db.get('SELECT 1 AS alive')).alive, 1);
});

test('a non-nested BEGIN error rejects unchanged without retry or rollback', async (t) => {
  const failure = Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
  const { helper, db, events } = fixture(t, { 'BEGIN IMMEDIATE': () => failure });
  let delays = 0;
  let executions = 0;
  helper._setTransactionRetryDelayForTests(async () => { delays += 1; });
  await assert.rejects(db.transaction(() => { executions += 1; }), (error) => error === failure);
  assert.deepEqual(events, ['BEGIN IMMEDIATE']);
  assert.equal(delays, 0);
  assert.equal(executions, 0);
});

for (const message of ['executor failed', 'cannot start a transaction within a transaction']) {
  test('executor error rolls back without retry: ' + message, async (t) => {
    const { helper, db, events } = fixture(t);
    await db.exec('CREATE TABLE sample(value TEXT)');
    const failure = new Error(message);
    let executions = 0;
    let delays = 0;
    helper._setTransactionRetryDelayForTests(async () => { delays += 1; });
    await assert.rejects(db.transaction(async (tx) => {
      executions += 1;
      await tx.run("INSERT INTO sample VALUES ('rolled back')");
      throw failure;
    }), (error) => error === failure);
    assert.equal(executions, 1);
    assert.equal(delays, 0);
    assert.deepEqual(events.slice(1), ['BEGIN IMMEDIATE', 'ROLLBACK']);
    assert.equal((await db.get('SELECT count(*) AS count FROM sample')).count, 0);
  });
}

test('COMMIT and ROLLBACK errors keep the original error and rollbackError without retry', async (t) => {
  const failure = new Error('cannot start a transaction within a transaction');
  const rollbackError = new Error('rollback failed');
  const { helper, db, events } = fixture(t, {
    COMMIT: () => failure,
    ROLLBACK: () => rollbackError
  });
  let executions = 0;
  let delays = 0;
  helper._setTransactionRetryDelayForTests(async () => { delays += 1; });
  await assert.rejects(db.transaction(() => { executions += 1; }), (error) => error === failure);
  assert.strictEqual(failure.rollbackError, rollbackError);
  assert.deepEqual(events, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
  assert.equal(executions, 1);
  assert.equal(delays, 0);
  await db.run('ROLLBACK');
});

test('successful operations retain FIFO submission order', async (t) => {
  const { helper, db } = fixture(t);
  await db.exec('CREATE TABLE sample(value TEXT)');
  helper._setTransactionRetryDelayForTests(() => { throw new Error('unexpected retry'); });
  const completed = [];
  const record = (name) => (result) => { completed.push(name); return result; };
  const operations = [
    db.run("INSERT INTO sample VALUES ('run')").then(record('run')),
    db.transaction(async (tx) => {
      await tx.run("INSERT INTO sample VALUES ('transaction')");
      return 'transaction-result';
    }).then(record('transaction')),
    db.exec("INSERT INTO sample VALUES ('exec')").then(record('exec')),
    db.get('SELECT count(*) AS count FROM sample').then(record('get'))
  ];
  const results = await Promise.all(operations);
  assert.deepEqual(completed, ['run', 'transaction', 'exec', 'get']);
  assert.equal(results[1], 'transaction-result');
  assert.equal(results[3].count, 3);
  assert.deepEqual((await db.all('SELECT value FROM sample ORDER BY rowid')).map((row) => row.value),
    ['run', 'transaction', 'exec']);
});

test('backoff releases the queue for run, get and the manual transaction statements', { timeout: 2000 }, async (t) => {
  const { helper, db } = fixture(t);
  await db.exec('CREATE TABLE sample(value TEXT)');
  await db.run('BEGIN IMMEDIATE');
  const waiting = Promise.withResolvers();
  const resume = Promise.withResolvers();
  helper._setTransactionRetryDelayForTests((ms) => {
    waiting.resolve(ms);
    return resume.promise;
  });
  let executions = 0;
  const pending = db.transaction(async (tx) => {
    executions += 1;
    await tx.run("INSERT INTO sample VALUES ('retried')");
  });
  try {
    assert.equal(await waiting.promise, 100);
    await db.run("INSERT INTO sample VALUES ('manual')");
    assert.equal((await db.get('SELECT count(*) AS count FROM sample')).count, 1);
    await db.run('COMMIT');
    assert.equal(executions, 0, 'the executor waits for the backoff to end');
  } finally {
    resume.resolve();
    await pending;
  }
  assert.equal(executions, 1);
  assert.equal((await db.get('SELECT count(*) AS count FROM sample')).count, 2);
});
