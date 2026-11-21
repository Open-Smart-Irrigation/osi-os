'use strict';
// Differential harness: the frozen pre-extraction nodes are the oracle. Only
// synthetic data is used; SQLite executes every SQL statement unchanged.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const originalTimingSafeEqual = crypto.timingSafeEqual;
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { spawnSync, spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'scripts/fixtures/x3-zone-env');
const LEGACY = require('../fixtures/x3-zone-env/legacy-nodes.json');
const NOW = '2026-10-25T01:30:00.000Z'; // repeated local hour in Europe/Zurich
const SECRET = 'x3-local-fixture-secret';
const IDS = ['zone-env-fn', 'strega-today-liters-fn', 'get-actuations-query', 'get-actuations-response'];
const PROFILES = ['bcm2712', 'bcm2709'];
function share(profile) { return path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`); }
function token(extra = {}, secret = SECRET, raw) {
  const payload = Buffer.from(raw === undefined ? JSON.stringify({ userId: 1, username: 'fixture', exp: Date.parse(NOW) + 3600000, ...extra }) : raw).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
function fixedDate(now) {
  const RealDate = Date;
  return class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new RealDate(now).getTime(); }
  };
}
function sqlValue(v) { return v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'"; }
function database(dir) {
  // Node 20 (the release runtime) has no node:sqlite. Use a persistent
  // Python SQLite worker there, and the native engine on development Node 22+.
  let db;
  if (Number(process.versions.node.split('.')[0]) >= 22) {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(':memory:');
    return { exec: sql => db.exec(sql), rows: (sql, params) => db.prepare(sql).all(...params), close: () => db.close() };
  }
  // A persistent SQLite worker avoids a process and disk fsync per SQL call.
  // The parent uses blocking FIFOs, so the same synchronous harness interface
  // runs inside Node-RED 3/4 on release Node 20 without another npm dependency.
  const input = path.join(dir, 'sql-in');
  const output = path.join(dir, 'sql-out');
  const fifo = spawnSync('mkfifo', [input, output], { encoding: 'utf8' });
  if (fifo.error || fifo.status) throw fifo.error || new Error(fifo.stderr);
  const inputFd = fs.openSync(input, fs.constants.O_RDWR);
  const outputFd = fs.openSync(output, fs.constants.O_RDWR);
  const child = spawn('python3', ['-u', path.join(__dirname, 'x3-sqlite-worker.py')], { stdio: [inputFd, outputFd, 'inherit'] });
  const buffer = Buffer.alloc(65536);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function call(request) {
    const bytes = Buffer.from(JSON.stringify(request) + '\n');
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(inputFd, bytes, written, bytes.length - written);
    while (!pending.includes('\n')) {
      const count = fs.readSync(outputFd, buffer, 0, buffer.length, null);
      if (!count) throw new Error('SQLite worker exited without a response');
      pending += decoder.write(buffer.subarray(0, count));
    }
    const end = pending.indexOf('\n');
    const answer = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    if (!answer.ok) throw new Error(answer.error);
    return answer.value;
  }
  return { exec: sql => call({ kind: 'exec', sql }), rows: (sql, params) => call({ kind: 'rows', sql, params }), close() {
    call({ kind: 'close' });
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
    child.unref();
  } };
}
function seed(db, c) {
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  db.exec(`INSERT INTO users(id,username,password_hash,created_at,updated_at,auth_mode,server_url,server_sync_token) VALUES(1,'fixture','x','${NOW}','${NOW}','${c.linked ? 'server' : 'local'}',${c.linked ? "'https://cloud.example.test'" : 'NULL'},${c.linked ? "'fixture-sync'" : 'NULL'});
    INSERT INTO irrigation_zones(id,user_id,name,zone_uuid,gateway_device_eui,timezone,latitude,longitude,area_m2,irrigation_efficiency_pct,scheduling_mode) VALUES(1,1,'Fixture zone','zone-fixture','0016C001F1000001',${sqlValue(c.timezone || 'UTC')},${c.noLocation ? 'NULL,NULL' : '0,0'},100,${c.nullCalibration ? 'NULL' : 90},'${c.serverPreferred ? 'server_preferred' : 'local'}');
    INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at,rain_gauge_enabled,flow_meter_enabled) VALUES('A840410000000001','Fixture sensor','KIWI_SENSOR',1,1,'${NOW}','${NOW}',${c.gauge ? 1 : 0},1);
    INSERT INTO irrigation_schedules(id,irrigation_zone_id,trigger_metric,threshold_kpa,enabled) VALUES(1,1,'SWT_1',30,1);`);
  if (!c.noSamples) db.exec(`INSERT INTO device_data(deveui,recorded_at,ambient_temperature,relative_humidity,swt_1,swt_2,vwc_1,soil_temp_1) VALUES('A840410000000001','${c.sampleAt || c.now || NOW}',0,0,NULL,25,0,0);`);
  if (c.sharedStation) db.exec(`INSERT INTO weather_station_zones(deveui,zone_id) VALUES('A840410000000001',1);`);
  if (c.rain != null) db.exec(`INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at) VALUES(1,'2026-10-25',${c.rain},${c.measured || 0},'aquascope_lorain','${NOW}');`);
  if (c.coverage) db.exec(`UPDATE zone_daily_environment SET rain_policy_version=2,rain_coverage=${sqlValue(c.coverage)},rain_selected_deveui='A840410000000001',rain_received_mm=0 WHERE zone_id=1;`);
  const labels = ['manual', 'one_time', 'cloud_command', 'trigger_based', 'conditional', null, 'on_valve_schedule'];
  for (let i = 0; i < labels.length; i++) {
    db.exec(`INSERT INTO valve_actuation_expectations(expectation_id,device_eui,zone_id,command_id,commanded_at,commanded_duration_seconds,expected_close_at,estimated_gross_liters,flow_rate_lpm,volume_source,reconciliation_state,trigger,created_at) VALUES('exp-${i}','A840410000000001',1,'cmd-${i}','2026-10-25T00:00:00.000Z',${i * 60},'2026-10-25T01:00:00.000Z',${i === 0 ? 'NULL' : i === 1 ? 0 : 5},${i === 0 ? 'NULL' : 0},'${i % 2 ? 'calibrated' : 'unknown'}','${i === 4 ? 'CANCELLED' : i === 5 ? 'STALE_NO_OBSERVATION' : 'PENDING_OBSERVATION'}',${sqlValue(labels[i])},'${NOW}');`);
  }
  db.exec("UPDATE valve_actuation_expectations SET transport_json='{}' WHERE expectation_id='exp-6'; INSERT INTO applied_commands(command_id,device_eui,command_type,result,applied_at) VALUES('cmd-2','A840410000000001','OPEN_FOR_DURATION','REFUSED','2026-10-25T00:00:01Z');");
  if (c.zeroVolume) db.exec('UPDATE valve_actuation_expectations SET estimated_gross_liters=0;');
  if (c.nullVolume) db.exec('UPDATE valve_actuation_expectations SET estimated_gross_liters=NULL;');
  if (c.manyReports) {
    for (let i = 0; i < 55; i++) db.exec(`INSERT INTO valve_actuation_expectations(expectation_id,device_eui,zone_id,command_id,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,transport_json,created_at) VALUES('report-${i}','A840410000000001',1,NULL,'2026-10-25T01:00:00Z',60,'2026-10-25T01:01:00Z','unknown','{"physical_run":{"version":1,"source":"explicit_report","earliest_possible_start_at":null,"latest_possible_end_at":null}}','${NOW}');`);
  }
  const bundle = { zoneId: 1, zoneName: 'Shared fixture', water: { available: true, rainTodayMm: 0, waterNeededTodayMm: null, daily: [{ date: c.yesterday ? '2026-10-24' : '2026-10-25', rainMm: 0, irrigationLiters: 999 }] } };
  if (c.sharedAge != null) db.exec(`INSERT INTO zone_shared_environment(zone_uuid,zone_id,summary_json,last_received_at) VALUES('zone-fixture',1,${sqlValue(c.badShared ? '{' : JSON.stringify(bundle))},${sqlValue(new Date(Date.parse(c.now || NOW) - c.sharedAge * 60000).toISOString())});`);
  if (c.noIdentity) db.exec('UPDATE irrigation_zones SET zone_uuid=NULL,gateway_device_eui=NULL;');
  if (c.notFound) db.exec('UPDATE irrigation_zones SET deleted_at=CURRENT_TIMESTAMP;');
  for (const key of c.cached ? c.currentOnly ? ['online_current_v2'] : c.forecastOnly ? ['forecast_v2'] : ['online_current_v2', 'forecast_v2'] : []) {
    const payload = key === 'online_current_v2' ? { source: 'cached', observedAt: NOW, airTemperatureC: 0, rainMm: 0, relativeHumidityPct: null } : { source: 'cached', observedAt: NOW, hours: [{time: NOW, rainMm: 0, airTemperatureC: null}], days: [] };
    db.exec(`INSERT INTO zone_weather_cache(zone_id,cache_key,source,payload_json,observed_at,fetched_at,expires_at) VALUES(1,${sqlValue(key)},'cached',${sqlValue(c.badCache ? '{' : JSON.stringify(payload))},'${NOW}','${NOW}',${sqlValue(new Date(Date.parse(c.now || NOW) + (c.expiresNow ? 0 : c.expired ? -1 : 1) * 60000).toISOString())});`);
  }
  if (c.extended) require('./x3-zone-env-extra-cases').seedExtra(db, c, bundle);
  return c.bundle || bundle;
}
function weather(url, c, bundle) {
  const now = Date.parse(c.now || NOW);
  if (url.includes('environment-bundles')) return c.sharedEntries || (c.emptyShared ? [] : [{ zoneUuid: 'zone-fixture', summary: bundle }]);
  if (c.httpReplies) { for (const [match, reply] of Object.entries(c.httpReplies)) if (url.includes(match)) return reply; }
  if (url.endsWith('/auth/token')) return c.noToken ? {} : { jwt_token: 'fixture-provider' };
  if (url.includes('/weather/')) return { data: { dt: now / 1000, main: { temp: 0, humidity: 0, pressure: null }, wind: { speed: 0, deg: 0 }, weather: [] } };
  if (url.includes('/forecast5/')) return ['ambient_temperature','ambient_humidity','wind_speed','wind_direction','rainfall_3h','precipitation'].filter(type => !c.supplementalRain || type !== 'rainfall_3h').flatMap(measurement_type => [0,3,6].map(hour => ({ timestamp: new Date(now + hour * 3600000).toISOString(), measurement_type, value: 0 })));
  if (url.includes('current=')) return { utc_offset_seconds: 0, current: { time: now / 1000, temperature_2m: 0, relative_humidity_2m: 0, precipitation: 0, wind_speed_10m: null, wind_direction_10m: 0 } };
  const hours = Array.from({ length: 50 }, (_, i) => Date.parse('2026-10-25T00:00:00Z') / 1000 + i * 3600);
  return { utc_offset_seconds: 0, hourly: { time: hours, temperature_2m: hours.map(() => 0), relative_humidity_2m: hours.map(() => null), precipitation: hours.map((t, i) => c.noRain ? null : c.boundaryRain ? (i === 1 || t * 1000 === now + 24 * 3600000 ? 2 : 0) : 0), precipitation_probability: hours.map(() => 0) }, daily: { time: [Date.parse('2026-10-25') / 1000], precipitation_sum: [0], et0_fao_evapotranspiration: [0], temperature_2m_min: [0], temperature_2m_max: [0] } };
}
function statusRows() {
  const base = { expected_close_at: '2026-10-25T01:00:00Z', commanded_duration_seconds: 0, estimated_gross_liters: 0, flow_rate_lpm: 0, zone_id: 0 };
  return [
    { ...base, reconciliation_state: 'CANCELLED', command_result: 'REFUSED' },
    { ...base, command_result: 'REFUSED' },
    { ...base, command_result: 'applied', observed_open_at: 'open', observed_close_at: 'close' },
    { ...base, observed_open_at: 'open' },
    { ...base, observed_open_at: 'open', expected_close_at: '2026-10-25T00:59:59Z' },
    { ...base }, { ...base, expected_close_at: '2026-10-25T00:59:59Z' },
    { ...base, expected_close_at: null }, { ...base, expected_close_at: 'invalid', estimated_gross_liters: null, flow_rate_lpm: null },
  ].map((row, i) => ({ ...row, trigger: ['manual', 'one_time', 'cloud_command', 'trigger_based', 'conditional', 'on_valve_schedule', 'service_action', null, 'unknown'][i] }));
}
async function execute(profile, source, c, executor) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-'));
  const db = database(dir);
  const bundle = seed(db, c);
  const trace = [];
  let closes = 0, sqlIndex = 0;
  const branches = { sqlErrors: [], loads: [], closeCallbacks: 0, signatureChecks: [] };
    const root = share(profile);
  const envValues = { AUTH_TOKEN_SECRET: SECRET, ...(c.openagri ? { OPENAGRI_WEATHER_URL: c.providerUrl || 'https://provider.example.test', ...(c.staticToken ? { OPENAGRI_WEATHER_BEARER_TOKEN: 'fixture-provider' } : { OPENAGRI_WEATHER_USERNAME: 'fixture', OPENAGRI_WEATHER_PASSWORD: 'fixture-password' }) } : {}), ...(c.scoped ? { OSI_SCOPED_ACCESS: '1' } : {}), ...c.env };
  const facade = {};
  for (const kind of ['all', 'get', 'run']) facade[kind] = (sql, params, cb) => {
    if (typeof params === 'function') { cb = params; params = []; }
    params = params || [];
    const task = () => {
      trace.push({ kind, sql, params });
      if (++sqlIndex === c.faultSql || c.faultPattern && sql.includes(c.faultPattern)) throw new Error('fixture SQL failure');
      // Real seed already has the compatibility columns; preserve the exact
      // error across SQLite CLI/native engines for parity of caught DDL.
      if (kind === 'run') { db.exec(sql); return undefined; }
      const rows = db.rows(sql, params);
      return kind === 'get' ? rows[0] : rows;
    };
    try { const value = task(); if (cb) { cb(null, value); return; } return Promise.resolve(value); }
    catch (e) { if (c.extended) branches.sqlErrors.push({ sql, message: e.message }); if (cb) { cb(e); return; } return Promise.reject(e); }
  };
  facade.close = cb => { closes++; trace.push({ kind: 'close' }); if (c.closeError) throw new Error('fixture close failure'); if (cb) { if (c.closeCallbackError) branches.closeCallbacks++; cb(c.closeCallbackError ? new Error('fixture callback close error') : undefined); } };
  const osiDb = { Database: function(file) { trace.push({ kind: 'open', file }); if (c.openError) throw new Error('fixture open failure'); return facade; } };
  const makeHttp = transport => ({ request(url, options, callback) {
    const item = { kind: 'http', url, options, body: '', ...(c.extended ? { transport } : {}) }; trace.push(item);
    const req = new EventEmitter();
    req.write = body => { item.body += body; };
    req.destroy = e => req.emit('error', e);
    req.setTimeout = (ms, callback) => { item.timeoutMs = ms; req.timeout = callback; };
    req.end = () => process.nextTick(() => {
      const selected = (c.httpFaults || []).find(rule => url.includes(rule.match));
      const failure = selected ? selected.failure : c.httpFailure;
      const fail = failure && (!c.failSharedOnly || url.includes('environment-bundles'));
      if (fail === 'timeout' || fail && failure === 'timeout') return req.timeout();
      if (fail && failure === 'network') return req.destroy(new Error(selected?.failureMessage || 'fixture network failure'));
      const res = new EventEmitter(); res.statusCode = fail && failure === 'status' ? selected?.statusCode || 503 : 200;
      callback(res);
      process.nextTick(() => {
        const body = selected?.responseBody ?? (fail && failure === 'malformed' ? '{' : fail && failure === 'empty' ? '' : fail && failure === 'shape' ? '{}' : JSON.stringify(weather(url, c, bundle)));
        if (c.captureProviderResponse) { item.responseBody = body; item.responseStatus = res.statusCode; }
        res.emit('data', body); res.emit('end');
      });
    });
    return req;
  } });
  const http = makeHttp('http'), https = makeHttp('https');
  const diagnostics = [];
  const node = Object.fromEntries(['warn', 'error', 'log', 'status', 'send'].map(kind => [kind, (value, message) => diagnostics.push({ kind, value: value && value.message ? value.message : value, ...(c.extended && message ? { message: JSON.parse(JSON.stringify(message)) } : {}) })]));
  const loadCounts = {};
  const osiLib = { require(name) {
    // Loading the newly required facade in the run adapters is wiring. Record
    // the original dependency resolutions inside it, in their original order.
    if (c.extended) branches.loads.push(name);
    if (!(name === 'zone-env' && c.node !== IDS[0])) trace.push({ kind: 'load', name });
    loadCounts[name] = (loadCounts[name] || 0) + 1;
    if (name === c.missingModule && (!c.missingModuleOn || loadCounts[name] === c.missingModuleOn)) return { ok: false, error: 'fixture module unavailable', ...(c.quarantined ? { quarantined: true } : {}) };
    if (name === 'scope') return { ok: true, value: {
      resolveAuthSecret: () => SECRET,
      resolveZoneUuidById: async (db, id) => { if (c.scopeResolveError) throw new Error('fixture zone resolution failure'); return c.realScope ? require(path.join(root, 'node-red/osi-scope-helper')).resolveZoneUuidById(db, id) : c.scopeMissingZone ? null : 'zone-fixture'; },
      assertEnabledAccount: async () => { if (c.disabled) { const e = new Error('disabled'); e.statusCode = 403; throw e; } },
    } };
    const modulePath = path.join(root, 'node-red', name === 'osi-valve-control' ? name : 'osi-' + name);
    return { ok: true, value: c.missingPredicate && name === 'osi-valve-control' ? {} : require(modulePath) };
  } };
  let msg = { res: { fixture: 'response-handle' }, req: { headers: { authorization: c.auth === 'missing' ? undefined : c.auth === 'invalid' ? 'Bearer invalid' : token(c.expiredAuth ? { exp: 1 } : c.unknownUser ? { username: 'unknown' } : {}) }, params: { zone_id: c.invalidId ? 'invalid' : '1', deveui: c.invalidId ? '' : 'a840410000000001' }, query: { depth: 90 } }, payload: c.node === IDS[2] ? c.noUser ? [] : [{ id: 1 }] : c.node === IDS[3] ? c.badRows ? {} : statusRows() : undefined, authUsername: c.unknownUser ? 'unknown' : 'fixture', _msgid: 'fixture-msg' };
  if (c.extended) {
    const signSecret = c.signGenerated ? Buffer.alloc(48, 0x42).toString('hex') : SECRET;
    if (c.authCase) {
      const raw = c.authCase === 'malformed-json' ? '{' : c.authCase === 'missing-user' ? JSON.stringify({ username: 'fixture' }) : c.authCase === 'missing-name' ? JSON.stringify({ userId: 1 }) : undefined;
      msg.req.headers.authorization = token({ exp: Date.parse(c.now || NOW) + 3600000 }, signSecret, raw);
      if (c.authCase === 'wrong-signature') { const auth = msg.req.headers.authorization; msg.req.headers.authorization = auth.slice(0,-1) + (auth.endsWith('A') ? 'B' : 'A'); }
    } else if (!c.auth && !c.expiredAuth) msg.req.headers.authorization = token({ exp: Date.parse(c.now || NOW) + 3600000 }, signSecret);
    if (Object.prototype.hasOwnProperty.call(c, 'payload')) msg.payload = c.payload;
  }
  const fakeFs = {
    readFileSync(file) {
      trace.push({ kind: 'fs-read', file });
      if (c.authStorage === 'read-error') { const e = new Error('fixture read failure'); e.code = 'EACCES'; throw e; }
      if (c.authStorage === 'existing') return SECRET + '\n';
      const e = new Error('missing'); e.code = 'ENOENT'; throw e;
    },
    writeFileSync(file, value, options) {
      trace.push({ kind: 'fs-write', file, value, options });
      if (c.authStorage === 'write-error') throw new Error('fixture write failure');
    },
  };
  const globals = { get(key) { if (key === 'fs') return c.noSecret ? undefined : fakeFs; }, set() { throw new Error('unexpected global write'); } };
  const dependencies = { osiDb, osiLib, crypto: { ...crypto, randomBytes: size => Buffer.alloc(size, 0x42), timingSafeEqual(a,b) { const result=originalTimingSafeEqual(a,b); if(c.extended) branches.signatureChecks.push(result); return result; } }, httpLib: http, httpsLib: https, env: { get: key => envValues[key] }, global: globals, node, Date: fixedDate(c.now || NOW) };
  const RealDate = global.Date;
  global.Date = dependencies.Date;
  let result, thrown;
  try {
    result = executor ? await executor(source, msg, dependencies) : await new Function('msg', ...Object.keys(dependencies), source.func)(msg, ...Object.values(dependencies));
  } catch (e) { thrown = { name: e.name, message: e.message }; }
  finally { global.Date = RealDate; }
  const state = Object.fromEntries(['zone_weather_cache', 'zone_shared_environment'].map(table => [table, db.rows('SELECT * FROM ' + table + ' ORDER BY 1,2', [])]));
  const schema = c.extended ? require('./x3-zone-env-extra-cases').schemaState(db) : undefined;
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(JSON.stringify({ result, msg, thrown, trace, diagnostics, closes, state, ...(c.extended ? { branches, schema } : {}) }));
}
const scenarios = [
  ...[
    ['local-zero', { gauge: true, rain: 0, measured: 12 }], ['local-no-samples', { noSamples: true, noRain: true }],
    ...['complete','complete_so_far','partial','unknown'].map(coverage => ['rain-' + coverage, { gauge: true, rain: 0, coverage }]),
    ['no-location', { noLocation: true }], ['stale-local-sensor', { sampleAt: '2026-10-24T21:00:00Z' }], ['shared-station', { sharedStation: true }],
    ['server-preferred-unlinked', { serverPreferred: true }], ['linked-no-identity', { linked: true, noIdentity: true }],
    ['shared-fresh', { linked: true, sharedAge: 5 }], ['shared-fetch', { linked: true }],
    ['shared-stale', { linked: true, sharedAge: 5.01, httpFailure: 'timeout', failSharedOnly: true }],
    ['shared-180', { linked: true, sharedAge: 180, httpFailure: 'status', failSharedOnly: true }],
    ['shared-expired', { linked: true, sharedAge: 180.01, httpFailure: 'malformed', failSharedOnly: true }],
    ['shared-yesterday', { linked: true, sharedAge: 1, yesterday: true }], ['shared-corrupt', { linked: true, sharedAge: 1, badShared: true }],
    ['shared-empty', { linked: true, emptyShared: true }], ['current-forecast-cache', { cached: true }],
    ['cache-expired-refresh', { cached: true, expired: true }],
    ['cache-expiry-equal-now', { cached: true, expiresNow: true }],
    ['cache-current-only', { cached: true, currentOnly: true }], ['cache-forecast-only', { cached: true, forecastOnly: true }],
    ['cache-no-location', { cached: true, noLocation: true }], ['shared-fresh-unlinked', { sharedAge: 1 }],
    ['cache-ttl-clamp', { env: { OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES: '-1', OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES: '-1' } }],
    ['cache-ttl-invalid', { env: { OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES: 'bad', OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES: 'bad' } }], ['cache-expired-offline', { cached: true, expired: true, httpFailure: 'timeout' }],
    ['cache-corrupt', { cached: true, badCache: true }], ['openagri-token', { openagri: true }], ['openagri-static', { openagri: true, staticToken: true }],
    ['openagri-no-token', { openagri: true, noToken: true }],
    ['openagri-supplemental-rain', { openagri: true, supplementalRain: true }], ['precipitation-boundaries', { boundaryRain: true, now: '2026-10-25T01:00:00Z' }],
    ['null-calibration', { nullCalibration: true }], ['missing-depth-alternatives', {}],
    ['spring-DST', { timezone: 'Europe/Zurich', now: '2026-03-29T01:30:00Z' }], ['fall-DST', { timezone: 'Europe/Zurich' }],
    ['not-found', { notFound: true }], ['invalid-id', { invalidId: true }], ['missing-auth', { auth: 'missing' }],
    ['invalid-auth', { auth: 'invalid' }], ['expired-auth', { expiredAuth: true }],
    ['no-auth-secret', { env: { AUTH_TOKEN_SECRET: '' }, noSecret: true }],
    ...['existing','read-error','write-error','generate'].map(authStorage => ['auth-storage-' + authStorage, { env: { AUTH_TOKEN_SECRET: '' }, authStorage }]),
    ['scoped', { scoped: true }], ['scoped-no-zone', { scoped: true, scopeMissingZone: true }],
    ['scoped-helper-missing', { scoped: true, missingModule: 'scope' }],
    ['scoped-disabled', { scoped: true, disabled: true }],
    ['scoped-helper-after-auth', { scoped: true, missingModule: 'scope', missingModuleOn: 2 }],
    ['scoped-user-missing', { scoped: true, unknownUser: true }],
    ['scoped-user-read-error', { scoped: true, faultPattern: 'SELECT user_uuid FROM users' }],
    ['shared-write-error', { linked: true, faultPattern: 'INSERT INTO zone_shared_environment' }],
    ['shared-station-read-error', { sharedStation: true, faultPattern: 'WHERE d.deveui IN (' }],
    ['zone-helper-missing', { missingModule: 'zone-env' }], ['rain-helper-missing', { missingModule: 'rain' }],
    ['valve-helper-missing', { missingModule: 'osi-valve-control' }],
    ...['timeout', 'malformed', 'status', 'network', 'empty', 'shape'].map(httpFailure => ['provider-' + httpFailure, { httpFailure }]),
  ].map(([name, opts]) => ({ name: 'environment/' + name, node: IDS[0], ...opts })),
  ...['normal', 'no-user', 'scoped', 'disabled', 'scope-missing', 'valve-missing', 'reports', 'close-error'].map(name => ({ name: 'actuations/' + name, node: IDS[2], noUser: name === 'no-user', scoped: ['scoped', 'disabled', 'scope-missing'].includes(name), disabled: name === 'disabled', missingModule: name === 'scope-missing' ? 'scope' : name === 'valve-missing' ? 'osi-valve-control' : undefined, manyReports: name === 'reports', closeError: name === 'close-error' })),
  ...['normal', 'missing-auth', 'invalid-auth', 'expired-auth', 'invalid-id', 'scoped', 'scope-missing', 'valve-missing', 'close-error', 'midnight', 'spring-DST', 'fall-DST'].map(name => ({ name: 'liters/' + name, node: IDS[1], auth: name === 'missing-auth' ? 'missing' : name === 'invalid-auth' ? 'invalid' : undefined, expiredAuth: name === 'expired-auth', invalidId: name === 'invalid-id', scoped: ['scoped', 'scope-missing'].includes(name), missingModule: name === 'scope-missing' ? 'scope' : name === 'valve-missing' ? 'osi-valve-control' : undefined, closeError: name === 'close-error', now: name === 'midnight' ? '2026-10-25T00:00:00Z' : name === 'spring-DST' ? '2026-03-29T01:30:00Z' : NOW })),
  { name: 'actuations/scoped-read-error', node: IDS[2], scoped: true, faultPattern: 'SELECT user_uuid FROM users' },
  { name: 'actuations/scoped-user-missing', node: IDS[2], scoped: true, unknownUser: true },
  { name: 'liters/scoped-helper-after-auth', node: IDS[1], scoped: true, missingModule: 'scope', missingModuleOn: 2 },
  { name: 'liters/scoped-read-error', node: IDS[1], scoped: true, faultPattern: 'SELECT user_uuid FROM users' },
  { name: 'liters/scoped-user-missing', node: IDS[1], scoped: true, unknownUser: true },
  { name: 'liters/zero-only', node: IDS[1], zeroVolume: true },
  { name: 'liters/null-only', node: IDS[1], nullVolume: true },
  { name: 'liters/scoped-disabled', node: IDS[1], scoped: true, disabled: true },
  { name: 'response/status-matrix', node: IDS[3] },
  { name: 'response/invalid-rows', node: IDS[3], badRows: true, expectThrown: true },
  { name: 'environment/open-error', node: IDS[0], openError: true, expectThrown: true },
  { name: 'environment/close-error', node: IDS[0], closeError: true, expectedCloses: 2 },
  { name: 'environment/module-missing-close-error', node: IDS[0], missingModule: 'zone-env', closeError: true, expectThrown: true },
  { name: 'actuations/open-error', node: IDS[2], openError: true, expectThrown: true },
  { name: 'liters/open-error', node: IDS[1], openError: true },
];
module.exports = { execute, scenarios, IDS, LEGACY, PROFILES, FIXTURES, share, ROOT, NOW, SECRET, token, fixedDate };
