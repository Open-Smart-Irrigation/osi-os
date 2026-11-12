'use strict';
// NEW-15 start-up state. Started by scripts/test-release-sqlite-overlap.js
// (startupCase) in the gateway's dependency layout. OSI_STARTUP_FAULT:
//   none     a healthy file;
//   damaged  the parent damaged an index page before start;
//   conflict a stray loader maps the user-directory sqlite3 addon before
//            Node-RED starts, so two native addons are in the process.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const watchdog=setTimeout(()=>{console.error('startup runtime timeout');process.exit(2);},120000);
const addons=()=>[...new Set(fs.readFileSync('/proc/self/maps','utf8').split('\n')
  .filter(line=>line.includes('node_sqlite3.node')).map(line=>line.trim().split(/\s+/).at(-1)))].sort();
(async()=>{
  const fault=process.env.OSI_STARTUP_FAULT;
  if(!['none','damaged','conflict'].includes(fault))throw new Error('invalid OSI_STARTUP_FAULT');
  // runtime.js links the fixture's modules into the user directory when it
  // loads; the stray copy needs them (bindings) before Node-RED starts.
  const runtime=require('./runtime');
  if(fault==='conflict')require(path.join(process.env.OSI_SMOKE_RUN,'node_modules/sqlite3'));
  const h=await runtime.start();
  // The harness pauses inject timers before this tick's 5 s delay runs out;
  // send the heartbeat tick once, the first one this process sees.
  const before=h.state.received.length;
  h.inject('310dfe7cfe34a448');
  await h.settle();
  const tickOrder=h.state.received.slice(before).filter(id=>['2a4f142e3e9b6d80','062a0f9bf66d9789'].includes(id));
  const edgeHealth=h.RED.nodes.getNode('2a4f142e3e9b6d80').context().global.get('edge_health');
  const payload=Buffer.from(JSON.stringify({userId:1,username:'overlap',exp:Date.now()+600000})).toString('base64url');
  const token=payload+'.'+crypto.createHmac('sha256','synthetic-smoke-secret').update(payload).digest('base64url');
  const statsWithout=await h.http('GET','/api/system/stats',undefined,undefined,5000);
  const stats=await h.http('GET','/api/system/stats',undefined,token,5000);
  const open=await h.http('POST','/api/valve/A840410000000001',{action:'OPEN_FOR_DURATION',duration_seconds:60},token,15000);
  await h.settle();
  const report={fault,addons:addons(),heartbeats:h.state.heartbeats,statsWithout:{status:statsWithout.status},
    stats:{status:stats.status,json:stats.json},open:{status:open.status,json:open.json},exec:h.state.exec,
    logs:h.state.logs,tickOrder,edgeHealth,node:process.version};
  fs.writeFileSync(path.join(h.RUN,'startup.json'),JSON.stringify(report,null,2)+'\n');
  await h.stop();clearTimeout(watchdog);
  console.log('startup stopped',JSON.stringify({fault,addons:report.addons.length}));
  process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(2);});
