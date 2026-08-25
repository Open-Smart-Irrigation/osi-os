#!/usr/bin/env node
'use strict';
// Valve control Phase B Task 6: pins that strega-reconciliation-monitor logs an
// irrigation_events row exactly when an expectation transitions to OBSERVED_COMPLETE for an
// on-valve-observed trigger ('on_valve_schedule' / 'unexplained'), and never for 'one_time'
// (already logged at fire time by osi-valve-control/workers.js:53,62 - logging it again here
// would double-count the farmer's water). Execution-based (runs the node's real `func`
// against a real sqlite database via node:sqlite), not a source-text regex, so a
// behavior-preserving-looking refactor that actually inverts the gate is caught.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FLOWS_PATH = path.resolve(
  __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
const monitorNode = flows.find((n) => n.id === 'strega-reconciliation-monitor');
if (!monitorNode) throw new Error('strega-reconciliation-monitor node not found in flows.json');

const { tempDb, linkCloud } = require(path.resolve(
  __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers.js'
));
// P3-E1 added an `osiLib.require('osi-valve-control')` call to the monitor node's own func
// (for its VALVE_RUNTIME_CHANGED emission) -- the real module, not a hand-built stub, since this
// test's whole point is to exercise real DB-writing side effects end to end (including, as of
// P4-E1, VALVE_ACTUATION_ARCHIVED).
const VC = require(path.resolve(
  __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/index.js'
));
const osiLib = {
  require: (name) => (name === 'osi-valve-control' ? { ok: true, value: VC } : { ok: false, error: 'unexpected osiLib.require: ' + name }),
};

const EUI = '0016C001F1000001';

// Same shape as osi-valve-control/test-helpers.js's facade(), except close() is a deliberate
// no-op: the node under test (strega-reconciliation-monitor) opens its OWN
// `new osiDb.Database(...)` and calls db.close() in its finally block. Reusing the real
// facade() here would let that close() call tear down the SAME underlying node:sqlite
// connection the test's own `db` handle needs afterward to assert what actually landed.
function facadeNoClose(raw) {
  return {
    get: (sql, params) => Promise.resolve(raw.prepare(sql).get(...(params || []))),
    all: (sql, params) => Promise.resolve(raw.prepare(sql).all(...(params || []))),
    run: (sql, params) => { const r = raw.prepare(sql).run(...(params || [])); return Promise.resolve({ changes: Number(r.changes) }); },
    async transaction(executor) {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await executor(facadeNoClose(raw)); raw.exec('COMMIT'); return out; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw e; }
    },
    close: (cb) => { if (cb) cb(); },
  };
}

function noopNode() {
  const calls = { warns: [], logs: [], errors: [] };
  return { warn: (m) => calls.warns.push(m), log: (m) => calls.logs.push(m), error: (m) => calls.errors.push(m), status: () => {}, calls };
}

// Runs the real node `func` against `raw` (a node:sqlite DatabaseSync opened by tempDb()).
// `new osiDb.Database(...)` always returns a facade over the SAME connection, so writes are
// immediately visible to assertions made through the test's own `db` handle.
async function runMonitor(raw) {
  const osiDb = { Database: function Database() { return facadeNoClose(raw); } };
  const node = noopNode();
  const msg = { payload: null };
  const runner = new Function(
    'msg', 'node', 'osiDb', 'osiLib', 'flow', 'context', 'env', 'global',
    monitorNode.func + '\n//# sourceURL=strega-reconciliation-monitor.js'
  );
  const noopCtx = { get: () => undefined, set: () => {} };
  const outMsg = await runner(msg, node, osiDb, osiLib, noopCtx, noopCtx, { get: () => null }, { get: () => undefined });
  return { result: outMsg && outMsg.payload, node };
}

async function seedExpectation(db, overrides) {
  const now = Date.now();
  const commandedAt = new Date(now - 20 * 60000).toISOString(); // 20 min ago
  const expectedCloseAt = new Date(now - 5 * 60000).toISOString(); // already due
  const base = {
    expectation_id: 'exp-' + Math.random().toString(36).slice(2),
    device_eui: EUI,
    zone_id: null,
    command_id: null,
    effect_key: null,
    commanded_at: commandedAt,
    commanded_duration_seconds: 900,
    expected_close_at: expectedCloseAt,
    flow_rate_lpm: null,
    flow_rate_source: null,
    estimated_gross_liters: null,
    volume_source: 'unknown',
    observed_open_at: new Date(now - 15 * 60000).toISOString(),
    observed_close_at: null,
    reconciliation_state: 'OBSERVED_RUNNING',
    cancel_reason: null,
    created_at: commandedAt,
    trigger: 'on_valve_schedule',
  };
  const row = Object.assign(base, overrides || {});
  await db.run(
    `INSERT INTO valve_actuation_expectations(expectation_id, device_eui, zone_id, command_id, effect_key,
      commanded_at, commanded_duration_seconds, expected_close_at, flow_rate_lpm, flow_rate_source,
      estimated_gross_liters, volume_source, observed_open_at, observed_close_at, reconciliation_state,
      cancel_reason, created_at, trigger) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.expectation_id, row.device_eui, row.zone_id, row.command_id, row.effect_key,
      row.commanded_at, row.commanded_duration_seconds, row.expected_close_at, row.flow_rate_lpm, row.flow_rate_source,
      row.estimated_gross_liters, row.volume_source, row.observed_open_at, row.observed_close_at, row.reconciliation_state,
      row.cancel_reason, row.created_at, row.trigger]
  );
  return row;
}

// Simulates a fresh CLOSE uplink: current_state=CLOSE with device_data.recorded_at and
// devices.updated_at both newer than commanded_at, matching the monitor's state-freshness gate.
async function simulateCloseUplink(db) {
  const recordedAt = new Date(Date.now() - 60000).toISOString();
  await db.run("UPDATE devices SET current_state='CLOSED', updated_at=? WHERE deveui=?", [recordedAt, EUI]);
  await db.run('INSERT INTO device_data(deveui, recorded_at) VALUES (?,?)', [EUI, recordedAt]);
}

async function main() {
  await test('OBSERVED_COMPLETE + trigger=on_valve_schedule logs exactly one irrigation_events row with the observed-span duration', async () => {
    const { db, raw } = await tempDb();
    await db.run("INSERT INTO irrigation_zones(name, user_id, created_at, updated_at) VALUES ('Z1',1,datetime('now'),datetime('now'))");
    const zone = await db.get('SELECT id FROM irrigation_zones LIMIT 1');
    await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, EUI]);
    const exp = await seedExpectation(db, { trigger: 'on_valve_schedule' });
    await simulateCloseUplink(db);

    const { result } = await runMonitor(raw);
    assert.equal(result.advanced, 1);

    const events = await db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI]);
    assert.equal(events.length, 1, 'exactly one irrigation_events row must be written');
    assert.equal(events[0].action, 'IRRIGATE');
    assert.equal(events[0].reason, 'on_valve_schedule_run');
    assert.notEqual(events[0].reason, 'one_time_open', 'reason must be distinct from the ONCE-run reason');
    assert.equal(events[0].user_id, 1);
    assert.equal(events[0].irrigation_zone_id, zone.id);
    // The INSERT itself must omit event_uuid; the seed DB's trg_sync_irrigation_events_uuid_ai
    // then mints the canonical 'irrig-<gwEui>-<seq>' key on top of it (proof the column was
    // NULL going in - a hand-rolled UUID would not match this exact trigger-owned shape).
    assert.match(events[0].event_uuid, /^irrig-[0-9A-Fa-f]+-\d+$/, 'event_uuid must be the trigger-minted canonical key, not a hand-rolled UUID');
    const updated = await db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', [exp.expectation_id]);
    assert.equal(updated.reconciliation_state, 'OBSERVED_COMPLETE');
  });

  await test('OBSERVED_COMPLETE + trigger=unexplained also logs, with a distinct reason', async () => {
    const { db, raw } = await tempDb();
    await db.run("INSERT INTO irrigation_zones(name, user_id, created_at, updated_at) VALUES ('Z1',1,datetime('now'),datetime('now'))");
    const zone = await db.get('SELECT id FROM irrigation_zones LIMIT 1');
    await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, EUI]);
    await seedExpectation(db, { trigger: 'unexplained' });
    await simulateCloseUplink(db);

    await runMonitor(raw);
    const events = await db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI]);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'unexplained_on_valve_run');
  });

  await test('OBSERVED_COMPLETE + trigger=one_time logs NOTHING (already logged at fire time)', async () => {
    const { db, raw } = await tempDb();
    await db.run("INSERT INTO irrigation_zones(name, user_id, created_at, updated_at) VALUES ('Z1',1,datetime('now'),datetime('now'))");
    const zone = await db.get('SELECT id FROM irrigation_zones LIMIT 1');
    await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, EUI]);
    await seedExpectation(db, { trigger: 'one_time' });
    await simulateCloseUplink(db);

    const { result } = await runMonitor(raw);
    assert.equal(result.advanced, 1, 'the expectation must still transition to OBSERVED_COMPLETE');
    const events = await db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI]);
    assert.equal(events.length, 0, 'a ONCE run must not be double-logged');
  });

  await test('a zone-less/unclaimed valve logs nothing and warns, but still advances state', async () => {
    const { db, raw } = await tempDb();
    await db.run('UPDATE devices SET irrigation_zone_id=NULL WHERE deveui=?', [EUI]);
    await seedExpectation(db, { trigger: 'on_valve_schedule' });
    await simulateCloseUplink(db);

    const { result, node } = await runMonitor(raw);
    assert.equal(result.advanced, 1);
    const events = await db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI]);
    assert.equal(events.length, 0, 'irrigation_events.irrigation_zone_id is NOT NULL - a zone-less valve must log nothing');
    assert.ok(node.calls.warns.some((w) => /observed run not logged/.test(w)), 'must warn about the skipped log');
  });

  await test('observed_open_at null (never confirmed open) logs with a NULL duration, not zero', async () => {
    const { db, raw } = await tempDb();
    await db.run("INSERT INTO irrigation_zones(name, user_id, created_at, updated_at) VALUES ('Z1',1,datetime('now'),datetime('now'))");
    const zone = await db.get('SELECT id FROM irrigation_zones LIMIT 1');
    await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, EUI]);
    await seedExpectation(db, { trigger: 'unexplained', reconciliation_state: 'PENDING_OBSERVATION', observed_open_at: null });
    await simulateCloseUplink(db);

    await runMonitor(raw);
    const events = await db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI]);
    assert.equal(events.length, 1);
    assert.equal(events[0].duration_minutes, null, 'an unknown observed-open time must log an unknown duration, never a substituted zero');
  });

  await test('a non-completing transition (PENDING_OBSERVATION -> OBSERVED_RUNNING) never logs an event', async () => {
    const { db, raw } = await tempDb();
    await db.run("INSERT INTO irrigation_zones(name, user_id, created_at, updated_at) VALUES ('Z1',1,datetime('now'),datetime('now'))");
    const zone = await db.get('SELECT id FROM irrigation_zones LIMIT 1');
    await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, EUI]);
    await seedExpectation(db, { trigger: 'on_valve_schedule', reconciliation_state: 'PENDING_OBSERVATION', observed_open_at: null, observed_close_at: null });
    const recordedAt = new Date(Date.now() - 60000).toISOString();
    await db.run("UPDATE devices SET current_state='OPEN', updated_at=? WHERE deveui=?", [recordedAt, EUI]);
    await db.run('INSERT INTO device_data(deveui, recorded_at) VALUES (?,?)', [EUI, recordedAt]);

    const { result } = await runMonitor(raw);
    assert.equal(result.advanced, 1);
    const events = await db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI]);
    assert.equal(events.length, 0);
  });

  // --- Bovey cloud full-parity Task P4-E1: VALVE_ACTUATION_ARCHIVED on terminal transitions ---

  await test('OBSERVED_COMPLETE on a linked gateway emits a VALVE_ACTUATION_ARCHIVED sync_outbox row (status=COMPLETED); unlinked emits nothing', async () => {
    const { db, raw } = await tempDb();
    await seedExpectation(db, { trigger: 'unexplained' });
    await simulateCloseUplink(db);
    await runMonitor(raw);
    assert.equal((await db.all('SELECT * FROM sync_outbox')).length, 0, 'unlinked gateway must not enqueue anything');

    const exp2 = await seedExpectation(db, { trigger: 'unexplained' });
    await linkCloud(db);
    const recordedAt = new Date(Date.now() - 60000).toISOString();
    await db.run("UPDATE devices SET current_state='CLOSED', updated_at=? WHERE deveui=?", [recordedAt, EUI]);
    await db.run('INSERT INTO device_data(deveui, recorded_at) VALUES (?,?)', [EUI, recordedAt]);

    await runMonitor(raw);
    const rows = await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_ACTUATION_ARCHIVED'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].aggregate_key, exp2.expectation_id);
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.expectation_id, exp2.expectation_id);
    assert.equal(payload.status, 'COMPLETED');
    assert.equal(payload.trigger, 'unexplained');
  });

  await test('STALE_NO_OBSERVATION (never observed open, past grace) emits status=OPEN_TIMEOUT on a linked gateway', async () => {
    const { db, raw } = await tempDb();
    await linkCloud(db);
    const farPast = new Date(Date.now() - 40 * 60000).toISOString(); // 40 min ago: past the 30-min grace
    const exp = await seedExpectation(db, {
      trigger: 'manual', reconciliation_state: 'PENDING_OBSERVATION',
      observed_open_at: null, observed_close_at: null, expected_close_at: farPast,
    });

    const { result } = await runMonitor(raw);
    assert.equal(result.advanced, 1);
    const updated = await db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', [exp.expectation_id]);
    assert.equal(updated.reconciliation_state, 'STALE_NO_OBSERVATION');

    const rows = await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_ACTUATION_ARCHIVED'");
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].payload_json).status, 'OPEN_TIMEOUT');
  });

  await test('STALE_OPEN_OBSERVED (observed open, never observed close, past grace) emits status=CLOSE_TIMEOUT on a linked gateway', async () => {
    const { db, raw } = await tempDb();
    await linkCloud(db);
    const farPast = new Date(Date.now() - 40 * 60000).toISOString(); // 40 min ago: past the 30-min grace
    const exp = await seedExpectation(db, {
      trigger: 'manual', reconciliation_state: 'OBSERVED_RUNNING',
      observed_open_at: new Date(Date.now() - 35 * 60000).toISOString(), observed_close_at: null, expected_close_at: farPast,
    });

    const { result } = await runMonitor(raw);
    assert.equal(result.advanced, 1);
    const updated = await db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', [exp.expectation_id]);
    assert.equal(updated.reconciliation_state, 'STALE_OPEN_OBSERVED');

    const rows = await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_ACTUATION_ARCHIVED'");
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].payload_json).status, 'CLOSE_TIMEOUT');
  });

  await test('a non-completing transition (PENDING_OBSERVATION -> OBSERVED_RUNNING) never emits VALVE_ACTUATION_ARCHIVED, even on a linked gateway', async () => {
    const { db, raw } = await tempDb();
    await linkCloud(db);
    await seedExpectation(db, { trigger: 'on_valve_schedule', reconciliation_state: 'PENDING_OBSERVATION', observed_open_at: null, observed_close_at: null });
    const recordedAt = new Date(Date.now() - 60000).toISOString();
    await db.run("UPDATE devices SET current_state='OPEN', updated_at=? WHERE deveui=?", [recordedAt, EUI]);
    await db.run('INSERT INTO device_data(deveui, recorded_at) VALUES (?,?)', [EUI, recordedAt]);

    const { result } = await runMonitor(raw);
    assert.equal(result.advanced, 1, 'the expectation must still advance to OBSERVED_RUNNING');
    assert.equal((await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_ACTUATION_ARCHIVED'")).length, 0);
    // The runtime-state emission is unaffected by this task's addition.
    assert.equal((await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).length, 1);
  });
}

main();
