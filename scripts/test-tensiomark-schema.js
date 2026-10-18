'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const migration = path.join(root, 'database/migrations/ordered/0074__tensiomark_observations.sql');
function assertObservationStorage(db) {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='tensiomark_observations'").get(), 'raw observations table must exist');
  db.exec("PRAGMA foreign_keys=ON; INSERT INTO device_data (deveui, recorded_at) VALUES ('A840410000000001','2026-10-15T12:00:00.000Z')");
  const data = db.prepare('SELECT id FROM device_data ORDER BY id DESC LIMIT 1').get();
  const insert = db.prepare('INSERT INTO tensiomark_observations (device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const raw = '1+16.11+0.000\r\n4+18.25+5.359\r\n';
  const args = [data.id,'A840410000000001','2026-10-15T12:00:00.000Z','2026-10-15T12:00:01.000Z',raw,null,'abc','{}','accepted','{"channels":{"swt_1":0.1},"disposition":"accepted"}'];
  insert.run(...args);
  assert.equal(db.prepare('SELECT device_data_id FROM tensiomark_observations').get().device_data_id,data.id);
  assert.throws(() => insert.run(...args.slice(0,8),'unrecognized',args[9]), /CHECK constraint failed/);
  db.prepare('DELETE FROM device_data WHERE id=?').run(data.id);
  const kept=db.prepare('SELECT * FROM tensiomark_observations').get();
  assert.equal(kept.device_data_id,null,'pruning canonical history preserves raw evidence');
  assert.equal(kept.raw_response,raw);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  const indexes=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tensiomark_observations'").all().map(r=>r.name);
  assert.ok(indexes.includes('idx_tensiomark_observations_device_data'));
  assert.ok(indexes.includes('idx_tensiomark_observations_device_time'));
}
test('fresh schema retains linked observations after canonical history pruning',()=>{
  const db=new DatabaseSync(':memory:');
  try { db.exec(fs.readFileSync(path.join(root,'database/seed-blank.sql'),'utf8')); db.exec("INSERT INTO devices (deveui,name,type_id,created_at,updated_at) VALUES ('A840410000000001','Test Tensiomark','DRAGINO_SDI12','2026-10-15','2026-10-15')"); assertObservationStorage(db); }
  finally { db.close(); }
});
test('additive upgrade preserves existing rows and applies idempotently',()=>{
  assert.ok(fs.existsSync(migration),'an ordered additive migration must exist');
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE device_data (id INTEGER PRIMARY KEY, deveui TEXT, recorded_at TEXT)');
    db.exec("INSERT INTO device_data VALUES (42,'A840410000000002','2026-10-14T12:00:00.000Z')");
    const sql=fs.readFileSync(migration,'utf8');
    assert.ok(sql.startsWith('-- risk: additive\n'));
    db.exec(sql); db.exec(sql);
    assert.equal(db.prepare('SELECT count(*) AS n FROM device_data WHERE id=42').get().n,1);
    assertObservationStorage(db);
  } finally { db.close(); }
});

const dirtyMigration = path.join(root, 'database/migrations/ordered/0075__tensiomark_observation_history.sql');
function observationDb() {
  const db=new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root,'database/seed-blank.sql'),'utf8'));
  db.exec("INSERT INTO devices (deveui,name,type_id,created_at,updated_at) VALUES ('A840410000000001','Test Tensiomark','DRAGINO_SDI12','2026-10-15','2026-10-15')");
  db.exec("INSERT INTO tensiomark_observations (id,device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json) VALUES (7,NULL,'A840410000000001','2026-10-15T12:00:00.000Z','2026-10-15T12:00:01.000Z','1+16.11+0.000\r\n',NULL,'abc','{}','accepted','{}')");
  return db;
}
test('0075 is additive and idempotent, and the seed carries its dirty-key trigger',()=>{
  const sql=fs.readFileSync(dirtyMigration,'utf8');
  assert.ok(sql.startsWith('-- risk: additive\n'));
  assert.match(sql,/CREATE TRIGGER IF NOT EXISTS trg_sync_tensiomark_observations_dirty_au/);
  const db=observationDb();
  try {
    db.exec(sql); db.exec(sql);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='trg_sync_tensiomark_observations_dirty_au'").get().n,1);
  } finally { db.close(); }
});
test('0075 queues an observation correction only for a linked gateway',()=>{
  const db=observationDb();
  try {
    db.exec("UPDATE tensiomark_observations SET normalized_json='{\"v\":1}' WHERE id=7");
    assert.equal(db.prepare("SELECT count(*) AS n FROM sync_history_dirty_keys WHERE table_name='tensiomark_observations'").get().n,0,'unlinked gateway queues nothing');
    db.exec("INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,server_url,updated_at) VALUES('cloud',1,'0016C001F1000001','https://cloud.invalid','2026-10-16T00:00:00Z')");
    db.exec("UPDATE tensiomark_observations SET normalized_json='{\"v\":2}' WHERE id=7");
    const key=db.prepare("SELECT * FROM sync_history_dirty_keys WHERE table_name='tensiomark_observations'").get();
    assert.equal(key.row_key,'TENSIOMARK_OBSERVATION|0016C001F1000001|7');
    assert.equal(key.change_kind,'correction');
    assert.equal(key.source_row_id,7);
    assert.equal(key.status,'pending');
    db.exec("UPDATE sync_history_dirty_keys SET status='done', attempts=2");
    db.exec("UPDATE tensiomark_observations SET normalized_json='{\"v\":3}' WHERE id=7");
    const again=db.prepare("SELECT status,attempts FROM sync_history_dirty_keys WHERE table_name='tensiomark_observations'").get();
    assert.deepEqual({...again},{status:'pending',attempts:0});
  } finally { db.close(); }
});
