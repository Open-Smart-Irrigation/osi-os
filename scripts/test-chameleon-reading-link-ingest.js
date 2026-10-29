#!/usr/bin/env node
'use strict';
// Issue #356: a Chameleon uplink stores its canonical device_data row and its
// chameleon_readings diagnostic, then links the two by row id; calibration
// backfill fills a linked row only from its own linked diagnostic. Drives the
// shipped "LSN50 Normalize + Write", "Insert Chameleon Reading",
// "calibration-persist" and "calibration-local-backfill" bodies of both
// maintained profiles through the real osi-db-helper over a temp file
// database, and the shipped legacy scheduler query and decision nodes over the
// result. The sqlite3 binding is replaced by a node:sqlite adapter, as in
// scripts/test-lsn50-counter-concurrency.js. "Apply Config" is unchanged by
// #356 and is not driven here: each message carries the fields it produces.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/flow-node-harness');

const root = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-chameleon-link-'));
const EUI_A = 'A840410000000001';
const EUI_B = 'A840410000000002';
const VALVE = 'A840410000000019';
const GATEWAY = '0016C001F1000001';
const ARRAY = 'AABBCCDDEEFF0011';
const T0 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const QUERY_ID = 'd0b2b1c1a937e16d';
const DECISION_ID = '5f0d2b7e9b9b1b3a';
// kPa = a*ln(kOhm) + b*kOhm + c with a=0, b=1, c=0: 20000 Ohm -> 20 kPa.
const CALIBRATION = {
  array_id: ARRAY, sensor_id: 'S-TEST', source: 'test',
  sensor1_a: 0, sensor1_b: 1, sensor1_c: 0, sensor1_r2: 1,
  sensor2_a: 0, sensor2_b: 1, sensor2_c: 0, sensor2_r2: 1,
  sensor3_a: 0, sensor3_b: 1, sensor3_c: 0, sensor3_r2: 1,
};

function adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
      } catch (error) { callback.call(this, error); }
    }
    exec(sql, callback) {
      try { this.native.exec(sql); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
    close(callback) {
      try { this.native.close(); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function profilePaths(profile) {
  const share = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
  return { share, nodeRed: path.join(share, 'node-red'), flows: path.join(share, 'flows.json') };
}

function loadHelper(helperPath) {
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) return adapter();
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
  } finally {
    Module._load = original;
  }
}

let dbCount = 0;
function seedFile({ syncLinked = false, sql = '' } = {}) {
  dbCount += 1;
  const dbPath = path.join(tempRoot, `farming-${dbCount}.db`);
  const native = new DatabaseSync(dbPath);
  native.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  native.exec('PRAGMA foreign_keys=ON');
  native.exec(`
    INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z One', 1, 'z-1', 'UTC', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES
      ('${EUI_A}', 'Chameleon A', 'DRAGINO_LSN50', 1, 1, 1, '2026-01-01', '2026-01-01'),
      ('${EUI_B}', 'Chameleon B', 'DRAGINO_LSN50', 1, 1, 1, '2026-01-01', '2026-01-01'),
      ('${VALVE}', 'Valve', 'STREGA_VALVE', 1, 1, 0, '2026-01-01', '2026-01-01');`);
  if (syncLinked) {
    native.exec(`INSERT INTO sync_link_state (peer_node, linked, gateway_device_eui, updated_at)
      VALUES ('cloud', 1, '${GATEWAY}', '2026-10-28T00:00:00.000Z')`);
  }
  if (sql) native.exec(sql);
  native.close();
  return dbPath;
}

function snapshot(dbPath, sql) {
  const native = new DatabaseSync(dbPath, { readOnly: true });
  try { return native.prepare(sql).all().map((r) => ({ ...r })); } finally { native.close(); }
}

function runtime(profile, dbPath) {
  const p = profilePaths(profile);
  const flows = JSON.parse(fs.readFileSync(p.flows, 'utf8'));
  const modules = {
    dendro: require(path.join(p.nodeRed, 'osi-dendro-helper')),
    chameleon: require(path.join(p.nodeRed, 'osi-chameleon-helper')),
    'lsn50-normalize': require(path.join(p.nodeRed, 'osi-lsn50-normalize')),
    'device-writer': require(path.join(p.nodeRed, 'osi-device-writer')),
    rain: require(path.join(p.nodeRed, 'osi-rain')),
  };
  const manifest = fs.readFileSync(path.join(p.nodeRed, 'edge-channels.json'), 'utf8');
  const osiDb = loadHelper(path.join(p.nodeRed, 'osi-db-helper/index.js'));
  // Opens the shared connection on the temp file; also used as "another node".
  const facade = new osiDb.Database(dbPath);
  const errors = [];
  const warnings = [];
  const node = { status() {}, warn(m) { warnings.push(String(m)); }, error(m) { errors.push(String(m)); } };
  const globalApi = { get: (k) => (k === 'fs' ? { readFileSync: () => manifest } : undefined) };
  const osiLib = { require: (name) => (modules[name] ? { ok: true, value: modules[name] } : { ok: false, error: name }) };
  const libs = { osiDb, osiLib, dendro: modules.dendro, chameleon: modules.chameleon };
  const compile = (id) => {
    const n = flows.find((entry) => entry.id === id);
    assert.ok(n && n.type === 'function', 'function node ' + id);
    const names = (n.libs || []).map((l) => l.var);
    const fn = new AsyncFunction('msg', 'node', 'flow', 'global', ...names, n.func);
    return (msg) => fn(msg, node, { get() {}, set() {} }, globalApi, ...names.map((v) => libs[v]));
  };
  const write = compile('460e0bfd95f89e67');
  const insert = compile('chameleon-readings-insert-fn');
  const persist = compile('51c0ae3799c97131');
  const backfill = compile('d20948dd9120a3d2');
  async function deliver(fields) {
    const msg = { formattedData: chameleonUplink(fields) };
    const written = await write(msg);
    if (written === null) return null;
    return insert(written);
  }
  // Calibration arrives the way the sync worker delivers it: persist, then backfill.
  async function calibrate() {
    const persisted = await persist({ payload: { calibrations: [CALIBRATION], not_found: [] } });
    assert.ok(persisted, 'calibration-persist passes the message on: ' + JSON.stringify(warnings));
    assert.deepEqual(persisted.calibrated, [ARRAY]);
    assert.equal(await backfill(persisted), null);
  }
  return { deliver, write, insert, calibrate, facade, errors, warnings };
}

// formattedData as "Apply Config" leaves it for a Chameleon uplink.
function chameleonUplink({ devEui = EUI_A, timestamp = T0, swt1 = 40, swt2 = 30, r1 = 1000, r2 = 2000, ...rest } = {}) {
  return {
    devEui, timestamp, isChameleon: true, detectedMode: 1, modeCodeToStore: 1, modeLabelToStore: 'MOD1',
    swt1Kpa: swt1, swt2Kpa: swt2, swt3Kpa: null, dendroValid: null,
    chameleonPayloadVersion: 1, chameleonStatusFlags: 0, chameleonCompPending: 0, chameleonDataInvalid: 0,
    chameleonI2cMissing: 0, chameleonTimeout: 0, chameleonTempFault: 0, chameleonIdFault: 0,
    chameleonCh1Open: 0, chameleonCh2Open: 0, chameleonCh3Open: 1,
    chameleonTempC: 21.5, chameleonR1OhmComp: r1, chameleonR2OhmComp: r2, chameleonR3OhmComp: null,
    chameleonArrayId: ARRAY, calibrationStatus: 'calibrated', fPort: 2, fCnt: 7,
    ...rest,
  };
}

// Stored rows as an older ingest or a pre-calibration uplink leaves them: no
// SWT yet, a diagnostic with resistances and the array id, optionally linked.
function storedRows(spec) {
  return spec.map(({ at = T0, r1, r2, diagnostic = true, link = true }, i) => `
    INSERT INTO device_data (deveui, recorded_at) VALUES ('${EUI_A}', '${at}');
    ${diagnostic ? `INSERT INTO chameleon_readings (deveui, recorded_at, payload_version, status_flags, data_invalid, i2c_missing, timeout,
        ch1_open, ch2_open, ch3_open, r1_ohm_comp, r2_ohm_comp, array_id, calibration_status)
      VALUES ('${EUI_A}', '${at}', 1, 0, 0, 0, 0, 0, 0, 1, ${r1}, ${r2}, '${ARRAY}', NULL);` : ''}
    ${diagnostic && link ? `INSERT INTO chameleon_reading_links (chameleon_reading_id, device_data_id)
      VALUES ((SELECT MAX(id) FROM chameleon_readings), (SELECT MAX(id) FROM device_data));` : ''}
    -- row ${i + 1}`).join('\n');
}

const LINKED_SQL = `SELECT dd.id AS device_data_id, dd.deveui AS data_eui, dd.recorded_at AS data_at, dd.swt_1, dd.swt_2, dd.swt_3,
    cr.id AS reading_id, cr.deveui AS reading_eui, cr.recorded_at AS reading_at, cr.r1_ohm_comp, cr.r2_ohm_comp
  FROM chameleon_reading_links l
  JOIN device_data dd ON dd.id = l.device_data_id
  JOIN chameleon_readings cr ON cr.id = l.chameleon_reading_id
  ORDER BY dd.id`;
const APPEND_EVENTS_SQL = "SELECT COUNT(*) AS n FROM sync_outbox WHERE upper(op) = 'DEVICE_DATA_APPENDED'";

async function schedule(profile, dbPath, metric = 'SWT_1') {
  const flowsPath = profilePaths(profile).flows;
  const buildQuery = new Function('msg', loadNode(QUERY_ID, flowsPath).func); // eslint-disable-line no-new-func
  const zone = {
    zone_id: 1, zone_name: 'Z One', user_id: 1, scheduling_mode: 'local', trigger_metric: metric,
    threshold_kpa: 50, duration_minutes: 10, enabled: 1, last_triggered_at: null,
    enabled_scope_holders: 1, valve_deveui: VALVE, shared_environment_json: null,
  };
  const query = buildQuery({ payload: zone });
  const db = new DatabaseSync(dbPath);
  try {
    const row = { ...db.prepare(query.topic).get() };
    const { result } = await executeFunction(loadNode(DECISION_ID, flowsPath), { msg: { payload: [row], zone: query.zone }, db });
    return { row, result };
  } finally { db.close(); }
}

function assertNoData({ row, result }) {
  assert.equal(row.n_points, 0, 'no eligible value: ' + JSON.stringify(row));
  assert.equal(row.mean_kpa, null);
  assert.equal(result[0], null, 'no actuator message');
  assert.equal(result[2], null, 'last_triggered_at is not advanced');
  assert.match(result[1].topic, /'SKIP', 'no_data_last_hour'/);
}

// The decision node returns [{ payload: cmd, ... }, event, schedule update];
// cmd is { type: 'actuator_command', device: { devEui }, data: { action, ... } }.
function assertOpensAt({ row, result }, n, mean) {
  assert.equal(row.n_points, n, JSON.stringify(row));
  assert.equal(row.mean_kpa, mean);
  const command = result[0];
  assert.ok(command && command.payload && command.payload.data, 'an actuator message: ' + JSON.stringify(command));
  assert.equal(command.payload.type, 'actuator_command');
  assert.equal(command.payload.device.devEui, VALVE);
  assert.equal(command.payload.data.action, 'OPEN_FOR_DURATION');
  assert.equal(command.payload.data.reason, 'scheduler_threshold');
  assert.match(result[1].topic, /'IRRIGATE', 'scheduler_threshold'/);
}

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

for (const profile of PROFILES) {
  // Normal ingest.
  test(`${profile}: one Chameleon uplink stores one canonical row, one diagnostic and one link between them`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const out = await rt.deliver({});
    assert.ok(out, 'the message continues downstream');
    assert.deepEqual(rt.errors, []);
    const data = snapshot(dbPath, 'SELECT id FROM device_data');
    assert.equal(data.length, 1);
    assert.equal(out.formattedData.deviceDataId, data[0].id, 'Normalize + Write exposes its own RETURNING id');
    const linked = snapshot(dbPath, LINKED_SQL);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].device_data_id, data[0].id);
    assert.equal(linked[0].data_eui, EUI_A);
    assert.equal(linked[0].reading_eui, EUI_A);
    assert.equal(linked[0].swt_1, 40);
    assert.equal(linked[0].r1_ohm_comp, 1000);
  });

  test(`${profile}: two same-timestamp uplinks in flight together each link their own rows`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    await Promise.all([rt.deliver({ swt1: 41, r1: 1001, fCnt: 8 }), rt.deliver({ swt1: 42, r1: 1002, fCnt: 9 })]);
    assert.deepEqual(rt.errors, []);
    const linked = snapshot(dbPath, LINKED_SQL);
    assert.equal(linked.length, 2);
    for (const row of linked) {
      assert.equal(row.data_at, T0);
      assert.equal(row.reading_at, T0);
      assert.equal(row.r1_ohm_comp, row.swt_1 === 41 ? 1001 : 1002, 'a link pairs the rows of one message: ' + JSON.stringify(row));
    }
    assert.equal(new Set(linked.map((r) => r.reading_id)).size, 2);
  });

  test(`${profile}: a clamped canonical timestamp still links by id`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    await rt.deliver({ timestamp: '2020-01-01T00:00:00.000Z' });
    const linked = snapshot(dbPath, LINKED_SQL);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].reading_at, '2020-01-01T00:00:00.000Z', 'the diagnostic keeps the uplink time as before');
    assert.notEqual(linked[0].data_at, linked[0].reading_at, 'device-writer clamped the canonical time');
  });

  test(`${profile}: a diagnostic without a device_data id is stored and stays unlinked`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const msg = { formattedData: chameleonUplink({}) };
    assert.equal(await rt.insert(msg), msg);
    assert.equal(snapshot(dbPath, 'SELECT id FROM chameleon_readings').length, 1);
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
    assert.ok(rt.warnings.some((w) => /stays unlinked/.test(w)), JSON.stringify(rt.warnings));
  });

  test(`${profile}: a cross-device link the database refuses keeps the diagnostic and reports the failure`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const otherDevice = await rt.deliver({ devEui: EUI_B, chameleonPayloadVersion: undefined, isChameleon: false });
    const otherId = otherDevice.formattedData.deviceDataId;
    assert.ok(Number.isSafeInteger(otherId));
    const msg = { formattedData: chameleonUplink({ deviceDataId: otherId }) };
    assert.equal(await rt.insert(msg), msg);
    assert.equal(snapshot(dbPath, `SELECT id FROM chameleon_readings WHERE deveui = '${EUI_A}'`).length, 1);
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
    assert.ok(rt.errors.some((e) => /Chameleon link failed/.test(e)), JSON.stringify(rt.errors));
  });

  test(`${profile}: a non-Chameleon LSN50 uplink writes no diagnostic and no link`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const out = await rt.deliver({ isChameleon: false });
    assert.ok(Number.isSafeInteger(out.formattedData.deviceDataId));
    assert.equal(snapshot(dbPath, 'SELECT id FROM chameleon_readings').length, 0);
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
  });

  test(`${profile}: a failed canonical write sends nothing downstream`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    assert.equal(await rt.deliver({ devEui: 'A8404100000000FF' }), null);
    assert.ok(rt.errors.some((e) => /LSN50 write failed/.test(e)), JSON.stringify(rt.errors));
    assert.equal(snapshot(dbPath, 'SELECT id FROM chameleon_readings').length, 0);
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
  });

  // Partial failures after a normal canonical write.
  test(`${profile}: a failed diagnostic insert keeps the canonical value, links nothing and sends no command`, async () => {
    const dbPath = seedFile({ sql: `CREATE TRIGGER test_refuse_diagnostic BEFORE INSERT ON chameleon_readings
      BEGIN SELECT RAISE(ABORT, 'injected diagnostic failure'); END;` });
    const rt = runtime(profile, dbPath);
    const out = await rt.deliver({ swt1: 80 });
    assert.ok(out && out.formattedData && out.formattedData.devEui === EUI_A, 'the message continues downstream');
    assert.deepEqual(snapshot(dbPath, 'SELECT deveui, swt_1 FROM device_data'), [{ deveui: EUI_A, swt_1: 80 }], 'canonical value retained');
    assert.equal(snapshot(dbPath, 'SELECT id FROM chameleon_readings').length, 0);
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
    assert.ok(rt.errors.some((e) => /Chameleon persistence failed: .*injected diagnostic failure/.test(e)), JSON.stringify(rt.errors));
    assertNoData(await schedule(profile, dbPath));
  });

  test(`${profile}: a refused same-device link keeps both rows, reports the failure and sends no command`, async () => {
    const dbPath = seedFile({ sql: `CREATE TRIGGER test_refuse_link BEFORE INSERT ON chameleon_reading_links
      BEGIN SELECT RAISE(ABORT, 'injected link failure'); END;` });
    const rt = runtime(profile, dbPath);
    const out = await rt.deliver({ swt1: 80 });
    assert.ok(out && out.formattedData && out.formattedData.devEui === EUI_A, 'the message continues downstream');
    assert.deepEqual(snapshot(dbPath, 'SELECT deveui, swt_1 FROM device_data'), [{ deveui: EUI_A, swt_1: 80 }], 'canonical value retained');
    assert.deepEqual(snapshot(dbPath, 'SELECT deveui, r1_ohm_comp FROM chameleon_readings'), [{ deveui: EUI_A, r1_ohm_comp: 1000 }], 'diagnostic retained');
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
    assert.ok(rt.errors.some((e) => /Chameleon link failed for reading \d+ and device_data \d+: .*injected link failure/.test(e)), JSON.stringify(rt.errors));
    assertNoData(await schedule(profile, dbPath));
  });

  // Isolation from other nodes' statements on the shared connection.
  test(`${profile}: a rollback by another node between queued writes cannot produce a wrong-event link`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const a = await rt.write({ formattedData: chameleonUplink({ swt1: 41, r1: 1001, fCnt: 8 }) });
    const b = await rt.write({ formattedData: chameleonUplink({ swt1: 42, r1: 1002, fCnt: 9 }) });
    assert.ok(a && b, 'both canonical rows committed');
    // Another node opens a manual transaction on the shared connection, as
    // calibration-persist does; A's diagnostic is queued while it is open; the
    // other node rolls back; B's diagnostic is queued after the rollback.
    await rt.facade.run('BEGIN IMMEDIATE');
    const pendingA = rt.insert(a);
    const rollback = rt.facade.run('ROLLBACK');
    const pendingB = rt.insert(b);
    await Promise.all([pendingA, rollback, pendingB]);
    const linked = snapshot(dbPath, LINKED_SQL);
    assert.equal(linked.length, 1, JSON.stringify(linked));
    assert.equal(linked[0].device_data_id, b.formattedData.deviceDataId, 'the only link belongs to uplink B');
    assert.equal(linked[0].swt_1, 42);
    assert.equal(linked[0].r1_ohm_comp, 1002, 'linked diagnostic is B\'s own');
    assert.deepEqual(snapshot(dbPath, 'SELECT r1_ohm_comp FROM chameleon_readings'), [{ r1_ohm_comp: 1002 }]);
    assert.ok(rt.errors.some((e) => /Chameleon persistence failed: .*transaction within a transaction/.test(e)), JSON.stringify(rt.errors));
    assert.equal(snapshot(dbPath, `SELECT COUNT(*) AS n FROM chameleon_reading_links WHERE device_data_id = ${Number(a.formattedData.deviceDataId)}`)[0].n, 0, 'canonical A stays unlinked');
  });

  test(`${profile}: a diagnostic refused during another node's transaction never ends that transaction`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const a = await rt.write({ formattedData: chameleonUplink({}) });
    await rt.facade.run('BEGIN IMMEDIATE');
    await rt.facade.run("INSERT INTO chameleon_calibration_misses (array_id, last_tried, reason) VALUES (?, '2026-10-28T00:00:00.000Z', 'not_found')", [ARRAY]);
    await rt.insert(a);
    // Rejects with "cannot commit - no transaction is active" if the node had rolled it back.
    await rt.facade.run('COMMIT');
    assert.equal(snapshot(dbPath, 'SELECT COUNT(*) AS n FROM chameleon_calibration_misses')[0].n, 1, 'the other node\'s write committed');
    assert.equal(snapshot(dbPath, 'SELECT id FROM chameleon_readings').length, 0, 'no diagnostic joined the other transaction');
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
    assert.ok(rt.errors.some((e) => /Chameleon persistence failed: .*transaction within a transaction/.test(e)), JSON.stringify(rt.errors));
  });

  test(`${profile}: SQLite reuses a rolled-back AUTOINCREMENT id (why the link shares the diagnostic transaction)`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const insertSql = 'INSERT INTO chameleon_readings (deveui, recorded_at) VALUES (?, ?) RETURNING id';
    await rt.facade.run('BEGIN IMMEDIATE');
    const first = await rt.facade.get(insertSql, [EUI_A, T0]);
    await rt.facade.run('ROLLBACK');
    const second = await rt.facade.get(insertSql, [EUI_A, T0]);
    assert.equal(second.id, first.id);
  });

  // Calibration backfill.
  test(`${profile}: backfill fills two same-timestamp linked rows from their own diagnostics, by id, as history corrections`, async () => {
    const dbPath = seedFile({ syncLinked: true, sql: storedRows([{ r1: 20000, r2: 30000 }, { r1: 100000, r2: 60000 }]) });
    const before = snapshot(dbPath, LINKED_SQL);
    assert.equal(before.length, 2);
    const appendsBefore = snapshot(dbPath, APPEND_EVENTS_SQL)[0].n;
    const rt = runtime(profile, dbPath);
    await rt.calibrate();
    const after = snapshot(dbPath, LINKED_SQL);
    assert.deepEqual(after.map((r) => [r.device_data_id, r.reading_id]), before.map((r) => [r.device_data_id, r.reading_id]), 'links unchanged');
    for (const row of after) {
      assert.equal(row.swt_1, row.r1_ohm_comp / 1000, 'channel 1 from the row\'s own diagnostic: ' + JSON.stringify(row));
      assert.equal(row.swt_2, row.r2_ohm_comp / 1000, 'channel 2 from the row\'s own diagnostic: ' + JSON.stringify(row));
      assert.equal(row.swt_3, null);
    }
    const corrections = snapshot(dbPath, "SELECT row_key FROM sync_history_dirty_keys WHERE table_name = 'device_data' AND change_kind = 'correction'").map((r) => r.row_key);
    for (const row of after) assert.ok(corrections.includes(`DEVICE_DATA|${GATEWAY}|${row.device_data_id}`), JSON.stringify(corrections));
    assert.equal(snapshot(dbPath, APPEND_EVENTS_SQL)[0].n, appendsBefore, 'no replacement append event');
    assert.deepEqual(rt.warnings.filter((w) => /calibration-/.test(w)), []);
    assertOpensAt(await schedule(profile, dbPath), 2, 60);
  });

  test(`${profile}: backfill fills an unlinked pre-link row by device and time, links nothing, and the scheduler still excludes it`, async () => {
    const dbPath = seedFile({ sql: storedRows([{ r1: 80000, r2: 30000, link: false }]) });
    const rt = runtime(profile, dbPath);
    await rt.calibrate();
    assert.deepEqual(snapshot(dbPath, 'SELECT swt_1, swt_2 FROM device_data'), [{ swt_1: 80, swt_2: 30 }], 'history value filled');
    assert.equal(snapshot(dbPath, 'SELECT * FROM chameleon_reading_links').length, 0);
    assertNoData(await schedule(profile, dbPath));
  });

  test(`${profile}: backfill never fills an unlinked row from a diagnostic linked to another row`, async () => {
    const dbPath = seedFile({ sql: storedRows([{ r1: 20000, r2: 30000 }, { diagnostic: false }]) });
    const rt = runtime(profile, dbPath);
    await rt.calibrate();
    assert.deepEqual(snapshot(dbPath, 'SELECT swt_1 FROM device_data ORDER BY id'), [{ swt_1: 20 }, { swt_1: null }]);
    const out = await schedule(profile, dbPath);
    assert.equal(out.row.n_points, 1, JSON.stringify(out.row));
    assert.equal(out.row.mean_kpa, 20);
  });

  test(`${profile}: uplinks stored before calibration are filled from their own linked diagnostics when it arrives`, async () => {
    const dbPath = seedFile();
    const rt = runtime(profile, dbPath);
    const pending = { swt1: null, swt2: null, calibrationStatus: 'pending' };
    await Promise.all([
      rt.deliver({ ...pending, r1: 20000, r2: 30000, fCnt: 8 }),
      rt.deliver({ ...pending, r1: 100000, r2: 60000, fCnt: 9 }),
    ]);
    assert.equal(snapshot(dbPath, 'SELECT * FROM device_data WHERE swt_1 IS NULL AND swt_2 IS NULL').length, 2, 'no SWT before calibration');
    await rt.calibrate();
    const linked = snapshot(dbPath, LINKED_SQL);
    assert.equal(linked.length, 2);
    for (const row of linked) {
      assert.equal(row.data_at, T0);
      assert.equal(row.swt_1, row.r1_ohm_comp / 1000, JSON.stringify(row));
      assert.equal(row.swt_2, row.r2_ohm_comp / 1000, JSON.stringify(row));
    }
    assertOpensAt(await schedule(profile, dbPath), 2, 60);
  });
}

test('both profiles ship the same ingest and calibration bodies', () => {
  for (const id of ['460e0bfd95f89e67', 'chameleon-readings-insert-fn', '51c0ae3799c97131', 'd20948dd9120a3d2']) {
    assert.equal(loadNode(id, profilePaths('bcm2709').flows).func, loadNode(id, profilePaths('bcm2712').flows).func, id);
  }
});
