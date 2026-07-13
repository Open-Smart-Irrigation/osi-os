#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js'
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-db-snapshot-'));
const dbPath = path.join(tempRoot, 'snapshot.db');
let opened = 0;
let closed = 0;

function adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      opened += 1;
      queueMicrotask(() => callback && callback.call(this, null));
    }

    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const rows = this.native.prepare(sql).all(...(params || []));
        callback.call(this, null, rows);
      } catch (error) {
        callback.call(this, error);
      }
    }

    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes) }, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    exec(sql, callback) {
      try {
        this.native.exec(sql);
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    close(callback) {
      try {
        this.native.close();
        closed += 1;
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function loadHelper() {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) return adapter();
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
  } finally {
    Module._load = original;
  }
}

const native = new DatabaseSync(dbPath);
native.exec(
  'PRAGMA journal_mode=WAL; ' +
  'CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); ' +
  'CREATE TABLE sample_child(id INTEGER PRIMARY KEY,parent_id INTEGER,value TEXT);'
);
const parent = native.prepare('INSERT INTO sample(value) VALUES (?)').run('before');
native.prepare('INSERT INTO sample_child(parent_id,value) VALUES (?,?)')
  .run(Number(parent.lastInsertRowid), 'before-child');
native.close();
const helper = loadHelper();

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('readSnapshot commits a read-only snapshot and physically closes its connection', async () => {
  const beforeOpened = opened;
  const beforeClosed = closed;
  const db = new helper.Database(dbPath);
  const rows = await db.readSnapshot((snapshot) => snapshot.all('SELECT * FROM sample ORDER BY id'));
  assert.deepEqual(rows.map((row) => ({ id: row.id, value: row.value })), [{ id: 1, value: 'before' }]);
  assert.equal(opened, beforeOpened + 2, 'shared facade plus separate snapshot connection opened');
  assert.equal(closed, beforeClosed + 1, 'snapshot connection physically closed');
});

test('readSnapshot rolls back and physically closes after executor failure', async () => {
  const db = new helper.Database(dbPath);
  const beforeClosed = closed;
  await assert.rejects(
    db.readSnapshot(async (snapshot) => {
      await snapshot.get('SELECT * FROM sample LIMIT 1');
      throw new Error('injected snapshot failure');
    }),
    /injected snapshot failure/
  );
  assert.equal(closed, beforeClosed + 1);
});

test('readSnapshot enforces query_only', async () => {
  const db = new helper.Database(dbPath);
  await assert.rejects(
    db.readSnapshot((snapshot) => snapshot.run("INSERT INTO sample(value) VALUES ('forbidden')")),
    /read.?only|readonly|attempt to write/i
  );
});

test('readSnapshot pins parent and child queries across a concurrent WAL writer', async () => {
  const db = new helper.Database(dbPath);
  const writer = new DatabaseSync(dbPath);
  try {
    const old = await db.readSnapshot(async (snapshot) => {
      const parentRow = await snapshot.get('SELECT * FROM sample WHERE id=1');
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare('UPDATE sample SET value=? WHERE id=1').run('after');
      writer.prepare('INSERT INTO sample_child(parent_id,value) VALUES (?,?)').run(1, 'after-child');
      writer.exec('COMMIT');
      const children = await snapshot.all('SELECT value FROM sample_child WHERE parent_id=1 ORDER BY id');
      assert.equal(snapshot.readSnapshot, undefined, 'snapshot scopes cannot fake nested snapshots');
      return { parent: parentRow.value, children: children.map((row) => row.value) };
    });
    assert.deepEqual(old, { parent: 'before', children: ['before-child'] });
    const fresh = await db.readSnapshot(async (snapshot) => ({
      parent: (await snapshot.get('SELECT * FROM sample WHERE id=1')).value,
      children: (await snapshot.all('SELECT value FROM sample_child WHERE parent_id=1 ORDER BY id'))
        .map((row) => row.value),
    }));
    assert.deepEqual(fresh, {
      parent: 'after',
      children: ['before-child', 'after-child'],
    });
    await db.transaction(async (transaction) => {
      assert.equal(transaction.readSnapshot, undefined, 'writer scopes do not nest read snapshots');
    });
  } finally {
    writer.close();
  }
});
