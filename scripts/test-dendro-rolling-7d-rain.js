#!/usr/bin/env node
'use strict';

// The rolling 7-day rain of dendro-compute-fn covers the seven calendar days
// ending on the zone-local analytics date: the six prior days from stored
// recommendations plus the analytics day itself. A missing or unknown day adds
// nothing and is counted, so the sum is a lower bound, never a silent zero day.
// Unknown rain on the analytics day keeps the recommendation and marks it
// rain_unknown; it never starts dendro rain suppression.
//
// Runs the shipped function body against an in-memory database on
// seed-blank.sql, with a fixed clock and a stubbed HTTP module (the node never
// leaves the process).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb, loadNode } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'database/seed-blank.sql');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share',
];
const NOW_ISO = '2026-10-09T03:00:00.000Z';
const TREE = 'A840410000000001';

function makeFixedDate(iso) {
  const RealDate = Date;
  return class FixedDate extends RealDate {
    constructor(...args) {
      super(args.length ? args[0] : iso);
    }
    static now() { return RealDate.parse(iso); }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  };
}

// Answers every request with one canned response; records the URLs asked for.
function stubHttp(weather, calls) {
  return {
    request(url, _options, onResponse) {
      calls.push(String(url));
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => {};
      req.destroy = (error) => process.nextTick(() => req.emit('error', error));
      req.end = () => {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.destroy = () => res.emit('close');
          res.statusCode = weather.status;
          onResponse(res);
          if (weather.body != null) res.emit('data', JSON.stringify(weather.body));
          res.emit('end');
        });
      };
      return req;
    },
  };
}

function openMeteoDay(rainTotalMm) {
  // 24 hourly values; only the first carries the day's total so rounding stays exact.
  const precipitation = Array.from({ length: 24 }, (_, i) => (i === 0 ? rainTotalMm : 0));
  return {
    status: 200,
    body: {
      hourly: {
        temperature_2m: Array(24).fill(18),
        relative_humidity_2m: Array(24).fill(70),
        precipitation,
      },
    },
  };
}

// A provider answer with temperature and humidity but no usable precipitation hour:
// the key absent, or present with only nulls.
function openMeteoTemperatureOnly({ nullPrecipitation = false } = {}) {
  const hourly = { temperature_2m: Array(24).fill(18), relative_humidity_2m: Array(24).fill(70) };
  if (nullPrecipitation) hourly.precipitation = Array(24).fill(null);
  return { status: 200, body: { hourly } };
}

function seedDb({ timezone = 'UTC', withLocation = true, providerSetting = '1' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(SEED, 'utf8'));
  db.exec(`
    INSERT INTO users(id, username, password_hash, created_at)
    VALUES (1, 'fixture', 'not-a-real-password', '${NOW_ISO}');
    INSERT INTO irrigation_zones(id, name, user_id, created_at, updated_at, timezone, latitude, longitude)
    VALUES (1, 'Fixture Zone', 1, '${NOW_ISO}', '${NOW_ISO}', '${timezone}',
            ${withLocation ? '46.5' : 'NULL'}, ${withLocation ? '7.5' : 'NULL'});
    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, is_reference_tree)
    VALUES ('${TREE}', 'Fixture Tree', 'DRAGINO_LSN50', 1, '${NOW_ISO}', '${NOW_ISO}', 1, 1, 0);
  `);
  // Existing weather-policy cases explicitly opt in; the default-off cases
  // below pass null (absent), '0', or an unreadable setting.
  if (providerSetting != null) db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)')
    .run('dendro_provider_irrigation_enabled', providerSetting);
  return db;
}

function addRecommendation(db, date, rainfallMm, extra = {}) {
  const stress = extra.stress || 'none';
  db.prepare(`
    INSERT INTO zone_daily_recommendations(zone_id, date, zone_stress_summary, rainfall_mm, irrigation_action, recommendation_json, computed_at)
    VALUES (1, ?, ?, ?, 'maintain', ?, ?)
  `).run(date, stress, rainfallMm, extra.raw != null ? extra.raw : (extra.json == null ? null : JSON.stringify(extra.json)), NOW_ISO);
}

function addLocalRain(db, date, rainfallMm) {
  db.prepare(`
    INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at)
    VALUES (1, ?, ?, 0, 'aquascope_lorain', ?)
  `).run(date, rainfallMm, NOW_ISO);
}

// One tree with a complete, unstressed analytics day, so the zone reaches the
// rolling-rain rule of irrDecision (the readings mirror the dendro golden vectors).
function addUnstressedTreeDay(db, date) {
  db.exec(`
    INSERT INTO dendro_baselines(deveui, mds_max_reference_um, mds_mean_um, baseline_days, baseline_complete, computed_at)
    VALUES ('${TREE}', 45, 38, 14, 1, '${NOW_ISO}');
  `);
  const readings = [
    [121, '05:05:00'], [124, '05:35:00'], [122, '06:10:00'], [108, '09:00:00'],
    [92, '13:05:00'], [90, '14:00:00'], [93, '15:30:00'], [101, '18:00:00'],
  ];
  const insert = db.prepare('INSERT INTO dendrometer_readings(deveui, position_um, is_valid, recorded_at) VALUES (?, ?, 1, ?)');
  for (const [position, time] of readings) insert.run(TREE, position, `${date}T${time}.000Z`);
}

async function runDendro(db, { weather = { status: 500, body: null }, profile = PROFILES[0], envVars = {}, now = NOW_ISO, transport, completionTimeout, sourceRef = process.env.OSI_DENDRO_CONTROL_SOURCE_REF, settingUnreadable } = {}) {
  const flowsPath = path.join(ROOT, profile, 'flows.json');
  const moduleDirs = {
    'dendro-analytics': path.join(ROOT, profile, 'node-red/osi-dendro-analytics'),
    rain: path.join(ROOT, profile, 'node-red/osi-rain'),
  };
  const node = sourceRef
    ? JSON.parse(execFileSync('git', ['show', `${sourceRef}:${profile}/flows.json`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })).find(n => n.id === 'dendro-compute-fn')
    : loadNode('dendro-compute-fn', flowsPath);
  const facade = facadeDb(db);
  if (settingUnreadable) {
    const get = facade.get;
    facade.get = (sql, ...args) => /app_settings/.test(sql) ? Promise.reject(new Error('fixture setting read failed')) : get(sql, ...args);
  }
  const calls = [];
  const errors = [];
  const warnings = [];
  const fakeNode = {
    error: (value) => errors.push(String(value)),
    warn: (value) => warnings.push(String(value)),
    log: () => {},
    status: () => {},
  };
  const osiDb = { Database: function Database() { return facade; } };
  const osiLib = {
    require(name) {
      if (!moduleDirs[name]) return { ok: false, error: `unexpected helper ${name}` };
      return { ok: true, value: require(moduleDirs[name]) }; // eslint-disable-line global-require
    },
  };
  const http = transport || stubHttp(weather, calls);
  const env = { get: (key) => (Object.prototype.hasOwnProperty.call(envVars, key) ? envVars[key] : '') };
  const context = vm.createContext({ osiDb, osiLib, env, node: fakeNode, msg: {}, Buffer, Date: makeFixedDate(now) });
  assert.equal(vm.runInContext('typeof require', context), 'undefined', 'the function sandbox has no require');
  // Stub the real built-ins used by the extracted helper, rather than granting
  // the function node a CommonJS loader that Node-RED does not provide.
  const requests = ['node:http', 'node:https'].map((name) => test.mock.method(require(name), 'request', http.request));
  try {
    let watchdog;
    const execution = vm.runInContext('(async function(){\n' + node.func + '\n})()', context);
    let result;
    try {
      result = await (completionTimeout ? Promise.race([execution, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('analytics did not finish')), completionTimeout);
      })]) : execution);
    } finally {
      clearTimeout(watchdog);
    }
    assert.deepEqual(errors, [], 'dendro-compute-fn reported errors');
    return { result, calls, warnings };
  } finally {
    for (const request of requests) request.mock.restore();
  }
}

function recommendation(db, date) {
  const row = db.prepare('SELECT * FROM zone_daily_recommendations WHERE zone_id = 1 AND date = ?').get(date);
  assert.ok(row, `a recommendation row exists for ${date}`);
  return { row, json: JSON.parse(row.recommendation_json) };
}

const CONTROL_BASE_REF = '27459db81e605f07c1b62886ec150ffc753fbe33';
const PROVIDER_SETTING = 'dendro_provider_irrigation_enabled';

function controlFixture(providerSetting, highVpd) {
  const db = seedDb({ providerSetting });
  addUnstressedTreeDay(db, '2026-10-08');
  addRecommendation(db, '2026-10-07', null, { stress: highVpd ? 'mild' : 'none' });
  addRecommendation(db, '2026-10-06', null);
  if (highVpd) db.prepare(`INSERT INTO dendrometer_daily(deveui,date,d_max_um,d_min_um,mds_um,twd_night_um,tree_state_v5,data_quality,valid_readings_count,computed_at)
    VALUES (?, '2026-10-07', 146, 110, 36, 0, 'mild', 'good', 8, ?)`).run(TREE, NOW_ISO);
  return db;
}

async function controlOutcome(db, profile) {
  const { row } = recommendation(db, '2026-10-08');
  const scheduler = loadNode('5f0d2b7e9b9b1b3a', path.join(ROOT, profile, 'flows.json'));
  const multiplierSource = scheduler.func.match(/function applyDurationMultiplier\([^]*?\n\}/);
  assert.ok(multiplierSource, 'test executes the shipped scheduler multiplier');
  const scaled = vm.runInNewContext('(' + multiplierSource[0] + ')')(100, row.irrigation_action);
  const { readEvidence } = require(path.join(ROOT, profile, 'node-red/osi-irrigation-policy/observations'));
  const conditional = await readEvidence({ db: facadeDb(db), policy: { zone_id: 1, condition: { kind: 'DENDRO' } }, dueAt: NOW_ISO });
  const { evaluateCondition } = require(path.join(ROOT, profile, 'node-red/osi-irrigation-policy/evaluate'));
  const eligibility = evaluateCondition({ kind: 'DENDRO', minimum_stress: 'mild' }, conditional, NOW_ISO, 60);
  return { action: row.irrigation_action, reasoning: row.action_reasoning, multiplier: scaled / 100,
    suppression: row.rain_suppression_active,
    state: { ...db.prepare('SELECT * FROM zone_irrigation_state WHERE zone_id=1').get() }, conditional, eligibility };
}

for (const profile of PROFILES) {
  const tag = profile.includes('bcm2709') ? 'bcm2709' : 'bcm2712';
  test(`[${tag}] provider control off excludes historical provider rain while displaying it`, async t => {
    const db = controlFixture('0', false);
    t.after(() => db.close());
    db.prepare('UPDATE zone_daily_recommendations SET rainfall_mm=25,recommendation_json=? WHERE date=?')
      .run(JSON.stringify({ rain: { daily_mm: 25, daily_status: 'observed', source: 'open_meteo' } }), '2026-10-07');
    await runDendro(db, { profile, weather: openMeteoDay(0) });
    const { row, json } = recommendation(db, '2026-10-08');
    assert.equal(row.irrigation_action, 'decrease_10');
    assert.equal(json.rain.rolling7d, 25);
    assert.equal(json.weather_control.decision_rain.rolling7d, 0);
  });
  test(`[${tag}] changed provider observations still update and re-version the displayed row`, async t => {
    const db = controlFixture('0', false);
    t.after(() => db.close());
    await runDendro(db, { profile, weather: openMeteoDay(5.4) });
    const first = recommendation(db, '2026-10-08').row;
    const weather = openMeteoDay(8);
    weather.body.hourly.temperature_2m.fill(35);
    weather.body.hourly.relative_humidity_2m.fill(20);
    await runDendro(db, { profile, weather });
    const { row } = recommendation(db, '2026-10-08');
    assert.equal(row.rainfall_mm, 8);
    assert.ok(row.vpd_max_kpa > first.vpd_max_kpa);
    assert.equal(row.irrigation_action, first.irrigation_action, 'control remains off');
    assert.equal(row.sync_version, first.sync_version + 1);
  });
  test(`[${tag}] provider control off retains local rain and local VPD`, async t => {
    const db = controlFixture('0', true);
    const main = controlFixture(null, true);
    t.after(() => { db.close(); main.close(); });
    for (const fixture of [db, main]) {
      addLocalRain(fixture, '2026-10-08', 6);
      fixture.exec(`INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
        VALUES ('A840410000000009','Local weather','KIWI_SENSOR',1,1,'${NOW_ISO}','${NOW_ISO}');
        INSERT INTO device_data(deveui,recorded_at,ambient_temperature,relative_humidity)
        VALUES ('A840410000000009','2026-10-08T12:00:00Z',35,20);`);
    }
    await runDendro(db, { profile, weather: openMeteoDay(25) });
    await runDendro(main, { profile, sourceRef: CONTROL_BASE_REF });
    assert.deepEqual(await controlOutcome(db, profile), await controlOutcome(main, profile));
    const { row, json } = recommendation(db, '2026-10-08');
    assert.equal(row.vpd_source, 'local_sensor');
    assert.equal(row.rainfall_mm, 6);
    assert.equal(json.weather_control.decision_vpd.available, true);
    assert.equal(json.weather_control.decision_rain.daily_mm, 6);
  });
  for (const enabled of ['0', '1']) for (const highVpd of [false, true]) {
    test(`[${tag}] same-day provider observation survives a failed rerun, gate ${enabled}, ${highVpd ? 'high VPD' : 'rain'}`, async t => {
      const db = controlFixture(enabled, highVpd);
      t.after(() => db.close());
      const weather = openMeteoDay(highVpd ? 0 : 5.4);
      if (highVpd) { weather.body.hourly.temperature_2m.fill(35); weather.body.hourly.relative_humidity_2m.fill(20); }
      await runDendro(db, { profile, weather });
      const first = recommendation(db, '2026-10-08').row;
      await runDendro(db, { profile });
      const { row, json } = recommendation(db, '2026-10-08');
      for (const key of ['rainfall_mm', 'vpd_max_kpa', 'vpd_source', 'irrigation_action', 'rain_suppression_active', 'zone_stress_summary'])
        assert.equal(row[key], first[key], key);
      const changedReason = row.action_reasoning !== first.action_reasoning;
      assert.equal(row.sync_version, first.sync_version + (changedReason ? 1 : 0), 'an unchanged recommendation is not re-versioned');
      assert.equal(json.weather_control.provider_reused_from_computed_at, changedReason ? first.computed_at : null);
    });
  }
  for (const highVpd of [false, true]) {
    for (const mode of ['off', 'absent', 'unreadable']) {
      test(`[${tag}] provider control default-off: ${highVpd ? 'high VPD' : '5.4 mm rain'}, setting ${mode}`, async t => {
        const setting = mode === 'absent' ? null : mode === 'off' ? '0' : '1';
        const observed = controlFixture(setting, highVpd);
        const unreachable = controlFixture(setting, highVpd);
        const baseline = controlFixture(setting, highVpd);
        t.after(() => { observed.close(); unreachable.close(); baseline.close(); });
        const weather = openMeteoDay(highVpd ? 0 : 5.4);
        if (highVpd) {
          weather.body.hourly.temperature_2m.fill(35);
          weather.body.hourly.relative_humidity_2m.fill(20);
        }
        await runDendro(baseline, { profile, sourceRef: CONTROL_BASE_REF });
        await runDendro(unreachable, { profile, settingUnreadable: mode === 'unreadable' });
        await runDendro(observed, { profile, weather, settingUnreadable: mode === 'unreadable' });
        assert.deepEqual(await controlOutcome(observed, profile), await controlOutcome(unreachable, profile), 'provider observations cannot change valves while off');
        assert.deepEqual(await controlOutcome(observed, profile), await controlOutcome(baseline, profile), 'same control outputs as the pinned shipped main node');
        const { row, json } = recommendation(observed, '2026-10-08');
        assert.equal(row.rainfall_mm, highVpd ? 0 : 5.4, 'provider rain is still stored');
        assert.equal(row.vpd_source, 'open_meteo');
        if (highVpd) assert.ok(row.vpd_max_kpa > 2, 'high provider VPD is still stored');
        assert.equal(json.weather_control.provider_irrigation_enabled, false);
        assert.equal(json.weather_control.decision_vpd.available, false);
        assert.equal(json.weather_control.decision_rain.daily_mm, null);
      });
    }
    test(`[${tag}] provider control opt-in retains ${highVpd ? 'VPD adjustment' : 'rain suppression'}`, async t => {
      const db = controlFixture('1', highVpd);
      const baseline = controlFixture(null, highVpd);
      t.after(() => { db.close(); baseline.close(); });
      const weather = openMeteoDay(highVpd ? 0 : 5.4);
      if (highVpd) { weather.body.hourly.temperature_2m.fill(35); weather.body.hourly.relative_humidity_2m.fill(20); }
      await runDendro(db, { profile, weather });
      await runDendro(baseline, { profile, sourceRef: CONTROL_BASE_REF });
      assert.notDeepEqual(await controlOutcome(db, profile), await controlOutcome(baseline, profile), 'opt-in must exercise a real decision change');
      assert.equal(recommendation(db, '2026-10-08').row.irrigation_action, highVpd ? 'decrease_10' : 'maintain_rain_suppression');
    });
  }
}

for (const profile of PROFILES) {
  const tag = profile.includes('bcm2709') ? 'bcm2709' : 'bcm2712';

  test(`[${tag}] sandbox transport restores default Open-Meteo rainfall and VPD`, async (t) => {
    const db = seedDb();
    t.after(() => db.close());
    const { calls, warnings } = await runDendro(db, { weather: openMeteoDay(5.4), profile });
    assert.ok(!warnings.some((value) => /require is not defined/.test(value)), warnings.join('; '));
    assert.equal(calls.length, 1, 'the stubbed default weather transport was called');
    assert.ok(calls[0].startsWith('https://archive-api.open-meteo.com/'));
    const { row, json } = recommendation(db, '2026-10-08');
    assert.equal(row.rainfall_mm, 5.4);
    assert.equal(json.rain.source, 'open_meteo');
    assert.equal(row.vpd_source, 'open_meteo');
    assert.ok(row.vpd_max_kpa > 0, 'weather VPD fills the missing local humidity source');
  });

  test(`[${tag}] sandbox transport restores configured HTTP OpenAgri rainfall and VPD`, async (t) => {
    const db = seedDb();
    t.after(() => db.close());
    const weather = { status: 200, body: { data: Array.from({ length: 24 }, (_, hour) => ({
      values: { temperature_2m: 18, relative_humidity_2m: 70, precipitation: hour === 0 ? 5.4 : 0 },
    })) } };
    const { calls, warnings } = await runDendro(db, {
      weather, profile,
      envVars: { OPENAGRI_WEATHER_URL: 'http://weather.example.invalid', OPENAGRI_WEATHER_BEARER_TOKEN: 'fixture-token' },
    });
    assert.ok(!warnings.some((value) => /require is not defined/.test(value)), warnings.join('; '));
    assert.deepEqual(calls, ['http://weather.example.invalid/api/v1/history/hourly/']);
    const { row, json } = recommendation(db, '2026-10-08');
    assert.equal(row.rainfall_mm, 5.4);
    assert.equal(json.rain.source, 'openagri');
    assert.equal(row.vpd_source, 'openagri');
    assert.ok(row.vpd_max_kpa > 0);
  });

  test(`[${tag}] seven prior 1 mm days plus a 1 mm analytics day sum to 7 mm over seven calendar days`, async () => {
    const db = seedDb();
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) {
      addRecommendation(db, date, 1);
    }
    addLocalRain(db, '2026-10-08', 1);
    const { calls } = await runDendro(db, { weather: openMeteoDay(0), profile });
    assert.ok(calls.length >= 1, 'the weather provider was asked (stubbed)');
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_mm, 1);
    assert.equal(json.rain.rolling7d, 7);
    assert.equal(json.rain.rolling7d_days_present, 7);
    assert.deepEqual(json.rain.rolling7d_window, { from: '2026-10-02', to: '2026-10-08' });
    db.close();
  });

  test(`[${tag}] sparse history never reaches outside the seven-day window`, async () => {
    const db = seedDb();
    for (const date of ['2026-09-01', '2026-09-15', '2026-10-06']) addRecommendation(db, date, 1);
    addLocalRain(db, '2026-10-08', 1);
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.rolling7d, 2);
    assert.equal(json.rain.rolling7d_days_present, 2);
    db.close();
  });

  test(`[${tag}] the window follows the zone-local analytics date`, async () => {
    // 03:00Z on 9 October is the evening of 8 October in Los Angeles, so the
    // analytics date is 7 October and the window is 1..7 October.
    const db = seedDb({ timezone: 'America/Los_Angeles' });
    for (const date of ['2026-09-30', '2026-10-01', '2026-10-04', '2026-10-06']) addRecommendation(db, date, 2);
    await runDendro(db, { weather: openMeteoDay(0.5), profile });
    const { json } = recommendation(db, '2026-10-07');
    assert.deepEqual(json.rain.rolling7d_window, { from: '2026-10-01', to: '2026-10-07' });
    assert.equal(json.rain.daily_mm, 0.5);
    assert.equal(json.rain.rolling7d, 6.5);
    assert.equal(json.rain.rolling7d_days_present, 4);
    db.close();
  });

  test(`[${tag}] a stored null day or a day whose rain was unknown is missing, not a zero day`, async () => {
    const db = seedDb();
    addRecommendation(db, '2026-10-02', 1);
    addRecommendation(db, '2026-10-03', 1);
    addRecommendation(db, '2026-10-04', null);
    addRecommendation(db, '2026-10-05', 0, { json: { rain: { daily_mm: 0, daily_status: 'unknown' } } });
    addRecommendation(db, '2026-10-06', 0, { json: { rain: { daily_mm: 0, daily_status: 'observed' } } });
    addRecommendation(db, '2026-10-07', 1, { raw: 'not json' });
    addLocalRain(db, '2026-10-08', 1);
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.rolling7d, 4);
    // 02, 03, 06 (a known zero), 07 and the analytics day; 04 and 05 are missing.
    assert.equal(json.rain.rolling7d_days_present, 5);
    db.close();
  });

  test(`[${tag}] unknown rain keeps the recommendation, warns rain_unknown and never starts rain suppression`, async () => {
    const db = seedDb();
    for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) addRecommendation(db, date, 1);
    const { warnings } = await runDendro(db, { weather: { status: 500, body: null }, profile });
    assert.ok(warnings.some((w) => /Weather API failed/.test(w)), 'the provider failure is reported');
    const { row, json } = recommendation(db, '2026-10-08');
    assert.ok(row.irrigation_action, 'a recommendation is still written');
    assert.notEqual(row.irrigation_action, 'maintain_rain_suppression');
    assert.equal(json.rain.daily_status, 'unknown');
    assert.deepEqual(json.rain.warnings, ['rain_unknown']);
    assert.equal(json.rain.rolling7d, 3);
    assert.equal(json.rain.rolling7d_days_present, 3);
    const state = db.prepare('SELECT rain_suppression_active FROM zone_irrigation_state WHERE zone_id = 1').get();
    assert.equal(state.rain_suppression_active, 0);
    db.close();
  });

  test(`[${tag}] known rain carries no warning`, async () => {
    const db = seedDb();
    addLocalRain(db, '2026-10-08', 1);
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_status, 'observed');
    assert.deepEqual(json.rain.warnings, []);
    db.close();
  });

  test(`[${tag}] 20.8 mm over eight days but 18.2 mm over seven moves the zone from decrease_20 to decrease_10`, async () => {
    const db = seedDb();
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) {
      addRecommendation(db, date, 2.6);
    }
    addLocalRain(db, '2026-10-08', 2.6);
    addUnstressedTreeDay(db, '2026-10-08');
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { row, json } = recommendation(db, '2026-10-08');
    assert.equal(row.irrigation_action, 'decrease_10');
    assert.equal(json.rain.rolling7d, 18.2);
    db.close();
  });
  for (const variant of [{ nullPrecipitation: false, label: 'no precipitation key' }, { nullPrecipitation: true, label: 'only null precipitation' }]) {
    test(`[${tag}] an Open-Meteo day with ${variant.label} is unknown rain, not 0 mm`, async () => {
      const db = seedDb();
      addRecommendation(db, '2026-10-07', 1);
      await runDendro(db, { weather: openMeteoTemperatureOnly(variant), profile });
      const { row, json } = recommendation(db, '2026-10-08');
      assert.equal(json.rain.daily_status, 'unknown');
      assert.deepEqual(json.rain.warnings, ['rain_unknown']);
      assert.equal(json.rain.source, 'none');
      assert.equal(json.rain.rolling7d_days_present, 1);
      // The temperature data still serves VPD.
      assert.equal(json.vpd.vpd_source, 'open_meteo');
      assert.equal(row.rain_suppression_active, 0);
      db.close();
    });
  }

  test(`[${tag}] an OpenAgri day without precipitation values is unknown rain, not 0 mm`, async () => {
    const db = seedDb();
    const weather = {
      status: 200,
      body: { data: [{ values: { temperature_2m: 18, relative_humidity_2m: 70 } }, { values: { temperature_2m: 21, relative_humidity_2m: 60, precipitation: null } }] },
    };
    const { calls } = await runDendro(db, {
      weather,
      profile,
      envVars: { OPENAGRI_WEATHER_URL: 'https://weather.example.invalid', OPENAGRI_WEATHER_BEARER_TOKEN: 'test-token' },
    });
    assert.ok(calls.some((url) => url.includes('/api/v1/history/hourly/')), 'the OpenAgri history route was asked (stubbed)');
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_status, 'unknown');
    assert.deepEqual(json.rain.warnings, ['rain_unknown']);
    assert.equal(json.vpd.vpd_source, 'openagri');
    db.close();
  });

  test(`[${tag}] a provider day with a precipitation value of 0 is a known dry day`, async () => {
    const db = seedDb();
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_status, 'observed');
    assert.equal(json.rain.source, 'open_meteo');
    assert.equal(json.rain.rolling7d_days_present, 1);
    db.close();
  });

  // Zurich DST: the analytics date is zone-local and the window is seven calendar days,
  // whatever the length of the analytics day (23 h in spring, 25 h in autumn).
  for (const dst of [
    { label: 'spring (23-hour day)', now: '2026-03-30T01:00:00.000Z', date: '2026-03-29', from: '2026-03-23', outside: '2026-03-22', inside: ['2026-03-23', '2026-03-28'] },
    { label: 'autumn (25-hour day)', now: '2026-10-26T03:00:00.000Z', date: '2026-10-25', from: '2026-10-19', outside: '2026-10-18', inside: ['2026-10-19', '2026-10-24'] },
  ]) {
    test(`[${tag}] Europe/Zurich DST ${dst.label}: the window is the seven calendar days ending on the local analytics date`, async () => {
      const db = seedDb({ timezone: 'Europe/Zurich' });
      addRecommendation(db, dst.outside, 5);
      for (const date of dst.inside) addRecommendation(db, date, 2);
      addLocalRain(db, dst.date, 1);
      await runDendro(db, { weather: openMeteoDay(0), profile, now: dst.now });
      const { json } = recommendation(db, dst.date);
      assert.deepEqual(json.rain.rolling7d_window, { from: dst.from, to: dst.date });
      assert.equal(json.rain.rolling7d, 5);
      assert.equal(json.rain.rolling7d_days_present, 3);
      db.close();
    });
  }
}

// Real sockets exercise IncomingMessage abort/close and socket/deadline timers.
// Only the URL is redirected; the shipped node calls the real profile helper.
for (const profile of PROFILES) {
  const tag = profile.includes('bcm2709') ? 'bcm2709' : 'bcm2712';
  for (const scenario of ['disconnect', 'no-answer', 'slow-answer', 'endless-body']) {
    test(`[${tag}] bounded weather transport: ${scenario}`, async (t) => {
      const http = require('node:http');
      const request = http.request;
      const db = seedDb();
      addUnstressedTreeDay(db, '2026-10-08');
      db.exec(`
        INSERT INTO irrigation_zones(id, name, user_id, created_at, updated_at, timezone, latitude, longitude)
        SELECT 2, 'Later Zone', user_id, created_at, updated_at, timezone, latitude, longitude FROM irrigation_zones WHERE id=1;
        INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, is_reference_tree)
        SELECT 'A840410000000002', 'Later Tree', type_id, user_id, created_at, updated_at, 2, 1, 0 FROM devices WHERE deveui='${TREE}';
        INSERT INTO dendro_baselines(deveui, mds_max_reference_um, mds_mean_um, baseline_days, baseline_complete, computed_at)
        SELECT 'A840410000000002', mds_max_reference_um, mds_mean_um, baseline_days, baseline_complete, computed_at FROM dendro_baselines;
        INSERT INTO dendrometer_readings(deveui, position_um, is_valid, recorded_at)
        SELECT 'A840410000000002', position_um, is_valid, recorded_at FROM dendrometer_readings;
      `);
      let calls = 0;
      const timers = [];
      const server = http.createServer((_req, res) => {
        calls++;
        if (calls > 1) { res.writeHead(503); res.end(); return; }
        if (scenario === 'no-answer') return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        if (scenario === 'disconnect') {
          timers.push(setTimeout(() => res.destroy(), 25));
        } else if (scenario === 'slow-answer') {
          const body = JSON.stringify(openMeteoDay(5.4).body);
          timers.push(setInterval(() => res.write(' '), 1000));
          timers.push(setTimeout(() => res.end(body.slice(1)), 11000));
        } else {
          timers.push(setInterval(() => res.write(' '), 1000));
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        for (const timer of timers) clearInterval(timer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        db.close();
      });
      const transport = { request(_url, options, callback) {
        return request(`http://127.0.0.1:${server.address().port}/`, options, callback);
      } };
      const started = Date.now();
      const { warnings } = await runDendro(db, {
        profile, transport, completionTimeout: scenario === 'disconnect' ? 2000 : 18000,
      });
      assert.equal(calls, 2, 'the later zone is calculated after the first weather request');
      const rows = db.prepare('SELECT * FROM zone_daily_recommendations ORDER BY zone_id').all();
      assert.equal(rows.length, 2);
      const daily = db.prepare('SELECT mds_um FROM dendrometer_daily').all();
      assert.equal(daily.length, 2, 'both trees have stored sensor analytics');
      assert.ok(daily.every(row => row.mds_um > 0), 'stored daily shrinkage comes from each tree’s readings');
      for (const row of rows) {
        const goodWeather = row.zone_id === 1 && scenario === 'slow-answer';
        assert.equal(row.rainfall_mm, goodWeather ? 5.4 : null);
        assert.equal(row.vpd_source, goodWeather ? 'open_meteo' : 'unavailable');
        assert.equal(row.vpd_max_kpa == null, !goodWeather);
        assert.ok(row.zone_stress_summary, 'sensor-based stress is still stored');
        const zoneName = row.zone_id === 1 ? 'Fixture Zone' : 'Later Zone';
        assert.equal(warnings.filter(w => w.includes('Weather API failed zone ' + zoneName)).length, goodWeather ? 0 : 1, warnings.join('; '));
      }
      assert.ok(Date.now() - started < 17500, 'request is bounded even with a continuously active socket');
      if (scenario === 'slow-answer') assert.ok(Date.now() - started >= 11000, 'a slow but progressing response is accepted');
    });
  }
}
