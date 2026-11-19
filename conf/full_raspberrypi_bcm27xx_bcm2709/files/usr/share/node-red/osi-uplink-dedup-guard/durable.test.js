'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { eventKey, sdi12Key } = require('./durable');
const writer = require('../osi-device-writer');
const envelope = { deduplicationId: 'event-one', fCnt: 1, time: '2026-11-19T10:00:00Z' };

test('event identities separate decoder sources and rejoin events', () => {
  assert.notEqual(eventKey('kiwi', envelope), eventKey('lsn50', envelope));
  assert.notEqual(eventKey('kiwi', envelope), eventKey('kiwi', {...envelope, deduplicationId: 'rejoin-one'}));
  assert.equal(eventKey('kiwi', envelope), eventKey('kiwi', {...envelope, fCnt: 99}));
  assert.equal(eventKey('kiwi', {fCnt: 1}), null);
  assert.equal(eventKey('kiwi', {deduplicationId: {}, fCnt: {}}), null);
  assert.notEqual(eventKey('kiwi', {fCnt: 1, time: envelope.time}), eventKey('kiwi', {fCnt: 1, time: '2026-11-19T10:00:01Z'}));
});

test('multipart SDI12 identity is independent of arrival order', () => {
  const a = {event: envelope}, b = {event: {...envelope, deduplicationId: 'event-two'}};
  assert.equal(sdi12Key({frames: [a,b]}), sdi12Key({frames: [b,a]}));
  assert.equal(sdi12Key({frames: [{event: {fCnt: 1}}]}), null);
});

test('edge-local receipt never changes the history payload or hash', () => {
  const history = require('../osi-history-sync-helper');
  const row = {id:1,deveui:'A840410000000001',recorded_at:envelope.time,swt_1:23,swt_2:null,dendro_valid:null};
  const local = {...row,uplink_key:eventKey('kiwi',envelope)};
  const before = history.prepareRow('device_data','0016C001F1000001',row);
  const after = history.prepareRow('device_data','0016C001F1000001',local);
  assert.deepEqual(after,before);
  assert.ok(local.uplink_key,'the stored row remains untouched');
});

test('canonical insert deduplicates across module reload, preserves a rejoin and rolls back for retry', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE device_data(id INTEGER PRIMARY KEY, deveui TEXT, recorded_at TEXT, ambient_temperature REAL, uplink_key TEXT); CREATE UNIQUE INDEX uq_device_data_uplink ON device_data(deveui,uplink_key);');
  writer.resetColumnCache();
  const manifest = [{key:'ambient_temperature', edgeField:'ambient_temperature'}];
  const normalized = {recordedAt: envelope.time, channels: {ambient_temperature: 23}};
  const meta = {deveui:'A840410000000001', uplinkKey:eventKey('kiwi', envelope)};
  const first = writer.writeDeviceData(db, manifest, normalized, meta);
  delete require.cache[require.resolve('../osi-device-writer')];
  const restarted = require('../osi-device-writer');
  const duplicate = restarted.writeDeviceData(db, manifest, normalized, meta);
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.deviceDataId, first.deviceDataId);
  const newMeta = {...meta, uplinkKey:eventKey('kiwi', {...envelope, deduplicationId:'rejoin'})};
  db.exec('BEGIN');
  assert.equal(restarted.writeDeviceData(db, manifest, normalized, newMeta).inserted, true);
  db.exec('ROLLBACK');
  assert.equal(restarted.writeDeviceData(db, manifest, normalized, newMeta).inserted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 2);
  // Unkeyable legacy measurements cannot suppress each other.
  restarted.writeDeviceData(db, manifest, normalized, {deveui:meta.deveui});
  restarted.writeDeviceData(db, manifest, normalized, {deveui:meta.deveui});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 4);
  db.close();
});

test('async facade survives a database reopen and concurrent duplicate deliveries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'uplink-reopen-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'farming.db');
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE device_data(id INTEGER PRIMARY KEY,deveui TEXT,recorded_at TEXT,ambient_temperature REAL,uplink_key TEXT); CREATE UNIQUE INDEX uq_device_data_uplink ON device_data(deveui,uplink_key) WHERE uplink_key IS NOT NULL;');
  writer.resetColumnCache();
  const manifest = [{key:'ambient_temperature',edgeField:'ambient_temperature'}];
  const normalized = {recordedAt:envelope.time,channels:{ambient_temperature:21}};
  const meta = {deveui:'A840410000000001',uplinkKey:eventKey('uc512',envelope)};
  const facade = () => ({
    get:async(sql,params)=>db.prepare(sql).get(...(params||[])),
    all:async(sql,params)=>db.prepare(sql).all(...(params||[])),
    run:async(sql,params)=>db.prepare(sql).run(...(params||[]))
  });
  const results = await Promise.all([writer.writeDeviceData(facade(),manifest,normalized,meta),writer.writeDeviceData(facade(),manifest,normalized,meta)]);
  assert.equal(results.filter(result=>result.inserted).length,1);
  assert.equal(results.filter(result=>result.duplicate).length,1);
  db.close();
  db = new DatabaseSync(file);
  try {
    writer.resetColumnCache();
    assert.equal((await writer.writeDeviceData(facade(),manifest,normalized,meta)).duplicate,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,1);
    // A different event on an invalid schema must throw, not become a
    // successful duplicate through an overly broad INSERT OR IGNORE.
    db.exec("CREATE TRIGGER reject_temperature BEFORE INSERT ON device_data BEGIN SELECT RAISE(ABORT,'write failed'); END");
    const retryMeta = {...meta,uplinkKey:eventKey('uc512',{...envelope,deduplicationId:'retry-event'})};
    await assert.rejects(writer.writeDeviceData(facade(),manifest,normalized,retryMeta),/write failed/);
    db.exec('DROP TRIGGER reject_temperature');
    assert.equal((await writer.writeDeviceData(facade(),manifest,normalized,retryMeta)).inserted,true);
  } finally {db.close();}
});

test('additive migration preserves old rows and leaves them outside the partial indexes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE device_data(id INTEGER PRIMARY KEY,deveui TEXT,recorded_at TEXT); CREATE TABLE watermark_readings(deveui TEXT); CREATE TABLE sdi12_transmissions(deveui TEXT); INSERT INTO device_data(deveui,recorded_at) VALUES('sensor','same-time'),('sensor','same-time');");
    db.exec(fs.readFileSync(path.resolve(__dirname,'../../../../../../../database/migrations/ordered/0081__uplink_idempotency.sql'),'utf8'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data INDEXED BY uq_device_data_uplink WHERE uplink_key IS NOT NULL').get().n,0);
    for (const table of ['device_data','watermark_readings','sdi12_transmissions']) {
      assert.equal(db.prepare(`SELECT "unique" AS u,partial FROM pragma_index_list('${table}') WHERE name=?`).get(`uq_${table}_uplink`).u,1);
      assert.equal(db.prepare(`SELECT partial FROM pragma_index_list('${table}') WHERE name=?`).get(`uq_${table}_uplink`).partial,1);
    }
  } finally {db.close();}
});


test('review identity probe: device separation, rejoin, exact replay and original timestamp precision', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE device_data(id INTEGER PRIMARY KEY,deveui TEXT,recorded_at TEXT,ambient_temperature REAL,uplink_key TEXT); CREATE UNIQUE INDEX uq_device_data_uplink ON device_data(deveui,uplink_key) WHERE uplink_key IS NOT NULL');
  try {
    const manifest = [{key:'ambient_temperature',edgeField:'ambient_temperature'}];
    const normalized = {recordedAt:envelope.time,channels:{ambient_temperature:20}};
    const write = (deveui,event) => writer.writeDeviceData(db,manifest,normalized,{deveui,uplinkKey:eventKey('kiwi',event)});
    assert.equal(write('A840410000000001',envelope).inserted,true);
    assert.equal(write('A840410000000002',envelope).inserted,true);
    assert.equal(write('A840410000000001',{...envelope,deduplicationId:'rejoin'}).inserted,true);
    assert.equal(write('A840410000000001',envelope).duplicate,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,3);
    assert.notEqual(eventKey('kiwi',{fCnt:1,time:'2026-11-19T10:00:00.000001Z'}),
      eventKey('kiwi',{fCnt:1,time:'2026-11-19T10:00:00.000002Z'}));
    const guard = require('./index').createGuard();
    const identity = {source:'kiwi',devEui:'A840410000000001',event:{fCnt:1,time:envelope.time},receivedAtMs:1};
    assert.equal(guard.isDuplicateUplink(identity),false);
    assert.equal(guard.isDuplicateUplink({...identity,receivedAtMs:2}),true);
    assert.equal(guard.isDuplicateUplink({...identity,event:{fCnt:1,time:'2026-11-19T10:00:30Z'}}),false);
    assert.equal(require('./index').buildDedupKey(identity),identity.devEui+':'+eventKey('kiwi',identity.event));
  } finally {db.close();}
});

test('concurrent canonical redeliveries write unknown-channel quarantine once', async () => {
  const { facadeDb, seedTestDb } = require('../../../../../../../scripts/lib/flow-node-harness');
  const db = seedTestDb();
  try {
    const normalized = {recordedAt:envelope.time,channels:{},unknown:{unsupported_sensor:23}};
    const meta = {deveui:'WX1',uplinkKey:eventKey('uc512',envelope)};
    const results = await Promise.all([writer.writeDeviceData(facadeDb(db),[],normalized,meta),writer.writeDeviceData(facadeDb(db),[],normalized,meta)]);
    assert.equal(results.filter(r=>r.inserted).length,1);
    assert.equal(results.filter(r=>r.duplicate).length,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_quarantine').get().n,1);
  } finally {db.close();}
});


for (const asyncShape of [false,true]) {
  test('quarantine failure rolls back the canonical row and retries both: '+(asyncShape?'facade':'sync'), async () => {
    const { seedTestDb, facadeDb } = require('../../../../../../../scripts/lib/flow-node-harness');
    const db = seedTestDb();
    const handle = asyncShape ? facadeDb(db) : db;
    const manifest = [{key:'ambient_temperature',edgeField:'ambient_temperature'}];
    const meta = {deveui:'WX1',uplinkKey:eventKey('uc512',{deduplicationId:'quarantine-retry'})};
    const normalized = {recordedAt:envelope.time,channels:{ambient_temperature:20},unknown:{unknown_sensor:23}};
    const write = async () => writer.writeDeviceData(handle,manifest,normalized,meta);
    writer.resetColumnCache();
    try {
      db.exec("CREATE TRIGGER temporary_quarantine_failure BEFORE INSERT ON ingest_quarantine BEGIN SELECT RAISE(ABORT,'temporary quarantine write failure'); END");
      await assert.rejects(write(),/temporary quarantine write failure/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_quarantine').get().n,0);
      db.exec('DROP TRIGGER temporary_quarantine_failure');
      assert.equal((await write()).inserted,true);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_quarantine').get().n,1);
      assert.equal((await write()).duplicate,true);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_quarantine').get().n,1);
    } finally { db.close(); }
  });
}


test('sync atomic writer preserves an outer transaction and rolls back its own failed unit', () => {
  const { seedTestDb } = require('../../../../../../../scripts/lib/flow-node-harness');
  const db = seedTestDb();
  const meta = {deveui:'WX1',uplinkKey:eventKey('uc512',{deduplicationId:'sync-outer'})};
  const normalized = {recordedAt:envelope.time,unknown:{sync_unknown_sensor:23}};
  writer.resetColumnCache();
  try {
    db.exec('BEGIN IMMEDIATE');
    assert.equal(writer.writeDeviceData(db,[],normalized,meta).inserted,true);
    assert.equal(db.isTransaction,true,'the writer must not commit its caller transaction');
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_quarantine').get().n,0);
    db.exec("CREATE TRIGGER temporary_quarantine_failure BEFORE INSERT ON ingest_quarantine BEGIN SELECT RAISE(ABORT,'temporary failure'); END; BEGIN IMMEDIATE;");
    assert.throws(()=>writer.writeDeviceData(db,[],normalized,meta),/temporary failure/);
    assert.equal(db.isTransaction,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,0);
    db.exec("UPDATE devices SET name='caller work preserved' WHERE deveui='WX1'; COMMIT;");
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='WX1'").get().name,'caller work preserved');
  } finally {db.close();}
});
