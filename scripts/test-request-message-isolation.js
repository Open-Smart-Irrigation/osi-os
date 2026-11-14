'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { executeFunction, makeAuthHeader, profilePaths, seedScopedDb } = require('./lib/scoped-access-harness');

const SECRET = 'request-isolation-fixture-secret';
const GATEWAY = '0016C001F1000001';
const A = 'A840410000000001';
const B = 'A840410000000002';

// Only the node kinds on these HTTP chains are supported. Each request has
// its own queue/message; both share the same flow context and database.
// beforeSqlite can suspend one delivery while another request runs through.
async function walkRequest({ flows, start, msg, db, flowStore, modules, beforeSqlite = async () => {}, afterSqlite = () => {} }) {
  const byId = new Map(flows.map((n) => [n.id, n]));
  const queue = [{ id: start, msg }];
  const answers = [];
  while (queue.length) {
    const item = queue.shift();
    const node = byId.get(item.id);
    assert.ok(node, item.id);
    let outputs;
    if (node.type === 'http in') outputs = [item.msg];
    else if (node.type === 'function') {
      const run = await executeFunction(node, {
        msg: item.msg, db, flowStore, nodeRedModules: modules,
        env: { OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: SECRET, DEVICE_EUI: GATEWAY,
          CHIRPSTACK_APP_SENSORS: 'fixture-app', CHIRPSTACK_PROFILE_LSN50: 'fixture-profile' },
        libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => ({
          ensureDeviceProvisioned: async () => ({ deviceCreated: true }), close() {},
        }) } },
      });
      assert.deepEqual(run.errors, [], node.id);
      outputs = Array.isArray(run.result) ? run.result : [run.result];
    } else if (node.type === 'sqlite') {
      await beforeSqlite(node.id, item.msg);
      item.msg.payload = db.prepare(item.msg.topic).all();
      afterSqlite(node.id, item.msg);
      outputs = [item.msg];
    } else if (node.type === 'http response') {
      answers.push({ status: item.msg.statusCode || 200, body: item.msg.payload });
      continue;
    } else if (node.type === 'link out') continue; // outbox flush side lane, outside the HTTP reply
    else throw new Error('unsupported request node ' + node.id + ': ' + node.type);
    for (let port = 0; port < (node.wires || []).length; port++) {
      const value = outputs[port];
      if (value == null) continue;
      for (const id of node.wires[port]) queue.push({ id, msg: value });
    }
  }
  assert.equal(answers.length, 1);
  return answers[0];
}

function request(userId, username, deveui, zoneId) {
  return { payload: {}, req: { params: { deveui, id: zoneId },
    headers: { authorization: makeAuthHeader({ userId, username, secret: SECRET }) } } };
}

function latch() {
  let resume, reached;
  return { held: new Promise((resolve) => { reached = resolve; }),
    release: () => resume(),
    wait: () => { reached(); return new Promise((resolve) => { resume = resolve; }); } };
}

for (const profile of ['bcm2712', 'bcm2709']) {
  const paths = profilePaths(profile);
  const flows = JSON.parse(fs.readFileSync(paths.flowsPath));
  const options = { flows, modules: paths.nodeRedModules };
  test(`${profile}: account-link requests keep their selected server and local actor`, async (t) => {
    const db = seedScopedDb(); t.after(() => db.close());
    const flowStore = new Map();
    const validate = flows.find((n) => n.id === 'al-link-validate');
    assert.ok(validate.wires[0].includes('al-link-build-req'));
    const env = { OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: SECRET, DEVICE_EUI: GATEWAY,
      DEVICE_EUI_CONFIDENCE: 'authoritative', DEVICE_EUI_SOURCE: 'persisted' };
    const run = (node, msg) => executeFunction(node, { msg, db, flowStore, env,
      nodeRedModules: paths.nodeRedModules, libOverrides: { urlLib: require('node:url'), net: require('node:net') } });
    const create = (id, username, host) => ({ ...request(id, username), payload: {
      serverUrl: `https://${host}.example.invalid`, action: 'link', username: host, password: 'fixture-password',
    } });
    const first = await run(validate, create(2, 'res1', 'first'));
    const second = await run(validate, create(1, 'admin1', 'second'));
    assert.ok(first.result[0]); assert.ok(second.result[0]);
    const built = await run(flows.find((n) => n.id === 'al-link-build-req'), first.result[0]);
    assert.deepEqual(built.errors, []);
    assert.ok(built.result[0], JSON.stringify(built.result[1] && built.result[1].payload));
    assert.equal(built.result[0].url, 'https://first.example.invalid/auth/local-sync');
    assert.equal(built.result[0].authUserId, 2);
    assert.equal(built.result[0].payload.localUserUuid, 'u-res1');
    assert.equal(built.result[0].payload.localUsernameSnapshot, 'res1');
    assert.equal(built.result[0].payload.username, 'first');
  });
  for (const kind of ['device', 'zone']) {
    test(`${profile}: overlapping ${kind} creation carries its own request values`, async (t) => {
      const db = seedScopedDb(); t.after(() => db.close());
      const flowStore = new Map(); const gate = latch();
      const start = kind === 'device' ? 'post-devices-http' : 'post-zone-http';
      const hold = kind === 'device' ? 'post-devices-lookup' : 'post-zone-lookup';
      const create = (id, username, eui, name) => ({ ...request(id, username), payload: kind === 'device'
        ? { deveui: eui, name, type_id: 'DRAGINO_LSN50', appkey: '0'.repeat(32) }
        : { name, timezone: 'UTC' } });
      const first = walkRequest({ ...options, db, flowStore, start, msg: create(2, 'res1', A, 'First fixture'),
        beforeSqlite: (id) => id === hold ? gate.wait() : undefined });
      await gate.held;
      let second;
      try { second = await walkRequest({ ...options, db, flowStore, start, msg: create(1, 'admin1', B, 'Second fixture') }); }
      finally { gate.release(); }
      const answer = await first;
      assert.equal(answer.status, 201, JSON.stringify(answer.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(answer.body.name, 'First fixture');
      assert.equal(second.body.name, 'Second fixture');
      if (kind === 'device') {
        assert.equal(answer.body.deveui, A);
        assert.equal(db.prepare('SELECT user_id FROM devices WHERE deveui=?').get(A).user_id, 2);
        assert.equal(db.prepare('SELECT user_id FROM devices WHERE deveui=?').get(B).user_id, 1);
      } else {
        assert.notEqual(answer.body.zone_uuid, second.body.zone_uuid);
        assert.equal(db.prepare('SELECT user_id FROM irrigation_zones WHERE zone_uuid=?').get(answer.body.zone_uuid).user_id, 2);
        assert.equal(db.prepare('SELECT user_id FROM irrigation_zones WHERE zone_uuid=?').get(second.body.zone_uuid).user_id, 1);
      }
    });
  }
  for (const otherUser of [false, true]) {
    test(`${profile}: overlapping delete requests keep their own device and actor (${otherUser ? 'distinct actors' : 'one actor'})`, async (t) => {
      const db = seedScopedDb(); t.after(() => db.close());
      db.prepare('UPDATE devices SET deveui=? WHERE deveui=?').run(A, 'DENDRO1');
      db.prepare('UPDATE devices SET deveui=? WHERE deveui=?').run(B, 'VALVE1');
      db.prepare(`INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version,effective_from,created_at,updated_at)
        VALUES ('fixture-fixed-plan',?,'WEEKLY',127,'06:00',10,'UTC',1,1,'2026-01-01','2026-01-01','2026-01-01')`).run(B);
      const beforeA = db.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(A).sync_version;
      const beforeB = db.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(B).sync_version;
      db.exec('DELETE FROM sync_outbox');
      const flowStore = new Map(); const gate = latch();
      const first = walkRequest({ ...options, db, flowStore, start: 'delete-device-http', msg: request(2, 'res1', A),
        beforeSqlite: (id) => id === 'delete-device-lookup' ? gate.wait() : undefined });
      await gate.held;
      let second;
      try { second = await walkRequest({ ...options, db, flowStore, start: 'delete-device-http',
        msg: request(otherUser ? 1 : 2, otherUser ? 'admin1' : 'res1', B) }); }
      finally { gate.release(); }
      const answer = await first;
      assert.equal(answer.status, 200);
      assert.equal(answer.body.device_eui, A);
      assert.equal(db.prepare('SELECT user_id FROM devices WHERE deveui=?').get(A).user_id, null);
      assert.equal(second.status, otherUser ? 404 : 200);
      if (!otherUser) assert.equal(second.body.device_eui, B);
      assert.equal(db.prepare('SELECT user_id FROM devices WHERE deveui=?').get(B).user_id, otherUser ? 2 : null);
      assert.equal(db.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(A).sync_version, beforeA + 1);
      if (otherUser) {
        assert.equal(db.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(B).sync_version, beforeB);
        assert.equal(db.prepare("SELECT deleted_at FROM valve_schedules WHERE schedule_uuid='fixture-fixed-plan'").get().deleted_at, null);
        assert.equal(db.prepare('SELECT count(*) AS n FROM valve_schedule_pushes WHERE device_eui=?').get(B).n, 0);
      } else assert.ok(db.prepare("SELECT deleted_at FROM valve_schedules WHERE schedule_uuid='fixture-fixed-plan'").get().deleted_at);
    });
  }
  for (const holdAt of ['assign-device-lookup', 'assign-device-verify-zone-db', 'assign-device-verify-device-db']) {
    test(`${profile}: assignment request values survive interleaving at ${holdAt}`, async (t) => {
      const db = seedScopedDb(); t.after(() => db.close());
      db.prepare('UPDATE devices SET deveui=?,irrigation_zone_id=NULL WHERE deveui=?').run(A, 'DENDRO1');
      db.prepare('UPDATE devices SET deveui=?,irrigation_zone_id=NULL WHERE deveui=?').run(B, 'DENDRO2');
      const flowStore = new Map(); const gate = latch();
      const first = walkRequest({ ...options, db, flowStore, start: 'assign-device-http', msg: request(2, 'res1', A, 1),
        beforeSqlite: (id) => id === holdAt ? gate.wait() : undefined });
      await gate.held;
      let second;
      try { second = await walkRequest({ ...options, db, flowStore, start: 'assign-device-http', msg: request(1, 'admin1', B, 2) }); }
      finally { gate.release(); }
      const firstAnswer = await first;
      assert.equal(firstAnswer.status, 200);
      assert.equal(firstAnswer.body.deveui, A);
      assert.equal(firstAnswer.body.irrigation_zone_id, 1);
      assert.equal(second.status, 200);
      assert.equal(second.body.deveui, B);
      assert.equal(second.body.irrigation_zone_id, 2);
      assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(A).irrigation_zone_id, 1);
      assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(B).irrigation_zone_id, 2);
    });
  }
  for (const stage of ['assign-device-lookup', 'assign-device-verify-zone-db', 'assign-device-verify-device-db']) {
    test(`${profile}: assignment binds the lookup result at ${stage}`, async (t) => {
      const db = seedScopedDb(); t.after(() => db.close());
      db.prepare('UPDATE devices SET deveui=?,irrigation_zone_id=NULL WHERE deveui=?').run(A, 'DENDRO1');
      db.prepare('UPDATE devices SET deveui=?,irrigation_zone_id=NULL WHERE deveui=?').run(B, 'DENDRO2');
      const response = await walkRequest({ ...options, db, flowStore: new Map(), start: 'assign-device-http', msg: request(2, 'res1', A, 1),
        afterSqlite: (id, msg) => {
          if (id !== stage) return;
          msg.payload = stage === 'assign-device-lookup' ? [{ id: 1 }]
            : stage === 'assign-device-verify-zone-db' ? [{ id: 2, user_id: 1, zone_uuid: 'z-2' }]
              : [db.prepare('SELECT * FROM devices WHERE deveui=?').get(B)];
        } });
      assert.ok([400, 401, 404].includes(response.status));
      assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(A).irrigation_zone_id, null);
      assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(B).irrigation_zone_id, null);
    });
  }
}
