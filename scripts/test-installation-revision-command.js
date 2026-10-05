'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const helper=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-location-helper');
const gateway='0011223344556677',device='AABBCCDDEEFF0011',installation='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
function fixture(t){
 const raw=new DatabaseSync(':memory:');t.after(()=>raw.close());raw.exec(fs.readFileSync('database/seed-blank.sql','utf8'));
 raw.prepare("INSERT INTO users(id,username,password_hash,user_uuid,role,created_at) VALUES(1,'fixture','x',?,'admin','2026-09-10')").run(actor);
 raw.prepare("INSERT INTO irrigation_zones(id,user_id,name,zone_uuid,gateway_device_eui) VALUES(1,1,'fixture','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',?)").run(gateway);
 raw.prepare("INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,created_at,updated_at) VALUES(?,'sensor','DRAGINO_LSN50',1,1,?,'2026-09-10','2026-09-10')").run(device,gateway);
 raw.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,recovery_state,created_at,updated_at) VALUES(1,?,?,'ACTIVE','2026-09-10','2026-09-10')").run(installation,gateway);
 const db={get:async(s,p=[])=>raw.prepare(s).get(...p),all:async(s,p=[])=>raw.prepare(s).all(...p),run:async(s,p=[])=>raw.prepare(s).run(...p)};
 db.transaction=async fn=>{raw.exec('BEGIN IMMEDIATE');try{const value=await fn(db);raw.exec('COMMIT');return value;}catch(error){raw.exec('ROLLBACK');throw error;}};
 return {raw,db};
}
function command(id,revision,base=null){return {commandId:id,commandType:'UPSERT_DEVICE_INSTALLATION_LOCATION',payload:{command_id:revision,command_type:'UPSERT_DEVICE_INSTALLATION_LOCATION',effect_key:'device_installation_location:'+revision+':'+(base||'initial'),device_eui:device,installation_uuid:installation,revision_uuid:revision,base_revision_uuid:base,actor_user_uuid:actor,values:{latitude:47,longitude:8,effectiveFrom:'2026-09-10T08:00:00.000Z',coordinateSource:'manual'}}};}
test('pending revision, immutable event and durable ACK commit together; delivery replay does not duplicate revision',async t=>{
 const {db,raw}=fixture(t),cmd=command(1,'33333333-3333-4333-8333-333333333333');
 const first=await helper.applyCommand(db,cmd,{gateway_device_eui:gateway,scopedMode:true});assert.equal(first.ack.result,'APPLIED',JSON.stringify(first.ack));
 assert.equal((await helper.applyCommand(db,cmd,{gateway_device_eui:gateway,scopedMode:true})).ack.result,'APPLIED');
 assert.equal(raw.prepare('SELECT count(*) n FROM device_installation_location_revisions').get().n,1);
 const events=raw.prepare("SELECT * FROM sync_outbox WHERE op='DEVICE_INSTALLATION_LOCATION_REVISED'").all();assert.equal(events.length,1);
 const payload=JSON.parse(events[0].payload_json);assert.equal(payload.revision_uuid,cmd.payload.revision_uuid);assert.equal(payload.contract_version,1);assert.equal(payload.source_gateway_device_eui,gateway);
 assert.equal(raw.prepare('SELECT count(*) n FROM command_ack_outbox').get().n,1);
});
test('stale revision and revoked actor produce durable rejection without installation mutation',async t=>{
 const {db,raw}=fixture(t);await helper.applyCommand(db,command(1,'33333333-3333-4333-8333-333333333333'),{gateway_device_eui:gateway,scopedMode:true});
 const conflict=await helper.applyCommand(db,command(2,'44444444-4444-4444-8444-444444444444'),{gateway_device_eui:gateway,scopedMode:true});assert.equal(conflict.ack.result,'CONFLICT');
 raw.prepare("UPDATE users SET disabled_at='2026-09-10' WHERE id=1").run();
 const denied=await helper.applyCommand(db,command(3,'55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333'),{gateway_device_eui:gateway,scopedMode:true});assert.equal(denied.ack.result,'REJECTED_PERMANENT');
 assert.equal(raw.prepare('SELECT count(*) n FROM device_installation_location_revisions').get().n,1);
});
test('failed ACK persistence rolls back revision and operational event',async t=>{
 const {db,raw}=fixture(t);raw.exec("CREATE TRIGGER reject_test_ack BEFORE INSERT ON command_ack_outbox BEGIN SELECT RAISE(ABORT,'fixture ACK failure'); END;");
 await assert.rejects(()=>helper.applyCommand(db,command(1,'33333333-3333-4333-8333-333333333333'),{gateway_device_eui:gateway,scopedMode:true}),/fixture ACK failure/);
 assert.equal(raw.prepare('SELECT count(*) n FROM device_installation_location_revisions').get().n,0);
 assert.equal(raw.prepare("SELECT count(*) n FROM sync_outbox WHERE op='DEVICE_INSTALLATION_LOCATION_REVISED'").get().n,0);
 assert.equal(raw.prepare('SELECT count(*) n FROM applied_commands').get().n,0);
});
// The cloud sends the acting user's gateway-local users.user_uuid as stored; the
// first admin and backfilled users hold 32 lower-case hex digits. Both revision
// commands and the local save path must accept that form unchanged.
const hexOwner='0123456789abcdef0123456789abcdef',hexUnknown='fedcba9876543210fedcba9876543210';
function hexFixture(t){const state=fixture(t);state.raw.prepare('UPDATE users SET user_uuid=? WHERE id=1').run(hexOwner);return state;}
function typed(type,id,revision,actorUuid){
 const radio=type==='UPSERT_DEVICE_RADIO_CONFIGURATION',prefix=radio?'device_radio_configuration':'device_installation_location';
 return {commandId:id,commandType:type,payload:{command_id:revision,command_type:type,effect_key:prefix+':'+revision+':initial',device_eui:device,installation_uuid:installation,revision_uuid:revision,base_revision_uuid:null,actor_user_uuid:actorUuid,
  values:radio?{effectiveFrom:'2026-09-10T08:00:00.000Z',txPowerDbm:14,antennaGainDbi:2,feederLossDb:0,configurationSource:'manual'}:{latitude:47,longitude:8,effectiveFrom:'2026-09-10T08:00:00.000Z',coordinateSource:'manual'}}};
}
const revisionTypes=[['UPSERT_DEVICE_INSTALLATION_LOCATION','device_installation_location_revisions','DEVICE_INSTALLATION_LOCATION_REVISED'],['UPSERT_DEVICE_RADIO_CONFIGURATION','device_radio_configuration_revisions','DEVICE_RADIO_CONFIGURATION_REVISED']];
test('a 32-hex owner applies both revision commands; the actor is stored and emitted unchanged',async t=>{
 let id=900;
 for(const scopedMode of [false,true])for(const [type,table,op] of revisionTypes){
  const label=type+' scoped='+scopedMode,{db,raw}=hexFixture(t),cmd=typed(type,id++,'66666666-6666-4666-8666-'+String(id).padStart(12,'0'),hexOwner);
  const first=await helper.applyCommand(db,cmd,{gateway_device_eui:gateway,scopedMode});
  assert.equal(first.ack.result,'APPLIED',label+': '+JSON.stringify(first.ack));
  assert.equal(raw.prepare('SELECT actor_user_uuid FROM '+table).get().actor_user_uuid,hexOwner,label);
  const events=raw.prepare('SELECT payload_json FROM sync_outbox WHERE op=?').all(op);assert.equal(events.length,1,label);
  assert.equal(JSON.parse(events[0].payload_json).actor_user_uuid,hexOwner,label);
  assert.equal(JSON.parse(raw.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').get(String(cmd.commandId)).payload_json).result,'APPLIED',label);
  assert.deepEqual((await helper.applyCommand(db,cmd,{gateway_device_eui:gateway,scopedMode})).ack,first.ack,label+': exact redelivery');
  assert.equal(raw.prepare('SELECT count(*) n FROM '+table).get().n,1,label);
 }
});
test('an unknown or disabled 32-hex actor is refused for both revision commands',async t=>{
 let id=920;
 for(const [type,table] of revisionTypes){
  const {db,raw}=hexFixture(t);
  const unknown=await helper.applyCommand(db,typed(type,id++,'77777777-7777-4777-8777-'+String(id).padStart(12,'0'),hexUnknown),{gateway_device_eui:gateway,scopedMode:true});
  assert.equal(unknown.ack.result,'REJECTED_PERMANENT',type);assert.equal(unknown.ack.reason,'actor account disabled or missing',type);
  raw.prepare("UPDATE users SET disabled_at='2026-09-10' WHERE id=1").run();
  const disabled=await helper.applyCommand(db,typed(type,id++,'77777777-7777-4777-8777-'+String(id).padStart(12,'0'),hexOwner),{gateway_device_eui:gateway,scopedMode:true});
  assert.equal(disabled.ack.reason,'actor account disabled or missing',type);
  assert.equal(raw.prepare('SELECT count(*) n FROM '+table).get().n,0,type);
 }
});
test('malformed actor ids are refused for both revision commands',async t=>{
 let id=940;
 for(const [type,table] of revisionTypes)for(const bad of [hexOwner.slice(1),hexOwner+'0',hexOwner.toUpperCase(),'g'.repeat(32),hexOwner.slice(0,8)+'-'+hexOwner.slice(8)]){
  const {db,raw}=hexFixture(t);
  const result=await helper.applyCommand(db,typed(type,id++,'88888888-8888-4888-8888-'+String(id).padStart(12,'0'),bad),{gateway_device_eui:gateway,scopedMode:true});
  assert.equal(result.ack.result,'REJECTED_PERMANENT',type+' '+bad);assert.equal(result.ack.reason,'invalid device or actor identity',type+' '+bad);
  assert.equal(raw.prepare('SELECT count(*) n FROM '+table).get().n,0);
 }
});
test('the local save path keeps a 32-hex actor unchanged and refuses malformed actors',async t=>{
 const {db,raw}=hexFixture(t);
 const options={deviceEui:device,installationUuid:installation,gatewayEui:gateway,actorUserUuid:hexOwner,revisionUuid:'99999999-9999-4999-8999-999999999999',baseRevisionUuid:null,values:{latitude:47,longitude:8,effectiveFrom:'2026-09-10T08:00:00.000Z'}};
 await helper.saveLocation(db,options);
 assert.equal(raw.prepare('SELECT actor_user_uuid FROM device_installation_location_revisions').get().actor_user_uuid,hexOwner);
 await assert.rejects(()=>helper.saveRadioConfiguration(db,Object.assign({},options,{actorUserUuid:hexOwner.toUpperCase(),revisionUuid:'99999999-9999-4999-8999-999999999998',values:{effectiveFrom:'2026-09-10T08:00:00.000Z'}})),/actorUserUuid/);
});
