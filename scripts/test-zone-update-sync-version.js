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
