#!/usr/bin/env node
'use strict';
// Two real Node-RED processes reuse one DB. The second uses the shipped
// 30-second startup inject; no shortened production timer or VM SQLite adapter.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures/release-smoke');
const NODE_MODULES = path.join(FIXTURE, 'node_modules');
const sqlite = require(path.join(NODE_MODULES, 'sqlite3'));
const NativeDatabase = sqlite.Database;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const open = file => new Promise((resolve, reject) => {
  const db = new NativeDatabase(file, error => error ? reject(error) : resolve(db));
});
const sql = (db, query, params = []) => new Promise((resolve, reject) => db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));

async function child(directory, profile, phase) {
  const src = path.join(ROOT, profile);
  const run = path.join(directory, phase);
  const dbfile = path.join(directory, 'farming.db');
  fs.mkdirSync(path.join(run, 'node_modules'), { recursive: true });
  for (const entry of fs.readdirSync(path.join(src, 'node-red'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !(entry.name.startsWith('osi-') || entry.name === 'codecs')) continue;
    fs.cpSync(path.join(src, 'node-red', entry.name), path.join(run, entry.name), { recursive: true });
    fs.symlinkSync(path.join(run, entry.name), path.join(run, 'node_modules', entry.name));
  }
  for (const name of fs.readdirSync(NODE_MODULES)) {
    if (!fs.existsSync(path.join(run, 'node_modules', name))) fs.symlinkSync(path.join(NODE_MODULES, name), path.join(run, 'node_modules', name));
  }
  fs.writeFileSync(path.join(run, 'package.json'), JSON.stringify({ private: true, dependencies: { 'osi-db-helper': 'file:osi-db-helper', 'osi-lib': 'file:osi-lib' } }));
  process.env.OSI_LIB_BASE = run;
  sqlite.Database = class extends NativeDatabase {
    constructor(file, ...args) { super(file === '/data/db/farming.db' ? dbfile : file, ...args); }
  };
  const realRequest = http.request;
  const weather = http.createServer((req, res) => {
    req.resume();
    if (phase === 'restart') { req.socket.destroy(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: Array.from({ length: 24 }, () => ({ values: { temperature_2m: 35, relative_humidity_2m: 20, precipitation: 0 } })) }));
  });
  await new Promise(resolve => weather.listen(0, '127.0.0.1', resolve));
  http.request = https.request = (url, options, callback) => {
    const parsed = new URL(url);
    assert.ok(['127.0.0.1', 'archive-api.open-meteo.com'].includes(parsed.hostname), 'no external provider request');
    return realRequest({ ...options, hostname: '127.0.0.1', port: weather.address().port, path: parsed.pathname, agent: false }, callback);
  };
  process.env.OPENAGRI_WEATHER_URL = 'http://127.0.0.1:' + weather.address().port;
  process.env.OPENAGRI_WEATHER_BEARER_TOKEN = 'synthetic-weather-token';
  const flows = JSON.parse(fs.readFileSync(path.join(src, 'flows.json'), 'utf8'));
  const daily = { ...flows.find(n => n.id === 'dendro-compute-fn'), z: 'restart-test-tab', wires: [['restart-result-sink']] };
  if (process.env.OSI_DENDRO_RUNTIME_SOURCE_REF) {
    const original = JSON.parse(execFileSync('git', ['show', process.env.OSI_DENDRO_RUNTIME_SOURCE_REF + ':' + profile + '/flows.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
    daily.func = original.find(n => n.id === daily.id).func;
  }
  const inject = { ...flows.find(n => n.id === 'dendro-daily-inject'), z: daily.z };
  assert.equal(Number(inject.onceDelay), 30);
  assert.equal(inject.once, true);
  const subset = [{ id: daily.z, type: 'tab', label: 'Dendro restart regression' }, daily,
    { id: 'restart-result-sink', z: daily.z, type: 'restart-test-sink', wires: [] }, ...(phase === 'restart' ? [inject] : [])];
  fs.writeFileSync(path.join(run, 'flows.json'), JSON.stringify(subset, null, 2) + '\n');
  const RED = require(path.join(NODE_MODULES, 'node-red'));
  const server = http.createServer();
  const deliveries = [], errors = [], warnings = [];
  RED.init(server, { userDir: run, flowFile: path.join(run, 'flows.json'), functionExternalModules: true,
    externalModules: { modules: { allowInstall: false } }, httpAdminRoot: false, credentialSecret: false,
    logging: { console: { level: 'off' } } });
  RED.nodes.registerType('restart-test-sink', function(config) {
    RED.nodes.createNode(this, config);
    this.on('input', msg => deliveries.push(msg));
  });
  const logger = new EventEmitter();
  logger.on('log', event => { if (event.level <= 20) errors.push(event.msg); else if (event.level === 30) warnings.push(event.msg); });
  RED.log.addHandler(logger);
  const started = Date.now();
  try {
    await RED.start();
    await sleep(300);
    if (phase === 'restart') RED.nodes.getNode(inject.id).cronjob?.stop();
    else RED.nodes.getNode(daily.id).receive({ payload: Date.now() });
    while (!deliveries.length && Date.now() - started < 60000) await sleep(50);
    assert.equal(deliveries.length, 1, 'the actual daily node finishes once');
    assert.equal(deliveries[0].payload.success, true);
    assert.deepEqual(errors, [], 'no runtime node error');
    if (phase === 'restart') {
      assert.ok(Date.now() - started >= 29000, 'the real startup delay was retained');
      assert.ok(warnings.some(message => /weather failed|Weather API failed/.test(message)));
    }
    fs.writeFileSync(path.join(directory, phase + '.json'), JSON.stringify({ pid: process.pid, node: process.version,
      nodeRed: require(path.join(NODE_MODULES, 'node-red/package.json')).version, seconds: (Date.now() - started) / 1000, warnings }));
  } finally {
    await RED.stop(); weather.closeAllConnections();
    await new Promise(resolve => weather.close(resolve));
    server.close();
  }
}

async function parent() {
  assert.equal(process.versions.node.split('.')[0], '20', 'run real Node-RED with the image-qualified Node 20');
  const results = [];
  for (const variant of ['2712', '2709']) for (const gate of ['0', '1']) {
    const profile = `conf/full_raspberrypi_bcm27xx_bcm${variant}/files/usr/share`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-dendro-restart-'));
    try {
      const dbfile = path.join(directory, 'farming.db');
      fs.copyFileSync(path.join(ROOT, profile, 'db/farming.db'), dbfile);
      let db = await open(dbfile);
      const DA = require(path.join(ROOT, profile, 'node-red/osi-dendro-analytics'));
      const day = DA.computeZoneDayWindow(new Date(), 'UTC').date;
      await sql(db, "INSERT INTO app_settings(key,value) VALUES ('dendro_provider_irrigation_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [gate]);
      await sql(db, "INSERT INTO users(id,username,password_hash,created_at) VALUES (1,'fixture','synthetic',datetime('now'))");
      for (const id of [1, 2]) {
        const eui = 'A84041000000000' + id;
        await sql(db, "INSERT INTO irrigation_zones(id,name,user_id,timezone,latitude,longitude) VALUES (?, ?,1,'UTC',0,0)", [id, 'Fixture zone ' + id]);
        await sql(db, "INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,dendro_enabled,created_at,updated_at) VALUES (?,?,'DRAGINO_LSN50',1,?,1,datetime('now'),datetime('now'))", [eui, 'Fixture tree ' + id, id]);
        await sql(db, 'INSERT INTO dendro_baselines(deveui,mds_max_reference_um,mds_mean_um,baseline_days,baseline_complete,computed_at) VALUES (?,45,38,14,1,datetime(\'now\'))', [eui]);
        for (const [position, time] of [[121,'05:05'],[124,'05:35'],[122,'06:10'],[108,'09:00'],[92,'13:05'],[90,'14:00'],[93,'15:30'],[101,'18:00']])
          await sql(db, 'INSERT INTO dendrometer_readings(deveui,position_um,is_valid,recorded_at) VALUES (?,?,1,?)', [eui, (position - 90) * 4 + 90, day + 'T' + time + ':00.000Z']);
        for (let offset = 1; offset <= 6; offset++) await sql(db, "INSERT INTO zone_daily_recommendations(zone_id,date,zone_stress_summary,rainfall_mm,irrigation_action,computed_at) VALUES (?,?,'none',0,'maintain',datetime('now'))", [id, DA.shiftDateIso(day, -offset)]);
      }
      await close(db);
      const snapshots = [];
      for (const phase of ['success', 'restart']) {
        const run = spawnSync(process.execPath, [__filename, '--child', directory, profile, phase], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 75000, maxBuffer: 4 * 1024 * 1024 });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stdout + run.stderr);
        db = await open(dbfile);
        snapshots.push(await sql(db, 'SELECT zone_id,rainfall_mm,vpd_max_kpa,vpd_source,irrigation_action,action_reasoning,computed_at,sync_version,rain_suppression_active FROM zone_daily_recommendations WHERE date=? ORDER BY zone_id', [day]));
        await close(db);
      }
      assert.equal(snapshots[0].length, 2);
      assert.deepEqual(snapshots[1], snapshots[0], 'a failed restart retains observations, action, freshness and sync_version');
      const scheduler = JSON.parse(fs.readFileSync(path.join(ROOT, profile, 'flows.json'), 'utf8')).find(n => n.id === '5f0d2b7e9b9b1b3a');
      const multiply = vm.runInNewContext('(' + scheduler.func.match(/function applyDurationMultiplier\([^]*?\n\}/)[0] + ')');
      assert.equal(multiply(20, snapshots[1][0].irrigation_action), gate === '1' ? 18 : 22);
      const processes = ['success', 'restart'].map(phase => JSON.parse(fs.readFileSync(path.join(directory, phase + '.json'))));
      assert.notEqual(processes[0].pid, processes[1].pid);
      const result = { profile: variant, gate, day, snapshots, processes, scheduledMinutes: multiply(20, snapshots[1][0].irrigation_action) };
      results.push(result); console.log('PASS two-process restart ' + JSON.stringify(result));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  console.log('PASS provider restart: four gateways, two real Node-RED processes each; no recommendation re-versioned');
}
if (require.main === module) {
  (process.argv[2] === '--child' ? child(...process.argv.slice(3)) : parent()).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
