#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const test=require('node:test');
const {cases,CANCEL}=require('./lib/valve-ingress-x2-cases');
const {execute}=require('./lib/valve-ingress-x2-harness');
const {adaptFlows,comparable}=require('./lib/valve-ingress-x2-adapters');
const baseline=require('./fixtures/valve-ingress-x2/baseline.json');
const ROOT=path.resolve(__dirname,'..');
const FAULTS={'command-ingress':'osi-command-ingress','osi-valve-control':'osi-valve-control',scope:'osi-scope-helper'};
function realLoader(base,modules,fault,quarantined){
 const source=fs.readFileSync(path.join(modules,'osi-lib/index.js'),'utf8'),module={exports:{}};
 new Function('require','module','exports','process',source)(createRequire(path.join(modules,'osi-lib/index.js')),module,module.exports,{env:{OSI_LIB_BASE:base,OSI_LIB_COOLDOWN_MS:quarantined?'300000':'0'}});
 const probe=module.exports.require(fault);assert.equal(probe.ok,false,'actual missing dependency must fail: '+fault);
 assert.equal(!!module.exports.require(fault).quarantined,quarantined,'real quarantine state: '+fault);
 return module.exports;
}
for(const profile of ['bcm2712','bcm2709'])for(const fault of Object.keys(FAULTS))for(const quarantined of [false,true]){
 const share=path.join(ROOT,`conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`),modules=path.join(share,'node-red'),vc=path.join(modules,'osi-valve-control');
 const flows=adaptFlows(JSON.parse(fs.readFileSync(path.join(share,'flows.json'))));
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'x2-loader-failure-'));
 for(const entry of fs.readdirSync(modules,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name===FAULTS[fault])continue;
  // Copy valve-control so relative imports cannot escape into the intact source tree.
  if(entry.name==='osi-valve-control')fs.cpSync(path.join(modules,entry.name),path.join(fixture,entry.name),{recursive:true});
  else fs.symlinkSync(path.join(modules,entry.name),path.join(fixture,entry.name),'dir');
 }
 test.after(()=>{for(const key of Object.keys(require.cache))if(key.startsWith(fixture+path.sep))delete require.cache[key];fs.rmSync(fixture,{recursive:true,force:true});});
 if(fault==='command-ingress')test(`${profile} ${quarantined?'quarantined':'missing'} ingress leaves existing valve exports loadable`,async()=>{
  const loader=realLoader(fixture,modules,fault,quarantined),loaded=loader.require('osi-valve-control');
  assert.equal(loaded.ok,true,loaded.error);
  for(const entry of ['executeValveAttempt','reserveValveCommand','cancelActuation','cancelHttpResponse','runOnceTick','handleUplink'])assert.equal(typeof loaded.value[entry],'function',entry);
  const x2Names=new Set(require('./lib/valve-ingress-x2-renderer').ENTRIES.map(entry=>entry[1]));
  for(const [name,value] of Object.entries(require(vc)))if(!x2Names.has(name))assert.equal(typeof loaded.value[name],typeof value,'existing export: '+name);
  assert.equal(loaded.value.cancelHttpResponse({ok:false,error:'no_active_actuation'},'fixture').statusCode,404);
  assert.ok(!Object.keys(require.cache).some(key=>key.startsWith(fixture+path.sep)&&/ingress/.test(path.basename(key))),'valve index did not eagerly load compatibility modules');
  for(const [id,entry] of require('./lib/valve-ingress-x2-renderer').ENTRIES){
   const tc=cases().find(item=>item.id===id),original=baseline.nodes.find(item=>item.id===id);
   const expected=await execute(original,tc,vc),actual=await execute(original,tc,vc,(_node,deps)=>loaded.value[entry](deps.msg,deps));
   assert.deepEqual(comparable(actual),comparable(expected),'direct X2 compatibility call without ingress: '+entry);
  }
  assert.equal(loader.require('osi-valve-control').value,loaded.value,'existing valve package is cached successfully');
 });
 for(const tc of cases())test(`${profile} ${quarantined?'quarantined':'missing'} ${fault}: ${tc.name}`,async()=>{
  const loads={before:[],after:[]};
  async function run(node,phase){
   const loader=realLoader(fixture,modules,fault,quarantined);
   return execute(node,tc,vc,(current,deps)=>{
    const old=deps.osiLib;
    deps.osiLib={invokeCommandIngress:loader.invokeCommandIngress,require(name){
     loads[phase].push(name);
     if(name==='command-ingress')return loader.require(name);
     if(name===fault){old.require(name);return loader.require(name);}
     return old.require(name);
    }};
    return vm.runInNewContext('(function('+Object.keys(deps).join(',')+'){\n'+current.func+'\n})',{})(...Object.values(deps));
   });
  }
  const before=await run(baseline.nodes.find(n=>n.id===tc.id),'before'),after=await run(flows.find(n=>n.id===tc.id),'after');
  assert.deepEqual(comparable(after),comparable(before),'all outputs, errors, SQL, DB close and effect order survive dependency failure');
  for(const dependency of ['osi-valve-control','scope'])assert.equal(loads.after.filter(n=>n===dependency).length,loads.before.filter(n=>n===dependency).length,'dependency order/count: '+dependency);
  if(tc.id!==CANCEL)assert.ok(!loads.after.includes('osi-valve-control'),'pure ingress never consults valve control');
  if(tc.name.endsWith('/missing-bearer'))assert.equal(after.msg._osiAuthFailure.code,'MISSING_BEARER');
  if(tc.id===CANCEL&&tc.name==='cancel/valid'&&fault==='osi-valve-control'){
   assert.equal(after.value.statusCode,503);assert.equal(after.effects.at(-1)[0],'db.close');
  }
 });
}
