#!/usr/bin/env node

const assert = require('assert');
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
  return String(node.func || '');
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
  const rowCalibration = chameleon.calibrationFromDeviceRow({
    chameleon_enabled: 1,
    chameleon_swt1_a: 1,
    chameleon_swt1_b: '',
    chameleon_swt1_c: 3,
    chameleon_swt2_a: 4,
    chameleon_swt2_b: 5,
    chameleon_swt2_c: 6,
  });
  assert.deepStrictEqual(rowCalibration, {
    enabled: 1,
    swt1: { a: 1, b: 0.13, c: 3 },
    swt2: { a: 4, b: 5, c: 6 },
    swt3: { a: 10.33, b: 0.12, c: 7.21 },
  });

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
  const metrics = chameleon.buildChameleonSwtMetrics(sample, { enabled: 1 });
  assert.deepStrictEqual(
    { swt1Kpa: metrics.swt1Kpa, swt2Kpa: metrics.swt2Kpa, swt3Kpa: metrics.swt3Kpa },
    { swt1Kpa: 5.85, swt2Kpa: 5.56, swt3Kpa: 6.02 },
  );
  assert.strictEqual(chameleon.buildChameleonSwtMetrics(sample, { enabled: 0 }).swt1Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, timeout: 1 }, { enabled: 1 }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, ch2Open: 1 }, { enabled: 1 }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, ch2Open: true }, { enabled: 1 }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, r1OhmComp: 9999999 }, { enabled: 1 }).swt1Kpa, 300);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.strictEqual(packageJson.dependencies['osi-chameleon-helper'], 'file:osi-chameleon-helper');
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  assert.strictEqual(packageLock.packages[''].dependencies['osi-chameleon-helper'], 'file:osi-chameleon-helper');
  assert(packageLock.packages['node_modules/osi-chameleon-helper'], 'package-lock includes osi-chameleon-helper package');

  assertLibById('lsn50-apply-config', 'chameleon', 'osi-chameleon-helper');
  assertIncludes(funcOf('lsn50-config-query-fn'), 'chameleon_enabled', 'LSN50 config query loads Chameleon enable flag');
  assertIncludes(funcOf('lsn50-config-query-fn'), 'chameleon_swt1_a', 'LSN50 config query loads Chameleon coefficients');
  assertIncludes(funcOf('lsn50-apply-config'), 'chameleon.buildChameleonSwtMetrics', 'Apply Config derives Chameleon SWT');
  assertIncludes(funcOf('lsn50-apply-config'), 'd.swt1Kpa = swt.swt1Kpa;', 'Apply Config stores SWT1 in formattedData');
  assertIncludes(funcOf('lsn50-apply-config'), 'if (!dendroEnabled)', 'Apply Config still gates dendrometer by dendro_enabled');
  assertExcludes(funcOf('lsn50-apply-config'), '} else if (d.isChameleon === true) {', 'Chameleon no longer bypasses dendrometer derivation');
  assertExcludes(funcOf('dendro-readings-insert-fn'), 'd.isChameleon === true', 'Dendrometer insert no longer skips Chameleon frames by type');

  assertIncludes(funcOf('lsn50-sql-fn'), 'swt_1, swt_2, swt_3', 'device_data insert stores canonical SWT channels');
  assertIncludes(funcOf('format-devices'), 'dd.swt_1', 'GET /api/devices selects SWT1');
  assertIncludes(funcOf('format-devices'), 'msg.devices_to_format = msg.payload || [];', 'GET /api/devices keeps device rows request-scoped');
  assertExcludes(funcOf('format-devices'), "flow.set('devices_to_format'", 'GET /api/devices must not store request rows in flow context');
  assertIncludes(funcOf('merge-device-data'), 'chameleon_enabled: d.chameleon_enabled ?? 0', 'GET /api/devices returns Chameleon enable flag');
  assertIncludes(funcOf('merge-device-data'), 'const devices = msg.devices_to_format || [];', 'GET /api/devices reads request-scoped device rows');
  assertExcludes(funcOf('merge-device-data'), "flow.get('devices_to_format'", 'GET /api/devices must not read request rows from flow context');
  assertIncludes(funcOf('sensor-history-fn'), "'swt_1'", 'sensor history allows SWT1');
  assertIncludes(funcOf('sensor-history-fn'), "'swt_2'", 'sensor history allows SWT2');
  assertIncludes(funcOf('sensor-history-fn'), "'swt_3'", 'sensor history allows SWT3');
  assertIncludes(funcOf('d0b2b1c1a937e16d'), "ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1", 'scheduler includes Chameleon-enabled LSN50 SWT');
  assertIncludes(funcOf('d0b2b1c1a937e16d'), 'COALESCE(dd.swt_3, NULL)', 'SWT_AVG expression handles SWT3');

  compileFunctionNode('lsn50-config-query-fn');
  compileFunctionNode('lsn50-apply-config');
  compileFunctionNode('lsn50-sql-fn');
  compileFunctionNode('dendro-readings-insert-fn');
  compileFunctionNode('put-chameleon-config-auth-fn');

  const deploy = fs.readFileSync(deployPath, 'utf8');
  assertIncludes(deploy, 'osi-chameleon-helper/package.json', 'deploy ships Chameleon helper package manifest');
  assertIncludes(deploy, 'osi-chameleon-helper/index.js', 'deploy ships Chameleon helper implementation');
  assertIncludes(deploy, 'ensure_chameleon_schema', 'deploy repairs live Chameleon SWT schema');

  for (const dbPath of seedDatabasePaths) {
    const devices = tableColumns(dbPath, 'devices');
    const deviceData = tableColumns(dbPath, 'device_data');
    for (const column of [
      'chameleon_enabled',
      'chameleon_swt1_depth_cm',
      'chameleon_swt2_depth_cm',
      'chameleon_swt3_depth_cm',
      'chameleon_swt1_a',
      'chameleon_swt1_b',
      'chameleon_swt1_c',
      'chameleon_swt2_a',
      'chameleon_swt2_b',
      'chameleon_swt2_c',
      'chameleon_swt3_a',
      'chameleon_swt3_b',
      'chameleon_swt3_c',
    ]) {
      assert(devices.has(column), `${path.relative(repoRoot, dbPath)} devices table has ${column}`);
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
