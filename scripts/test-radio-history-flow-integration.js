'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const helper = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper');
const flows = JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'));
const gateway = '0011223344556677';
const installation = '00000000-0000-4000-8000-000000000001';
const key = `RADIO_UPLINK|${gateway}|1`;
function fixture(t) {
  const farming = new DatabaseSync(':memory:');
  const radio = new DatabaseSync(':memory:');
  t.after(() => { farming.close(); radio.close(); });
  farming.exec(fs.readFileSync('database/seed-blank.sql','utf8'));
  farming.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,recovery_state,created_at,updated_at) VALUES(1,?,?,'ACTIVE','2026-09-10','2026-09-10')").run(installation,gateway);
  farming.prepare("INSERT INTO users(id,username,password_hash,user_uuid,server_url,server_sync_token,created_at) VALUES(1,'fixture','x','fixture','https://test.invalid','test-token','2026-09-10')").run();
  farming.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES('cloud',1,'https://test.invalid',?,'2026-09-10') ON CONFLICT(peer_node) DO UPDATE SET linked=1,server_url=excluded.server_url,gateway_device_eui=excluded.gateway_device_eui").run(gateway);
  farming.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,snapshot_high_id,last_acked_id) VALUES('cloud','radio_uplinks','tail','2026-09-10','1','1')").run();
  farming.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,source_row_id,changed_at,status) VALUES('cloud','radio_uplinks',?,'correction',1,'2026-09-10','pending')").run(key);
  farming.prepare("INSERT INTO radio_history_bridge(history_key,generation,status) VALUES(?,2,'transferred')").run(key);
  radio.exec('CREATE TABLE radio_uplinks(id INTEGER PRIMARY KEY,installation_uuid TEXT,deveui TEXT,recorded_at TEXT,deduplication_id TEXT,metadata_json TEXT,dirty_generation INTEGER)');
  radio.prepare('INSERT INTO radio_uplinks VALUES(1,?,?,?,?,?,2)').run(installation,'AABBCCDDEEFF0011','2026-09-10T10:00:00.000Z','native-1',JSON.stringify({version:1,receivers:[]}));
  const memory = new Map([['history_sync_last_table',helper.tableNames({includeRadio:true}).at(-2)]]);
  const warnings = [];
  let reads = 0;
  class Database {
    all(sql,params,cb) { try { cb(null,farming.prepare(sql).all(...params)); } catch(e) { cb(e); } }
    run(sql,params,cb) { try { farming.prepare(sql).run(...params); cb(null); } catch(e) { cb(e); } }
    close(cb) { if(cb)cb(); }
  }
  const source = { all:async(sql,params=[])=>{ reads++; return radio.prepare(sql).all(...params); },bridgeDirty:async()=>{} };
  const env = { get:n=>({OSI_RADIO_CAPTURE_ENABLED:'1',DEVICE_EUI:gateway})[n] };
  async function invoke(id,msg) {
    const context={msg,env,osiDb:{Database},osiLib:{require:n=>({ok:true,value:n==='history-sync'?helper:{getSharedStore:async()=>source}})},flow:{get:k=>memory.get(k),set:(k,v)=>memory.set(k,v)},node:{warn:x=>warnings.push(x),error:x=>warnings.push(x)}};
    return vm.runInNewContext('(async function(){'+flows.find(n=>n.id===id).func+'})',context)();
  }
  return {farming,radio,memory,warnings,invoke,reads:()=>reads};
}
test('real flow reads radio source and leaves a newer dirty generation pending after old ACK',async t=>{
  const f=fixture(t);
  // Radio is appended to the registry; choose its actual predecessor.
  const tables=helper.tableNames({includeRadio:true});
  f.memory.set('history_sync_last_table',tables[(tables.indexOf('radio_uplinks')+tables.length-1)%tables.length]);
  const batch=await f.invoke('sync-history-build',{});
  assert.deepEqual(f.warnings,[]);
  assert.ok(batch); assert.equal(batch.historyTable,'radio_uplinks');
  assert.equal(batch._historyBatch.dirtyGenerations[key],2); assert.equal(batch.payload.rows.length,1);
  f.farming.prepare('UPDATE radio_history_bridge SET generation=3 WHERE history_key=?').run(key);
  f.radio.exec('UPDATE radio_uplinks SET dirty_generation=3');
  batch.statusCode=200;
  batch.payload={phase:'correction',durableMirrorConfirmed:true,ackedThroughId:1,gatewayDeviceEui:gateway,results:[{historyKey:key,status:'UPDATED'}]};
  await f.invoke('sync-history-mark',batch);
  assert.deepEqual(f.warnings,[]);
  assert.equal(f.farming.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key).status,'pending');
  batch._historyBatch.dirtyGenerations[key]=3;
  await f.invoke('sync-history-mark',batch);
  assert.deepEqual(f.warnings,[]);
  assert.equal(f.farming.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key).status,'done');
  assert.ok(f.reads()>=3);
});
test('radio HTTP rejection backs off only that stream and next tick selects another family',async t=>{
  const f=fixture(t);
  await f.invoke('sync-history-mark',{statusCode:400,_historyBatch:{tableName:'radio_uplinks',phase:'tail',batchId:'unsupported'}});
  assert.deepEqual(f.warnings,[]);
  assert.ok(f.farming.prepare("SELECT next_attempt_at FROM sync_history_cursors WHERE table_name='radio_uplinks'").get().next_attempt_at);
  f.memory.set('history_sync_last_table','radio_uplinks');
  await f.invoke('sync-history-build',{});
  assert.notEqual(f.memory.get('history_sync_last_table'),'radio_uplinks');
  assert.equal(f.reads(),0);
});
