'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const scheduler = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-daily-scheduler');
const adapters = require('./fixtures/daily-scheduler/adapters.json');
const { execute, PROFILES, ROOT } = require('./lib/daily-scheduler-harness');
const { zone } = require('./lib/daily-scheduler-cases');
const WINDOW = Date.parse('2026-05-10T06:05:00Z');
const DAY = 24 * 3600 * 1000;

test('UTC-day window suppresses same-day backward jumps and preserves prior-day firing', () => {
  const same = scheduler.sameLogicalWindow;
  assert.equal(same(WINDOW, '2026-05-10T06:00:30Z'), true);
  assert.equal(same(WINDOW, '2026-05-10T06:10:00Z'), true);
  assert.equal(same(WINDOW, new Date(WINDOW - DAY).toISOString()), false);
  for (const last of [null, '', 'invalid']) assert.equal(same(WINDOW, last), false);
});

for (const profile of PROFILES) test(profile + ': extracted adapter skips and logs a same-day re-fire', async () => {
  const adapter = adapters.find(n => n.entry === 'decide');
  const c = { msg: { zone: { ...zone, last_triggered_at: '2026-05-10T06:10:00Z' }, payload: [{ mean_kpa: 35, n_points: 1 }] } };
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json'))).find(n => n.id === adapter.id);
  for (const source of [shipped.func, adapter.func]) {
    const actual = await execute(source, c, profile);
    assert.equal(actual.result[0], null);
    assert.match(actual.result[1].topic, /clock_jump_backward_suppressed/);
    assert.equal(actual.result[2], null);
    assert.ok(actual.trace.some(row => row[0] === 'warn' && row[1].startsWith('clock_jump_backward_suppressed:')));
  }
});
