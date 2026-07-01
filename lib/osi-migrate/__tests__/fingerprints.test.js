'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { computeFingerprints } = require('../fingerprints');

function tmpDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-fp-')), 't.db'); }

test('identical schemas produce identical fingerprints; a column change differs', async () => {
  const a = cliRunner(tmpDb());
  const b = cliRunner(tmpDb());
  const schema = 'CREATE TABLE devices (id INTEGER PRIMARY KEY, deveui TEXT);';
  await a.exec(schema);
  await b.exec(schema);
  const fa = await computeFingerprints(a);
  const fb = await computeFingerprints(b);
  assert.deepEqual(fa, fb);

  const c = cliRunner(tmpDb());
  await c.exec('CREATE TABLE devices (id INTEGER PRIMARY KEY, deveui TEXT, extra INTEGER);');
  const fc = await computeFingerprints(c);
  const fpDevicesA = fa.find((x) => x.object_name === 'devices').fingerprint;
  const fpDevicesC = fc.find((x) => x.object_name === 'devices').fingerprint;
  assert.notEqual(fpDevicesA, fpDevicesC);
});

test('whitespace-only trigger differences fingerprint identically', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec("CREATE TABLE t (x INTEGER); CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET x=1; END;");
  await b.exec("CREATE TABLE t (x INTEGER);\nCREATE TRIGGER trg AFTER INSERT ON t\nBEGIN\n  UPDATE t SET x=1;\nEND;");
  const fa = (await computeFingerprints(a)).find((x) => x.object_type === 'trigger');
  const fb = (await computeFingerprints(b)).find((x) => x.object_type === 'trigger');
  assert.equal(fa.fingerprint, fb.fingerprint);
});

test('CHECK constraint change is detected (the LORAIN drift class)', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec("CREATE TABLE d (id INTEGER, t TEXT CHECK(t IN ('A')));");
  await b.exec("CREATE TABLE d (id INTEGER, t TEXT CHECK(t IN ('A','B')));");
  const fa = (await computeFingerprints(a)).find((x) => x.object_name === 'd');
  const fb = (await computeFingerprints(b)).find((x) => x.object_name === 'd');
  assert.notEqual(fa.fingerprint, fb.fingerprint);
});

test('partial-index predicate change is detected', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec('CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t(x) WHERE x IS NOT NULL;');
  await b.exec('CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t(x) WHERE x > 0;');
  const fa = (await computeFingerprints(a)).find((x) => x.object_type === 'index' && x.object_name === 'ix');
  const fb = (await computeFingerprints(b)).find((x) => x.object_type === 'index' && x.object_name === 'ix');
  assert.notEqual(fa.fingerprint, fb.fingerprint);
});

test('trigger string-literal case is significant', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec("CREATE TABLE t (s TEXT); CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE t SET s='A'; END;");
  await b.exec("CREATE TABLE t (s TEXT); CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE t SET s='a'; END;");
  const fa = (await computeFingerprints(a)).find((x) => x.object_type === 'trigger');
  const fb = (await computeFingerprints(b)).find((x) => x.object_type === 'trigger');
  assert.notEqual(fa.fingerprint, fb.fingerprint);
});

test('quoted table and index identifiers fingerprint without PRAGMA syntax errors', async () => {
  const r = cliRunner(tmpDb());
  await r.exec('CREATE TABLE "odd table" ("id value" INTEGER); CREATE INDEX "odd index" ON "odd table"("id value");');
  const fps = await computeFingerprints(r);
  assert.ok(fps.find((x) => x.object_type === 'table' && x.object_name === 'odd table'));
  assert.ok(fps.find((x) => x.object_type === 'index' && x.object_name === 'odd index'));
});

test('SQLite engine version is not part of schema fingerprints', async () => {
  const fakeRunner = (version) => ({
    async all(sql) {
      if (sql === 'SELECT sqlite_version() AS v') return [{ v: version }];
      if (sql.startsWith('SELECT type, name, sql FROM sqlite_master')) {
        return [{ type: 'table', name: 't', sql: 'CREATE TABLE t (id INTEGER)' }];
      }
      if (sql.startsWith('PRAGMA table_xinfo')) return [{ cid: 0, name: 'id', type: 'INTEGER' }];
      if (sql.startsWith('PRAGMA foreign_key_list')) return [];
      if (sql.startsWith('PRAGMA index_list')) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  });
  assert.deepEqual(await computeFingerprints(fakeRunner('3.53.0')), await computeFingerprints(fakeRunner('3.54.0')));
});
