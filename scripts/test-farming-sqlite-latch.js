'use strict';
// NEW-15: a refusal latched after a farm handle is open stops every further
// operation on it, and a helper that chose its own sqlite3 outside Node-RED
// refuses once Node-RED appears in the process. Separate file: the latch is
// process-wide by design.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createSqlite3Adapter } = require('./lib/sqlite3-node-adapter');
const HELPER = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper');

test('a standalone driver choice is refused once Node-RED is loaded in the same process', () => {
  const { createDriver } = require(path.join(HELPER, 'sqlite-driver.js'));
  let files = ['/srv/node-red/osi-db-helper/index.js'], now = 0;
  const acquire = createDriver(() => ({ Database: function Database() {} }), { loadedFiles: () => files, monotonicNow: () => now });
  assert.doesNotThrow(() => acquire());
  files = [...files, '/usr/lib/node/node-red/node_modules/@node-red/runtime/lib/index.js'];
  now = 1000;
  assert.throws(() => acquire.guard(), { code: 'OSI_SQLITE_REFUSED' });
  assert.throws(() => acquire(), { code: 'OSI_SQLITE_REFUSED' });
});

test('operations on an open shared or independent handle stop once a refusal is latched', async () => {
  const helperPath = path.join(HELPER, 'index.js');
  const original = Module._load;
  let osiDb;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'sqlite3' && parent && parent.filename === helperPath) return createSqlite3Adapter();
      return original.call(this, request, parent, isMain);
    };
    delete require.cache[helperPath];
    osiDb = require(helperPath);
  } finally { Module._load = original; }
  const shared = new osiDb.Database(':memory:');
  assert.deepEqual((await shared.all('SELECT 1 AS one')).map((row) => ({ ...row })), [{ one: 1 }]);
  require(path.join(HELPER, 'startup.js')).driverFailed(new Error('second native addon, simulated'));
  await assert.rejects(shared.all('SELECT 1 AS one'), { code: 'OSI_SQLITE_REFUSED' });
  await assert.rejects(osiDb.isolatedFarmingTransaction(async () => {}), { code: 'OSI_SQLITE_REFUSED' });
  assert.throws(() => osiDb.openNativeFarming(), { code: 'OSI_SQLITE_REFUSED' });
  assert.equal(osiDb.startupHealth().health_state, 'sqlite_driver_unavailable');
});
