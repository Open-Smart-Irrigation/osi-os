#!/usr/bin/env node
'use strict';

// weather_source round trip on the edge (spec
// docs/superpowers/specs/2026-09-27-weather-data-view-design.md, final review
// final-review-fable.md finding I1): the zone update trigger of migration
// 0065 on every bundled database, the bootstrap and force-sync zone
// snapshots, the zone write route and zone list, and the legacy "Build
// UPDATE SQL" command path. The edge must never push a default over a value
// the cloud already holds, so the payload/snapshot key is present only when
// the stored value is not 'auto', or -- for the trigger only, since it sees
// the update -- when the value changed in this update (a reset to 'auto' is
// sent exactly once); otherwise the key is absent, never null. The route and
// command tests run the shipped function-node source through
// scripts/lib/scoped-access-harness.js; the trigger tests run on copies of
// the bundled databases, as scripts/test-zone-update-sync-version.js does;
// the snapshot tests extract the zone-mapping expression from the shipped
// flows.json source and evaluate it directly.
//
// Run: node --test scripts/test-zone-weather-source.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode, makeAuthHeader, facadeDb } = require('./lib/scoped-access-harness');
const { SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = 'AA00000000000001';
const ZONE_UUID = '306fa8ef-20f8-4911-b9c4-f99f60252579';
const USER_UUID = '55555555-5555-4555-8555-555555555555';
const SECRET = 'zone-weather-source-secret';

function bundledCopy(t, relativePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(path.join(ROOT, relativePath), dbPath);
  const db = new DatabaseSync(dbPath);
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', datetime('now'))");
  db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, created_at, updated_at) '
    + `VALUES (11, 'North', 7, '${ZONE_UUID}', '${GATEWAY}', 1, 'UTC', datetime('now'), datetime('now'))`);
  return db;
}

function link(db) {
  db.exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) "
    + `VALUES ('cloud', 1, '${GATEWAY}', datetime('now'))`);
}

function zoneEvents(db) {
  return db.prepare("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE' ORDER BY rowid").all()
    .map((row) => ({ op: row.op, syncVersion: Number(row.sync_version), payload: JSON.parse(row.payload_json) }));
}

for (const relativePath of SEED_DB_RELATIVE_PATHS) {
  test(`[${relativePath}] 0065: a provider change alone emits one ZONE_CONFIG_UPSERTED carrying the value`, (t) => {
    const db = bundledCopy(t, relativePath);
    link(db);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET weather_source = 'meteoswiss', sync_version = 2 WHERE id = 11");
    const events = zoneEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_CONFIG_UPSERTED');
    assert.equal(events[0].payload.weather_source, 'meteoswiss');
    assert.equal(events[0].syncVersion, 2);
  });

  test(`[${relativePath}] 0065: an untouched provider (still auto) carries no weather_source key; nothing changed emits nothing`, (t) => {
    const db = bundledCopy(t, relativePath);
    link(db);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET name = 'North block', sync_version = 2 WHERE id = 11");
    const events = zoneEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_UPSERTED');
    assert.equal('weather_source' in events[0].payload, false, 'the key must be absent, not null, when the stored value is untouched auto');
    db.exec('DELETE FROM sync_outbox');
    db.exec('UPDATE irrigation_zones SET name = name WHERE id = 11');
    assert.deepEqual(zoneEvents(db), []);
  });

  test(`[${relativePath}] 0065: a reset to auto is carried once, then omitted on the next unrelated update`, (t) => {
    const db = bundledCopy(t, relativePath);
    link(db);
    db.exec("UPDATE irrigation_zones SET weather_source = 'meteoswiss', sync_version = 2 WHERE id = 11");
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET weather_source = 'auto', sync_version = 3 WHERE id = 11");
    const reset = zoneEvents(db);
    assert.equal(reset.length, 1);
    assert.equal(reset[0].op, 'ZONE_CONFIG_UPSERTED', 'a weather_source change alone still selects ZONE_CONFIG_UPSERTED');
    assert.equal(reset[0].payload.weather_source, 'auto');
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET name = 'North block', sync_version = 4 WHERE id = 11");
    const next = zoneEvents(db);
    assert.equal(next.length, 1);
    assert.equal('weather_source' in next[0].payload, false, 'the reset must not repeat on a later unrelated update');
  });

  test(`[${relativePath}] 0065: an unlinked gateway emits nothing`, (t) => {
    const db = bundledCopy(t, relativePath);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET weather_source = 'local', sync_version = 2 WHERE id = 11");
    assert.deepEqual(zoneEvents(db), []);
  });
}

// The bootstrap and force-sync snapshots are value-based, not diff-based: each
// snapshot recomputes the zone object fresh from the stored row, so there is no
// separate "reset" case to test here -- a value of 'auto' (whether it always
// was, or was just reset) always omits the key, and any other value always
// carries it. Extract the mapping expression directly from the shipped
// flows.json source so a regression in the shipped code fails this test.
function zoneWeatherSourceSnapshotField(nodeId) {
  const flowPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const node = flows.find((n) => n.id === nodeId);
  assert.ok(node && typeof node.func === 'string', `${nodeId} not found in flows.json`);
  const marker = 'prediction_card_enabled: !!Number(z.prediction_card_enabled || 0), ';
  const start = node.func.indexOf(marker);
  assert.ok(start >= 0, `${nodeId}: zone map fragment not found`);
  const exprStart = start + marker.length;
  const exprEnd = node.func.indexOf(', notes: z.notes,', exprStart);
  assert.ok(exprEnd > exprStart, `${nodeId}: weather_source expression end not found`);
  const expr = node.func.slice(exprStart, exprEnd);
  assert.match(expr, /weather_source/, `${nodeId}: extracted expression does not mention weather_source`);
  // expr is an object-spread expression ("...(cond ? {...} : {})"), only valid
  // inside an object literal.
  return new Function('z', `return ({${expr}});`);
}

for (const nodeId of ['sync-bootstrap-build', 'sync-force-build']) {
  test(`[flows.json ${nodeId}] the zone snapshot carries weather_source only when the stored value is not auto`, () => {
    const spread = zoneWeatherSourceSnapshotField(nodeId);
    assert.deepEqual(spread({ weather_source: 'auto' }), {}, 'untouched (auto) zone: no key in the snapshot');
    assert.deepEqual(spread({ weather_source: 'meteoswiss' }), { weather_source: 'meteoswiss' }, 'explicit provider: key present');
    assert.deepEqual(spread({ weather_source: 'auto' }), {}, 'a zone just reset to auto: absent in the next snapshot too');
  });
}

function seededMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
    + `VALUES (7, 'grower', 'x', '2026-01-01', '${USER_UUID}', 'admin', 1)`);
  db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, created_at, updated_at) '
    + `VALUES (11, 'North', 7, '${ZONE_UUID}', '${GATEWAY}', 3, 'UTC', '2026-01-01', '2026-01-01')`);
  return db;
}

async function putConfig(db, body, env = {}) {
  const run = await executeFunction(loadNode('zone-config-fn'), {
    msg: {
      req: {
        headers: { authorization: makeAuthHeader({ userId: 7, username: 'grower', secret: SECRET }) },
        params: { zone_id: '11' },
        body,
      },
      payload: {},
    },
    env: { AUTH_TOKEN_SECRET: SECRET, ...env },
    db,
  });
  return run.result;
}

function stored(db) {
  return { ...db.prepare('SELECT weather_source, sync_version FROM irrigation_zones WHERE id = 11').get() };
}

test('zone-config-fn stores a valid provider, lower-cased, and bumps sync_version', async () => {
  const db = seededMemory();
  try {
    const response = await putConfig(db, { weatherSource: ' MeteoSwiss ' }, { OSI_WEATHER_PROVIDER_DEFAULT: 'meteoswiss' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(stored(db), { weather_source: 'meteoswiss', sync_version: 4 });
    assert.equal(response.payload.weather_source, 'meteoswiss');
    assert.equal(response.payload.weather_source_default, 'meteoswiss');
    const snake = await putConfig(db, { weather_source: 'open_meteo' });
    assert.equal(snake.statusCode, 200);
    assert.equal(stored(db).weather_source, 'open_meteo');
    assert.equal(snake.payload.weather_source_default, 'open_meteo');
  } finally {
    db.close();
  }
});

// E-M5: the invalid-zone-id early return used to skip closing the handle
// opened at the top of the function. Wraps the harness's facade close() with
// a counter (via libOverrides) so the assertion is on the actual call, not on
// a side effect of it.
test('zone-config-fn closes the database handle when the zone id is invalid', async () => {
  const db = seededMemory();
  try {
    let closeCalls = 0;
    const baseFacade = facadeDb(db);
    const trackedFacade = {
      ...baseFacade,
      close(callback) {
        closeCalls += 1;
        return baseFacade.close(callback);
      },
    };
    const run = await executeFunction(loadNode('zone-config-fn'), {
      msg: {
        req: {
          headers: { authorization: makeAuthHeader({ userId: 7, username: 'grower', secret: SECRET }) },
          params: { zone_id: 'abc' },
          body: {},
        },
        payload: {},
      },
      env: { AUTH_TOKEN_SECRET: SECRET },
      db,
      libOverrides: { osiDb: { Database: function Database() { return trackedFacade; } } },
    });
    assert.equal(run.result.statusCode, 400);
    assert.deepEqual(run.result.payload, { error: 'Invalid zone ID' });
    assert.equal(closeCalls, 1, 'the handle opened for this request must be closed before responding');
  } finally {
    db.close();
  }
});

test('zone-config-fn stores auto for null and rejects a malformed provider', async () => {
  const db = seededMemory();
  try {
    db.exec("UPDATE irrigation_zones SET weather_source = 'local' WHERE id = 11");
    assert.equal((await putConfig(db, { weatherSource: null })).statusCode, 200);
    assert.equal(stored(db).weather_source, 'auto');
    for (const bad of ['open-meteo!', 'a'.repeat(21)]) {
      const response = await putConfig(db, { weatherSource: bad });
      assert.equal(response.statusCode, 400, bad);
      assert.deepEqual(response.payload, { error: 'Weather provider must be 1 to 20 lower-case letters or underscores' });
    }
    assert.equal(stored(db).weather_source, 'auto');
    assert.equal((await putConfig(db, { notes: 'x' })).payload.weather_source, 'auto', 'a save of other fields keeps the value');
  } finally {
    db.close();
  }
});

async function zoneList(db, env) {
  const query = await executeFunction(loadNode('get-zones-query'), {
    msg: { payload: [{ id: 7 }] },
    env,
    db,
  });
  const rowsMsg = query.result[0];
  const response = await executeFunction(loadNode('get-zones-response'), { msg: rowsMsg, env, db });
  return response.result.payload;
}

test('the zone list returns weather_source and the gateway default', async () => {
  const db = seededMemory();
  try {
    db.exec("UPDATE irrigation_zones SET weather_source = 'openagri' WHERE id = 11");
    const [swiss] = await zoneList(db, { OSI_WEATHER_PROVIDER_DEFAULT: 'meteoswiss' });
    assert.equal(swiss.weather_source, 'openagri');
    assert.equal(swiss.weather_source_default, 'meteoswiss');
    assert.equal((await zoneList(db, {}))[0].weather_source_default, 'open_meteo');
    assert.equal((await zoneList(db, { OSI_WEATHER_PROVIDER_DEFAULT: 'bogus' }))[0].weather_source_default, 'open_meteo');
  } finally {
    db.close();
  }
});

async function legacyCommand(db, cmd) {
  const run = await executeFunction(loadNode('4f4a765f36cee6f3'), {
    msg: { payload: { zoneUuid: ZONE_UUID, syncVersion: 9, ...cmd } },
    env: { DEVICE_EUI: GATEWAY },
    db,
  });
  assert.equal(typeof run.result.topic, 'string', 'the node must build a statement');
  db.exec(run.result.topic);
  return run;
}

test('Build UPDATE SQL: UPSERT_ZONE_CONFIG stores weatherSource or weather_source, null as auto', async () => {
  const db = seededMemory();
  try {
    await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weatherSource: 'MeteoSwiss' });
    assert.equal(stored(db).weather_source, 'meteoswiss');
    await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weather_source: 'openagri' });
    assert.equal(stored(db).weather_source, 'openagri');
    await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weatherSource: null });
    assert.equal(stored(db).weather_source, 'auto');
  } finally {
    db.close();
  }
});

test('Build UPDATE SQL: an invalid provider leaves the column, warns once, and applies the rest', async () => {
  const db = seededMemory();
  try {
    db.exec("UPDATE irrigation_zones SET weather_source = 'meteoswiss' WHERE id = 11");
    const run = await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weatherSource: 'Meteo-Blue!', notes: 'kept going' });
    assert.equal(stored(db).weather_source, 'meteoswiss');
    assert.equal(db.prepare('SELECT notes FROM irrigation_zones WHERE id = 11').get().notes, 'kept going');
    assert.equal(run.warnings.length, 1);
    assert.match(run.warnings[0], new RegExp(ZONE_UUID));
    const quiet = await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', notes: 'no provider' });
    assert.deepEqual(quiet.warnings, []);
  } finally {
    db.close();
  }
});

test('Build UPDATE SQL: legacy UPSERT_ZONE inserts auto when absent and keeps the stored value on conflict', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SEED);
    db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
      + `VALUES (7, 'grower', 'x', '2026-01-01', '${USER_UUID}', 'admin', 1)`);
    const upsert = { commandType: 'UPSERT_ZONE', name: 'North', gatewayDeviceEui: GATEWAY, user: { userUuid: USER_UUID } };
    await legacyCommand(db, upsert);
    assert.equal(db.prepare('SELECT weather_source FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID).weather_source, 'auto');
    await legacyCommand(db, { ...upsert, weatherSource: 'meteoswiss', syncVersion: 10 });
    assert.equal(db.prepare('SELECT weather_source FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID).weather_source, 'meteoswiss');
    await legacyCommand(db, { ...upsert, syncVersion: 11 });
    assert.equal(db.prepare('SELECT weather_source FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID).weather_source, 'meteoswiss');
  } finally {
    db.close();
  }
});
