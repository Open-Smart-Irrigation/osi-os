'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const flowPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const byId = Object.fromEntries(flows.map((node) => [node.id, node]));
const expectedCaps = ['watermark_v1', 'chameleon_config_commands_v1', 'device_soil_depth_commands_v1'];

for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
  const node = byId[id];
  assert.ok(node, `${id} exists`);
  assert.match(node.func, /watermark_calibrations/);
  assert.match(node.func, /deleted_at/);
  assert.match(node.func, /effective_op/);
  assert.match(node.func, /gateway_device_eui/);
  assert.match(node.func, /NULLIF\(trim\(\(SELECT gateway_device_eui FROM devices/);
  assert.match(node.func, /NULLIF\(trim\(\(SELECT gateway_device_eui FROM sync_link_state/);
  assert.ok(node.func.indexOf('devices') < node.func.indexOf('watermark_calibrations'), `${id} emits calibration after devices`);
  assert.doesNotMatch(node.func, /watermark_readings/, `${id} does not ship raw watermark readings`);
  for (const cap of expectedCaps) assert.match(node.func, new RegExp(cap), `${id} advertises ${cap}`);
}

const link = byId['al-link-build-req'];
assert.ok(link, 'link builder exists');
for (const cap of expectedCaps) assert.match(link.func, new RegExp(cap), `link advertises ${cap}`);
const capabilityLists = [
  ...flows.filter((node) => /sync-bootstrap-build|sync-force-build|Build server auth request/.test(node.id + ' ' + node.name))
    .map((node) => [...node.func.matchAll(/['"]([a-z][a-z0-9_]+_v1)['"]/g)].map((m) => m[1]).filter((v) => expectedCaps.includes(v)))
];
assert.ok(capabilityLists.length >= 3, 'all three builders expose capability tokens');
for (const list of capabilityLists) assert.deepEqual(list, expectedCaps, 'capability order is stable');

// Execute both shipped builders against one real SQLite fixture. The child
// adapts node:sqlite's synchronous API to the callback-shaped DB helper and
// supplies only deterministic local cloud responses to force-sync.
const realSqlProbe = spawnSync(process.execPath, ['-e', `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const root = ${JSON.stringify(ROOT)};
  const seed = fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8');
  const bootstrapBody = ${JSON.stringify(byId['sync-bootstrap-build'].func)};
  const forceBody = ${JSON.stringify(byId['sync-force-build'].func)};
  const installation = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper/index.js'));
  const rejection = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rejection-recovery/index.js'));
  const gateway = '0011223344556677';
  const linkedGateway = '0011223344556677';
  const liveDevice = 'AABBCCDDEEFF0011';
  const tombstoneDevice = 'AABBCCDDEEFF0022';
  const owner = '22222222-2222-4222-8222-222222222222';
  const now = '2026-09-30T09:00:00.000Z';
  let raw;
  function callbackDb() {
    return {
      all(sql, params, callback) { try { callback(null, raw.prepare(sql).all(...(params || []))); } catch (error) { callback(error); } },
      run(sql, params, callback) { try { raw.prepare(sql).run(...(params || [])); callback(null); } catch (error) { callback(error); } },
      close(callback) { callback(); }
    };
  }
  class Database {
    constructor() {
      if (!raw) {
        raw = new DatabaseSync(':memory:');
        raw.exec(seed);
        raw.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role,auth_mode,server_url,server_sync_token,cloud_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(1, 'owner', 'hash', now, now, owner, 'admin', 'server', 'https://test.invalid', 'sync-token', 7);
        raw.prepare('INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,updated_at) VALUES(?,?,?,?,?,?)').run('cloud', 1, 'https://test.invalid', 7, linkedGateway, now);
        raw.prepare('INSERT INTO devices(deveui,name,type_id,user_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)').run(liveDevice, 'Live WATERMARK', 'DRAGINO_LSN50', 1, gateway, now, now);
        raw.prepare('INSERT INTO devices(deveui,name,type_id,user_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)').run(tombstoneDevice, 'Tombstone WATERMARK', 'DRAGINO_LSN50', 1, null, now, now);
        const insert = raw.prepare('INSERT INTO watermark_calibrations(deveui,pullup_1_ohm,pulldown_1_ohm,series_fwd_1_ohm,series_rev_1_ohm,pullup_2_ohm,pulldown_2_ohm,series_fwd_2_ohm,series_rev_2_ohm,measured_at,method,worst_residual_pct,notes,sync_version,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        insert.run(liveDevice, 41670, 41260, 130, 112, 42530, 42070, 46, 27, now, 'bench', 0.7, 'live', 4, now, null);
        insert.run(tombstoneDevice, 41670, 41260, 130, 112, 42530, 42070, 46, 27, now, 'bench', 0.7, 'tombstone', 5, now, '2026-09-30T10:00:00.000Z');
      }
      return callbackDb();
    }
  }
  const flowState = {};
  const flow = { get: (key) => flowState[key] || {}, set: (key, value) => { flowState[key] = value; } };
  global.get = (key) => key === 'fs' ? { existsSync: () => false } : undefined;
  const env = { get: (key) => ({ DEVICE_EUI: gateway, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active', FIRMWARE_VERSION: 'test-build', OSI_SCOPED_ACCESS: '0' }[key] || '') };
  const node = { warn: () => {}, error: () => {}, status: () => {} };
  const calls = [];
  const cloud = { requestJsonIpv4: async (request) => {
    calls.push(request);
    if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'sync-token' } };
    if (request.url.endsWith('/api/v1/sync/edge/bootstrap')) return { statusCode: 200, payload: { applied: 2, skipped: 0 } };
    if (request.url.endsWith('/api/v1/sync/edge/events')) return { statusCode: 200, payload: { results: [] } };
    if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [] } };
    throw new Error('unexpected request ' + request.url);
  } };
  const osiLib = { require(name) {
    if (name === 'installation') return { ok: true, value: installation };
    if (name === 'rejection-recovery') return { ok: true, value: rejection };
    return { ok: false, error: 'unexpected helper ' + name };
  } };
  function assertSnapshot(payload) {
    assert.ok(payload && Array.isArray(payload.devices));
    assert.ok(Array.isArray(payload.watermark_calibrations));
    assert.equal(payload.devices.length, 2);
    assert.equal(payload.watermark_calibrations.length, 2);
    const keys = Object.keys(payload);
    assert.ok(keys.indexOf('devices') < keys.indexOf('watermark_calibrations'));
    const live = payload.watermark_calibrations.find((row) => row.device_eui === liveDevice);
    const tombstone = payload.watermark_calibrations.find((row) => row.device_eui === tombstoneDevice);
    assert.equal(live.gateway_device_eui, gateway);
    assert.equal(live.effective_op, 'set');
    assert.equal(live.deleted_at, null);
    assert.equal(live.sync_version, 4);
    assert.equal(tombstone.gateway_device_eui, linkedGateway);
    assert.equal(tombstone.effective_op, 'delete');
    assert.equal(tombstone.deleted_at, '2026-09-30T10:00:00.000Z');
    assert.equal(tombstone.sync_version, 5);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'watermark_readings'), false);
    assert.equal(JSON.stringify(payload).includes('watermark_readings'), false);
  }
  (async () => {
    const bootstrap = new Function('msg', 'node', 'env', 'flow', 'osiDb', 'osiLib', bootstrapBody);
    const bootstrapMsg = {};
    const built = await bootstrap(bootstrapMsg, node, env, flow, { Database }, osiLib);
    assert.equal(built, bootstrapMsg);
    assertSnapshot(built.payload);
    const force = new Function('msg', 'node', 'env', 'flow', 'crypto', 'osiDb', 'osiCloudHttp', 'osiLib', forceBody);
    const forceMsg = { _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'owner' };
    const forced = await force(forceMsg, node, env, flow, require('node:crypto'), { Database }, cloud, osiLib);
    assert.ok(Array.isArray(forced));
    const bootstrapRequest = calls.find((request) => request.url.endsWith('/api/v1/sync/edge/bootstrap'));
    assert.ok(bootstrapRequest);
    assertSnapshot(bootstrapRequest.payload);
    console.log('REAL_SQL_BOOTSTRAP_FORCE_OK');
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
assert.equal(realSqlProbe.status, 0, realSqlProbe.stderr || realSqlProbe.stdout);
assert.match(realSqlProbe.stdout, /REAL_SQL_BOOTSTRAP_FORCE_OK/);

console.log('WATERMARK calibration bootstrap checks passed');
