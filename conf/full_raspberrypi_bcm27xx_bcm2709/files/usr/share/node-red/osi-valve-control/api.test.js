'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { tempDb, facade } = require('./test-helpers');
const { handleHttpRequest } = require('./api');
const { DatabaseSync } = require('node:sqlite');
// The router takes a Database constructor; hand it one backed by node:sqlite.
function TestDatabase(dbPath) { return facade(new DatabaseSync(dbPath)); }
const store = require('./store');

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

test('GET /api/valves (review R1, MAJOR-2): the shaped valve payload carries the stored enclosure reading through the API', async () => {
  const { path, db } = await tempDb();
  // (review R2, NEW-MAJOR-3) VALVE_LIST_SQL's enclosure subqueries are bounded to a 7-day
  // recency window against wall-clock `now` — a fixture pinned to a hardcoded calendar date
  // stops being "recent" the day the window rolls past it, going red with no code change
  // involved. Anchor to `Date.now()`, same pattern as the `nowIso` fixture at store.test.js:80.
  const recentIso = new Date(Date.now() - 2 * 3600000).toISOString();
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, 21.5, 48.2)", [recentIso]);
  const out = await call(path, req('GET', '/api/valves'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.valves[0].enclosure_temperature_c, 21.5, 'the field must be present and carry the stored value, not be dropped from the shaped payload');
  assert.equal(out.payload.valves[0].enclosure_humidity_pct, 48.2, 'the field must be present and carry the stored value, not be dropped from the shaped payload');
  assert.equal(out.payload.valves[0].enclosure_measured_at, recentIso);
});

test('GET /api/valves (review R1, MAJOR-2): a stored 0/0 enclosure reading survives end-to-end as 0, not null', async () => {
  const { path, db } = await tempDb();
  const recentIso = new Date(Date.now() - 2 * 3600000).toISOString(); // (review R2) wall-clock-relative — see note above
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, 0, 0)", [recentIso]);
  const out = await call(path, req('GET', '/api/valves'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.valves[0].enclosure_temperature_c, 0, 'a real 0 reading must not be coerced to null by a `||` guard');
  assert.equal(out.payload.valves[0].enclosure_humidity_pct, 0, 'a real 0 reading must not be coerced to null by a `||` guard');
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
  assert.equal(out.payload.pushes_queued, 8); // CMD-04 PR0 (C): 7 weekdays + scheduler status, no clock sync
  assert.equal(out.valvePushMessages, undefined, 'the snapshot leaves with the valve tick after the debounce window');
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
  const db = new TestDatabase(path);
  const marker = await store.getSnapshotPending(db, require('./test-helpers').FIXTURE_EUI);
  const snap = await store.queuedPushesById(db, require('./test-helpers').FIXTURE_EUI, marker.push_ids);
  assert.deepEqual(snap.map((r) => [r.fport, Buffer.from(r.payload_hex, 'hex').toString('ascii')]), [[21, '1']]);
  db.close();
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

test('PUT cannot change fire_at on a live terminal ONCE schedule; delete and revival is explicit', async () => {
  const { path, db } = await tempDb();
  const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'ONCE', fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 10 }));
  const uuid = created.payload.schedule.schedule_uuid;
  await db.run("UPDATE valve_schedules SET once_state='FIRED', once_fired_at='2026-08-19T10:00:00.000Z' WHERE schedule_uuid=?", [uuid]);
  await db.run("INSERT INTO valve_once_dispatch_intents(schedule_uuid, device_eui, command_id, state, attempted_at) VALUES (?, '0016C001F1000001', 'api-legacy-a', 'SENT', '2026-08-19T10:00:00.000Z')", [uuid]);
  const out = await call(path, req('PUT', `/api/valves/0016C001F1000001/schedules/${uuid}`, { fire_at: '2026-08-19T11:00:00.000Z' }));
  assert.equal(out.statusCode, 409);
  assert.equal(out.payload.error, 'once_fire_at_immutable');
  assert.match(out.payload.message, /delete and revive/i);
  const row = await db.get('SELECT fire_at, once_state FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.fire_at, '2026-08-19T10:00:00.000Z');
  assert.equal(row.once_state, 'FIRED');
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

// --- F144 regression pins: the local routes already scope a schedule to the valve in the path ---
// PUT/DELETE /api/valves/:eui/schedules/:uuid look the row up through listSchedules(eui), so a
// uuid belonging to another valve is a 404 and never reaches the store. These pin that (the
// store-level (uuid, device_eui) scope added for F144 is the second line of defence, not the
// first), including for a second valve the SAME user owns, where ownedValve() cannot help.
const VALVE_B = '0016C001F1000002';

async function addSecondValve(db) {
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?,'Valve B','STREGA_VALVE',1,datetime('now'),datetime('now'))", [VALVE_B]);
}

test('F144: PUT /api/valves/<B>/schedules/<A-owned uuid> -> 404 and A\'s row is untouched', async () => {
  const { path, db } = await tempDb();
  await addSecondValve(db);
  const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, label: 'A' }));
  const uuid = created.payload.schedule.schedule_uuid;
  const before = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  const out = await call(path, req('PUT', `/api/valves/${VALVE_B}/schedules/${uuid}`, { start_time: '23:00', duration_minutes: 90 }));
  assert.equal(out.statusCode, 404);
  assert.equal(out.payload.error, 'not_found');
  const after = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.deepEqual(after, before);
});

test('F144: DELETE /api/valves/<B>/schedules/<A-owned uuid> -> 404 and A\'s row stays live', async () => {
  const { path, db } = await tempDb();
  await addSecondValve(db);
  const created = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, label: 'A' }));
  const uuid = created.payload.schedule.schedule_uuid;
  const out = await call(path, req('DELETE', `/api/valves/${VALVE_B}/schedules/${uuid}`));
  assert.equal(out.statusCode, 404);
  assert.equal(out.payload.error, 'not_found');
  const row = await db.get('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.deleted_at, null);
});

const { FIXTURE_EUI } = require('./test-helpers');

test('CMD-04 PR0 (C): two quick schedule edits supersede the first snapshot; GET /api/valves shows the second as queued, nothing LOST', async () => {
  const { path } = await tempDb();
  const first = await call(path, req('POST', '/api/valves/' + FIXTURE_EUI + '/schedules', { kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:00', duration_minutes: 30 }));
  assert.equal(first.statusCode, 201);
  const second = await call(path, req('POST', '/api/valves/' + FIXTURE_EUI + '/schedules', { kind: 'WEEKLY', weekdays_mask: 4, start_time: '07:00', duration_minutes: 30 }));
  assert.equal(second.statusCode, 201);
  assert.equal(second.payload.pushes_queued, 8, 'a full snapshot');
  const list = await call(path, req('GET', '/api/valves'));
  const ps = list.payload.valves[0].push_state;
  assert.deepEqual({ queued: ps.queued, lost: ps.lost, failed: ps.failed, scheduler_status_lost: ps.scheduler_status_lost }, { queued: 7, lost: 0, failed: 0, scheduler_status_lost: false });
  const db = new TestDatabase(path);
  const states = await db.all("SELECT state, COUNT(*) AS n FROM valve_schedule_pushes GROUP BY state ORDER BY state");
  db.close();
  assert.deepEqual(states.map((r) => [r.state, r.n]), [['QUEUED', 8], ['SUPERSEDED', 8]]);
});

test('R5 M3: pause is not refused when the stored plan has a plan_conflict; the status goes out alone', async () => {
  const { path } = await tempDb();
  const db = new TestDatabase(path);
  for (let i = 1; i <= 5; i += 1) await store.insertSchedule(db, { schedule_uuid: 'x' + i, device_eui: FIXTURE_EUI, kind: 'WEEKLY', label: null, weekdays_mask: 4, start_time: '0' + i + ':00', duration_minutes: 10, timezone: 'UTC', enabled: 1 });
  db.close();
  const out = await call(path, req('POST', '/api/valves/' + FIXTURE_EUI + '/scheduler-status', { status: 'DEACTIVATED' }));
  assert.equal(out.statusCode, 202);
  const db2 = new TestDatabase(path);
  const marker = await store.getSnapshotPending(db2, FIXTURE_EUI);
  const snap = await store.queuedPushesById(db2, FIXTURE_EUI, marker.push_ids);
  assert.deepEqual(snap.map((r) => [r.fport, r.payload_hex]), [[21, '32']]);
  assert.equal((await store.getSettings(db2, FIXTURE_EUI)).scheduler_status, 'DEACTIVATED');
  db2.close();
});

// Step 4 of the scheduling integration (R11 probe 2), through the REST routes on the transport
// path: delete a schedule, then Pause and Resume before the valve's next uplink. Before the fix the
// status route flushed the queue and sent the status alone, killing the clears; the valve kept the
// deleted schedule with status ACTIVE.
test('R11 probe 2 (REST, transport): delete, pause, resume inside one uplink -> the valve ends cleared and ACTIVE', async () => {
  const { tempDb: td, fakeChirpStack, applyToValve, FIXTURE_EUI: EUI } = require('./test-helpers');
  const push = require('./push');
  const { path, db } = await td();
  const cs = fakeChirpStack();
  const uuid = '11111111-2222-4333-8444-555555555555';
  await store.insertSchedule(db, { schedule_uuid: uuid, device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x02, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const t0 = Date.now();
  await push.compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: new Date(t0), transport: cs.transport, warn: () => {} });
  await push.emitPendingSnapshots({ db, now: new Date(t0 + push.SNAPSHOT_DEBOUNCE_MS), appId: 'app', transport: cs.transport, warn: () => {} });
  const valve = applyToValve(null, cs.drain());
  assert.equal(valve.gen1[1] === 'FF'.repeat(24), false, 'the valve holds the schedule');
  const extra = { transport: cs.transport, flushQueue: undefined };
  assert.equal((await call(path, req('DELETE', `/api/valves/${EUI}/schedules/${uuid}`), extra)).statusCode < 300, true);
  await push.emitPendingSnapshots({ db, now: new Date(Date.now() + push.SNAPSHOT_DEBOUNCE_MS), appId: 'app', transport: cs.transport, warn: () => {} });
  assert.equal(cs.getQueue().length, 8, 'the clears are on the air');
  assert.equal((await call(path, req('POST', `/api/valves/${EUI}/scheduler-status`, { status: 'DEACTIVATED' }), extra)).statusCode, 202);
  assert.equal((await call(path, req('POST', `/api/valves/${EUI}/scheduler-status`, { status: 'ACTIVE' }), extra)).statusCode, 202);
  await push.emitPendingSnapshots({ db, now: new Date(Date.now() + push.SNAPSHOT_DEBOUNCE_MS), appId: 'app', transport: cs.transport, warn: () => {} });
  applyToValve(valve, cs.drain());
  assert.deepEqual(valve.gen1, Array(7).fill('FF'.repeat(24)), 'every weekday is cleared');
  assert.equal(valve.status, '0');
  db.close();
});

// R13-M4 follow-up (W29): a fixed schedule written while the valve leaves conditional mode behind an
// active open answers with the open the pending snapshot waits for, not a silent success.
test('R13-M4: REST schedule create during a pending open names the open the fixed snapshot waits for', async () => {
  const { FIXTURE_EUI: EUI } = require('./test-helpers');
  const { path, db } = await tempDb();
  await store.writeConditionalControl(db, EUI, { mode: 'CONDITIONAL', generation: 'GEN1', desired_revision: 'rev-1', required_push_ids: [], readiness: { state: 'READY', revision: 'rev-1', reason: 'all_current_clear_acked' } });
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES ('e-open', ?, 'cmd-open', ?, 600, ?, 'unknown', 'PENDING_OBSERVATION', ?)",
    [EUI, new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), new Date().toISOString()]);
  const out = await call(path, req('POST', `/api/valves/${EUI}/schedules`, { kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:00', duration_minutes: 30, enabled: true }));
  assert.equal(out.statusCode, 201, JSON.stringify(out.payload));
  assert.equal(out.payload.conversion_waits_for, 'cmd-open');
  assert.equal(out.payload.pushes_queued, 8);
  db.close();
});
