'use strict';
// NEW-15: osi-db-helper/sqlite-driver.js selects one native sqlite3 module.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const HELPER = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper');
const { selectDriver } = require(path.join(HELPER, 'sqlite-driver.js'));

const RUNTIME = '/usr/lib/node/node-red/node_modules/@node-red/runtime/lib/index.js';
const FIRMWARE_NODE = '/usr/lib/node/node-red/node_modules/node-red-node-sqlite/sqlite.js';
const USER_NODE = '/srv/node-red/node_modules/node-red-node-sqlite/sqlite.js';

function loaders() {
  const loads = [];
  const localRequire = (request) => { loads.push(['local', request]); return { driver: 'user-directory' }; };
  const requireFrom = (file) => (request) => { loads.push([file, request]); return { driver: file }; };
  return { loads, localRequire, requireFrom };
}

test('inside Node-RED the driver comes from the SQLite node package Node-RED loaded (factory image)', () => {
  const l = loaders();
  const selected = selectDriver([RUNTIME, FIRMWARE_NODE], l.localRequire, l.requireFrom);
  assert.deepEqual(selected, { mode: 'node_red', sqlite3: { driver: FIRMWARE_NODE } });
  assert.deepEqual(l.loads, [[FIRMWARE_NODE, 'sqlite3']]);
});

test('after npm install in the user directory Node-RED loads that package, and so does the helper', () => {
  const l = loaders();
  const selected = selectDriver([RUNTIME, USER_NODE], l.localRequire, l.requireFrom);
  assert.equal(selected.sqlite3.driver, USER_NODE);
  assert.ok(!l.loads.some(([from]) => from === 'local'));
});

test('without a loaded SQLite node package the helper refuses and never tries its own copy', () => {
  const l = loaders();
  assert.throws(() => selectDriver([RUNTIME], l.localRequire, l.requireFrom), /has not loaded node-red-node-sqlite/);
  assert.throws(() => selectDriver([RUNTIME, FIRMWARE_NODE, USER_NODE], l.localRequire, l.requireFrom), /more than one/);
  assert.deepEqual(l.loads, []);
});

test('a failing driver load inside Node-RED is not retried through another copy', () => {
  const l = loaders();
  const failing = () => () => { throw new Error('native load failed'); };
  assert.throws(() => selectDriver([RUNTIME, FIRMWARE_NODE], l.localRequire, failing), /native load failed/);
  assert.deepEqual(l.loads, []);
});

test('a process that is not Node-RED uses the helper\'s own require', () => {
  const l = loaders();
  const selected = selectDriver(['/srv/node-red/osi-db-helper/index.js'], l.localRequire, l.requireFrom);
  assert.deepEqual(selected, { mode: 'standalone', sqlite3: { driver: 'user-directory' } });
  assert.deepEqual(l.loads, [['local', 'sqlite3']]);
});

test('the helper selects its driver through its own require, without a bare sqlite3 import', () => {
  const source = require('node:fs').readFileSync(path.join(HELPER, 'index.js'), 'utf8');
  assert.doesNotMatch(source, /require\('sqlite3'\)/);
  assert.match(source, /require\('\.\/sqlite-driver'\)\.createDriver\(require\)/);
  const index = require(path.join(HELPER, 'index.js'));
  assert.deepEqual([index.OPEN_READONLY, index.OPEN_READWRITE, index.OPEN_CREATE], [1, 2, 4]);
  assert.equal(typeof index.startupHealth, 'function');
  assert.equal(typeof index.openNativeFarming, 'function');
});

test('a stock image whose firmware package has no sqlite3: Node-RED loads the user-directory package and the helper follows it', () => {
  const l = loaders();
  // The user-directory package resolves sqlite3 to /srv/node-red/node_modules/sqlite3 by Node's own lookup.
  const selected = selectDriver([RUNTIME, USER_NODE], l.localRequire, l.requireFrom);
  assert.deepEqual(l.loads, [[USER_NODE, 'sqlite3']]);
  assert.equal(selected.mode, 'node_red');
});
