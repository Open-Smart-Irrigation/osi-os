'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scratchDir, copyFixture, assertFixtureUnchanged, funcText, makeFacadeShim, emitArtifact } = require('./rig');

const REPO = path.resolve(__dirname, '..', '..');

test('scratchDir creates a unique writable directory', () => {
  const a = scratchDir('rigtest-');
  const b = scratchDir('rigtest-');
  assert.notEqual(a, b);
  assert.ok(fs.existsSync(a) && fs.statSync(a).isDirectory());
  fs.writeFileSync(path.join(a, 'probe'), 'ok');
  assert.equal(fs.readFileSync(path.join(a, 'probe'), 'utf8'), 'ok');
});

test('copyFixture copies a DB and reports the source hash; assertFixtureUnchanged passes when untouched', () => {
  const srcDir = scratchDir('rigsrc-');
  const src = path.join(srcDir, 'source.db');
  fs.writeFileSync(src, 'PRAGMA user_version=1;'); // opaque bytes are fine for the hash test
  const { dbPath, srcSha256 } = copyFixture(src, scratchDir('rigdst-'));
  assert.ok(fs.existsSync(dbPath));
  assert.equal(srcSha256, crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex'));
  fs.writeFileSync(dbPath, 'MUTATED COPY'); // mutating the COPY must not trip the source guard
  assert.doesNotThrow(() => assertFixtureUnchanged(src, srcSha256));
});

test('assertFixtureUnchanged THROWS if the source fixture was modified (the farm-data guard)', () => {
  const src = path.join(scratchDir('rigsrc2-'), 'source.db');
  fs.writeFileSync(src, 'original');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  fs.writeFileSync(src, 'TAMPERED');
  assert.throws(() => assertFixtureUnchanged(src, sha), /fixture changed/i);
});

test('funcText pulls the REAL function body of a flows node by id', () => {
  const body = funcText('sync-outbox-build'); // "Build Edge Event Batch" — verified to exist
  assert.match(body, /LIMIT\s+100/, 'the real outbox drain caps at LIMIT 100');
});

test('makeFacadeShim exposes the osi-db-helper surface over a real node:sqlite DB', async () => {
  const db = path.join(scratchDir('rigshim-'), 'f.db');
  const shim = makeFacadeShim(db);
  await shim.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
  await shim.run("INSERT INTO t (v) VALUES ('x')");
  assert.deepEqual(await shim.all('SELECT v FROM t'), [{ v: 'x' }]);
  assert.deepEqual(await shim.get('SELECT COUNT(*) c FROM t'), { c: 1 });
  await shim.transaction(async (s) => { await s.run("INSERT INTO t (v) VALUES ('y')"); });
  assert.equal((await shim.get('SELECT COUNT(*) c FROM t')).c, 2);
  await new Promise((res) => shim.close(res));
});

test('emitArtifact writes a JSON evidence file and returns its path', () => {
  const dir = scratchDir('rigart-');
  const p = emitArtifact(dir, 'demo', { outcome: 'pass', invariants: { rows: 3 }, timingsMs: 12 });
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(doc.scenario, 'demo');
  assert.equal(doc.outcome, 'pass');
  assert.equal(doc.invariants.rows, 3);
  assert.equal(typeof doc.timestamp, 'string');
});
