#!/usr/bin/env node
'use strict';

// Owner decision 2026-10-22: sync does not depend on the conditional irrigation helper. When
// osi-irrigation-policy is missing, the bootstrap, outbox and force-sync builders (and their
// mark nodes) work normally on the legacy routes and simply leave conditional irrigation data
// out: no fail-closed, no sync fault, and conditional_irrigation_v1 is not advertised.
// Runs the shipped function bodies of both profiles against a real SQLite fixture.
//
// Run: node --test scripts/test-sync-without-conditional-helper.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = 'AABBCCDDEEFF0042';
const VALVE = 'AABBCCDDEEFF0043';
const SENSOR = 'AABBCCDDEEFF0044';
const NOW = '2026-10-22T09:00:00.000Z';
const OWNER = '22222222-2222-4222-8222-222222222222';
const INSTALLATION = '44444444-4444-4444-8444-444444444444';

function profile(name) {
  const share = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${name}/files/usr/share`);
  const flows = JSON.parse(fs.readFileSync(path.join(share, 'flows.json'), 'utf8'));
  const modules = path.join(share, 'node-red');
  const lib = (dir) => require(path.join(modules, dir, 'index.js'));
  return {
    node: (id) => flows.find((n) => n.id === id),
    helpers: {
      installation: lib('osi-installation-helper'),
      'rejection-recovery': lib('osi-rejection-recovery'),
      'history-sync': lib('osi-history-sync-helper'),
      'osi-valve-control': lib('osi-valve-control'),
      scope: lib('osi-scope-helper'),
    },
  };
}

function fixture() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  raw.prepare("INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role,auth_mode,server_url,server_sync_token,cloud_user_id) VALUES(1,'owner','hash',?,?,?,'admin','server','https://cloud.test.invalid','sync-token',7)").run(NOW, NOW, OWNER);
  raw.prepare("INSERT OR REPLACE INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, ?, '[]', 'ACTIVE', ?, ?)").run(INSTALLATION, GATEWAY, NOW, NOW);
  raw.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,'https://cloud.test.invalid',7,?,?,?)").run(GATEWAY, INSTALLATION, NOW);
  raw.prepare("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid,gateway_device_eui,sync_version) VALUES(1,'North',1,?,?,'UTC','zone-north',?,1)").run(NOW, NOW, GATEWAY);
  for (const [eui, type] of [[VALVE, 'STREGA_VALVE'], [SENSOR, 'KIWI_SENSOR']]) {
    raw.prepare('INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,1,1,?,1,?,?)').run(eui, eui, type, GATEWAY, NOW, NOW);
  }
  // A fixed schedule (always synced) and a conditional policy with its schedule (left out).
  raw.prepare("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version,created_at,updated_at) VALUES('fixed-1',?,'WEEKLY','Fixed',127,'06:00',10,'UTC',1,1,?,?)").run(VALVE, NOW, NOW);
  raw.prepare("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,min_interval_minutes,max_daily_minutes,delivery_settings_json,sync_version,created_at,updated_at) VALUES('policy-1','zone-north',?, 'UTC',1,60,60,240,'{}',1,?,?)").run(JSON.stringify({ kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: SENSOR, channel: 'SWT_1' }] }), NOW, NOW);
  raw.prepare("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version,created_at,updated_at,condition_policy_uuid) VALUES('conditional-1',?,'WEEKLY','Conditional',127,'07:00',10,'UTC',1,1,?,?,'policy-1')").run(VALVE, NOW, NOW);
  function callbackDb() {
    return {
      all(sql, params, callback) { if (typeof params === 'function') { callback = params; params = []; } try { callback(null, raw.prepare(sql).all(...(params || []))); } catch (error) { callback(error); } },
      get(sql, params, callback) { if (typeof params === 'function') { callback = params; params = []; } try { callback(null, raw.prepare(sql).get(...(params || []))); } catch (error) { callback(error); } },
      run(sql, params, callback) { if (typeof params === 'function') { callback = params; params = []; } try { const r = raw.prepare(sql).run(...(params || [])); if (callback) callback.call({ changes: Number(r.changes) }, null); } catch (error) { if (callback) callback(error); } },
      close(callback) { if (callback) callback(); },
    };
  }
  return { raw, Database: function Database() { return callbackDb(); } };
}

function runtime(p) {
  const warnings = [];
  const errors = [];
  const flowState = {};
  const node = { warn: (m) => warnings.push(String(m)), error: (m) => errors.push(String(m)), status: () => {}, log: () => {} };
  const flow = { get: (key) => flowState[key], set: (key, value) => { flowState[key] = value; } };
  const env = { get: (key) => ({ DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active', FIRMWARE_VERSION: 'test-build', OSI_SCOPED_ACCESS: '0' }[key] || '') };
  const global = { get: (key) => (key === 'fs' ? { existsSync: () => false } : undefined) };
  const osiLib = {
    require(name) {
      if (Object.prototype.hasOwnProperty.call(p.helpers, name)) return { ok: true, value: p.helpers[name] };
      return { ok: false, error: 'module not installed: ' + name };
    },
  };
  return { warnings, errors, flowState, node, flow, env, global, osiLib };
}

function run(p, id, rt, msg, libs) {
  const n = p.node(id);
  const names = ['msg', 'node', 'flow', 'env', 'global', ...n.libs.map((l) => l.var)];
  const values = [msg, rt.node, rt.flow, rt.env, rt.global, ...n.libs.map((l) => libs[l.var])];
  return new Function(...names, n.func)(...values);
}

for (const name of ['bcm2712', 'bcm2709']) {
  test(`${name}: without the conditional helper the gateway bootstraps, sends its outbox and force-syncs on the legacy routes`, async () => {
    const p = profile(name);
    const db = fixture();
    const rt = runtime(p);
    const calls = [];
    const cloud = { requestJsonIpv4: async (request) => {
      calls.push(request);
      if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'sync-token' } };
      if (/\/api\/v1\/sync\/edge\/bootstrap/.test(request.url)) return { statusCode: 200, payload: { success: true, applied: 1, skipped: 0 } };
      if (/\/api\/v1\/sync\/edge\/events/.test(request.url)) return { statusCode: 200, payload: { results: [] } };
      if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [] } };
      throw new Error('unexpected request ' + request.url);
    } };
    const libs = { crypto, osiDb: { Database: db.Database }, osiLib: rt.osiLib, osiCloudHttp: cloud };

    // Bootstrap: legacy route, no conditional data, capability not advertised.
    const built = await run(p, 'sync-bootstrap-build', rt, {}, libs);
    assert.ok(built && built.payload, 'bootstrap builds a request: ' + JSON.stringify({ warnings: rt.warnings, errors: rt.errors }));
    assert.match(built.url, /\/api\/v1\/sync\/edge\/bootstrap$/);
    assert.equal(built._syncConditionalGuarded, false);
    const identity = built.payload.gatewayIdentity;
    assert.equal(identity.syncCapabilities.includes('conditional_irrigation_v1'), false);
    assert.ok(identity.syncCapabilities.includes('linked_auth_sync_v1'));
    const text = JSON.stringify(built.payload);
    assert.ok(text.includes('fixed-1'), 'the fixed schedule is synced');
    assert.equal(text.includes('conditional-1'), false, 'the conditional schedule is left out');
    assert.equal(text.includes('policy-1'), false, 'the conditional policy is left out');

    // Bootstrap mark: a successful answer is accepted, no sync fault.
    const marked = await run(p, 'sync-bootstrap-mark', rt, Object.assign({}, built, { statusCode: 200, payload: { success: true, applied: 1, skipped: 0 } }), libs);
    assert.equal(rt.flowState.sync_state && rt.flowState.sync_state.lastError ? rt.flowState.sync_state.lastError.message : null, null, 'no sync fault after the bootstrap');
    void marked;

    // Outbox: legacy route; no conditional event is sent.
    const outbox = await run(p, 'sync-outbox-build', rt, {}, libs);
    assert.ok(outbox && outbox.payload, 'the outbox builds a batch: ' + JSON.stringify({ warnings: rt.warnings, errors: rt.errors }));
    assert.match(outbox.url, /\/api\/v1\/sync\/edge\/events$/);
    assert.equal(outbox._syncConditionalGuarded, false);
    assert.equal(JSON.stringify(outbox.payload).includes('policy-1'), false, 'no conditional policy event');
    assert.ok(Array.isArray(outbox._syncEventIds) && outbox._syncEventIds.length > 0);
    const results = outbox._syncEventIds.map((id) => ({ eventUuid: String(id), status: 'APPLIED' }));
    await run(p, 'sync-outbox-mark', rt, Object.assign({}, outbox, { statusCode: 200, payload: { results } }), libs);
    assert.equal(rt.flowState.sync_state && rt.flowState.sync_state.lastError ? rt.flowState.sync_state.lastError.message : null, null, 'no sync fault after the outbox');

    // Force sync: legacy endpoints only, completes.
    const forced = await run(p, 'sync-force-build', rt, { _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'owner' }, libs);
    assert.ok(Array.isArray(forced), 'force sync answers: ' + JSON.stringify({ warnings: rt.warnings, errors: rt.errors }));
    const urls = calls.map((request) => request.url);
    assert.ok(urls.some((url) => /\/api\/v1\/sync\/edge\/bootstrap$/.test(url)), 'force sync bootstraps on the legacy route');
    assert.equal(urls.some((url) => /conditional-irrigation-v1/.test(url)), false, 'no guarded conditional endpoint');
    assert.equal(rt.errors.length, 0, rt.errors.join('\n'));
  });
}
