'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const journalPath = '/data/db/osi-account-link-config.json';
const requestDir = '/var/run/osi-node-red-restart-requests';
const testRef = process.env.OSI_ACCOUNT_LINK_TEST_REF;

function source(file) {
  return testRef ? cp.execFileSync('git', ['show', testRef + ':' + file], {cwd:root, encoding:'utf8', maxBuffer:20*1024*1024}) : fs.readFileSync(path.join(root,file),'utf8');
}
function loadHelper(profile) {
  const relative = `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red/osi-installation-helper/index.js`;
  const file = path.join(root, relative);
  const mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(source(relative), file);
  return mod.exports;
}
function fixture(profile, kind) {
  const helper = loadHelper(profile);
  const files = new Map(), config = new Map(), descriptors = new Map();
  let nextFd = 1, failAt = 'mkdir', writes = 0;
  const io = {
    fs: {
      existsSync: p => files.has(p),
      readFileSync: p => { if(!files.has(p)) throw Object.assign(new Error('missing'),{code:'ENOENT'}); return files.get(p); },
      openSync(p, flags) {const fd=nextFd++; descriptors.set(fd,p); if(flags==='wx')files.set(p,''); return fd;},
      writeFileSync(p,data,options) {
        const target=typeof p==='number'?descriptors.get(p):p;
        if(failAt==='write' && target.startsWith(requestDir)) throw new Error('injected request write failure');
        if(typeof p!=='number') assert.equal(options.mode,0o600);
        files.set(target,String(data));
      },
      fsyncSync() {}, closeSync(fd) {descriptors.delete(fd);},
      mkdirSync() {if(failAt==='mkdir') throw new Error('injected request directory failure');},
      renameSync(a,b) {if(failAt==='rename' && b.startsWith(requestDir)) throw new Error('injected request rename failure');files.set(b,files.get(a));files.delete(a);},
      unlinkSync(p) {if(!files.delete(p))throw Object.assign(new Error('missing'),{code:'ENOENT'});},
    },
    cp: {execFileSync(command,args) {
      assert.equal(command,'uci'); const key=args.at(-1);
      if(args.includes('get')) {if(!config.has(key))throw Object.assign(new Error('missing'),{status:1});return config.get(key)+'\n';}
      if(args[0]==='set') {const i=key.indexOf('=');config.set(key.slice(0,i),key.slice(i+1));}
      if(args.includes('delete'))config.delete(key);
      return '';
    }},
  };
  const context={server_url:'https://cloud.example.org',cloud_user_id:'77',gateway_device_eui:'0016C001F1000001',installation_uuid:'123e4567-e89b-42d3-a456-426614174000'};
  const marker={kind,username:'local',token:'fixture-token',context,reply:{serverUsername:'target',claimedDevices:[],skippedDevices:[]}};
  let committed=false;
  const db={
    transaction:async fn=>fn({
      get:async sql=> sql.includes('FROM users') ? {id:1,auth_mode:committed?(kind==='link'?'server':'local'):'server',server_sync_token:committed?'fixture-token':'old-token',cloud_user_id:'77',server_url:context.server_url,server_username:'target'} : {...context,linked:committed?(kind==='link'?1:0):1},
      run:async()=>{writes++;},
    }),
    all() {throw new Error('a recovery retry must not prepare another cloud authentication');},
    close:async callback=>{if(callback)callback();},
  };
  const osiDb={Database:class{constructor(){return db;}}};
  const flows=JSON.parse(source(`conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`));
  const state=new Map();
  const deps=msg=>({msg,node:{warn(){},status(){}},flow:{get:k=>state.get(k),set:(k,v)=>state.set(k,v)},env:{get:()=>''},global:{get:k=>io[k]},osiDb,osiLib:{require:name=>name==='installation'?{ok:true,value:helper}:{ok:false,error:'optional module absent'}}});
  async function commit() {
    const desired=Object.fromEntries(['server_host','mqtt_password','mqtt_broker_url','link_gateway_device_eui'].map(k=>[k,kind==='link'?'new-'+k:'']));
    await helper.accountConfigTransaction(db,{...io,desired,marker},async()=>{committed=true;writes++;});
  }
  async function publish() {
    const n=flows.find(n=>n.id===(kind==='link'?'al-link-restart-node-red':'al-unlink-restart-node-red'));
    const d=deps({_msgid:'fixture-publication'});
    const fn=new vm.Script('(async function(msg,node,flow,env,global,osiDb,osiLib){'+n.func+'\n})').runInNewContext({Buffer,Date,Math});
    return fn(d.msg,d.node,d.flow,d.env,d.global,d.osiDb,d.osiLib);
  }
  return {helper,io,files,db,osiDb,marker,flows,deps,commit,publish,setFailure:value=>{failAt=value;},getWrites:()=>writes};
}

for(const profile of ['bcm2712','bcm2709']) for(const kind of ['link','disconnect']) {
  for(const failure of ['mkdir','write','rename']) test(`${profile} ${kind}: committed operation retains restart obligation on ${failure} failure and retries without authentication`,async()=>{
    const f=fixture(profile,kind); f.setFailure(failure);
    await f.commit();
    const [ok,error]=await f.publish();
    assert.equal(ok,null); assert.equal(error.statusCode,503);
    assert.equal(f.files.has(journalPath),true,'committed restart obligation must survive publication failure');
    assert.equal(f.helper.gatewayWorkBlocked({fs:f.io.fs,warn(){}}),true);
    assert.equal([...f.files.keys()].filter(p=>p.startsWith(requestDir)&&p.endsWith('.json')).length,0);
    f.setFailure(null); const before=f.getWrites();
    const msg=kind==='link'?{authUserId:1,authUsername:'local',_alState:{al_local_username:'local',al_local_user_id:1,al_server_url:f.marker.context.server_url,al_action:'link',al_server_username:'target',al_gateway_device_eui:f.marker.context.gateway_device_eui,al_gateway_device_eui_confidence:'authoritative'}}:{_unlinkAuth:{userId:1,username:'local'}};
    const result=await f.helper.accountLinkStage(kind==='link'?'build':'disconnect',f.deps(msg));
    if(kind==='link') {assert.equal(result[0],null);assert.equal(result[1],null);assert.equal(result[2],msg,'recovered link uses a dedicated local-success output');assert.deepEqual(f.flows.find(n=>n.id==='al-link-build-req').wires[2],['al-link-success']);}
    else assert.equal(result[0],msg);
    assert.equal(f.getWrites(),before,'a recovery retry must not repeat the account mutation');
    assert.equal(f.files.has(journalPath),false);
    assert.equal(msg._alRestartPublished,kind);
    const requests=[...f.files].filter(([p])=>p.startsWith(requestDir)&&p.endsWith('.json'));
    assert.equal(requests.length,1);
    const request=JSON.parse(requests[0][1]);
    assert.deepEqual(Object.keys(request).sort(),['delaySeconds','reason','requestedAtEpoch']);
    assert.equal(request.reason,kind==='link'?'account_link':'account_unlink');assert.equal(request.delaySeconds,kind==='link'?10:2);
    const warnings=[];
    await f.helper.recoverAccountConfigOnStart({osiDb:f.osiDb,...f.io,warn:message=>warnings.push(message)});
    assert.equal(warnings.length,0);
    assert.equal([...f.files.keys()].filter(p=>p.startsWith(requestDir)&&p.endsWith('.json')).length,1);
  });
  test(`${profile} ${kind}: process interruption after commit recovers and publishes on startup`,async()=>{
    const f=fixture(profile,kind);await f.commit();
    assert.equal(f.files.has(journalPath),true,'commit must leave a receipt until publication');
    const restarted=loadHelper(profile);f.setFailure(null);
    await restarted.recoverAccountConfigOnStart({osiDb:f.osiDb,...f.io,warn(){}});
    assert.equal(f.files.has(journalPath),false);
    assert.equal([...f.files.keys()].filter(p=>p.startsWith(requestDir)&&p.endsWith('.json')).length,1);
    assert.equal(restarted.gatewayWorkBlocked({fs:f.io.fs,warn(){}}),false);
  });
}


for(const profile of ['bcm2712','bcm2709']) for(const kind of ['link','disconnect']) {
  test(`${profile} ${kind}: startup publication failure retains a normal committed receipt`,async()=>{
    const f=fixture(profile,kind);await f.commit();
    const restarted=loadHelper(profile), warnings=[];
    await restarted.recoverAccountConfigOnStart({osiDb:f.osiDb,...f.io,warn:t=>warnings.push(t)});
    assert.equal(warnings.length,1);assert.equal(f.files.has(journalPath),true);
    assert.equal(restarted.gatewayWorkBlocked({fs:f.io.fs,warn(){}}),true);
    f.setFailure(null);
    await restarted.recoverAccountConfigOnStart({osiDb:f.osiDb,...f.io,warn:t=>warnings.push(t)});
    assert.equal(warnings.length,1);assert.equal(f.files.has(journalPath),false);
  });
  test(`${profile} ${kind}: another account operation recovers publication before any new mutation`,async()=>{
    const f=fixture(profile,kind);await f.commit();f.setFailure(null);
    const before=f.getWrites();
    const msg=kind==='link'?{_unlinkAuth:{userId:1,username:'local'}}:{authUserId:1,authUsername:'local',_alState:{al_local_username:'local',al_local_user_id:1,al_server_url:f.marker.context.server_url,al_server_username:'target',al_gateway_device_eui:f.marker.context.gateway_device_eui}};
    const result=await f.helper.accountLinkStage(kind==='link'?'disconnect':'build',f.deps(msg));
    assert.equal(result[0],null);assert.equal(result[1].statusCode,503);
    assert.equal(result[1].payload.reason,'account_restart_queued');
    assert.equal(f.getWrites(),before);assert.equal(f.files.has(journalPath),false);
    assert.equal([...f.files.keys()].filter(p=>p.startsWith(requestDir)&&p.endsWith('.json')).length,1);
  });
  test(`${profile} ${kind}: interruption before the post-commit stamp still recovers the committed transaction`,async()=>{
    const f=fixture(profile,kind);const rename=f.io.fs.renameSync;let writes=0;
    f.io.fs.renameSync=(a,b)=>{if(b===journalPath && ++writes===2)throw new Error('interrupted stamp');rename(a,b);};
    await assert.rejects(f.commit(),error=>error.applied===true && error.statusCode===503);
    assert.equal(JSON.parse(f.files.get(journalPath)).restart_pending,undefined);
    f.io.fs.renameSync=rename;f.setFailure(null);
    const restarted=loadHelper(profile);
    await restarted.recoverAccountConfigOnStart({osiDb:f.osiDb,...f.io,warn(){}});
    assert.equal(f.files.has(journalPath),false);
    assert.equal([...f.files.keys()].filter(p=>p.startsWith(requestDir)&&p.endsWith('.json')).length,1);
  });
}


for(const profile of ['bcm2712','bcm2709']) test(`${profile}: recovery matches the original login spelling, not the canonical response name`,async()=>{
  const f=fixture(profile,'link');f.marker.request_username='Target@EXAMPLE.org';
  await f.commit();f.setFailure(null);
  const msg={authUserId:1,authUsername:'local',_alState:{al_local_username:'local',al_local_user_id:1,al_server_url:f.marker.context.server_url,al_server_username:'Target@EXAMPLE.org',al_gateway_device_eui:f.marker.context.gateway_device_eui}};
  const result=await f.helper.accountLinkStage('build',f.deps(msg));
  assert.equal(result[0],null);assert.equal(result[1],null);assert.equal(result[2],msg);
  assert.equal(msg._alRecoveredReply.serverUsername,'target');
});

for(const profile of ['bcm2712','bcm2709']) test(`${profile}: every cloud MQTT publication is blocked by an unresolved restart receipt`,async()=>{
  const f=fixture(profile,'link');await f.commit();
  const cloudOutputs=f.flows.filter(n=>n.type==='mqtt out'&&n.broker==='ec43625ea99685a6');
  assert.equal(cloudOutputs.length,6);
  // Pin the reviewed MQTT endpoints/configuration without requiring a historical
  // commit in a shallow CI checkout. The new function guards are excluded.
  const immutableTypes = new Set(['mqtt in','mqtt out','mqtt-broker']);
  const configuration = f.flows.filter(n=>immutableTypes.has(n.type));
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),'599dc6a8837663abdef706512a6302959924956a6df0d5ba2a391f637060322c','MQTT endpoint and broker configuration stays unchanged');
  for(const target of cloudOutputs) {
    const guard=f.flows.find(n=>n.id==='account-cloud-guard-'+target.id);
    assert.ok(guard,'cloud MQTT output must have an account recovery guard');
    assert.deepEqual(guard.wires,[[target.id]]);
    assert.deepEqual(guard.libs,[{var:'osiLib',module:'osi-lib'}]);
    for(const caller of f.flows.filter(n=>(n.wires||[]).some(w=>w.includes(target.id)))) assert.equal(caller.id,guard.id,'no cloud publication may bypass its guard');
    const fn=new vm.Script('(function(msg,node,global,osiLib){'+guard.func+'\n})').runInNewContext();
    const msg={topic:'devices/0016C001F1000001/telemetry',payload:{fixture:true}};
    const node={warn(){}};const globals={get:key=>f.io[key]};const lib={require:()=>({ok:true,value:f.helper})};
    assert.equal(fn(msg,node,globals,lib),null,'pending receipt blocks MQTT with boot-time credentials');
    f.files.delete(journalPath);
    assert.equal(fn(msg,node,globals,lib),msg,'settled account passes MQTT unchanged');
    f.files.set('/var/run/osi-identity-restart.json','{}');
    assert.equal(fn(msg,node,globals,lib),null,'identity sentinel also blocks cloud publication');
    f.files.delete('/var/run/osi-identity-restart.json');
    f.files.set(journalPath,'{}');
    assert.equal(fn(msg,node,{get:()=>null},lib),null,'missing fs fails closed');
    assert.equal(fn(msg,node,globals,{require:()=>({ok:false,error:'fixture unavailable'})}),null,'missing helper fails closed');
  }
});
