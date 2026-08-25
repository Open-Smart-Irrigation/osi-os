'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb, linkCloud } = require('./test-helpers');
const store = require('./store');
const { buildRuntimePayload, emitRuntimeChanged } = require('./runtime');

const EUI = '0016C001F1000001';

async function insertExpectation(db, { id, state, commandedAt, expectedCloseAt, durationSeconds, trigger, deviceEui }) {
  await db.run(
    'INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, deviceEui || EUI, commandedAt, durationSeconds == null ? 900 : durationSeconds, expectedCloseAt || commandedAt, 'unknown', state, trigger === undefined ? 'on_valve_schedule' : trigger, commandedAt]
  );
}

test('buildRuntimePayload: a valve with no expectation history has a null active_actuation/recent_stale_state and zeroed push_state', async () => {
  const { db } = await tempDb();
  const payload = await buildRuntimePayload(db, EUI);
  assert.equal(payload.contract_version, 1);
  assert.equal(payload.device_eui, EUI);
  assert.equal(payload.active_actuation, null);
  assert.equal(payload.recent_stale_state, null);
  assert.deepEqual(payload.push_state, { queued: 0, acked: 0, failed: 0, last_plan_acked_at: null, weekday_states: [] });
  assert.match(payload.as_of, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('buildRuntimePayload: PENDING_OBSERVATION is surfaced as the active_actuation, field names/casing matching the edge GET /api/valves shape', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z', expectedCloseAt: '2026-08-25T10:15:00.000Z', durationSeconds: 900, trigger: 'manual' });
  const payload = await buildRuntimePayload(db, EUI);
  assert.deepEqual(payload.active_actuation, {
    expectation_id: 'e1',
    reconciliation_state: 'PENDING_OBSERVATION',
    commanded_at: '2026-08-25T10:00:00.000Z',
    expected_close_at: '2026-08-25T10:15:00.000Z',
    duration_seconds: 900,
    trigger: 'manual',
  });
});

test('buildRuntimePayload: OBSERVED_RUNNING is surfaced the same way, and a null trigger (legacy writer, not yet backfilled) comes through as null not undefined', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:00:00.000Z', expectedCloseAt: '2026-08-25T10:30:00.000Z', durationSeconds: 1800, trigger: null });
  const payload = await buildRuntimePayload(db, EUI);
  assert.equal(payload.active_actuation.reconciliation_state, 'OBSERVED_RUNNING');
  assert.equal(payload.active_actuation.duration_seconds, 1800);
  assert.equal(payload.active_actuation.trigger, null);
});

test('buildRuntimePayload: the newest of several PENDING_OBSERVATION/OBSERVED_RUNNING rows wins (matches VALVE_LIST_SQL ORDER BY commanded_at DESC LIMIT 1)', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-old', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T09:00:00.000Z', expectedCloseAt: '2026-08-25T09:15:00.000Z' });
  await insertExpectation(db, { id: 'e-new', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:00:00.000Z', expectedCloseAt: '2026-08-25T10:15:00.000Z' });
  const payload = await buildRuntimePayload(db, EUI);
  assert.equal(payload.active_actuation.expectation_id, 'e-new');
});

test('buildRuntimePayload: CANCELLED/OBSERVED_COMPLETE rows are not an active_actuation', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'CANCELLED', commandedAt: '2026-08-25T10:00:00.000Z', expectedCloseAt: '2026-08-25T10:15:00.000Z' });
  const payload = await buildRuntimePayload(db, EUI);
  assert.equal(payload.active_actuation, null);
});

test('buildRuntimePayload: a recent STALE_* row is recent_stale_state, and does not double as active_actuation', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'STALE_OPEN_OBSERVED', commandedAt: '2026-08-25T09:00:00.000Z', expectedCloseAt: '2026-08-25T09:15:00.000Z' });
  const payload = await buildRuntimePayload(db, EUI);
  assert.equal(payload.recent_stale_state, 'STALE_OPEN_OBSERVED');
  assert.equal(payload.active_actuation, null);
});

test('buildRuntimePayload: a STALE_* row older than the 1-day lookback is not recent_stale_state', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'STALE_NO_OBSERVATION', commandedAt: '2026-08-01T09:00:00.000Z', expectedCloseAt: '2026-08-01T09:15:00.000Z' });
  const payload = await buildRuntimePayload(db, EUI);
  assert.equal(payload.recent_stale_state, null);
});

test('buildRuntimePayload: GEN1 weekday_states mirrors the raw WEEKDAY_PLAN push-ledger rows ValveScheduleDialog.tsx consumes', async () => {
  const { db } = await tempDb();
  await store.insertPushes(db, [
    { push_id: 'p1', device_eui: EUI, purpose: 'WEEKDAY_PLAN', weekday: 3, fport: 17, payload_hex: 'FF'.repeat(24), plan_hash: 'h3' },
    { push_id: 'p2', device_eui: EUI, purpose: 'WEEKDAY_PLAN', weekday: 4, fport: 18, payload_hex: 'FF'.repeat(24), plan_hash: 'h4' },
    // A CLOCK_SYNC row must not leak into weekday_states -- it is not a plan-push purpose.
    { push_id: 'p3', device_eui: EUI, purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null },
  ]);
  await store.ackPush(db, EUI, 'WEEKDAY_PLAN', 17, 3, '00', '2026-08-25T09:00:00.000Z');
  const payload = await buildRuntimePayload(db, EUI);
  assert.deepEqual(
    payload.push_state.weekday_states.slice().sort((a, b) => a.weekday - b.weekday),
    [
      { weekday: 3, state: 'ACKED', acked_at: '2026-08-25T09:00:00.000Z' },
      { weekday: 4, state: 'QUEUED', acked_at: null },
    ]
  );
  assert.equal(payload.push_state.queued, 1);
  assert.equal(payload.push_state.acked, 1);
});

test('buildRuntimePayload: GEN2 has no weekday_states key at all (mirrors the schedule dialog, which has nothing to filter a null-weekday DAYMASK_PLAN row into)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  await store.insertPushes(db, [
    { push_id: 'p1', device_eui: EUI, purpose: 'DAYMASK_PLAN', weekday: null, fport: 25, payload_hex: '8099151930', plan_hash: 'h1' },
  ]);
  const payload = await buildRuntimePayload(db, EUI);
  assert.equal('weekday_states' in payload.push_state, false);
  // 0x80 (all-days sentinel) expands to a QUEUED slot for each of the 7 weekdays -- same
  // per-slot counting store.pushSummary() already does for the "N of 7" plan-delivery badge.
  assert.equal(payload.push_state.queued, 7);
});

test('emitRuntimeChanged: unlinked gateway is a no-op -- returns null and enqueues nothing', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z', expectedCloseAt: '2026-08-25T10:15:00.000Z' });
  const result = await emitRuntimeChanged(db, EUI, new Date('2026-08-25T10:01:00.000Z'));
  assert.equal(result, null);
  const rows = await db.all('SELECT * FROM sync_outbox');
  assert.equal(rows.length, 0);
});

test('emitRuntimeChanged: a linked gateway enqueues a VALVE_RUNTIME_CHANGED sync_outbox row whose payload matches buildRuntimePayload', async () => {
  const { db } = await tempDb();
  await linkCloud(db, { gatewayDeviceEui: '0016C001F11715E2' });
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z', expectedCloseAt: '2026-08-25T10:15:00.000Z' });

  const now = new Date('2026-08-25T10:01:00.000Z');
  const result = await emitRuntimeChanged(db, EUI, now);
  assert.ok(result);
  assert.equal(result.event_uuid, result.event_uuid);

  const rows = await db.all('SELECT * FROM sync_outbox');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.aggregate_type, 'VALVE_RUNTIME');
  assert.equal(row.aggregate_key, EUI);
  assert.equal(row.op, 'VALVE_RUNTIME_CHANGED');
  assert.equal(row.gateway_device_eui, '0016C001F11715E2');
  assert.equal(row.occurred_at, '2026-08-25T10:01:00.000Z');

  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.contract_version, 1);
  assert.equal(payload.device_eui, EUI);
  assert.equal(payload.active_actuation.expectation_id, 'e1');
  assert.equal(payload.as_of, '2026-08-25T10:01:00.000Z');
});

test('emitRuntimeChanged: a device-level gateway_device_eui override wins over sync_link_state.gateway_device_eui, matching the 0024/0025 trigger COALESCE order', async () => {
  const { db } = await tempDb();
  await linkCloud(db, { gatewayDeviceEui: '0016C001F11715E2' });
  await db.run('UPDATE devices SET gateway_device_eui=? WHERE UPPER(deveui)=?', ['0016C001F1999999', EUI]);
  await emitRuntimeChanged(db, EUI, new Date());
  const row = await db.get('SELECT gateway_device_eui FROM sync_outbox');
  assert.equal(row.gateway_device_eui, '0016C001F1999999');
});

test('emitRuntimeChanged: multiple emits for the same device are not deduplicated/debounced -- each call enqueues its own row (design: coalescing is fine, cloud applier is last-write-wins on as_of)', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await emitRuntimeChanged(db, EUI, new Date('2026-08-25T10:00:00.000Z'));
  await emitRuntimeChanged(db, EUI, new Date('2026-08-25T10:00:01.000Z'));
  const rows = await db.all('SELECT occurred_at FROM sync_outbox ORDER BY occurred_at');
  assert.deepEqual(rows.map((r) => r.occurred_at), ['2026-08-25T10:00:00.000Z', '2026-08-25T10:00:01.000Z']);
});
