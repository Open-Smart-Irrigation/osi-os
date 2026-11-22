'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {execute,ROOT,normalize}=require('./daily-scheduler-harness');
const {cases,NOW}=require('./daily-scheduler-cases');
const legacy=require('../fixtures/daily-scheduler/legacy-nodes.json');
const adapters=require('../fixtures/daily-scheduler/adapters.json');
const EUI='A840410000000001';
function fixture() {
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(path.join(ROOT,'database/seed-blank.sql'),'utf8'));
 raw.exec(`INSERT INTO users(id,username,password_hash,user_uuid,created_at,role) VALUES(1,'actor''s name','h','synthetic-actor','2026-01-01','researcher');
 INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui) VALUES(2,'Synthetic',1,'synthetic-zone','0016C001F1000001'),(3,'Second',1,'second-zone','0016C001F1000001');
 INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,duration_minutes,enabled,response_mode,sync_version) VALUES(2,'SWT_1',30,20,1,'fixed',1),(3,'SWT_1',30,20,1,'fixed',1);
 INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('${EUI}','Valve','STREGA_VALVE',1,2,'2026-01-01','2026-01-01');
 INSERT INTO sync_link_state(peer_node,linked,updated_at) VALUES('cloud',1,'2026-01-01');DELETE FROM sync_outbox;`);
 return raw;
}
function snapshot(raw) {return normalize({schedules:raw.prepare('SELECT irrigation_zone_id,enabled,last_triggered_at,sync_version,duration_minutes FROM irrigation_schedules ORDER BY irrigation_zone_id').all(),events:raw.prepare('SELECT action,reason,irrigation_zone_id,payload_json FROM irrigation_events ORDER BY id').all(),outbox:raw.prepare("SELECT aggregate_type,op,payload_json,sync_version FROM sync_outbox WHERE aggregate_type='SCHEDULE' ORDER BY rowid").all(),owners:raw.prepare('SELECT command_id,device_eui,reconciliation_state FROM valve_actuation_expectations ORDER BY rowid').all(),occurrences:raw.prepare('SELECT command_id,state,device_eui FROM irrigation_occurrences ORDER BY rowid').all()});}
async function sequence(variant,profile,scenario) {
 const nodes=variant==='legacy'?legacy:adapters;
 const moduleRoot=path.join(ROOT,'conf',profile,'files/usr/share/node-red');
 const {facade}=require(path.join(moduleRoot,'osi-valve-control/test-helpers'));
 const dispatch=require(path.join(moduleRoot,'osi-valve-control/dispatch'));
 let raw=fixture(),db=facade(raw);const trace=[],queue=[];
 const restartDir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'x1-restart-'));
 const byEntry=entry=>nodes.find(n=>n.id===legacy.find(n=>n.name===({zones:'Build zones query (enabled schedules)',mean:'Build mean query (last hour, all datapoints)',decide:'Decide + build actuator cmd + build DB logs',decode:'Decode Token',validate:'Verify Zone Ownership',upsert:'Build UPSERT'})[entry]).id);
 const run=async(entry,c,overrides)=>execute(byEntry(entry).func,c,profile,null,overrides);
 const sql=(label,topic,fault)=>{try {if(fault===label) throw new Error('synthetic SQL '+label); const rows=raw.prepare(topic).all();trace.push(['SQL',label,rows]);return rows;}catch(error){trace.push(['Catch',label,error.message]);return null;}};
 const decisionCase=()=>structuredClone(cases().find(c=>c.name==='swt-mean-30'));
 async function decide(c,index,fault) {
  const out=await run('decide',c);trace.push(['decision',out]);
  if(!Array.isArray(out.result)) return;
  if(out.result[0]) {
   const command=out.result[0].payload;
   try {
    const reservation=await dispatch.reserveValveCommand({db,command:{device_eui:command.device.devEui,zone_id:command.device.zone_id,command_id:'tick-'+index,expectation_id:'owner-'+index,action:command.data.action,duration_minutes:command.data.duration_minutes,commanded_at:new Date(c.now??NOW).toISOString()},now:new Date(c.now??NOW).toISOString()});
    const sent=await dispatch.enqueueValveCommand({db,deviceEui:EUI,owner:{type:'expectation',id:reservation.expectation.expectation_id},item:{fPort:14,data:'AQI='},transport:{async enqueueDownlink(item){queue.push({fPort:item.fPort,data:item.data});return {id:'queue-'+queue.length};}},now:new Date(c.now??NOW).toISOString()});
    trace.push(['dispatch',sent.phase]);
   } catch(error){trace.push(['dispatch-refused',error.code,error.message]);}
  }
  for(const [port,label] of [[1,'event-insert'],[2,'last-trigger-update']]) if(out.result[port])sql(label,out.result[port].topic,fault);
  trace.push(['state',snapshot(raw),{queue:[...queue]}]);
 }
 try {
  if(scenario==='overlapping-ticks-restart' || scenario==='stale-reassigned-valve' || scenario==='conditional-busy') {
   async function readTick(zoneId) {
    const built=await run('zones',{msg:{}});
    const row=raw.prepare(built.result.topic).all().find(r=>r.zone_id===zoneId);
    assert.ok(row,'real zone query yields tick snapshot');assert.equal(row.last_triggered_at,null,'snapshot precedes marker write');
    const c=decisionCase();for(const key of Object.keys(c.msg.zone))c.msg.zone[key]=row[key];return c;
   }
   const c=await readTick(2);
   if(scenario==='stale-reassigned-valve')raw.prepare('UPDATE devices SET irrigation_zone_id=3 WHERE deveui=?').run(EUI);
   const second=await readTick(scenario==='stale-reassigned-valve'?3:2);
   assert.equal(c.msg.zone.valve_deveui,second.msg.zone.valve_deveui,'same EUI from production query snapshots');
   if(scenario==='conditional-busy') raw.prepare('INSERT INTO irrigation_occurrences(schedule_uuid,local_date,local_time,device_eui,due_at,state,expires_at,reservation_end_at,command_id,decision_evidence_json,reserved_minutes) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('stored-policy','2026-05-10','06:00',EUI,'2026-05-10T06:00:00Z','SENT','2026-05-10T06:15:00Z','2026-05-10T06:25:00Z','conditional-owner',JSON.stringify({minimum_gap_minutes:60,exclusion_end_at:'2026-05-10T07:25:00Z'}),20);
   await decide(c,1);
   await decide(second,2);
   if(scenario==='overlapping-ticks-restart') {
    const loaded=decisionCase();loaded.msg.zone.last_triggered_at=raw.prepare('SELECT last_triggered_at FROM irrigation_schedules WHERE irrigation_zone_id=2').get().last_triggered_at;
    await decide(loaded,3);
    const file=path.join(restartDir,'farming.db');raw.exec("VACUUM INTO '"+file.replace(/'/g,"''")+"'");raw.close();raw=new DatabaseSync(file);db=facade(raw);trace.push(['restart','database reopened; transport queue retained']);
    const restart=decisionCase();restart.now=NOW+86400000;await decide(restart,4);
   }
   assert.ok(trace.some(t=>t[0]==='dispatch-refused'&&t[1]==='valve_busy'),scenario+' reaches real reservation refusal');
   assert.equal(queue.length,scenario==='conditional-busy'?0:1,'transport queue contains only accepted open');
   assert.equal(snapshot(raw).events.filter(e=>e.action==='IRRIGATE').length,scenario==='overlapping-ticks-restart'?3:2,'premature events retained');
  } else if(['event-insert','last-trigger-update'].includes(scenario)) {
   await decide(decisionCase(),1,scenario);
   const loaded=decisionCase();loaded.msg.zone.last_triggered_at=raw.prepare('SELECT last_triggered_at FROM irrigation_schedules WHERE irrigation_zone_id=2').get().last_triggered_at;
   await decide(loaded,2);
   assert.ok(trace.some(t=>t[0]==='Catch'&&t[1]===scenario));
   assert.equal(trace.filter(t=>t[0]==='decision'&&t[1].result[0]).length,scenario==='event-insert'?1:2,'partial write controls reloaded decision');
  } else if(['zone-select','swt-select','dendro-select'].includes(scenario)) {
   const c=decisionCase();
   const query=scenario==='zone-select'?await run('zones',{msg:{}}):await run('mean',{msg:{payload:{...c.msg.zone,trigger_metric:scenario==='dendro-select'?'DENDRO':'SWT_1'}}});
   sql(scenario,query.result.topic,scenario);assert.equal(trace[0][0],'Catch');assert.equal(snapshot(raw).events.length,0);
  } else if(scenario==='disabled-policy-excluded') {
   raw.exec("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,enabled,timezone,condition_json) VALUES('policy','synthetic-zone',0,'UTC','{}')");
   const query=await run('zones',{msg:{}});const rows=sql('zones',query.result.topic);
   assert.ok(!rows.some(r=>r.zone_id===2),'disabled undeleted policy excludes legacy schedule');trace.push(['policy-exclusion',rows.map(r=>r.zone_id)]);
  } else if(['user-lookup','ownership-select','upsert','outbox-trigger','interleaved-peer','interleaved-tick','interleaved-writes'].includes(scenario)) {
   const c=structuredClone(cases().find(c=>c.name==='auth-valid'));c.msg._msgid='save-sequence';
   let auth=await run('decode',c);let msg=auth.result[0];
   const userRows=sql('user-lookup',msg.topic,scenario);if(!userRows)return normalize({trace,state:snapshot(raw),queue});
   msg.payload=userRows;const validation=await run('validate',{msg});msg=validation.result[0];assert.ok(msg,'validation accepted');
   const zones=sql('ownership-select',msg.topic,scenario);if(!zones)return normalize({trace,state:snapshot(raw),queue});
   msg.payload=zones;
   const built=await run('upsert',{msg});assert.ok(built.result[0]);
   let second;
   if(scenario==='interleaved-writes') {const peer=structuredClone(msg);peer.osi.request.requestId='second-save';peer.osi.request.validatedPatch.duration_minutes=33;second=await run('upsert',{msg:peer});}
   if(scenario==='interleaved-peer')raw.exec('UPDATE irrigation_schedules SET duration_minutes=44,sync_version=6 WHERE irrigation_zone_id=2');
   if(scenario==='interleaved-tick')await decide(decisionCase(),1);
   if(scenario==='outbox-trigger') raw.exec("CREATE TRIGGER synthetic_outbox_abort BEFORE INSERT ON sync_outbox WHEN NEW.aggregate_type='SCHEDULE' BEGIN SELECT RAISE(ABORT,'synthetic outbox-trigger'); END");
   const saved=sql('upsert',built.result[0].topic,scenario);
   trace.push(['save-attempt',snapshot(raw)]);
   if(scenario==='upsert'||scenario==='outbox-trigger') {
    assert.equal(saved,null);assert.equal(snapshot(raw).schedules[0].sync_version,1,'failed statement rolls back row and outbox');
    assert.equal(snapshot(raw).outbox.length,0);
    if(scenario==='outbox-trigger')raw.exec('DROP TRIGGER synthetic_outbox_abort');
    sql('retry',built.result[0].topic);assert.equal(snapshot(raw).outbox.length,1,'retry commits one event');
   }
   if(second) {sql('second-save',second.result[0].topic);assert.equal(snapshot(raw).schedules[0].duration_minutes,33);assert.equal(snapshot(raw).schedules[0].sync_version,2,'both pre-read writes retain legacy version behavior');}
   if(scenario==='interleaved-peer') {assert.equal(snapshot(raw).schedules[0].sync_version,2);assert.equal(snapshot(raw).schedules[0].duration_minutes,20);}
   if(scenario==='interleaved-tick') {assert.ok(snapshot(raw).schedules[0].last_triggered_at);assert.equal(queue.length,1);}
   trace.push(['save-final',snapshot(raw)]);
  } else {
   // Real scope helper reads, with one targeted statement failure per case.
   const scope=require(path.join(moduleRoot,'osi-scope-helper'));scope._resetForTests();
   const base=structuredClone(cases().find(c=>c.name==='auth-scoped-none'));base.failure=undefined;
   let read=0;
   const real={};for(const method of ['get','all','run']) real[method]=(text,params,cb)=>{
    if(typeof params==='function'){cb=params;params=[];}params ||= [];
    try {read++;trace.push(['scope-sql',read,text,params]);if(scenario==='scope-read-'+read)throw new Error('synthetic scope read '+read);
     const result=raw.prepare(text)[method==='run'?'run':method](...params);if(cb){cb(null,result);return;}return Promise.resolve(result);
    }catch(error){if(cb){cb(error);return;}return Promise.reject(error);}
   };
   real.close=cb=>{trace.push(['close']);if(scenario==='close-throw')throw new Error('synthetic close throw');cb(scenario==='close-callback'?new Error('synthetic callback close'):undefined);};
   const loader={require(name){if(name==='scope')return{ok:true,value:scope};if(name==='daily-scheduler')return{ok:true,value:require(path.join(moduleRoot,'osi-daily-scheduler'))};return{ok:false,error:name};}};
   const auth=await run('decode',base,{osiLib:loader,osiDb:{Database:function(){return real;}}});trace.push(['auth',auth]);
   if(scenario.startsWith('scope-read-')) {assert.ok(read>=Number(scenario.slice(11)),scenario+' reaches requested SQL');assert.equal(auth.result[1].statusCode,500);}
   else {assert.ok(auth.result[0],'auth accepted');if(scenario==='close-throw') assert.ok(auth.trace.some(t=>t[0]==='warn'));}
   scope._resetForTests();
  }
  return normalize({trace,state:snapshot(raw),queue});
 } finally {raw.close();fs.rmSync(restartDir,{recursive:true,force:true});}
}
const scenarios=['overlapping-ticks-restart','stale-reassigned-valve','conditional-busy','event-insert','last-trigger-update','zone-select','swt-select','dendro-select','disabled-policy-excluded','user-lookup','ownership-select','upsert','outbox-trigger','interleaved-peer','interleaved-tick','interleaved-writes',...Array.from({length:7},(_,i)=>'scope-read-'+(i+1)),'close-throw','close-callback'];
module.exports={sequence,scenarios};
