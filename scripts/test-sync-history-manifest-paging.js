'use strict';
// The 5-minute history manifest pages through every stored segment. Before the
// fix, Build History Manifest read `ORDER BY table_name, segment_key LIMIT 500`
// with no cursor, so a gateway with more than 500 segments sent the same first
// 500 every time and a segment after them was never compared or repaired.
// Runs the shipped Build / POST / Mark History Manifest and Build / POST / Mark
// History Batch bodies of both profiles on real SQLite (node:sqlite) against the
// harness's fake cloud. Identifiers are obviously synthetic: the gateway uses the
// AGENTS.md example EUI (the node needs a 16-hex gateway), the sensor a plain label.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PROFILES, createHarness } = require('./history-sync-flow-harness');

const root = path.resolve(__dirname, '..');
const GATEWAY = 'AABBCCDDEEFF0011';
const SENSOR = 'TEST-SENSOR-01';
const PAGE = 500;
// Repair keys queued per manifest answer, and pending per table, before a
// mismatching segment is left for the next pass.
const REPAIR_CAP = 2000;
// SHA-256 of no rows: what the cloud computes for a segment it holds nothing of.
const EMPTY_HASH = crypto.createHash('sha256').digest('hex');

function seedBase(db) {
  db.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  db.prepare("INSERT INTO users(id,username,password_hash,user_uuid,server_url,server_sync_token,created_at) VALUES(1,'fixture','x','fixture-user','https://cloud.invalid','fixture-token','2026-08-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,gateway_device_eui) VALUES(?,?,'DRAGINO_LSN50',1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',?)").run(SENSOR, 'Sensor', GATEWAY);
  db.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES('cloud',1,'https://cloud.invalid',?,'2026-08-01T00:00:00.000Z')").run(GATEWAY);
}

// `count` empty chameleon_readings segments, which sort before every
// device_data segment and match the cloud (no rows on either side).
function fillerSegments(db, count) {
  const insert = db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,quarantined_count,tombstone_count,covered_max_id,computed_at) VALUES('cloud','chameleon_readings',?,1,0,0,?,0,0,0,'2026-08-14T00:00:00.000Z')");
  const keys = [];
  for (let i = 0; i < count; i += 1) {
    const key = `FILLER-${String(i).padStart(5, "0")}|2026-07-01`;
    insert.run(key, EMPTY_HASH);
    keys.push('chameleon_readings|' + key);
  }
  return keys;
}

// One device_data day whose rows the cloud lacks: the manifest must request a
// repair, and the edge must queue every row of the day.
function missingDeviceDataSegment(db, helper) {
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1,dendro_valid) VALUES(?,?,?,?,1)');
  for (let i = 0; i < 6; i += 1) insert.run(9001 + i, SENSOR, new Date(Date.UTC(2026, 7, 20, 6 + i)).toISOString(), 21.5);
  const rows = db.prepare('SELECT * FROM device_data ORDER BY id').all();
  const segmentKey = helper.segmentKey('device_data', rows[0]);
  const manifest = helper.buildSegment('device_data', GATEWAY, segmentKey, rows).manifest;
  db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,quarantined_count,tombstone_count,covered_max_id,computed_at) VALUES('cloud','device_data',?,1,?,?,?,0,0,9006,'2026-08-21T00:00:00.000Z')")
    .run(segmentKey, manifest.canonicalRowCount, manifest.syncableRowCount, manifest.syncablePayloadHash);
  return { segmentKey, rowIds: rows.map((row) => row.id) };
}

function harness(t, profile, db) {
  t.after(() => db.close());
  return createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY }, start: '2026-10-19T02:00:00.000Z' });
}

const sent = (msg) => msg.payload.segments.map((s) => s.tableName + '|' + s.segmentKey);

for (const profile of PROFILES) {
  test(`${profile}: a segment after the first ${PAGE} is compared and its rows are queued for repair`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    fillerSegments(db, 1203);
    const target = missingDeviceDataSegment(db, h.helper);
    const requested = [];
    for (let i = 0; i < 4; i += 1) {
      assert.ok(await h.manifest(), `manifest ${i + 1} was posted`);
      requested.push(...h.cloud.manifests.at(-1));
      h.advance(300000);
    }
    assert.ok(requested.includes('device_data|' + target.segmentKey), 'the cloud saw the device_data segment and requested its repair');
    const queued = db.prepare("SELECT source_row_id AS id FROM sync_history_dirty_keys WHERE table_name='device_data' AND change_kind='repair' AND status='pending' ORDER BY source_row_id").all().map((row) => row.id);
    assert.deepEqual(queued, target.rowIds, 'every row of the segment is queued as a repair key');
  });

  test(`${profile}: pages are bounded, cover every segment once per pass and wrap to the start`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    const all = fillerSegments(db, 1203);
    const pages = [];
    for (let i = 0; i < 4; i += 1) {
      const built = await h.invoke('sync-history-manifest-build', {});
      assert.ok(built, `page ${i + 1} built`);
      assert.ok(built.payload.segments.length <= PAGE, 'a request never carries more than ' + PAGE + ' segments');
      pages.push(sent(built));
    }
    assert.deepEqual(pages.map((p) => p.length), [500, 500, 203, 500]);
    assert.deepEqual([].concat(pages[0], pages[1], pages[2]), all, 'one pass sends every segment exactly once, in key order');
    assert.deepEqual(pages[3], pages[0], 'the pass after a short page starts again from the first segment');
  });

  test(`${profile}: an exact multiple of ${PAGE} wraps without an empty request`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    const all = fillerSegments(db, 1000);
    const lengths = [];
    const firsts = [];
    for (let i = 0; i < 3; i += 1) {
      const built = await h.invoke('sync-history-manifest-build', {});
      assert.ok(built, `page ${i + 1} built (no idle turn at the end of a pass)`);
      lengths.push(built.payload.segments.length);
      firsts.push(sent(built)[0]);
    }
    assert.deepEqual(lengths, [500, 500, 500]);
    assert.deepEqual(firsts, [all[0], all[500], all[0]]);
    assert.ok(h.memory.get('sync_state').lastHistoryManifestPassCompletedAt, 'a finished pass is visible in sync_state');
  });

  test(`${profile}: a cursor past the last segment (segments removed) restarts from the first`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    const all = fillerSegments(db, 700);
    assert.equal((await h.invoke('sync-history-manifest-build', {})).payload.segments.length, 500);
    db.prepare("DELETE FROM sync_history_segments WHERE segment_key >= ?").run(all[400].split('|').slice(1).join('|'));
    const built = await h.invoke('sync-history-manifest-build', {});
    assert.ok(built, 'the build restarts instead of going idle');
    assert.deepEqual(sent(built), all.slice(0, 400));
  });

  test(`${profile}: the protocol-1 manifest sends hash v1 segments only`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    fillerSegments(db, 499);
    const twin = db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,quarantined_count,tombstone_count,covered_max_id,computed_at) VALUES('cloud','device_data','TWIN|2026-08-20',?,0,0,?,0,0,0,'2026-08-21T00:00:00.000Z')");
    twin.run(1, EMPTY_HASH);
    twin.run(2, EMPTY_HASH);
    const first = await h.invoke('sync-history-manifest-build', {});
    const second = await h.invoke('sync-history-manifest-build', {});
    const tail = (msg) => msg.payload.segments.filter((s) => s.segmentKey === 'TWIN|2026-08-20').map((s) => s.hashVersion);
    assert.deepEqual([tail(first), tail(second)], [[1], [1]], 'a hash v2 row would make the cloud reject the page');
    assert.ok(first.payload.segments.every((s) => s.hashVersion === 1));
  });

  test(`${profile}: the cursor survives a Node-RED restart`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    const all = fillerSegments(db, 1100);
    assert.equal(sent(await h.invoke('sync-history-manifest-build', {}))[0], all[0]);
    // A restart: fresh flow context, same database.
    const restarted = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY }, start: '2026-10-19T02:05:00.000Z' });
    assert.equal(sent(await restarted.invoke('sync-history-manifest-build', {}))[0], all[500]);
    assert.equal(sent(await restarted.invoke('sync-history-manifest-build', {}))[0], all[1000]);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='history_manifest_cursor'").get().value, null, 'a finished pass clears the stored cursor');
  });

  test(`${profile}: a failed or rejected page does not stall the pass`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    const all = fillerSegments(db, 1100);
    const first = await h.invoke('sync-history-manifest-build', {});
    // The cloud is unreachable, then answers 400: the mark records the error.
    await h.invoke('sync-history-manifest-mark', Object.assign({}, first, { statusCode: 0, error: { message: 'offline' }, payload: null }));
    const second = await h.invoke('sync-history-manifest-build', {});
    await h.invoke('sync-history-manifest-mark', Object.assign({}, second, { statusCode: 400, payload: { error: 'bad request' } }));
    const third = await h.invoke('sync-history-manifest-build', {});
    assert.deepEqual([sent(first)[0], sent(second)[0], sent(third)[0]], [all[0], all[500], all[1000]]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_history_dirty_keys').get().n, 0, 'a failed page queues nothing');
  });

  test(`${profile}: the request keeps the protocol-1 shape an older cloud accepts`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    seedBase(db);
    fillerSegments(db, 3);
    const built = await h.invoke('sync-history-manifest-build', {});
    assert.match(built.url, /\/api\/v1\/sync\/edge\/history\/manifests$/, 'manifests never use the command path');
    assert.equal(built.headers['X-OSI-History-Protocol'], '1');
    assert.deepEqual(Object.keys(built.payload).sort(), ['gatewayDeviceEui', 'generatedAt', 'segments']);
    assert.deepEqual(Object.keys(built.payload.segments[0]).sort(), ['canonicalRowCount', 'hashVersion', 'quarantinedCount', 'segmentKey', 'syncablePayloadHash', 'syncableRowCount', 'tableName', 'tombstoneCount']);
    // A gateway at or below one page sends the same request every time, as before.
    const again = await h.invoke('sync-history-manifest-build', {});
    assert.deepEqual(sent(again), sent(built));
  });

  test(`${profile}: a large mismatch queues a bounded repair backlog`, async (t) => {
    const db = new DatabaseSync(':memory:');
    const h = harness(t, profile, db);
    const big = bigMismatch(db, h.helper);
    assert.ok(await h.manifest());
    const pending = () => db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='device_data' AND change_kind='repair' AND status='pending'").get().n;
    const first = pending();
    assert.ok(first >= REPAIR_CAP && first < REPAIR_CAP + big.rowsPerDay, `one answer queues at most ${REPAIR_CAP} keys plus one segment (queued ${first} of ${big.rows})`);
    assert.ok(h.memory.get('sync_state').lastHistoryManifestRepairSkipped > 0, 'the skipped segments are counted');
    assert.ok(await h.manifest());
    assert.equal(pending(), first, 'nothing more is queued while the table holds a full backlog');
  });

  test(`${profile}: a repair backlog does not hold back new history, and repair completes`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const h = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY }, manifestEvery: 10, start: '2026-10-19T02:00:00.000Z' });
    const big = bigMismatch(db, h.helper);
    // Fill the queue first, then a new row arrives.
    assert.ok(await h.manifest());
    db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1,dendro_valid) VALUES(?,?,?,?,1)').run(big.nextId, SENSOR, '2026-10-19T02:00:30.000Z', 30.5);
    const newKey = h.helper.prepareRow('device_data', GATEWAY, db.prepare('SELECT * FROM device_data WHERE id=?').get(big.nextId)).historyKey;
    let turns = 0;
    let deliveredAfterTurns = null;
    for (let i = 0; i < 400 && deliveredAfterTurns === null; i += 1) {
      const result = await h.tick();
      if (result.table === 'device_data') turns += 1;
      if (h.cloud.batches.some((b) => b.tableName === 'device_data' && b.phase === 'tail' && b.keys.includes(newKey))) deliveredAfterTurns = turns;
    }
    assert.ok(deliveredAfterTurns !== null && deliveredAfterTurns <= 2, `a new row goes out within two device_data turns (took ${deliveredAfterTurns})`);
    let done = false;
    for (let i = 0; i < 6000 && !done; i += 1) {
      await h.tick();
      if (i % 50 === 0) done = big.ids.every((id) => h.cloud.index.has('device_data\u0000' + h.helper.prepareRow('device_data', GATEWAY, { id }).historyKey));
    }
    done = big.ids.every((id) => h.cloud.index.has('device_data\u0000' + h.helper.prepareRow('device_data', GATEWAY, db.prepare('SELECT * FROM device_data WHERE id=?').get(id)).historyKey));
    assert.ok(done, 'every missing row reaches the cloud eventually');
    assert.deepEqual(h.cloud.batches.filter((b) => b.rejected), []);
  });
}

// 50 device_data days of 100 rows each that the cloud never received, every
// history table in tail state with nothing new: the first full pass after the
// paging fix meets this shape on a gateway whose later segments were never
// compared before.
function bigMismatch(db, helper) {
  seedBase(db);
  const rowsPerDay = 100;
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1,dendro_valid) VALUES(?,?,?,?,1)');
  const ids = [];
  let id = 1;
  for (let day = 0; day < 50; day += 1) {
    for (let k = 0; k < rowsPerDay; k += 1) {
      insert.run(id, SENSOR, new Date(Date.UTC(2026, 6, 1 + day) + k * 840000).toISOString(), 20 + (k % 7));
      ids.push(id);
      id += 1;
    }
  }
  const bySegment = new Map();
  for (const row of db.prepare('SELECT * FROM device_data ORDER BY id').all()) {
    const key = helper.segmentKey('device_data', row);
    if (!bySegment.has(key)) bySegment.set(key, []);
    bySegment.get(key).push(row);
  }
  const segment = db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,quarantined_count,tombstone_count,covered_max_id,computed_at) VALUES('cloud','device_data',?,1,?,?,?,0,0,?,'2026-08-21T00:00:00.000Z')");
  for (const [key, rows] of bySegment) {
    const manifest = helper.buildSegment('device_data', GATEWAY, key, rows).manifest;
    segment.run(key, manifest.canonicalRowCount, manifest.syncableRowCount, manifest.syncablePayloadHash, id - 1);
  }
  const cursor = db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,durable_enabled_at,backfill_completed_at,snapshot_high_id,snapshot_high_key,last_acked_id,last_acked_key) VALUES('cloud',?,'tail','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z',?,?,?,?)");
  for (const table of helper.tableNames()) {
    const high = table === 'device_data' ? String(id - 1) : '0';
    if (helper.cursorKind(table) === 'id') cursor.run(table, high, null, high, null);
    else cursor.run(table, null, '', null, '');
  }
  return { ids, rows: ids.length, rowsPerDay, nextId: id };
}
