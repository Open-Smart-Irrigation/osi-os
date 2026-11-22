#!/usr/bin/env node

const assert = require('assert');
const { functionSource } = require('./flow-function-source');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const flowPath = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const nodeRedRoot = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const helperPath = path.join(nodeRedRoot, 'osi-chameleon-helper/index.js');
const packageJsonPath = path.join(nodeRedRoot, 'package.json');
const packageLockPath = path.join(nodeRedRoot, 'package-lock.json');
const deployPath = path.join(repoRoot, 'deploy.sh');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));

const seedDatabasePaths = [
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
].map((relativePath) => path.join(repoRoot, relativePath));

function nodeById(id) {
  const node = flows.find((entry) => entry.id === id);
  assert(node, `missing flow node ${id}`);
  return node;
}

function funcOf(id) {
  const node = nodeById(id);
  assert.strictEqual(node.type, 'function', `${id} must be a function node`);
  return functionSource(node, nodeRedRoot);
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label}: expected to find ${needle}`);
}

function assertExcludes(haystack, needle, label) {
  assert(!haystack.includes(needle), `${label}: did not expect to find ${needle}`);
}

function assertLibById(id, variableName, moduleName) {
  const libs = nodeById(id).libs || [];
  assert(
    libs.some((entry) => entry.var === variableName && entry.module === moduleName),
    `${id} must import ${moduleName} as ${variableName}`,
  );
}

function compileFunctionNode(id) {
  new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${funcOf(id)}\n})`);
}

function tableColumns(dbPath, tableName) {
  const output = execFileSync('sqlite3', [dbPath, `PRAGMA table_info(${tableName});`], { encoding: 'utf8' });
  return new Set(output.trim().split('\n').filter(Boolean).map((line) => line.split('|')[1]).filter(Boolean));
}

(async () => {
  assert(fs.existsSync(helperPath), 'osi-chameleon-helper/index.js exists');
  const chameleon = require(helperPath);
  assert.strictEqual(typeof chameleon.resistanceOhmsToKpa, 'function', 'helper exports resistanceOhmsToKpa');
  assert.strictEqual(typeof chameleon.buildChameleonSwtMetrics, 'function', 'helper exports buildChameleonSwtMetrics');

  assert.strictEqual(chameleon.resistanceOhmsToKpa(1168, { a: 10.71, b: 0.13, c: 7.18 }), 9.00);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(10257, { a: 10.40, b: 0.13, c: 7.31 }), 32.85);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(101195, { a: 10.33, b: 0.12, c: 7.21 }), 67.05);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(162580, { a: 10.71, b: 0.13, c: 7.18 }), 82.84);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(10000000, { a: 10.71, b: 0.13, c: 7.18 }), null);
  // Current calibration interface is array-keyed, read by Apply Config.
  const calibration = {
    swt1: { a: 10.71, b: 0.13, c: 7.18 },
    swt2: { a: 10.40, b: 0.13, c: 7.31 },
    swt3: { a: 10.33, b: 0.12, c: 7.21 },
  };
  assertIncludes(funcOf('lsn50-apply-config'), 'FROM chameleon_calibrations WHERE array_id = ?', 'calibration is selected by array id');
  assertIncludes(funcOf('lsn50-apply-config'), 'b: row.sensor1_b', 'Apply Config maps stored coefficients');

  const { DatabaseSync } = require('node:sqlite');
  const { executeFunction } = require('./lib/flow-node-harness');
  const calibrationDb = new DatabaseSync(':memory:');
  calibrationDb.exec(fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8'));
  calibrationDb.prepare('INSERT INTO chameleon_calibrations(array_id,sensor_id,sensor1_a,sensor1_b,sensor1_c,sensor2_a,sensor2_b,sensor2_c,sensor3_a,sensor3_b,sensor3_c,source,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('AABBCCDDEEFF0011','synthetic',1,0.13,3,4,5,6,10.33,0.12,7.21,'synthetic','2026-05-10');
  let loadedCalibration;
  try {
    const applyNode = nodeById('lsn50-apply-config');
    const applied = await executeFunction({ ...applyNode, func: 'return (async () => {\n' + applyNode.func + '\n})();' }, {
      msg: { payload: [{ chameleon_enabled: 1, dendro_enabled: 0, temp_enabled: 0, device_mode: 1 }], formattedData: { tempC1: null, batV: null, adcV: null, adcCh1V: null, dendroRatio: null, positionMm: null, dendroStemChangeUm: null, devEui: 'A840410000000001', timestamp: '2026-05-10T06:00:00Z', isChameleon: true, chameleonArrayId: 'AABBCCDDEEFF0011', chameleonR1OhmComp: 874, chameleonR2OhmComp: 836, chameleonR3OhmComp: 882 } },
      db: calibrationDb,
      libOverrides: { chameleon: { ...chameleon, buildChameleonSwtMetrics(sample, options) { loadedCalibration = options.calibration; return chameleon.buildChameleonSwtMetrics(sample, options); } } },
    });
    assert.deepStrictEqual(applied.errors, []);
    assert.deepStrictEqual(loadedCalibration, { swt1: { a: 1, b: 0.13, c: 3 }, swt2: { a: 4, b: 5, c: 6 }, swt3: { a: 10.33, b: 0.12, c: 7.21 } }, 'current array-keyed loader preserves every channel coefficient');
  } finally { calibrationDb.close(); }

  const sample = {
    r1OhmComp: 874,
    r2OhmComp: 836,
    r3OhmComp: 882,
    i2cMissing: 0,
    timeout: 0,
    ch1Open: 0,
    ch2Open: 0,
    ch3Open: 0,
  };
  const metrics = chameleon.buildChameleonSwtMetrics(sample, { enabled: 1, calibration });
  assert.deepStrictEqual(
    { swt1Kpa: metrics.swt1Kpa, swt2Kpa: metrics.swt2Kpa, swt3Kpa: metrics.swt3Kpa },
    { swt1Kpa: 5.85, swt2Kpa: 5.56, swt3Kpa: 6.02 },
  );
  assert.strictEqual(chameleon.buildChameleonSwtMetrics(sample, { enabled: 0, calibration }).swt1Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, timeout: 1 }, { enabled: 1, calibration }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, ch2Open: 1 }, { enabled: 1, calibration }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, ch2Open: true }, { enabled: 1, calibration }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, r1OhmComp: 9999999 }, { enabled: 1, calibration }).swt1Kpa, 300);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.strictEqual(packageJson.dependencies['osi-chameleon-helper'], 'file:osi-chameleon-helper');
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  assert.strictEqual(packageLock.packages[''].dependencies['osi-chameleon-helper'], 'file:osi-chameleon-helper');
  assert(packageLock.packages['node_modules/osi-chameleon-helper'], 'package-lock includes osi-chameleon-helper package');

  assertLibById('lsn50-apply-config', 'chameleon', 'osi-chameleon-helper');
  assertIncludes(funcOf('lsn50-config-query-fn'), 'chameleon_enabled', 'LSN50 config query loads Chameleon enable flag');
  assertIncludes(funcOf('lsn50-apply-config'), 'sensor1_a, sensor1_b, sensor1_c', 'LSN50 calibration query loads Chameleon coefficients');
  assertIncludes(funcOf('lsn50-apply-config'), 'chameleon.buildChameleonSwtMetrics', 'Apply Config derives Chameleon SWT');
  assertIncludes(funcOf('lsn50-apply-config'), 'd.swt1Kpa = swt.swt1Kpa;', 'Apply Config stores SWT1 in formattedData');
  assertIncludes(funcOf('lsn50-apply-config'), 'if (!dendroEnabled)', 'Apply Config still gates dendrometer by dendro_enabled');
  assertExcludes(funcOf('lsn50-apply-config'), '} else if (d.isChameleon === true) {', 'Chameleon no longer bypasses dendrometer derivation');
  assertExcludes(funcOf('dendro-readings-insert-fn'), 'd.isChameleon === true', 'Dendrometer insert no longer skips Chameleon frames by type');

  const normalized = require(path.join(nodeRedRoot, 'osi-lsn50-normalize')).normalize({ devEui: 'A840410000000001', timestamp: '2026-05-10T06:00:00Z', detectedMode: 1, swt1Kpa: 11, swt2Kpa: 22, swt3Kpa: 33 }, {});
  assert.strictEqual(normalized.channels.swt_1, 11); assert.strictEqual(normalized.channels.swt_2, 22); assert.strictEqual(normalized.channels.swt_3, 33);
  assertIncludes(funcOf('460e0bfd95f89e67'), 'writer', 'canonical normalized channels enter durable writer');
  assertIncludes(funcOf('format-devices'), 'COALESCE(dd.swt_1, dd.swt_wm1) AS swt_1', 'GET /api/devices selects canonical SWT1 with Kiwi fallback');
  assertIncludes(funcOf('format-devices'), 'COALESCE(dd.swt_2, dd.swt_wm2) AS swt_2', 'GET /api/devices selects canonical SWT2 with Kiwi fallback');
  assertIncludes(funcOf('format-devices'), 'msg.devices_to_format = msg.payload || [];', 'GET /api/devices keeps device rows request-scoped');
  assertExcludes(funcOf('format-devices'), "flow.set('devices_to_format'", 'GET /api/devices must not store request rows in flow context');
  assertIncludes(funcOf('merge-device-data'), 'chameleon_enabled: d.chameleon_enabled ?? 0', 'GET /api/devices returns Chameleon enable flag');
  assertIncludes(funcOf('merge-device-data'), 'const devices = msg.devices_to_format || [];', 'GET /api/devices reads request-scoped device rows');
  assertExcludes(funcOf('merge-device-data'), "flow.get('devices_to_format'", 'GET /api/devices must not read request rows from flow context');
  const historySource = fs.readFileSync(path.join(nodeRedRoot, 'osi-history-helper/index.js'), 'utf8');
  assertIncludes(funcOf('sensor-history-fn'), 'osiHistory.legacySensorHistory', 'history route calls the maintained history interface');
  assertIncludes(historySource, "swt_3: 'dd.swt_3'", 'sensor history allows SWT3');
  for (const field of ['swt_1', 'swt_2']) {
    assertIncludes(historySource, field + ": 'COALESCE(dd." + field + ", dd.swt_wm" + field.slice(-1) + ")'", 'sensor history allows and coalesces ' + field);
  }
  assert.strictEqual(chameleon.buildChameleonSwtMetrics(sample, { enabled: 1 }).swt1Kpa, null, 'uncalibrated stays pending');
  const queryNode = nodeById('d0b2b1c1a937e16d');
  const loads = [];
  const loader = { require(name) {
    loads.push(name);
    return { ok: true, value: require(path.join(nodeRedRoot, name === 'daily-scheduler' ? 'osi-daily-scheduler' : 'osi-scheduler-mean-query')) };
  } };
  const query = new Function('msg', 'node', 'env', 'osiLib', queryNode.func)(
    { payload: { zone_id: 1, trigger_metric: 'SWT_AVG' } },
    { error(message) { throw new Error(message); } }, { get() {} }, loader);
  const cutoff = query.topic.match(/dd\.recorded_at >= '([^']+)'/)[1];
  assert.strictEqual(query.topic, require(path.join(nodeRedRoot, 'osi-scheduler-mean-query')).buildSwtMeanQuery('SWT_AVG', 1, cutoff));
  assert(loads.includes('scheduler-mean-query'), 'real SWT query helper reached');
  if (queryNode.func.includes("require('daily-scheduler')")) assert(loads.includes('daily-scheduler'), 'staged scheduler reached');
  console.log('scheduler query reached: ' + loads.join(' -> '));
  // Issue #356: the scheduler SWT query lives in osi-scheduler-mean-query.
  const schedulerQuerySource = fs.readFileSync(path.join(nodeRedRoot, 'osi-scheduler-mean-query/index.js'), 'utf8');
  assertIncludes(funcOf('d0b2b1c1a937e16d'), 'osiLib.require("scheduler-mean-query")', 'scheduler loads its SWT query builder');
  assertIncludes(schedulerQuerySource, "ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1", 'scheduler includes Chameleon-enabled LSN50 SWT');
  assertIncludes(schedulerQuerySource, '* 1.0 / ((v1 IS NOT NULL) + (v2 IS NOT NULL) + (v3 IS NOT NULL))', 'SWT_AVG expression handles SWT3');

  compileFunctionNode('lsn50-config-query-fn');
  compileFunctionNode('lsn50-apply-config');
  compileFunctionNode('460e0bfd95f89e67');
  compileFunctionNode('dendro-readings-insert-fn');
  compileFunctionNode('put-chameleon-enabled-auth-fn');

  const deploy = fs.readFileSync(deployPath, 'utf8');
  assertIncludes(deploy, 'osi-chameleon-helper/package.json', 'deploy ships Chameleon helper package manifest');
  assertIncludes(deploy, 'osi-chameleon-helper/index.js', 'deploy ships Chameleon helper implementation');
  assertIncludes(deploy, 'run_schema_migration', 'deploy applies ordered Chameleon schema migrations');

  for (const dbPath of seedDatabasePaths) {
    const devices = tableColumns(dbPath, 'devices');
    const deviceData = tableColumns(dbPath, 'device_data');
    for (const column of [
      'chameleon_enabled',
      'chameleon_swt1_depth_cm',
      'chameleon_swt2_depth_cm',
      'chameleon_swt3_depth_cm',
    ]) {
      assert(devices.has(column), `${path.relative(repoRoot, dbPath)} devices table has ${column}`);
    }
    const coefficients = tableColumns(dbPath, 'chameleon_calibrations');
    for (const column of ['array_id', ...[1, 2, 3].flatMap(channel => ['a', 'b', 'c'].map(coefficient => 'sensor' + channel + '_' + coefficient))]) {
      assert(coefficients.has(column), `${path.relative(repoRoot, dbPath)} calibration table has ${column}`);
    }
    for (const column of ['swt_1', 'swt_2', 'swt_3']) {
      assert(deviceData.has(column), `${path.relative(repoRoot, dbPath)} device_data table has ${column}`);
    }
  }

  console.log('LSN50 Chameleon SWT checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
