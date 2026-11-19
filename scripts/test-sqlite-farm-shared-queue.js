'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSqlite3Adapter } = require('./lib/sqlite3-node-adapter');
const MODS = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const HELPER = path.join(MODS, 'osi-db-helper/index.js');
const NODE_FILE = path.join(MODS, 'nodes/osi-sqlite-serialize.js');
const SHARED = Symbol.for('osi.flowsDbShared');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sqlite-shared-'));
  const filename = path.join(dir, 'farm.db');
  const adapter = createSqlite3Adapter(), handles = [];
  const Base = adapter.Database;
  adapter.Database = class extends Base { constructor(...args) { super(...args); handles.push(this); } };
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === HELPER) return adapter;
    return original.call(this, request, parent, isMain);
  };
  let helper;
  try { delete require.cache[HELPER]; helper = require(HELPER); }
  finally { Module._load = original; }
  const db = new helper.Database(filename);
  t.after(() => { for (const h of handles) h.native.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, helper };
}

function runtime(helper, { unavailable = false, mode = 'RWC' } = {}) {
  const events = new EventEmitter(), errors = [], state = new Map();
  let constructions = 0, serializations = 0, nativeCalls = 0;
  const native = { serialize() { serializations++; } };
  for (const method of ['all', 'run', 'exec']) native[method] = () => { nativeCalls++; assert.fail('native farm query bypassed the shared queue'); };
  const config = { dbname: '/data/db/farming.db', mod: mode, db: native, context: () => ({ global: { get: (key) => state.get(key), set: (key, value) => state.set(key, value) } }) };
  const RED = {
    events, log: { error: (text) => errors.push(text) },
    nodes: {
      eachNode: (fn) => [{ id: 'config', type: 'sqlitedb' }, { id: 'query', type: 'sqlite', mydb: 'config' }].forEach(fn),
      getNode: (id) => id === 'config' ? config : id === 'query' ? {} : null,
    },
  };
  require(NODE_FILE)(RED);
  function start() {
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'osi-db-helper' && parent && parent.filename === NODE_FILE) {
        if (unavailable) throw new Error('helper unavailable');
        return { Database: function(filename) { assert.equal(filename, '/data/db/farming.db'); constructions++; return new helper.Database(); } };
      }
      return original.call(this, request, parent, isMain);
    };
    try { events.emit('flows:started'); } finally { Module._load = original; }
  }
  const query = (method, sql, params) => new Promise((resolve, reject) => {
    const cb = function(error, rows) { if (error) reject(error); else resolve(method === 'run' ? { changes: this.changes, lastID: this.lastID } : rows); };
    const result = params === undefined ? native[method](sql, cb) : native[method](sql, params, cb);
    assert.strictEqual(result, native, 'sqlite3 chainable return value');
  });
  return { native, start, query, errors, state, counts: () => ({ constructions, serializations, nativeCalls }) };
}

test('farm SQLite msg.topic/fixed/prepared/batch operations use the helper and keep callback results', async (t) => {
  const { db, helper } = fixture(t);
  await db.exec('CREATE TABLE samples(id INTEGER PRIMARY KEY, value TEXT)');
  const rt = runtime(helper);
  rt.start(); rt.start();
  assert.equal(rt.native[SHARED], true);
  assert.deepEqual(await rt.query('all', 'INSERT INTO samples(value) VALUES ($value)', { $value: 'prepared' }), []);
  assert.equal((await rt.query('all', 'SELECT value FROM samples WHERE value=?', ['prepared']))[0].value, 'prepared');
  assert.equal((await rt.query('all', 'SELECT last_insert_rowid() AS id'))[0].id, 1);
  assert.deepEqual(await rt.query('run', "INSERT INTO samples(value) VALUES ('run')"), { changes: 1, lastID: 2 });
  assert.equal(await rt.query('exec', "INSERT INTO samples(value) VALUES ('batch-1'); INSERT INTO samples(value) VALUES ('batch-2');"), undefined);
  assert.equal((await db.get('SELECT count(*) AS count FROM samples')).count, 4);
  await assert.rejects(rt.query('all', 'SELECT * FROM missing'), /missing/);
  await assert.rejects(rt.query('exec', 'INVALID SQL'), /syntax/);
  assert.deepEqual(rt.errors, []);
  assert.deepEqual(rt.counts(), { constructions: 1, serializations: 1, nativeCalls: 0 });
});

for (const method of ['all', 'run', 'exec']) {
  test(`connection B ${method} waits outside an owner rollback and survives it`, { timeout: 2000 }, async (t) => {
    const { db, helper } = fixture(t);
    await db.exec('CREATE TABLE samples(value TEXT)');
    const rt = runtime(helper); rt.start();
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const failure = new Error('owner failed');
    const owner = db.transaction(async (tx) => { await tx.run("INSERT INTO samples VALUES ('owner')"); enter(); await held; throw failure; });
    const rejected = assert.rejects(owner, (e) => e === failure);
    await entered;
    let delivered = false;
    const foreign = rt.query(method, "INSERT INTO samples VALUES ('connection B')").then(() => { delivered = true; });
    const another = db.transaction(async (tx) => { await tx.run("INSERT INTO samples VALUES ('another transaction')"); });
    await new Promise(setImmediate);
    assert.equal(delivered, false);
    release();
    await Promise.all([rejected, foreign, another]);
    assert.deepEqual((await db.all('SELECT value FROM samples ORDER BY rowid')).map((row) => row.value), ['connection B', 'another transaction']);
    assert.equal(rt.counts().nativeCalls, 0);
  });
}

test('a missing helper refuses farm queries and records degraded health', async (t) => {
  const { helper } = fixture(t);
  const rt = runtime(helper, { unavailable: true }); rt.start();
  for (const method of ['all', 'run', 'exec']) await assert.rejects(rt.query(method, 'SELECT 1'), /helper unavailable/);
  assert.equal(rt.native[SHARED], undefined);
  assert.equal(rt.state.get('error_counts').total, 1);
  assert.equal(rt.counts().nativeCalls, 0);
});

test('a read-only farm configuration keeps its native read-only permission', async (t) => {
  const { helper } = fixture(t);
  const rt = runtime(helper, { mode: 'RO' }); rt.start();
  assert.equal(rt.native[SHARED], undefined);
  assert.deepEqual(rt.counts(), { constructions: 0, serializations: 1, nativeCalls: 0 });
});
