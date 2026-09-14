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

// --- osi-os#221 characterisation ------------------------------------------
// #221 asks the runner's drift gate to tolerate a `table|devices` diff. No such
// diff shape exists. These pin the emitted taxonomy so the next reader does not
// have to re-derive it from the source: `table` diffs carry only `missing`,
// `extra_forward` or `extra_unknown`, and a table whose CONTENTS changed is
// always reported as `column`, `check` or `foreign_key`.

test('a dropped table is missing|table, never changed|table', async () => {
  const live = await snapOf('CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]).sort(), [
    ['changed', 'check', 't1'],
    ['missing', 'column', 't1.name'],
    ['missing', 'column', 't1.v'],
    ['missing', 'index', 'idx_t1'],
    ['missing', 'trigger', 'trg_t1'],
  ]);
});

test('a reference table absent from the live DB is missing|table', async () => {
  const live = await snapOf(BASE);
  const ref = await snapOf(BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY);');
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['missing', 'table', 't2']]);
});

test('a changed table-level CHECK is changed|check, keyed by table name', async () => {
  const live = await snapOf('CREATE TABLE t1 (id INTEGER PRIMARY KEY, kind TEXT, CHECK (kind IN (\'a\')));');
  const ref = await snapOf('CREATE TABLE t1 (id INTEGER PRIMARY KEY, kind TEXT, CHECK (kind IN (\'a\',\'b\')));');
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['changed', 'check', 't1']]);
  assert.match(res.diffs[0].detail, /liveOnly=\[.*'a'.*\] refOnly=\[.*'b'.*\]/);
});

test('a live-only CHECK present in reference(head) is extra_forward|check', async () => {
  const live = await snapOf('CREATE TABLE t1 (id INTEGER PRIMARY KEY, kind TEXT CHECK (kind IN (\'a\')));');
  const ref = await snapOf('CREATE TABLE t1 (id INTEGER PRIMARY KEY, kind TEXT);');
  const head = await snapOf('CREATE TABLE t1 (id INTEGER PRIMARY KEY, kind TEXT CHECK (kind IN (\'a\')));');
  const res = compareSchemas(live, ref, head);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['extra_forward', 'check', 't1']]);
});

test('a live-only FK present in reference(head) is extra_forward|foreign_key', async () => {
  const PARENT = 'CREATE TABLE parent (id INTEGER PRIMARY KEY);';
  const WITH_FK = PARENT + 'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER '
    + 'REFERENCES parent(id) ON DELETE CASCADE);';
  const live = await snapOf(WITH_FK);
  const ref = await snapOf(PARENT + 'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER);');
  const head = await snapOf(WITH_FK);
  const res = compareSchemas(live, ref, head);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['extra_forward', 'foreign_key', 'child']]);
});

test('compareSchemas never emits a changed|table diff for any drift shape', async () => {
  const ref = await snapOf(BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER REFERENCES t1(id));');
  const shapes = [
    BASE,                                                             // table dropped
    BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER);',        // FK removed
    BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER REFERENCES t1(id), extra TEXT);',
    BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n TEXT REFERENCES t1(id));', // column retyped
    BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER REFERENCES t1(id), CHECK (k <> \'\'));',
    BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER REFERENCES t1(id));'
      + 'CREATE TABLE t3 (z TEXT);',                                  // live-only table
  ];
  for (const sql of shapes) {
    const res = compareSchemas(await snapOf(sql), ref, ref);
    // Without this the sweep would pass vacuously on any shape the comparator
    // reports nothing for.
    assert.equal(res.ok, false, `expected drift for shape:\n${sql}\n${JSON.stringify(res.diffs)}`);
    for (const d of res.diffs) {
      assert.notEqual(`${d.class}|${d.kind}`, 'changed|table',
        `unexpected changed|table diff for shape:\n${sql}\n${JSON.stringify(d)}`);
      if (d.kind === 'table') {
        assert.ok(['missing', 'extra_forward', 'extra_unknown'].includes(d.class),
          `table diffs carry only missing/extra_forward/extra_unknown, got ${d.class}`);
      }
    }
  }
});

test('sqlite_sequence presence difference is ignored', async () => {
  const SEQT = 'CREATE TABLE s (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT);';
  const live = await snapOf(BASE + SEQT + "INSERT INTO s (x) VALUES ('row');");
  const ref = await snapOf(BASE + SEQT);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
});
