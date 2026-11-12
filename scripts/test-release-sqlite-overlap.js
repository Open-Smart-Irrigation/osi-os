#!/usr/bin/env node
'use strict';
// NEW-15: overlapping valve commands with two copies of the native sqlite3
// addon in the Node-RED process damage the farm database. This case runs the
// shipped flows and helpers in the dependency layout of a gateway, sends the
// overlapping round, stops the runtime and checks the file from outside.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),FIXTURE=path.join(__dirname,'fixtures/release-smoke');
const LAYOUTS=['dual','single','npm','stock'];

// Reproduce the firmware/user-directory dependency boundary. Copies have
// different inodes, including the native addon; hard links cannot test this.
//   dual:   the factory image. Node-RED loads the firmware node-red-node-sqlite
//           with its nested sqlite3; the user directory has its own real sqlite3.
//   single: the user directory's sqlite3 is a link to the firmware copy.
//   npm:    after `npm install` in the user directory: a real node-red-node-sqlite
//           there, which Node-RED prefers, with sqlite3 beside it.
//   stock:  a stock ChirpStack Gateway OS image deployed by script: the firmware
//           has no node-red-node-sqlite and no sqlite3; npm put both into the
//           user directory, so the user copy is the only one.
function prepareLayout(run,layout,worker='sqlite-overlap-worker.js') {
  const deps=path.join(FIXTURE,'node_modules'),firmware=path.join(run,'firmware/node_modules');
  const user=path.join(run,'node_modules');
  fs.mkdirSync(firmware,{recursive:true});fs.mkdirSync(user,{recursive:true});
  for(const name of fs.readdirSync(deps)) {
    if(!['sqlite3','node-red-node-sqlite'].includes(name))fs.symlinkSync(path.join(deps,name),path.join(firmware,name));
  }
  const copyPackage=target=>fs.cpSync(path.join(deps,'node-red-node-sqlite'),target,{recursive:true,
    filter:source=>source!==path.join(deps,'node-red-node-sqlite/node_modules')});
  const nodeDir=path.join(firmware,'node-red-node-sqlite');
  const firmwareDriver=path.join(nodeDir,'node_modules/sqlite3');
  if(layout!=='stock') {
    copyPackage(nodeDir);
    fs.mkdirSync(path.dirname(firmwareDriver),{recursive:true});
    fs.cpSync(path.join(deps,'sqlite3'),firmwareDriver,{recursive:true,dereference:true});
  }
  if(layout==='single')fs.symlinkSync(firmwareDriver,path.join(user,'sqlite3'));
  else fs.cpSync(path.join(deps,'sqlite3'),path.join(user,'sqlite3'),{recursive:true,dereference:true});
  if(layout==='npm'||layout==='stock')copyPackage(path.join(user,'node-red-node-sqlite'));
  else fs.symlinkSync(nodeDir,path.join(user,'node-red-node-sqlite'));
  // The process entry stands where the image's red.js does.
  const entry=path.join(run,'firmware/red.js');
  fs.writeFileSync(entry,`require(${JSON.stringify(path.join(FIXTURE,worker))});\n`);
  return entry;
}

// The parent never loads a SQLite library: each step is a separate sqlite3
// CLI process, before the runtime starts or after it has exited.
function cli(dbfile,sql,{readonly=true}={}) {
  const r=spawnSync('sqlite3',[...(readonly?['-readonly']:[]),'-json',dbfile,sql],{encoding:'utf8',timeout:120000});
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error((r.stderr||'').trim()||'sqlite3 exited '+r.status);
  return r.stdout.trim()?JSON.parse(r.stdout):[];
}

function seedFarm(source,run,dbfile,env) {
  const seed=spawnSync(process.execPath,[path.join(source,'scripts/build-seed-db.js'),'--out',dbfile],{cwd:source,env,encoding:'utf8',timeout:240000});
  fs.writeFileSync(path.join(run,'seed.log'),(seed.stdout||'')+(seed.stderr||''));
  if(seed.error||seed.status!==0)throw new Error('overlap seed failed: '+(seed.error||seed.stderr));
  cli(dbfile,"INSERT INTO users(id,username,password_hash,user_uuid,created_at,updated_at) VALUES(1,'overlap','synthetic','00000000-0000-4000-8000-000000000001',datetime('now'),datetime('now'));"+
    "INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid) VALUES(1,'Synthetic zone',1,'UTC','00000000-0000-4000-8000-000000000002');"+
    Array.from({length:8},(_,i)=>`INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,claimed_at,irrigation_zone_id,current_state,strega_model) VALUES('A8404100000000${String(i+1).padStart(2,'0')}','Synthetic valve ${i+1}','STREGA_VALVE',1,datetime('now'),datetime('now'),datetime('now'),1,'CLOSED','MOTORIZED');`).join(''),
  {readonly:false});
}

function run({source=ROOT,layout='dual'}={}) {
  if(!LAYOUTS.includes(layout))throw new Error('invalid sqlite layout');
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'osi-sqlite-overlap-'));
  console.log('OVERLAP EVIDENCE:',layout,run);
  const dbfile=path.join(run,'data/db/farming.db');
  // libuv's default pool of 4 threads, as on the image.
  const env={PATH:process.env.PATH,HOME:run,LANG:'C.UTF-8',TZ:'UTC',TMPDIR:os.tmpdir(),OSI_SMOKE_RUN:run,OSI_SMOKE_SOURCE:source,UV_THREADPOOL_SIZE:'4'};
  seedFarm(source,run,dbfile,env);
  const entry=prepareLayout(run,layout),logfile=path.join(run,'runtime.log');
  const fd=fs.openSync(logfile,'w');let child;
  try {child=spawnSync(process.execPath,['--max-old-space-size=1536',entry],{cwd:ROOT,env,stdio:['ignore',fd,fd],timeout:190000});}
  finally {fs.closeSync(fd);}
  const text=fs.readFileSync(logfile,'utf8');
  const failures=[],check=(code,ok,actual)=>{if(!ok)failures.push({code,actual});};
  check('scratch-capacity',!/(?:Disk quota exceeded|EDQUOT|ENOSPC)/.test(text+fs.readFileSync(path.join(run,'seed.log'),'utf8')),'quota or disk-space error in the logs');
  check('runtime-exit',!child.error&&child.status===0,{status:child.status,error:child.error?.message||null});
  let evidence={layout,run};
  const observation=path.join(run,'overlap.json');
  if(fs.existsSync(observation)) {
    const result=JSON.parse(fs.readFileSync(observation,'utf8'));
    evidence={...evidence,node:result.node,addons:result.addons,openDatabaseFiles:result.openDatabaseFiles,seconds:result.seconds,maxRSSKiB:result.maxRSSKiB};
    const corrupt=result.logs.filter(l=>/SQLITE_CORRUPT|malformed/i.test(l.msg));
    evidence.corruptLines=corrupt.length;
    check('single-native-addon',result.addons.length===1,result.addons.length);
    check('runtime-corruption',!corrupt.length,corrupt.length?'SQLITE_CORRUPT in the runtime log':null);
    check('responses',result.replies.length===19&&result.replies.every(r=>r.response.status===(r.kind==='open'?202:201)),
      result.replies.map(r=>r.kind+':'+(r.response.status||'none')).join(','));
    check('radio',result.radio.filter(c=>c.fn==='enqueue'&&c.port===2&&c.hex==='4101').length===19,'open frames sent: '+result.radio.filter(c=>c.fn==='enqueue'&&c.port===2&&c.hex==='4101').length);
    check('runtime-budget',result.maxRSSKiB<4*1024*1024&&result.seconds<180,null);
  } else check('observation',false,'runtime wrote no overlap.json');
  let intact=false;
  try {
    const integrity=cli(dbfile,'PRAGMA integrity_check');evidence.integrity=integrity;
    intact=integrity.length===1&&Object.values(integrity[0])[0]==='ok';
    check('integrity',intact,'integrity_check did not answer ok');
  } catch(error) {evidence.integrity=String(error.message||error);check('integrity',false,'database file damaged or unreadable');}
  if(intact) {
    const logs=cli(dbfile,"SELECT deveui,count(*) AS n FROM actuator_log WHERE action='OPEN_FOR_DURATION' GROUP BY deveui ORDER BY deveui");
    evidence.commandRecords=logs;
    check('command-records',logs.length===8&&logs.every((r,i)=>Number(r.n)===(i<3?3:2)),logs);
    const schedules=cli(dbfile,'SELECT device_eui,once_state,once_fired_at FROM valve_schedules ORDER BY device_eui,fire_at');
    evidence.schedules=schedules;
    check('due-schedules',schedules.length===6&&schedules.every(r=>r.once_state==='FIRED'&&!!r.once_fired_at),schedules.map(r=>r.once_state));
  }
  // Prove the harness copied the shipped payload without editing its code.
  check('flows-unchanged',fs.readFileSync(path.join(source,'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json')).equals(fs.readFileSync(path.join(run,'flows.json'))),null);
  const result={id:'overlapping-valves-integrity'+(layout==='dual'?'':'-'+layout+'-layout'),failures,evidence};
  fs.writeFileSync(path.join(run,'summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(failures.length?'OVERLAP FAIL':'OVERLAP PASS',layout,JSON.stringify(failures.map(f=>f.code)),JSON.stringify({addons:evidence.addons?.length,corruptLines:evidence.corruptLines,integrity:evidence.integrity}));
  return result;
}
// Start-up state cases: the file check and the addon count reach the first
// heartbeat and the authenticated stats answer; nothing is repaired.
const STARTUP_FAULTS={
  none:{id:'database-startup-healthy',status:'healthy',health:null},
  damaged:{id:'database-startup-damaged',status:'damaged',health:'database_damaged',log:/\[osi-db-startup\] ERROR farm database start-up check: damaged .*no file was moved or repaired; see docs\/operations\/damaged-farm-database\.md/},
  conflict:{id:'database-startup-module-conflict',status:'healthy',health:'sqlite_module_conflict',log:/\[osi-db-startup\] ERROR found 2 native SQLite addons/},
  // The check answers 12 s after the flows started: first "checking", then damaged.
  damaged_late:{id:'database-startup-damaged-late',status:'checking',health:'database_checking',late:{status:'damaged',health:'database_damaged'},
    log:/\[osi-db-startup\] ERROR farm database start-up check: damaged .*no file was moved or repaired; see docs\/operations\/damaged-farm-database\.md/},
};
const STANDIN_DELAY_S=12;
function startupCase({source=ROOT,fault='none',layout='dual'}={}) {
  const expected=STARTUP_FAULTS[fault];
  if(!expected||!LAYOUTS.includes(layout)||(fault==='conflict'&&layout!=='dual'))throw new Error('invalid start-up case');
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'osi-sqlite-overlap-'));
  console.log('STARTUP EVIDENCE:',fault,layout,run);
  const dbfile=path.join(run,'data/db/farming.db');
  const env={PATH:process.env.PATH,HOME:run,LANG:'C.UTF-8',TZ:'UTC',TMPDIR:os.tmpdir(),OSI_SMOKE_RUN:run,OSI_SMOKE_SOURCE:source,UV_THREADPOOL_SIZE:'4',OSI_STARTUP_FAULT:fault};
  seedFarm(source,run,dbfile,env);
  if(fault==='damaged_late') {
    // A stand-in sqlite3 for the runtime only: it waits, then runs the real one.
    const real=spawnSync('sh',['-c','command -v sqlite3'],{encoding:'utf8'}).stdout.trim();
    const dir=path.join(run,'standin');fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'sqlite3'),`#!/bin/sh\nsleep ${STANDIN_DELAY_S}\nexec ${JSON.stringify(real)} "$@"\n`,{mode:0o755});
    env.PATH=dir+':'+env.PATH;
  }
  if(fault==='damaged'||fault==='damaged_late') {
    // Zero the page-type byte of a non-core index's root page: quick_check
    // reports it, the core tables stay readable.
    const [{page_size:pageSize}]=cli(dbfile,'PRAGMA page_size');
    const [{rootpage}]=cli(dbfile,"SELECT rootpage FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name NOT IN ('users','devices','irrigation_zones') ORDER BY rootpage DESC LIMIT 1");
    const fd=fs.openSync(dbfile,'r+');
    try {fs.writeSync(fd,Buffer.from([0]),0,1,(rootpage-1)*pageSize);} finally {fs.closeSync(fd);}
  }
  const entry=prepareLayout(run,layout,'sqlite-startup-worker.js'),logfile=path.join(run,'runtime.log');
  const fd=fs.openSync(logfile,'w');let child;
  try {child=spawnSync(process.execPath,['--max-old-space-size=1536',entry],{cwd:ROOT,env,stdio:['ignore',fd,fd],timeout:160000});}
  finally {fs.closeSync(fd);}
  const text=fs.readFileSync(logfile,'utf8');
  const failures=[],check=(code,ok,actual)=>{if(!ok)failures.push({code,actual});};
  check('runtime-exit',!child.error&&child.status===0,{status:child.status,error:child.error?.message||null});
  const observation=path.join(run,'startup.json');
  let evidence={fault,layout,run};
  if(fs.existsSync(observation)) {
    const r=JSON.parse(fs.readFileSync(observation,'utf8'));
    // What is shown: the first heartbeat message reaching its MQTT output node
    // carries the state, and is complete for publication. What is not: its
    // publication. The harness broker (aedes, MQTT 3.1.1) cannot accept the
    // cloud broker node's MQTT 5 connection; `published` stays in the evidence.
    const message=r.heartbeats[0]||null;
    let first=null;
    try{first=message&&typeof message.payload==='string'?JSON.parse(message.payload):null;}catch{first=null;}
    check('heartbeat-message',!!first&&message.topic==='devices/0016C001F1000001/heartbeat'&&message.qos===1
      &&first.deviceEui==='0016C001F1000001'&&typeof first.firmwareVersion==='string'&&!Number.isNaN(Date.parse(first.timestamp))
      &&first.health&&typeof first.health==='object'&&'health_state' in first.health&&'schema_sig' in first.health&&'crash_count' in first.health,
      message&&{topic:message.topic,qos:message.qos,keys:first&&Object.keys(first)});
    const database=r.stats.json&&r.stats.json.database;
    evidence={...evidence,statsStatus:r.stats.status,addons:r.addons.length,firstHeartbeatHealth:first?.health?.health_state,database,
      check:r.exec.filter(e=>/^sqlite3 -readonly/.test(e.cmd)).length};
    check('startup-check-ran',evidence.check===1,evidence.check);
    check('tick-order',JSON.stringify(r.tickOrder)===JSON.stringify(['2a4f142e3e9b6d80','062a0f9bf66d9789']),r.tickOrder);
    check('first-heartbeat',!!first&&first.health?.health_state===(expected.health||'healthy'),first&&first.health);
    check('stats-requires-login',r.statsWithout.status===401,r.statsWithout.status);
    // System Stats answers 500 where the host has no thermal zone (CI runners);
    // the database state is added either way.
    check('stats-database',[200,500].includes(r.stats.status)&&database?.status===expected.status&&database?.health_state===expected.health,{status:r.stats.status,database});
    check('native-addons',r.addons.length===(fault==='conflict'?2:1),r.addons.length);
    if(expected.late) {
      // The flows did not wait for the check: the valve command was taken while it read.
      check('flows-not-held',r.open.status===202,r.open.status);
      const laterDatabase=r.later?.stats?.json?.database;
      const laterHeartbeat=r.later?.heartbeat?JSON.parse(r.later.heartbeat):null;
      evidence.later={database:laterDatabase,heartbeatHealth:laterHeartbeat?.health?.health_state};
      check('late-verdict-in-stats',laterDatabase?.status===expected.late.status&&laterDatabase?.health_state===expected.late.health,laterDatabase);
      check('late-verdict-in-next-heartbeat',laterHeartbeat?.health?.health_state===expected.late.health,laterHeartbeat?.health);
    }
    if(fault==='conflict')check('refused-open',r.open.status===503&&r.open.json?.error==='OSI_SQLITE_REFUSED'&&r.openRadio===0,{status:r.open.status,error:r.open.json?.error??null,radio:r.openRadio});
  } else check('observation',false,'runtime wrote no startup.json');
  if(expected.log)check('loud-log',expected.log.test(text),'no start-up error line');
  else check('quiet-log',!/\[osi-db-startup\]/.test(text),'unexpected start-up error line');
  // Report only: the file is where it was, under its name.
  check('file-kept',fs.existsSync(dbfile)&&fs.readdirSync(path.dirname(dbfile)).every(name=>/^farming\.db(?:-wal|-shm)?$/.test(name)),fs.readdirSync(path.dirname(dbfile)));
  const result={id:expected.id+(layout==='dual'?'':'-'+layout+'-layout'),failures,evidence};
  fs.writeFileSync(path.join(run,'summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(failures.length?'STARTUP FAIL':'STARTUP PASS',fault,layout,JSON.stringify(failures.map(f=>f.code)),JSON.stringify(evidence.database||null));
  return result;
}

if(require.main===module) {
  try {
    const args=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--layout')options.layout=args[++i];
      else if(args[i]==='--source')options.source=path.resolve(args[++i]);
      else if(args[i]==='--startup')options.fault=args[++i];
      else throw new Error('usage: test-release-sqlite-overlap.js [--layout dual|single|npm|stock | --startup none|damaged|conflict] [--source root]');
    }
    const result=options.fault?startupCase({...options,layout:options.layout||'dual'}):run(options);
    process.exitCode=result.failures.length?1:0;
  } catch(error) {console.error(error.stack);process.exitCode=2;}
}
module.exports={run,startupCase,LAYOUTS};
