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

test('GET /api/valves (FW-T5): a zoneless valve surfaces the gateway_timezone default, not UTC', async () => {
  const { path, db } = await tempDb();
  await db.run("INSERT INTO app_settings(key, value) VALUES ('gateway_timezone', 'Europe/Zurich')");
  const out = await call(path, req('GET', '/api/valves'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.valves[0].timezone, 'Europe/Zurich');
});

test('GET /api/valves (FW-T5): a zoneless valve with no gateway_timezone set falls back to UTC', async () => {
  const { path } = await tempDb();
  const out = await call(path, req('GET', '/api/valves'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.valves[0].timezone, 'UTC');
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

test('PUT a ONCE schedule with no WEEKLY rows does not compile/push a plan', async () => {
  const { path, db } = await tempDb();
  const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'ONCE', fire_at: new Date(Date.now() + 3600000).toISOString(), duration_minutes: 10 }));
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.pushes_queued, 0);
  const uuid = created.payload.schedule.schedule_uuid;
  const out = await call(path, req('PUT', `/api/valves/0016C001F1000001/schedules/${uuid}`, { duration_minutes: 15 }));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.pushes_queued, 0);
  assert.equal(out.valvePushMessages, undefined);
  const rows = await db.all('SELECT * FROM valve_schedule_pushes');
  assert.equal(rows.length, 0, 'a ONCE-only valve must never get an all-FF weekday plan pushed as a side effect');
});

test('DELETE a ONCE schedule does not compile/push a plan', async () => {
  const { path, db } = await tempDb();
  const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'ONCE', fire_at: new Date(Date.now() + 3600000).toISOString(), duration_minutes: 10 }));
  const uuid = created.payload.schedule.schedule_uuid;
  const out = await call(path, req('DELETE', `/api/valves/0016C001F1000001/schedules/${uuid}`));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.pushes_queued, 0);
  assert.equal(out.valvePushMessages, undefined);
  const rows = await db.all('SELECT * FROM valve_schedule_pushes');
  assert.equal(rows.length, 0);
});

test('PUT a WEEKLY schedule into a conflict -> 422 with labels; the row is not modified', async () => {
  const { path } = await tempDb();
  const a = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, label: 'A' }));
  const b = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 1, start_time: '07:00', duration_minutes: 30, label: 'B' }));
  const bUuid = b.payload.schedule.schedule_uuid;
  const out = await call(path, req('PUT', `/api/valves/0016C001F1000001/schedules/${bUuid}`, { start_time: '06:10' }));
  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, 'plan_conflict');
  assert.equal(out.payload.details[0].labels.length, out.payload.details[0].conflicts.length);
  assert.ok(out.payload.details[0].labels.includes('A'));
  const list = await call(path, req('GET', '/api/valves/0016C001F1000001/schedules'));
  const bRow = list.payload.schedules.find((s) => s.schedule_uuid === bUuid);
  assert.equal(bRow.start_time, '07:00', 'rejected update must not be persisted');
});

test('PUT {enabled:0} on a WEEKLY schedule disables it, leaves other fields untouched, and recompiles the plan', async () => {
  const { path } = await tempDb();
  const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, label: 'A' }));
  const uuid = created.payload.schedule.schedule_uuid;
  const out = await call(path, req('PUT', `/api/valves/0016C001F1000001/schedules/${uuid}`, { enabled: 0 }));
  assert.equal(out.statusCode, 200);
  assert.ok(out.payload.pushes_queued > 0, 'disabling a WEEKLY schedule changes the compiled plan and must push');
  const list = await call(path, req('GET', '/api/valves/0016C001F1000001/schedules'));
  const row = list.payload.schedules.find((s) => s.schedule_uuid === uuid);
  assert.equal(row.enabled, 0);
  assert.equal(row.start_time, '06:00');
  assert.equal(row.duration_minutes, 30);
  assert.equal(row.label, 'A');
});

test('PUT cannot change a schedule\'s kind; it stays pinned to the original', async () => {
  const { path } = await tempDb();
  const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30 }));
  const uuid = created.payload.schedule.schedule_uuid;
  const out = await call(path, req('PUT', `/api/valves/0016C001F1000001/schedules/${uuid}`, { kind: 'ONCE', fire_at: new Date(Date.now() + 3600000).toISOString() }));
  assert.equal(out.statusCode, 200);
  const list = await call(path, req('GET', '/api/valves/0016C001F1000001/schedules'));
  const row = list.payload.schedules.find((s) => s.schedule_uuid === uuid);
  assert.equal(row.kind, 'WEEKLY');
});
