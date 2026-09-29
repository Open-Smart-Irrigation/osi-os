'use strict';

// F140. A zone's timezone and location routes updated irrigation_zones without bumping
// sync_version, so trg_sync_zones_outbox_au emitted ZONE_UPSERTED / ZONE_LOCATION_UPSERTED
// at a version the cloud had already applied. The cloud folds event_uuid into its payload
// hash, so an equal version carrying a different payload is not a duplicate: it is
// terminally dead-lettered as equal_version_payload_conflict, and the change never
// reaches the cloud. Observed on Silvan 2026-09-17, twelve times in one day, e.g. zone
// 306fa8ef-20f8-4911-b9c4-f99f60252579 -- two ZONE_UPSERTED rows at sync_version 1,
// 32 ms apart, differing only in timezone (UTC -> Pacific/Kiritimati); the first was
// delivered and the second rejected, leaving the gateway on Pacific/Kiritimati and the
// cloud on UTC with nothing to reconcile them. zone-config-fn already bumps
// (`sets.push("sync_version=COALESCE(sync_version,0)+1")`); these two routes did not.
//
// This runs the UPDATE the shipped node actually issues against the real bundled
// farming.db and its real triggers, so it pins the emitted event, not just the SQL text.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712',
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];

const ZONE_UUID = '306fa8ef-20f8-4911-b9c4-f99f60252579';
// The two routes resolve the owning user differently, so each needs its own locals bound.
const TZ_BINDINGS = { tz: 'Europe/Zurich', zoneId: 11, ownerId: 7 };
const LOCATION_BINDINGS = {
  lat: 1.5,
  lon: 2.5,
  zoneId: 11,
  auth: { userId: 7 },
  msg: { _scopedZoneWriteAuthorized: false, _scopedZoneOwnerId: null },
};
const GATEWAY = '0016C001F11715E2';

function flowsFor(profile) {
  return JSON.parse(fs.readFileSync(path.join(REPO, profile, 'files/usr/share/flows.json'), 'utf8'));
}

function nodeSource(profile, id) {
  const node = flowsFor(profile).find((candidate) => candidate.id === id);
  assert.ok(node, `missing flow node ${id} in ${profile}`);
  return node.func;
}

/**
 * Pulls the argument expression of the first exec/run call that updates irrigation_zones
 * and evaluates it with the node's own local names bound, so the test sees the exact SQL
 * the node builds rather than a copy that could drift from it.
 */
function updateStatement(source, bindings) {
  const start = source.search(/(?:exec|run)\(\s*(?:"UPDATE irrigation_zones|`UPDATE irrigation_zones)/);
  assert.notEqual(start, -1, 'no irrigation_zones UPDATE found in the node source');
  const open = source.indexOf('(', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, 'unbalanced UPDATE call');
  const expression = source.slice(open + 1, end);
  const sandbox = Object.assign({
    s: (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`),
    n: (v) => (v === null || v === undefined || !isFinite(Number(v)) ? 'NULL' : String(Number(v))),
    Date,
    Number,
    String,
    isFinite,
  }, bindings);
  return new vm.Script(`(${expression})`).runInNewContext(sandbox, { timeout: 1000 });
}

function seededDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-sv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(path.join(REPO, PROFILES[0], 'files/usr/share/db/farming.db'), dbPath);
  const db = new DatabaseSync(dbPath);
  t.after(() => { try { db.close(); } catch { /* already closed */ } });

  // The outbox triggers are gated on a linked cloud peer; without this row nothing is
  // emitted at all and the test would pass for the wrong reason.
  db.exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) "
    + `VALUES ('cloud', 1, '${GATEWAY}', datetime('now'))`);
  db.exec("INSERT INTO users(id, username, password_hash, created_at) "
    + "VALUES (7,'grower','x',datetime('now'))");
  db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, '
    + 'sync_version, timezone, created_at, updated_at) '
    + `VALUES (11,'North',7,'${ZONE_UUID}','${GATEWAY}',1,'UTC',datetime('now'),datetime('now'))`);
  const seeded = db.prepare('SELECT sync_version FROM irrigation_zones WHERE id=11').get();
  assert.equal(Number(seeded.sync_version), 1, 'fixture must start at sync_version 1');
  // Drop the insert-time event so only the UPDATE's own emission is under test.
  db.exec('DELETE FROM sync_outbox');
  return db;
}

function emittedZoneEvents(db) {
  return db.prepare("SELECT op, sync_version, payload_json FROM sync_outbox "
    + "WHERE aggregate_type='ZONE' ORDER BY occurred_at, rowid").all();
}

for (const profile of PROFILES) {
  test(`[${profile}] PUT zone timezone emits ZONE_UPSERTED at a NEW sync_version`, (t) => {
    const db = seededDb(t);
    const sql = updateStatement(nodeSource(profile, 'dendro-tz-fn'), {
      tz: 'Pacific/Kiritimati',
      zoneId: 11,
      ownerId: 7,
    });
    db.exec(sql);

    const row = db.prepare('SELECT timezone, sync_version FROM irrigation_zones WHERE id=11').get();
    assert.equal(row.timezone, 'Pacific/Kiritimati', 'the timezone must still be written');
    assert.equal(Number(row.sync_version), 2, 'the row must move to the next sync version');

    const events = emittedZoneEvents(db);
    assert.equal(events.length, 1, `expected one emitted zone event, got ${events.length}`);
    assert.equal(Number(events[0].sync_version), 2,
      'the emitted event must carry the new version, or the cloud dead-letters it as equal_version_payload_conflict');
    assert.equal(Number(JSON.parse(events[0].payload_json).sync_version), 2,
      'the payload the cloud hashes must carry the new version too');
  });

  test(`[${profile}] PUT zone location emits its event at a NEW sync_version`, (t) => {
    const db = seededDb(t);
    const sql = updateStatement(nodeSource(profile, 'dendro-location-fn'), {
      lat: 46.2044,
      lon: 6.1432,
      zoneId: 11,
      auth: { userId: 7 },
      msg: { _scopedZoneWriteAuthorized: false, _scopedZoneOwnerId: null },
    });
    db.exec(sql);

    const row = db.prepare('SELECT latitude, longitude, sync_version FROM irrigation_zones WHERE id=11').get();
    assert.equal(Number(row.latitude), 46.2044);
    assert.equal(Number(row.longitude), 6.1432);
    assert.equal(Number(row.sync_version), 2, 'the row must move to the next sync version');

    const events = emittedZoneEvents(db);
    assert.equal(events.length, 1, `expected one emitted zone event, got ${events.length}`);
    assert.equal(Number(events[0].sync_version), 2,
      'the emitted event must carry the new version, or the cloud dead-letters it');
  });

  test(`[${profile}] both routes also refresh updated_at`, (t) => {
    const db = seededDb(t);
    db.exec("UPDATE irrigation_zones SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=11");
    db.exec('DELETE FROM sync_outbox');

    for (const [nodeId, bindings] of [
      ['dendro-tz-fn', TZ_BINDINGS],
      ['dendro-location-fn', LOCATION_BINDINGS],
    ]) {
      db.exec("UPDATE irrigation_zones SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=11");
      db.exec(updateStatement(nodeSource(profile, nodeId), bindings));
      const row = db.prepare('SELECT updated_at FROM irrigation_zones WHERE id=11').get();
      assert.notEqual(row.updated_at, '2020-01-01T00:00:00.000Z',
        `${nodeId} must refresh updated_at so the row does not look untouched`);
    }
  });
}

test('the shipped profiles issue the same zone UPDATE statements', () => {
  for (const [nodeId, bindings] of [
    ['dendro-tz-fn', TZ_BINDINGS],
    ['dendro-location-fn', LOCATION_BINDINGS],
  ]) {
    const [a, b] = PROFILES.map((profile) => updateStatement(nodeSource(profile, nodeId), bindings));
    assert.equal(a.replace(/'[^']*T[^']*'/g, "'<ts>'"), b.replace(/'[^']*T[^']*'/g, "'<ts>'"),
      `${nodeId} must build the same statement in both profiles`);
  }
});

// Stage start date on the zone write route and the zone list (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B5). The
// shipped zone-config-fn source runs through scripts/lib/scoped-access-harness.js
// against an in-memory seed, so the assertions are about the stored row.
const { executeFunction, loadNode, makeAuthHeader } = require('./lib/scoped-access-harness');
const SEED_SQL = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');
const ROUTE_SECRET = 'zone-stage-started-on-secret';

function routeDb({ stage = 'development', startedOn = '2026-05-01' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED_SQL);
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', '2026-01-01')");
  db.prepare('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, '
    + "phenological_stage, stage_started_on, created_at, updated_at) VALUES (11, 'North', 7, ?, ?, 3, 'UTC', ?, ?, '2026-01-01', '2026-01-01')")
    .run(ZONE_UUID, GATEWAY, stage, startedOn);
  return db;
}

async function putConfig(db, body) {
  const run = await executeFunction(loadNode('zone-config-fn'), {
    msg: {
      req: { headers: { authorization: makeAuthHeader({ userId: 7, username: 'grower', secret: ROUTE_SECRET }) }, params: { zone_id: '11' }, body },
      payload: {},
    },
    env: { AUTH_TOKEN_SECRET: ROUTE_SECRET },
    db,
  });
  return run.result;
}

function storedZone(db) {
  return { ...db.prepare('SELECT phenological_stage, stage_started_on, sync_version FROM irrigation_zones WHERE id = 11').get() };
}

// Today in a timezone, read the way the node reads it. A test reads it before and
// after a call and accepts either, so a midnight during the run cannot fail it.
function localToday(timezone) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

test('zone-config-fn sets a valid start date, bumps sync_version and returns it; the snake-case key works too', async () => {
  const db = routeDb({ startedOn: null });
  try {
    const response = await putConfig(db, { stageStartedOn: '2026-05-01' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(storedZone(db), { phenological_stage: 'development', stage_started_on: '2026-05-01', sync_version: 4 });
    assert.equal(response.payload.stage_started_on, '2026-05-01');
    assert.equal((await putConfig(db, { stage_started_on: '2026-06-02' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-06-02');
  } finally {
    db.close();
  }
});

test('zone-config-fn clears the date for null and empty, and refuses anything that is not a calendar date', async () => {
  const db = routeDb();
  try {
    assert.equal((await putConfig(db, { stageStartedOn: null })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, null);
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01' WHERE id = 11");
    assert.equal((await putConfig(db, { stageStartedOn: '' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, null);
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01', sync_version = 3 WHERE id = 11");
    for (const bad of ['2026-02-30', '05/01/2026', '2026-5-1', 'yesterday', 20260501]) {
      const response = await putConfig(db, { stageStartedOn: bad, notes: 'not saved' });
      assert.equal(response.statusCode, 400, String(bad));
      assert.deepEqual(response.payload, { error: 'stageStartedOn must be YYYY-MM-DD or null' });
    }
    assert.deepEqual(storedZone(db), { phenological_stage: 'development', stage_started_on: '2026-05-01', sync_version: 3 });
  } finally {
    db.close();
  }
});

test('zone-config-fn: a change from a set stage to unset clears the date, whatever the request says about it', async () => {
  const db = routeDb();
  try {
    assert.equal((await putConfig(db, { phenologicalStage: 'default', stageStartedOn: '2026-05-01' })).statusCode, 200);
    assert.deepEqual(storedZone(db), { phenological_stage: 'default', stage_started_on: null, sync_version: 4 });
  } finally {
    db.close();
  }
  const legacy = routeDb({ stage: 'veraison' });
  try {
    assert.equal((await putConfig(legacy, { phenologicalStage: null })).statusCode, 200);
    assert.equal(storedZone(legacy).stage_started_on, null, 'a legacy stored key counts as set');
  } finally {
    legacy.close();
  }
});

test('zone-config-fn: an unrelated save keeps the date, also when it repeats the stored stage or an unset stage', async () => {
  const db = routeDb();
  try {
    assert.equal((await putConfig(db, { notes: 'north block' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-05-01');
    assert.equal((await putConfig(db, { phenologicalStage: 'development', notes: 'same stage' })).statusCode, 200);
    assert.deepEqual(storedZone(db), { phenological_stage: 'development', stage_started_on: '2026-05-01', sync_version: 5 });
  } finally {
    db.close();
  }
  const unset = routeDb({ stage: 'default', startedOn: '2026-04-01' });
  try {
    assert.equal((await putConfig(unset, { phenologicalStage: 'default', notes: 'x' })).statusCode, 200);
    assert.equal(storedZone(unset).stage_started_on, '2026-04-01', 'the stored stage was already unset: nothing to clear');
  } finally {
    unset.close();
  }
});

test('zone-config-fn: another set stage without a date starts on the zone-local today; the same stage keeps it; a supplied date wins', async () => {
  // Controller ruling on plan review E2 I2. A UTC+14 zone: its date, not the gateway's.
  const db = routeDb();
  try {
    db.exec("UPDATE irrigation_zones SET timezone = 'Pacific/Kiritimati' WHERE id = 11");
    const before = localToday('Pacific/Kiritimati');
    assert.equal((await putConfig(db, { phenologicalStage: 'late_season' })).statusCode, 200);
    assert.ok([before, localToday('Pacific/Kiritimati')].includes(storedZone(db).stage_started_on), storedZone(db).stage_started_on);
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-08-01' WHERE id = 11");
    assert.equal((await putConfig(db, { phenologicalStage: 'harvest', notes: 'harvest is late season' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-08-01', 'a legacy key of the same stage keeps the date');
    assert.equal((await putConfig(db, { phenologicalStage: 'mid_season', stageStartedOn: '2026-07-15' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-07-15', 'a supplied date wins');
  } finally {
    db.close();
  }
  // Unset to a set stage is a change too; the request's timezone wins over the stored one.
  const unset = routeDb({ stage: 'default', startedOn: null });
  try {
    const before = localToday('Pacific/Kiritimati');
    assert.equal((await putConfig(unset, { phenologicalStage: 'initial', timezone: 'Pacific/Kiritimati' })).statusCode, 200);
    assert.ok([before, localToday('Pacific/Kiritimati')].includes(storedZone(unset).stage_started_on), storedZone(unset).stage_started_on);
  } finally {
    unset.close();
  }
});

test('the zone list returns stage_started_on', async () => {
  const db = routeDb();
  try {
    const query = await executeFunction(loadNode('get-zones-query'), { msg: { payload: [{ id: 7 }] }, env: {}, db });
    const response = await executeFunction(loadNode('get-zones-response'), { msg: query.result[0], env: {}, db });
    assert.equal(response.result.payload[0].stage_started_on, '2026-05-01');
    db.exec('UPDATE irrigation_zones SET stage_started_on = NULL WHERE id = 11');
    const again = await executeFunction(loadNode('get-zones-query'), { msg: { payload: [{ id: 7 }] }, env: {}, db });
    assert.equal((await executeFunction(loadNode('get-zones-response'), { msg: again.result[0], env: {}, db })).result.payload[0].stage_started_on, null);
  } finally {
    db.close();
  }
});

// The scheduled bootstrap snapshot carries the zone's stage start date, so a
// cloud that missed the event learns it within one bootstrap (spec B5).
async function bootstrapPayload(db) {
  // The bootstrap is built only for a cloud-linked account.
  db.exec("UPDATE users SET auth_mode = 'server', server_url = 'https://cloud.example.test', server_sync_token = 'fixture-token', user_uuid = COALESCE(user_uuid, '55555555-5555-4555-8555-555555555555') WHERE id = 7");
  const run = await executeFunction(loadNode('sync-bootstrap-build'), {
    msg: {},
    env: { DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'fixture', DEVICE_EUI_CONFIDENCE: 'authoritative' },
    db,
    osiLibModules: { installation: require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper') },
    globals: { fs: { existsSync: () => false, readFileSync: () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } } },
  });
  assert.ok(run.result && run.result.payload, 'the bootstrap node must build a payload: ' + run.warnings.join('; '));
  return run.result.payload;
}

test('the bootstrap snapshot carries stage_started_on and advertises zone_config_stage_started_on_v1', async () => {
  const db = routeDb();
  try {
    db.exec(`INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '${GATEWAY}', '2026-01-01')`);
    const payload = await bootstrapPayload(db);
    assert.equal(payload.zones.find((z) => z.zone_uuid === ZONE_UUID).stage_started_on, '2026-05-01');
    assert.ok(payload.gatewayIdentity.syncCapabilities.includes('zone_config_weather_source_v1'));
    assert.ok(payload.gatewayIdentity.syncCapabilities.includes('zone_config_stage_started_on_v1'));
    // An ordinary field: present on every zone, null when unset. weather_source keeps
    // sub-project 3's rule (absent while the zone is on 'auto').
    db.exec('UPDATE irrigation_zones SET stage_started_on = NULL WHERE id = 11');
    const unset = (await bootstrapPayload(db)).zones.find((z) => z.zone_uuid === ZONE_UUID);
    assert.ok(Object.prototype.hasOwnProperty.call(unset, 'stage_started_on') && unset.stage_started_on === null);
    assert.ok(!Object.prototype.hasOwnProperty.call(unset, 'weather_source'));
  } finally {
    db.close();
  }
});
