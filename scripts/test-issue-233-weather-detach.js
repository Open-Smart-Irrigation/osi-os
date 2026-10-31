'use strict';
// Issue #233 Phase A: SENSECAP_S2120 selected-pair detach and trusted cloud UNCLAIM_DEVICE
// through the osi-irrigation-policy lifecycle owner, both maintained profiles. Cases follow
// the matrix in docs/superpowers/plans/issue-233-exact-plan.md.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const {
  executeFunction, facadeDb, loadNode, makeAuthHeader, moduleByName, profilePaths
} = require('./lib/scoped-access-harness');
const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'].map((name) => Object.assign({ name }, profilePaths(name)));
const DEVICE = '0011223344556677';
const GATEWAY = 'AABBCCDDEEFF0011';
const OTHER_GATEWAY = '0016C001F1000002';
const TRANSITION_GATEWAY = '0016C001F1000003';
const NONWEATHER = 'A840410000000002';
const Z1 = '00000000-0000-4000-8000-000000000001';
const Z2 = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000011';
const RESEARCHER = '00000000-0000-4000-8000-000000000012';
const VIEWER = '00000000-0000-4000-8000-000000000013';
const OTHER = '00000000-0000-4000-8000-000000000014';
const CURRENT_DAY = new Date().toISOString().slice(0, 10);
const SECRET = 'scoped-access-test-secret';
const ADAPTER = 'conditional-lifecycle-command-adapter';
const DEDUPE = 'command-dedupe-dispatch';
const GATE = 's2120-unclaim-gate';
const ACK_QUEUE = 'command-ack-queue-rest';

function policyFor(profile) {
  return require(path.join(profile.nodeRedModules, 'osi-irrigation-policy'));
}

function wiring(profile) {
  const mqttAck = loadNode('weather-zones-command-apply-fn', profile.flowsPath).wires[1][0];
  assert.equal(loadNode(mqttAck, profile.flowsPath).type, 'mqtt out');
  return { mqttAck, legacySql: loadNode(ADAPTER, profile.flowsPath).wires[0][0] };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue233-'));
  const file = path.join(dir, 'farming.db');
  const first = new DatabaseSync(file);
  first.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  first.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const users = [
    [1, 'admin1', ADMIN, 'admin'],
    [2, 'res1', RESEARCHER, 'researcher'],
    [3, 'view1', VIEWER, 'viewer'],
    [4, 'other1', OTHER, 'researcher']
  ];
  for (const row of users) first.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid,role) VALUES (?,?,?,?,?,?)'
  ).run(row[0], row[1], 'h', '2026-01-01T00:00:00Z', row[2], row[3]);
  first.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui) VALUES (?,?,?,?,?)'
  ).run(1, 'Z One', 1, Z1, GATEWAY);
  first.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui) VALUES (?,?,?,?,?)'
  ).run(2, 'Z Two', 4, Z2, GATEWAY);
  first.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,sync_version,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(DEVICE, 'Weather', 'SENSECAP_S2120', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 7, GATEWAY);
  first.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,sync_version,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?)'
  ).run(NONWEATHER, 'Other', 'DRAGINO_LSN50', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 2, GATEWAY);
  for (const zoneId of [1, 2]) first.prepare(
    'INSERT INTO weather_station_zones(deveui,zone_id) VALUES (?,?)'
  ).run(DEVICE, zoneId);
  first.prepare('INSERT INTO device_data(deveui,recorded_at) VALUES (?,?)').run(DEVICE, '2026-01-01T12:00:00Z');
  first.prepare(
    'INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at,rain_selected_deveui,sync_version) VALUES (?,?,?,?,?,?,?,?)'
  ).run(1, '2026-01-01', 2.5, 0, 'sensecap_s2120', '2026-01-02T00:00:00Z', DEVICE, 1);
  first.prepare(
    'INSERT INTO zone_rain_source(zone_id,selected_deveui,selected_at,selected_by_uuid,updated_at) VALUES (?,?,?,?,?)'
  ).run(1, DEVICE, '2026-01-01T00:00:00Z', ADMIN, '2026-01-01T00:00:00Z');
  first.prepare(
    'INSERT INTO weather_station_zone_state(deveui,sync_version,last_applied_at) VALUES (?,?,NULL)'
  ).run(DEVICE, 3);
  for (const [n, uuid] of [[1, Z1], [2, Z2]]) first.prepare(
    'INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at) VALUES (?,?,?,?)'
  ).run('00000000-0000-4000-8000-00000000002' + n, RESEARCHER, uuid, '2026-01-01T00:00:00Z');
  first.prepare('UPDATE users SET server_url=?,server_sync_token=? WHERE id=1')
    .run('https://example.invalid', 'fixture-sync-token');
  first.prepare(
    'INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES (?,?,?,?,?)'
  ).run('cloud', 1, 'https://example.invalid', GATEWAY, '2026-01-01T00:00:00Z');
  const second = new DatabaseSync(file);
  second.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  for (const profile of PROFILES) {
    require(path.join(profile.nodeRedModules, 'osi-scope-helper'))._resetForTests();
  }
  return {
    first, second, file,
    close() {
      second.close();
      first.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// Production osi-db-helper semantics: BEGIN IMMEDIATE, and run() resolves undefined, so no
// code under test can read .changes. beforeBegin runs once, before the first BEGIN.
function productionFacade(raw, beforeBegin) {
  const f = facadeDb(raw);
  let pending = beforeBegin || null;
  return Object.assign({}, f, {
    run(sql, params, callback) {
      if (typeof params === 'function' || typeof callback === 'function') return f.run(sql, params, callback);
      return f.run(sql, params).then(() => undefined);
    },
    async transaction(fn) {
      if (pending) {
        const hook = pending;
        pending = null;
        await hook();
      }
      raw.exec('BEGIN IMMEDIATE');
      const tx = {
        get: (sql, params) => f.get(sql, params),
        all: (sql, params) => f.all(sql, params),
        run: async (sql, params) => {
          await f.run(sql, params);
          return undefined;
        }
      };
      try {
        const answer = await fn(tx);
        raw.exec('COMMIT');
        return answer;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    }
  });
}

function libsFor(profile, facade, policy) {
  const Database = function Database() { return facade; };
  const osiLibModules = { 'osi-db-helper': { Database } };
  if (policy) osiLibModules['osi-irrigation-policy'] = policy;
  return { nodeRedModules: profile.nodeRedModules, osiLibModules, libOverrides: { osiDb: { Database } } };
}

// Follows real output indexes across wires. Stops at http response, mqtt out, link out and
// the legacy SQL builder, and records every emission. With options.loader, every
// osiLib.require in the chain is recorded with the node that asked, and the one module named
// by loader.fault answers {ok:false} on every request; all other names resolve as the harness
// resolves them.
async function traverse(profile, startId, msg, raw, options = {}) {
  const facade = productionFacade(raw, options.beforeBegin);
  const libs = libsFor(profile, facade, options.policy);
  const ids = wiring(profile);
  let current = null;
  if (options.loader) {
    const loader = options.loader;
    libs.libOverrides.osiLib = {
      require(name) {
        loader.requests.push({ node: current, name });
        if (loader.fault && loader.fault.name === name) return { ok: false, error: loader.fault.error };
        const value = libs.osiLibModules[name] || moduleByName(name, profile.nodeRedModules);
        return value ? { ok: true, value } : { ok: false, error: 'unregistered in harness: ' + name };
      }
    };
  }
  const out = { responses: [], mqtt: [], legacy: [], visited: [], trace: [], errors: [], warnings: [] };
  let flowState = options.flowState || {};
  const env = Object.assign({
    OSI_SCOPED_ACCESS: options.scoped ? '1' : '0',
    DEVICE_EUI: GATEWAY,
    AUTH_TOKEN_SECRET: SECRET,
    DEVICE_EUI_CONFIDENCE: 'active'
  }, options.env || {});
  async function visit(id, value) {
    if (value == null) return;
    out.visited.push(id);
    if (id === ids.legacySql) {
      out.legacy.push(value);
      return;
    }
    const node = loadNode(id, profile.flowsPath);
    if (node.type === 'http response') {
      out.responses.push(value);
      return;
    }
    if (node.type === 'mqtt out') {
      out.mqtt.push(value);
      return;
    }
    if (node.type === 'link out') return;
    let output;
    if (node.type === 'sqlite') {
      value.payload = raw.prepare(value.topic).all();
      output = [value];
    } else if (node.type === 'function') {
      current = id;
      const call = await executeFunction(node, Object.assign({
        msg: value, db: raw, flowState, env, globals: options.globals || {}
      }, libs));
      out.errors.push(...call.errors.map((error) => id + ': ' + error));
      out.warnings.push(...call.warnings.map((warning) => id + ': ' + warning));
      flowState = call.flowState;
      output = Array.isArray(call.result) ? call.result : [call.result];
    } else {
      output = [value];
    }
    for (let slot = 0; slot < output.length; slot++) {
      const emitted = Array.isArray(output[slot]) ? output[slot] : [output[slot]];
      for (const item of emitted) {
        if (item == null) continue;
        out.trace.push({ id, slot, value: item });
        for (const child of node.wires[slot] || []) await visit(child, item);
      }
    }
  }
  await visit(startId, msg);
  out.flowState = flowState;
  return out;
}

function assertOneResponse(result, status, label) {
  assert.equal(result.responses.length, 1, label + ': exactly one HTTP response');
  assert.equal(result.responses[0].statusCode, status, label);
}

function mutantPolicy(profile, edit) {
  const filename = path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'lifecycle.js');
  const original = fs.readFileSync(filename, 'utf8');
  const changed = edit(original);
  assert.notEqual(changed, original);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(changed, filename);
  return Object.assign({}, policyFor(profile), m.exports);
}

// Routes mutants (M4, M5): an in-memory copy of the profile's routes.js. Every call that goes
// through the returned policy, including the gate node and the adapter, reaches the mutant.
function mutantRoutesPolicy(profile, edit) {
  const filename = path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'routes.js');
  const original = fs.readFileSync(filename, 'utf8');
  const changed = edit(original);
  assert.notEqual(changed, original);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(changed, filename);
  return Object.assign({}, policyFor(profile), { routes: m.exports });
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2);
  return source.replace(before, after);
}

const CLEANUP_LINE = "    if (operation === 'device_unclaim' && input[CLOUD_S2120_UNCLAIM] === true) await clearCloudS2120WeatherLinksTx(tx, current, at, input.gatewayDeviceEui);";
const DEVICE_UPDATE_LINE = '    await tx.run(`UPDATE devices SET ${fields}, updated_at=?, sync_version=? WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL`, params);';
const MUTATIONS = [
  (s) => replaceOnce(s,
    "'DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=?'",
    "'UPDATE weather_station_zones SET zone_id=zone_id WHERE deveui=? AND zone_id=?'"),
  (s) => replaceOnce(s, 'VALUES (?,0,NULL,?)', 'VALUES (?,1,NULL,?)'),
  (s) => replaceOnce(s, CLEANUP_LINE + '\n' + DEVICE_UPDATE_LINE, DEVICE_UPDATE_LINE + '\n' + CLEANUP_LINE),
  (s) => replaceOnce(s, 'prior.binding_hash !== hash', 'false')
];
const LEASE_LINE = '  envelope.leasedToGateway = command.leasedToGateway == null ? null : command.leasedToGateway;\n';
const GATE_ROUTE_LINE = '    return identity.station ? [null, msg] : [msg, null];';
const ROUTE_MUTATIONS = [
  (s) => replaceOnce(s, LEASE_LINE, ''),
  (s) => replaceOnce(s, GATE_ROUTE_LINE, '    return [msg, null];')
];
// Each mutant counts as killed only by an AssertionError whose message holds every listed text.
const KILLS = [
  ['MUTANT_PAIR_DELETE'],
  ['MUTANT_FIRST_STATE'],
  ['MUTANT_EVENT_ORDER'],
  ['MUTANT_BINDING'],
  ['MUTANT_LEASE', 'lease_gateway_unavailable_or_mismatch'],
  ['MUTANT_GATE_ROUTE', DEDUPE + ': Command dedupe failed closed: WATERMARK command replay binding conflicts with the terminal ledger']
];

function auth(id, username) {
  return makeAuthHeader({ userId: id, username, secret: SECRET });
}

const D = [
  { id: 'D01', scoped: true, zone: 1, actor: [1, 'admin1'], status: 200 },
  { id: 'D02', scoped: true, zone: 2, actor: [2, 'res1'], status: 200 },
  { id: 'D03', scoped: false, zone: 1, actor: [1, 'admin1'], status: 200 },
  { id: 'D04', scoped: false, zone: 2, actor: [1, 'admin1'], status: 200 },
  { id: 'D05', scoped: true, zone: 1, actor: [1, 'admin1'], onlyOne: true, firstState: true, status: 200 },
  { id: 'D06', scoped: false, zone: 1, actor: [1, 'admin1'], onlyOne: true, status: 200 },
  { id: 'D07', scoped: true, zone: 2, actor: [2, 'res1'], crossOwner: true, status: 200 },
  { id: 'D08', scoped: false, zone: 2, actor: [1, 'admin1'], crossOwner: true, status: 200 },
  { id: 'D09', scoped: true, zone: 2, actor: [2, 'res1'], revoke: true, status: 404 },
  { id: 'D10', scoped: true, zone: 1, actor: [3, 'view1'], status: 403 },
  { id: 'D11', scoped: false, zone: 2, actor: [2, 'res1'], status: 404 },
  { id: 'D12', scoped: true, zone: 1, actor: [1, 'admin1'], primaryOnly: true, status: 200 }
];

function deviceState(raw) {
  return raw.prepare('SELECT user_id,irrigation_zone_id,sync_version FROM devices WHERE deveui=?').get(DEVICE);
}

function assignments(raw) {
  return raw.prepare('SELECT zone_id FROM weather_station_zones WHERE deveui=? ORDER BY zone_id')
    .all(DEVICE).map((row) => row.zone_id);
}

function weatherVersion(raw) {
  const row = raw.prepare('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?').get(DEVICE);
  return row ? row.sync_version : null;
}

function weatherEvents(raw) {
  return raw.prepare(
    "SELECT payload_json FROM sync_outbox WHERE aggregate_key=? AND op='WEATHER_STATION_ZONES_REPLACED' ORDER BY rowid"
  ).all(DEVICE).map((row) => JSON.parse(row.payload_json));
}

function historyRows(raw) {
  const read = (sql) => raw.prepare(sql).all().map((row) => ({ ...row }));
  return {
    days: read('SELECT * FROM zone_daily_environment ORDER BY zone_id,date'),
    data: read('SELECT * FROM device_data ORDER BY id'),
    preference: read('SELECT * FROM zone_rain_source ORDER BY zone_id')
  };
}

async function currentCandidates(profile, raw, zoneId) {
  const rain = require(path.join(profile.nodeRedModules, 'osi-rain/index.js'));
  const selected = await rain.selectZoneGauge(productionFacade(raw), zoneId, CURRENT_DAY);
  return selected.candidates;
}

async function detachCase(profile, spec, policy) {
  const f = fixture();
  try {
    if (spec.onlyOne) f.first.prepare('DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=2').run(DEVICE);
    if (spec.primaryOnly) f.first.prepare('DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=1').run(DEVICE);
    if (spec.firstState) f.first.prepare('DELETE FROM weather_station_zone_state WHERE deveui=?').run(DEVICE);
    if (spec.revoke) f.first.prepare(
      'UPDATE user_zone_assignments SET deleted_at=? WHERE user_uuid=? AND zone_uuid=?'
    ).run('2026-01-02T00:00:00Z', RESEARCHER, Z2);
    const before = assignments(f.first);
    const historical = historyRows(f.first);
    const primaryBefore = deviceState(f.first).irrigation_zone_id;
    const currentBefore = [
      await currentCandidates(profile, f.first, 1),
      await currentCandidates(profile, f.first, 2)
    ];
    assert.deepEqual(currentBefore, [1, 2].map((zoneId) =>
      before.includes(zoneId) || primaryBefore === zoneId ? [DEVICE] : []));
    const msg = {
      req: {
        method: 'DELETE',
        headers: { authorization: auth(...spec.actor) },
        params: { id: String(spec.zone), deveui: DEVICE }
      },
      payload: {}
    };
    const result = await traverse(profile, 'scoped-device-unassign-router', msg, f.first, { scoped: spec.scoped, policy });
    if (policy && result.responses.length === 1 && result.responses[0].statusCode === 500 &&
        ['D01', 'D05'].includes(spec.id)) {
      const diagnostic = JSON.stringify(result.responses[0].payload) + ' ' + result.errors.join('|');
      assert.match(diagnostic, /detach_postcondition_failed|weather_outbox_postcondition_failed/);
      assert.deepEqual(assignments(f.first), before, 'postcondition failure rolls back the mutant');
      assert.fail(spec.id === 'D01' ? 'MUTANT_PAIR_DELETE' : 'MUTANT_FIRST_STATE');
    }
    assertOneResponse(result, spec.status, spec.id + (spec.id === 'D04' || spec.id === 'D08'
      ? ' flag-off secondary weather pair detach (base defect: lifecycle.js:454-455 answers 404 for a pair that is not the primary)'
      : ' route status'));
    const changed = spec.status === 200;
    const after = assignments(f.first);
    const expected = changed ? before.filter((id) => id !== spec.zone) : before;
    assert.deepEqual(after, expected, 'selected weather pair removed, other pairs kept (MUTANT_PAIR_DELETE)');
    assert.equal(f.first.prepare('SELECT COUNT(*) AS n FROM device_data WHERE deveui=?').get(DEVICE).n, 1);
    const state = deviceState(f.first);
    const selectedPrimary = spec.zone === 1;
    assert.equal(state.irrigation_zone_id, changed && selectedPrimary ? null : 1);
    assert.equal(state.sync_version, changed && selectedPrimary ? 8 : 7);
    if (changed) assert.equal(result.responses[0].payload.irrigation_zone_id, state.irrigation_zone_id,
      'the response reports the persisted primary zone');
    for (const zoneId of [1, 2]) {
      const expectedLive = after.includes(zoneId) || state.irrigation_zone_id === zoneId ? [DEVICE] : [];
      assert.deepEqual(await currentCandidates(profile, f.first, zoneId), expectedLive, 'osi-rain current-window zone ' + zoneId);
    }
    assert.deepEqual(historyRows(f.first), historical, 'detach keeps historical rain, telemetry and preference rows');
    const pairRemoved = changed && before.includes(spec.zone);
    assert.equal(weatherVersion(f.first),
      pairRemoved ? (spec.firstState ? 1 : 4) : (spec.firstState ? null : 3), 'MUTANT_FIRST_STATE');
    const events = weatherEvents(f.first);
    assert.equal(events.length, pairRemoved ? 1 : 0);
    if (pairRemoved) assert.deepEqual(events[0].zone_uuids, expected.map((id) => id === 1 ? Z1 : Z2));
    if (spec.id === 'D01' && !policy) {
      const repeated = await traverse(profile, 'scoped-device-unassign-router', {
        req: { method: 'DELETE', headers: { authorization: auth(1, 'admin1') }, params: { id: '1', deveui: DEVICE } },
        payload: {}
      }, f.first, { scoped: true });
      assertOneResponse(repeated, 404, 'D01 repeated detach');
      assert.equal(weatherEvents(f.first).length, 1);
    }
  } finally {
    f.close();
  }
}

async function unlinkedDetachCase(profile) {
  const f = fixture();
  try {
    f.first.prepare("UPDATE sync_link_state SET linked=0 WHERE peer_node='cloud'").run();
    const result = await traverse(profile, 'scoped-device-unassign-router', {
      req: { method: 'DELETE', headers: { authorization: auth(1, 'admin1') }, params: { id: '2', deveui: DEVICE } },
      payload: {}
    }, f.first, { scoped: false, env: { DEVICE_EUI: '' } });
    assertOneResponse(result, 200, 'unlinked flag-off detach');
    assert.deepEqual(assignments(f.first), [1]);
    assert.equal(weatherVersion(f.first), 4);
    assert.equal(weatherEvents(f.first).length, 0);
  } finally {
    f.close();
  }
}

function command(id = 123, target = 8) {
  return {
    commandId: id,
    commandType: 'UNCLAIM_DEVICE',
    eventUuid: '00000000-0000-4000-8000-000000000031',
    aggregateType: 'DEVICE',
    aggregateKey: DEVICE,
    appliedSyncVersion: target,
    effectKey: null,
    leasedToGateway: GATEWAY,
    payload: { deviceEui: DEVICE, gatewayDeviceEui: GATEWAY, syncVersion: target, commandType: 'UNCLAIM_DEVICE' }
  };
}

async function cloudCall(profile, f, issued, opts = {}) {
  const run = await traverse(profile, 'sync-pending-split', { statusCode: 200, payload: { commands: [issued] } }, f.first, {
    scoped: false,
    policy: opts.policy,
    beforeBegin: opts.beforeBegin,
    loader: opts.loader,
    env: opts.runtimeGatewayEui === undefined ? {} : { DEVICE_EUI: opts.runtimeGatewayEui }
  });
  assert.ok(require.cache[path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'lifecycle.js')],
    profile.name + ' loads its own lifecycle owner');
  assert.ok(run.mqtt.length <= 1, 'at most one MQTT ACK per delivery');
  const split = run.trace.find((item) => item.id === 'sync-pending-split' && item.slot === 0);
  return Object.assign(run, {
    splitMessage: split ? split.value : null,
    gate: run.trace.filter((item) => item.id === GATE),
    dedupe: run.trace.filter((item) => item.id === DEDUPE),
    adapter: run.trace.filter((item) => item.id === ADAPTER)
  });
}

function ackFrom(call) {
  return call.mqtt.length ? JSON.parse(call.mqtt[0].payload) : null;
}

function terminalSnapshot(raw) {
  const rows = (sql) => raw.prepare(sql).all().map((row) => ({ ...row }));
  return {
    devices: rows('SELECT * FROM devices ORDER BY deveui'),
    zones: rows('SELECT * FROM irrigation_zones ORDER BY id'),
    joins: rows('SELECT * FROM weather_station_zones ORDER BY deveui,zone_id'),
    weatherState: rows('SELECT * FROM weather_station_zone_state ORDER BY deveui'),
    history: historyRows(raw),
    outbox: rows('SELECT * FROM sync_outbox ORDER BY rowid'),
    ledger: rows('SELECT * FROM applied_commands ORDER BY command_id'),
    restAck: rows('SELECT * FROM command_ack_outbox ORDER BY id')
  };
}

function ackRows(raw) {
  return raw.prepare('SELECT payload_json FROM command_ack_outbox WHERE delivered_at IS NULL ORDER BY id')
    .all().map((row) => row.payload_json);
}

async function batchTieCase(profile, earlierCount) {
  const f = fixture();
  try {
    const forced = loadNode('sync-force-build', profile.flowsPath);
    assert.ok(forced.func.includes('ORDER BY occurred_at ASC, rowid ASC LIMIT 100'));
    const applied = await cloudCall(profile, f, command());
    assert.equal(ackFrom(applied).result, 'APPLIED');
    f.first.prepare(
      "UPDATE sync_outbox SET occurred_at=? WHERE aggregate_key=? AND op IN ('WEATHER_STATION_ZONES_REPLACED','DEVICE_UNCLAIMED')"
    ).run('2026-01-02T00:00:00.000Z', DEVICE);
    for (let n = 0; n < earlierCount; n++) f.first.prepare(
      'INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui) ' +
      "SELECT ?,aggregate_type,aggregate_key,op,payload_json,sync_version,?,gateway_device_eui FROM sync_outbox WHERE op='DEVICE_UNCLAIMED' AND aggregate_key=? LIMIT 1"
    ).run('00000000-0000-4000-8000-' + String(n + 1).padStart(12, '0'), '2026-01-01T00:00:00.000Z', DEVICE);
    async function build() {
      const libs = libsFor(profile, productionFacade(f.first));
      const result = await executeFunction(loadNode('sync-outbox-build', profile.flowsPath), Object.assign({
        msg: {},
        db: f.first,
        globals: { fs: { existsSync: () => false } },
        env: { DEVICE_EUI: GATEWAY, DEVICE_EUI_CONFIDENCE: 'active', DEVICE_EUI_SOURCE: 'test' },
        flowState: { outboxFlushInFlightAt: 0, sync_state: {} }
      }, libs));
      assert.deepEqual(result.errors, []);
      assert.ok(result.result && result.result.payload);
      return result.result.payload.events;
    }
    const firstBatch = await build();
    assert.equal(firstBatch.length, 100);
    const weatherIndex = firstBatch.findIndex((event) => event.op === 'WEATHER_STATION_ZONES_REPLACED');
    const deviceIndex = firstBatch.findIndex((event) =>
      event.op === 'DEVICE_UNCLAIMED' && event.occurredAt === '2026-01-02T00:00:00.000Z');
    assert.equal(weatherIndex, earlierCount);
    assert.equal(deviceIndex, earlierCount === 98 ? 99 : -1);
    assert.deepEqual(firstBatch[weatherIndex].payload.zone_uuids, []);
    const firstIds = new Set(firstBatch.map((event) => event.eventUuid));
    assert.equal(firstIds.size, 100);
    if (earlierCount === 99) {
      for (const event of firstBatch) f.first.prepare('UPDATE sync_outbox SET delivered_at=? WHERE event_uuid=?')
        .run('2026-01-03T00:00:00.000Z', event.eventUuid);
      const secondBatch = await build();
      assert.equal(secondBatch.length, 1);
      assert.equal(secondBatch[0].op, 'DEVICE_UNCLAIMED');
      assert.ok(!firstIds.has(secondBatch[0].eventUuid));
    }
    f.first.prepare(
      'UPDATE sync_outbox SET delivered_at=NULL,rejected_at=NULL,retry_count=0,last_retryable_failure_at=NULL WHERE aggregate_key=?'
    ).run(DEVICE);
    f.first.prepare("UPDATE users SET auth_mode='server',cloud_user_id=7 WHERE id=1").run();
    const forceRequests = [];
    const cloud = { requestJsonIpv4: async (request) => {
      if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'fixture-sync-token' } };
      if (request.url.endsWith('/api/v1/sync/edge/bootstrap')) return { statusCode: 200, payload: { applied: 1, skipped: 0 } };
      if (request.url.endsWith('/api/v1/sync/edge/events')) {
        forceRequests.push(request.payload);
        return { statusCode: 200, payload: { results: request.payload.events.map((event) => ({ eventUuid: event.eventUuid, status: 'APPLIED' })) } };
      }
      if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [] } };
      throw new Error('unexpected force request ' + request.url);
    } };
    async function forceOnce() {
      const libs = libsFor(profile, productionFacade(f.first));
      const msg = { _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'admin1' };
      const result = await executeFunction(forced, Object.assign({
        msg,
        db: f.first,
        env: {
          DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active',
          OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: SECRET
        },
        globals: { fs: { existsSync: () => false } }
      }, libs, { libOverrides: Object.assign({}, libs.libOverrides, { osiCloudHttp: cloud }) }));
      assert.deepEqual(result.errors, []);
      assert.ok(msg.statusCode === 200 || msg.statusCode === 207, JSON.stringify(msg.payload));
      return result;
    }
    await forceOnce();
    assert.equal(forceRequests.length, 1);
    const forceFirst = forceRequests[0].events;
    assert.equal(forceFirst.length, 100);
    const forceWeather = forceFirst.findIndex((event) => event.op === 'WEATHER_STATION_ZONES_REPLACED');
    const forceDevice = forceFirst.findIndex((event) =>
      event.op === 'DEVICE_UNCLAIMED' && event.occurredAt === '2026-01-02T00:00:00.000Z');
    assert.equal(forceWeather, earlierCount);
    assert.equal(forceDevice, earlierCount === 98 ? 99 : -1);
    assert.deepEqual(forceFirst[forceWeather].payload.zone_uuids, []);
    const forceIds = new Set(forceFirst.map((event) => event.eventUuid));
    assert.equal(forceIds.size, 100);
    if (earlierCount === 99) {
      await forceOnce();
      assert.equal(forceRequests.length, 2);
      const forceSecond = forceRequests[1].events;
      assert.equal(forceSecond.length, 1);
      assert.equal(forceSecond[0].op, 'DEVICE_UNCLAIMED');
      assert.ok(!forceIds.has(forceSecond[0].eventUuid));
    }
  } finally {
    f.close();
  }
}

// Issue #233: replaces the static force-sync lease text check. A cloud S2120 UNCLAIM_DEVICE
// delivered by force sync carries its lease only beside the envelope; the gate adds it, and the
// owner applies the unclaim.
async function forceDeliveryCase(profile) {
  const f = fixture();
  try {
    f.first.prepare("UPDATE users SET auth_mode='server',cloud_user_id=7 WHERE id=1").run();
    const issued = command();
    const cloud = { requestJsonIpv4: async (request) => {
      if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'fixture-sync-token' } };
      if (request.url.endsWith('/api/v1/sync/edge/bootstrap')) return { statusCode: 200, payload: { applied: 1, skipped: 0 } };
      if (request.url.endsWith('/api/v1/sync/edge/events')) {
        return { statusCode: 200, payload: { results: request.payload.events.map((event) => ({ eventUuid: event.eventUuid, status: 'APPLIED' })) } };
      }
      if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [issued] } };
      throw new Error('unexpected force request ' + request.url);
    } };
    const libs = libsFor(profile, productionFacade(f.first));
    const msg = { _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'admin1' };
    const forced = await executeFunction(loadNode('sync-force-build', profile.flowsPath), Object.assign({
      msg,
      db: f.first,
      env: {
        DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active',
        OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: SECRET
      },
      globals: { fs: { existsSync: () => false } }
    }, libs, { libOverrides: Object.assign({}, libs.libOverrides, { osiCloudHttp: cloud }) }));
    assert.deepEqual(forced.errors, []);
    const queued = Array.isArray(forced.result) ? forced.result[1] : null;
    assert.ok(Array.isArray(queued) && queued.length === 1, 'force sync queues the one pending command');
    assert.equal(queued[0].payload.leasedToGateway, GATEWAY);
    assert.equal(queued[0].payload._pendingCommandEnvelope.leasedToGateway, undefined,
      'force sync leaves the envelope lease to the S2120 unclaim gate');
    const run = await traverse(profile, 'reject-indefinite-open', queued[0], f.first, { scoped: false });
    const gate = run.trace.filter((item) => item.id === GATE);
    assert.ok(gate.length === 1 && gate[0].slot === 1, 'the gate sends the force-delivered S2120 unclaim to its owner');
    assert.equal(gate[0].value.payload._pendingCommandEnvelope.leasedToGateway, GATEWAY);
    assert.equal(run.trace.filter((item) => item.id === DEDUPE).length, 0);
    const ack = ackFrom(run);
    assert.ok(ack, 'the force-delivered unclaim publishes one terminal ACK');
    assert.equal(ack.result, 'APPLIED');
    assert.deepEqual(assignments(f.first), [], 'the force-delivered unclaim removes every weather link');
  } finally {
    f.close();
  }
}

const EXPECTED = {
  C01: ['APPLIED', null, false],
  C02: ['CONFLICT', 'stale_sync_version', false],
  C03: ['APPLIED', null, true],
  C04: ['CONFLICT', 'equal_version_postcondition_failed', false],
  C05: ['CONFLICT', 'version_gap', false],
  C06: ['REJECTED_PERMANENT', 'invalid_version', false],
  C07: ['REJECTED_PERMANENT', 'malformed_command', false],
  C11: ['REJECTED_PERMANENT', 'malformed_command', false],
  C12: ['REJECTED_PERMANENT', 'malformed_command', false]
};

async function cloudCase(profile, id, policy) {
  const f = fixture();
  try {
    const issued = command();
    if (id === 'C02') issued.payload.syncVersion = issued.appliedSyncVersion = 6;
    if (id === 'C03' || id === 'C04') {
      issued.payload.syncVersion = issued.appliedSyncVersion = 7;
      f.first.prepare('UPDATE devices SET user_id=NULL,irrigation_zone_id=NULL WHERE deveui=?').run(DEVICE);
      if (id === 'C03') f.first.prepare('DELETE FROM weather_station_zones WHERE deveui=?').run(DEVICE);
    }
    if (id === 'C05') issued.payload.syncVersion = issued.appliedSyncVersion = 9;
    if (id === 'C06') issued.payload.syncVersion = issued.appliedSyncVersion = Number.MAX_SAFE_INTEGER + 1;
    if (id === 'C07') issued.payload.unexpected = true;
    if (id === 'C08') f.first.prepare("UPDATE devices SET type_id='DRAGINO_LSN50' WHERE deveui=?").run(DEVICE);
    if (id === 'C09') issued.commandId = '123';
    if (id === 'C10') issued.leasedToGateway = null;
    if (id === 'C11') issued.aggregateKey = NONWEATHER;
    if (id === 'C12') issued.aggregateKey = null;
    const before = { device: deviceState(f.first), links: assignments(f.first) };
    const beforeTerminal = terminalSnapshot(f.first);
    const call = await cloudCall(profile, f, issued, { policy });
    const ack = ackFrom(call);
    const sent = (slot) => call.adapter.some((item) => item.slot === slot);
    if (id === 'C08') {
      assert.equal(call.dedupe.length, 1);
      assert.equal(call.dedupe[0].slot, 0);
      assert.strictEqual(call.dedupe[0].value, call.splitMessage, 'C08 generic dedupe passes the identical split message on');
      assert.ok(call.gate.length === 1 && call.gate[0].slot === 0 && call.gate[0].value === call.splitMessage,
        'C08 the gate passes a non-S2120 unclaim on to the generic replay check unchanged');
      assert.equal(call.splitMessage.payload._pendingCommandEnvelope.leasedToGateway, GATEWAY,
        'C08 the gate adds the trusted lease to every cloud unclaim envelope');
      assert.ok(sent(1) && !sent(2), 'C08 non-S2120 unclaim keeps the generic owner path and its ACK queue');
      assert.ok(call.visited.includes(ACK_QUEUE));
      assert.equal(call.legacy.length, 0);
      assert.ok(ack);
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.valveCleanup.outcome, 'not_applicable');
      assert.equal(deviceState(f.first).user_id, null, 'the unchanged generic unclaim applied to the non-weather device');
      const afterTerminal = terminalSnapshot(f.first);
      assert.deepEqual(afterTerminal.joins, beforeTerminal.joins, 'C08 non-S2120 unclaim gains no weather cleanup');
      assert.deepEqual(afterTerminal.weatherState, beforeTerminal.weatherState);
      assert.equal(weatherEvents(f.first).length, 0);
      const ledger = f.first.prepare('SELECT originator, binding_hash FROM applied_commands WHERE command_id=?').get('123');
      assert.equal(ledger.originator, 'edge');
      assert.equal(ledger.binding_hash, null);
    } else if (id === 'C09' || id === 'C10') {
      const assertHeld = (out, reason) => {
        assert.equal(ackFrom(out), null, reason + ': no ACK');
        assert.equal(out.legacy.length, 0, reason + ': never reaches legacy SQL');
        assert.ok(!out.visited.includes(ACK_QUEUE), reason + ': generic ACK queue untouched');
        assert.ok(out.gate.length === 1 && out.gate[0].slot === 1 && out.dedupe.length === 0,
          reason + ': the gate sends the S2120 unclaim past the generic replay check to its owner');
        assert.equal(out.adapter.length, 0, reason + ': the adapter emits nothing');
        assert.ok(out.warnings.some((warning) => warning.includes('S2120 unclaim held') && warning.includes(reason)), reason);
        assert.deepEqual(terminalSnapshot(f.first), beforeTerminal, reason + ': no canonical, ledger or outbox row changes');
      };
      assertHeld(call, id === 'C09' ? 'invalid_command_id' : 'lease_gateway_unavailable_or_mismatch');
      if (id === 'C10') {
        for (const variant of [
          { lease: '' },
          { lease: OTHER_GATEWAY },
          { lease: GATEWAY, runtime: TRANSITION_GATEWAY }
        ]) {
          issued.leasedToGateway = variant.lease;
          assertHeld(await cloudCall(profile, f, issued, { policy, runtimeGatewayEui: variant.runtime }),
            'lease_gateway_unavailable_or_mismatch');
        }
        issued.leasedToGateway = GATEWAY;
        for (const [sql, reason] of [
          ["UPDATE sync_link_state SET gateway_device_eui='" + TRANSITION_GATEWAY + "' WHERE peer_node='cloud'", 'link_gateway_transition'],
          ["UPDATE sync_link_state SET gateway_device_eui='" + GATEWAY + "', link_attempt_json='{\"attempt\":\"fixture\"}' WHERE peer_node='cloud'", 'link_in_progress'],
          ["UPDATE sync_link_state SET link_attempt_json=NULL, linked=0 WHERE peer_node='cloud'", 'link_inactive']
        ]) {
          f.first.exec(sql);
          assertHeld(await cloudCall(profile, f, issued, { policy }), reason);
        }
      }
    } else {
      const held = call.warnings.find((warning) => warning.includes('S2120 unclaim held'));
      assert.equal(held, undefined,
        id + ': the owner decides a trusted, leased S2120 unclaim instead of holding it (MUTANT_LEASE): ' + held);
      if (id === 'C01' && !ack && policy) {
        assert.match(call.errors.join('|'), /unclaim_outbox_postcondition_failed/);
        assert.fail('MUTANT_EVENT_ORDER');
      }
      if (id === 'C01') {
        assert.deepEqual(assignments(f.first), [],
          'cloud S2120 unclaim removes every weather link (base defect: lifecycle.js:521-528 writes only the device row)');
      }
      const [result, reasonCode, duplicate] = EXPECTED[id];
      assert.ok(ack, id + ' publishes one terminal ACK');
      assert.equal(ack.result, result);
      assert.equal(ack.reasonCode, reasonCode);
      assert.equal(ack.duplicate, duplicate);
      assert.equal(ack.status, result === 'APPLIED' ? 'ACKED' : (result === 'CONFLICT' ? 'CONFLICT' : 'NACKED'));
      assert.equal(ack.payloadHash, null);
      assert.equal(ack.gatewayDeviceEui, GATEWAY);
      assert.equal(ack.valveCleanup.outcome, result === 'APPLIED' ? 'not_applicable' : 'not_attempted');
      assert.ok(call.gate.length === 1 && call.gate[0].slot === 1 && call.dedupe.length === 0,
        id + ': the gate sends the S2120 unclaim past the generic replay check to its owner');
      assert.ok(sent(2) && !sent(1) && !sent(0), id + ': the adapter answers on its S2120 output only');
      assert.ok(!call.visited.includes(ACK_QUEUE), id + ': the generic ACK queue never reclassifies this decision');
      assert.equal(call.legacy.length, 0);
      const pending = ackRows(f.first);
      assert.equal(pending.length, 1, 'one pending REST ACK');
      assert.equal(pending[0], call.mqtt[0].payload, 'the MQTT copy is byte-identical to the durable REST ACK');
      const ledger = f.first.prepare('SELECT * FROM applied_commands WHERE command_id=?').get('123');
      assert.equal(ledger.originator, 'cloud');
      assert.match(ledger.binding_hash, /^[0-9a-f]{64}$/);
      assert.equal(ledger.result, result);
      assert.equal(ledger.result_detail, pending[0]);
      if (id === 'C01') {
        assert.equal(deviceState(f.first).user_id, null);
        assert.equal(deviceState(f.first).irrigation_zone_id, null);
        assert.equal(deviceState(f.first).sync_version, 8);
        assert.equal(weatherVersion(f.first), 4);
        const events = f.first.prepare('SELECT rowid,op,payload_json FROM sync_outbox WHERE aggregate_key=? ORDER BY rowid').all(DEVICE);
        const weather = events.find((row) => row.op === 'WEATHER_STATION_ZONES_REPLACED');
        const unclaim = events.find((row) => row.op === 'DEVICE_UNCLAIMED');
        assert.ok(weather && unclaim);
        assert.ok(weather.rowid < unclaim.rowid, 'MUTANT_EVENT_ORDER');
        assert.deepEqual(JSON.parse(weather.payload_json).zone_uuids, []);
        assert.deepEqual(historyRows(f.first), beforeTerminal.history);
        if (!policy) {
          await batchTieCase(profile, 98);
          await batchTieCase(profile, 99);
        }
      } else {
        assert.deepEqual(deviceState(f.first), before.device);
        assert.deepEqual(assignments(f.first), before.links);
        if (id === 'C11' || id === 'C12') {
          assert.equal(ack.aggregateKey, null);
          assert.equal(ack.resourceUuid, null);
          const afterTerminal = terminalSnapshot(f.first);
          assert.deepEqual(afterTerminal.weatherState, beforeTerminal.weatherState);
          assert.deepEqual(afterTerminal.outbox, beforeTerminal.outbox);
        }
      }
    }
  } finally {
    f.close();
  }
}

async function replayCase(profile, id, policy) {
  const f = fixture();
  try {
    if (id === 'R04') {
      const beforeFault = terminalSnapshot(f.first);
      assert.equal(beforeFault.devices.find((row) => row.deveui === DEVICE).user_id, 1);
      assert.deepEqual(beforeFault.joins.map((row) => row.zone_id), [1, 2]);
      f.first.exec("CREATE TRIGGER fail_issue233_ledger BEFORE INSERT ON applied_commands BEGIN SELECT RAISE(ABORT,'ledger fault'); END");
      const failed = await cloudCall(profile, f, command(125, 8), { policy });
      assert.equal(ackFrom(failed), null, 'a failed canonical transaction publishes no ACK');
      assert.ok(failed.errors.some((error) => error.includes('ledger fault')));
      assert.ok(!failed.visited.includes(ACK_QUEUE), 'no retryable ACK is queued');
      f.first.exec('DROP TRIGGER fail_issue233_ledger');
      assert.deepEqual(terminalSnapshot(f.first), beforeFault,
        'R04 rolls back links, claim, primary, both versions, outbox, ledger and REST ACK');
      return;
    }
    const first = await cloudCall(profile, f, command(), { policy });
    assert.equal(ackFrom(first).result, 'APPLIED');
    const before = f.first.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
    if (id === 'R02') {
      const changed = command();
      changed.payload.commandType = undefined;
      const result = await cloudCall(profile, f, changed, { policy });
      if (policy) {
        assert.deepEqual(ackFrom(result), ackFrom(first));
        assert.deepEqual(result.errors, []);
        assert.fail('MUTANT_BINDING');
      }
      assert.equal(ackFrom(result), null);
      assert.ok(result.errors.some((error) => error.includes('command_id_binding_conflict')));
      assert.equal(ackRows(f.first).length, 1, 'the stored ACK stays the only pending REST ACK');
    } else if (id === 'R01') {
      const result = await cloudCall(profile, f, command(), { policy });
      const refused = result.errors.find((error) => error.startsWith(DEDUPE + ': '));
      assert.equal(refused, undefined,
        'R01 the generic replay check never answers the bound replay (MUTANT_GATE_ROUTE): ' + refused);
      assert.ok(result.gate.length === 1 && result.gate[0].slot === 1 && result.dedupe.length === 0,
        'the gate sends the replay past the generic replay check to its owner');
      assert.equal(result.mqtt.length, 1);
      assert.equal(result.mqtt[0].payload, first.mqtt[0].payload, 'exact replay republishes the stored ACK byte-for-byte');
      assert.equal(ackRows(f.first).length, 1);
    } else if (id === 'R03') {
      let postReclaimOutbox = null;
      const result = await cloudCall(profile, f, command(124, 9), {
        policy,
        beforeBegin() {
          f.second.prepare('UPDATE devices SET user_id=?,sync_version=? WHERE deveui=?').run(4, 8, DEVICE);
          postReclaimOutbox = f.second.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all().map((row) => ({ ...row }));
        }
      });
      assert.ok(postReclaimOutbox && postReclaimOutbox.length > before, 'the second connection reclaim creates its own outbox event');
      assert.equal(ackFrom(result).result, 'CONFLICT');
      assert.equal(ackFrom(result).reasonCode, 'stale_device_state');
      assert.equal(deviceState(f.first).user_id, 4);
      assert.deepEqual(f.first.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all().map((row) => ({ ...row })),
        postReclaimOutbox, 'R03 command adds no event after the second connection reclaim');
    }
    if (id !== 'R03') assert.equal(f.first.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, before);
  } finally {
    f.close();
  }
}

async function accountCase(profile) {
  const f = fixture();
  try {
    const libs = libsFor(profile, productionFacade(f.first));
    const before = {
      device: deviceState(f.first),
      links: assignments(f.first),
      historical: historyRows(f.first),
      weatherEvents: weatherEvents(f.first),
      state: weatherVersion(f.first)
    };
    const call = await executeFunction(loadNode('al-unlink-db', profile.flowsPath),
      Object.assign({ msg: { _unlinkAuth: { userId: 1, username: 'admin1' } }, db: f.first }, libs));
    assert.ok(call.result[0]);
    const format = await executeFunction(loadNode('al-unlink-format', profile.flowsPath),
      Object.assign({ msg: call.result[0], db: f.first }, libs));
    assert.equal(format.result.statusCode, 200);
    assert.deepEqual(format.result.payload, { success: true });
    assert.equal(f.first.prepare("SELECT linked FROM sync_link_state WHERE peer_node='cloud'").get().linked, 0);
    assert.deepEqual(deviceState(f.first), before.device);
    assert.deepEqual(assignments(f.first), before.links);
    assert.deepEqual(historyRows(f.first), before.historical);
    assert.deepEqual(weatherEvents(f.first), before.weatherEvents);
    assert.equal(weatherVersion(f.first), before.state);
  } finally {
    f.close();
  }
}

// H01: the local DELETE /api/devices/:deveui keeps today's behavior in both flag states. The
// held Phase B all-links cleanup does not run there: links, weather version, weather events and
// history are unchanged while claim and primary are cleared.
async function boundaryCase(profile, policy) {
  const owner = policy || policyFor(profile);
  assert.equal(owner.CLOUD_S2120_UNCLAIM, undefined, 'the cloud-only cleanup flag is not exported');
  assert.ok(!fs.readFileSync(path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'routes.js'), 'utf8')
    .includes('CLOUD_S2120_UNCLAIM'), 'no route can set the cloud-only cleanup flag');
  for (const scoped of [true, false]) {
    const f = fixture();
    try {
      const before = {
        links: assignments(f.first),
        state: weatherVersion(f.first),
        weather: weatherEvents(f.first).length,
        history: historyRows(f.first)
      };
      const result = await traverse(profile, 'scoped-device-delete-router', {
        req: { method: 'DELETE', headers: { authorization: auth(1, 'admin1') }, params: { deveui: DEVICE } },
        payload: {}
      }, f.first, { scoped, policy });
      assertOneResponse(result, 200, 'H01 local unclaim, scoped=' + scoped);
      const device = deviceState(f.first);
      assert.equal(device.user_id, null);
      assert.equal(device.irrigation_zone_id, null);
      assert.deepEqual(assignments(f.first), before.links,
        'H01 the held Phase B local all-links cleanup did not run: weather links unchanged');
      assert.equal(weatherVersion(f.first), before.state);
      assert.equal(weatherEvents(f.first).length, before.weather);
      assert.deepEqual(historyRows(f.first), before.history);
      assert.equal(f.first.prepare(
        "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_key=? AND op='DEVICE_UNCLAIMED'"
      ).get(DEVICE).n, 1);
      assert.equal(f.first.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
    } finally {
      f.close();
    }
  }
}

// G01: the four protected WATERMARK command types pass the gate with no helper load and the
// identical message on output 1; the generic replay node then sends them to its protected
// output 3, still before any helper load.
const PROTECTED_TYPES = [
  'SET_WATERMARK_CALIBRATION', 'DELETE_WATERMARK_CALIBRATION', 'SET_CHAMELEON_CONFIG', 'UPSERT_DEVICE_SOIL_DEPTHS'
];

async function protectedPassCase(profile) {
  const raw = new DatabaseSync(':memory:');
  try {
    const gateNode = loadNode(GATE, profile.flowsPath);
    assert.deepEqual(gateNode.wires[0], [DEDUPE], 'G01 gate output 1 feeds the generic replay check');
    for (const type of PROTECTED_TYPES) {
      const envelope = { commandId: 77, commandType: type, aggregateType: 'DEVICE', aggregateKey: NONWEATHER, payload: { deviceEui: NONWEATHER } };
      const msg = { payload: { commandId: 77, commandType: type, leasedToGateway: GATEWAY, _pendingCommandEnvelope: envelope } };
      const pristine = JSON.stringify(msg.payload);
      const requests = [];
      const osiLib = { require(name) {
        requests.push(name);
        return { ok: false, error: 'G01 expects no helper load: ' + name };
      } };
      const options = { db: raw, env: { DEVICE_EUI: GATEWAY }, nodeRedModules: profile.nodeRedModules, libOverrides: { osiLib } };
      const gate = await executeFunction(gateNode, Object.assign({ msg }, options));
      assert.deepEqual(requests, [], 'G01 ' + type + ': the gate loads no helper');
      assert.ok(Array.isArray(gate.result) && gate.result.length === 2 && gate.result[0] === msg && gate.result[1] === null,
        'G01 ' + type + ': the gate passes the identical message on output 1 only');
      assert.deepEqual([gate.errors, gate.warnings], [[], []], 'G01 ' + type + ': the gate reports nothing');
      assert.equal(JSON.stringify(msg.payload), pristine, 'G01 ' + type + ': the gate changes neither the command nor its envelope');
      const dedupe = await executeFunction(loadNode(DEDUPE, profile.flowsPath), Object.assign({ msg: gate.result[0] }, options));
      assert.deepEqual(requests, [], 'G01 ' + type + ': the replay node reaches its protected output before any helper load');
      assert.ok(Array.isArray(dedupe.result) && dedupe.result.length === 3 &&
        dedupe.result[0] === null && dedupe.result[1] === null && dedupe.result[2] === msg,
        'G01 ' + type + ': the replay node sends the identical message to its protected output 3');
      assert.deepEqual([dedupe.errors, dedupe.warnings], [[], []], 'G01 ' + type + ': the replay node reports nothing');
    }
  } finally {
    raw.close();
  }
}

// G02 and G03 call the owner gate (routes.s2120UnclaimGate) with a recording DB helper and node,
// so opens, queries, closes, errors and warnings land in one ordered log.
function pendingUnclaim(deviceEui, aggregateKey) {
  const issued = command();
  issued.aggregateKey = aggregateKey;
  issued.payload.deviceEui = deviceEui;
  return Object.assign({}, issued, {
    _pendingCommandEnvelope: {
      commandId: issued.commandId, commandType: issued.commandType, eventUuid: issued.eventUuid,
      aggregateType: issued.aggregateType, aggregateKey, appliedSyncVersion: issued.appliedSyncVersion,
      effectKey: null, payload: issued.payload
    }
  });
}

function recordingDatabase(raw, log, fault) {
  const base = facadeDb(raw);
  const counts = { opens: 0, closes: 0 };
  function Database(file) {
    if (fault.construct) throw fault.construct;
    counts.opens++;
    log.push('open ' + file);
    return {
      all(sql, params) {
        log.push('all');
        if (fault.query) return Promise.reject(fault.query);
        return base.all(sql, params).then((rows) => {
          log.push('rows');
          return rows;
        });
      },
      close(callback) {
        counts.closes++;
        log.push('close');
        setImmediate(() => callback(fault.close || null));
      }
    };
  }
  return { Database, counts };
}

function ownerGateContext(profile, raw, cmd, fault = {}) {
  const log = [];
  const requests = [];
  const db = recordingDatabase(raw, log, fault);
  const msg = { payload: cmd };
  const node = {
    error: (text, errorMsg) => log.push(['error', String(text), errorMsg === msg]),
    warn: (text) => log.push(['warn', String(text)])
  };
  const osiLib = { require(name) {
    requests.push(name);
    if (name !== 'osi-db-helper') return { ok: false, error: 'unexpected helper ' + name };
    return fault.dbHelper ? { ok: false, error: fault.dbHelper } : { ok: true, value: { Database: db.Database } };
  } };
  const policy = policyFor(profile);
  return {
    log, requests, counts: db.counts, msg, cmd,
    context: { msg, node, osiLib, policy, command: cmd, envelope: cmd._pendingCommandEnvelope }
  };
}

const OPEN = 'open /data/db/farming.db';

async function ownerGateOrderCase(profile) {
  const f = fixture();
  try {
    const policy = policyFor(profile);
    const cantOpen = Object.assign(new Error('SQLITE_CANTOPEN: unable to open database file'), { code: 'SQLITE_CANTOPEN' });
    const closeFault = new Error('fixture close failed');
    const cases = [
      { label: 'station', cmd: pendingUnclaim(DEVICE, DEVICE), out: 'owner', log: [OPEN, 'all', 'rows', 'close'] },
      { label: 'non-station', cmd: pendingUnclaim(NONWEATHER, NONWEATHER), out: 'replay', log: [OPEN, 'all', 'rows', 'close'] },
      { label: 'no identity', cmd: pendingUnclaim('not-an-eui', null), out: 'replay', log: [OPEN, 'close'] },
      {
        // The real osi-db-helper Database reports an open failure through its queued queries,
        // not from the constructor; the awaited lookup rejects inside the owner gate's try.
        label: 'asynchronous open rejection', cmd: pendingUnclaim(DEVICE, DEVICE), fault: { query: cantOpen }, out: 'none',
        log: [OPEN, 'all', ['error', 'S2120 unclaim check failed closed: ' + cantOpen.message, true], 'close']
      },
      {
        label: 'close failure after a station lookup', cmd: pendingUnclaim(DEVICE, DEVICE), fault: { close: closeFault }, out: 'owner',
        log: [OPEN, 'all', 'rows', 'close', ['warn', 'S2120 unclaim check DB close failed: fixture close failed']]
      },
      {
        label: 'close failure after a lookup failure', cmd: pendingUnclaim(DEVICE, DEVICE), fault: { query: cantOpen, close: closeFault }, out: 'none',
        log: [OPEN, 'all', ['error', 'S2120 unclaim check failed closed: ' + cantOpen.message, true], 'close',
          ['warn', 'S2120 unclaim check DB close failed: fixture close failed']]
      }
    ];
    for (const spec of cases) {
      const g = ownerGateContext(profile, f.first, spec.cmd, spec.fault);
      const result = await policy.routes.s2120UnclaimGate(g.context);
      const expected = { owner: [null, g.msg], replay: [g.msg, null], none: [null, null] }[spec.out];
      assert.ok(Array.isArray(result) && result.length === 2 && result[0] === expected[0] && result[1] === expected[1],
        'G02 ' + spec.label + ': output ' + spec.out);
      assert.deepEqual(g.log, spec.log, 'G02 ' + spec.label + ': open, lookup, report and close order');
      assert.deepEqual(g.counts, { opens: 1, closes: 1 }, 'G02 ' + spec.label + ': one open and exactly one close');
      assert.deepEqual(g.requests, ['osi-db-helper'], 'G02 ' + spec.label + ': the owner gate loads only the DB helper');
      assert.equal(g.context.envelope.leasedToGateway, GATEWAY, 'G02 ' + spec.label + ': the trusted lease joins the envelope');
    }
    assert.deepEqual(terminalSnapshot(f.first).ledger, [], 'G02 the owner gate writes no ledger row');
  } finally {
    f.close();
  }
}

async function ownerGateRefusalCase(profile) {
  const f = fixture();
  try {
    const policy = policyFor(profile);
    const before = terminalSnapshot(f.first);
    // DB helper unavailable inside the owner gate: one error, no output, no open.
    const missing = ownerGateContext(profile, f.first, pendingUnclaim(DEVICE, DEVICE), { dbHelper: 'fixture db helper quarantined' });
    const refused = await policy.routes.s2120UnclaimGate(missing.context);
    assert.ok(Array.isArray(refused) && refused.length === 2 && refused[0] === null && refused[1] === null, 'G03 missing DB helper: no output');
    assert.deepEqual(missing.log, [['error', 'S2120 unclaim owner unavailable: fixture db helper quarantined', true]],
      'G03 missing DB helper: one contextual error');
    assert.deepEqual(missing.counts, { opens: 0, closes: 0 }, 'G03 missing DB helper: no open');
    // Owner unavailable at the gate node: one error, no output, no DB helper load.
    const gateNode = loadNode(GATE, profile.flowsPath);
    const requests = [];
    const policyMissing = { require(name) {
      requests.push(name);
      return name === 'osi-irrigation-policy' ? { ok: false, error: 'fixture policy quarantined' } : { ok: false, error: 'unexpected helper ' + name };
    } };
    const msg = { payload: pendingUnclaim(DEVICE, DEVICE) };
    const gate = await executeFunction(gateNode, {
      msg, db: f.first, nodeRedModules: profile.nodeRedModules, libOverrides: { osiLib: policyMissing }
    });
    assert.ok(Array.isArray(gate.result) && gate.result.length === 2 && gate.result[0] === null && gate.result[1] === null,
      'G03 missing owner: no output');
    assert.deepEqual([gate.errors, gate.warnings], [['S2120 unclaim owner unavailable: fixture policy quarantined'], []],
      'G03 missing owner: one contextual error');
    assert.deepEqual(requests, ['osi-irrigation-policy'], 'G03 missing owner: no DB helper load, so no open');
    // A DB helper whose constructor throws synchronously: the constructor runs before the owner
    // gate's try, so the returned promise rejects with that error. There is no contextual error,
    // no warning, no open and no close, and no output; Node-RED reports the rejection itself.
    const constructError = new Error('fixture constructor failed');
    const thrown = ownerGateContext(profile, f.first, pendingUnclaim(DEVICE, DEVICE), { construct: constructError });
    await assert.rejects(policy.routes.s2120UnclaimGate(thrown.context), (error) => error === constructError,
      'G03 synchronous constructor failure rejects the owner gate promise');
    assert.deepEqual(thrown.log, [], 'G03 synchronous constructor failure: no report, open or close from the owner gate');
    assert.deepEqual(thrown.counts, { opens: 0, closes: 0 });
    const throwing = { Database: function Database() { throw constructError; } };
    await assert.rejects(executeFunction(gateNode, {
      msg: { payload: pendingUnclaim(DEVICE, DEVICE) }, db: f.first, nodeRedModules: profile.nodeRedModules,
      osiLibModules: { 'osi-db-helper': throwing, 'osi-irrigation-policy': policy }
    }), (error) => error === constructError, 'G03 the gate node passes the rejection to Node-RED and sends nothing');
    assert.deepEqual(terminalSnapshot(f.first), before, 'G03 no refusal writes a row');
  } finally {
    f.close();
  }
}

// L01, L02: a persistent osi-command-ledger load failure along the real chain from
// sync-pending-split. A live S2120 unclaim passes the gate on output 2 and stops at the lifecycle
// adapter; any other unclaim passes on output 1 and stops at the generic replay node. Neither
// applies the unclaim, writes a ledger decision or sends an ACK.
const LEDGER_FAULT = 'fixture ledger quarantined';
const MISSING_LEDGER = {
  L01: { gateSlot: 1, stop: ADAPTER, forbidden: DEDUPE, error: ADAPTER + ': lifecycle command adapter unavailable: ' + LEDGER_FAULT },
  L02: { gateSlot: 0, stop: DEDUPE, forbidden: ADAPTER, error: DEDUPE + ': Command helpers unavailable: ' + LEDGER_FAULT }
};

async function missingLedgerRun(profile, id, inject) {
  const f = fixture();
  try {
    const issued = command();
    if (id === 'L02') {
      issued.aggregateKey = NONWEATHER;
      issued.payload.deviceEui = NONWEATHER;
      issued.payload.syncVersion = issued.appliedSyncVersion = 3;
    }
    const before = terminalSnapshot(f.first);
    const loader = { fault: inject ? { name: 'osi-command-ledger', error: LEDGER_FAULT } : null, requests: [] };
    const call = await cloudCall(profile, f, issued, { loader });
    return { call, before, after: terminalSnapshot(f.first), requests: loader.requests };
  } finally {
    f.close();
  }
}

function missingLedgerOracles(profile, id, run) {
  const spec = MISSING_LEDGER[id];
  const { call } = run;
  return {
    stop() {
      const gate = call.trace.filter((item) => item.id === GATE);
      assert.ok(gate.length === 1 && gate[0].slot === spec.gateSlot, id + ' stop: the gate emits once, on output ' + (spec.gateSlot + 1));
      assert.ok(call.visited.includes(spec.stop), id + ' stop: the chain reaches ' + spec.stop);
      assert.equal(call.trace.filter((item) => item.id === spec.stop).length, 0, id + ' stop: ' + spec.stop + ' emits nothing');
      assert.ok(!call.visited.includes(spec.forbidden), id + ' stop: the chain never reaches ' + spec.forbidden);
    },
    error() {
      assert.deepEqual(call.errors, [spec.error], id + ' error: exactly one contextual error, at the stop node');
      assert.ok(!call.warnings.some((warning) => warning.includes('S2120 unclaim held') || warning.includes(LEDGER_FAULT)),
        id + ' error: no hold and no second report');
    },
    state() {
      assert.deepEqual(run.after, run.before, id + ' state: no device, zone, weather, history, outbox, ledger or REST ACK row changes');
      const kinds = call.visited.map((nodeId) => loadNode(nodeId, profile.flowsPath).type);
      assert.ok(call.responses.length === 0 && call.mqtt.length === 0 && call.legacy.length === 0 &&
        !kinds.includes('http request'), id + ' state: no HTTP response, MQTT ACK, legacy SQL or external request');
    }
  };
}

async function missingLedgerCase(profile, id) {
  const run = await missingLedgerRun(profile, id, true);
  const oracles = missingLedgerOracles(profile, id, run);
  oracles.stop();
  oracles.error();
  oracles.state();
  assert.deepEqual(run.requests.filter((item) => item.name === 'osi-command-ledger').map((item) => item.node),
    [MISSING_LEDGER[id].stop], id + ': the quarantined ledger was requested, once, by the stop node');
  assert.deepEqual(run.requests.filter((item) => item.node === GATE).map((item) => item.name),
    ['osi-irrigation-policy', 'osi-db-helper'], id + ': the gate loads only the owner and the DB helper');
}

// Control: the same chain with the injector disconnected. Every oracle of the negative case must
// fail, and normal ledger resolution must reach the existing APPLIED outcome.
async function missingLedgerControl(profile, id) {
  const run = await missingLedgerRun(profile, id, false);
  const oracles = missingLedgerOracles(profile, id, run);
  for (const part of ['stop', 'error', 'state']) {
    await assert.rejects(async () => oracles[part](),
      (error) => error.name === 'AssertionError' && error.message.startsWith(id + ' ' + part + ':'),
      id + ' control: without the injected fault the ' + part + ' oracle fails');
  }
  const ack = ackFrom(run.call);
  assert.ok(ack && ack.result === 'APPLIED', id + ' control: normal ledger resolution applies the unclaim');
  const ledgerNodes = run.requests.filter((item) => item.name === 'osi-command-ledger').map((item) => item.node);
  assert.equal(ledgerNodes[0], MISSING_LEDGER[id].stop, id + ' control: the same node asks for the ledger first');
  if (id === 'L01') {
    assert.ok(run.call.trace.some((item) => item.id === ADAPTER && item.slot === 2), 'L01 control: the owner answers on the S2120 output');
    assert.deepEqual(run.after.joins, [], 'L01 control: the owner removes every weather link');
  } else {
    assert.ok(run.call.visited.includes(ACK_QUEUE), 'L02 control: the generic path queues its ACK');
    assert.equal(run.after.devices.find((row) => row.deveui === NONWEATHER).user_id, null, 'L02 control: the generic unclaim applies');
  }
}

let passed = 0;
const candidate = PROFILES.every((profile) => typeof policyFor(profile).applyS2120CloudUnclaim === 'function');
for (const profile of PROFILES) {
  const label = profile.name;
  if (!candidate) {
    for (const spec of [D[0], D[3]]) test(label + ' RED ' + spec.id, async () => {
      await detachCase(profile, spec);
    });
    test(label + ' RED C01', async () => {
      await cloudCase(profile, 'C01');
    });
    continue;
  }
  for (const spec of D) test(label + ' ' + spec.id, async () => {
    await detachCase(profile, spec);
    if (spec.id === 'D12') await unlinkedDetachCase(profile);
    passed++;
  });
  for (let n = 1; n <= 12; n++) {
    const id = 'C' + String(n).padStart(2, '0');
    test(label + ' ' + id, async () => {
      await cloudCase(profile, id);
      passed++;
    });
  }
  for (let n = 1; n <= 4; n++) {
    const id = 'R0' + n;
    test(label + ' ' + id, async () => {
      await replayCase(profile, id);
      passed++;
    });
  }
  test(label + ' F01', async () => {
    await forceDeliveryCase(profile);
    passed++;
  });
  test(label + ' A01', async () => {
    await accountCase(profile);
    passed++;
  });
  test(label + ' H01', async () => {
    await boundaryCase(profile);
    passed++;
  });
  test(label + ' G01', async () => {
    await protectedPassCase(profile);
    passed++;
  });
  test(label + ' G02', async () => {
    await ownerGateOrderCase(profile);
    passed++;
  });
  test(label + ' G03', async () => {
    await ownerGateRefusalCase(profile);
    passed++;
  });
  for (const id of ['L01', 'L02']) {
    test(label + ' ' + id, async () => {
      await missingLedgerCase(profile, id);
      passed++;
    });
    test(label + ' ' + id + ' control', async () => {
      await missingLedgerControl(profile, id);
      passed++;
    });
  }
  for (let n = 0; n < 6; n++) test(label + ' mutation ' + n, async () => {
    const policy = n < 4 ? mutantPolicy(profile, MUTATIONS[n]) : mutantRoutesPolicy(profile, ROUTE_MUTATIONS[n - 4]);
    await assert.rejects(async () => {
      if (n === 0) await detachCase(profile, D[0], policy);
      if (n === 1) await detachCase(profile, D[4], policy);
      if (n === 2 || n === 4) await cloudCase(profile, 'C01', policy);
      if (n === 3) await replayCase(profile, 'R02', policy);
      if (n === 5) await replayCase(profile, 'R01', policy);
    }, (error) => error.name === 'AssertionError' && KILLS[n].every((text) => error.message.includes(text)));
    passed++;
  });
}
if (candidate) test('issue233 phase A count', () => {
  assert.equal(passed, 88);
  process.stdout.write('PASS 88 issue-233 phase-a checks\n');
});
