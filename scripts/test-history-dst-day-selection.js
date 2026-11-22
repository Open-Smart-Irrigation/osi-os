'use strict';

// Nightly CSV day selection across DST transitions (#745). The scheduled
// builder must write the local calendar date immediately before the job's
// local-midnight instant, so a 23-hour spring-forward day and a 25-hour
// fall-back day are each written once. Both profile copies of the helper are
// exercised because the bcm2709 file mirrors the bcm2712 payload byte-for-byte.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const PROFILE_HELPER_DIRS = [
  ['bcm2712', path.join(repoRoot, 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'osi-history-helper')],
  ['bcm2709', path.join(repoRoot, 'conf', 'full_raspberrypi_bcm27xx_bcm2709', 'files', 'usr', 'share', 'node-red', 'osi-history-helper')],
];

const SQLITE_JSON_MAX_BUFFER = 16 * 1024 * 1024;

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`OK ${name}`))
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
}

function sqliteEscape(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createCliSqliteDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-dst-day-'));
  const dbPath = path.join(dir, 'dst-day-selection.sqlite');
  const schema = fs.readFileSync(path.join(repoRoot, 'database', 'seed-blank.sql'), 'utf8');
  execFileSync('sqlite3', [dbPath], { input: schema });

  const db = {
    path: dbPath,
    runSql(sql) {
      execFileSync('sqlite3', [dbPath], { input: sql });
    },
    run(sql, params, cb) {
      let index = 0;
      const rendered = sql.replace(/\?/g, () => sqliteEscape(params[index++]));
      try {
        execFileSync('sqlite3', [dbPath], { input: rendered });
        if (typeof cb === 'function') cb.call({}, null);
      } catch (error) {
        if (typeof cb === 'function') cb(error);
        else throw error;
      }
    },
    all(sql, params, cb) {
      let index = 0;
      const rendered = sql.replace(/\?/g, () => sqliteEscape(params[index++]));
      try {
        const output = execFileSync('sqlite3', ['-json', dbPath, rendered], { encoding: 'utf8', maxBuffer: SQLITE_JSON_MAX_BUFFER }).trim();
        cb(null, output ? JSON.parse(output) : []);
      } catch (error) {
        cb(error);
      }
    },
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return db;
}

function seedZone(db, timezone, readings) {
  db.runSql(`
    INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2025-03-01T00:00:00.000Z','2025-03-01T00:00:00.000Z');
    INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at)
      VALUES(7,'Zone B',1,'zu',${sqliteEscape(timezone)},'2025-03-01T00:00:00.000Z','2025-03-01T00:00:00.000Z');
    INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
      VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,7,1,5,'2025-03-01T00:00:00.000Z','2025-03-01T00:00:00.000Z');
  `);
  for (const reading of readings) {
    db.runSql(`
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES('AA00000000000001',${sqliteEscape(reading.recordedAt)},${sqliteEscape(reading.value)});
      INSERT INTO chameleon_readings(deveui,recorded_at,array_id) VALUES('AA00000000000001',${sqliteEscape(reading.recordedAt)},'ARR-007');
    `);
  }
}

async function runNightly(helper, db, dir, nowMs) {
  const summary = await helper.runRollupJob(db, { nowMs, exportDir: dir, retentionDays: 90 });
  assert.deepStrictEqual(summary.errors, [], 'runRollupJob must not error');
  assert.strictEqual(summary.csvZonesWritten, 1, 'one zone export expected');
}

function levelDayFiles(dir, level) {
  const levelDir = path.join(dir, 'zu', level);
  return fs.existsSync(levelDir) ? fs.readdirSync(levelDir).sort() : [];
}

for (const [profile, helperDir] of PROFILE_HELPER_DIRS) {
  const helper = require(helperDir);

  test(`${profile}: nightly CSV writes the completed spring-forward day (Zurich 2025-03-30)`, async () => {
    const db = createCliSqliteDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-dst-spring-'));
    try {
      seedZone(db, 'Europe/Zurich', [
        { recordedAt: '2025-03-30T08:10:00.000Z', value: 10 },
        { recordedAt: '2025-03-30T20:40:00.000Z', value: 20 },
      ]);

      await runNightly(helper, db, dir, Date.parse('2025-03-31T02:00:00.000Z'));

      assert.deepStrictEqual(levelDayFiles(dir, 'raw'), ['2025-03-30.csv']);
      assert.deepStrictEqual(levelDayFiles(dir, 'hourly'), ['2025-03-30.csv']);
      const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2025-03-30.csv'), 'utf8');
      assert.match(raw, /2025-03-30T08:10:00\.000Z,/);
      assert.match(raw, /2025-03-30T20:40:00\.000Z,/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${profile}: nightly CSV writes the completed fall-back day once (Zurich 2025-10-26)`, async () => {
    const db = createCliSqliteDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-dst-fallback-'));
    try {
      seedZone(db, 'Europe/Zurich', [
        { recordedAt: '2025-10-25T23:30:00.000Z', value: 10 },
        { recordedAt: '2025-10-26T12:00:00.000Z', value: 20 },
      ]);

      await runNightly(helper, db, dir, Date.parse('2025-10-27T02:00:00.000Z'));

      assert.deepStrictEqual(levelDayFiles(dir, 'raw'), ['2025-10-26.csv']);
      const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2025-10-26.csv'), 'utf8');
      assert.match(raw, /2025-10-25T23:30:00\.000Z,/);
      assert.match(raw, /2025-10-26T12:00:00\.000Z,/);

      db.runSql(`
        INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES('AA00000000000001','2025-10-27T09:00:00.000Z',30);
        INSERT INTO chameleon_readings(deveui,recorded_at,array_id) VALUES('AA00000000000001','2025-10-27T09:00:00.000Z','ARR-007');
      `);
      await runNightly(helper, db, dir, Date.parse('2025-10-28T02:00:00.000Z'));

      assert.deepStrictEqual(levelDayFiles(dir, 'raw'), ['2025-10-26.csv', '2025-10-27.csv']);
      assert.deepStrictEqual(levelDayFiles(dir, 'hourly'), ['2025-10-26.csv', '2025-10-27.csv']);
      // daily.csv carries one row per channel per completed day; the fall-back
      // day's rows must appear exactly once (bucket start 2025-10-25T22:00Z is
      // local midnight CEST of the 25-hour day, 2025-10-26T23:00Z the next).
      const dailyLines = fs.readFileSync(path.join(dir, 'zu', 'daily.csv'), 'utf8').trim().split('\n').slice(1);
      assert.strictEqual(dailyLines.filter((line) => line.startsWith('2025-10-25T22:00:00.000Z') && line.includes(',swt_1,')).length, 1, 'fall-back day exactly once in daily.csv');
      assert.match(dailyLines.find((line) => line.startsWith('2025-10-25T22:00:00.000Z') && line.includes(',swt_1,')), /,kPa,15$/m);
      assert.strictEqual(dailyLines.filter((line) => line.startsWith('2025-10-26T23:00:00.000Z') && line.includes(',swt_1,')).length, 1, 'next day exactly once in daily.csv');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${profile}: nightly CSV writes an ordinary completed day (Zurich 2026-06-02)`, async () => {
    const db = createCliSqliteDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-dst-ordinary-'));
    try {
      seedZone(db, 'Europe/Zurich', [
        { recordedAt: '2026-06-02T08:10:00.000Z', value: 10 },
        { recordedAt: '2026-06-02T20:40:00.000Z', value: 20 },
      ]);

      await runNightly(helper, db, dir, Date.parse('2026-06-03T02:00:00.000Z'));

      assert.deepStrictEqual(levelDayFiles(dir, 'raw'), ['2026-06-02.csv']);
      const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2026-06-02.csv'), 'utf8');
      assert.match(raw, /2026-06-02T08:10:00\.000Z,/);
      assert.match(raw, /2026-06-02T20:40:00\.000Z,/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${profile}: nightly CSV writes the completed day for a UTC zone`, async () => {
    const db = createCliSqliteDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-dst-utc-'));
    try {
      seedZone(db, 'UTC', [{ recordedAt: '2026-06-02T08:10:00.000Z', value: 10 }]);

      await runNightly(helper, db, dir, Date.parse('2026-06-03T02:00:00.000Z'));

      assert.deepStrictEqual(levelDayFiles(dir, 'raw'), ['2026-06-02.csv']);
      assert.deepStrictEqual(levelDayFiles(dir, 'hourly'), ['2026-06-02.csv']);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
