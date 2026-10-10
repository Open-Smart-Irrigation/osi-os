'use strict';
// LoRain ingestion through the one writer node (lorain-ingest-fn + osi-rain):
// durable identity, atomic persistence, the contract fixtures replayed through
// the node, delayed and rejoined frames, and the verified-interval rate.
// Run: TZ=UTC node --test scripts/test-lorain-ingest.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadNode, executeFunction, facadeDb, seedTestDb } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const NODE_RED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const R = require(path.join(NODE_RED, 'osi-rain/index.js'));
const FIXTURE_DIR = path.join(ROOT, 'scripts/fixtures/lorain-rain');
const CODEC = path.join(NODE_RED, 'codecs/aquascope_lorain_decoder.js');
const EUI = 'A840410000000001';
const GATEWAY = '0016C001F1000001';

function decoder() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODEC, 'utf8'), sandbox, { filename: CODEC });
  return sandbox.decodeUplink;
}
const decodeUplink = decoder();
const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) }));
const fixture = (id) => fixtures.find((f) => f.id === id);

// Node-RED runs a function body as an AsyncFunction; the shared harness uses a plain Function.
function asyncNode(id) {
  const node = loadNode(id);
  return { ...node, func: 'return (async () => {\n' + node.func + '\n})();' };
}

function seed({ tz = 'UTC', linked = false } = {}) {
  const db = seedTestDb();
  db.exec(`UPDATE irrigation_zones SET timezone='${tz}' WHERE id=1;
    INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
    VALUES ('${EUI}','Gauge','AQUASCOPE_LORAIN',2,1,'2026-01-01','2026-01-01');`);
  if (linked) {
    db.exec(`INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at)
      VALUES ('cloud', 1, '${GATEWAY}', '2026-01-01T00:00:00.000Z');`);
  }
  return db;
}

function uplinkMsg(frame, extra = {}) {
  const bytes = frame.bytesHex ? Buffer.from(frame.bytesHex, 'hex') : null;
  const object = frame.object || decodeUplink({ fPort: frame.fPort, bytes }).data;
  const payload = {
    deviceInfo: { devEui: EUI.toLowerCase(), deviceProfileName: 'Aqua-Scope LoRain', applicationId: 'app-sensors' },
    devAddr: frame.devAddr, fCnt: frame.fCnt, time: frame.time, fPort: frame.fPort, object,
    ...(frame.deduplicationId === undefined ? {} : { deduplicationId: frame.deduplicationId }),
    ...(bytes ? { data: bytes.toString('base64') } : {}),
    ...extra,
  };
  return { payload };
}

async function ingest(db, frame, options = {}) {
  const out = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(frame), db, env: options.env || {}, libOverrides: options.libOverrides || {} });
  return out;
}

const count = (db, sql) => db.prepare(sql).get().n;
const rows = (db, sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));

test('duplicate delivery counts once (one observation, one device_data row, one outbox insertion)', async () => {
  const db = seed({ linked: true });
  const frame = fixture('wet-ordinary').frames[1];
  const first = await ingest(db, frame);
  const second = await ingest(db, frame);
  assert.deepEqual(first.errors.concat(second.errors), []);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 1);
  assert.equal(db.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get().rainfall_mm, 0.5);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE op='DEVICE_DATA_APPENDED'"), 1);
});

test('a confirmed-uplink retransmission (new deduplicationId, same session, fCnt and payload) is a duplicate', async () => {
  const db = seed();
  const frame = fixture('wet-ordinary').frames[1];
  await ingest(db, frame);
  await ingest(db, { ...frame, deduplicationId: '00000000-0000-4000-8000-000000000099', time: '2026-10-08T10:15:05.000Z' });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 1);
});

test('identity conflict is quarantined, not overwritten', async () => {
  const db = seed();
  const frame = fixture('wet-ordinary').frames[1];
  await ingest(db, frame);
  const digest = db.prepare('SELECT payload_digest FROM rain_observations').get().payload_digest;
  await ingest(db, { ...frame, bytesHex: '06030005060100b8068100041221000a' });
  const obs = rows(db, 'SELECT payload_digest, amount_mm FROM rain_observations');
  assert.deepEqual(obs, [{ payload_digest: digest, amount_mm: 0.5 }]);
  assert.deepEqual(rows(db, 'SELECT deveui, channel, reason FROM ingest_quarantine'),
    [{ deveui: EUI, channel: 'rain_observation', reason: 'identity_conflict' }]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 1);
});

test('failure between identity claim and persistence rolls back; the retry counts once', async () => {
  const db = seed({ linked: true });
  let failing = true;
  const facade = facadeDb(db);
  const faulty = {
    Database: function Database() {
      return {
        ...facade,
        transaction: (fn) => facade.transaction((t) => fn({
          ...t,
          run: (sql, params) => (failing && /^\s*INSERT INTO device_data/i.test(sql)
            ? Promise.reject(new Error('injected device_data failure')) : t.run(sql, params)),
        })),
      };
    },
  };
  const frame = fixture('wet-ordinary').frames[0];
  const first = await ingest(db, frame, { libOverrides: { osiDb: faulty } });
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /rolled back.*injected device_data failure/);
  for (const table of ['rain_observations', 'device_data', 'zone_daily_environment', 'sync_outbox']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} empty after the rollback`);
  }
  failing = false;
  const second = await ingest(db, frame, { libOverrides: { osiDb: faulty } });
  assert.deepEqual(second.errors, []);
  for (const table of ['rain_observations', 'device_data', 'zone_daily_environment']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table}`), 1, `${table} has one row after the retry`);
  }
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE op='DEVICE_DATA_APPENDED'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='ZONE_ENVIRONMENT'"), 1);
});

test('missing deduplicationId is ambiguous identity and never reaches the zone table', async () => {
  const db = seed();
  const frame = { ...fixture('wet-ordinary').frames[0] };
  delete frame.deduplicationId;
  await ingest(db, frame);
  assert.deepEqual(rows(db, 'SELECT event_id, status, tips FROM rain_observations'), [{ event_id: null, status: 'ambiguous_identity', tips: 2 }]);
  assert.deepEqual(rows(db, 'SELECT rain_mm_delta, rain_delta_status FROM device_data'), [{ rain_mm_delta: null, rain_delta_status: 'ambiguous_identity' }]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM zone_daily_environment'), 0);
});

test('a device of another type, or another profile, is ignored', async () => {
  const db = seed();
  db.exec(`UPDATE devices SET type_id='SENSECAP_S2120' WHERE deveui='${EUI}'`);
  await ingest(db, fixture('wet-ordinary').frames[0]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 0);
  const db2 = seed();
  const msg = uplinkMsg(fixture('wet-ordinary').frames[0]);
  msg.payload.deviceInfo.deviceProfileName = 'SenseCAP S2120';
  await executeFunction(asyncNode('lorain-ingest-fn'), { msg, db: db2 });
  assert.equal(count(db2, 'SELECT COUNT(*) AS n FROM rain_observations'), 0);
});

test('invalid tips are rejected; the device_data row keeps the diagnostic status (A10)', async () => {
  const db = seed();
  await ingest(db, { ...fixture('invalid-tips').frames[0] });
  assert.deepEqual(rows(db, 'SELECT status, tips, amount_mm, quality_reasons FROM rain_observations'),
    [{ status: 'rejected_invalid', tips: null, amount_mm: null, quality_reasons: '["invalid_tips","build_unpinned","session_reset","received_only"]' }]);
  assert.deepEqual(rows(db, 'SELECT rain_mm_delta, rain_tips_delta, rain_delta_status FROM device_data'),
    [{ rain_mm_delta: null, rain_tips_delta: null, rain_delta_status: 'invalid_rain_delta' }]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM zone_daily_environment'), 0);
});

// Every contract fixture through the node: after the replay each frame's
// stored state matches the fixture's received-only column (the shipped pinned
// set is empty, so nothing is promoted), and the zone day is the sum of the
// counted amounts.
for (const fx of fixtures) {
  test(`${fx.file}: replayed through the node`, async () => {
    const db = seed();
    for (const frame of fx.frames) {
      const out = await ingest(db, frame);
      assert.deepEqual(out.errors, [], frame.deduplicationId);
    }
    const stored = rows(db, 'SELECT o.*, dd.rain_mm_delta, dd.rain_delta_status FROM rain_observations o LEFT JOIN device_data dd ON dd.id = o.device_data_id ORDER BY o.id');
    const firsts = [];
    const seenEvents = new Set();
    const seenSlots = new Map();
    let expectedTotal = 0;
    for (const exp of fx.expect.observations) {
      const frame = fx.frames[exp.frameIndex];
      const slot = frame.devAddr + '/' + frame.fCnt;
      const repeat = seenEvents.has(frame.deduplicationId) || seenSlots.has(slot);
      seenEvents.add(frame.deduplicationId);
      if (!seenSlots.has(slot)) seenSlots.set(slot, true);
      if (repeat) continue;
      firsts.push(exp);
      if (exp.counted) expectedTotal += exp.amount_mm;
    }
    assert.equal(stored.length, firsts.length, 'one observation per distinct frame');
    const byEvent = new Map(stored.map((r) => [r.event_id, r]));
    for (const exp of firsts) {
      const row = byEvent.get(fx.frames[exp.frameIndex].deduplicationId);
      const where = `frame ${exp.frameIndex}`;
      assert.ok(row, where);
      assert.equal(row.status === 'accepted', exp.counted, `${where}: counted <=> accepted`);
      assert.equal(row.amount_mm, exp.amount_mm, `${where}: amount_mm`);
      assert.equal(row.rain_mm_delta, exp.counted ? exp.amount_mm : null, `${where}: device_data rain_mm_delta`);
      assert.equal(row.frame_kind, exp.frame_kind, `${where}: frame_kind`);
      assert.equal(row.interval_basis, exp.interval_basis, `${where}: interval_basis`);
      assert.equal(row.rain_mm_per_hour ?? null, null, `${where}: no rate without a verified interval`);
    }
    const conflicts = fx.expect.observations.filter((o) => o.reason === 'identity_conflict').length;
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM ingest_quarantine WHERE reason='identity_conflict'"), conflicts);
    const zone = rows(db, 'SELECT COALESCE(SUM(rainfall_mm), 0) AS mm, COUNT(*) AS n FROM zone_daily_environment WHERE zone_id=1')[0];
    assert.equal(Math.round(zone.mm * 10) / 10, Math.round(expectedTotal * 10) / 10, 'zone total = sum of counted amounts');
  });
}

test('a frame pair in one wake slot: the earlier frame is withdrawn from history and zone total (T10, t17)', async () => {
  const db = seed();
  const fx = fixture('button-same-slot');
  await ingest(db, fx.frames[0]);
  await ingest(db, fx.frames[1]);
  assert.equal(db.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1").get().rainfall_mm, 1.5);
  await ingest(db, fx.frames[2]);
  assert.equal(db.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1").get().rainfall_mm, 0.5);
  const dd = rows(db, 'SELECT rain_mm_delta, rain_delta_status FROM device_data ORDER BY id');
  assert.deepEqual(dd[1], { rain_mm_delta: null, rain_delta_status: 'overlap_unqualified' });
});

// Task 4 (A7): delayed distinct events and rejoined sessions keep their identity.
test('a delayed distinct frame is accepted once and its zone day gains its amount once (t06)', async () => {
  const db = seed();
  const fx = fixture('delayed-distinct');
  for (const frame of fx.frames) await ingest(db, frame);
  await ingest(db, fx.frames[2]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 3);
  assert.deepEqual(rows(db, 'SELECT status FROM rain_observations ORDER BY received_at').map((r) => r.status), ['accepted', 'accepted', 'accepted']);
  assert.equal(db.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get().rainfall_mm, 2);
});

test('a delayed frame from an earlier zone day lands in its own day (order-independent)', async () => {
  const db = seed({ tz: 'Europe/Zurich' });
  const late = { deduplicationId: '00000000-0000-4000-8000-000000000071', devAddr: '01000001', fCnt: 5, time: '2026-10-08T21:45:00.000Z', fPort: 2, bytesHex: '06030005060100b8068100021221000a' };
  const next = { deduplicationId: '00000000-0000-4000-8000-000000000072', devAddr: '01000001', fCnt: 6, time: '2026-10-08T22:00:01.000Z', fPort: 2, bytesHex: '06030005060100b8068100011221000a' };
  await ingest(db, next);
  await ingest(db, late);
  assert.deepEqual(rows(db, 'SELECT date, rainfall_mm FROM zone_daily_environment WHERE zone_id=1 ORDER BY date'),
    [{ date: '2026-10-08', rainfall_mm: 1 }, { date: '2026-10-09', rainfall_mm: 0.5 }]);
});

test('after a rejoin on a new devAddr with fCnt from 0 both sessions count; a repeat inside one hour is a duplicate (t07)', async () => {
  const db = seed();
  const fx = fixture('rejoin-fcnt-reuse');
  for (const frame of fx.frames) await ingest(db, frame);
  assert.deepEqual(rows(db, 'SELECT dev_addr, f_cnt, status, amount_mm FROM rain_observations ORDER BY received_at'), [
    { dev_addr: '01000001', f_cnt: 1, status: 'accepted', amount_mm: 0.5 },
    { dev_addr: '01000001', f_cnt: 2, status: 'accepted', amount_mm: 0.5 },
    { dev_addr: '01000002', f_cnt: 0, status: 'accepted', amount_mm: 0.5 },
    { dev_addr: '01000002', f_cnt: 1, status: 'accepted', amount_mm: 1 },
  ]);
  const reasons = JSON.parse(db.prepare("SELECT quality_reasons FROM rain_observations WHERE dev_addr='01000002' AND f_cnt=0").get().quality_reasons);
  assert.ok(reasons.includes('session_reset'));
  await ingest(db, { ...fx.frames[3], deduplicationId: '00000000-0000-4000-8000-000000000098', time: '2026-10-08T11:40:00.000Z' });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 4);
  assert.equal(db.prepare('SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1').get().rainfall_mm, 2.5);
});

// Task 5 (A2, A3): an average rate only over a protocol-verified interval.
async function ingestModule(db, frame, opts) {
  const facade = facadeDb(db);
  const msg = uplinkMsg(frame).payload;
  return facade.transaction((t) => R.ingestLoRainUplink(t, {
    deveui: EUI, eventId: msg.deduplicationId, devAddr: msg.devAddr, fCnt: msg.fCnt, time: msg.time, fPort: msg.fPort, data: msg.data, object: msg.object,
  }, { nowMs: Date.parse('2026-10-09T00:00:00.000Z'), ...opts }));
}
const PINNED = [{ fPort: 2, buildDate: '241015' }];
const JOIN_FRAME = { deduplicationId: '00000000-0000-4000-8000-000000000081', devAddr: '01000009', fCnt: 0, time: '2026-10-08T09:45:00.000Z', fPort: 2,
  // build date 241015, hardware, configuration reply 900 s / 16 wakes, zero rain
  bytesHex: '0a0003ad7703050001040403840402001006030000060100b8068100001221000a' };

test('0.5 mm over a verified 900-second interval is 2 mm/h, explicitly over 15 minutes (A2)', async () => {
  const db = seed();
  await ingestModule(db, JOIN_FRAME, { pinnedBuilds: PINNED });
  const wet = { deduplicationId: '00000000-0000-4000-8000-000000000082', devAddr: '01000009', fCnt: 1, time: '2026-10-08T10:00:01.000Z', fPort: 2,
    bytesHex: '06030000060100b8068100011221000a' };
  const result = await ingestModule(db, wet, { pinnedBuilds: PINNED });
  assert.equal(result.status, 'accepted');
  const obs = db.prepare('SELECT interval_basis, measured_start, measured_end, amount_mm FROM rain_observations WHERE id = ?').get(result.observationId);
  assert.deepEqual({ ...obs }, { interval_basis: 'protocol_verified', measured_start: '2026-10-08T09:45:01.000Z', measured_end: '2026-10-08T10:00:01.000Z', amount_mm: 0.5 });
  const dd = db.prepare('SELECT rain_mm_delta, rain_mm_per_hour, rain_mm_per_10min, counter_interval_seconds FROM device_data WHERE id = ?').get(result.deviceDataId);
  assert.deepEqual({ ...dd }, { rain_mm_delta: 0.5, rain_mm_per_hour: 2, rain_mm_per_10min: null, counter_interval_seconds: 900 });
});

test('unknown firmware and a 90-minute reception gap keep 0.5 mm without a rate or bounds (A3)', async () => {
  const db = seed();
  await ingestModule(db, JOIN_FRAME, {});
  const wet = { deduplicationId: '00000000-0000-4000-8000-000000000083', devAddr: '01000009', fCnt: 1, time: '2026-10-08T11:15:00.000Z', fPort: 2,
    bytesHex: '06030000060100b8068100011221000a' };
  const result = await ingestModule(db, wet, {});
  const obs = db.prepare('SELECT interval_basis, measured_start, measured_end, amount_mm FROM rain_observations WHERE id = ?').get(result.observationId);
  assert.deepEqual({ ...obs }, { interval_basis: 'unknown', measured_start: null, measured_end: null, amount_mm: 0.5 });
  const dd = db.prepare('SELECT rain_mm_delta, rain_mm_per_hour, rain_mm_per_10min, counter_interval_seconds FROM device_data WHERE id = ?').get(result.deviceDataId);
  assert.deepEqual({ ...dd }, { rain_mm_delta: 0.5, rain_mm_per_hour: null, rain_mm_per_10min: null, counter_interval_seconds: null });
});

test('the configuration query is off by default and never sent from the node unless enabled', async () => {
  const db = seed();
  const off = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(fixture('wet-ordinary').frames[0]), db });
  assert.equal(off.result, null);
  const db2 = seed();
  const on = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(fixture('wet-ordinary').frames[0]), db: db2, env: { OSI_LORAIN_CONFIG_QUERY: '1' } });
  assert.equal(on.result.topic, 'application/app-sensors/device/a840410000000001/command/down');
  assert.deepEqual(JSON.parse(on.result.payload), { devEui: 'a840410000000001', confirmed: false, fPort: 2, data: Buffer.from('000000000000000000000402040404030a00', 'hex').toString('base64') });
  const again = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(fixture('wet-ordinary').frames[1]), db: db2, env: { OSI_LORAIN_CONFIG_QUERY: '1' } });
  assert.equal(again.result, null, 'one query per gauge, never re-sent automatically');
  const db3 = seed();
  const port10 = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(fixture('fport10-unpinned').frames[0]), db: db3, env: { OSI_LORAIN_CONFIG_QUERY: '1' } });
  assert.equal(port10.result, null, 'no documented query form for the FPort-10 build');
});

// One query at commissioning and one after a firmware upgrade, never an
// automatic resend (contract, "Configuration query"). A query recorded before
// any 0x0A frame was seen covers the first build date observed afterwards.
test('a query recorded without a build date is not re-sent when the gauge rejoins with its build date', async () => {
  const db = seed();
  const env = { OSI_LORAIN_CONFIG_QUERY: '1' };
  const frames = [
    { deduplicationId: '00000000-0000-4000-8000-000000000091', devAddr: '01000005', fCnt: 40, time: '2026-10-08T08:00:00.000Z', fPort: 2, bytesHex: '06030005060100b8068100011221000a' },
    { deduplicationId: '00000000-0000-4000-8000-000000000092', devAddr: '01000005', fCnt: 41, time: '2026-10-08T08:15:01.000Z', fPort: 2, bytesHex: '06030005060100b8068100011221000a' },
    // rejoin: new session, the post-join frame carries the stock build date 241015 and still no 0x04 reply
    { deduplicationId: '00000000-0000-4000-8000-000000000093', devAddr: '01000006', fCnt: 0, time: '2026-10-08T10:00:00.000Z', fPort: 2, bytesHex: '0a0003ad770305000106030000060100b8068100011221000a' },
    { deduplicationId: '00000000-0000-4000-8000-000000000094', devAddr: '01000006', fCnt: 1, time: '2026-10-08T10:15:01.000Z', fPort: 2, bytesHex: '06030000060100b8068100011221000a' },
  ];
  const sends = [];
  for (const frame of frames) {
    const out = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(frame), db, env });
    assert.deepEqual(out.errors, []);
    sends.push(out.result !== null);
  }
  assert.deepEqual(sends, [true, false, false, false]);
  // A real upgrade (a recorded build date changes to another one) allows one more query.
  const upgrade = { deduplicationId: '00000000-0000-4000-8000-000000000095', devAddr: '01000007', fCnt: 0, time: '2026-10-08T12:00:00.000Z', fPort: 2,
    bytesHex: '0a0003d0a50305000106030000060100b8068100011221000a' };
  const after = { deduplicationId: '00000000-0000-4000-8000-000000000096', devAddr: '01000007', fCnt: 1, time: '2026-10-08T12:15:01.000Z', fPort: 2,
    bytesHex: '06030000060100b8068100011221000a' };
  const up1 = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(upgrade), db, env });
  const up2 = await executeFunction(asyncNode('lorain-ingest-fn'), { msg: uplinkMsg(after), db, env });
  assert.deepEqual([up1.result !== null, up2.result !== null], [true, false]);
});
