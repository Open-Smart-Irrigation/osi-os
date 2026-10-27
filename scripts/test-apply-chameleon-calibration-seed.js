'use strict';
// Run the writer only from temporary repository-shaped trees. Source images
// are hashed before fixture setup and checked again after every test case.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const { SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');
const SEED_SQL_REL = 'database/seeds/chameleon-calibrations.sql';
const EXPECTED_PATHS = [
  'conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
];
const COLUMNS = [
  'array_id', 'sensor_id', 'sensor1_a', 'sensor1_b', 'sensor1_c', 'sensor1_r2',
  'sensor2_a', 'sensor2_b', 'sensor2_c', 'sensor2_r2',
  'sensor3_a', 'sensor3_b', 'sensor3_c', 'sensor3_r2',
  'test_rig_run_start_date', 'source', 'fetched_at',
];
const SELECT_ROWS = `SELECT ${COLUMNS.join(', ')} FROM chameleon_calibrations ORDER BY array_id;`;
const SOURCE_IMAGE_HASHES = new Map(EXPECTED_PATHS.map((rel) => [rel, sha256(path.join(REPO, rel))]));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function failRedacted(rel, kind, column = '') {
  throw new Error(`${rel}: ${kind}${column ? ` (${column})` : ''}`);
}

function assertSourceImagesUnchanged() {
  for (const rel of EXPECTED_PATHS) {
    if (sha256(path.join(REPO, rel)) !== SOURCE_IMAGE_HASHES.get(rel)) {
      failRedacted(rel, 'source-image-changed');
    }
  }
}

function assertManifest(manifest, rel = 'scripts/seed-db-paths.js') {
  if (manifest.length !== EXPECTED_PATHS.length || manifest.some((item, i) => item !== EXPECTED_PATHS[i])) {
    failRedacted(rel, 'seven-path');
  }
}

function sandbox({ seedSql = fs.readFileSync(path.join(REPO, SEED_SQL_REL), 'utf8'), omit = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-calibration-seed-'));
  try {
    assertManifest(SEED_DB_RELATIVE_PATHS);
    for (const rel of ['scripts/apply-chameleon-calibration-seed.js', 'scripts/seed-db-paths.js']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    }
    if (process.env.ISSUE410_MUTATION === 'short-manifest') {
      const manifestPath = path.join(root, 'scripts/seed-db-paths.js');
      const source = fs.readFileSync(manifestPath, 'utf8');
      fs.writeFileSync(manifestPath, source.replace(/,\s*'web\/react-gui\/farming\.db'/, ''));
    }
    const copiedManifest = require(path.join(root, 'scripts/seed-db-paths.js')).SEED_DB_RELATIVE_PATHS;
    assertManifest(copiedManifest, 'scripts/seed-db-paths.js');
    fs.mkdirSync(path.dirname(path.join(root, SEED_SQL_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, SEED_SQL_REL), seedSql);
    for (const rel of EXPECTED_PATHS) {
      if (rel === omit) continue;
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    }
    return root;
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

function withSandbox(options, run) {
  let root;
  try {
    root = sandbox(options);
    return run(root);
  } finally {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    assertSourceImagesUnchanged();
  }
}

function runApply(root, args = [], label = 'fixture') {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/apply-chameleon-calibration-seed.js'), ...args], {
    encoding: 'utf8',
  });
  if (r.error || r.signal || r.status !== 0) {
    const outcome = r.signal ? `signal ${r.signal}` : `status ${r.status}`;
    throw new Error(`${label}: ${outcome} writer-exit`);
  }
  return r;
}

function runSql(dbPath, sql, rel, kind = 'fixture-sql') {
  const r = spawnSync('sqlite3', ['-bail', dbPath, sql], { encoding: 'utf8' });
  if (r.error || r.signal || r.status !== 0) {
    const outcome = r.signal ? `signal ${r.signal}` : `status ${r.status}`;
    failRedacted(rel, `${kind} ${outcome}`);
  }
}

function rows(dbPath, rel) {
  const r = spawnSync('sqlite3', ['-readonly', '-json', dbPath, SELECT_ROWS], { encoding: 'utf8' });
  if (r.error || r.signal || r.status !== 0) failRedacted(rel, 'row-query');
  if (typeof r.stdout !== 'string') failRedacted(rel, 'row-json');
  const out = r.stdout.trim();
  if (out === '') return [];
  let result;
  try {
    result = JSON.parse(out);
  } catch {
    failRedacted(rel, 'row-json');
  }
  if (!Array.isArray(result)) failRedacted(rel, 'row-json');
  return result;
}

function compareRows(actual, expected, rel, mismatch = 'field-value') {
  if (actual.length !== expected.length) failRedacted(rel, 'key-set');
  const actualByKey = new Map(actual.map((row) => [row.array_id, row]));
  const expectedByKey = new Map(expected.map((row) => [row.array_id, row]));
  if (actualByKey.size !== actual.length || expectedByKey.size !== expected.length || actualByKey.size !== expectedByKey.size) {
    failRedacted(rel, 'key-set');
  }
  for (const key of expectedByKey.keys()) {
    if (!actualByKey.has(key)) failRedacted(rel, 'key-set');
  }
  for (const [key, expectedRow] of expectedByKey) {
    const actualRow = actualByKey.get(key);
    for (const column of COLUMNS) {
      if (!Object.is(actualRow[column], expectedRow[column])) failRedacted(rel, mismatch, column);
    }
  }
}

function clearTable(dbPath, rel) {
  runSql(dbPath, 'DELETE FROM chameleon_calibrations;', rel, 'clear-table');
}

function temporaryRows(root) {
  return EXPECTED_PATHS.map((rel) => rows(path.join(root, rel), rel));
}

function assertParity(rowsByPath) {
  for (let i = 0; i < EXPECTED_PATHS.length; i += 1) {
    compareRows(rowsByPath[i], rowsByPath[0], EXPECTED_PATHS[i]);
  }
}

function inputHashes(root) {
  const hashes = EXPECTED_PATHS.map((rel) => sha256(path.join(root, rel)));
  if (new Set(hashes).size !== 1) failRedacted('seven-targets', 'prepared-input-parity');
  return hashes[0];
}

function assertOutputParity(root, firstHash) {
  const hashes = EXPECTED_PATHS.map((rel) => sha256(path.join(root, rel)));
  if (new Set(hashes).size !== 1 || hashes[0] === firstHash) failRedacted('seven-targets', 'output-parity');
}

function assertNoTemporaryImages(root) {
  for (const rel of EXPECTED_PATHS) {
    const dbPath = path.join(root, rel);
    const dir = path.dirname(dbPath);
    const strays = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => name.startsWith('farming.db') && name !== 'farming.db')
      : [];
    if (strays.length) failRedacted(rel, 'temporary-image');
  }
}

function assertExpectedDiagnostic(r, pattern, rel, label) {
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (!pattern.test(output)) failRedacted(rel, `${label}-diagnostic-absent`);
}

function assertWriterFailed(r, label) {
  if (r.error || r.signal || r.status === 0 || r.status === null) {
    const outcome = r.signal ? `signal ${r.signal}` : `status ${r.status}`;
    throw new Error(`${label}: ${outcome} writer-exit`);
  }
}

function assertHashesUnchanged(root, before, paths = EXPECTED_PATHS) {
  for (const rel of paths) {
    if (sha256(path.join(root, rel)) !== before.get(rel)) failRedacted(rel, 'image-changed');
  }
}

const EXPECTED_S1 = {
  array_id: 'TEST-ARRAY-1', sensor_id: 'T001',
  sensor1_a: 1.1, sensor1_b: 1.2, sensor1_c: 1.3, sensor1_r2: 0.91,
  sensor2_a: 2.1, sensor2_b: 2.2, sensor2_c: 2.3, sensor2_r2: 0.92,
  sensor3_a: 3.1, sensor3_b: 3.2, sensor3_c: 3.3, sensor3_r2: 0.93,
  test_rig_run_start_date: '2024-01-01T00:00:00Z', source: 'bundled', fetched_at: '2026-01-01T00:00:00Z',
};
const EXPECTED_S2 = {
  array_id: 'TEST-ARRAY-2', sensor_id: 'T002',
  sensor1_a: 4.1, sensor1_b: 4.2, sensor1_c: 4.3, sensor1_r2: 0.94,
  sensor2_a: 5.1, sensor2_b: 5.2, sensor2_c: 5.3, sensor2_r2: null,
  sensor3_a: 6.1, sensor3_b: 6.2, sensor3_c: 6.3, sensor3_r2: 0.96,
  test_rig_run_start_date: null, source: 'bundled', fetched_at: '2026-01-02T00:00:00Z',
};
const EXPECTED_UNRELATED = {
  array_id: 'TEST-EXISTING-1', sensor_id: 'T900',
  sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null,
  sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71,
  sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72,
  test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z',
};
const EXPECTED_OVERLAP = {
  array_id: 'TEST-ARRAY-1', sensor_id: 'T901',
  sensor1_a: 81.1, sensor1_b: 81.2, sensor1_c: 81.3, sensor1_r2: null,
  sensor2_a: 82.1, sensor2_b: 82.2, sensor2_c: 82.3, sensor2_r2: 0.82,
  sensor3_a: 83.1, sensor3_b: 83.2, sensor3_c: 83.3, sensor3_r2: 0.83,
  test_rig_run_start_date: '2023-02-01T00:00:00Z', source: 'prior', fetched_at: '2025-02-01T00:00:00Z',
};

const DIVERGENT_ROWS = [
  { array_id: 'TEST-EXISTING-1', sensor_id: 'T900', sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null, sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71, sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72, test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z' },
  { array_id: 'TEST-EXISTING-2', sensor_id: 'T900', sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null, sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71, sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72, test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z' },
  { array_id: 'TEST-EXISTING-3', sensor_id: 'T900', sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null, sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71, sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72, test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z' },
  { array_id: 'TEST-EXISTING-4', sensor_id: 'T900', sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null, sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71, sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72, test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z' },
  { array_id: 'TEST-EXISTING-5', sensor_id: 'T900', sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null, sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71, sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72, test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z' },
  { array_id: 'TEST-EXISTING-6', sensor_id: 'T900', sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null, sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71, sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72, test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z' },
  { array_id: 'TEST-EXISTING-7', sensor_id: 'T900', sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null, sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71, sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72, test_rig_run_start_date: '2023-01-01T00:00:00Z', source: 'prior', fetched_at: '2025-01-01T00:00:00Z' },
];

const SYNTHETIC_SEED = [
  '-- synthetic only',
  "INSERT OR IGNORE INTO chameleon_calibrations (array_id, sensor_id, sensor1_a, sensor1_b, sensor1_c, sensor1_r2, sensor2_a, sensor2_b, sensor2_c, sensor2_r2, sensor3_a, sensor3_b, sensor3_c, sensor3_r2, test_rig_run_start_date, source, fetched_at) VALUES ('TEST-ARRAY-1', 'T001', 1.1, 1.2, 1.3, 0.91, 2.1, 2.2, 2.3, 0.92, 3.1, 3.2, 3.3, 0.93, '2024-01-01T00:00:00Z', 'bundled', '2026-01-01T00:00:00Z');",
  "INSERT OR IGNORE INTO chameleon_calibrations (array_id, sensor_id, sensor1_a, sensor1_b, sensor1_c, sensor1_r2, sensor2_a, sensor2_b, sensor2_c, sensor2_r2, sensor3_a, sensor3_b, sensor3_c, sensor3_r2, test_rig_run_start_date, source, fetched_at) VALUES ('TEST-ARRAY-2', 'T002', 4.1, 4.2, 4.3, 0.94, 5.1, 5.2, 5.3, NULL, 6.1, 6.2, 6.3, 0.96, NULL, 'bundled', '2026-01-02T00:00:00Z');",
  '',
].join('\n');
const MUTATED_SEED = process.env.ISSUE410_MUTATION === 'omit-seed-key'
  ? SYNTHETIC_SEED.replace(/\nINSERT OR IGNORE INTO chameleon_calibrations[^\n]*TEST-ARRAY-2[^\n]*\n/, '\n')
  : SYNTHETIC_SEED;

const SQL_UNRELATED = "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-1', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');";
const SQL_OVERLAP = "INSERT INTO chameleon_calibrations VALUES ('TEST-ARRAY-1', 'T901', 81.1, 81.2, 81.3, NULL, 82.1, 82.2, 82.3, 0.82, 83.1, 83.2, 83.3, 0.83, '2023-02-01T00:00:00Z', 'prior', '2025-02-01T00:00:00Z');";
const SQL_DIVERGENT = [
  "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-1', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');",
  "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-2', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');",
  "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-3', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');",
  "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-4', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');",
  "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-5', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');",
  "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-6', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');",
  "INSERT INTO chameleon_calibrations VALUES ('TEST-EXISTING-7', 'T900', 70.1, 70.2, 70.3, NULL, 71.1, 71.2, 71.3, 0.71, 72.1, 72.2, 72.3, 0.72, '2023-01-01T00:00:00Z', 'prior', '2025-01-01T00:00:00Z');",
];

test('the seed lands in all seven bundled databases and they stay byte-identical', () => withSandbox({ seedSql: MUTATED_SEED }, (root) => {
  for (const rel of EXPECTED_PATHS) clearTable(path.join(root, rel), rel);
  for (const rel of EXPECTED_PATHS) compareRows(rows(path.join(root, rel), rel), [], rel);
  const before = inputHashes(root);
  runApply(root, ['--require-rows'], 'empty-seed-fixture');
  if (process.env.ISSUE410_MUTATION === 'alter-seeded-field') {
    runSql(path.join(root, EXPECTED_PATHS[0]), "UPDATE chameleon_calibrations SET sensor2_b = 41.25 WHERE array_id = 'TEST-ARRAY-2';", EXPECTED_PATHS[0]);
  }
  for (const rel of EXPECTED_PATHS) compareRows(rows(path.join(root, rel), rel), [EXPECTED_S1, EXPECTED_S2], rel);
  assertOutputParity(root, before);
  inputHashes(root);
  runApply(root, ['--require-rows'], 'empty-seed-reapply');
  for (const rel of EXPECTED_PATHS) compareRows(rows(path.join(root, rel), rel), [EXPECTED_S1, EXPECTED_S2], rel);
  assertOutputParity(root, before);
}));

test('unrelated existing rows survive with exact seed rows', () => withSandbox({ seedSql: SYNTHETIC_SEED }, (root) => {
  for (const rel of EXPECTED_PATHS) {
    const db = path.join(root, rel);
    clearTable(db, rel);
    runSql(db, SQL_UNRELATED, rel);
    compareRows(rows(db, rel), [EXPECTED_UNRELATED], rel);
  }
  const before = inputHashes(root);
  runApply(root, ['--require-rows'], 'unrelated-existing-fixture');
  for (const rel of EXPECTED_PATHS) compareRows(rows(path.join(root, rel), rel), [EXPECTED_UNRELATED, EXPECTED_S1, EXPECTED_S2], rel);
  assertOutputParity(root, before);
}));

test('identical overlap keeps every old field and inserts absent rows', () => withSandbox({ seedSql: SYNTHETIC_SEED }, (root) => {
  for (const rel of EXPECTED_PATHS) {
    const db = path.join(root, rel);
    clearTable(db, rel);
    runSql(db, `${SQL_UNRELATED}\n${SQL_OVERLAP}`, rel);
    compareRows(rows(db, rel), [EXPECTED_UNRELATED, EXPECTED_OVERLAP], rel);
  }
  const before = inputHashes(root);
  runApply(root, ['--require-rows'], 'identical-overlap-fixture');
  for (const rel of EXPECTED_PATHS) {
    const db = path.join(root, rel);
    if (process.env.ISSUE410_MUTATION === 'overwrite-collision' && rel === EXPECTED_PATHS[0]) {
      runSql(db, "UPDATE chameleon_calibrations SET sensor1_a = 1.1 WHERE array_id = 'TEST-ARRAY-1';", rel);
    }
    compareRows(rows(db, rel), [EXPECTED_UNRELATED, EXPECTED_OVERLAP, EXPECTED_S2], rel, 'collision-preservation');
  }
  assertOutputParity(root, before);
}));

test('divergent prepared inputs retain their own overlapping rows', () => withSandbox({ seedSql: SYNTHETIC_SEED }, (root) => {
  for (let i = 0; i < EXPECTED_PATHS.length; i += 1) {
    const rel = EXPECTED_PATHS[i];
    const db = path.join(root, rel);
    clearTable(db, rel);
    runSql(db, SQL_DIVERGENT[i], rel);
    if ([0, 2, 4].includes(i)) runSql(db, SQL_OVERLAP, rel);
    const prepared = [DIVERGENT_ROWS[i]];
    if ([0, 2, 4].includes(i)) prepared.push(EXPECTED_OVERLAP);
    compareRows(rows(db, rel), prepared, rel);
  }
  runApply(root, ['--require-rows'], 'divergent-input-fixture');
  for (let i = 0; i < EXPECTED_PATHS.length; i += 1) {
    const rel = EXPECTED_PATHS[i];
    const expected = [DIVERGENT_ROWS[i]];
    if ([0, 2, 4].includes(i)) expected.push(EXPECTED_OVERLAP);
    else expected.push(EXPECTED_S1);
    expected.push(EXPECTED_S2);
    compareRows(rows(path.join(root, rel), rel), expected, rel, [0, 2, 4].includes(i) ? 'collision-preservation' : 'field-value');
  }
}));

test('the bundled seed SQL applies to every target', () => withSandbox({}, (root) => {
  const initial = new Map();
  for (const rel of EXPECTED_PATHS) initial.set(rel, rows(path.join(root, rel), rel));
  const oracleRel = EXPECTED_PATHS[0];
  const oracle = path.join(root, 'snapshot-oracle.db');
  fs.copyFileSync(path.join(root, oracleRel), oracle);
  clearTable(oracle, oracleRel);
  compareRows(rows(oracle, oracleRel), [], oracleRel);
  const seedSql = fs.readFileSync(path.join(root, SEED_SQL_REL), 'utf8');
  const oracleRun = spawnSync('sqlite3', ['-bail', oracle], {
    input: `BEGIN;\n${seedSql}\nCOMMIT;\n`, encoding: 'utf8',
  });
  if (oracleRun.error || oracleRun.signal || oracleRun.status !== 0) failRedacted(oracleRel, 'snapshot-oracle-exit');
  const proposed = rows(oracle, oracleRel);
  const before = EXPECTED_PATHS.map((rel) => sha256(path.join(root, rel)));
  const inputsMatch = new Set(before).size === 1;
  runApply(root, [], 'checked-in-snapshot-fixture');
  for (const rel of EXPECTED_PATHS) {
    const expectedByKey = new Map(initial.get(rel).map((row) => [row.array_id, row]));
    for (const row of proposed) if (!expectedByKey.has(row.array_id)) expectedByKey.set(row.array_id, row);
    compareRows(rows(path.join(root, rel), rel), Array.from(expectedByKey.values()), rel);
  }
  if (inputsMatch) {
    const hashes = EXPECTED_PATHS.map((rel) => sha256(path.join(root, rel)));
    if (new Set(hashes).size !== 1) failRedacted('seven-targets', 'output-parity');
  }
}));

test('a missing target fails before any database is written', () => withSandbox({ seedSql: SYNTHETIC_SEED, omit: EXPECTED_PATHS[6] }, (root) => {
  const present = EXPECTED_PATHS.slice(0, -1);
  const before = new Map(present.map((rel) => [rel, sha256(path.join(root, rel))]));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/apply-chameleon-calibration-seed.js')], { encoding: 'utf8' });
  assertWriterFailed(r, 'missing-target');
  assertExpectedDiagnostic(r, /missing database/i, EXPECTED_PATHS[6], 'missing-target');
  assertHashesUnchanged(root, before, present);
  assertNoTemporaryImages(root);
}));

test('--require-rows refuses an empty seed and writes nothing', () => withSandbox({ seedSql: '-- no rows\n' }, (root) => {
  const before = new Map(EXPECTED_PATHS.map((rel) => [rel, sha256(path.join(root, rel))]));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/apply-chameleon-calibration-seed.js'), '--require-rows'], { encoding: 'utf8' });
  assertWriterFailed(r, 'empty-snapshot');
  assertExpectedDiagnostic(r, /no calibration rows|empty seed/i, EXPECTED_PATHS[0], 'empty-snapshot');
  assertHashesUnchanged(root, before);
  assertNoTemporaryImages(root);
}));

test('a staging SQL failure leaves all seven originals unchanged', () => withSandbox({ seedSql: SYNTHETIC_SEED }, (root) => {
  const broken = EXPECTED_PATHS[EXPECTED_PATHS.length - 1];
  runSql(path.join(root, broken), 'DROP TABLE chameleon_calibrations;', broken, 'fixture-break');
  const before = new Map(EXPECTED_PATHS.map((rel) => [rel, sha256(path.join(root, rel))]));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/apply-chameleon-calibration-seed.js')], { encoding: 'utf8' });
  assertWriterFailed(r, 'staging-sql-failure');
  assertHashesUnchanged(root, before);
  assertNoTemporaryImages(root);
}));
