'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {seedTestDb,facadeDb}=require('./lib/flow-node-harness');
const base='../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/';
const normalizer=require(base+'osi-sdi12-normalize');
const commissioning=require(base+'osi-sdi12-commissioning');
const writer=require(base+'osi-device-writer');
const history=require(base+'osi-history-sync-helper');
const manifest=require(base+'edge-channels.json');
const observationFixture=require('../docs/contracts/matric-potential/observation-v1.json');
const eui='A840410000000101', gateway='0016C001F1000001';
const layout={version:1,kind:'tensiomark',source_unit:'pF',field_order:'temperature_pf',qualification:'bench_observed',sensors:[
 {address:'1',channel:1,identity:'111TENSIOMARK_2Vh_10A00001',depth_cm:null,calibration_range:'unverified'},
 {address:'4',channel:2,identity:'411TENSIOMARK_2Vh_10A00002',depth_cm:30,calibration_range:'unverified'}]};
const raw='1+18.090+1.7300\r\n4+19.125+0.164\r\n';
const nowMs=Date.parse('2026-10-16T12:00:00Z');
function setup(){
 const db=seedTestDb();writer.resetColumnCache();
 db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,gateway_device_eui,created_at,updated_at) VALUES(?,'Test','DRAGINO_SDI12',1,?,'2026-10-15','2026-10-15')").run(eui,gateway);
 db.prepare("INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES('cloud',1,?,'2026-10-16T12:00:00Z') ON CONFLICT(peer_node) DO UPDATE SET linked=1,gateway_device_eui=excluded.gateway_device_eui").run(gateway);
 return db;
}
test('native pF token and full kPa double survive observation, SQLite, append JSON and history',async()=>{
 const db=setup();
 try{
  const result=normalizer.normalize({BatV:3.606,data_sum:raw},{probeProfile:'TENSIOMARK',sdi12ChannelLayout:layout},{recordedAt:new Date(nowMs).toISOString()});
  const expected1=Math.pow(10,1.73-1),expected2=Math.pow(10,.164-1);
  assert.equal(result.channels.swt_1,expected1);
  await commissioning.writeTensiomarkObservation(facadeDb(db),manifest,result,{deveui:eui,payloadBase64:Buffer.from(raw).toString('base64')},{nowMs});
  const row=db.prepare('SELECT * FROM device_data').get();
  assert.equal(row.swt_1,expected1);assert.equal(row.swt_2,expected2);
  assert.equal(row.soil_temp_2,19.125);
  const observation=db.prepare('SELECT * FROM tensiomark_observations').get();
  const source=JSON.parse(observation.normalized_json);
  assert.equal(source.normalization_version,2);
  assert.equal(source.conversion,'matric-potential-hpa-v1');
  assert.deepEqual(source.native_pf,{swt_1:'+1.7300',swt_2:'+0.164'});
  assert.equal(source.channels.swt_1,row.swt_1);
  assert.equal(observation.raw_response,raw);
  const event=JSON.parse(db.prepare("SELECT payload_json FROM sync_outbox WHERE op='DEVICE_DATA_APPENDED'").get().payload_json);
  assert.equal(event.swt_1,expected1);assert.equal(event.swt_2,expected2);
  const transferred=JSON.parse(JSON.stringify(history.prepareRow('device_data',gateway,row)));
  assert.equal(transferred.payload.swt_1,expected1);
  // Self-consistency only (same hash function on both sides); the paired
  // edge/Java fixture test below is the cross-implementation pin.
  assert.equal(history.hashHistoryRow('device_data',transferred.historyKey,transferred.payload),transferred.payloadHash);
 }finally{db.close();}
});
test('observation append decorates only its new aggregate event', async()=>{
 const db=setup();
 try{
  const recordedAt=new Date(nowMs).toISOString();
  db.prepare("INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui) VALUES(?,?,?,?,?,?,?,?)")
    .run('preexisting-event','DEVICE_DATA',eui+'|'+recordedAt,'DEVICE_DATA_APPENDED',JSON.stringify({swt_1:1.25,marker:'old'}),0,recordedAt,gateway);
  const result=normalizer.normalize({BatV:3.606,data_sum:raw},{probeProfile:'TENSIOMARK',sdi12ChannelLayout:layout},{recordedAt});
  await commissioning.writeTensiomarkObservation(facadeDb(db),manifest,result,{deveui:eui,payloadBase64:Buffer.from(raw).toString('base64')},{nowMs});
  const events=db.prepare("SELECT event_uuid,payload_json FROM sync_outbox WHERE aggregate_key=? ORDER BY rowid").all(eui+'|'+recordedAt);
  assert.equal(events.length,2);
  assert.deepEqual(JSON.parse(events[0].payload_json),{swt_1:1.25,marker:'old'});
  assert.equal(JSON.parse(events[1].payload_json).swt_1,Math.pow(10,1.73-1));
 }finally{db.close();}
});
test('ambiguous new aggregate events roll back the complete observation transaction', async()=>{
 const db=setup();
 try{
  db.exec("CREATE TRIGGER test_duplicate_tensiomark_event AFTER INSERT ON device_data WHEN NEW.deveui='"+eui+"' BEGIN INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui) VALUES('duplicate-event','DEVICE_DATA',NEW.deveui||'|'||NEW.recorded_at,'DEVICE_DATA_APPENDED','{}',0,NEW.recorded_at,'"+gateway+"'); END");
  const result=normalizer.normalize({BatV:3.606,data_sum:raw},{probeProfile:'TENSIOMARK',sdi12ChannelLayout:layout},{recordedAt:new Date(nowMs).toISOString()});
  await assert.rejects(
   commissioning.writeTensiomarkObservation(facadeDb(db),manifest,result,{deveui:eui,payloadBase64:Buffer.from(raw).toString('base64')},{nowMs}),
   error => error && error.code === 'ambiguous_observation_event'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tensiomark_observations').get().n,0);
 }finally{db.close();}
});
test('observation history hashes native token spelling, and binary evidence stays lossless',()=>{
 const db=setup();
 try{
  const binary='1+18.09+1.7\0suffix\r\n';
  db.prepare('INSERT INTO tensiomark_observations(device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(null,eui,new Date(nowMs).toISOString(),new Date(nowMs).toISOString(),binary,Buffer.from(binary).toString('base64'),'abc',JSON.stringify(layout),'rejected_framing',JSON.stringify({channels:{},disposition:'rejected_framing'}));
  const row=db.prepare(history.batchQuery('tensiomark_observations','tail')).get(...history.batchQueryParams('tensiomark_observations','tail',0,null,10));
  const initial=history.prepareRow('tensiomark_observations',gateway,row);
  assert.equal(initial.quarantineReason,null);
  assert.equal(initial.historyKey,'TENSIOMARK_OBSERVATION|'+gateway+'|1');
  assert.equal(initial.payload.raw_response,undefined);
  assert.equal(Buffer.from(initial.payload.raw_response_hex,'hex').toString(),binary);
  const modified=history.prepareRow('tensiomark_observations',gateway,{...row,normalized_json:'{"native_pf":{"swt_1":"+1.7300"}}'});
  const lexical=history.prepareRow('tensiomark_observations',gateway,{...row,normalized_json:'{"native_pf":{"swt_1":"+1.73"}}'});
  assert.notEqual(initial.payloadHash,modified.payloadHash);
  assert.notEqual(modified.payloadHash,lexical.payloadHash);
  db.prepare("UPDATE tensiomark_observations SET normalized_json=? WHERE id=1").run(modified.payload.normalized_json);
  assert.equal(db.prepare("SELECT table_name FROM sync_history_dirty_keys WHERE table_name='tensiomark_observations'").get().table_name,'tensiomark_observations');
 }finally{db.close();}
});
test('all observation history projections preserve NUL bytes and retain nullable device_data_id',()=>{
 const db=setup();
 try{
  const binary='prefix\0middle\0suffix';
  db.prepare('INSERT INTO tensiomark_observations(device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(null,eui,new Date(nowMs).toISOString(),new Date(nowMs).toISOString(),binary,Buffer.from(binary,'latin1').toString('base64'),'abc',JSON.stringify(layout),'rejected_framing','{"native_pf":{}}');
  const expected=Buffer.from(binary,'utf8').toString('hex').toUpperCase();
  const queries=[
   [history.batchQuery('tensiomark_observations','tail'),history.batchQueryParams('tensiomark_observations','tail',0,null,10)],
   [history.nextRawQuery('tensiomark_observations'),[0,10]],
   [history.segmentQuery('tensiomark_observations',eui+'|2026-10-16').sql,history.segmentQuery('tensiomark_observations',eui+'|2026-10-16').params],
   [history.rowByHistoryKeyQuery('tensiomark_observations','TENSIOMARK_OBSERVATION|'+gateway+'|1').sql,[1]],
  ];
  for(const [sql,params] of queries){
   const row=db.prepare(sql).get(...params);
   assert.equal(row.raw_response_hex,expected,sql);
   assert.equal(row.device_data_id,null,sql);
  }
 }finally{db.close();}
});
test('unsupported history cursor remains unadvanced while rotation reaches other tables',()=>{
 const tables=history.tableNames();
 assert.throws(()=>history.cursorKind('unsupported_table'),/unsupported history table/);
 const patch=history.cursorPatchFromResponse({results:[{status:'REJECTED_PERMANENT',reason:'unsupported_table'}]});
 assert.equal(patch.last_acked_id,undefined);
 assert.equal(patch.last_acked_key,undefined);
 assert.match(patch.last_error,/unsupported_table/);
 assert.equal(history.nextTable('valve_actuation_expectations',tables),'tensiomark_observations');
 assert.equal(history.nextTable('tensiomark_observations',tables),'device_data');
 assert.equal(history.nextTable('unsupported_table',tables),'device_data');
});
test('canonical observation fixture matches edge columns, key and hash',()=>{
 const actual=history.prepareRow(observationFixture.tableName,observationFixture.gatewayDeviceEui,observationFixture.row);
 assert.deepEqual(history.buildCanonicalColumns(observationFixture.tableName,observationFixture.row),observationFixture.canonicalColumns);
 assert.deepEqual(actual,observationFixture.expected);
});
