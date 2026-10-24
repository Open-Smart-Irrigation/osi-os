#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { tempDb } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const store = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store');
const valveControl = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control');
const zoneEnv = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env');

const EUI = '0016C001F1000001';
const flow = JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json', 'utf8'));

async function insertExpectation(db, values) {
  await db.run(`INSERT INTO valve_actuation_expectations
    (expectation_id,device_eui,command_id,commanded_at,commanded_duration_seconds,expected_close_at,estimated_gross_liters,volume_source,reconciliation_state,trigger,transport_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, values);
}

test('recent command projection filters report-only rows before the 50-row limit', async () => {
  const fixture = await tempDb();
  const reportTransport = JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null } });
  for (let index = 0; index < 60; index += 1) {
    await insertExpectation(fixture.db, [
      'report-' + index, EUI, null, `2026-10-18T12:${String(index % 60).padStart(2, '0')}:00.000Z`, -1, '', null, 'unknown', 'OBSERVED_COMPLETE', 'unexplained', reportTransport, '2026-10-18T12:00:00.000Z',
    ]);
  }
  await insertExpectation(fixture.db, ['command-survives-limit', EUI, 'cmd-survives', '2026-10-18T09:00:00.000Z', 120, '2026-10-18T09:02:00.000Z', 3, 'estimated_duration_flow_rate', 'OBSERVED_COMPLETE', 'one_time', JSON.stringify({ phase: 'ATTEMPTED' }), '2026-10-18T09:00:00.000Z']);
  const node = flow.find((item) => item.id === 'get-actuations-query');
  const opened = [];
  const callbackDb = {
    all(sql, params, callback) { fixture.db.all(sql, params || []).then((rows) => callback(null, rows), (error) => callback(error)); },
    run(sql, params, callback) { fixture.db.run(sql, params || []).then(() => callback(null), (error) => callback(error)); },
    close(callback) { if (callback) callback(); },
  };
  const context = {
    msg: { payload: [{ id: 1 }], authUsername: 't' },
    osiDb: { Database: class Database { constructor() { return callbackDb; } } },
    osiLib: { require(name) { return name === 'osi-valve-control' ? { ok: true, value: valveControl } : { ok: false, error: name }; } },
    env: { get() { return ''; } },
    node: { warn(value) { opened.push(value); }, error(value) { opened.push(value); } },
  };
  const result = await vm.runInNewContext('(function(){\n' + node.func + '\n})()', context, { timeout: 5000 });
  assert.equal(result[0].payload.length, 1);
  assert.equal(result[0].payload[0].expectation_id, 'command-survives-limit');
  fixture.cleanup();
});

test('zone environment estimate projection skips malformed and valid report-only markers', async () => {
  const fixture = await tempDb();
  await fixture.db.run("INSERT INTO irrigation_zones(name,user_id,timezone) VALUES ('Projection Zone',1,'UTC')");
  const zone = await fixture.db.get("SELECT id FROM irrigation_zones WHERE name='Projection Zone'");
  const reportTransport = JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null } });
  await insertExpectation(fixture.db, ['report-volume', EUI, null, '2026-10-18T10:00:00.000Z', -1, '', 90, 'estimated_duration_flow_rate', 'OBSERVED_COMPLETE', 'unexplained', reportTransport, '2026-10-18T10:00:00.000Z']);
  await insertExpectation(fixture.db, ['malformed-volume', EUI, null, '2026-10-18T11:00:00.000Z', -1, '', 80, 'estimated_duration_flow_rate', 'OBSERVED_COMPLETE', 'unexplained', '{bad-json', '2026-10-18T11:00:00.000Z']);
  await fixture.db.run('UPDATE valve_actuation_expectations SET zone_id=? WHERE expectation_id IN (?,?)', [zone.id, 'report-volume', 'malformed-volume']);
  const node = flow.find((item) => item.id === 'zone-env-fn');
  const start = node.func.indexOf('async function loadEstimatedIrrigationByLocalDate');
  const end = node.func.indexOf('\nasync function buildWaterHistory', start);
  assert.ok(start >= 0 && end > start);
  const source = node.func.slice(start, end);
  const context = {
    ZE: zoneEnv,
    osiLib: { require(name) { return name === 'osi-valve-control' ? { ok: true, value: valveControl } : { ok: false, error: name }; } },
    node: { warn() {} },
    s(value) { return "'" + String(value).replace(/'/g, "''") + "'"; },
    q(sql) { return fixture.db.all(sql); },
  };
  const fn = await vm.runInNewContext('(async function(){\n' + source + '\nreturn loadEstimatedIrrigationByLocalDate;\n})()', context, { timeout: 5000 });
  const projected = await fn({ id: zone.id, timezone: 'UTC' }, '2026-10-18', '2026-10-18');
  assert.deepEqual(Object.keys(projected), []);
  fixture.cleanup();
});
