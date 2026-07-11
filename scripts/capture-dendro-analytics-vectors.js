#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MODULE = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics');
const CONTRACT = path.join(REPO, 'docs/contracts/dendro');
const CASES = path.join(CONTRACT, 'cases');
const EDGE_CASES = path.join(CONTRACT, 'edge-node-cases');
const FIXED_NOW = '2026-07-11T12:00:00.000Z';
const ANALYTICS_DATE = '2026-07-10';

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stableJson(value));
}

function plainRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

function funcText() {
  const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
  const node = flows.find((entry) => entry.id === 'dendro-compute-fn');
  if (!node) throw new Error('dendro-compute-fn not found');
  return node.func;
}

function makeFixedDate(iso) {
  const realDate = Date;
  return class FixedDate extends realDate {
    constructor(...args) {
      super(args.length ? args[0] : iso);
    }
    static now() { return realDate.parse(iso); }
    static parse(value) { return realDate.parse(value); }
    static UTC(...args) { return realDate.UTC(...args); }
  };
}

function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
    try {
      let result;
      if (kind === 'run' || kind === 'exec') {
        db.exec(sql);
        result = undefined;
      } else if (kind === 'get') {
        result = db.prepare(sql).get();
      } else {
        result = db.prepare(sql).all();
      }
      if (typeof cb === 'function') {
        process.nextTick(() => cb(null, result));
        return undefined;
      }
      return Promise.resolve(result);
    } catch (error) {
      if (typeof cb === 'function') {
        process.nextTick(() => cb(error));
        return undefined;
      }
      return Promise.reject(error);
    }
  };
  return {
    run: call('run'),
    all: call('all'),
    get: call('get'),
    exec: call('exec'),
    close(cb) {
      try { db.close(); } catch (_) {}
      if (typeof cb === 'function') cb();
    },
  };
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function seedDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(SEED, 'utf8'));
  db.exec(`
    INSERT INTO users(id, username, password_hash, created_at)
    VALUES (1, 'fixture', 'not-a-real-password', '${FIXED_NOW}');

    INSERT INTO irrigation_zones(
      id, name, user_id, created_at, updated_at, timezone, phenological_stage, calibration_key
    ) VALUES (1, 'Fixture Zone', 1, '${FIXED_NOW}', '${FIXED_NOW}', 'UTC', 'default', 'default');

    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, is_reference_tree)
    VALUES
      ('DENDRO0000000001', 'Fixture Tree A', 'DRAGINO_LSN50', 1, '${FIXED_NOW}', '${FIXED_NOW}', 1, 1, 0),
      ('DENDRO0000000002', 'Fixture Tree B', 'DRAGINO_LSN50', 1, '${FIXED_NOW}', '${FIXED_NOW}', 1, 1, 0),
      ('WEATHER000000001', 'Fixture Weather', 'SENSECAP_S2120', 1, '${FIXED_NOW}', '${FIXED_NOW}', NULL, 0, 0);

    INSERT INTO weather_station_zones(deveui, zone_id, created_at)
    VALUES ('WEATHER000000001', 1, '${FIXED_NOW}');

    INSERT INTO device_data(deveui, recorded_at, ambient_temperature, relative_humidity)
    VALUES ('WEATHER000000001', '${ANALYTICS_DATE}T12:00:00.000Z', 30, 45);

    INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at)
    VALUES (1, '${ANALYTICS_DATE}', 0, 120, 'none', '${FIXED_NOW}');

    INSERT INTO irrigation_schedules(irrigation_zone_id, trigger_metric, threshold_kpa, enabled, duration_minutes, created_at, updated_at)
    VALUES (1, 'DENDRO', 2, 1, 30, '${FIXED_NOW}', '${FIXED_NOW}');

    INSERT INTO dendro_baselines(deveui, mds_max_reference_um, mds_mean_um, baseline_days, baseline_complete, computed_at)
    VALUES
      ('DENDRO0000000001', 45, 38, 14, 1, '${FIXED_NOW}'),
      ('DENDRO0000000002', 65, 52, 14, 1, '${FIXED_NOW}');

    INSERT INTO dendrometer_daily(deveui, date, d_max_um, d_min_um, mds_um, data_quality, valid_readings_count, computed_at, twd_night_um, twd_day_um, tree_state_v5, low_confidence_day)
    VALUES
      ('DENDRO0000000001', '2026-07-08', 100, 70, 30, 'good', 80, '${FIXED_NOW}', 0, 30, 'mild', 0),
      ('DENDRO0000000001', '2026-07-09', 112, 82, 30, 'good', 80, '${FIXED_NOW}', 0, 30, 'mild', 0),
      ('DENDRO0000000002', '2026-07-08', 110, 70, 40, 'good', 80, '${FIXED_NOW}', 0, 40, 'moderate', 0),
      ('DENDRO0000000002', '2026-07-09', 118, 68, 50, 'good', 80, '${FIXED_NOW}', 0, 50, 'moderate', 0);
  `);

  const readings = [
    ['DENDRO0000000001', 121, '05:05:00'],
    ['DENDRO0000000001', 124, '05:35:00'],
    ['DENDRO0000000001', 122, '06:10:00'],
    ['DENDRO0000000001', 92, '13:05:00'],
    ['DENDRO0000000001', 90, '14:00:00'],
    ['DENDRO0000000001', 93, '15:30:00'],
    ['DENDRO0000000001', 108, '09:00:00'],
    ['DENDRO0000000001', 101, '18:00:00'],
    ['DENDRO0000000002', 118, '05:10:00'],
    ['DENDRO0000000002', 120, '05:50:00'],
    ['DENDRO0000000002', 119, '06:30:00'],
    ['DENDRO0000000002', 58, '13:15:00'],
    ['DENDRO0000000002', 56, '14:15:00'],
    ['DENDRO0000000002', 60, '15:45:00'],
    ['DENDRO0000000002', 100, '10:00:00'],
    ['DENDRO0000000002', 96, '19:00:00'],
  ];
  for (const [deveui, position, time] of readings) {
    db.exec(`
      INSERT INTO dendrometer_readings(deveui, position_um, is_valid, recorded_at)
      VALUES (${sqlString(deveui)}, ${position}, 1, ${sqlString(`${ANALYTICS_DATE}T${time}.000Z`)});
    `);
  }
  db.close();
}

async function runNodeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-dendro-analytics-'));
  const dbPath = path.join(dir, 'farming.db');
  seedDb(dbPath);

  const errors = [];
  const warnings = [];
  const logs = [];
  const statuses = [];
  const msg = {};
  const node = {
    error(value) { errors.push(String(value && value.message ? value.message : value)); },
    warn(value) { warnings.push(String(value && value.message ? value.message : value)); },
    log(value) { logs.push(String(value)); },
    status(value) { statuses.push(value); },
  };
  const env = { get() { return ''; } };
  const osiDb = { Database: function Database() { return makeFacadeShim(dbPath); }, verbose() { return osiDb; } };
  const osiLib = {
    require(name) {
      if (name !== 'dendro-analytics') return { ok: false, error: `unexpected helper ${name}` };
      return { ok: true, value: require(MODULE) };
    },
  };
  const fakeRequire = (name) => {
    if (name === 'http' || name === 'https') {
      throw new Error(`unexpected network dependency in dendro fixture: ${name}`);
    }
    return require(name);
  };
  const fn = new Function('osiDb', 'env', 'node', 'msg', 'require', 'Date', 'osiLib', funcText());
  const result = await fn(osiDb, env, node, msg, fakeRequire, makeFixedDate(FIXED_NOW), osiLib);
  if (errors.length) throw new Error(`node errors: ${errors.join('; ')}`);

  const db = new DatabaseSync(dbPath);
  const dailyRows = db.prepare(`
    SELECT deveui, date, d_max_um, d_min_um, mds_um, twd_night_um, twd_day_um,
           envelope_ref_um, twd_method, confidence_score, low_confidence_day,
           tree_state_v5, stress_level, data_quality, valid_readings_count
    FROM dendrometer_daily
    WHERE date = ?
    ORDER BY deveui
  `).all(ANALYTICS_DATE);
  const recRows = db.prepare(`
    SELECT zone_id, date, zone_stress_summary, rainfall_mm, water_delivered_liters,
           irrigation_action, action_reasoning, vpd_max_kpa, vpd_source,
           usable_tree_count, low_confidence_tree_count, outlier_filtered_tree_count,
           zone_confidence_score
    FROM zone_daily_recommendations
    WHERE date = ?
    ORDER BY zone_id
  `).all(ANALYTICS_DATE);
  const stateRows = db.prepare(`
    SELECT zone_id, rain_suppression_active, recovery_verification_active,
           consecutive_increases, current_volume_liters
    FROM zone_irrigation_state
    ORDER BY zone_id
  `).all();
  db.close();

  return {
    fixedNow: FIXED_NOW,
    resultPayload: result && result.payload,
    nodeLogs: logs,
    nodeWarnings: warnings,
    finalStatus: statuses[statuses.length - 1] || null,
    dendrometer_daily: plainRows(dailyRows),
    zone_daily_recommendations: plainRows(recRows),
    zone_irrigation_state: plainRows(stateRows),
  };
}

function envelopeCases() {
  const da = require(MODULE);
  const cases = [
    {
      name: 'stepwise-anchor-deficit',
      input: {
        method: 'stepwise',
        maxGrowthUmPerDay: null,
        points: [
          { date: '2026-07-07', d_max_um: 100, d_min_um: 70 },
          { date: '2026-07-08', d_max_um: 112, d_min_um: 82 },
          { date: '2026-07-09', d_max_um: 108, d_min_um: 66 },
          { date: '2026-07-10', d_max_um: 116, d_min_um: 88 },
        ],
      },
    },
    {
      name: 'stepwise-missing-day',
      input: {
        method: 'stepwise',
        maxGrowthUmPerDay: null,
        points: [
          { date: '2026-07-07', d_max_um: 90, d_min_um: 62 },
          { date: '2026-07-08', d_max_um: 95, d_min_um: 60 },
          { date: '2026-07-09', d_max_um: null, d_min_um: null },
          { date: '2026-07-10', d_max_um: 91, d_min_um: 55 },
        ],
      },
    },
  ];
  return cases.map((entry) => {
    const sequence = entry.input.points.map((point) => ({
      date: point.date,
      dMax: point.d_max_um,
      dMin: point.d_min_um,
    }));
    const computed = da.computeEnvelope(sequence, entry.input.method);
    return {
      name: entry.name,
      input: entry.input,
      expected: {
        results: computed.map((row, index) => ({
          date: entry.input.points[index].date,
          envelope_ref_um: row.envelopeRef,
          twd_night_um: row.twdNight,
          twd_day_um: row.twdDay,
          mds_um: row.mds,
        })),
      },
    };
  });
}

async function capture() {
  fs.mkdirSync(CASES, { recursive: true });
  fs.mkdirSync(EDGE_CASES, { recursive: true });
  const cases = envelopeCases();
  writeJson(path.join(CONTRACT, 'MANIFEST.json'), {
    schemaVersion: 1,
    cases: cases.map((entry) => entry.name),
  });
  for (const entry of cases) {
    writeJson(path.join(CASES, `${entry.name}.input.json`), entry.input);
    writeJson(path.join(CASES, `${entry.name}.expected.json`), entry.expected);
  }

  const nodeOutput = await runNodeFixture();
  writeJson(path.join(EDGE_CASES, 'daily-analytics.input.json'), {
    fixedNow: FIXED_NOW,
    analyticsDate: ANALYTICS_DATE,
    description: 'Temp SQLite fixture seeded by scripts/capture-dendro-analytics-vectors.js and executed against dendro-compute-fn.',
  });
  writeJson(path.join(EDGE_CASES, 'daily-analytics.expected.json'), nodeOutput);
  fs.writeFileSync(path.join(CONTRACT, 'README.md'), [
    '# Dendrometer Golden Vectors',
    '',
    'These fixtures are owned by `osi-os`.',
    '',
    '- `cases/` contains shared DailyPoint envelope fixtures consumed by the edge module and mirrored into `osi-server` by refactor-program item 2.3.',
    '- `edge-node-cases/` contains the extraction replay fixture for `dendro-compute-fn`; it proves the flow adapter produces the same DB writes after the compute core moves into `osi-dendro-analytics`.',
    '',
    'For the shared contract, inputs use `dendrometer_daily` daily-point field names and expected outputs assert the shared envelope/TWD/MDS core: `envelope_ref_um`, `twd_night_um`, `twd_day_um`, and `mds_um`.',
    '',
  ].join('\n'));
}

async function verify() {
  const manifest = readJson(path.join(CONTRACT, 'MANIFEST.json'));
  for (const name of manifest.cases) {
    const input = readJson(path.join(CASES, `${name}.input.json`));
    const expected = readJson(path.join(CASES, `${name}.expected.json`));
    const da = require(MODULE);
    const sequence = input.points.map((point) => ({
      date: point.date,
      dMax: point.d_max_um,
      dMin: point.d_min_um,
    }));
    const actual = {
      results: da.computeEnvelope(sequence, input.method).map((row, index) => ({
        date: input.points[index].date,
        envelope_ref_um: row.envelopeRef,
        twd_night_um: row.twdNight,
        twd_day_um: row.twdDay,
        mds_um: row.mds,
      })),
    };
    assert.deepEqual(actual, expected, `shared envelope case ${name}`);
  }

  const expectedNodeOutput = readJson(path.join(EDGE_CASES, 'daily-analytics.expected.json'));
  const actualNodeOutput = await runNodeFixture();
  assert.deepEqual(actualNodeOutput, expectedNodeOutput, 'dendro-compute-fn edge-node fixture');
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--capture') {
    await capture();
    console.log('Captured dendro analytics vectors');
    return;
  }
  if (mode === '--verify') {
    await verify();
    console.log('Verified dendro analytics vectors');
    return;
  }
  throw new Error('Usage: node scripts/capture-dendro-analytics-vectors.js --capture|--verify');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
