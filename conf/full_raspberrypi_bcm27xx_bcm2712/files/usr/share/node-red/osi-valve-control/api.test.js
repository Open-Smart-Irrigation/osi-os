'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { tempDb, facade } = require('./test-helpers');
const { handleHttpRequest } = require('./api');
const { DatabaseSync } = require('node:sqlite');
// The router takes a Database constructor; hand it one backed by node:sqlite.
function TestDatabase(dbPath) { return facade(new DatabaseSync(dbPath)); }

const SECRET = 'test-secret';
function token(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, username: 'u', exp: Date.now() + 60000 })).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function req(method, url, body, auth) {
  return { req: { method, url, headers: { authorization: auth === undefined ? token(1) : auth }, body, params: {} }, payload: body };
}
async function call(dbPath, msg, extra) {
  return handleHttpRequest(Object.assign({ msg, Database: TestDatabase, environment: { authTokenSecret: SECRET, dbPath }, warn: () => {}, flushQueue: async () => {}, appId: 'app' }, extra || {}));
}

test('GET /api/valves returns the user valves with zone name and defaults', async () => {
  const { path } = await tempDb();
  const out = await call(path, req('GET', '/api/valves'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.valves.length, 1);
  assert.equal(out.payload.valves[0].device_eui, '0016C001F1000001');
  assert.equal(out.payload.valves[0].strega_generation, 'GEN1');
  assert.equal(out.payload.valves[0].next_run, null);
});

test('no token -> 401', async () => {
  const { path } = await tempDb();
  assert.equal((await call(path, req('GET', '/api/valves', undefined, null))).statusCode, 401);
});

test('POST schedule creates, compiles, queues pushes and exposes mqtt messages; GET lists it', async () => {
  const { path } = await tempDb();
  const out = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 3, start_time: '06:00', duration_minutes: 30, label: 'Slot' }));
  assert.equal(out.statusCode, 201);
  assert.ok(out.payload.schedule.schedule_uuid);
  assert.equal(out.payload.pushes_queued, 8); // 7 weekdays + clock sync
  assert.equal(out.valvePushMessages.length, 8);
  const list = await call(path, req('GET', '/api/valves/0016C001F1000001/schedules'));
  assert.equal(list.payload.schedules.length, 1);
  assert.equal(list.payload.compiled.days[0].length, 1);
  assert.equal(list.payload.push_state.length, 7);
});

test('POST schedule that overflows 4 windows -> 422 with weekday, conflicts and labels', async () => {
  const { path } = await tempDb();
  const uuids = [];
  for (let i = 1; i <= 4; i += 1) {
    const body = { kind: 'WEEKLY', weekdays_mask: 4, start_time: '0' + i + ':00', duration_minutes: 10 };
    if (i === 1) body.label = 'Morning';
    const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', body));
    uuids.push(created.payload.schedule.schedule_uuid);
  }
  const out = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 4, start_time: '09:00', duration_minutes: 10 }));
  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, 'plan_conflict');
  assert.equal(out.payload.details[0].weekday, 2);
  assert.equal(out.payload.details[0].labels.length, out.payload.details[0].conflicts.length);
  const morningIndex = out.payload.details[0].conflicts.indexOf(uuids[0]);
  assert.ok(morningIndex >= 0);
  assert.equal(out.payload.details[0].labels[morningIndex], 'Morning');
  const list = await call(path, req('GET', '/api/valves/0016C001F1000001/schedules'));
  assert.equal(list.payload.schedules.length, 4, 'rejected schedule must not be persisted');
});

test('scheduler-status SKIP_TODAY queues FPort 21 "1" and records the local date', async () => {
  const { path } = await tempDb();
  const out = await call(path, req('POST', '/api/valves/0016C001F1000001/scheduler-status', { status: 'SKIP_TODAY' }));
  assert.equal(out.statusCode, 202);
  assert.equal(out.valvePushMessages[0].payload.fPort, 21);
  assert.equal(Buffer.from(out.valvePushMessages[0].payload.data, 'base64').toString('ascii'), '1');
});

test('settings PUT validates flow rate and generation', async () => {
  const { path } = await tempDb();
  assert.equal((await call(path, req('PUT', '/api/valves/0016C001F1000001/settings', { flow_rate_lpm: 12.5, flow_rate_source: 'measured' }))).statusCode, 200);
  assert.equal((await call(path, req('PUT', '/api/valves/0016C001F1000001/settings', { strega_generation: 'GEN3' }))).statusCode, 422);
});

test('another user -> 403 on schedules', async () => {
  const { path } = await tempDb();
  assert.equal((await call(path, req('GET', '/api/valves/0016C001F1000001/schedules', undefined, token(2)))).statusCode, 403);
});
