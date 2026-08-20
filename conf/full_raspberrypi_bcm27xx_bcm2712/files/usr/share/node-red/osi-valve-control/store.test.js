'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const store = require('./store');

test('listValvesForUser: valve with no valve_settings row defaults to GEN1/ACTIVE (IMPORTANT 3)', async () => {
  const { db } = await tempDb();
  const rows = await store.listValvesForUser(db, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].strega_generation, 'GEN1');
  assert.equal(rows[0].scheduler_status, 'ACTIVE');
  db.close();
});

test('supersedeQueued(DAYMASK_PLAN) supersedes only rows whose mask intersects the new push (CRITICAL 1)', async () => {
  const { db } = await tempDb();
  // Row A: mask 0x80 (all days) QUEUED
  await store.insertPushes(db, [{ push_id: 'a', device_eui: '0016C001F1000001', purpose: 'DAYMASK_PLAN', weekday: null, fport: 25, payload_hex: '8099151930', plan_hash: 'h1' }]);
  // Row B: mask 0x08 (Wed only, bit3) QUEUED — must NOT be touched by a Monday-only (bit1=0x02) supersede
  await store.insertPushes(db, [{ push_id: 'b', device_eui: '0016C001F1000001', purpose: 'DAYMASK_PLAN', weekday: null, fport: 25, payload_hex: '0899151930', plan_hash: 'h2' }]);
  await store.supersedeQueued(db, '0016C001F1000001', 'DAYMASK_PLAN', 0x02);
  const rows = await db.all('SELECT push_id, state FROM valve_schedule_pushes ORDER BY push_id');
  const byId = Object.fromEntries(rows.map((r) => [r.push_id, r.state]));
  assert.equal(byId.a, 'SUPERSEDED', '0x80 (all-days, treated as 0x7F) intersects Monday (bit1)');
  assert.equal(byId.b, 'QUEUED', '0x08 (Wed) does not intersect Monday (bit1)');
  db.close();
});

test('updateSchedule and softDeleteSchedule resolve with no return value (MINOR 6)', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 's1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const u = await store.updateSchedule(db, 's1', { label: 'x' });
  assert.equal(u, undefined);
  const d = await store.softDeleteSchedule(db, 's1');
  assert.equal(d, undefined);
  db.close();
});
