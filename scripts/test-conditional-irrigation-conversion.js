'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const plan = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan');
const push = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push');
const ack = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/ack');
const store = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store');
const workers = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers');

const EUI = '0016C001F1000001';

test('conditional weekly rows are excluded and mixed enabled mode fails closed', () => {
  const rows = [
    { schedule_uuid: 'fixed', kind: 'WEEKLY', enabled: 1, weekdays_mask: 1, start_time: '08:00', duration_minutes: 5 },
    { schedule_uuid: 'conditional', kind: 'WEEKLY', enabled: 1, condition_policy_uuid: 'policy-1', weekdays_mask: 1, start_time: '09:00', duration_minutes: 5 },
  ];
  assert.equal(plan.compileWindows(rows).days[0].length, 1);
  const mode = plan.validateScheduleModes(rows, [{ policy_uuid: 'policy-1', deleted_at: null, enabled: 1 }]);
  assert.equal(mode.ok, false);
  assert.equal(mode.code, 'mixed_schedule_mode');
});

test('conversion persists the exact empty program and current revision before transport', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.insertSchedule(db, { schedule_uuid: 'conditional', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 127, start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await db.run('UPDATE valve_schedules SET condition_policy_uuid=? WHERE schedule_uuid=?', ['policy-1', 'conditional']);
  await db.run("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone) VALUES ('policy-1','zone-1','{}','UTC')");
  const out = await push.compileAndQueue({ db, deviceEui: EUI, now: new Date('2026-10-18T10:00:00Z') });
  assert.equal(out.rows.length, 7);
  assert.equal(new Set(out.rows.map((row) => row.payload_hex)).size, 1);
  assert.equal(out.rows[0].payload_hex, 'FF'.repeat(24));
  const control = await store.conditionalControl(db, EUI);
  assert.equal(control.desired_revision, out.revision);
  assert.deepEqual(control.required_push_ids, out.rows.map((row) => row.push_id));
  assert.equal((await push.conditionalReadiness(db, EUI)).ready, false);
  fixture.cleanup();
});

test('Gen2 current clear requires attempted owner and positive status 1', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  await store.insertSchedule(db, { schedule_uuid: 'conditional-g2', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 127, start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await db.run('UPDATE valve_schedules SET condition_policy_uuid=? WHERE schedule_uuid=?', ['policy-2', 'conditional-g2']);
  await db.run("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone) VALUES ('policy-2','zone-1','{}','UTC')");
  const out = await push.compileAndQueue({ db, deviceEui: EUI, now: new Date('2026-10-18T10:00:00Z') });
  const id = out.required_push_ids[0];
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  assert.equal((await push.conditionalReadiness(db, EUI)).ready, false);
  await db.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: '2026-10-18T10:00:00Z' }), id]);
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  assert.equal((await push.conditionalReadiness(db, EUI)).ready, true);
  fixture.cleanup();
});

test('post-commit sender flushes and claims each current clear exactly once', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.insertSchedule(db, { schedule_uuid: 'conditional-send', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 1, start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await db.run('UPDATE valve_schedules SET condition_policy_uuid=? WHERE schedule_uuid=?', ['policy-send', 'conditional-send']);
  await db.run("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone) VALUES ('policy-send','zone-1','{}','UTC')");
  const prepared = await push.compileAndQueue({ db, deviceEui: EUI, now: new Date('2026-10-18T10:00:00Z') });
  let flushes = 0;
  let enqueues = 0;
  const transport = {
    async getDeviceQueue() { return []; },
    async flushDeviceQueue() { flushes += 1; },
    async enqueueDownlink() { enqueues += 1; return { id: 'queue-' + enqueues }; },
  };
  const sent = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport, now: new Date('2026-10-18T10:00:00Z') });
  assert.equal(sent.sent, 7);
  assert.equal(flushes, 1);
  assert.equal(enqueues, 7);
  const retry = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport, now: new Date('2026-10-18T10:01:00Z') });
  assert.equal(retry.sent, 0);
  assert.equal(enqueues, 7);
  fixture.cleanup();
});

test('ACK parsing is strict and raw Gen2 battery prefix accepts case-insensitive hex', () => {
  assert.deepEqual(ack.interpretUplink({ Schl_Port: 16, Schl_status: '01junk' }, 2).acks[0].status, null);
  const raw = Buffer.from('dAd00\x061901', 'binary');
  assert.deepEqual(ack.interpretUplink({}, 2, raw).acks, [{ purpose: 'DAYMASK_PLAN', fport: 25, weekday: null, status: 1 }]);
});
