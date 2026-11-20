'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const H=require('./lib/valve-equivalence-harness');
const evidence=[];
const writeEvidence=require('./lib/valve-ingress-x2-evidence').createEvidenceWriter('X2_STATE_EVIDENCE');
test.after(()=>writeEvidence(evidence));
const clean=value=>JSON.parse(JSON.stringify(value===undefined?null:value));
function observe(gateway,world){
 const trace=[],raw=gateway.raw,prepare=raw.prepare.bind(raw),exec=raw.exec.bind(raw),clock=new DatabaseSync(':memory:');let serial=0,fault=null;
 for(const name of ['datetime','date','julianday','strftime','unixepoch'])raw.function(name,{varargs:true},(...args)=>clock.prepare('SELECT '+name+'('+args.map(()=>'?').join(',')+') AS v').get(...args.map(a=>a==='now'?new Date(world.wall()).toISOString():a)).v);
 raw.function('randomblob',n=>Buffer.alloc(Number(n),(++serial)%256));
 raw.prepare=sql=>{
  const statement=prepare(sql);
  return new Proxy(statement,{get(target,key){const value=target[key];if(typeof value!=='function')return value;
   return (...args)=>{
    trace.push(['sql',String(sql),key,clean(args)]);
    if(fault?.(String(sql),key)){trace.push(['sql.error','fixture SQL failure']);throw new Error('fixture SQL failure');}
    const out=value.apply(target,args);trace.push(['sql.result',clean(out)]);return out;
   };
  }});
 };
 raw.exec=sql=>{trace.push(['sql.exec',sql]);return exec(sql);};
 const original=gateway.runNode.bind(gateway);
 gateway.runNode=async(name,msg)=>{trace.push(['node',name,clean(msg)]);try{const out=await original(name,msg);trace.push(['node.result',name,clean(out)]);return out;}catch(error){trace.push(['node.error',name,error.message]);throw error;}};
 for(const name of ['readQueue','flush','enqueue']){
  const fn=world[name].bind(world);world[name]=(...args)=>{trace.push(['rpc',name,clean(args)]);try{const out=fn(...args);trace.push(['rpc.result',name,clean(out)]);return out;}catch(error){trace.push(['rpc.error',name,error.message]);throw error;}};
 }
 const close=gateway.db.close;gateway.db.close=callback=>{trace.push(['db.close']);return close(callback);};
 return {trace,failSQL:fn=>{fault=fn;},finish(){raw.prepare=prepare;raw.exec=exec;clock.close();}};
}
function pinTables(gateway){
 const tables=['devices','valve_actuation_expectations','valve_schedule_pushes','actuator_log','sync_outbox','irrigation_occurrences','irrigation_decisions'];
 return Object.fromEntries(tables.filter(table=>gateway.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).map(table=>[table,clean(gateway.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all())]));
}
async function seeded(t,profile,mode,script){
 let uuid=0;t.mock.method(crypto,'randomUUID',()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`);
 const world=new H.World(t),gateway=new H.Gateway(H.candidate({profile,x2:mode}),world);
 // Linked state makes trigger/outbox effects part of the comparison.
 gateway.raw.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,updated_at) VALUES ('cloud',1,'https://sync.test.invalid','cloud-user',?,'2026-11-02T06:00:00.000Z')").run(H.GATEWAY_EUI);
 const observer=observe(gateway,world);
 try{
  const result=await script({gateway,world,observer});
  const tables=pinTables(gateway);
  return {trace:observer.trace,tables,result:clean(result),queue:clean(world.readQueue()),log:clean(gateway.log)};
 }finally{observer.finish();gateway.raw.close();}
}
async function compare(t,profile,script){
 const before=await seeded(t,profile,'legacy',script),after=await seeded(t,profile,'rendered',script);
 evidence.push({profile,case:t.name,before,after});
 assert.deepEqual(after,before,'immediate legacy predecessor: complete ordered SQL/RPC/node/ACK/run-log/outbox effects');
 return after;
}
for(const profile of ['bcm2712','bcm2709']){
 test(profile+': shipped manual/cloud/service/scheduler/one-time lanes retain ordered effects',async t=>{
  const out=await compare(t,profile,async({gateway:g,world:w})=>{
   const manual=await g.manual('OPEN_FOR_DURATION',2);assert.equal(manual.answer.status,202);
   const cloud=await g.cloud({commandType:'OPEN_FOR_DURATION',commandId:'cloud-open',duration_seconds:180});assert.equal(cloud.ack.result,'SUCCESS');
   const service=await g.service({action:'SET_INTERVAL',payloadHex:'000a0002',fPort:11,reason:'manual_gui'});
   const scheduler=await g.scheduler(4),once=await g.oneTime(5);
   return {manual,cloud,service,scheduler,once};
  });
  assert.ok(out.trace.some(e=>e[0]==='sql'&&/INSERT INTO actuator_log/i.test(e[1])),'run-log INSERT actually executed');
  assert.ok(out.tables.sync_outbox.length>0,'linked outbox effects recorded');
 });
 test(profile+': duplicate uplink and restart while observed running retain state',async t=>{
  await compare(t,profile,async({gateway:g,world:w})=>{
   await g.manual('OPEN_FOR_DURATION',2);const frame=w.selectNext().frame;assert.ok(frame);w.valveApply(frame);w.advance(H.MINUTE);
   const at=new Date(w.wall()).toISOString();await g.report('OPEN',at);g.reportCount--;await g.report('OPEN',at);
   const running=await g.rows();assert.ok(running.some(r=>r.reconciliation_state==='OBSERVED_RUNNING'));
   g.load();await g.ticks();const cancelled=await g.cancel({open:0});
   w.advance(2*H.MINUTE);await g.report('CLOSED',new Date(w.wall()).toISOString());await g.ticks();
   return {running,cancelled,rows:await g.rows()};
  });
 });
 test(profile+': overlapping command and named cancellation share the reservation',async t=>{
  await compare(t,profile,async({gateway:g})=>{
   let cancellation;
   g.reservationHook=async()=>{cancellation=await g.cancel({open:0});};
   const command=await g.manual('OPEN_FOR_DURATION',2);
   assert.ok(cancellation);return {command,cancellation,rows:await g.rows()};
  });
 });
 test(profile+': downstream run-log SQL failure preserves upstream handoff and ACK order',async t=>{
  await compare(t,profile,async({gateway:g,world:w,observer})=>{
   observer.failSQL(sql=>/INSERT INTO actuator_log/i.test(sql));
   await assert.rejects(g.manual('OPEN_FOR_DURATION',2),/fixture SQL failure/);
   assert.equal(w.enqueued.length,1,'downlink already accepted before log INSERT failure');
   observer.failSQL(null);return {rows:await g.rows()};
  });
 });
 for(const variant of ['ordinary','conditional','conditional-flush-failed','conditional-flush-timeout','read-failed','flush-failed','flush-timeout','requeue-failed','scoped-device-read-failed','close-callback-error']){
  test(profile+': real cancel/scope '+variant,async t=>{
   await compare(t,profile,async({gateway:g,world:w,observer})=>{
    const at=new Date(w.wall()).toISOString();
    await g.db.run("INSERT INTO valve_actuation_expectations(expectation_id,device_eui,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,reconciliation_state,trigger,created_at,transport_json) VALUES ('cancel-target',?,?,120,?,'unknown','PENDING_OBSERVATION','manual_gui',?,?)",[H.EUI,at,new Date(w.wall()+120000).toISOString(),at,JSON.stringify({phase:'ACCEPTED',queue_id:'eq-0001',attempted_at:at})]);
    w.enqueue({devEui:H.EUI,fPort:2,data:Buffer.from([0x41,2]).toString('base64')});
    w.enqueue({devEui:H.EUI,fPort:11,data:Buffer.from([0,10,0,2]).toString('base64')});
    if(variant.startsWith('conditional'))await g.db.run("INSERT INTO irrigation_occurrences(schedule_uuid,local_date,local_time,device_eui,due_at,state,command_id) VALUES ('conditional','2026-11-02','06:00',?,?,'SENT','conditional-command')",[H.EUI,at]);
    if(variant==='scoped-device-read-failed'){
     g.env={OSI_SCOPED_ACCESS:'1'};
     await g.db.run("UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?",[H.EUI]);
     observer.failSQL(sql=>/SELECT deveui, type_id, user_id FROM devices WHERE UPPER/.test(sql));
    }
    const client=g.client.bind(g);g.client=()=>{
     const rpc=client();
     if(variant==='read-failed')rpc.getDeviceQueue=async()=>{observer.trace.push(['rpc.inject','getDeviceQueue']);throw new Error('queue read failed');};
     if(variant.includes('flush-failed')||variant.includes('flush-timeout'))rpc.flushDeviceQueue=async()=>{observer.trace.push(['rpc.inject','flushDeviceQueue']);throw Object.assign(new Error(variant.includes('flush-timeout')?'deadline exceeded':'flush failed'),{code:variant.includes('flush-timeout')?4:13});};
     if(variant==='requeue-failed')rpc.enqueueDownlink=async()=>{observer.trace.push(['rpc.inject','enqueueDownlink']);throw new Error('collateral requeue failed');};
     return rpc;
    };
    if(variant==='close-callback-error')g.db.close=callback=>{observer.trace.push(['db.close.callback-error']);callback(new Error('close callback failed'));};
    const outcome=await g.cancel({open:0});observer.failSQL(null);
    const row=(await g.rows())[0];
    if(variant==='conditional'){
     assert.ok(outcome.body.collateral.some(item=>item.owner_type==='opaque'&&item.fport===11),'flushed setting is reported as collateral');
     assert.equal(outcome.status,409);assert.equal(outcome.body.outcome,'handed_off');assert.equal(row.reconciliation_state,'PENDING_OBSERVATION');assert.equal(w.readQueue().length,0);
     // The reservation still blocks the same conditional occurrence.
     await assert.rejects(g.valveControl.reserveValveCommand({db:g.db,command:{device_eui:H.EUI,command_id:'conditional-retry',action:'OPEN_FOR_DURATION',duration_minutes:1,commanded_at:at,timezone:'UTC'},now:at}),error=>error.code==='valve_busy');
     observer.trace.push(['conditional.retry','valve_busy']);
    }
    if(variant==='ordinary'||variant==='close-callback-error'){assert.equal(outcome.status,200);assert.equal(row.reconciliation_state,'CANCELLED');assert.equal(w.readQueue().length,1);}
    if(variant==='read-failed'){assert.equal(outcome.status,200);assert.equal(outcome.body.queue_scope,'full_flush');assert.equal(row.reconciliation_state,'CANCELLED');assert.equal(w.readQueue().length,0);}
    if(variant==='flush-failed'||variant==='flush-timeout'){assert.equal(outcome.status,500);assert.equal(row.reconciliation_state,'PENDING_OBSERVATION');assert.equal(w.readQueue().length,2);}
    if(variant==='requeue-failed'){assert.equal(outcome.status,200);assert.equal(outcome.body.transport_uncertain,false);assert.ok(observer.trace.some(e=>e[0]==='rpc.inject'&&e[1]==='enqueueDownlink'));assert.equal(w.readQueue().length,0);assert.equal(row.reconciliation_state,'CANCELLED');}
    if(variant.startsWith('conditional-flush')){assert.equal(outcome.status,503);assert.equal(outcome.body.outcome,'uncertain');assert.equal(row.reconciliation_state,'PENDING_OBSERVATION');}
    if(variant==='scoped-device-read-failed'){assert.equal(outcome.status,500);assert.ok(observer.trace.some(e=>e[0]==='sql'&&/zone_uuid\s+FROM irrigation_zones/.test(e[1])),'real scope access succeeded before the injected later lookup');}
    return {outcome,row};
   });
  });
 }
}
