'use strict';
const fs=require('fs');const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const flows=JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'));
const {encodeFieldTesterReply,classifyUplinkFrame}=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/fieldtester.js');
const {executeFunction,loadNode,seedTestDb}=require('./lib/flow-node-harness');
test('radio capture has an enabled always-loaded input and leaves field testing disabled',()=>{
 const inputs=flows.filter(n=>n.type==='mqtt in'&&n.topic==='application/+/device/+/event/up');
 const capture=flows.find(n=>n.id==='radio-capture-fn');
 const captureTab=flows.find(n=>n.id===capture.z);
 const fieldTesting=flows.find(n=>n.id==='a3f03829ad106e10');
 assert.equal(captureTab.disabled,false);
 assert.equal(captureTab.label,'Radio observations');
 assert.equal(fieldTesting.disabled,true);
 assert.equal(inputs.filter(n=>n.wires.flat().includes('radio-capture-fn')).length,1);
 assert.equal(inputs.find(n=>n.wires.flat().includes('radio-capture-fn')).z,captureTab.id);
 assert.equal(inputs.find(n=>n.id==='e382bbf0dde572b1').wires[0].length,2);
});
test('disabled capture returns without loading dependencies or touching DB',async()=>{const code=flows.find(n=>n.id==='radio-capture-fn').func;const fn=vm.runInNewContext('(async function(){'+code+'})',{env:{get:()=>''}});assert.equal(await fn(),null);});
test('all source reads use radio adapter but bookkeeping remains farming based',()=>{const code=flows.find(n=>n.id==='sync-history-build').func;assert.match(code,/sourceQuery\(tableName,helper.snapshotHighQuery/);assert.match(code,/sourceQuery\(tableName,lookup.sql/);assert.match(code,/sourceQuery\(tableName,\s*helper.batchQuery/);assert.match(code,/bridgeDirty\(_db\)/);assert.match(flows.find(n=>n.id==='sync-history-mark').func,/rb.generation=\?/);});

// --- Task 3 fix round 1, Finding A: executable coverage for the field-tester fence ---
// Process Data (81c98fb07344a787), Build Telemetry (8809bb5239dfb3d4) and Process
// STREGA (strega-process-fn) each carry an identical guard: return null before any
// profile comparison when msg.payload.deviceInfo.applicationId matches
// CHIRPSTACK_APP_FIELD_TESTER. Without an executable check, a wrong field name (e.g.
// application_id) or a change that makes the guard match everything would ship
// silently. These tests run the real node.func bodies via node:vm (same approach as
// 'disabled capture...' above), and use side-effect spies (not just the return value)
// so a guard that never fires or a guard that fires unconditionally both fail loudly.
const FIELD_TESTER_APP='6a2f9e3c-6d0b-4b1a-9f7e-2c8a5e1d9b40';// synthetic app id, shaped like a real ChirpStack application UUID
const OTHER_APP='11e4c7a2-9f3d-4a6b-8c5e-0d2f7b1a9e63';// a different application: must never be fenced
const SHARED_CLOVER_UUID='46bdcc01-86db-41bd-bbf8-78cc439edae5';// literal Clover fallback baked into all three nodes; the RAK10701 is deliberately provisioned onto this same ChirpStack profile id
const SYNTHETIC_STREGA_PROFILE_ID='b2c9e614-2f5b-4b21-9b8a-7b6c5d4e3f2a';// distinct from SHARED_CLOVER_UUID so getProfileKind falls through to its deviceProfileName STREGA fallback instead of matching the Clover literal
const TESTER_FRAME_DATA='INlJhJz1BdwMCA==';// this program's synthetic field-tester uplink fixture (scripts/test-radio-chirpstack.js); none of these three nodes decode it (no `object` field on the real tester frame), so no coordinate is exposed here
function makeEnv(overrides){return {get:(k)=>Object.prototype.hasOwnProperty.call(overrides,k)?overrides[k]:''};}
function realTesterFrame(devEui){return {deviceInfo:{devEui,deviceProfileId:SHARED_CLOVER_UUID,deviceProfileName:'OSI RAK Field Tester',applicationId:FIELD_TESTER_APP},fPort:1,data:TESTER_FRAME_DATA,time:'2026-01-01T00:00:00Z'};}
async function runNode(id,msg,sandbox){const code=flows.find(n=>n.id===id).func;const fn=vm.runInNewContext('(function(msg){'+code+'})',sandbox);return await fn(msg);}

test('Process Data: field-tester application is fenced before the !data.object check ever logs',async()=>{
 const calls={error:0};
 const node={error:()=>{calls.error++;},status:()=>{},warn:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:FIELD_TESTER_APP});
 const msg={payload:realTesterFrame('AABBCCDDEEFF9101')};
 const result=await runNode('81c98fb07344a787',msg,{env,node});
 assert.equal(result,null);
 assert.equal(calls.error,0,'a broken guard would fall through to the !data.object check and log "Unexpected payload structure"');
});
test('Process Data: a different application is not fenced and reaches the KIWI/CLOVER branch',async()=>{
 const calls={error:0};
 const node={error:()=>{calls.error++;},status:()=>{},warn:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:FIELD_TESTER_APP});
 const msg={payload:{deviceInfo:{devEui:'AABBCCDDEEFF9102',deviceProfileId:SHARED_CLOVER_UUID,deviceProfileName:'OSI Tektelic Clover',applicationId:OTHER_APP},object:{watermark1_frequency:2000,watermark2_frequency:2500,light_intensity:123,ambient_temperature:21.4,relative_humidity:55},time:'2026-01-01T00:00:00Z'}};
 const result=await runNode('81c98fb07344a787',msg,{env,node});
 assert.ok(result&&result.formattedData,'an unfenced Clover-shaped frame must still reach formattedData; a guard that fenced everything would return null here');
 assert.equal(result.formattedData.devEui,'AABBCCDDEEFF9102');
 assert.equal(calls.error,0);
});
test('Process Data: an unset CHIRPSTACK_APP_FIELD_TESTER fences nothing',async()=>{
 const node={error:()=>{},status:()=>{},warn:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:''});
 const msg={payload:{deviceInfo:{devEui:'AABBCCDDEEFF9103',deviceProfileId:SHARED_CLOVER_UUID,deviceProfileName:'OSI Tektelic Clover',applicationId:FIELD_TESTER_APP},object:{watermark1_frequency:2000,watermark2_frequency:2500},time:'2026-01-01T00:00:00Z'}};
 const result=await runNode('81c98fb07344a787',msg,{env,node});
 assert.ok(result&&result.formattedData,'an empty CHIRPSTACK_APP_FIELD_TESTER must never fence, even when applicationId equals the would-be tester id');
});

test('Build Telemetry: field-tester application is fenced before the CLOVER-shaped fallback publishes',async()=>{
 const calls={lsn50ModeLabel:0};
 const dendro={lsn50ModeLabel:()=>{calls.lsn50ModeLabel++;return null;}};
 const flow={get:()=>undefined,set:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:FIELD_TESTER_APP,DEVICE_EUI:'ABCDEF0123456789'});
 const msg={payload:realTesterFrame('AABBCCDDEEFF9201')};
 const result=await runNode('8809bb5239dfb3d4',msg,{env,dendro,flow});
 assert.equal(result,null,'without the fence this real tester frame resolves profileKind=TEKTELIC_CLOVER (the shared UUID) and falls through to a mislabeled deviceType=KIWI_SENSOR publish with mostly-null readings -- the exact bug this task exists to prevent');
 assert.equal(calls.lsn50ModeLabel,0,'no downstream logic should run once the fence returns null');
});
test('Build Telemetry: a different application is not fenced and reaches the CLOVER/KIWI branch',async()=>{
 const calls={lsn50ModeLabel:0};
 const dendro={lsn50ModeLabel:()=>{calls.lsn50ModeLabel++;return null;}};
 const flow={get:()=>undefined,set:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:FIELD_TESTER_APP,DEVICE_EUI:'ABCDEF0123456789'});
 const msg={payload:{deviceInfo:{devEui:'AABBCCDDEEFF9202',deviceProfileId:SHARED_CLOVER_UUID,deviceProfileName:'OSI Tektelic Clover',applicationId:OTHER_APP},object:{watermark1_frequency:2000,watermark2_frequency:2500},time:'2026-01-01T00:00:00Z'}};
 const result=await runNode('8809bb5239dfb3d4',msg,{env,dendro,flow});
 assert.ok(result&&typeof result.payload==='string','an unfenced frame must still reach the JSON.stringify publish step; a guard that fenced everything would return null here');
 const published=JSON.parse(result.payload);
 assert.equal(published.deviceEui,'AABBCCDDEEFF9202');
 assert.equal(calls.lsn50ModeLabel,1);
});
test('Build Telemetry: an unset CHIRPSTACK_APP_FIELD_TESTER fences nothing',async()=>{
 const calls={lsn50ModeLabel:0};
 const dendro={lsn50ModeLabel:()=>{calls.lsn50ModeLabel++;return null;}};
 const flow={get:()=>undefined,set:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:'',DEVICE_EUI:'ABCDEF0123456789'});
 const msg={payload:{deviceInfo:{devEui:'AABBCCDDEEFF9203',deviceProfileId:SHARED_CLOVER_UUID,deviceProfileName:'OSI Tektelic Clover',applicationId:FIELD_TESTER_APP},object:{watermark1_frequency:2000,watermark2_frequency:2500},time:'2026-01-01T00:00:00Z'}};
 const result=await runNode('8809bb5239dfb3d4',msg,{env,dendro,flow});
 assert.ok(result&&typeof result.payload==='string');
 assert.equal(calls.lsn50ModeLabel,1);
});

test('Process STREGA: the real field-tester frame (Clover-aliased profile) is fenced',async()=>{
 // The real tester frame's deviceProfileName ('OSI RAK Field Tester') and shared Clover
 // profile id already make strega-process-fn's own pre-existing
 // getProfileKind(...)!=='STREGA_VALVE' bail-out return null on its own, so this test
 // alone cannot prove the NEW fence (rather than that pre-existing filter) is what
 // fired. See the next test, which isolates the two.
 const calls={database:0};
 const osiDb={Database:function(){calls.database++;return {all:(sql,cb)=>cb(null,[]),close:(cb)=>cb()};}};
 const node={warn:()=>{},status:()=>{},error:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:FIELD_TESTER_APP});
 const msg={payload:realTesterFrame('AABBCCDDEEFF9301')};
 const result=await runNode('strega-process-fn',msg,{env,node,osiDb});
 assert.equal(result,null);
 assert.equal(calls.database,0);
});
test('Process STREGA: fence fires even for a frame that would otherwise pass the STREGA_VALVE profile check',async()=>{
 // Isolates the new guard from getProfileKind: this frame's profile NAME is
 // STREGA-shaped (not Clover-aliased), so if the field-tester fence were broken
 // (wrong field name, or removed), getProfileKind would classify it as STREGA_VALVE
 // and execution would reach osiDb.Database. A null return and zero DB calls here can
 // only be explained by the applicationId fence itself.
 const calls={database:0};
 const osiDb={Database:function(){calls.database++;return {all:(sql,cb)=>cb(null,[{type_id:'STREGA_VALVE'}]),close:(cb)=>cb()};}};
 const node={warn:()=>{},status:()=>{},error:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:FIELD_TESTER_APP});
 const msg={payload:{deviceInfo:{devEui:'AABBCCDDEEFF9302',deviceProfileId:SYNTHETIC_STREGA_PROFILE_ID,deviceProfileName:'OSI STREGA Valve',applicationId:FIELD_TESTER_APP},object:{Valve:1,Battery:80},time:'2026-01-01T00:00:00Z'}};
 const result=await runNode('strega-process-fn',msg,{env,node,osiDb});
 assert.equal(result,null);
 assert.equal(calls.database,0,'a broken guard would let this STREGA-shaped frame reach osiDb.Database');
});
test('Process STREGA: a different application is not fenced and reaches the STREGA_VALVE branch',async()=>{
 const calls={database:0};
 const osiDb={Database:function(){calls.database++;return {all:(sql,cb)=>cb(null,[{type_id:'STREGA_VALVE'}]),close:(cb)=>cb()};}};
 const node={warn:()=>{},status:()=>{},error:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:FIELD_TESTER_APP});
 const msg={payload:{deviceInfo:{devEui:'AABBCCDDEEFF9303',deviceProfileId:SYNTHETIC_STREGA_PROFILE_ID,deviceProfileName:'OSI STREGA Valve',applicationId:OTHER_APP},object:{Valve:1,Battery:80},time:'2026-01-01T00:00:00Z'}};
 const result=await runNode('strega-process-fn',msg,{env,node,osiDb});
 assert.ok(result&&result.formattedData,'an unfenced STREGA-shaped frame must still reach formattedData; a guard that fenced everything would return null here');
 assert.equal(result.formattedData.currentState,'OPEN');
 assert.equal(calls.database,1);
});
test('Process STREGA: an unset CHIRPSTACK_APP_FIELD_TESTER fences nothing',async()=>{
 const calls={database:0};
 const osiDb={Database:function(){calls.database++;return {all:(sql,cb)=>cb(null,[{type_id:'STREGA_VALVE'}]),close:(cb)=>cb()};}};
 const node={warn:()=>{},status:()=>{},error:()=>{}};
 const env=makeEnv({CHIRPSTACK_APP_FIELD_TESTER:''});
 const msg={payload:{deviceInfo:{devEui:'AABBCCDDEEFF9304',deviceProfileId:SYNTHETIC_STREGA_PROFILE_ID,deviceProfileName:'OSI STREGA Valve',applicationId:FIELD_TESTER_APP},object:{Valve:1,Battery:80},time:'2026-01-01T00:00:00Z'}};
 const result=await runNode('strega-process-fn',msg,{env,node,osiDb});
 assert.ok(result&&result.formattedData);
 assert.equal(calls.database,1);
});

// --- Finding 1 (LoRaWAN consultant review): field tester reply wiring (radio-capture-fn) ---
// radio-capture-fn computes the six-byte field-tester reply with the REAL
// encodeFieldTesterReply (proving the fCnt/receivers/devicePosition plumbing is
// right, not just that some stub was called) and enqueues it as a ChirpStack
// downlink through the chirpstack lib BEFORE store.capture runs, and before the
// recovery-state gate -- not after, and with no queue flush first. RAK's own
// reference server (field-tester-server/server/server.js) never flushes either:
// a Class A device drains one queue item per uplink so staleness cannot build
// up, and every bootstrapped profile sets flush_queue_on_activate so a rejoin
// clears leftovers anyway. A flush ahead of a late enqueue could otherwise
// delete the pending reply outright inside ChirpStack's own ~100ms queue-read
// window. The mock chirpstack client below does not even expose
// flushDeviceQueue, so a regression that reintroduces the call would surface as
// a stray warn in every happy-path test. fromChirpStack/normalizeUplink/
// getSharedStore are faked here: they touch the DB and network decoding,
// already covered by test-radio-chirpstack.js/test-radio-store.js, and are not
// the concern of this wiring test.
test('radio-capture-fn declares the chirpstack lib binding it now calls',()=>{
 const capture=flows.find(n=>n.id==='radio-capture-fn');
 assert.ok(capture.libs.some(l=>l.var==='chirpstack'&&l.module==='osi-chirpstack-helper'));
});

// radio-capture-fn is fed by the wildcard application/+/device/+/event/up, so the
// uplink's own application id is what separates a field tester from a valve. Every
// capture test therefore builds its msg through one of these two helpers rather than
// a bare {payload:{fCnt}}, which carries no application and would be fenced out.
// testerUplink carries fPort:1 and a genuine 10-byte payload (TESTER_FRAME_DATA) so it
// also clears the port/length gate added for the 2026-09-22 rehearsal-loop fix below --
// every pre-existing test that expects a reply depends on this shape now, same as the
// real RAK10701's standard field-test frame does.
const TESTER_EUI='A840410000000001';// the device typed RAK10701_FIELD_TESTER in the fake devices table
function testerUplink(fCnt){return {payload:{fCnt,deviceInfo:{devEui:'A840410000000001',applicationId:FIELD_TESTER_APP},fPort:1,data:TESTER_FRAME_DATA}};}
function otherAppUplink(fCnt){return {payload:{fCnt,deviceInfo:{devEui:'A840410000000002',applicationId:OTHER_APP},fPort:1,data:TESTER_FRAME_DATA}};}
function makeCaptureSandbox({receivers,reportedPosition,enqueueImpl,captureImpl,identity,fieldTesterApp=FIELD_TESTER_APP,testerEuis=[TESTER_EUI],testerLookupError=null,enqueueFailsOnce=false}){
 // `order` records the sequence of side-effecting calls (enqueue vs capture) so
 // Finding 1's reordering can be pinned directly, not just inferred from which
 // calls happened at all.
 const calls={capture:[],enqueue:[],statusSet:[],warn:[],order:[],fromChirpStackContexts:[],testerQueries:[],clientsCreated:0};
 // Node-RED's default in-memory node context: persists across runs of one node.
 const contextStore=new Map();
 const context={get:(k)=>contextStore.get(k),set:(k,v)=>{contextStore.set(k,v);}};
 let enqueueFailuresLeft=enqueueFailsOnce?1:0;
 const fakeRow={
  deveui:'A840410000000001',
  recorded_at:'2026-09-25T10:00:00Z',
  deduplication_id:'dedupe-1',
  metadata:{receivers:receivers,reported_position:reportedPosition,device_location:null}
 };
 const fakeRadio={
  // The real helper takes the DevEUI from the uplink it was handed, which is exactly
  // why an unfenced reply would be addressed to whichever device just transmitted.
  fromChirpStack:(payload,context)=>{calls.fromChirpStackContexts.push(context);return {...fakeRow,deveui:String((payload&&payload.deviceInfo&&payload.deviceInfo.devEui)||fakeRow.deveui).toUpperCase()};},
  normalizeUplink:(row,opts)=>({installation_uuid:opts.installationUuid,deveui:row.deveui,recorded_at:row.recorded_at,deduplication_id:row.deduplication_id,metadata_json:'{}'}),
  getSharedStore:async()=>({capture:async(normalized)=>{
   calls.order.push('capture');
   if(captureImpl)return captureImpl(normalized);
   calls.capture.push(normalized);
  }}),
  fieldtester:{encodeFieldTesterReply,classifyUplinkFrame}
 };
 const osiLib={require:(name)=>{
  if(name==='radio')return{ok:true,value:fakeRadio};
  return{ok:false,error:name+' unavailable in this fixture'};
 }};
 const osiDb={Database:function(){return{
  // Two different queries reach get(): installation identity and the device-type lookup.
  get:async(sql,params)=>{
   if(String(sql).includes('FROM devices')){
    calls.testerQueries.push({sql:String(sql),params});
    if(testerLookupError)throw testerLookupError;
    return String(sql).includes("type_id='RAK10701_FIELD_TESTER'")&&testerEuis.includes(params[0])?{present:1}:undefined;
   }
   return identity||{installation_uuid:'11111111-1111-4111-8111-111111111111',recovery_state:'ACTIVE'};
  },
  all:async()=>[],
  close:()=>{}
 };}};
 const env=makeEnv({OSI_RADIO_CAPTURE_ENABLED:'1',DEVICE_EUI:'0016C001F1000002',CHIRPSTACK_PROFILE_RAK10701:'tester-profile',CHIRPSTACK_PROFILE_CLOVER:'clover-profile',CHIRPSTACK_APP_FIELD_TESTER:fieldTesterApp});
 const node={warn:(m)=>{calls.warn.push(m);},status:()=>{},error:()=>{}};
 const global_={set:(k,v)=>{calls.statusSet.push({key:k,value:v});},get:()=>undefined};
 const chirpstack={createProvisioningClientFromEnv:()=>{calls.clientsCreated++;return {
  // No flushDeviceQueue here (Finding 1): radio-capture-fn must never call it, so
  // a regression that reintroduces the call fails with 'not a function', caught
  // by the reply's own try/catch and surfacing as an unexpected warn below.
  enqueueDownlink:async(opts)=>{calls.order.push('enqueue');calls.enqueue.push(opts);if(enqueueFailuresLeft>0){enqueueFailuresLeft--;throw new Error('401 invalid api key');}if(enqueueImpl)return enqueueImpl(opts);return{id:'q-1'};}
 };}};
 // Node-RED's real function-node sandbox provides Buffer as a global (86 existing
 // function nodes already rely on this); radio-capture-fn's new port/length gate is
 // the first thing in this test file's own vm sandbox to need it, so it must be
 // supplied explicitly -- vm.runInNewContext, unlike Node-RED's own function.js,
 // does not inherit the host's globals.
 return{sandbox:{env,node,osiLib,osiDb,global:global_,context,chirpstack,Buffer},calls};
}

test('a tester uplink with receivers enqueues a fPort 2 six-byte reply before capture is even attempted',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5}
 });
 const result=await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1,'the observation must still be captured');
 assert.equal(calls.enqueue.length,1);
 assert.equal(calls.enqueue[0].devEui,'A840410000000001');
 assert.equal(calls.enqueue[0].fPort,2);
 assert.equal(calls.enqueue[0].confirmed,false);
 const dataBuf=Buffer.from(calls.enqueue[0].data,'base64');
 assert.equal(dataBuf.length,6);
 assert.equal(dataBuf[0],4);
 assert.deepEqual(calls.order,['enqueue','capture'],'Finding 1: the reply must be built and enqueued before store.capture runs, not after');
 assert.equal(calls.statusSet.some(s=>s.key==='radio_capture_status'&&s.value.state==='active'),true);
 assert.equal(calls.warn.length,0,'no stray flushDeviceQueue call: the mock chirpstack client does not even expose one');
});

test('no reply when the uplink device in the tester application is not a field tester',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],reportedPosition:{latitude:46.5,longitude:6.5},testerEuis:[]});
 await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(calls.enqueue.length,0);
 assert.equal(calls.capture.length,1,'the observation is still captured');
 assert.equal(calls.fromChirpStackContexts[0].isFieldTester,false);
});
test('reply and GPS decode when the device is typed as a field tester',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],reportedPosition:{latitude:46.5,longitude:6.5},testerEuis:[TESTER_EUI]});
 await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(calls.enqueue.length,1);
 assert.equal(calls.fromChirpStackContexts[0].isFieldTester,true);
 assert.equal(calls.testerQueries[0].params[0],TESTER_EUI);
 assert.equal(Object.hasOwn(calls.fromChirpStackContexts[0],'testerProfileIds'),false,'profile ids no longer take part');
});
test('a typed tester outside the tester application is captured but not answered',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],reportedPosition:{latitude:46.5,longitude:6.5},testerEuis:[TESTER_EUI]});
 const msg=testerUplink(4);msg.payload.deviceInfo.applicationId=OTHER_APP;
 await runNode('radio-capture-fn',msg,sandbox);
 assert.equal(calls.enqueue.length,0);
 assert.equal(calls.capture.length,1);
});
test('a failing tester lookup warns, sends no reply and still captures',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],reportedPosition:{latitude:46.5,longitude:6.5},testerLookupError:new Error('database is locked')});
 await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(calls.warn.filter(m=>m.includes('field tester lookup failed')).length,1);
 assert.equal(calls.warn.length,1);
 assert.equal(calls.enqueue.length,0);
 assert.equal(calls.capture.length,1,'a failed lookup must not pause capture');
 assert.equal(calls.fromChirpStackContexts[0].isFieldTester,false);
 assert.equal(calls.statusSet.some(s=>s.key==='radio_capture_status'&&s.value.state==='active'),true);
});
test('no receiver heard the uplink: no reply is queued, but the observation still captures',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[],reportedPosition:{latitude:46.5,longitude:6.5}});
 const result=await runNode('radio-capture-fn',testerUplink(1),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1);
 assert.equal(calls.enqueue.length,0);
 assert.equal(calls.statusSet.some(s=>s.key==='radio_capture_status'&&s.value.state==='active'),true);
});

test('a receiver heard the uplink but GPS has no fix yet: RSSI/gateway-count still reach the handheld',async()=>{
 // Deliberate design choice (Task 7, question 2): gating the reply on a decoded
 // reported_position would silently withhold a useful signal-strength reading
 // for exactly the moments an operator needs it most (cold GPS start, canopy).
 // encodeFieldTesterReply already zeros only the distance bytes when devicePosition
 // is null (see fieldtester.test.js); the reply itself must still go out. This is a
 // fake row.metadata.reported_position (this file fakes fromChirpStack entirely), not
 // an exercise of the real quality-gated decoder -- see
 // scripts/test-radio-chirpstack.js's all-zero-frame test and
 // osi-radio-helper/index.test.js for that (Finding 3).
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-80,position:{latitude:46.5,longitude:6.5}}],reportedPosition:null});
 await runNode('radio-capture-fn',testerUplink(9),sandbox);
 assert.equal(calls.enqueue.length,1,'RSSI/gateway-count are useful even without a GPS fix; the brief\'s reported_position gate was deliberately not implemented');
 const dataBuf=Buffer.from(calls.enqueue[0].data,'base64');
 assert.equal(dataBuf.length,6);
 assert.equal(dataBuf[1],120);
 assert.equal(dataBuf[3],0,'distance bytes are zero with no device position, exactly as the encoder documents');
 assert.equal(dataBuf[5],1);
});

test('an enqueue failure warns but never prevents or undoes the capture',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5},
  enqueueImpl:async()=>{throw new Error('ChirpStack gRPC unavailable');}
 });
 const result=await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(result,null,'the node must not throw out to Node-RED');
 assert.equal(calls.capture.length,1,'capture already committed before the reply attempt and must not be undone');
 assert.equal(calls.statusSet.some(s=>s.key==='radio_capture_status'&&s.value.state==='active'),true,'capture status must read active, not paused -- a downlink failure is not a capture failure');
 assert.equal(calls.statusSet.some(s=>s.value.state==='paused'),false);
 assert.equal(calls.warn.length,1);
 assert.match(calls.warn[0],/field tester reply not queued/i);
});

// --- Finding 1 mutation proof: the reply must survive a capture-side failure ---
// These two tests are the direct evidence that the reorder actually happened: if
// the reply were still built after store.capture (or after the recovery-state
// check), a thrown capture/recovery error would abort the function before
// calls.enqueue was ever touched, and both assertions below would fail.
test('installation recovery (a capture-blocking state) does not silence the handheld: the reply is already on the wire',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5},
  identity:{installation_uuid:'11111111-1111-4111-8111-111111111111',recovery_state:'RECOVERING'}
 });
 const result=await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(result,null,'the node must not throw out to Node-RED');
 assert.equal(calls.enqueue.length,1,'the reply must reach the handheld even though the recovery-state gate is about to block capture');
 assert.deepEqual(calls.order,['enqueue'],'capture never even started: the recovery gate threw before store.capture was reached');
 assert.equal(calls.capture.length,0);
 assert.equal(calls.statusSet.some(s=>s.value.state==='paused'&&/installation recovery prevents radio capture/.test(s.value.reason)),true);
 assert.equal(calls.warn.some(w=>/installation recovery prevents radio capture/.test(w)),true);
});
test('a store.capture failure (e.g. a radio.db write error) does not block or undo the already-sent reply',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5},
  captureImpl:async()=>{throw new Error('radio.db write failed: disk full');}
 });
 const result=await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(result,null);
 assert.equal(calls.enqueue.length,1,'the reply must already have been enqueued before the failing capture call was even reached');
 assert.deepEqual(calls.order,['enqueue','capture'],'capture is attempted (and fails) only after the reply is already on the wire');
 assert.equal(calls.statusSet.some(s=>s.value.state==='paused'&&/radio\.db write failed/.test(s.value.reason)),true);
 assert.equal(calls.warn.some(w=>/radio\.db write failed/.test(w)),true);
});

// --- Final review, Finding 2: the handheld reply must never reach a non-tester ---
// radio-capture-fn subscribes to application/+/device/+/event/up, so it sees every
// uplink from every device, and the reply it builds goes out on fPort 2 -- the port
// STREGA valves read as opcode||amount. Byte 0 of the reply is fCnt & 0xFF and byte 1
// is minRSSI + 200, so an unfenced reply to a valve is a well-formed timed action:
// 0x21/0x41/0x81 are OPEN for n seconds/minutes/hours. These tests pin the fence.
test('an uplink from another application is captured but never answered',async()=>{
 const RECEIVERS=[{rssi_dbm:-95,position:{latitude:46.5045,longitude:6.5}}];
 const POSITION={latitude:46.5,longitude:6.5};
 const {sandbox,calls}=makeCaptureSandbox({receivers:RECEIVERS,reportedPosition:POSITION});
 // Neither number is arbitrary. Reply byte 0 is fCnt & 0xFF, so fCnt 33 gives 0x21 --
 // STREGA's OPEN-for-n-seconds opcode. Reply byte 1 is minRSSI + 200, so -95 dBm gives
 // 105. The frame this uplink would otherwise have produced is therefore a valid
 // "OPEN for 105 seconds" command. Asserted here so the stakes of the fence are legible
 // and so a change to the encoder that broke this coincidence is noticed rather than
 // quietly weakening the test's rationale.
 const wouldHaveBeen=encodeFieldTesterReply({fCnt:33,receivers:RECEIVERS,devicePosition:POSITION});
 assert.equal(wouldHaveBeen[0],0x21,'byte 0 of the unsent reply really is STREGA OPEN-seconds');
 assert.equal(wouldHaveBeen[1],0x69,'byte 1 really is 105, so this frame would open a valve for 105 seconds');
 const result=await runNode('radio-capture-fn',otherAppUplink(33),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1,'coverage capture is deliberately all-device and must still happen');
 assert.deepEqual(calls.enqueue,[],'no downlink may be addressed to a device outside the field-tester application');
 assert.deepEqual(calls.warn,[]);
 assert.equal(calls.statusSet.some(s=>s.key==='radio_capture_status'&&s.value.state==='active'),true);
});
test('an unset CHIRPSTACK_APP_FIELD_TESTER answers nothing rather than everything',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5},
  fieldTesterApp:''
 });
 const result=await runNode('radio-capture-fn',testerUplink(4),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1);
 assert.deepEqual(calls.enqueue,[],'an unconfigured discriminator must fail closed');
});
test('an uplink carrying no deviceInfo at all is captured and not answered',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5}
 });
 await runNode('radio-capture-fn',{payload:{fCnt:65}},sandbox);
 assert.equal(calls.capture.length,1);
 assert.deepEqual(calls.enqueue,[]);
});

// --- 2026-09-22 rehearsal fix: fPort/length gate on the field-tester reply ---
// The application-id fence above answers ANY uplink from the field-tester application
// regardless of port. fPort 0 is the LoRaWAN MAC-command port, not an application port:
// on the rehearsal gateway, our first reply (16:22:08) provoked a MAC-layer frame from
// the RAK10701 three seconds later (16:22:11, fPort 0, no position); this fence, with no
// port gate, answered that too, provoking the next MAC frame every ~3.5s, forever, at
// SF12 on a battery handheld, until capture was disabled by hand. classifyUplinkFrame
// (osi-radio-helper/fieldtester.js) now gates on fPort and payload length exactly as
// RAK's own reference server does (field-tester-server/server/server.js, ftdProcess():
// "Filter wrong messages by length"; parser_cs34(): `if ((port != 1) && (port != 11))
// return null`). Only the standard fPort-1/10-byte shape is implemented -- it is the only
// shape this fleet has ever sent; the extended fPort-11 format is rejected explicitly.
function macCommandUplink(fCnt){return {payload:{fCnt,deviceInfo:{devEui:'A840410000000001',applicationId:FIELD_TESTER_APP},fPort:0,data:''}};}
function extendedUplink(fCnt){return {payload:{fCnt,deviceInfo:{devEui:'A840410000000001',applicationId:FIELD_TESTER_APP},fPort:11,data:Buffer.alloc(11).toString('base64')}};}
function wrongLengthStandardUplink(fCnt){return {payload:{fCnt,deviceInfo:{devEui:'A840410000000001',applicationId:FIELD_TESTER_APP},fPort:1,data:Buffer.alloc(9).toString('base64')}};}

test('a fPort 0 (LoRaWAN MAC-command) uplink from the field-tester application produces no enqueue -- this is the exact rehearsal loop bug',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5}
 });
 const result=await runNode('radio-capture-fn',macCommandUplink(2972),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1,'coverage capture is still all-device -- a MAC-command frame is still a real observation');
 assert.deepEqual(calls.enqueue,[],'fPort 0 is never a field-test uplink; answering it is exactly the self-sustaining downlink loop the rehearsal hit');
 assert.deepEqual(calls.warn,[],'not a field-test frame at all: silently unanswered, same as any other non-tester uplink, not a rejection warning');
});

test('a genuine standard field-test frame (fPort 1, 10 bytes) still enqueues its reply',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5}
 });
 const result=await runNode('radio-capture-fn',testerUplink(2970),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1);
 assert.equal(calls.enqueue.length,1,'the real field-test shape the RAK10701 sends, and the demo depends on, must still get its reply');
 assert.equal(calls.enqueue[0].fPort,2);
 assert.equal(calls.warn.length,0);
});

test('a wrong-length fPort-1 frame is not answered, matching the vendor\'s own length filter',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5}
 });
 const result=await runNode('radio-capture-fn',wrongLengthStandardUplink(4),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1);
 assert.deepEqual(calls.enqueue,[]);
 assert.deepEqual(calls.warn,[]);
});

test('an extended-format uplink (fPort 11) is recognized as a field-test frame and explicitly rejected, not silently dropped',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5}
 });
 const result=await runNode('radio-capture-fn',extendedUplink(7),sandbox);
 assert.equal(result,null);
 assert.equal(calls.capture.length,1);
 assert.deepEqual(calls.enqueue,[],'the extended reply (fPort 12, 8 bytes) is a different shape we cannot bench-test before the demo -- see fieldtester.js scope decision');
 assert.equal(calls.warn.length,1,'a recognized-but-unimplemented format must say so plainly, not fall through to the silent not-field-test path');
 assert.match(calls.warn[0],/extended-format uplink \(fPort 11\) is not implemented/);
});

// --- Post-deploy hardening (rehearsal review): Buffer.from must never abort capture ---
// ChirpStack v4's contract for msg.payload.data is a base64 string, but Buffer.from
// throws TypeError [ERR_INVALID_ARG_TYPE] for a truthy non-string (a bare number, a
// plain object). Unguarded, that throw runs before the reply's own try/catch, so it
// would propagate to radio-capture-fn's OUTER catch -- the one that pauses
// radio_capture_status and skips store.capture entirely, silently losing the
// observation. A payload this malformed is definitionally not a field-test frame, so
// the fix degrades to that classification instead of aborting the whole capture.
function malformedDataUplink(fCnt){return {payload:{fCnt,deviceInfo:{devEui:'A840410000000001',applicationId:FIELD_TESTER_APP},fPort:1,data:12345}};}

test('a field-tester-application uplink whose data is a non-string truthy value still captures the observation and still does not reply',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({
  receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],
  reportedPosition:{latitude:46.5,longitude:6.5}
 });
 const result=await runNode('radio-capture-fn',malformedDataUplink(4),sandbox);
 assert.equal(result,null,'the unguarded Buffer.from(12345, \'base64\') throws TypeError [ERR_INVALID_ARG_TYPE]; the node must never let that escape to Node-RED');
 assert.equal(calls.capture.length,1,'the all-device capture guarantee must survive a malformed payload on the reply-only path');
 assert.deepEqual(calls.enqueue,[],'a payload we cannot even measure is not a field-test frame -- no reply');
 assert.equal(calls.statusSet.some(s=>s.key==='radio_capture_status'&&s.value.state==='active'),true,'capture status must read active, not paused -- a malformed reply payload is not a capture failure');
 assert.equal(calls.statusSet.some(s=>s.value.state==='paused'),false);
});

// --- Final review, Finding 3: the field tester must be registrable through the product ---
// The type reached the CHECK constraint, the seed, the bundled images, the boot node,
// the sync contract and the GUI union, but not catalog-response or post-devices-insert.
// Two consequences on the customer's screen: /api/network/observations scopes its query
// to registered devices, so the walk's rows are filtered out and the map stays empty;
// and readFieldTesterPresent finds nothing, so the Network header entry never appears.
// scripts/test-flows-wiring.js pins the entries structurally; this proves the path runs.
const REGISTER_ENV={
 DEVICE_EUI:'0016C001F1000002',
 CHIRPSTACK_APP_SENSORS:'app-sensors-uuid',
 CHIRPSTACK_APP_ACTUATORS:'app-actuators-uuid',
 CHIRPSTACK_APP_FIELD_TESTER:'app-field-tester-uuid',
 CHIRPSTACK_PROFILE_RAK10701:'profile-rak10701-uuid'
};
test('a RAK10701 field tester registers instead of 503ing as an unsupported type',async()=>{
 const db=seedTestDb();
 try{
  const response=await executeFunction(loadNode('post-devices-insert'),{
   msg:{payload:[]},// no existing local row
   env:REGISTER_ENV,
   db,
   flowState:{
    new_device_user_id:1,
    new_device_deveui:'A840410000000001',
    new_device_name:'Field tester',
    new_device_type:'RAK10701_FIELD_TESTER',
    new_device_appkey:'000000000000000000000000000000AB'
   }
  });
  assert.equal(response.result[1],null,'the 503 "unsupported device type" branch must not fire');
  const registration=response.result[0].deviceRegistration;
  assert.equal(registration.deviceType,'RAK10701_FIELD_TESTER');
  assert.equal(registration.applicationId,'app-field-tester-uuid','the tester must land in the field-tester application -- radio-capture-fn fences its reply on exactly this id');
  assert.equal(registration.deviceProfileId,'profile-rak10701-uuid');
  db.exec(response.result[0].topic);
  const row=db.prepare("SELECT type_id,chirpstack_app_id FROM devices WHERE deveui='A840410000000001'").get();
  assert.equal(row.type_id,'RAK10701_FIELD_TESTER','the devices CHECK constraint must accept the row that the registration path writes');
  assert.equal(row.chirpstack_app_id,'app-field-tester-uuid');
 } finally { db.close(); }
});
test('catalog-response offers the field tester to the add-device modal',async()=>{
 const response=await executeFunction(loadNode('catalog-response'),{msg:{},env:REGISTER_ENV});
 const catalog=response.result.payload;
 const entry=catalog.find(item=>item.id==='RAK10701_FIELD_TESTER');
 assert.ok(entry,'the add-device modal renders exactly what this node returns; a type missing here cannot be picked at all');
 assert.equal(typeof entry.name,'string');
 assert.ok(entry.name.length>0);
});

test('the reply carries an expiry 700 ms ahead',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],reportedPosition:{latitude:46.5,longitude:6.5}});
 const before=Date.now();
 await runNode('radio-capture-fn',testerUplink(1),sandbox);
 const after=Date.now();
 assert.equal(calls.enqueue.length,1);
 // The node runs in its own vm realm, so instanceof Date against the host's Date is false.
 assert.equal(Object.prototype.toString.call(calls.enqueue[0].expiresAt),'[object Date]','the reply must carry an expiresAt Date');
 const at=calls.enqueue[0].expiresAt.getTime();
 assert.ok(at>=before+700&&at<=after+700,'expiry must be now + 700 ms, got '+(at-before)+' ms');
});
test('an enqueue error drops the cached client',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],reportedPosition:{latitude:46.5,longitude:6.5},enqueueFailsOnce:true});
 await runNode('radio-capture-fn',testerUplink(1),sandbox);
 await runNode('radio-capture-fn',testerUplink(2),sandbox);
 assert.equal(calls.clientsCreated,2);
 assert.equal(calls.enqueue.length,2);
});
test('one ChirpStack client serves consecutive replies',async()=>{
 const {sandbox,calls}=makeCaptureSandbox({receivers:[{rssi_dbm:-93,position:{latitude:46.5045,longitude:6.5}}],reportedPosition:{latitude:46.5,longitude:6.5}});
 await runNode('radio-capture-fn',testerUplink(1),sandbox);
 await runNode('radio-capture-fn',testerUplink(2),sandbox);
 assert.equal(calls.clientsCreated,1);
 assert.equal(calls.enqueue.length,2);
});
