'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const { queuePushes, buildStatusPush } = require('./push');
const { applyCloudCommand } = require('./cloud-commands');
const dispatch = require('./dispatch');

const EUI = '0016C001F1000001';

test('writer wrapper awaits delayed enqueue and returns no MQTT messages', async () => {
  const { db } = await tempDb();
  const events = [];
  const transport = {
    async getDeviceQueue() { events.push('get'); return []; },
    async enqueueDownlink(item) {
      events.push('enqueue-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('enqueue-end');
      return { id: 'queue-delayed-1' };
    },
    async flushDeviceQueue() { events.push('flush'); return { statusCode: 204 }; },
  };
  const out = await queuePushes({
    db, deviceEui: EUI, pushes: [buildStatusPush('1')],
    transport, now: new Date('2026-10-17T10:00:00.000Z'), warn: () => {},
  });
  assert.deepEqual(out.messages, []);
  assert.equal(out.transportResults[0].phase, 'ACCEPTED');
  // Design C (CMD-04 PR0) + R11 probe 2: queuePushes is the standalone path (clock tick, a
  // status appended in conditional mode) and never flushes: a flush there would kill a plan
  // snapshot still outstanding. Plan and fixed-mode status changes are snapshots.
  assert.deepEqual(events, ['enqueue-start', 'enqueue-end']);
  const persisted = await db.get('SELECT transport_json FROM valve_schedule_pushes WHERE push_id=?', [out.rows[0].push_id]);
  assert.match(persisted.transport_json, /queue-delayed-1/);
  db.close();
});

test('cloud writer surfaces an uncertain flush instead of reporting success', async () => {
  const { db } = await tempDb();
  const transport = {
    async getDeviceQueue() { throw new Error('gateway timeout'); },
    async enqueueDownlink() { throw new Error('must not enqueue after uncertain flush'); },
  };
  const out = await applyCloudCommand({
    db,
    cmd: {
      commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI,
      schedule_uuid: 'a1111111-0000-0000-0000-000000000021', kind: 'WEEKLY',
      weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true,
    },
    appId: 'app', transport, now: new Date('2026-10-17T10:00:00.000Z'), warn: () => {},
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'transport_uncertain');
  db.close();
});

test('reservation wrapper preserves valve_busy as a terminal local result', async () => {
  const { db } = await tempDb();
  await dispatch.reserveValveCommand({
    db, command: { device_eui: EUI, command_id: 'busy-first', action: 'OPEN_FOR_DURATION', duration_minutes: 5 },
    now: '2026-10-17T10:00:00.000Z',
  });
  await assert.rejects(
    dispatch.reserveValveCommand({
      db, command: { device_eui: EUI, command_id: 'busy-second', action: 'OPEN_FOR_DURATION', duration_minutes: 5 },
      now: '2026-10-17T10:00:01.000Z',
    }),
    (error) => error && error.code === 'valve_busy'
  );
  db.close();
});

test('timed-open writer encodes the persisted duration for both STREGA generations', async () => {
  for (const generation of ['GEN1', 'GEN2']) {
    const { db } = await tempDb();
    await db.run('UPDATE valve_settings SET strega_generation=? WHERE device_eui=?', [generation, EUI]);
    const reservation = await dispatch.reserveValveCommand({
      db,
      command: { device_eui: EUI, command_id: 'duration-' + generation, action: 'OPEN_FOR_DURATION', duration_minutes: 7 },
      now: '2026-10-17T10:00:00.000Z',
    });
    const sent = [];
    const result = await dispatch.enqueueValveCommand({
      db, deviceEui: EUI, owner: { type: 'expectation', id: reservation.expectation.expectation_id },
      item: { fPort: 2, data: Buffer.from([0x41, Number(reservation.expectation.commanded_duration_seconds) / 60]).toString('base64'), confirmed: false },
      transport: { async enqueueDownlink(item) { sent.push(item); return { id: 'duration-' + generation + '-queue' }; } },
      now: '2026-10-17T10:00:00.000Z',
    });
    assert.equal(result.phase, 'ACCEPTED');
    assert.deepEqual([...Buffer.from(sent[0].data, 'base64')], [0x41, 7]);
    db.close();
  }
});

test('writer honors explicit no-flush for clock and housekeeping style pushes', async () => {
  const { db } = await tempDb();
  const events = [];
  const out = await queuePushes({
    db, deviceEui: EUI, pushes: [buildStatusPush('1')], flushQueue: null,
    transport: {
      async getDeviceQueue() { events.push('get'); return []; },
      async flushDeviceQueue() { events.push('flush'); return { statusCode: 204 }; },
      async enqueueDownlink() { events.push('enqueue'); return { id: 'no-flush-1' }; },
    }, now: new Date('2026-10-17T10:00:00.000Z'), warn: () => {},
  });
  assert.equal(out.transportResults[0].phase, 'ACCEPTED');
  assert.deepEqual(events, ['enqueue']);
  db.close();
});

test('opaque writer owner persists original frame metadata and stable owner identity', async () => {
  const { db } = await tempDb();
  const owner = { type: 'opaque', id: 'opaque-owner-1', device_eui: EUI };
  const item = { fPort: 25, data: Buffer.from([0x25, 0x7f]).toString('base64'), confirmed: true, expiresAt: '2026-10-18T00:00:00.000Z' };
  await dispatch.enqueueValveCommand({ db, deviceEui: EUI, owner, item, transport: { async enqueueDownlink() { return { id: 'opaque-q-1' }; } }, now: '2026-10-17T10:00:00.000Z' });
  const settings = await db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [EUI]);
  const control = JSON.parse(settings.conditional_control_json);
  assert.equal(control.opaque.length, 1);
  assert.equal(control.opaque[0].owner_id, 'opaque-owner-1');
  assert.equal(control.opaque[0].queue_id, 'opaque-q-1');
  assert.equal(control.opaque[0].fPort, 25);
  assert.equal(control.opaque[0].data, item.data);
  assert.equal(control.opaque[0].confirmed, true);
  assert.equal(control.opaque[0].expiresAt, item.expiresAt);
  db.close();
});

test('flush captures a legacy opaque row with no ids in place with one durable identity', async () => {
  const { db } = await tempDb();
  await db.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', [EUI, JSON.stringify({ opaque: [{ device_eui: EUI, phase: 'ACCEPTED', queue_id: null, owner_id: null, data: 'AQI=', fPort: 25 }] })]);
  const result = await dispatch.flushValveQueue({
    db, deviceEui: EUI, reason: 'legacy-capture', now: new Date('2026-10-17T10:00:00.000Z'),
    transport: {
      async getDeviceQueue() { return []; },
      async flushDeviceQueue() { return { statusCode: 204 }; },
    },
  });
  assert.equal(result.ok, true);
  const control = JSON.parse((await db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [EUI])).conditional_control_json);
  assert.equal(control.opaque.length, 1);
  assert.match(control.opaque[0].owner_id, /^opaque:/);
  const flushIntent = control.flushes && control.flushes.find((intent) => intent.reason === 'legacy-capture');
  assert.ok(flushIntent, 'flush must persist an intent for the captured legacy owner');
  const capturedOwner = flushIntent.owners.find((owner) => owner.type === 'opaque');
  assert.equal(capturedOwner.id, control.opaque[0].owner_id);
  db.close();
});

test('concurrent real flush wrappers serialize device transport calls', async () => {
  const { db } = await tempDb();
  let active = 0; let maxActive = 0; let flushes = 0;
  const transport = {
    async getDeviceQueue() { active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; return []; },
    async flushDeviceQueue() { flushes += 1; active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; return { statusCode: 204 }; },
  };
  const [first, second] = await Promise.all([
    dispatch.flushValveQueue({ db, deviceEui: EUI, reason: 'concurrent-a', transport, now: new Date('2026-10-17T10:00:00.000Z') }),
    dispatch.flushValveQueue({ db, deviceEui: EUI, reason: 'concurrent-b', transport, now: new Date('2026-10-17T10:00:00.001Z') }),
  ]);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(maxActive, 1, 'flush RPCs must share the per-device writer gate');
  assert.equal(flushes, 2);
  db.close();
});

test('advanced timed open reservation preserves exact seconds including sub-minute and hours', async () => {
  for (const seconds of [30, 2 * 3600]) {
    const { db } = await tempDb();
    const reservation = await dispatch.reserveValveCommand({
      db, command: { device_eui: EUI, command_id: 'advanced-' + seconds, action: 'OPEN_FOR_DURATION', duration_seconds: seconds },
      now: '2026-10-17T10:00:00.000Z',
    });
    assert.equal(Number(reservation.expectation.commanded_duration_seconds), seconds);
    db.close();
  }
});
