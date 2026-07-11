'use strict';
// Full-taxonomy synthetic-drift suite: every diff class is exercised, plus the
// must-not-fail cases (formatting-only, sqlite_sequence) and FK comparison.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { snapshotSchema, compareSchemas } = require('./semantic-schema-compare');

let seq = 0;
async function snapOf(sql) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sscmp-')), `t${seq++}.db`);
  const runner = cliRunner(db);
  await runner.exec(sql);
  return snapshotSchema(runner);
}

const BASE = `
CREATE TABLE t1 (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'x',
  v REAL CHECK (v > 0)
);
CREATE INDEX idx_t1 ON t1(name, v);
CREATE TRIGGER trg_t1 AFTER INSERT ON t1 BEGIN UPDATE t1 SET name = 'y' WHERE id = NEW.id; END;
`;

test('identical schemas: ok, zero diffs', async () => {
  const res = compareSchemas(await snapOf(BASE), await snapOf(BASE), await snapOf(BASE));
  assert.equal(res.ok, true);
  assert.deepEqual(res.diffs, []);
});

test('whitespace/case/quote-only differences do NOT fail', async () => {
  const live = await snapOf(`
CREATE TABLE t1 (id INTEGER PRIMARY KEY, "name" text NOT NULL DEFAULT 'x', v REAL check(v   >   0));
CREATE INDEX idx_t1 ON t1("name", v);
CREATE TRIGGER trg_t1 AFTER INSERT ON t1 BEGIN update t1 set "name" = 'y' where id = NEW.id; END;
`);
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
});

test('extra unknown column FAILS', async () => {
  const live = await snapOf(BASE + 'ALTER TABLE t1 ADD COLUMN rogue TEXT;');
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['extra_unknown', 'column', 't1.rogue']]);
});

test('missing trigger FAILS', async () => {
  const live = await snapOf(BASE + 'DROP TRIGGER trg_t1;');
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['missing', 'trigger', 'trg_t1']]);
});

test('changed column default FAILS', async () => {
  const live = await snapOf(BASE.replace("DEFAULT 'x'", "DEFAULT 'z'"));
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['changed', 'column', 't1.name']]);
});

test('changed foreign key action FAILS', async () => {
  const ref = await snapOf(`
CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
);`);
  const live = await snapOf(`
CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE NO ACTION
);`);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['changed', 'foreign_key', 'child']]);
});

const FORWARD = 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0));';

test('live extra identical to a reference(head) forward object is tolerated', async () => {
  const live = await snapOf(BASE + FORWARD);
  const ref = await snapOf(BASE);
  const head = await snapOf(BASE + FORWARD);
  const res = compareSchemas(live, ref, head);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['extra_forward', 'table', 't2']]);
});

test('live extra NOT identical to the head object is extra_unknown', async () => {
  const live = await snapOf(BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER);');
  const ref = await snapOf(BASE);
  const head = await snapOf(BASE + FORWARD);
  const res = compareSchemas(live, ref, head);
  assert.equal(res.ok, false);
  assert.equal(res.diffs[0].class, 'extra_unknown');
});

const CHAM = 'CREATE TABLE chameleon_readings (id INTEGER PRIMARY KEY, deveui TEXT NOT NULL);';

test('chameleon swt_1/2/3 allowlist entries are tolerated by name', async () => {
  const live = await snapOf(BASE + CHAM + `
ALTER TABLE chameleon_readings ADD COLUMN swt_1 REAL;
ALTER TABLE chameleon_readings ADD COLUMN swt_2 REAL;
ALTER TABLE chameleon_readings ADD COLUMN swt_3 REAL;`);
  const ref = await snapOf(BASE + CHAM);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
  assert.deepEqual(res.diffs.map((d) => d.class),
    ['extra_allowlisted', 'extra_allowlisted', 'extra_allowlisted']);
});

test('sqlite_sequence presence difference is ignored', async () => {
  const SEQT = 'CREATE TABLE s (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT);';
  const live = await snapOf(BASE + SEQT + "INSERT INTO s (x) VALUES ('row');");
  const ref = await snapOf(BASE + SEQT);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
});
