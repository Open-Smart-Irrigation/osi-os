'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.cwd();
const H = require(path.join(ROOT, 'scripts/lib/scoped-access-harness'));
const MODULES = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const scope = require(path.join(MODULES, 'osi-scope-helper'));
const VC = require(path.join(MODULES, 'osi-valve-control'));
const SECRET = 'scoped-access-test-secret';
const EUI = 'A840410000000001';
const UUID = '00000000-0000-4000-8000-000000000001';
const profiles = ['bcm2712', 'bcm2709'];
function bearer(userId = 2, username = 'res1', extra = {}) {
  return H.makeAuthHeader({ userId, username, secret: SECRET, ...extra });
}
function request(method, url, authorization = bearer(), body = {}) {
  return { req: { method, path: url, params: { deveui: url.split('/')[3] },
    headers: authorization ? { authorization } : {}, body }, payload: body };
}
function row(db, eui = 'DENDRO1') {
  return { ...db.prepare('SELECT user_id, is_reference_tree, sync_version FROM devices WHERE deveui=?').get(eui) };
}
for (const profile of profiles) {
  const flowsPath = path.join(process.env.OSI_470_FLOWS_ROOT || ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const load = id => H.loadNode(id, flowsPath);
  async function reference(db, { flag = '0', eui = 'DENDRO1', userId = 2, username = 'res1', auth = bearer(userId, username), value = 1, libOverrides = {} } = {}) {
    scope._resetForTests();
    assert.deepEqual(load('dendro-ref-tree-http').wires, [['scoped-device-config-guard']]);
    const guard = load('scoped-device-config-guard');
    assert.deepEqual(guard.wires[2], ['dendro-ref-tree-fn']);
    assert.deepEqual(load('dendro-ref-tree-fn').wires, [['dendro-http-resp']]);
    assert.equal(load('dendro-http-resp').type, 'http response');
    const msg = request('PUT', `/api/devices/${eui}/reference-tree`, auth, { is_reference_tree: value });
    const env = { OSI_SCOPED_ACCESS: flag, AUTH_TOKEN_SECRET: SECRET };
    const guarded = await H.executeFunction(guard, { db, msg, env });
    assert.equal(guarded.result.filter(Boolean).length, 1, 'one routed response or continuation');
    if (!guarded.result[2]) return guarded.result[guard.wires.length - 1];
    return (await H.executeFunction(load('dendro-ref-tree-fn'), { db, msg: guarded.result[2], env, libOverrides })).result;
  }
  test(`${profile}: flag-off owner toggles reference tree and increments version once per write`, async () => {
    const db = H.seedScopedDb();
    try {
      const before = row(db);
      for (const [value, increment] of [[1, 1], [0, 2]]) {
        const out = await reference(db, { eui: 'dendro1', value });
        assert.equal(out.statusCode, 200);
        assert.deepEqual(out.payload, { success: true, deveui: 'DENDRO1', is_reference_tree: value });
        assert.deepEqual(row(db), { ...before, is_reference_tree: value, sync_version: before.sync_version + increment });
      }
    } finally { db.close(); }
  });
  test(`${profile}: flag-off foreign, unclaimed and missing device return identical 404 without mutation`, async () => {
    const db = H.seedScopedDb();
    try {
      const before = row(db);
      const foreign = await reference(db, { userId: 1, username: 'admin1' });
      assert.equal(foreign.statusCode, 404);
      assert.deepEqual(row(db), before);
      const absent = await reference(db, { eui: 'ABSENT', userId: 1, username: 'admin1' });
      assert.deepEqual([foreign.statusCode, foreign.payload, foreign.headers], [absent.statusCode, absent.payload, absent.headers]);
      assert.deepEqual(foreign.payload, { error: 'Device not found' });
      db.exec("UPDATE devices SET user_id=NULL WHERE deveui='DENDRO1'");
      const unclaimedBefore = row(db);
      const unclaimed = await reference(db);
      assert.equal(unclaimed.statusCode, 404);
      assert.deepEqual(unclaimed.payload, absent.payload);
      assert.deepEqual(row(db), unclaimedBefore);
    } finally { db.close(); }
  });
  for (const [name, auth] of [['missing', null], ['malformed', 'Bearer x'],
    ['expired', bearer(2, 'res1', { expiresAt: Date.now() - 10000 })],
    ['wrong signature', bearer(2, 'res1', { secret: 'wrong-test-secret' })]]) {
    for (const flag of ['0', '1']) test(`${profile}: reference flag=${flag} rejects ${name} session`, async () => {
      const db = H.seedScopedDb();
      try { const before = row(db); assert.equal((await reference(db, { flag, auth })).statusCode, 401); assert.deepEqual(row(db), before); }
      finally { db.close(); }
    });
  }
  test(`${profile}: scoped assigned non-owner and admin retain access`, async () => {
    const db = H.seedScopedDb();
    try {
      const before = row(db, 'DENDRO2');
      assert.equal((await reference(db, { flag: '1', eui: 'DENDRO2' })).statusCode, 200);
      assert.deepEqual(row(db, 'DENDRO2'), { ...before, is_reference_tree: 1, sync_version: before.sync_version + 1 });
      assert.equal((await reference(db, { flag: '1', eui: 'DENDRO2', userId: 1, username: 'admin1' })).statusCode, 200);
    } finally { db.close(); }
  });
  for (const [name, setup, options, status] of [
    ['out-of-scope admin', () => {}, { userId: 1, username: 'admin1' }, 404],
    ['viewer', () => {}, { userId: 3, username: 'view1' }, 403],
    ['disabled', db => db.exec("UPDATE users SET disabled_at='2026-01-02' WHERE id=2"), {}, 403],
    ['revoked assignment', db => db.exec("DELETE FROM user_zone_assignments WHERE user_uuid='u-res1' AND zone_uuid='z-2'"), { eui: 'DENDRO2' }, 404],
    ['unassigned owner', db => db.exec("UPDATE devices SET irrigation_zone_id=NULL WHERE deveui='DENDRO1'"), {}, 404],
  ]) test(`${profile}: scoped ${name} is denied`, async () => {
    const db = H.seedScopedDb();
    try { setup(db); const before = row(db, options.eui); assert.equal((await reference(db, { flag: '1', ...options })).statusCode, status); assert.deepEqual(row(db, options.eui), before); }
    finally { db.close(); }
  });
  test(`${profile}: flag-off write rechecks ownership after the read`, async () => {
    const db = H.seedScopedDb();
    let closes = 0;
    try {
      const before = row(db);
      const facade = H.facadeDb(db);
      const run = facade.run;
      facade.run = (sql, params, callback) => {
        if (/UPDATE devices SET is_reference_tree/.test(sql)) db.exec("UPDATE devices SET user_id=1 WHERE deveui='DENDRO1'");
        return run(sql, params, callback);
      };
      facade.close = callback => { closes++; callback(); };
      const out = await reference(db, { libOverrides: { osiDb: { Database: function () { return facade; } } } });
      assert.equal(out.statusCode, 404);
      assert.deepEqual(row(db), { ...before, user_id: 1 });
      assert.equal(closes, 1);
    } finally { db.close(); }
  });
  test(`${profile}: flag-off reference route never loads the scope helper`, async () => {
    const db = H.seedScopedDb();
    try {
      const out = await reference(db, { libOverrides: { osiLib: { require() { throw new Error('flag-off scope dependency'); } } } });
      assert.equal(out.statusCode, 200);
    } finally { db.close(); }
  });
  async function valve(db, msg, chirpstack, vc = VC) {
    assert.deepEqual(load('valve-api-router-fn').wires, [['valve-api-response'], ['valve-push-mqtt-out']]);
    return H.executeFunction(load('valve-api-router-fn'), { db, msg,
      env: { AUTH_TOKEN_SECRET: SECRET, CHIRPSTACK_APP_ACTUATORS: 'fixture-app' },
      osiLibModules: { 'osi-valve-control': vc }, libOverrides: { chirpstack } });
  }
  const routes = [['GET', '/api/valves'], ['GET', `/api/valves/${EUI}/schedules`],
    ['POST', `/api/valves/${EUI}/schedules`], ['PUT', `/api/valves/${EUI}/schedules/${UUID}`],
    ['DELETE', `/api/valves/${EUI}/schedules/${UUID}`], ['POST', `/api/valves/${EUI}/plan/resend`],
    ['POST', `/api/valves/${EUI}/scheduler-status`], ['PUT', `/api/valves/${EUI}/settings`]];
  test(`${profile}: all eight valve routes reject invalid sessions without allocating a client or DB`, async () => {
    const db = H.seedScopedDb();
    try {
      const incoming = JSON.parse(require('node:fs').readFileSync(flowsPath, 'utf8')).filter(n => n.type === 'http in' && n.wires.flat().includes('valve-api-router-fn'));
      assert.equal(incoming.length, 8);
      const actualRoutes = incoming.map(n => [n.method.toUpperCase(), n.url.replace(':deveui', EUI).replace(':uuid', UUID)]);
      assert.deepEqual(actualRoutes.map(pair => JSON.stringify(pair)).sort(), routes.map(pair => JSON.stringify(pair)).sort());
      let creates = 0, opens = 0;
      const dbHelper = { Database: function () { opens++; throw new Error('unauthorized DB open'); } };
      for (const [method, url] of routes) for (const auth of [null, 'Bearer x', bearer(2, 'res1', { expiresAt: Date.now() - 10000 }), bearer(2, 'res1', { secret: 'wrong-test-secret' })]) {
        const out = await H.executeFunction(load('valve-api-router-fn'), { db, msg: request(method, url, auth), env: { AUTH_TOKEN_SECRET: SECRET },
          osiLibModules: { 'osi-db-helper': dbHelper, 'osi-valve-control': VC },
          libOverrides: { chirpstack: { createProvisioningClientFromEnv() { creates++; return { close: () => [] }; } } } });
        assert.equal(out.result[0].statusCode, 401);
        assert.deepEqual(out.result[1], []);
      }
      assert.equal(opens, 0); assert.equal(creates, 0);
    } finally { db.close(); }
  });
  test(`${profile}: authenticated valve read and ownership rejection need no client`, async () => {
    const db = H.seedScopedDb();
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      let creates = 0;
      const cs = { createProvisioningClientFromEnv() { creates++; throw new Error('must remain lazy'); } };
      assert.equal((await valve(db, request('GET', '/api/valves'), cs)).result[0].statusCode, 200);
      assert.equal((await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`, bearer(1, 'admin1')), cs)).result[0].statusCode, 403);
      assert.equal(creates, 0);
    } finally { db.close(); }
  });
  for (const rejectFlush of [false, true]) test(`${profile}: close waits for actual async queue flush (reject=${rejectFlush})`, async () => {
    const db = H.seedScopedDb();
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise((resolve, reject) => { release = () => rejectFlush ? reject(new Error('fixture flush failed')) : resolve(); });
    const events = [];
    let creates = 0, closes = 0;
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      const cs = { createProvisioningClientFromEnv() { creates++; events.push('create'); return {
        async getDeviceQueue() { return []; },
        async enqueueDownlink() { return { id: 'fixture-queue-item' }; },
        async flushDeviceQueue(eui) { assert.equal(eui, EUI); events.push('flush-start'); started(); try { await pending; } finally { events.push('flush-settled'); } },
        close() { closes++; events.push('close'); return []; }
      }; } };
      const operation = valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), cs);
      await Promise.race([entered, operation.then(() => { throw new Error('API settled before entering flush'); })]);
      assert.equal(closes, 0, 'do not close a pending RPC');
      release();
      const out = await operation;
      // #515 (CMD-04, no MQTT fallback): a flush that did not settle fails the write closed with
      // 503 transport_uncertain (push.transportFailure); the snapshot rows stay pending.
      assert.equal(out.result[0].statusCode, rejectFlush ? 503 : 202);
      if (rejectFlush) assert.equal(out.result[0].payload.error, 'transport_uncertain');
      assert.equal(creates, 1); assert.equal(closes, 1);
      assert.deepEqual(events, ['create', 'flush-start', 'flush-settled', 'close']);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n > 0);
      if (rejectFlush) assert.ok(out.warnings.some(w => w.includes('queue flush uncertain')));
    } finally { release(); db.close(); }
  });
  test(`${profile}: factory failure fails closed, keeps the snapshot pending and warns`, async () => {
    const db = H.seedScopedDb();
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      let creates = 0;
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() { creates++; throw new Error('fixture unavailable'); } });
      // #515: without a ChirpStack transport STREGA writes fail closed (no MQTT fallback).
      assert.equal(out.result[0].statusCode, 503); assert.equal(out.result[0].payload.error, 'transport_uncertain');
      assert.deepEqual(out.result[1], []); assert.equal(creates, 1);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n > 0);
      assert.ok(out.warnings.some(w => w.includes('client unavailable')));
    } finally { db.close(); }
  });
  for (const mode of ['returned-errors', 'throw', 'api-rejection']) test(`${profile}: cleanup handles ${mode} without replacing the response`, async () => {
    const db = H.seedScopedDb();
    let closes = 0;
    try {
      // Only this fault-injection test substitutes the API; all route tests above use VC.
      // The router itself is VC.liveValveApiRouter (#515), so the fake keeps the real module.
      const vc = Object.assign({}, VC, { async handleHttpRequest(options) {
        await options.flushQueue(EUI);
        if (mode === 'api-rejection') throw new Error('fixture API rejection');
        return Object.assign(options.msg, { statusCode: 202, payload: { ok: true }, valvePushMessages: [{ topic: 'fixture/topic', payload: { fPort: 21 } }] });
      } });
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() { return {
        flushDeviceQueue: async () => {}, close() { closes++; if (mode === 'throw') throw new Error('fixture close error'); return mode === 'returned-errors' ? [new Error('fixture close error')] : []; }
      }; } }, vc);
      assert.equal(closes, 1);
      assert.equal(out.result[0].statusCode, mode === 'api-rejection' ? 500 : 202);
      if (mode === 'api-rejection') assert.equal(out.result[1], null);
      else { assert.deepEqual(out.result[1], [{ topic: 'fixture/topic', payload: { fPort: 21 } }]); assert.ok(out.warnings.some(w => w.includes('client close failed'))); }
    } finally { db.close(); }
  });
  for (const fault of ['SELECT', 'UPDATE', 'close']) test(`${profile}: reference ${fault} exception closes once and preserves response semantics`, async () => {
    const db = H.seedScopedDb();
    let closes = 0;
    try {
      const before = row(db);
      const facade = H.facadeDb(db);
      if (fault === 'SELECT') facade.all = (...args) => args.at(-1)(new Error('fixture SELECT failure'));
      if (fault === 'UPDATE') facade.run = (...args) => args.at(-1)(new Error('fixture UPDATE failure'));
      facade.close = callback => { closes++; if (fault === 'close') throw new Error('fixture close failure'); callback(); };
      const out = await reference(db, { libOverrides: { osiDb: { Database: function () { return facade; } } } });
      assert.equal(out.statusCode, fault === 'close' ? 200 : 500);
      assert.equal(closes, 1);
      if (fault === 'close') assert.deepEqual(row(db), { ...before, is_reference_tree: 1, sync_version: before.sync_version + 1 });
      else { assert.deepEqual(row(db), before); assert.equal(out.payload.error, `fixture ${fault} failure`); }
    } finally { db.close(); }
  });
  test(`${profile}: real valve API catches synchronous flush failure and still closes`, async () => {
    const db = H.seedScopedDb();
    let creates = 0, closes = 0, flushes = 0;
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() {
        creates++;
        return { async getDeviceQueue() { return []; }, async enqueueDownlink() { return { id: 'fixture-queue-item' }; },
          flushDeviceQueue() { flushes++; throw new Error('fixture synchronous flush failure'); }, close() { closes++; return []; } };
      } });
      // #515: the uncertain flush fails the write closed (503 transport_uncertain).
      assert.equal(out.result[0].statusCode, 503); assert.equal(out.result[0].payload.error, 'transport_uncertain');
      assert.deepEqual([creates, flushes, closes], [1, 1, 1]);
      assert.ok(out.warnings.some(w => w.includes('queue flush uncertain')));
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n > 0);
    } finally { db.close(); }
  });
  for (const fault of ['synchronous API throw', 'mapping failure', 'two flushes']) test(`${profile}: router handles ${fault}`, async () => {
    const db = H.seedScopedDb();
    const events = [];
    let creates = 0, closes = 0, flushes = 0;
    try {
      // These three cases deliberately substitute the API to reach router-only branches.
      // The router itself is VC.liveValveApiRouter (#515), so the fake keeps the real module.
      const vc = Object.assign({}, VC, { handleHttpRequest(options) {
        if (fault === 'synchronous API throw') throw new Error('fixture synchronous API failure');
        return (async () => {
          await options.flushQueue(EUI);
          if (fault === 'two flushes') await options.flushQueue(EUI);
          const out = Object.assign(options.msg, { statusCode: 202, payload: { ok: true } });
          if (fault === 'mapping failure') Object.defineProperty(out, 'valvePushMessages', { get() { throw new Error('fixture mapping failure'); } });
          return out;
        })();
      } });
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() {
        creates++; events.push('create');
        return { async flushDeviceQueue() { flushes++; events.push('flush'); }, close() { closes++; events.push('close'); return []; } };
      } }, vc);
      assert.equal(out.result[0].statusCode, fault === 'two flushes' ? 202 : 500);
      if (fault === 'synchronous API throw') assert.deepEqual([creates, flushes, closes], [0, 0, 0]);
      else {
        assert.deepEqual([creates, flushes, closes], [1, fault === 'two flushes' ? 2 : 1, 1]);
        assert.deepEqual(events, fault === 'two flushes' ? ['create', 'flush', 'flush', 'close'] : ['create', 'flush', 'close']);
      }
      if (fault !== 'two flushes') { assert.equal(out.result[1], null); assert.equal(out.result[0].payload.error, 'internal_error'); assert.equal(out.errors.length, 1); }
    } finally { db.close(); }
  });
}
