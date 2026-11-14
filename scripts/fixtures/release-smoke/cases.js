'use strict';
// Assertions keep running after an HTTP failure so a missing reply cannot hide a
// lost database write or a wrong radio frame. Setup exceptions never become known failures.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

exports.run = async function(h) {
  const results=[],rechecks=[];
  async function test(id,fn) {
    h.state.caseId=id;
    const failures=[], evidence={};
    const check=(code,ok,actual)=>{if(!ok)failures.push({code,actual});};
    const defer=assertAgain=>rechecks.push(async()=>{
      h.state.caseId=id;
      let completed=false;
      try {await assertAgain();completed=true;}
      finally {console.log('RECHECK',id,completed&&!failures.length?'PASS':'FAIL');}
    });
    await fn(check,evidence,defer);
    results.push({id,failures,evidence});
    console.log('CASE',id,failures.length?JSON.stringify(failures):'PASS');
  }
  const radio=eui=>h.state.cs.calls.filter(c=>c.fn==='enqueue'&&c.eui===eui);
  const logs=async eui=>(await h.sql('SELECT * FROM actuator_log WHERE deveui=?',eui));
  const row=async eui=>(await h.sql('SELECT * FROM devices WHERE deveui=?',eui))[0];
  const expectations=async eui=>(await h.sql('SELECT * FROM valve_actuation_expectations WHERE device_eui=?',eui));
  const httpCheck=(check,r,status,code='http')=>check(code,r.status===status,r);
  const startup=h.state.logs.slice();
  await test('runtime-started',async check=>{
    check('started',startup.some(l=>l.msg==='Started flows'),startup);
    check('missing-types',!startup.some(l=>/missing types|already registered|Error loading|Failed to register/.test(l.msg)),startup);
  });
  let token,user,zone;
  await test('login-and-lists',async(check,e)=>{
    const reg=await h.http('POST','/auth/register',{username:'smoke',password:'Synthetic-pass-1'});httpCheck(check,reg,201,'register');
    const login=await h.http('POST','/auth/login',{username:'smoke',password:'Synthetic-pass-1'});httpCheck(check,login,200,'login');
    token=login.json?.token; if(!token)throw new Error('login did not supply a token');
    user=(await h.sql("SELECT * FROM users WHERE username='smoke'"))[0];check('registered',!!user,user);
    // These fixtures represent devices discovered/claimed before the GUI session.
    const now=new Date().toISOString();
    (await h.sql('INSERT INTO irrigation_zones(name,user_id,timezone,zone_uuid,created_at,updated_at) VALUES (?,?,?,?,?,?)','Smoke zone',user.id,'UTC',randomUUID(),now,now));
    zone=(await h.sql('SELECT * FROM irrigation_zones WHERE user_id=?',user.id))[0];
    (await h.sql('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,claimed_at,irrigation_zone_id,current_state,strega_model) VALUES (?,?,?,?,?,?,?,?,?,?)','A840410000000001','Listed valve','STREGA_VALVE',user.id,now,now,now,zone.id,'CLOSED','MOTORIZED'));
    for(const url of ['/api/devices','/api/irrigation-zones','/api/valves']) {const r=await h.http('GET',url,undefined,token);httpCheck(check,r,200,url);e[url]=r.json;const items=Array.isArray(r.json)?r.json:r.json?.valves;check('list:'+url,Array.isArray(items)&&items.some(item=>url==='/api/irrigation-zones'?item.id===zone.id:(item.deveui||item.device_eui)==='A840410000000001'),r.json);}
    check('radio',h.state.cs.calls.length===0,h.state.cs.calls);
  });
  let next=2;
  async function device(type='STREGA_VALVE',zoneId=zone.id) {
    const eui='A8404100'+String(next++).padStart(8,'0'),now=new Date().toISOString();
    (await h.sql('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,claimed_at,irrigation_zone_id,current_state,strega_model) VALUES (?,?,?,?,?,?,?,?,?,?)',eui,'Synthetic device',type,user.id,now,now,now,zoneId,'CLOSED','MOTORIZED'));return eui;
  }
  const commands=[
    {id:'close',method:'POST',url:e=>'/api/valve/'+e,body:{action:'CLOSE'},port:1,hex:'30'},
    {id:'close-duration',method:'POST',url:e=>'/api/valve/'+e,body:{action:'CLOSE_FOR_DURATION',duration_minutes:2},port:2,hex:'4002'},
    {id:'open-duration',method:'POST',url:e=>'/api/valve/'+e,body:{action:'OPEN_FOR_DURATION',duration_minutes:2},port:2,hex:'4102'},
    {id:'interval',method:'PUT',url:e=>'/api/devices/'+e+'/strega/interval',body:{closedMinutes:10,openedMinutes:2},port:11,hex:'000a0002'},
    {id:'timed-close',method:'PUT',url:e=>'/api/devices/'+e+'/strega/timed-action',body:{action:'CLOSE',unit:'MINUTES',amount:2},port:2,hex:'4002'},
    {id:'magnet',method:'PUT',url:e=>'/api/devices/'+e+'/strega/magnet',body:{enabled:true},port:22,hex:'31'},
    {id:'partial-close',method:'PUT',url:e=>'/api/devices/'+e+'/strega/partial-opening',body:{action:'CLOSE',percentage:50},port:27,hex:'3032'},
    {id:'flushing',method:'PUT',url:e=>'/api/devices/'+e+'/strega/flushing',body:{returnPosition:'CLOSE',percentage:50},port:28,hex:'3032'},
  ];
  for(const c of commands) {
    await test('command-accepted:'+c.id,async(check,e,recheck)=>{
      const eui=(await device());const r=await h.http(c.method,c.url(eui),c.body,token);
      await waitFor(async()=>(await logs(eui)).length>0);
      httpCheck(check,r,202);
      const action={close:'CLOSE','close-duration':'CLOSE_FOR_DURATION','open-duration':'OPEN_FOR_DURATION',interval:'SET_INTERVAL','timed-close':'TIMED_ACTION',magnet:'SET_MAGNET_MODE','partial-close':'SET_PARTIAL_OPENING 50%',flushing:'SET_FLUSHING 50% -> CLOSE'}[c.id];
      const assertOutcome=async()=>{
        e.radio=radio(eui);e.stored=(await logs(eui));
        check('radio',isDeepStrictEqual(e.radio.map(x=>({port:x.port,hex:x.hex})),[{port:c.port,hex:c.hex}]),e.radio);
        check('stored',e.stored.length===1&&e.stored[0].action===action,e.stored);
      };
      await assertOutcome();recheck(assertOutcome);
    });
    await test('command-refused:'+c.id,async(check,e,recheck)=>{
      const eui=(await device('KIWI_SENSOR'));const before=JSON.stringify((await row(eui)));
      const r=await h.http(c.method,c.url(eui),c.body,token);httpCheck(check,r,409);
      await h.sleep(120);
      e.radio=radio(eui);check('radio',e.radio.length===0,e.radio);
      check('stored',(await logs(eui)).length===0&&before===JSON.stringify((await row(eui))),(await row(eui)));
      recheck(async()=>{
        const stored=await logs(eui),sent=radio(eui);
        check('stored',stored.length===0,stored);check('radio',sent.length===0,sent);
      });
    });
  }
  for(const body of [{action:'OPEN'},{action:'OPEN_FOR_DURATION',duration_minutes:0},{action:'OPEN_FOR_DURATION',duration_minutes:256}]) {
    await test('command-invalid:'+JSON.stringify(body),async check=>{const eui=(await device());const r=await h.http('POST','/api/valve/'+eui,body,token);httpCheck(check,r,400);check('radio',radio(eui).length===0,radio(eui));check('stored',(await logs(eui)).length===0,(await logs(eui)));});
  }
  const open=eui=>h.http('POST','/api/valve/'+eui,{action:'OPEN_FOR_DURATION',duration_minutes:1},token);
  // Valve control as in v0.8.1 (owner decision of 2026-11-12): an ordinary open is accepted whatever
  // came before it. The cases below assert the complete call list at the radio stand-in for the
  // valve, not a count: every enqueue with its port, bytes and expiry, and any flush. An ordinary
  // frame carries no queue expiry of the gateway's own. They also assert one record per commanded
  // open, each with its own command id and its 60 seconds, and no record without a command.
  const OPEN_FRAME={fn:'enqueue',port:2,hex:'4101',expiresAt:null};
  const radioCalls=eui=>h.state.cs.calls.filter(c=>c.eui===eui).map(c=>c.fn==='enqueue'?{fn:c.fn,port:c.port,hex:c.hex,expiresAt:c.expiresAt}:{fn:c.fn});
  const records=async eui=>(await h.sql('SELECT * FROM valve_actuation_expectations WHERE device_eui=? ORDER BY rowid',eui));
  const recordSummary=rows=>rows.map(r=>({command:r.command_id!=null,seconds:Number(r.commanded_duration_seconds),state:r.reconciliation_state,trigger:r.trigger}));
  const openRecords=rows=>rows.filter(r=>r.command_id!=null&&Number(r.commanded_duration_seconds)===60);
  const oneRecordPerOpen=(rows,count)=>openRecords(rows).length===count&&new Set(openRecords(rows).map(r=>r.command_id)).size===count&&rows.every(r=>r.command_id!=null);
  const evidenceOf=r=>{try{return Object.keys((JSON.parse(r.transport_json||'{}')||{}).untrusted_report||{}).sort().join('+')||null;}catch(_){return 'unreadable';}};
  await test('open-report-close-open',async(check,e)=>{
    const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
    await h.uplink(eui,1);await waitFor(async()=>(await row(eui)).current_state==='OPEN');check('open-state',(await row(eui)).current_state==='OPEN',(await row(eui)).current_state);
    await h.uplink(eui,0);await waitFor(async()=>(await row(eui)).current_state==='CLOSED');check('closed-state',(await row(eui)).current_state==='CLOSED',(await row(eui)).current_state);
    e.stored=(await expectations(eui));check('settled',e.stored.some(r=>r.observed_open_at&&r.observed_close_at),e.stored);
    httpCheck(check,await open(eui),202,'second-http');check('radio',radio(eui).length===2,radio(eui));
  });
  // Aging translates persisted wall-clock instants together. It changes test data,
  // never code or the runtime clock. The no-report case still reaches the real fence.
  const age=require('./time').age;
  await test('open-no-report-open-later',async(check,e)=>{
    const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
    (await age(h,eui,3*24*60));h.inject('strega-reconciliation-monitor');await h.settle();
    httpCheck(check,await open(eui),202,'later-http');e.stored=(await records(eui));e.radio=radioCalls(eui);
    check('radio',isDeepStrictEqual(e.radio,[OPEN_FRAME,OPEN_FRAME]),e.radio);
    check('stored',e.stored.length===2&&oneRecordPerOpen(e.stored,2),recordSummary(e.stored));
  });
  // The retry without three days of ageing, without a report and without a monitor tick: a
  // refusal that lets go after any wait, however short, fails here. A third open is accepted too.
  await test('open-no-report-open-at-once',async(check,e)=>{
    const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
    httpCheck(check,await open(eui),202,'second-http');httpCheck(check,await open(eui),202,'third-http');
    e.stored=(await records(eui));e.radio=radioCalls(eui);
    check('radio',isDeepStrictEqual(e.radio,[OPEN_FRAME,OPEN_FRAME,OPEN_FRAME]),e.radio);
    check('stored',e.stored.length===3&&oneRecordPerOpen(e.stored,3),recordSummary(e.stored));
  });
  await test('no-clock-open-report-close-open',async(check,e)=>{
    h.setMarker(false);
    try {
      // The valve's OPEN and CLOSED reports reach the gateway before its first time signal, as
      // after a power cut. current_state is the last report the gateway accepted, not the valve's
      // physical state.
      const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
      await h.uplink(eui,1);await waitFor(async()=>(await row(eui)).current_state==='OPEN');check('open-state',(await row(eui)).current_state==='OPEN',(await row(eui)).current_state);
      await h.uplink(eui,0);await waitFor(async()=>(await row(eui)).current_state==='CLOSED');check('closed-state',(await row(eui)).current_state==='CLOSED',(await row(eui)).current_state);
      httpCheck(check,await open(eui),202,'second-http');
      e.stored=(await records(eui));e.radio=radioCalls(eui);
      check('radio',isDeepStrictEqual(e.radio,[OPEN_FRAME,OPEN_FRAME]),e.radio);
      // One record per commanded open and no run without a command: the reports belong to the
      // first open alone, so no second, unexplained record is written.
      check('stored',e.stored.length===2&&oneRecordPerOpen(e.stored,2),recordSummary(e.stored));
      // The reports are kept on the first open as evidence with an untrusted time. Without a
      // time signal no observed time and no completion is invented for it.
      const first=e.stored[0]||{},second=e.stored[1]||{};
      check('report-evidence',evidenceOf(first)==='closed+open'&&evidenceOf(second)===null,e.stored.map(evidenceOf));
      check('no-trusted-time',first.observed_open_at==null&&first.observed_close_at==null&&first.reconciliation_state==='PENDING_OBSERVATION',{observed_open_at:first.observed_open_at,observed_close_at:first.observed_close_at,state:first.reconciliation_state});
      // The time signal arrives: a third open is accepted and the earlier records stay as they are.
      h.setMarker(h.state.markerValue);
      httpCheck(check,await open(eui),202,'third-http');
      const after=(await records(eui));
      check('earlier-records',after.length===3&&evidenceOf(after[0])==='closed+open'&&after[0].observed_close_at==null&&after[0].reconciliation_state==='PENDING_OBSERVATION'&&oneRecordPerOpen(after,3),recordSummary(after));
    } finally {h.setMarker(h.state.markerValue);}
  });
  await test('no-clock-open-no-report-open-later',async(check,e)=>{
    h.setMarker(false);
    try {
      const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
      (await age(h,eui,3*24*60));h.inject('strega-reconciliation-monitor');await h.settle();
      httpCheck(check,await open(eui),202,'later-http');e.stored=(await records(eui));e.radio=radioCalls(eui);
      check('stored',e.stored.length===2&&oneRecordPerOpen(e.stored,2),recordSummary(e.stored));
      check('radio',isDeepStrictEqual(e.radio,[OPEN_FRAME,OPEN_FRAME]),e.radio);
    } finally {h.setMarker(h.state.markerValue);}
  });
  await test('no-clock-open-no-report-open-at-once',async(check,e)=>{
    h.setMarker(false);
    try {
      const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
      httpCheck(check,await open(eui),202,'second-http');httpCheck(check,await open(eui),202,'third-http');
      e.stored=(await records(eui));e.radio=radioCalls(eui);
      check('radio',isDeepStrictEqual(e.radio,[OPEN_FRAME,OPEN_FRAME,OPEN_FRAME]),e.radio);
      check('stored',e.stored.length===3&&oneRecordPerOpen(e.stored,3),recordSummary(e.stored));
    } finally {h.setMarker(h.state.markerValue);}
  });
  await test('no-clock-safety-close',async(check,e)=>{
    h.setMarker(false);
    try {
      const eui=(await device());httpCheck(check,await h.http('POST','/api/valve/'+eui,{action:'CLOSE'},token),202);
      e.radio=radio(eui);check('radio',e.radio.length===1&&e.radio[0].port===1&&e.radio[0].hex==='30'&&!e.radio[0].expiresAt,e.radio);
      // The 202 reply can precede the downstream asynchronous actuator-log insert.
      await waitFor(async()=>(await logs(eui)).length===1);
      check('stored',(await logs(eui)).length===1,(await logs(eui)).length);
    } finally {h.setMarker(h.state.markerValue);}
  });
  for(const id of ['close-duration','timed-close','flushing']) {
    await test('open-after:'+id,async(check,e)=>{
      const c=commands.find(c=>c.id===id),eui=(await device());httpCheck(check,await h.http(c.method,c.url(eui),c.body,token),202,'initial-http');
      const serviceFrame={fn:'enqueue',port:c.port,hex:c.hex,expiresAt:null};
      const beforeCount=(await expectations(eui)).length;(await age(h,eui,3*24*60));
      const reportCount=async()=>(await h.sql('SELECT COUNT(*) n FROM device_data WHERE deveui=?',eui))[0].n;
      const beforeReport=await reportCount();
      await h.uplink(eui,0);
      const reportApplied=async()=>(await row(eui)).current_state==='CLOSED'&&await reportCount()>beforeReport;
      await waitFor(reportApplied);
      check('closed-state',await reportApplied(),{device:await row(eui),reports:await reportCount()});
      httpCheck(check,await open(eui),202,'open-http');e.stored=(await records(eui));e.radio=radioCalls(eui);
      check('stored',e.stored.length===beforeCount+1&&openRecords(e.stored).length===1,recordSummary(e.stored));
      check('radio',isDeepStrictEqual(e.radio,[serviceFrame,OPEN_FRAME]),e.radio);
    });
    // The open right behind the service command: no ageing and no report in between. The call
    // list is the service frame and the open, with no flush between them, as in v0.8.1.
    await test('open-at-once-after:'+id,async(check,e)=>{
      const c=commands.find(c=>c.id===id),eui=(await device());httpCheck(check,await h.http(c.method,c.url(eui),c.body,token),202,'initial-http');
      const serviceFrame={fn:'enqueue',port:c.port,hex:c.hex,expiresAt:null};
      const beforeCount=(await expectations(eui)).length;
      httpCheck(check,await open(eui),202,'open-http');e.stored=(await records(eui));e.radio=radioCalls(eui);
      check('stored',e.stored.length===beforeCount+1&&openRecords(e.stored).length===1,recordSummary(e.stored));
      check('radio',isDeepStrictEqual(e.radio,[serviceFrame,OPEN_FRAME]),e.radio);
    });
  }
  for(const operation of ['assign','remove','delete-device','delete-zone']) {
    await test('lifecycle:'+operation,async(check,e)=>{
      const sensor=(await device('KIWI_SENSOR',operation==='assign'?null:zone.id));let r;
      if(operation==='assign') r=await h.http('PUT',`/api/irrigation-zones/${zone.id}/devices/${sensor}`,{},token);
      if(operation==='remove') r=await h.http('DELETE',`/api/irrigation-zones/${zone.id}/devices/${sensor}`,{},token);
      if(operation==='delete-device') r=await h.http('DELETE','/api/devices/'+sensor,{},token);
      let zid;
      if(operation==='delete-zone') {const now=new Date().toISOString();(await h.sql('INSERT INTO irrigation_zones(name,user_id,timezone,zone_uuid,created_at,updated_at) VALUES (?,?,?,?,?,?)','Disposable zone',user.id,'UTC',randomUUID(),now,now));zid=(await h.sql('SELECT max(id) id FROM irrigation_zones'))[0].id;(await h.sql('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?',zid,sensor));r=await h.http('DELETE','/api/irrigation-zones/'+zid,{},token);}
      httpCheck(check,r,200);e.stored=(await row(sensor));
      const ok=operation==='assign'?e.stored.irrigation_zone_id===zone.id:operation==='remove'?e.stored.irrigation_zone_id===null:operation==='delete-device'?e.stored.user_id===null:!!(await h.sql('SELECT deleted_at FROM irrigation_zones WHERE id=?',zid))[0]?.deleted_at&&e.stored.irrigation_zone_id===null;
      check('stored',ok,{zone:e.stored.irrigation_zone_id,user:e.stored.user_id,deleted:!!e.stored.deleted_at});check('radio',radio(sensor).length===0,radio(sensor));
    });
  }
  const weekly={kind:'WEEKLY',weekdays_mask:127,start_time:'06:00',duration_minutes:20,timezone:'UTC',enabled:true};
  async function waitFor(predicate,timeout=5000) {
    const until=Date.now()+timeout;
    while(!(await predicate())&&Date.now()<until)await h.sleep(40);
  }
  async function trySnapshot(eui) {
    const key='valve_snapshot_pending:'+eui;
    const value=(await h.sql('SELECT value FROM app_settings WHERE key=?',key))[0]?.value;
    if(value){const pending=JSON.parse(value);pending.edited_at=new Date(Date.now()-60000).toISOString();pending.first_edited_at=pending.edited_at;(await h.sql('UPDATE app_settings SET value=? WHERE key=?',JSON.stringify(pending),key));}
    const before=radio(eui).length;
    h.inject('valve-clock-fn');
    await waitFor(()=>radio(eui).length>=before+8);
    // Wait for post-enqueue persistence and the worker's asynchronous close.
    await h.settle();
    return radio(eui).slice(before).filter(c=>c.port>=14&&c.port<=21).map(c=>({port:c.port,hex:c.hex}));
  }
  const planFrames=minutes=>[...Array.from({length:7},(_,day)=>({port:14+day,hex:minutes?'ff8600ff06'+String(minutes)+'ff'.repeat(18):'ff'.repeat(24)})),{port:21,hex:'30'}].sort((a,b)=>a.port-b.port);
  let weeklyEui,weeklyUuid;
  // Caught entries from the scheduler case's deliberate write failure.
  const schedulerWriteFailures=new Set();
  // Holds the farm database's write lock from a separate process (its own SQLite
  // library, as another writer on a gateway) for holdMs, runs during() once the
  // lock is held, and resolves when that process has released it and exited.
  async function holdWriteLock(holdMs,during) {
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',`const s=require(${JSON.stringify(require.resolve('sqlite3'))});const db=new s.Database(${JSON.stringify(h.DBFILE)});
db.exec('BEGIN IMMEDIATE',e=>{if(e){console.error(e.message);process.exit(3);}process.stdout.write('LOCKED\\n');setTimeout(()=>db.exec('ROLLBACK',()=>db.close(()=>process.exit(0))),${Number(holdMs)});});`],{stdio:['ignore','pipe','inherit']});
    const exited=new Promise((resolve,reject)=>child.on('exit',code=>code===0?resolve():reject(new Error('lock holder exited '+code))));
    await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('LOCKED'))resolve();});child.on('exit',code=>reject(new Error('lock holder exited before locking: '+code)));});
    during();
    await exited;
  }
  await test('weekly-save',async(check,e)=>{
    weeklyEui=(await device());const r=await h.http('POST',`/api/valves/${weeklyEui}/schedules`,weekly,token);httpCheck(check,r,201);await h.sleep(150);
    e.stored=(await h.sql('SELECT * FROM valve_schedules WHERE device_eui=?',weeklyEui));weeklyUuid=e.stored[0]?.schedule_uuid;const listed=await h.http('GET',`/api/valves/${weeklyEui}/schedules`,undefined,token);httpCheck(check,listed,200,'list-http');e.list=listed.json;
    check('stored',e.stored.length===1&&e.stored[0].duration_minutes===20,e.stored);
    e.radio=await trySnapshot(weeklyEui);check('radio',isDeepStrictEqual(e.radio.sort((a,b)=>a.port-b.port),planFrames(20)),e.radio);
  });
  await test('weekly-change',async(check,e)=>{
    // Independent precondition if the save failed, so later handlers still get exercised.
    if(!weeklyUuid){weeklyUuid=randomUUID();(await h.sql('INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled) VALUES (?,?,?,?,?,?,?,?)',weeklyUuid,weeklyEui,'WEEKLY',127,'06:00',20,'UTC',1));}
    const r=await h.http('PUT',`/api/valves/${weeklyEui}/schedules/${weeklyUuid}`,{...weekly,duration_minutes:25},token);httpCheck(check,r,200);
    e.stored=(await h.sql('SELECT * FROM valve_schedules WHERE schedule_uuid=?',weeklyUuid))[0];check('stored',e.stored.duration_minutes===25,e.stored);e.radio=await trySnapshot(weeklyEui);check('radio',isDeepStrictEqual(e.radio.sort((a,b)=>a.port-b.port),planFrames(25)),e.radio);
  });
  await test('weekly-delete',async(check,e)=>{
    const r=await h.http('DELETE',`/api/valves/${weeklyEui}/schedules/${weeklyUuid}`,{},token);httpCheck(check,r,200);e.stored=(await h.sql('SELECT * FROM valve_schedules WHERE schedule_uuid=?',weeklyUuid))[0];check('stored',!!e.stored?.deleted_at,e.stored);e.radio=await trySnapshot(weeklyEui);check('radio',isDeepStrictEqual(e.radio.sort((a,b)=>a.port-b.port),planFrames(0)),e.radio);
  });
  await test('scheduler-irrigates',async(check,e)=>{
    const valve=(await device()),sensor=(await device('KIWI_SENSOR'));
    const r=await h.http('PUT',`/api/irrigation-zones/${zone.id}/schedule`,{trigger_metric:'SWT_WM1',threshold_kpa:30,duration_minutes:15,enabled:true},token);httpCheck(check,r,200,'save-http');
    // Existing configuration is the precondition when known defect 1 blocks the save.
    if(!(await h.sql('SELECT 1 FROM irrigation_schedules WHERE irrigation_zone_id=?',zone.id)).length)(await h.sql('INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,duration_minutes,enabled) VALUES (?,?,?,?,?)',zone.id,'SWT_WM1',30,15,1));
    // Keep the scheduler's zone independent of valves used by preceding cases.
    (await h.sql('UPDATE devices SET irrigation_zone_id=NULL WHERE irrigation_zone_id=? AND deveui NOT IN (?,?)',zone.id,valve,sensor));
    (await h.sql('INSERT INTO device_data(deveui,recorded_at,swt_wm1) VALUES (?,?,?)',sensor,new Date().toISOString(),60));
    // F-7. Another process holds the farm database's write lock, as a separate
    // writer on a gateway would. First for 2 s: longer than SQLite's default
    // 1 s wait, shorter than the 5 s the boot node sets on the flows' connection,
    // so both scheduler writes must wait and succeed, and exactly one frame goes out.
    await holdWriteLock(2000,()=>h.inject('a0a61f4b7dca1c2e'));
    await h.settle();
    e.radio=radio(valve);e.stored=(await h.sql('SELECT action,reason,duration_minutes FROM irrigation_events WHERE irrigation_zone_id=?',zone.id));
    check('radio',e.radio.filter(c=>c.port===2&&c.hex==='410f').length===1,e.radio);const persisted=e.stored.some(r=>r.action==='IRRIGATE'&&r.duration_minutes===15);
    const triggered=!!(await h.sql('SELECT last_triggered_at FROM irrigation_schedules WHERE irrigation_zone_id=?',zone.id))[0]?.last_triggered_at;
    e.caught=h.state.caught.filter(c=>c.caseId==='scheduler-irrigates');
    check('scheduler-persistence',persisted&&triggered&&!e.caught.length,{eventStored:persisted,lastTriggered:triggered,errors:e.caught.map(({sourceId,sourceType,message})=>({sourceId,sourceType,message})).sort((a,b)=>a.sourceId.localeCompare(b.sourceId))});
    // Then for 7 s, beyond the wait: the next tick is debounced (already fired
    // today), so its one write is the SKIP event, which fails after 5 s. That
    // failure must be loud: one log line naming the node and the error, the
    // error counted for the heartbeat, and no second frame.
    const counts=()=>Number((h.RED.nodes.getNode('record-error-fn').context().global.get('error_counts')||{}).total)||0;
    const countBefore=counts(),caughtBefore=h.state.caught.length,logsBefore=h.state.logs.length;
    await holdWriteLock(7000,()=>h.inject('a0a61f4b7dca1c2e'));
    await h.settle();
    const failed=h.state.caught.slice(caughtBefore);for(const c of failed)schedulerWriteFailures.add(c);
    e.failedWrite={caught:failed,logged:h.state.logs.slice(logsBefore).filter(l=>l.id==='f7-scheduler-write-log'),counted:counts()-countBefore,radio:radio(valve)};
    check('failed-write-logged',e.failedWrite.logged.length===1&&/DB: insert irrigation_events \(2cb3b5c1a3d0e5f7\): Error: SQLITE_BUSY/.test(e.failedWrite.logged[0].msg)
      &&failed.some(c=>c.catchId==='f7-scheduler-write-catch'&&c.sourceId==='2cb3b5c1a3d0e5f7')&&e.failedWrite.counted>=1
      &&e.failedWrite.radio.filter(c=>c.port===2&&c.hex==='410f').length===1,e.failedWrite);
    const answer=await h.http('GET','/api/irrigation/recent-actuations',undefined,token);httpCheck(check,answer,200,'read-http');
  });
  // F-7, the ordinary shapes. Unserialised, three different valves opened
  // together lost an actuator-log row in about half of all runs, and a
  // scheduler open beside an operator's open lost the scheduler's own
  // last_triggered_at; with the flows' connection serialised neither loses
  // anything. Five rounds each, every row counted.
  await test('three-valves-at-once',async(check,e)=>{
    e.rounds=[];
    for(let round=0;round<5;round++) {
      const euis=[(await device()),(await device()),(await device())];
      const answers=await Promise.all(euis.map(open));await h.settle();
      const rows=[];for(const eui of euis)rows.push({eui,status:answers[euis.indexOf(eui)].status,radio:radioCalls(eui),logRows:(await logs(eui)).length,records:(await records(eui)).length});
      e.rounds.push(rows);
    }
    const all=e.rounds.flat();
    check('http',all.every(r=>r.status===202),all.map(r=>r.status));
    check('radio',all.every(r=>isDeepStrictEqual(r.radio,[OPEN_FRAME])),all.map(r=>r.radio));
    check('actuator-log',all.every(r=>r.logRows===1),all.map(r=>r.logRows));
    check('stored',all.every(r=>r.records===1),all.map(r=>r.records));
  });
  await test('scheduler-beside-operator-open',async(check,e)=>{
    const now=new Date().toISOString();
    (await h.sql('INSERT INTO irrigation_zones(name,user_id,timezone,zone_uuid,created_at,updated_at) VALUES (?,?,?,?,?,?)','Scheduler beside operator',user.id,'UTC',randomUUID(),now,now));
    const schedZone=(await h.sql('SELECT * FROM irrigation_zones WHERE name=?','Scheduler beside operator'))[0];
    const valve=(await device('STREGA_VALVE',schedZone.id)),sensor=(await device('KIWI_SENSOR',schedZone.id));
    (await h.sql('INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,duration_minutes,enabled) VALUES (?,?,?,?,?)',schedZone.id,'SWT_WM1',30,15,1));
    e.rounds=[];
    for(let round=0;round<5;round++) {
      (await h.sql('UPDATE irrigation_schedules SET last_triggered_at=NULL WHERE irrigation_zone_id=?',schedZone.id));
      (await h.sql('INSERT INTO device_data(deveui,recorded_at,swt_wm1) VALUES (?,?,?)',sensor,new Date().toISOString(),60));
      const operatorValve=(await device());
      const eventsBefore=(await h.sql("SELECT COUNT(*) AS n FROM irrigation_events WHERE irrigation_zone_id=? AND action='IRRIGATE'",schedZone.id))[0].n;
      const framesBefore=radio(valve).length;
      h.inject('a0a61f4b7dca1c2e');const answer=await open(operatorValve);await h.settle();
      e.rounds.push({
        event:(await h.sql("SELECT COUNT(*) AS n FROM irrigation_events WHERE irrigation_zone_id=? AND action='IRRIGATE'",schedZone.id))[0].n-eventsBefore,
        lastTriggered:!!(await h.sql('SELECT last_triggered_at FROM irrigation_schedules WHERE irrigation_zone_id=?',schedZone.id))[0].last_triggered_at,
        schedulerFrames:radio(valve).slice(framesBefore).filter(c=>c.port===2&&c.hex==='410f').length,
        operator:{status:answer.status,radio:radioCalls(operatorValve),logRows:(await logs(operatorValve)).length,records:(await records(operatorValve)).length},
      });
    }
    check('scheduler-event',e.rounds.every(r=>r.event===1),e.rounds.map(r=>r.event));
    check('last-triggered',e.rounds.every(r=>r.lastTriggered),e.rounds.map(r=>r.lastTriggered));
    check('scheduler-radio',e.rounds.every(r=>r.schedulerFrames===1),e.rounds.map(r=>r.schedulerFrames));
    check('operator',e.rounds.every(r=>r.operator.status===202&&isDeepStrictEqual(r.operator.radio,[OPEN_FRAME])&&r.operator.logRows===1&&r.operator.records===1),e.rounds.map(r=>r.operator));
  });
  const disabled=new Set(h.flows.filter(n=>n.type==='tab'&&n.disabled).map(n=>n.id));
  const routes=h.flows.filter(n=>n.type==='http in'&&!n.d&&!disabled.has(n.z));
  const publicGet=new Set(['/api/catalog','/api/system/features']);
  for(const route of routes) {
    const method=route.method.toUpperCase(),id=`no-token:${method} ${route.url}`;
    await test(id,async(check,e)=>{
      const url=route.url.replace(/:deveui\b/g,weeklyEui).replace(/:(id|zone_id|zoneId)\b/g,String(zone.id)).replace(/:[A-Za-z_]+/g,'00000000-0000-4000-8000-000000000001').replace('*','x');
      const storedSnapshot=async()=>JSON.stringify([(await h.sql('SELECT deveui,user_id,irrigation_zone_id,deleted_at FROM devices')),(await h.sql('SELECT id,name,deleted_at FROM irrigation_zones')),(await h.sql('SELECT schedule_uuid,duration_minutes,deleted_at FROM valve_schedules'))]);
      const storedBefore=(await storedSnapshot());
      const radioBefore=h.state.cs.calls.length;
      const r=await h.http(method,url,['POST','PUT','PATCH','DELETE'].includes(method)?{}:undefined);
      check('stored',storedBefore===(await storedSnapshot()),'unauthenticated request changed devices, zones or schedules');
      check('radio',radioBefore===h.state.cs.calls.length,'unauthenticated request reached ChirpStack');
      e.response=r;
      const isPublic=method==='GET'&&publicGet.has(route.url);
      check('http',isPublic?r.status>=200&&r.status<300:method==='OPTIONS'?(r.status>=200&&r.status<300||r.status>=400&&r.status<500):r.status>=400&&r.status<500,r);
    });
  }
  // Do not let the later manual/cron scheduler injects water the scenario's
  // synthetic zone again. Their handlers still run against an explicit empty
  // eligible set, while the scheduler case above owns the populated case.
  await h.sql('UPDATE irrigation_schedules SET enabled=0');
  const dendro=await device('DRAGINO_LSN50');
  await h.sql('UPDATE devices SET dendro_enabled=1 WHERE deveui=?',dendro);
  const weatherLogStart=h.state.logs.length;
  await test('enabled-inject-sweep',async(check,e)=>{
    await h.sweepInjects(async config=>{
      if(config.id==='dendro-daily-inject')await h.sql('UPDATE irrigation_zones SET latitude=0,longitude=0 WHERE id=?',zone.id);
    },async config=>{
      if(config.id==='dendro-daily-inject')await h.sql('UPDATE irrigation_zones SET latitude=NULL,longitude=NULL WHERE id=?',zone.id);
    });
    e.sweep=h.state.sweep;
    check('injects',e.sweep.length===require('./observation').enabledInjects(h.flows).length,e.sweep);
  });
  await test('dendro-weather-transport',async(check,e)=>{
    e.warnings=h.state.logs.slice(weatherLogStart).filter(l=>l.id==='dendro-compute-fn'&&l.level==='warn').map(l=>l.msg);
    check('weather-transport',e.warnings.length===0,e.warnings);
    e.daily=await h.sql('SELECT rainfall_mm,vpd_source FROM zone_daily_recommendations WHERE zone_id=? ORDER BY date DESC LIMIT 1',zone.id);
    check('weather-output',e.daily.length===1&&e.daily[0].rainfall_mm===5.4&&e.daily[0].vpd_source==='openagri',e.daily);
  });
  await test('caught-node-errors',async(check,e)=>{
    const expected=require('./expected-refusals.json');
    e.unexpected=h.state.caught.filter(c=>{
      // The scheduler case provokes one write failure on purpose and asserts it
      // is logged. Any other BUSY, there or elsewhere, stays red.
      if(schedulerWriteFailures.has(c))return false;
      return !require('./observation').isExpectedRefusal(c,expected);
    });
    check('caught-errors',e.unexpected.length===0,e.unexpected);
  });
  await test('network-contained',async check=>check('network',!h.state.logs.some(l=>l.level==='NET_REFUSED'),h.state.logs.filter(l=>l.level==='NET_REFUSED')));
  const source=path.join(__dirname,'../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  await test('flows-unchanged',async check=>check('bytes',fs.readFileSync(source).equals(fs.readFileSync(path.join(h.RUN,'flows.json'))),'Node-RED rewrote the flow file'));
  await test('helpers-unchanged',async check=>{
    const source=path.join(__dirname,'../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
    function same(rel) {
      const a=path.join(source,rel),b=path.join(h.RUN,rel);
      if(fs.statSync(a).isDirectory())return fs.readdirSync(a).every(name=>same(path.join(rel,name)));
      return fs.readFileSync(a).equals(fs.readFileSync(b));
    }
    const changed=fs.readdirSync(source).filter(name=>(name.startsWith('osi-')||name==='codecs'||name==='nodes')&&!same(name));
    check('bytes',changed.length===0,changed);
  });
  await h.settle();
  // Side branches can add a forbidden row/frame or duplicate an accepted one.
  for(const recheck of rechecks)await recheck();
  // All error-level events are checked, including non-function nodes. Keep the
  // established F-14 node error separate from unhandled function errors.
  await test('startup-node-errors',async check=>{
    const errors=h.state.logs.filter(l=>l.level==='error'&&l.type!=='function').map(l=>({id:l.id,msg:l.msg}));
    check('node-errors',errors.length===0,errors);
  });
  // Check after scenarios and the explicit sweep, including late handlers.
  await test('startup-function-errors',async check=>check('function-errors',!h.state.logs.some(l=>l.type==='function'&&l.level==='error'),h.state.logs.filter(l=>l.type==='function'&&l.level==='error')));
  await test('database-integrity',async check=>{const rows=await h.sql('PRAGMA quick_check');check('quick-check',rows.length===1&&rows[0].quick_check==='ok',rows);});
  // F-7. The node file nodes/osi-sqlite-serialize.js puts the flows' shared
  // connection (the handle node-red-node-sqlite keeps as `db` on the sqlitedb
  // configuration node) into serialized mode at every start of the flows.
  // Checked by its effect: while another process holds the write lock, a read
  // and a write issued together on that handle must not stall the event loop
  // (in parallel mode the read's finalisation waits on the write for the whole
  // hold). Then again after a restart of the flows, which makes a new handle.
  // Last, because the restart re-runs every start-up flow.
  await test('flows-db-serialized',async(check,e)=>{
    const handle=()=>h.RED.nodes.getNode('734737e846d06893')?.db;
    async function stalls(db) {
      const gaps=[];
      for(let i=0;i<3;i++) {
        let last=performance.now(),gap=0,both;
        const tick=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;},1);
        await holdWriteLock(800,()=>{both=Promise.all([new Promise(r=>db.all('SELECT id FROM users LIMIT 1',r)),new Promise(r=>db.run('UPDATE users SET id=id WHERE 0',r))]);});
        await both;clearInterval(tick);gaps.push(Math.round(gap));
      }
      return gaps;
    }
    const first=handle();
    e.marked=!!first?.[Symbol.for('osi.flowsDbSerialized')];e.gaps=await stalls(first);
    check('serialized-after-start',e.marked&&e.gaps.every(g=>g<300),{marked:e.marked,gaps:e.gaps});
    await h.RED.runtime.flows.setFlows({deploymentType:'reload'});
    await h.settle();
    const second=handle();
    e.newHandle=!!second&&second!==first;e.markedAfterRestart=!!second?.[Symbol.for('osi.flowsDbSerialized')];e.gapsAfterRestart=second?await stalls(second):null;
    check('serialized-after-restart',e.newHandle&&e.markedAfterRestart&&e.gapsAfterRestart.every(g=>g<300),{newHandle:e.newHandle,marked:e.markedAfterRestart,gaps:e.gapsAfterRestart});
    e.errors=h.state.logs.filter(l=>/osi-sqlite-serialize/.test(String(l.msg)));
    check('no-error-line',e.errors.length===0,e.errors);
  });
  return results;
};
