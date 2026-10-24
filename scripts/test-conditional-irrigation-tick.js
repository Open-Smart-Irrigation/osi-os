'use strict';

// Execute the shipped due Function node against the real policy module and
// SQLite facade. The clock is the only injected seam because this test runs
// outside a provisioned gateway; qualification stays at its production false
// default and must produce an explicit persisted skip.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { tempDb } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');

async function run(profile) {
  const root = path.resolve(__dirname, '..');
  const runtimeRoot = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red`);
  const flow = JSON.parse(fs.readFileSync(path.join(runtimeRoot, '../flows.json'), 'utf8'));
  const due = flow.find((node) => node.id === 'conditional-due-fn');
  assert.ok(due, `${profile}: due Function node is installed`);

  const value = await tempDb();
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 60 * 1000);
  const localDate = start.toISOString().slice(0, 10);
  const startTime = `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`;
  const weekdaysMask = 1 << start.getUTCDay();
  const dueInstant = new Date(start);
  dueInstant.setUTCSeconds(0, 0);
  const recommendationAt = new Date(dueInstant.getTime() - 60 * 1000).toISOString();
  const recommendation = {
    raw_evidence: { version: 1, analysis: { computed_at: recommendationAt, stress: 'mild', action: 'maintain', usable_tree_count: 1 } },
    raw_decision: { version: 1, computed_at: recommendationAt },
  };
  const device = '0016C001F1000001';
  await value.db.run("INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid) VALUES (1,'Tick zone',1,'UTC','tick-zone')");
  await value.db.run('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?', [device]);
  await value.db.run(
    `INSERT INTO irrigation_policies(
      policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,
      min_interval_minutes,max_daily_minutes,delivery_settings_json,effective_from,sync_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['tick-policy', 'tick-zone', JSON.stringify({ kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' }), 'UTC', 1, 60, 60, 240, JSON.stringify({}), new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), 1],
  );
  await value.db.run(
    `INSERT INTO valve_schedules(
      schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,
      sync_version,condition_policy_uuid,effective_from
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['tick-schedule', device, 'WEEKLY', weekdaysMask, startTime, 5, 'UTC', 1, 1, 'tick-policy', new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()],
  );
  await value.db.run(
    `INSERT INTO zone_daily_recommendations(
      zone_id,date,zone_stress_summary,irrigation_action,recommendation_json,computed_at,usable_tree_count
    ) VALUES (?,?,?,?,?,?,?)`,
    [1, localDate, 'mild', 'maintain', JSON.stringify(recommendation), recommendation.raw_evidence.analysis.computed_at, 1],
  );
  await value.db.run(
    'INSERT INTO valve_settings(device_eui,conditional_control_json) VALUES (?,?)',
    [device, JSON.stringify({ desired_revision: 'tick-rev', required_push_ids: ['tick-push'], readiness: { state: 'READY' } })],
  );
  await value.db.run(
    `INSERT INTO valve_schedule_pushes(push_id,device_eui,purpose,weekday,fport,payload_hex,state)
     VALUES (?,?,?,?,?,?,?)`,
    ['tick-push', device, 'WEEKDAY_PLAN', 1, 14, '00', 'ACKED'],
  );

  const oldBase = process.env.OSI_LIB_BASE;
  process.env.OSI_LIB_BASE = runtimeRoot;
  const oldNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = path.join(path.resolve(root, '../..'), 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules');
  Module._initPaths();
  const osiLib = require(path.join(runtimeRoot, 'osi-lib'));
  const dbReal = require(path.join(runtimeRoot, 'osi-db-helper'));
  const policy = require(path.join(runtimeRoot, 'osi-irrigation-policy'));
  const clock = require(path.join(runtimeRoot, 'osi-irrigation-policy/clock'));
  const originalClock = clock.runtimeClockStatus;
  clock.runtimeClockStatus = () => ({ trusted: true, reason: 'fixture' });
  class TestDatabase extends dbReal.Database {
    constructor() { super(value.path); }
  }
  const dbLoad = { ...dbReal, Database: TestDatabase };
  const transport = {
    async enqueueDownlink() { throw new Error('qualification should stop before transport'); },
  };
  const loader = {
    require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: dbLoad };
      if (name === 'osi-irrigation-policy') return { ok: true, value: policy };
      if (name === 'chirpstack') return { ok: true, value: { createProvisioningClientFromEnv: () => transport } };
      return osiLib.require(name);
    },
  };
  const node = { errors: [], warnings: [], statuses: [], error(value) { this.errors.push(String(value && value.message || value)); }, warn(value) { this.warnings.push(String(value && value.message || value)); }, status(value) { this.statuses.push(value); } };
  const env = { get() { return ''; } };
  try {
    const invoke = new Function('msg', 'osiLib', 'env', 'node', due.func);
    await invoke({ payload: null }, loader, env, node);
    assert.deepEqual(node.errors, [], `${profile}: decoded due tick has no errors`);
    const occurrence = await value.db.get('SELECT state, decision, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['tick-schedule']);
    assert.equal(occurrence.state, 'SKIPPED', `${profile}: actual tick persists an explicit production qualification skip`);
    assert.equal(occurrence.decision, 'SKIPPED');
    assert.equal(occurrence.decision_reason, 'qualification_unavailable');
  } finally {
    clock.runtimeClockStatus = originalClock;
    if (oldBase === undefined) delete process.env.OSI_LIB_BASE;
    else process.env.OSI_LIB_BASE = oldBase;
    if (oldNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = oldNodePath;
    value.cleanup();
  }
}

const profile = process.argv[2] || 'bcm2712';
assert.ok(['bcm2712', 'bcm2709'].includes(profile), `unsupported profile ${profile}`);
run(profile).then(() => console.log(`OK (decoded conditional due tick, ${profile})`)).catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
