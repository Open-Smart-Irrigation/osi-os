'use strict';
// apply-chameleon-calibration-seed.js must write every bundled seed database
// that scripts/seed-db-paths.js lists, and leave them byte-identical, as the
// seed parity checks require.
//
// The script resolves the repository from its own location, so each test
// copies it, seed-db-paths.js, the seed SQL and the seven bundled databases
// into a temporary tree and runs it there. The tracked databases are only
// read.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const { SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');
const SEED_SQL_REL = 'database/seeds/chameleon-calibrations.sql';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sandbox({ seedSql = fs.readFileSync(path.join(REPO, SEED_SQL_REL), 'utf8'), omit = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-calibration-seed-'));
  for (const rel of ['scripts/apply-chameleon-calibration-seed.js', 'scripts/seed-db-paths.js']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  fs.mkdirSync(path.dirname(path.join(root, SEED_SQL_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, SEED_SQL_REL), seedSql);
  for (const rel of SEED_DB_RELATIVE_PATHS) {
    if (rel === omit) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  return root;
}

function runApply(root, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/apply-chameleon-calibration-seed.js'), ...args], {
    encoding: 'utf8',
  });
}

function calibrationRows(dbPath) {
  return Number(execFileSync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM chameleon_calibrations;'], { encoding: 'utf8' }).trim());
}

const SYNTHETIC_SEED = [
  '-- test seed',
  "INSERT OR IGNORE INTO chameleon_calibrations (array_id, sensor_id, sensor1_a, sensor1_b, sensor1_c, sensor1_r2, sensor2_a, sensor2_b, sensor2_c, sensor2_r2, sensor3_a, sensor3_b, sensor3_c, sensor3_r2, test_rig_run_start_date, source, fetched_at) VALUES ('TEST-ARRAY-1', 'T001', 9.6, 0.2, 7.0, 0.99, 9.6, 0.2, 7.0, 0.99, 9.6, 0.2, 7.0, 0.99, '2024-01-01T00:00:00Z', 'bundled', '2026-01-01T00:00:00Z');",
  "INSERT OR IGNORE INTO chameleon_calibrations (array_id, sensor_id, sensor1_a, sensor1_b, sensor1_c, sensor1_r2, sensor2_a, sensor2_b, sensor2_c, sensor2_r2, sensor3_a, sensor3_b, sensor3_c, sensor3_r2, test_rig_run_start_date, source, fetched_at) VALUES ('TEST-ARRAY-2', 'T002', 9.6, 0.2, 7.0, 0.99, 9.6, 0.2, 7.0, 0.99, 9.6, 0.2, 7.0, 0.99, '2024-01-01T00:00:00Z', 'bundled', '2026-01-01T00:00:00Z');",
  '',
].join('\n');

test('the seed lands in all seven bundled databases and they stay byte-identical', () => {
  const root = sandbox({ seedSql: SYNTHETIC_SEED });
  try {
    const before = sha256(path.join(root, SEED_DB_RELATIVE_PATHS[0]));
    const r = runApply(root, ['--require-rows']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const hashes = new Set();
    for (const rel of SEED_DB_RELATIVE_PATHS) {
      const dbPath = path.join(root, rel);
      assert.equal(calibrationRows(dbPath), 2, `${rel} must hold the seeded rows`);
      hashes.add(sha256(dbPath));
    }
    assert.equal(hashes.size, 1, 'all seven seed images must stay byte-identical');
    assert.ok(!hashes.has(before), 'the images must have changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the bundled seed SQL applies to every target', () => {
  const root = sandbox();
  try {
    const r = runApply(root);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const expected = (fs.readFileSync(path.join(REPO, SEED_SQL_REL), 'utf8').match(/INSERT OR IGNORE INTO chameleon_calibrations/g) || []).length;
    for (const rel of SEED_DB_RELATIVE_PATHS) {
      assert.equal(calibrationRows(path.join(root, rel)), expected, rel);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing target fails before any database is written', () => {
  const omit = SEED_DB_RELATIVE_PATHS[SEED_DB_RELATIVE_PATHS.length - 1];
  const root = sandbox({ seedSql: SYNTHETIC_SEED, omit });
  try {
    const before = SEED_DB_RELATIVE_PATHS.filter((rel) => rel !== omit).map((rel) => sha256(path.join(root, rel)));
    const r = runApply(root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /missing database/);
    const after = SEED_DB_RELATIVE_PATHS.filter((rel) => rel !== omit).map((rel) => sha256(path.join(root, rel)));
    assert.deepEqual(after, before, 'no database may change when one target is missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--require-rows refuses an empty seed and writes nothing', () => {
  const root = sandbox({ seedSql: '-- no rows\n' });
  try {
    const before = SEED_DB_RELATIVE_PATHS.map((rel) => sha256(path.join(root, rel)));
    const r = runApply(root, ['--require-rows']);
    assert.notEqual(r.status, 0);
    assert.deepEqual(SEED_DB_RELATIVE_PATHS.map((rel) => sha256(path.join(root, rel))), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failure in one image leaves all seven unchanged and no temporary files', () => {
  const root = sandbox({ seedSql: SYNTHETIC_SEED });
  try {
    const broken = SEED_DB_RELATIVE_PATHS[SEED_DB_RELATIVE_PATHS.length - 1];
    execFileSync('sqlite3', [path.join(root, broken), 'DROP TABLE chameleon_calibrations;']);
    const before = SEED_DB_RELATIVE_PATHS.map((rel) => sha256(path.join(root, rel)));
    const r = runApply(root);
    assert.notEqual(r.status, 0, 'the run must fail');
    assert.deepEqual(SEED_DB_RELATIVE_PATHS.map((rel) => sha256(path.join(root, rel))), before,
      'no image may change when one of them fails');
    for (const rel of SEED_DB_RELATIVE_PATHS) {
      const dir = path.dirname(path.join(root, rel));
      const strays = fs.readdirSync(dir).filter((f) => f !== 'farming.db' && f.startsWith('farming.db'));
      assert.deepEqual(strays, [], `${rel}: temporary files left behind`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
