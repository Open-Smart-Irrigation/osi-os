'use strict';
// NEW-15: a second SQLite library in the process is reported and refuses
// nothing; only a driver that cannot be obtained refuses, and then with 503
// and OSI_SQLITE_REFUSED. A helper that chose its own sqlite3 outside
// Node-RED refuses once Node-RED appears in the process. Separate file: the
// state is process-wide by design, and these tests latch it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { createSqlite3Adapter } = require('./lib/sqlite3-node-adapter');
const NR = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const HELPER = path.join(NR, 'osi-db-helper');

test('a standalone driver choice is refused once Node-RED is loaded in the same process', () => {
  const { createDriver } = require(path.join(HELPER, 'sqlite-driver.js'));
  let files = ['/srv/node-red/osi-db-helper/index.js'], now = 0;
  const acquire = createDriver(() => ({ Database: function Database() {} }), { loadedFiles: () => files, monotonicNow: () => now });
  assert.doesNotThrow(() => acquire());
  files = [...files, '/usr/lib/node/node-red/node_modules/@node-red/runtime/lib/index.js'];
  now = 1000;
  assert.throws(() => acquire.guard(), { code: 'OSI_SQLITE_REFUSED', statusCode: 503 });
  assert.throws(() => acquire(), { code: 'OSI_SQLITE_REFUSED', statusCode: 503 });
});

test('under a reported conflict statements run; under a refused driver every route answers 503', async () => {
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
  const startup = require(path.join(HELPER, 'startup.js'));
  const rows = async (db) => (await db.all('SELECT 1 AS one')).map((row) => ({ ...row }));

  // A second library mapped (it opens some other database, or none): the
  // state latches, statements keep running on the open handle and a new one.
  const shared = new osiDb.Database(':memory:');
  assert.deepEqual(await rows(shared), [{ one: 1 }]);
  const realRead = fs.readFileSync;
  fs.readFileSync = function read(file, ...rest) {
    if (file === '/proc/self/maps') {
      return ['7f00-7f01 r-xp 00000000 b3:02 11 /srv/node-red/node_modules/sqlite3/build/Release/node_sqlite3.node',
        '7f02-7f03 r-xp 00000000 b3:02 12 /usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3/build/Release/node_sqlite3.node'].join('\n');
    }
    return realRead.call(this, file, ...rest);
  };
  try { startup.inspectModules(); } finally { fs.readFileSync = realRead; }
  const conflict = osiDb.startupHealth();
  assert.equal(conflict.health_state, 'sqlite_module_conflict');
  assert.equal(conflict.module_paths.length, 2);
  assert.deepEqual(await rows(shared), [{ one: 1 }], 'the open handle still works');
  // readSnapshot opens a new native handle through the same openDatabase.
  assert.deepEqual(await shared.readSnapshot(async (tx) => (await tx.all('SELECT 2 AS two')).map((row) => ({ ...row }))), [{ two: 2 }], 'a new handle opens');

  // The driver cannot be obtained: every helper path refuses with 503 and the code.
  startup.driverFailed(new Error('simulated'));
  await assert.rejects(shared.all('SELECT 1 AS one'), { code: 'OSI_SQLITE_REFUSED', statusCode: 503 });
  await assert.rejects(shared.readSnapshot(async () => {}), { code: 'OSI_SQLITE_REFUSED', statusCode: 503 });
  await assert.rejects(osiDb.isolatedFarmingTransaction(async () => {}), { code: 'OSI_SQLITE_REFUSED', statusCode: 503 });
  assert.throws(() => osiDb.openNativeFarming(), { code: 'OSI_SQLITE_REFUSED', statusCode: 503 });

  // A valve route reached through the valve module answers 503 with the code.
  const payload = Buffer.from(JSON.stringify({ userId: 1, username: 'latch', exp: Date.now() + 60000 })).toString('base64url');
  const token = payload + '.' + crypto.createHmac('sha256', 'synthetic-latch-secret').update(payload).digest('base64url');
  const { handleHttpRequest } = require(path.join(NR, 'osi-valve-control/api.js'));
  for (const route of ['/api/valves', '/api/valves/A840410000000001/schedules']) {
    const msg = { req: { method: 'GET', path: route, headers: { authorization: 'Bearer ' + token } } };
    await handleHttpRequest({ msg, Database: osiDb.Database, environment: { dbPath: ':memory:', authTokenSecret: 'synthetic-latch-secret' } });
    assert.equal(msg.statusCode, 503, route);
    assert.equal(msg.payload.error, 'OSI_SQLITE_REFUSED', route);
  }
});
