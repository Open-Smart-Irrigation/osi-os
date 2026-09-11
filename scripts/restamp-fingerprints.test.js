'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync, execSync } = require('node:child_process');

// The script logs exclusively via console.error (stderr) so operator-facing
// text never pollutes a machine-parseable stdout stream in the future;
// execFileSync only returns stdout, so these report-mode assertions need
// stderr merged in.
function runNode(args) {
  return execSync(`node ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} 2>&1`, { encoding: 'utf8' });
}
const { applyPending, verifyHead } = require('../lib/osi-migrate/runner');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

test('restamp-fingerprints re-baselines a stale stamp', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  // Introduce a "known-correct" out-of-band change + a stale stamp.
  await r.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY);');
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, false);

  execFileSync('node', [path.join(__dirname, 'restamp-fingerprints.js'), db], { encoding: 'utf8' });

  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true,
    'restamp makes the live schema the new baseline');
});

test('restamp-fingerprints refuses a nonexistent DB path (does not create/stamp an empty file)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-missing-'));
  const missing = path.join(root, 'nope.db');
  let status = 0;
  try {
    execFileSync('node', [path.join(__dirname, 'restamp-fingerprints.js'), missing], { encoding: 'utf8' });
  } catch (e) { status = e.status; }
  assert.strictEqual(status, 2, 'must exit 2 for a missing DB');
  assert.strictEqual(fs.existsSync(missing), false, 'must NOT create the file');
});

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('restamp-fingerprints --report: no diffs -> exit 0, never writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-report-clean-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });

  const before = sha256File(db);
  const out = runNode([path.join(__dirname, 'restamp-fingerprints.js'), db, '--report']);
  const after = sha256File(db);
  assert.strictEqual(before, after, '--report must never write to the database');
  assert.match(out, /no diffs under the current normalizer/);
});

test('restamp-fingerprints --report: real drift -> exit non-zero, never writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-report-drift-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  await r.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY);'); // out-of-band, real drift

  const before = sha256File(db);
  let status = 0; let out = '';
  try {
    execFileSync('node', [path.join(__dirname, 'restamp-fingerprints.js'), db, '--report'], { encoding: 'utf8' });
  } catch (e) { status = e.status; out = (e.stdout || '') + (e.stderr || ''); }
  const after = sha256File(db);
  assert.strictEqual(before, after, '--report must never write to the database even when drift is real');
  assert.notStrictEqual(status, 0, 'real (non-normalizer-only) drift must exit non-zero');
  assert.match(out, /real diffs remain/);
});

test('restamp-fingerprints --report: pure normalizer-scheme bump only -> exit 0, never writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-report-scheme-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // stamped under CURRENT (v3) scheme

  // Overwrite with what a v2-era runner would have stamped for this SAME live schema.
  const { computeFingerprints, PREVIOUS_NORMALIZER_VERSION } = require('../lib/osi-migrate/fingerprints');
  const { composeFingerprintRefresh } = require('../lib/osi-migrate/runner');
  const oldFps = await computeFingerprints(r, { normalizerVersion: PREVIOUS_NORMALIZER_VERSION });
  await r.exec(composeFingerprintRefresh(oldFps));

  const before = sha256File(db);
  const out = runNode([path.join(__dirname, 'restamp-fingerprints.js'), db, '--report']);
  const after = sha256File(db);
  assert.strictEqual(before, after, '--report must never write, even in the tolerated normalizer-only case');
  assert.match(out, /normalizer version bump alone/);
});

test('restamp-fingerprints default (no flags) and --apply both remain backward-compatible: they still restamp unconditionally', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-apply-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  await r.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY);');
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, false);

  execFileSync('node', [path.join(__dirname, 'restamp-fingerprints.js'), db, '--apply'], { encoding: 'utf8' });
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true, '--apply must restamp exactly like the flagless default');
});
