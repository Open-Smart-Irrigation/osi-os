'use strict';
// Assertions keep running after an HTTP failure so a missing reply cannot hide a
// lost database write or a wrong radio frame. Setup exceptions never become known failures.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

exports.run = async function(h) {
  const results=[];
  async function test(id,fn) {
    h.state.caseId=id;
    const failures=[], evidence={};
    const check=(code,ok,actual)=>{if(!ok)failures.push({code,actual});};
    await fn(check,evidence);
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
    await test('command-accepted:'+c.id,async(check,e)=>{
      const eui=(await device());const r=await h.http(c.method,c.url(eui),c.body,token);await h.sleep(120);httpCheck(check,r,202);
      e.radio=radio(eui);e.stored=(await logs(eui));
      check('radio',isDeepStrictEqual(e.radio.map(x=>({port:x.port,hex:x.hex})),[{port:c.port,hex:c.hex}]),e.radio);
      const action={close:'CLOSE','close-duration':'CLOSE_FOR_DURATION','open-duration':'OPEN_FOR_DURATION',interval:'SET_INTERVAL','timed-close':'TIMED_ACTION',magnet:'SET_MAGNET_MODE','partial-close':'SET_PARTIAL_OPENING 50%',flushing:'SET_FLUSHING 50% -> CLOSE'}[c.id];
      check('stored',e.stored.length===1&&e.stored[0].action===action,e.stored);
    });
    await test('command-refused:'+c.id,async(check,e)=>{
      const eui=(await device('KIWI_SENSOR'));const before=JSON.stringify((await row(eui)));
      const r=await h.http(c.method,c.url(eui),c.body,token);httpCheck(check,r,409);
      e.radio=radio(eui);check('radio',e.radio.length===0,e.radio);
      check('stored',(await logs(eui)).length===0&&before===JSON.stringify((await row(eui))),(await row(eui)));
    });
  }
  for(const body of [{action:'OPEN'},{action:'OPEN_FOR_DURATION',duration_minutes:0},{action:'OPEN_FOR_DURATION',duration_minutes:256}]) {
    await test('command-invalid:'+JSON.stringify(body),async check=>{const eui=(await device());const r=await h.http('POST','/api/valve/'+eui,body,token);httpCheck(check,r,400);check('radio',radio(eui).length===0,radio(eui));check('stored',(await logs(eui)).length===0,(await logs(eui)));});
  }
  const open=eui=>h.http('POST','/api/valve/'+eui,{action:'OPEN_FOR_DURATION',duration_minutes:1},token);
  await test('open-report-close-open',async(check,e)=>{
    const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
    await h.uplink(eui,1);check('open-state',(await row(eui)).current_state==='OPEN',(await row(eui)).current_state);
    await h.uplink(eui,0);check('closed-state',(await row(eui)).current_state==='CLOSED',(await row(eui)).current_state);
    e.stored=(await expectations(eui));check('settled',e.stored.some(r=>r.observed_open_at&&r.observed_close_at),e.stored);
    httpCheck(check,await open(eui),202,'second-http');check('radio',radio(eui).length===2,radio(eui));
  });
  // Aging translates persisted wall-clock instants together. It changes test data,
  // never code or the runtime clock. The no-report case still reaches the real fence.
  const age=require('./time').age;
  await test('open-no-report-open-later',async(check,e)=>{
    const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
    (await age(h,eui,3*24*60));h.inject('strega-reconciliation-monitor');await h.sleep(200);
    httpCheck(check,await open(eui),202,'later-http');e.stored=(await expectations(eui));
    check('radio',radio(eui).length===2,radio(eui));
    check('stored',e.stored.length===2,e.stored.map(r=>r.reconciliation_state));
  });
  await test('no-clock-open-report-close-open',async(check,e)=>{
    h.setMarker(false);
    try {
      const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
      await h.uplink(eui,1);check('open-state',(await row(eui)).current_state==='OPEN',(await row(eui)).current_state);
      await h.uplink(eui,0);check('closed-state',(await row(eui)).current_state==='CLOSED',(await row(eui)).current_state);
      httpCheck(check,await open(eui),202,'second-http');
      e.stored=(await expectations(eui));check('stored',e.stored.some(r=>r.observed_close_at),e.stored.map(r=>r.reconciliation_state));check('radio',radio(eui).length===2,radio(eui));
    } finally {h.setMarker(h.state.markerValue);}
  });
  await test('no-clock-open-no-report-open-later',async(check,e)=>{
    h.setMarker(false);
    try {
      const eui=(await device());httpCheck(check,await open(eui),202,'initial-http');
      (await age(h,eui,3*24*60));h.inject('strega-reconciliation-monitor');await h.sleep(200);
      httpCheck(check,await open(eui),202,'later-http');e.stored=(await expectations(eui));
      check('stored',e.stored.length===2,e.stored.map(r=>r.reconciliation_state));check('radio',radio(eui).length===2,radio(eui));
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
      const beforeCount=(await expectations(eui)).length;(await age(h,eui,3*24*60));await h.uplink(eui,0);
      httpCheck(check,await open(eui),202,'open-http');e.stored=(await expectations(eui));check('stored',e.stored.length===beforeCount+1,e.stored.map(r=>r.reconciliation_state));check('radio',radio(eui).length===2,radio(eui));
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
    // The clock worker closes its database asynchronously after its last enqueue.
    await h.sleep(120);
    return radio(eui).slice(before).filter(c=>c.port>=14&&c.port<=21).map(c=>({port:c.port,hex:c.hex}));
  }
  const planFrames=minutes=>[...Array.from({length:7},(_,day)=>({port:14+day,hex:minutes?'ff8600ff06'+String(minutes)+'ff'.repeat(18):'ff'.repeat(24)})),{port:21,hex:'30'}].sort((a,b)=>a.port-b.port);
  let weeklyEui,weeklyUuid;
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
    // A separate real SQLite writer deterministically exposes F-7. The two
    // sqlite nodes have no product lock wait; the valve helper does. Release
    // once both refusals arrive, or after 2.5s if a fix makes them wait. No retry.
    const release=await h.writerLock();
    try {
      h.inject('a0a61f4b7dca1c2e');
      await waitFor(()=>h.state.caught.filter(c=>c.caseId==='scheduler-irrigates'&&c.message==='Error: SQLITE_BUSY: database is locked').length>=2,2500);
    } finally {await release();}
    await h.settle();
    e.radio=radio(valve);e.stored=(await h.sql('SELECT action,reason,duration_minutes FROM irrigation_events WHERE irrigation_zone_id=?',zone.id));
    check('radio',e.radio.some(c=>c.port===2&&c.hex==='410f'),e.radio);const persisted=e.stored.some(r=>r.action==='IRRIGATE'&&r.duration_minutes===15);
    const triggered=!!(await h.sql('SELECT last_triggered_at FROM irrigation_schedules WHERE irrigation_zone_id=?',zone.id))[0]?.last_triggered_at;
    e.caught=h.state.caught.filter(c=>c.caseId==='scheduler-irrigates');
    check('scheduler-persistence',persisted&&triggered&&!e.caught.length,{eventStored:persisted,lastTriggered:triggered,errors:e.caught.map(({sourceId,sourceType,message})=>({sourceId,sourceType,message})).sort((a,b)=>a.sourceId.localeCompare(b.sourceId))});
    const answer=await h.http('GET','/api/irrigation/recent-actuations',undefined,token);httpCheck(check,answer,200,'read-http');
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
    const f7Sources=new Set(['2cb3b5c1a3d0e5f7','3a0d9d0f1a1b2c3d']);
    e.unexpected=h.state.caught.filter(c=>{
      // These exact errors are asserted (and listed as F-7) by the scheduler
      // case itself. Any BUSY elsewhere or with another signature stays red.
      if(c.caseId==='scheduler-irrigates'&&f7Sources.has(c.sourceId)&&c.sourceType==='sqlite'&&c.message==='Error: SQLITE_BUSY: database is locked')return false;
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
    const changed=fs.readdirSync(source).filter(name=>(name.startsWith('osi-')||name==='codecs')&&!same(name));
    check('bytes',changed.length===0,changed);
  });
  await h.settle();
  // All error-level events are checked, including non-function nodes. Keep the
  // established F-14 node error separate from unhandled function errors.
  await test('startup-node-errors',async check=>{
    const errors=h.state.logs.filter(l=>l.level==='error'&&l.type!=='function').map(l=>({id:l.id,msg:l.msg}));
    check('node-errors',errors.length===0,errors);
  });
  // Check after scenarios and the explicit sweep, including late handlers.
  await test('startup-function-errors',async check=>check('function-errors',!h.state.logs.some(l=>l.type==='function'&&l.level==='error'),h.state.logs.filter(l=>l.type==='function'&&l.level==='error')));
  await test('database-integrity',async check=>{const rows=await h.sql('PRAGMA quick_check');check('quick-check',rows.length===1&&rows[0].quick_check==='ok',rows);});
  return results;
};
