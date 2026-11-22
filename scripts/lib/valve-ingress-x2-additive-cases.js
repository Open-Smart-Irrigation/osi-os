'use strict';
const assert=require('node:assert/strict');
const {cases:originalCases,ROUTER,AUTH,ADVANCED}=require('./valve-ingress-x2-cases');
function cases(){
 const original=originalCases(),out=[];
 const add=(name,base,edit,options={})=>{const tc=structuredClone(original.find(c=>c.name===base));assert.ok(tc);tc.name='add/'+name;tc.options={...tc.options,...options};edit(tc.msg);out.push(tc);};
 add('snake-metadata','route/open',m=>{const p=m.payload;for(const [camel,snake]of [['commandId','command_id'],['eventUuid','event_uuid'],['aggregateType','aggregate_type'],['aggregateKey','aggregate_key'],['appliedSyncVersion','applied_sync_version']]){p[snake]=p[camel];delete p[camel];}});
 add('missing-metadata','route/open',m=>{for(const key of ['commandId','command_id','eventUuid','aggregateType','aggregateKey','appliedSyncVersion'])delete m.payload[key];});
 add('missing-gateway','route/open',()=>{},{env:{DEVICE_EUI:''}});
 for(const field of ['durationMinutes','duration_minutes'])add('valve-'+field,'route/valve-allowed',m=>{delete m.payload.duration_seconds;m.payload[field]=3;});
 add('interval-default','route/interval',m=>{delete m.payload.closedIntervalMinutes;delete m.payload.openIntervalMinutes;delete m.payload.tamperDisabled;});
 add('interval-wire','route/interval',m=>{m.payload.fPort=99;m.payload.payloadHex='abcd';});
 add('lsn-numeric','route/lsn-mode',m=>{delete m.payload.mode;m.payload.modeCode=7;});
 for(const label of ['manual','cancel',...ADVANCED])add(label+'-jwt-only',label+'/valid',()=>{},{env:{AUTH_TOKEN_SECRET:undefined,JWT_SECRET:'x2-fixture-secret'}});
 add('builder-absent-zone-actor','build/valid',m=>{delete m.payload[0].irrigation_zone_id;delete m.actor_user_uuid;});
 add('scope-resolver-warning','manual/scoped-valid',()=>{},{scopeWarn:true});
 for(const [label,speed]of [['missing',undefined],['nonnumeric','bad'],['null',null]])add('fan-speed-'+label,'route/fan-hwmon',m=>{if(speed===undefined)delete m.payload.speed;else m.payload.speed=speed;});
 add('cancel-close-callback-error','cancel/valid',()=>{},{mode:'close-callback-error'});
 return out;
}
function assertBranch(tc,result){
 assert.equal(result.error,null,tc.name+': no unexpected throw');
 const value=result.value;
 const command=Array.isArray(value)?value[0]:value;
 if(tc.id===ROUTER){
  if(tc.name.includes('snake-metadata')){assert.equal(command.payload.data.eventUuid,'event-1');assert.equal(command.payload.data.appliedSyncVersion,0);}
  if(tc.name.includes('missing-metadata'))for(const key of ['commandId','eventUuid','aggregateType','aggregateKey','appliedSyncVersion'])assert.equal(command.payload.data[key],null,key);
  if(tc.name.includes('missing-gateway'))assert.equal(command.payload.data.gatewayDeviceEui,'UNKNOWN');
  if(tc.name.includes('valve-duration'))assert.equal(command.payload.data.duration_minutes,3);
  if(tc.name.includes('interval-default')){assert.equal(command.payload.data.open_interval_minutes,2);assert.equal(command.payload.data.payloadHex,'00000002');}
  if(tc.name.includes('interval-wire')){assert.equal(command.payload.data.fPort,99);assert.equal(command.payload.data.payloadHex,'ABCD');}
  if(tc.name.includes('lsn-numeric')){assert.equal(value[4].payload.fPort,2);assert.equal(value[4].payload.mode,'MOD7');assert.equal(value[4].payload.payloadHex,'0A07');}
  if(tc.name.includes('fan-speed')){assert.deepEqual(value.map(Boolean),[false,false,true,false,false]);assert.equal(JSON.parse(value[2].payload).result,'SUCCESS');assert.ok(result.effects.some(e=>e[0]==='write' && e[1].endsWith('/pwm1_enable') && e[2]==='2'));}
 }else if(tc.name.includes('jwt-only')){
  assert.equal(result.effects.some(e=>e[0]==='env'&&e[1]==='JWT_SECRET'),true);
  assert.notEqual(value?.statusCode,401);
 }else if(tc.name.includes('builder-absent')){assert.equal(command.payload.data.zone_id,null);assert.equal(command._actorUserUuid,null);}
 else if(tc.name.includes('scope-resolver-warning'))assert.ok(result.effects.some(e=>e[0]==='warn'&&e[1]==='fixture scope resolver warning'));
 else if(tc.name.includes('close-callback')){assert.equal(value.statusCode,200);assert.equal(result.effects.at(-1)[0],'db.close');}
}
module.exports={cases,assertBranch};
