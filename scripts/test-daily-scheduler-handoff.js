#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {adaptFlows}=require('./prepare-daily-scheduler-adapters');
const {ROOT,PROFILES,execute}=require('./lib/daily-scheduler-harness');
const {cases}=require('./lib/daily-scheduler-cases');
const {verifyFrozen,createExclusive}=require('./lib/daily-scheduler-oracles');
const legacy=require('./fixtures/daily-scheduler/legacy-nodes.json');
const adapters=require('./fixtures/daily-scheduler/adapters.json');
async function main() {
 verifyFrozen();
 const {stagedBaselines}=require('./lib/daily-scheduler-baselines');
 const baselineFile=path.join(__dirname,'fixtures/daily-scheduler/evidence/staged-baselines.json');
 assert.deepStrictEqual(stagedBaselines(),JSON.parse(fs.readFileSync(baselineFile)),'fresh staged silent-catch and DDL counts equal handoff');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'x1-handoff-'));
 try {
  for(const p of PROFILES) {const rel='conf/'+p+'/files/usr/share/flows.json';fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.copyFileSync(path.join(ROOT,rel),path.join(dir,rel));}
  const patch=path.join(ROOT,'scripts/fixtures/daily-scheduler/evidence/flows-handoff.patch');
  execFileSync('git',['apply','--check',patch],{cwd:dir});execFileSync('git',['apply',patch],{cwd:dir});
  for(const p of PROFILES) {const rel='conf/'+p+'/files/usr/share/flows.json';const rendered=JSON.stringify(adaptFlows(JSON.parse(fs.readFileSync(path.join(ROOT,rel)))),null,2)+'\n';assert.equal(fs.readFileSync(path.join(dir,rel),'utf8'),rendered,'checked-in patch must equal renderer');
   assert.throws(()=>assert.equal(fs.readFileSync(path.join(dir,rel),'utf8'),rendered+'\n'),'stale patch negative control');
  }
  const oracle=path.join(dir,'write-once.json');createExclusive(oracle,{value:1});assert.throws(()=>createExclusive(oracle,{value:2}),/EEXIST/);assert.deepStrictEqual(JSON.parse(fs.readFileSync(oracle)),{value:1});
  const earlyNames=['auth-missing-request','auth-invalid-undefined','auth-invalid-Bearer nope','validate-user-[]','validate-zone','validate-no-request','validate-body-{}','upsert-missing-zone','upsert-missing-context','query-invalid-zone','swt-missing-zone'];
  for(const p of PROFILES) for(const name of earlyNames) {
   const c=cases().find(c=>c.name===name);assert.ok(c,name);let loads=0;
   const before=await execute(legacy.find(n=>n.id===c.id).func,c,p);
   const after=await execute(adapters.find(n=>n.id===c.id).func,c,p,null,{osiLib:{require(){loads++;return {ok:false,error:'missing'};}}});
   assert.deepStrictEqual(after,before,p+'/'+name+' early result before load');assert.equal(loads,0,name+' must not load');
  }
  for(const p of PROFILES) for(const entry of ['decodeToken','verifyZoneOwnership','buildUpsert']) for(const quarantined of [false,true]) {
   const a=adapters.find(n=>n.entry===entry);const c=cases().find(c=>c.id===a.id && ['auth-valid','validate-save','upsert-version-4-enabled-1'].includes(c.name));
   const originalDeps=require('./lib/daily-scheduler-harness').dependencies(c,p);
   const loader={require(name){if(name==='daily-scheduler')return {ok:false,error:quarantined?'quarantined':'missing',quarantined};return originalDeps.osiLib.require(name);}};
   const after=await execute(a.func,c,p,null,{osiLib:loader});assert.equal(after.result[1].statusCode,503);assert.ok(after.trace.some(t=>t[0]==='warn'&&t[1].includes('daily-scheduler unavailable')));
  }
  const {checkProfile}=require('./verify-request-context-isolation');
  const {findAuthGatedNodes,checkNode}=require('./verify-auth-flag-off-hermetic');
  for(const p of PROFILES) {
   const root=path.join(ROOT,'conf',p,'files/usr/share/node-red');
   const original=JSON.parse(fs.readFileSync(path.join(ROOT,'conf',p,'files/usr/share/flows.json')));
   const staged=adaptFlows(original);
   assert.equal(findAuthGatedNodes(staged,root).length,findAuthGatedNodes(original,root).length,'handler count preserved');
   const token=staged.find(n=>n.id==='70fcbea336401bd1');
   assert.equal((await checkNode(token,root)).outcome,'pass','real delegated scheduler hermetic, both secrets');
   for(const target of ['wrapper','module']) {
    const flows=structuredClone(staged);const n=flows.find(n=>n.entry==='verifyZoneOwnership'||n.id==='22cc64fa2a899cea');
    if(target==='wrapper') n.func="flow.set('sched_probe', msg.osi);\n"+n.func;
    else { const {inlineForMutation}=require('./flow-function-source');n.func=inlineForMutation(n,root).func; n.func="flow.set('sched_probe', msg.osi);\n"+n.func; }
    const copy=path.join(dir,'guard-'+target+'.json');fs.writeFileSync(copy,JSON.stringify(flows));
    assert.ok(checkProfile(copy,root).failures.some(f=>f.includes('sched_probe')),target+' scratch mutation caught');
   }
   const scheduler=require(path.join(root,'osi-daily-scheduler'));const saved=scheduler.decodeToken;
   try {
    scheduler.decodeToken=function(msg,deps){ return deps.osiLib.require('scope'); };
    assert.equal((await checkNode(token,root)).outcome,'scope-helper-touched','real module regression is caught behind preflight');
   } finally {scheduler.decodeToken=saved;}
   const mutant={...token,func:"osiLib.require('scope');\n"+token.func};
   assert.equal((await checkNode(mutant,root)).outcome,'scope-helper-touched','hermetic sentinel rejects wrapper regression');
  }
  console.log('handoff parity: OK (patch == renderer, exclusive oracle, early replies and 503 missing/quarantined diagnostics)');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
