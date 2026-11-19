'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const { PROFILES, createHarness } = require('./history-sync-flow-harness');
const GATEWAY = '0016C001F1000001';
const SENSOR = 'A840410000000001';
const key = id => `DEVICE_DATA|${GATEWAY}|${id}`;
const pending = db => db.prepare("SELECT COUNT(*) n FROM sync_history_dirty_keys WHERE table_name='device_data' AND status='pending'").get().n;
function fixture(t, profile, count = 300, extra = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(fs.readFileSync('database/seed-blank.sql', 'utf8'));
  db.prepare("INSERT INTO users(id,username,password_hash,user_uuid,server_url,server_sync_token,created_at) VALUES(1,'fixture','x','fixture','https://cloud.invalid','fixture-token','2026-11-01')").run();
  db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,gateway_device_eui,created_at,updated_at) VALUES(?,'fixture','DRAGINO_LSN50',1,?,'2026-11-01','2026-11-01')").run(SENSOR, GATEWAY);
  db.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES('cloud',1,'https://cloud.invalid',?,'2026-11-01')").run(GATEWAY);
  let radio;
  if (extra.includeRadio) {
    radio = new DatabaseSync(':memory:');
    t.after(() => radio.close());
    radio.exec('CREATE TABLE radio_uplinks(id INTEGER PRIMARY KEY,installation_uuid TEXT,deveui TEXT,recorded_at TEXT,deduplication_id TEXT,metadata_json TEXT,dirty_generation INTEGER)');
    db.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,recovery_state,created_at,updated_at) VALUES(1,'00000000-0000-4000-8000-000000000001',?,'ACTIVE','2026-07-01','2026-07-01')").run(GATEWAY);
  }
  const h = createHarness({ db, radio, profile, env: { DEVICE_EUI: GATEWAY, AUTH_TOKEN_SECRET: 'fixture-secret', OSI_RADIO_CAPTURE_ENABLED: extra.includeRadio ? '1' : '0' }, ...extra });
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(?,?,?,20)');
  db.exec('BEGIN');
  for (let id = 1; id <= count; id++) insert.run(id, SENSOR, new Date(Date.UTC(2026, 6, 1) + (id - 1) * 300000).toISOString());
  const groups = new Map();
  for (const row of db.prepare('SELECT * FROM device_data').all()) {
    const segment = h.helper.segmentKey('device_data', row);
    if (!groups.has(segment)) groups.set(segment, []);
    groups.get(segment).push(row);
  }
  const put = db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,computed_at) VALUES('cloud','device_data',?,1,?,?,?,'2026-11-01')");
  for (const [segment, values] of groups) {
    const m = h.helper.buildSegment('device_data', GATEWAY, segment, values).manifest;
    put.run(segment, m.canonicalRowCount, m.syncableRowCount, m.syncablePayloadHash);
  }
  const cursor = db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,durable_enabled_at,snapshot_high_id,last_acked_id,snapshot_high_key,last_acked_key) VALUES('cloud',?,'tail','2026-11-01','2026-11-01',?,?,?,?)");
  for (const table of h.helper.tableNames({ includeRadio: extra.includeRadio })) {
    const numeric = h.helper.cursorKind(table) === 'id';
    cursor.run(table, numeric ? (table === 'device_data' ? count : 0) : null, numeric ? (table === 'device_data' ? count : 0) : null, numeric ? null : '', numeric ? null : '');
  }
  db.exec('COMMIT');
  h.memory.set('history_sync_last_table', 'tensiomark_observations');
  return { db, h, insert };
}
function sqliteAdapter(db) {
  const q = async (sql, params = []) => db.prepare(sql).all(...params);
  return { q, transaction: async executor => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await executor({ all: q, get: async (sql, params = []) => db.prepare(sql).get(...params),
        run: async (sql, params = []) => db.prepare(sql).run(...params) });
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}
for (const profile of PROFILES) {
  for (const growing of [false, true]) {
    test(`${profile}: repair continuation reaches position 40 on a ${growing ? 'growing' : 'stable'} comparison page`, async t => {
      // Issue #691: append a later-sorting segment before every refresh, as in
      // the reviewer's five-round membership probe. No source rows are needed
      // to observe whether the worker reaches the target checkpoint.
      const { db, h } = fixture(t, profile, 0);
      const adapter = sqliteAdapter(db);
      const comparison = day => ({ tableName: 'device_data', segmentKey: SENSOR + '|' + day, repairRequested: true });
      const comparisons = Array.from({ length: 40 }, (_, i) => comparison(new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10)));
      const target = 'history_repair_segment:' + JSON.stringify(['device_data', comparisons[39].segmentKey]);
      for (let round = 0; round < 5; round++) {
        if (growing) comparisons.push(comparison(new Date(Date.UTC(2026, 7, 10 + round)).toISOString().slice(0, 10)));
        const result = await h.helper.queueManifestRepairs({ comparisons, db: adapter, q: adapter.q,
          sourceQuery: async () => [], now: '2026-11-19', gatewayEui: GATEWAY, clock: () => 0 });
        assert.ok(result.examinedSegments <= 32);
      }
      assert.ok(db.prepare('SELECT value FROM app_settings WHERE key=?').get(target), 'position 40 must be visited within five refreshes');
    });
  }
  test(`${profile}: repair continuation survives removals and reordering, wraps to earlier additions, and resets on relink`, async t => {
    const { db, h } = fixture(t, profile, 0);
    const adapter = sqliteAdapter(db);
    const comparison = day => ({ tableName: 'device_data', segmentKey: SENSOR + '|' + day, repairRequested: true });
    let comparisons = Array.from({ length: 40 }, (_, i) => comparison(new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10)));
    const checkpoint = c => 'history_repair_segment:' + JSON.stringify([c.tableName, c.segmentKey]);
    const call = (helper, scope = 'first-link') => helper.queueManifestRepairs({ comparisons, db: adapter, q: adapter.q,
      sourceQuery: async () => [], now: '2026-11-19', gatewayEui: GATEWAY, request: { scope }, clock: () => 0 });
    await call(h.helper);
    const target = comparisons[39];
    const removed = comparisons[31];
    const earlier = comparison('2026-06-30');
    comparisons = [earlier, ...comparisons.filter((c, i) => i >= 16 && c !== removed)].reverse();
    const restarted = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY } });
    const second = await call(restarted.helper);
    assert.equal(second.examinedSegments, 8, 'removed resume anchor still seeks to its successor');
    assert.ok(db.prepare('SELECT value FROM app_settings WHERE key=?').get(checkpoint(target)));
    assert.equal(db.prepare('SELECT value FROM app_settings WHERE key=?').get(checkpoint(earlier)), undefined, 'earlier addition waits for wrap');
    comparisons.push(comparison('2026-08-10'));
    await call(restarted.helper);
    assert.ok(db.prepare('SELECT value FROM app_settings WHERE key=?').get(checkpoint(earlier)), 'a completed page wraps even when later segments keep arriving');
    // Leave the cursor partway through a larger page, then change link scope.
    comparisons = Array.from({ length: 40 }, (_, i) => comparison(new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10)));
    await call(restarted.helper);
    const relinked = await call(restarted.helper, 'second-link');
    assert.equal(relinked.examinedSegments, 32, 'a new link starts at the beginning');
    const first = JSON.parse(db.prepare('SELECT value FROM app_settings WHERE key=?').get(checkpoint(comparisons[0])).value);
    assert.equal(first.scope, 'second-link');
  });
  test(`${profile}: rotating disjoint growing pages retain independent repair positions`, async t => {
    const { db, h } = fixture(t, profile, 0);
    const adapter = sqliteAdapter(db);
    const pages = [5, 8].map(month => Array.from({ length: 40 }, (_, i) => ({
      tableName: 'device_data', segmentKey: SENSOR + '|' + new Date(Date.UTC(2026, month, i + 1)).toISOString().slice(0, 10), repairRequested: true
    })));
    const targets = pages.map(page => 'history_repair_segment:' + JSON.stringify(['device_data', page[39].segmentKey]));
    for (let round = 0; round < 5; round++) {
      for (const [pageIndex, page] of pages.entries()) {
        page.push({ ...page[0], segmentKey: SENSOR + '|' + new Date(Date.UTC(2026, [5, 8][pageIndex], 41 + round)).toISOString().slice(0, 10) });
        await h.helper.queueManifestRepairs({ comparisons: page, db: adapter, q: adapter.q, sourceQuery: async () => [],
          now: '2026-11-19', gatewayEui: GATEWAY, request: { scope: 'same-link' }, clock: () => 0 });
      }
    }
    for (const target of targets) assert.ok(db.prepare('SELECT value FROM app_settings WHERE key=?').get(target), 'each disjoint page reaches position 40');
  });
  test(`${profile}: alternating overlapping pages visit position 96`, async t => {
    const { db, h } = fixture(t, profile, 0);
    const adapter = sqliteAdapter(db);
    const comparisons = Array.from({ length: 96 }, (_, i) => ({ tableName: 'device_data',
      segmentKey: SENSOR + '|' + new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), repairRequested: true }));
    for (let round = 0; round < 20; round++) for (const page of [comparisons.slice(0, 64), comparisons.slice(32, 96)]) {
      const result = await h.helper.queueManifestRepairs({ comparisons: page, db: adapter, q: adapter.q,
        sourceQuery: async () => [], now: '2026-11-19', gatewayEui: GATEWAY, request: { scope: 'same-link' }, clock: () => 0 });
      assert.ok(result.examinedSegments <= 32);
    }
    const target = 'history_repair_segment:' + JSON.stringify(['device_data', comparisons[95].segmentKey]);
    assert.ok(db.prepare('SELECT value FROM app_settings WHERE key=?').get(target), 'overlapping pages must reach position 96');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'history_repair_segment:%'").get().n, 96);
  });
  test(`${profile}: completed cursor ranges are pruned and lookup survives the charged clock`, async t => {
    const { db, h } = fixture(t, profile, 0);
    const adapter = sqliteAdapter(db);
    const call = (i, clock = () => 0) => h.helper.queueManifestRepairs({ comparisons: [{ tableName: 'device_data',
      segmentKey: SENSOR + '|' + new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), repairRequested: false, mismatchFields: [] }],
      db: adapter, q: adapter.q, sourceQuery: assert.fail, now: '2026-11-19', gatewayEui: GATEWAY, request: { scope: 'same-link' }, clock });
    for (let i = 0; i < 1000; i++) await call(i);
    let elapsed = 0;
    const result = await call(1000, () => (elapsed += 3));
    assert.equal(result.examinedSegments, 1, 'lookup must not consume the deadline before examining an unseen segment');
    const cursors = db.prepare("SELECT value FROM app_settings WHERE key GLOB 'history_repair_cursor:*'").all();
    assert.ok(cursors.reduce((n, row) => n + Buffer.byteLength(row.value), 0) <= 32768, 'cursor storage is bounded');
    assert.ok(cursors.every(row => JSON.parse(row.value).pages.length === 0), 'completed ranges are pruned');
  });
  test(`${profile}: cursor range overflow stays bounded and retains unfinished tails`, async t => {
    const { db, h } = fixture(t, profile, 0);
    const adapter = sqliteAdapter(db);
    const tails = [];
    const call = (comparisons, clock = () => 0) => h.helper.queueManifestRepairs({ comparisons, db: adapter, q: adapter.q,
      sourceQuery: async () => [], now: '2026-11-19', gatewayEui: GATEWAY, request: { scope: 'same-link' }, clock });
    for (let range = 0; range < 40; range++) {
      const comparisons = Array.from({ length: 40 }, (_, i) => ({ tableName: 'device_data',
        segmentKey: SENSOR + '|' + new Date(Date.UTC(2020, 0, range * 100 + i + 1)).toISOString().slice(0, 10), repairRequested: true }));
      tails.push(comparisons[39].segmentKey);
      await call(comparisons);
      const value = db.prepare("SELECT value FROM app_settings WHERE key='history_repair_cursor:v3'").get().value;
      const pages = JSON.parse(value).pages;
      assert.ok(pages.length <= 32);
      assert.ok(Buffer.byteLength(value) <= 32768);
      for (const tail of tails) assert.ok(pages.some(page => page.after[1] < tail && page.last[1] >= tail), 'compaction must retain every unfinished tail');
    }
    let elapsed = 0;
    const result = await call([{ tableName: 'device_data', segmentKey: SENSOR + '|2040-01-01', repairRequested: true }], () => (elapsed += 3));
    assert.equal(result.examinedSegments, 1, 'even a full cursor set leaves work budget under the charged clock');
  });
  test(`${profile}: more recurring pages than cursor slots still visit every unfinished tail`, async t => {
    const { db, h } = fixture(t, profile, 0);
    const adapter = sqliteAdapter(db);
    const pages = Array.from({ length: 40 }, (_, range) => Array.from({ length: 40 }, (_, i) => ({ tableName: 'device_data',
      segmentKey: SENSOR + '|' + new Date(Date.UTC(2020, 0, range * 100 + i + 1)).toISOString().slice(0, 10), repairRequested: true })));
    for (let round = 0; round < 20; round++) for (const comparisons of pages) {
      const result = await h.helper.queueManifestRepairs({ comparisons, db: adapter, q: adapter.q, sourceQuery: async () => [],
        now: '2026-11-19', gatewayEui: GATEWAY, request: { scope: 'same-link' }, clock: () => 0 });
      assert.ok(result.examinedSegments <= 32);
    }
    for (const page of pages) assert.ok(db.prepare('SELECT value FROM app_settings WHERE key=?').get(
      'history_repair_segment:' + JSON.stringify(['device_data', page[39].segmentKey])), 'compaction must allow every recurring tail to advance');
  });
  test(`${profile}: completed answers preserve active progress and remove legacy offsets in bounded batches`, async t => {
    const { db, h } = fixture(t, profile, 0);
    const adapter = sqliteAdapter(db);
    const comparisons = Array.from({ length: 40 }, (_, i) => ({ tableName: 'device_data',
      segmentKey: SENSOR + '|' + new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), repairRequested: true }));
    const call = page => h.helper.queueManifestRepairs({ comparisons: page, db: adapter, q: adapter.q,
      sourceQuery: async () => [], now: '2026-11-19', gatewayEui: GATEWAY, request: { scope: 'same-link' }, clock: () => 0 });
    await call(comparisons);
    const state = () => db.prepare("SELECT value FROM app_settings WHERE key='history_repair_cursor:v3'").get().value;
    const active = state();
    const put = db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)');
    for (let i = 0; i < 96; i++) put.run('history_repair_cursor:' + i.toString(16).padStart(64, '0'), '32');
    put.run('history_repair_cursor:v2', JSON.stringify({ scope: 'same-link', pages: Array.from({ length: 1000 }, () => ({ first: ['device_data', 'old'], last: ['device_data', 'old'], after: null })) }));
    const legacy = () => db.prepare("SELECT COUNT(*) n FROM app_settings WHERE key GLOB 'history_repair_cursor:*' AND key<>'history_repair_cursor:v3'").get().n;
    for (let i = 0; i < 1000; i++) {
      const before = legacy();
      await call([{ tableName: 'device_data', segmentKey: SENSOR + '|' + new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), repairRequested: false, mismatchFields: [] }]);
      assert.equal(before - legacy(), Math.min(before, 32), 'cleanup is bounded to 32 indexed keys per answer');
      assert.equal(state(), active, 'completed disjoint work must not displace an unfinished continuation');
    }
    assert.equal(legacy(), 0);
    await call(comparisons);
    assert.equal(JSON.parse(state()).pages.length, 0, 'completing the retained range prunes it');
    assert.ok(db.prepare('SELECT value FROM app_settings WHERE key=?').get('history_repair_segment:' + JSON.stringify(['device_data', comparisons[39].segmentKey])));
  });
  test(`${profile}: upgrade rechecks legacy done keys when the cloud reports a mismatch`, async t => {
    const { db, h } = fixture(t, profile, 3);
    db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status) VALUES('cloud','device_data',?,'repair','2026-07-01','done')").run(key(1));
    await h.manifest();
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)).status, 'pending');
    assert.equal(pending(db), 3, 'without per-key cloud evidence the whole mismatching segment queues');
  });
  test(`${profile}: unchanged manifest preserves done keys and retries across restart`, async t => {
    const { db, h } = fixture(t, profile);
    await h.manifest();
    await h.tick();
    const before = db.prepare("SELECT * FROM sync_history_dirty_keys WHERE status='done' ORDER BY row_key").all();
    assert.ok(before.length > 0);
    const waiting = db.prepare("SELECT row_key FROM sync_history_dirty_keys WHERE status='pending' LIMIT 1").get();
    db.prepare("UPDATE sync_history_dirty_keys SET attempts=2,next_attempt_at='2099-01-01',last_error='retry' WHERE row_key=?").run(waiting.row_key);
    const retry = db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(waiting.row_key);
    h.advance(300000);
    const restarted = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY } });
    // A gateway restart retains the remote cloud. A new empty fake cloud would
    // instead prove genuine cloud divergence for the fully ACKed second day.
    for (const [indexKey, hash] of h.cloud.index) {
      const [table, historyKey] = indexKey.split('\0');
      restarted.cloud.seed(table, historyKey, h.cloud.segments.get(indexKey), hash);
    }
    assert.equal(restarted.cloud.index.size, h.cloud.index.size);
    await restarted.manifest();
    assert.deepEqual(db.prepare("SELECT * FROM sync_history_dirty_keys WHERE status='done' ORDER BY row_key").all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(waiting.row_key), retry);
  });
  test(`${profile}: cloud divergence before first parity converges after the first repair generation drains`, async t => {
    // Independent review probe: corrupt the cloud after the last row ACK but
    // before any manifest has confirmed segment parity.
    const { db, h } = fixture(t, profile, 2);
    await h.manifest();
    await h.tick();
    assert.equal(pending(db), 0);
    const indexKey = 'device_data\0' + key(1);
    h.cloud.index.set(indexKey, 'cloud-payload-diverged');
    for (let i = 0; i < 4; i++) {
      h.advance(300000);
      await h.manifest();
      for (let j = 0; j < 10; j++) await h.tick();
    }
    const current = h.helper.prepareRow('device_data', GATEWAY, db.prepare('SELECT * FROM device_data WHERE id=1').get()).payloadHash;
    assert.equal(h.cloud.index.get(indexKey), current);
    assert.equal(pending(db), 0);
  });
  test(`${profile}: a manifest built before a row ACK cannot reopen the completed generation`, async t => {
    const { db, h } = fixture(t, profile, 2);
    await h.manifest();
    const built = await h.invoke('sync-history-manifest-build', {});
    const delayed = await h.invoke('sync-history-manifest-http', built);
    await h.tick();
    assert.equal(pending(db), 0);
    h.advance(300000);
    await h.invoke('sync-history-manifest-mark', delayed);
    assert.equal(pending(db), 0, 'a stale mismatch is not fresh cloud evidence');
  });
  test(`${profile}: delayed parity cannot erase a newer repair generation`, async t => {
    const { db, h } = fixture(t, profile, 2);
    await h.manifest(); await h.tick();
    const oldMatch = await h.invoke('sync-history-manifest-http', await h.invoke('sync-history-manifest-build', {}));
    h.cloud.index.set('device_data\0' + key(1), 'new-cloud-divergence');
    await h.manifest();
    assert.equal(pending(db), 2);
    const checkpoint = db.prepare("SELECT value FROM app_settings WHERE key LIKE 'history_repair_segment:%'").get().value;
    await h.invoke('sync-history-manifest-mark', oldMatch);
    assert.equal(pending(db), 2);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key LIKE 'history_repair_segment:%'").get().value, checkpoint);
  });
  test(`${profile}: persistent mismatches exhaust a bounded repair budget and are visible in progress`, async t => {
    const { db, h } = fixture(t, profile, 2, { fs: { existsSync: () => false } });
    for (let round = 0; round < 8; round++) {
      h.cloud.index.set('device_data\0' + key(1), 'persistent-cloud-divergence');
      await h.manifest();
      for (let j = 0; j < 10; j++) await h.tick();
      h.advance(300000);
    }
    assert.equal(h.cloud.batches.filter(b => b.phase === 'repair').length, 3);
    assert.equal(pending(db), 0);
    const counts = await h.helper.unresolvedRepairCounts(async sql => db.prepare(sql).all());
    assert.equal(counts.device_data, 1);
    const tokenPayload = Buffer.from(JSON.stringify({userId:1,username:'fixture'})).toString('base64url');
    const token = tokenPayload+'.'+crypto.createHmac('sha256','fixture-secret').update(tokenPayload).digest('base64url');
    const response = await h.invoke('sync-state-build',{req:{headers:{authorization:'Bearer '+token}}});
    assert.equal(response.statusCode,200);
    assert.equal(response.payload.historyRepairUnresolvedByTable.device_data,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_history_quarantine WHERE reason='manifest_repair_exhausted'").get().n, 1);
    // Verified parity clears the unresolved marker without deleting history.
    for (const row of db.prepare('SELECT * FROM device_data').all()) {
      const p = h.helper.prepareRow('device_data', GATEWAY, row);
      h.cloud.seed('device_data', p.historyKey, h.helper.segmentKey('device_data', row), p.payloadHash);
    }
    await h.manifest();
    assert.equal((await h.helper.unresolvedRepairCounts(async sql => db.prepare(sql).all())).device_data, 0);
  });
  test(`${profile}: relinking starts a fresh budget for a previously quarantined segment`, async t => {
    const { db,h }=fixture(t,profile,2);
    for(let round=0;round<5;round++) {
      h.cloud.index.set('device_data\0'+key(1),'persistent-divergence');
      await h.manifest();
      for(let tick=0;tick<10;tick++) await h.tick();
      h.advance(300000);
    }
    assert.equal((await h.helper.unresolvedRepairCounts(async sql=>db.prepare(sql).all())).device_data,1);
    db.exec("DELETE FROM sync_history_dirty_keys WHERE peer_node='cloud'");
    db.prepare("UPDATE users SET server_linked_at='2026-11-19T00:00:00.000Z' WHERE id=1").run();
    db.prepare("UPDATE sync_link_state SET cloud_user_id='new-fixture-account' WHERE peer_node='cloud'").run();
    const relinked=createHarness({db,profile,env:{DEVICE_EUI:GATEWAY}});
    await relinked.manifest();
    assert.equal(pending(db),2,'the new account is not blocked by the old account repair budget');
    assert.equal((await h.helper.unresolvedRepairCounts(async sql=>db.prepare(sql).all())).device_data,0);
  });
  for (const expiry of ['preparation', 'enqueue']) {
    test(`${profile}: deadline after relink clears the previous quarantine (${expiry})`, async t => {
      const { db, h } = fixture(t, profile, 2);
      const adapter = sqliteAdapter(db);
      const built = await h.invoke('sync-history-manifest-build', {});
      const segment = built.payload.segments[0];
      const checkpoint = 'history_repair_segment:' + JSON.stringify(['device_data', segment.segmentKey]);
      const fingerprint = JSON.stringify([segment.hashVersion, segment.canonicalRowCount, segment.syncablePayloadHash, segment.quarantinedCount, segment.tombstoneCount]);
      db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(checkpoint, JSON.stringify({ version: 2, scope: 'old-link', fingerprint, round: 3, budgetFailures: 3, unresolved: 'round_limit' }));
      db.prepare("INSERT INTO sync_history_quarantine(peer_node,table_name,history_key,reason,first_seen_at,last_seen_at) VALUES('cloud','device_data',?,'manifest_repair_exhausted','2026-11-01','2026-11-01')").run('REPAIR_SEGMENT|' + segment.segmentKey);
      let elapsed = 0;
      const request = built._historyManifest;
      const txDb = { transaction: executor => adapter.transaction(tx => executor({ ...tx, get: async (...args) => {
        const row = await tx.get(...args);
        if (expiry === 'enqueue' && args[0].includes('SELECT status FROM sync_history_dirty_keys')) elapsed = 2001;
        return row;
      } })) };
      const call = slow => h.helper.queueManifestRepairs({ comparisons: [{ tableName: 'device_data', segmentKey: segment.segmentKey, repairRequested: true }],
        db: slow ? txDb : adapter, q: adapter.q, sourceQuery: async (table, sql, params) => {
          if (slow && expiry === 'preparation') elapsed = 2001;
          return adapter.q(sql, params);
        }, now: new Date(h.now()).toISOString(), gatewayEui: GATEWAY, request, clock: () => elapsed });
      await call(true);
      const state = JSON.parse(db.prepare('SELECT value FROM app_settings WHERE key=?').get(checkpoint).value);
      assert.equal(state.scope, request.scope);
      assert.equal(state.budgetFailures, 1);
      assert.equal(state.unresolved, undefined, 'the old link quarantine must not suppress the new link');
      assert.equal((await h.helper.unresolvedRepairCounts(adapter.q)).device_data, 0);
      elapsed = 0;
      await call(false);
      assert.equal(pending(db), 2, 'the next response for the same content can enqueue');
    });
    test(`${profile}: deadline budget belongs to the attempted fingerprint (${expiry})`, async t => {
      const { db, h } = fixture(t, profile, 2);
      const adapter = sqliteAdapter(db);
      let elapsed = 0;
      let slow = true;
      let request;
      const txDb = { transaction: executor => adapter.transaction(tx => executor({ ...tx, get: async (...args) => {
        const row = await tx.get(...args);
        if (slow && expiry === 'enqueue' && args[0].includes('SELECT status FROM sync_history_dirty_keys')) elapsed = 2001;
        return row;
      } })) };
      const call = async () => {
        elapsed = 0;
        const rows = db.prepare('SELECT * FROM device_data').all();
        const segmentKey = h.helper.segmentKey('device_data', rows[0]);
        const manifest = h.helper.buildSegment('device_data', GATEWAY, segmentKey, rows).manifest;
        request = { scope: 'same-link', segments: [manifest] };
        await h.helper.queueManifestRepairs({ comparisons: [{ tableName: 'device_data', segmentKey, repairRequested: true }],
          db: txDb, q: adapter.q, sourceQuery: async (table, sql, params) => {
            if (slow && expiry === 'preparation') elapsed = 2001;
            return adapter.q(sql, params);
          }, now: new Date(h.now()).toISOString(), gatewayEui: GATEWAY, request, clock: () => elapsed });
      };
      const state = () => JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key LIKE 'history_repair_segment:%'").get().value);
      await call(); await call();
      assert.equal(state().budgetFailures, 2);
      const firstFingerprint = state().fingerprint;
      db.exec('UPDATE device_data SET swt_1=99 WHERE id=1');
      await call();
      assert.equal(state().budgetFailures, 1, 'F2 must not inherit two F1 deadline failures');
      assert.notEqual(state().fingerprint, firstFingerprint);
      assert.equal((await h.helper.unresolvedRepairCounts(adapter.q)).device_data, 0);
      await call(); await call();
      assert.equal(state().budgetFailures, 3, 'repeated timeouts for F2 exhaust its own budget');
      assert.equal(state().unresolved, 'work_deadline');
      const marker = db.prepare("SELECT payload_hash FROM sync_history_quarantine WHERE reason='manifest_repair_exhausted'").get();
      assert.equal(marker.payload_hash, crypto.createHash('sha256').update(state().fingerprint).digest('hex'));
    });
  }
  test(`${profile}: a partial or duplicate ACK fences only segments whose dirty keys completed`, async t => {
    const { db, h } = fixture(t, profile, 2);
    // Two adjacent IDs in different segments fit in one batch.
    db.exec("UPDATE device_data SET recorded_at='2026-07-02T00:00:00.000Z' WHERE id=2; DELETE FROM sync_history_segments; DELETE FROM sync_history_dirty_keys");
    const rows = db.prepare('SELECT * FROM device_data').all();
    for (const row of rows) {
      const segment = h.helper.buildSegment('device_data', GATEWAY, h.helper.segmentKey('device_data', row), [row]).manifest;
      db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,computed_at) VALUES('cloud','device_data',?,1,1,1,?,'2026-11-01')").run(segment.segmentKey, segment.syncablePayloadHash);
    }
    await h.manifest();
    const built = await h.invoke('sync-history-build', {});
    assert.equal(built._historyBatch.segmentKeys.length, 2);
    h.cloud.index.clear();
    const delayed = await h.invoke('sync-history-manifest-http', await h.invoke('sync-history-manifest-build', {}));
    const args = { batch: built._historyBatch, response: { results: [{ historyKey: key(1), status: 'APPLIED' }, { historyKey: key(2), status: 'RETRYABLE_ERROR' }] },
      tableName: 'device_data', gatewayEui: GATEWAY, sourceQuery: async (table, sql, params) => db.prepare(sql).all(...params), db: sqliteAdapter(db), manifestClock: h.memory.get('history_manifest_clock') };
    await h.helper.completeDirtyBatch(args);
    const states = () => db.prepare("SELECT value FROM app_settings WHERE key LIKE 'history_repair_segment:%' ORDER BY key").all().map(row => JSON.parse(row.value));
    assert.deepEqual(states().map(state => !!state.ackFence), [true, false]);
    const before = states();
    await h.helper.completeDirtyBatch({ ...args, manifestClock: { ...args.manifestClock, sequence: args.manifestClock.sequence + 1 } });
    assert.deepEqual(states(), before, 'a duplicate ACK that completes no key cannot move the fence');
    const oldRequest = states()[1].lastRequest.sequence;
    await h.invoke('sync-history-manifest-mark', delayed);
    assert.ok(states()[1].lastRequest.sequence > oldRequest, 'the retryable segment still processes its in-flight mismatch');
    assert.deepEqual(h.warnings, []);
  });
  test(`${profile}: an empty local segment with extra cloud rows also exhausts its repair budget`, async t => {
    const {db,h}=fixture(t,profile,2);
    await h.manifest();await h.tick();
    db.exec('DELETE FROM device_data');
    db.prepare("UPDATE sync_history_segments SET canonical_row_count=0,syncable_row_count=0,syncable_payload_hash=? WHERE table_name='device_data'").run(crypto.createHash('sha256').digest('hex'));
    for(let round=0;round<8;round++){h.advance(300000);await h.manifest();}
    assert.equal(pending(db),0);
    assert.equal((await h.helper.unresolvedRepairCounts(async sql=>db.prepare(sql).all())).device_data,1,'zero source rows must not reset the round counter forever');
    assert.equal(h.cloud.index.size,2,'the manifest never deletes cloud history');
  });
  test(`${profile}: changed segments requeue done rows and preserve UPDATE corrections`, async t => {
    const { db, h } = fixture(t, profile);
    await h.manifest();
    await h.tick();
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)).status, 'done');
    db.prepare('UPDATE device_data SET swt_1=37 WHERE id=1').run();
    const correction = db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(key(1));
    assert.equal(correction.status, 'pending');
    assert.equal(correction.change_kind, 'correction');
    h.advance(300000);
    await h.manifest();
    assert.deepEqual(db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)), correction);
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(2)).status, 'pending');
    for (let i = 0; i < 150 && pending(db); i++) await h.tick();
    assert.equal(pending(db), 0);
    assert.equal(h.cloud.index.get('device_data\0' + key(1)), h.helper.prepareRow('device_data', GATEWAY, db.prepare('SELECT * FROM device_data WHERE id=1').get()).payloadHash);
  });
  test(`${profile}: old ACK cannot consume an intervening correction`, async t => {
    const { db, h } = fixture(t, profile, 2);
    await h.manifest();
    const built = await h.invoke('sync-history-build', {});
    const answered = await h.invoke('sync-history-http', built);
    db.prepare('UPDATE device_data SET swt_1=99 WHERE id=1').run();
    // SQLite's timestamp granularity can give two updates the same dirty time.
    // The submitted payload hash must fence the ACK even in that case.
    db.prepare('UPDATE sync_history_dirty_keys SET changed_at=? WHERE row_key=?').run(built._historyBatch.dirtyVersions[key(1)], key(1));
    await h.invoke('sync-history-mark', answered);
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)).status, 'pending');
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(2)).status, 'done');
  });
  test(`${profile}: row-loading deadline shortens a batch and leaves the rest queued`, async t => {
    const { db, h } = fixture(t, profile, 300);
    await h.manifest();
    let elapsed = 0;
    const q = async (sql, params = []) => db.prepare(sql).all(...params);
    const loaded = await h.helper.loadDirtyRows({ q, tableName: 'device_data', now: new Date(h.now()).toISOString(), skipRepair: false,
      sourceQuery: async (table, sql, params) => { elapsed += 75; return q(sql, params); },
      clock: () => elapsed, node: { warn: assert.fail }, setSyncState: assert.fail });
    assert.equal(loaded.rows.length, 3, 'stops after the first read crossing 200 ms');
    assert.equal(pending(db), 300, 'building never completes unsent keys');
  });
  for (const kind of ['repair', 'correction']) {
    test(`${profile}: a capacity-blocked ${kind} cannot starve following tables and is retried later`, async t => {
      // Round-two review probe: one backed-off key prevents atomic enqueue of
      // a 3,000-row segment, before unrelated device history on the same page.
      const { db, h } = fixture(t, profile, 1);
      const insert = db.prepare('INSERT INTO dendrometer_readings(id,deveui,position_um,recorded_at) VALUES(?,?,20,?)');
      db.exec('BEGIN');
      for (let id = 1; id <= 3000; id++) insert.run(id, SENSOR, '2026-07-01T00:00:00.000Z');
      db.exec('COMMIT');
      db.prepare("UPDATE sync_history_cursors SET snapshot_high_id=3000,last_acked_id=3000 WHERE table_name='dendrometer_readings'").run();
      const rows = db.prepare('SELECT * FROM dendrometer_readings').all();
      const blockedKey = h.helper.historyKey('dendrometer_readings', GATEWAY, rows[0]);
      const segment = h.helper.segmentKey('dendrometer_readings', rows[0]);
      const m = h.helper.buildSegment('dendrometer_readings', GATEWAY, segment, rows).manifest;
      db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,computed_at) VALUES('cloud','dendrometer_readings',?,1,?,?,?,'2026-11-01')").run(segment,m.canonicalRowCount,m.syncableRowCount,m.syncablePayloadHash);
      db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status,attempts,next_attempt_at,last_error) VALUES('cloud','dendrometer_readings',?,?,'2026-01-01','pending',2,'2099-01-01','retry')").run(blockedKey, kind);
      const waiting = db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(blockedKey);
      for (let cycle = 0; cycle < 8; cycle++) {
        await h.manifest();
        for (let tick = 0; tick < 10; tick++) await h.tick();
        h.advance(300000);
      }
      assert.ok(h.cloud.index.has('device_data\0' + key(1)), 'independent device history reaches the cloud while dendrometer waits for capacity');
      assert.deepEqual(db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(blockedKey), waiting, 'deferral preserves the pending correction or retry');
      assert.deepEqual(h.warnings, []);
      // Simulate the outstanding key finishing, then prove the deferred segment
      // remains eligible when a later manifest page wraps back to it.
      db.prepare("UPDATE sync_history_dirty_keys SET status='done',next_attempt_at=NULL WHERE row_key=?").run(blockedKey);
      for (let cycle = 0; cycle < 2; cycle++) { await h.manifest(); h.advance(300000); }
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_history_dirty_keys WHERE table_name='dendrometer_readings' AND status='pending'").get().n, 3000);
    });
  }
  test(`${profile}: progress reads use partial indexes with 100,000 completed keys`, async t => {
    const { db, h } = fixture(t, profile, 1);
    db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000) INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status) SELECT 'cloud','device_data','synthetic-'||i,'repair','2026-01-01','done' FROM n");
    db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status) VALUES('cloud','device_data','waiting','repair','2026-01-01','pending')").run();
    const plans = [];
    const q = async sql => {
      plans.push(...db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(r => r.detail));
      return db.prepare(sql).all();
    };
    assert.equal((await h.helper.pendingRepairCounts(q)).device_data, 1);
    assert.ok(plans.some(p => p.includes('idx_sync_history_pending')), plans.join('\n'));
    assert.ok(plans.every(p => !p.includes('sqlite_autoindex_sync_history_dirty_keys')), plans.join('\n'));
  });
  test(`${profile}: manifest budget charges 3,000 examined keys and continues past its first segments`, async t => {
    // Independent review probe: eleven unchanged mismatching segments with
    // completed keys. Work must be charged even when no new key is inserted.
    const { db, h } = fixture(t, profile, 3000);
    const groups = new Map();
    const put = db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status) VALUES('cloud','device_data',?,'repair','2026-07-01','done')");
    for (const row of db.prepare('SELECT * FROM device_data').all()) {
      put.run(h.helper.historyKey('device_data', GATEWAY, row));
      const segment = h.helper.segmentKey('device_data', row);
      if (!groups.has(segment)) groups.set(segment, []);
      groups.get(segment).push(row);
    }
    for (const [segment, rows] of groups) {
      const m = h.helper.buildSegment('device_data', GATEWAY, segment, rows).manifest;
      const fingerprint = JSON.stringify([m.hashVersion,m.canonicalRowCount,m.syncablePayloadHash,m.quarantinedCount,m.tombstoneCount]);
      db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run('history_repair_segment:'+JSON.stringify(['device_data',segment]), JSON.stringify({version:2,round:1,fingerprint}));
      // Every segment is actively repairing: unchanged refreshes enqueue zero
      // keys but must still charge hashing, source rows and dirty-key lookups.
      db.prepare("UPDATE sync_history_dirty_keys SET status='pending' WHERE row_key=?").run(h.helper.historyKey('device_data', GATEWAY, rows[0]));
    }
    const seen = new Set();
    const q = async (sql, params = []) => db.prepare(sql).all(...params);
    const adapter = { transaction: async executor => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = await executor({ all:q, get:async (sql, params = []) => {
          if (sql.includes('SELECT status FROM sync_history_dirty_keys')) seen.add(params[1]);
          return db.prepare(sql).get(...params);
        }, run:async (sql, params = []) => db.prepare(sql).run(...params) });
        db.exec('COMMIT'); return value;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } };
    const comparisons = [...groups.keys()].map(segmentKey => ({ tableName:'device_data',segmentKey,repairRequested:true }));
    const call = now => h.helper.queueManifestRepairs({ comparisons,db:adapter,q,sourceQuery:async (table,sql,params)=>q(sql,params),now,gatewayEui:GATEWAY,clock:()=>0 });
    const first = await call('2026-11-19T00:00:00.000Z');
    assert.ok(seen.size <= 2000, `examined ${seen.size} dirty keys`);
    assert.ok(first.examinedRows <= 2001);
    assert.ok(first.examinedSegments <= 32);
    assert.ok(first.repairSkipped > 0);
    assert.equal(first.repairCount, 0);
    await call('2026-11-19T00:05:00.000Z');
    assert.equal(seen.size, 3000, 'the second call continues instead of restarting at segment one');
  });
  test(`${profile}: manifest deadline defers a whole segment without a partial enqueue`, async t => {
    const { db, h } = fixture(t, profile, 300);
    const segmentKey = h.helper.segmentKey('device_data',db.prepare('SELECT * FROM device_data LIMIT 1').get());
    const q = async (sql, params = []) => db.prepare(sql).all(...params);
    const adapter = { transaction: async executor => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = await executor({ all:q,get:async (sql,params=[])=>db.prepare(sql).get(...params),run:async (sql,params=[])=>db.prepare(sql).run(...params) });
        db.exec('COMMIT'); return value;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } };
    let elapsed = 0;
    const args = { comparisons:[{tableName:'device_data',segmentKey,repairRequested:true}],db:adapter,q,now:'2026-11-19T00:00:00.000Z',gatewayEui:GATEWAY,clock:()=>elapsed };
    const first = await h.helper.queueManifestRepairs({ ...args,sourceQuery:async(table,sql,params)=>{ elapsed=2001;return q(sql,params); } });
    assert.equal(pending(db), 0);
    assert.ok(first.repairSkipped > 0);
    elapsed=0;
    await h.helper.queueManifestRepairs({ ...args,sourceQuery:async(table,sql,params)=>q(sql,params) });
    assert.equal(pending(db), 288, 'the deferred segment queues whole on the next call');
  });
  test(`${profile}: deadline inside the enqueue rolls back every key of the segment`, async t => {
    const { db, h } = fixture(t, profile, 20);
    const segmentKey = h.helper.segmentKey('device_data',db.prepare('SELECT * FROM device_data LIMIT 1').get());
    const q = async (sql,params=[])=>db.prepare(sql).all(...params);
    let elapsed=0;
    const adapter={transaction:async executor=>{
      db.exec('BEGIN IMMEDIATE');
      try {
        const value=await executor({all:q,get:async(sql,params=[])=>db.prepare(sql).get(...params),run:async(sql,params=[])=>{
          const result=db.prepare(sql).run(...params);
          if(sql.startsWith('INSERT INTO sync_history_dirty_keys')) elapsed+=750;
          return result;
        }});
        db.exec('COMMIT');return value;
      }catch(e){db.exec('ROLLBACK');throw e;}
    }};
    const result=await h.helper.queueManifestRepairs({comparisons:[{tableName:'device_data',segmentKey,repairRequested:true}],db:adapter,q,sourceQuery:async(table,sql,params)=>q(sql,params),now:'2026-11-19T00:00:00.000Z',gatewayEui:GATEWAY,clock:()=>elapsed});
    assert.equal(pending(db),0,'three tentative inserts roll back with the generation');
    assert.equal(result.repairCount,0);
    assert.ok(result.repairSkipped>0);
  });
  test(`${profile}: an over-limit segment is explicit unresolved work with no partial enqueue`, async t => {
    const { db, h } = fixture(t, profile, 10001);
    db.prepare("UPDATE device_data SET recorded_at='2026-07-01T00:00:00.000Z'").run();
    db.exec('DELETE FROM sync_history_dirty_keys');
    const segmentKey=SENSOR+'|2026-07-01';
    const q=async(sql,params=[])=>db.prepare(sql).all(...params);
    const adapter={transaction:async executor=>{
      db.exec('BEGIN IMMEDIATE');
      try { const value=await executor({all:q,get:async(sql,params=[])=>db.prepare(sql).get(...params),run:async(sql,params=[])=>db.prepare(sql).run(...params)}); db.exec('COMMIT');return value; }
      catch(e){db.exec('ROLLBACK');throw e;}
    }};
    const result=await h.helper.queueManifestRepairs({comparisons:[{tableName:'device_data',segmentKey,repairRequested:true}],db:adapter,q,sourceQuery:async(table,sql,params)=>q(sql,params),now:'2026-11-19T00:00:00.000Z',gatewayEui:GATEWAY,clock:()=>0});
    assert.equal(result.examinedRows,10001,'source read stops at the hard limit plus one lookahead');
    assert.equal(pending(db),0);
    assert.equal((await h.helper.unresolvedRepairCounts(q)).device_data,1);
  });
  test(`${profile}: repair checkpoint and dirty keys roll back together`, async t => {
    const { db, h } = fixture(t, profile, 3);
    db.exec("CREATE TEMP TRIGGER reject_test_key BEFORE INSERT ON sync_history_dirty_keys WHEN NEW.source_row_id=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await h.manifest();
    assert.equal(pending(db), 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'history_repair_segment:%'").get().n, 0);
    db.exec('DROP TRIGGER reject_test_key');
    await h.manifest();
    assert.equal(pending(db), 3);
  });
  test(`${profile}: clearing the dirty ledger for a relink queues missing keys despite an old checkpoint`, async t => {
    const { db, h } = fixture(t, profile, 2);
    await h.manifest();
    await h.tick();
    db.exec("DELETE FROM sync_history_dirty_keys WHERE peer_node='cloud'");
    const restarted = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY } });
    await restarted.manifest();
    assert.equal(pending(db), 2, 'new cloud lacks the rows');
  });
  test(`${profile}: authenticated sync state reports fresh pending repair counts`, async t => {
    const { db, h } = fixture(t, profile, 2, { fs: { existsSync: () => false } });
    await h.manifest();
    const payload = Buffer.from(JSON.stringify({ userId: 1, username: 'fixture' })).toString('base64url');
    const token = payload + '.' + crypto.createHmac('sha256', 'fixture-secret').update(payload).digest('base64url');
    const request = () => h.invoke('sync-state-build', { req: { headers: { authorization: 'Bearer ' + token } } });
    assert.equal((await h.invoke('sync-state-build', { req: { headers: {} } })).statusCode, 401);
    let response = await request();
    assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
    assert.equal(response.payload.historyRepairPendingByTable.device_data, 2);
    assert.equal(response.payload.historyRepairPendingByTable.radio_uplinks, 0);
    await h.tick();
    response = await request();
    assert.equal(response.payload.historyRepairPendingByTable.device_data, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_history_dirty_keys WHERE status='done'").get().n, 2);
  });
  test(`${profile}: manifest ACKs preserve every source history table through the delegated helper`, async t => {
    const { db, h } = fixture(t, profile, 2);
    const snapshot = () => Object.fromEntries(h.helper.tableNames().map(table => [table, db.prepare('SELECT * FROM ' + table).all()]));
    const before = snapshot();
    await h.manifest();
    assert.deepEqual(snapshot(), before, 'a mismatch only queues repair keys');
    await h.tick();
    await h.manifest();
    assert.deepEqual(snapshot(), before, 'parity only clears repair state');
    assert.deepEqual(h.warnings, []);
  });
  test(`${profile}: a radio manifest confirming parity preserves completed repairs`, async t => {
    const { db } = fixture(t, profile, 1);
    const radio = new DatabaseSync(':memory:');
    t.after(() => radio.close());
    radio.exec('CREATE TABLE radio_uplinks(id INTEGER PRIMARY KEY,installation_uuid TEXT,deveui TEXT,recorded_at TEXT,deduplication_id TEXT,metadata_json TEXT,dirty_generation INTEGER)');
    radio.prepare('INSERT INTO radio_uplinks VALUES(1,?,?,?,?,?,1)').run('00000000-0000-4000-8000-000000000001', SENSOR, '2026-07-01T00:00:00.000Z', 'fixture-dedup', '{"version":1,"receivers":[]}');
    db.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,recovery_state,created_at,updated_at) VALUES(1,'00000000-0000-4000-8000-000000000001',?,'ACTIVE','2026-07-01','2026-07-01')").run(GATEWAY);
    db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,snapshot_high_id,last_acked_id) VALUES('cloud','radio_uplinks','tail','2026-07-01',1,1)").run();
    const h = createHarness({ db, radio, profile, env: { DEVICE_EUI: GATEWAY, OSI_RADIO_CAPTURE_ENABLED: '1' }, lastTable: 'tensiomark_observations' });
    const comparison = { tableName: 'radio_uplinks', segmentKey: SENSOR + '|2026-07-01', repairRequested: true };
    const mark = () => h.invoke('sync-history-manifest-mark', { statusCode: 200, payload: { segments: [comparison] } });
    await mark();
    db.prepare("INSERT INTO radio_history_bridge(history_key,generation,status) VALUES(?,1,'transferred')").run(`RADIO_UPLINK|${GATEWAY}|1`);
    await h.tick();
    const status = () => db.prepare("SELECT status FROM sync_history_dirty_keys WHERE table_name='radio_uplinks'").get().status;
    assert.equal(status(), 'done');
    h.advance(300000);
    const manifest = await h.invoke('sync-history-manifest-build', {});
    assert.ok(manifest.payload.segments.some(segment => segment.tableName === 'radio_uplinks' && segment.segmentKey === comparison.segmentKey), 'the ACK publishes the radio segment to the manifest cache');
    const answered = await h.invoke('sync-history-manifest-http', manifest);
    const radioComparison = answered.payload.segments.find(segment => segment.tableName === 'radio_uplinks' && segment.segmentKey === comparison.segmentKey);
    assert.ok(radioComparison, 'the cloud compared the expected radio segment');
    assert.deepEqual(radioComparison.mismatchFields, []);
    assert.equal(radioComparison.repairRequested, false);
    await h.invoke('sync-history-manifest-mark', answered);
    assert.equal(status(), 'done');
    radio.exec("UPDATE radio_uplinks SET metadata_json='{\"version\":1,\"receivers\":[],\"changed\":true}',dirty_generation=2");
    await mark();
    assert.equal(status(), 'pending', 'a different radio payload is repaired');
    assert.deepEqual(h.warnings, []);
  });
  test(`${profile}: 10,000 repairs converge in 800 ticks with refreshes and continuous tail`, async t => {
    // Simulate an arbitrarily slow runner clock. The scheduling assertion must
    // use its injected helper clock; separate tests cover cooperative deadlines.
    let runnerTime = 0;
    t.mock.method(performance, 'now', () => (runnerTime += 201));
    const { db, h, insert } = fixture(t, profile, 10000, { manifestEvery: 10, includeRadio: true, helperClock: () => 0 });
    const tables = h.helper.tableNames({ includeRadio: true });
    assert.equal(tables.length, 10);
    let visits = 0;
    let liveId = 10000;
    for (let tick = 0; tick < 800; tick++) {
      if (h.helper.nextTable(h.memory.get('history_sync_last_table'), tables) === 'device_data') {
        visits++;
        insert.run(++liveId, SENSOR, new Date(Date.UTC(2026, 10, 1) + visits * 300000).toISOString());
      }
      await h.tick();
      const batches = h.cloud.batches.filter(b => b.tableName === 'device_data');
      if (batches.length >= 2) assert.ok(!batches.slice(-2).every(b => b.phase === 'repair'), 'waiting tail is served between repairs');
      const done = db.prepare("SELECT COUNT(*) n FROM sync_history_dirty_keys WHERE table_name='device_data' AND status='done'").get().n;
      if (done >= 10000 && pending(db) === 0) break;
    }
    assert.equal(pending(db), 0);
    for (let id = 1; id <= 10000; id++) assert.ok(h.cloud.index.has('device_data\0' + key(id)), `missing ${id}`);
    assert.ok(visits <= 80, `at most 80 table visits, got ${visits}`);
    const repaired = h.cloud.batches.filter(b => b.tableName === 'device_data' && b.phase === 'repair');
    assert.equal(repaired.length, 40);
    assert.equal(repaired.flatMap(b => b.keys).length, 10000, 'no repeated repair delivery');
    assert.deepEqual(h.cloud.batches.filter(b => b.rejected), []);
    assert.deepEqual(h.warnings, []);
  });
}
