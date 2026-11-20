#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const test=require('node:test');
const {cases,CANCEL,AUTH}=require('./lib/valve-ingress-x2-cases');
const {execute}=require('./lib/valve-ingress-x2-harness');
const {adaptFlows,comparable}=require('./lib/valve-ingress-x2-adapters');
const baseline=require('./fixtures/valve-ingress-x2/baseline.json');
const ROOT=path.resolve(__dirname,'..');
function realLoader(base,modules,quarantined) {
  const source=fs.readFileSync(path.join(modules,'osi-lib/index.js'),'utf8');
  const module={exports:{}};
  new Function('require','module','exports','process',source)(createRequire(path.join(modules,'osi-lib/index.js')),module,module.exports,{env:{OSI_LIB_BASE:base,OSI_LIB_COOLDOWN_MS:quarantined?'300000':'0'}});
  const probe=module.exports.require('osi-valve-control');
  assert.equal(probe.ok,false,'actual missing valve package must fail');
  if(quarantined)assert.equal(module.exports.require('osi-valve-control').quarantined,true);
  return module.exports;
}
for(const profile of ['bcm2712','bcm2709'])for(const quarantined of [false,true]){
 const share=path.join(ROOT,`conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`),modules=path.join(share,'node-red'),vc=path.join(modules,'osi-valve-control');
 const flows=adaptFlows(JSON.parse(fs.readFileSync(path.join(share,'flows.json'))));
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'x2-loader-failure-'));
 fs.symlinkSync(path.join(modules,'osi-command-ingress'),path.join(fixture,'osi-command-ingress'),'dir');
 test.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
 const corpus=cases();
 for(const tc of corpus)test(`${profile} ${quarantined?'quarantined':'failed'} actual valve loader: ${tc.name}`,async()=>{
  const loads={before:[],after:[]};
  async function run(node,phase){
   const loader=realLoader(fixture,modules,quarantined);
   return execute(node,tc,vc,(current,deps)=>{
    const old=deps.osiLib;
    deps.osiLib={require(name){
     loads[phase].push(name);
     if(name==='command-ingress')return loader.require(name);
     if(name==='osi-valve-control'){old.require(name);return loader.require(name);}
     return old.require(name);
    }};
    return vm.runInNewContext('(function('+Object.keys(deps).join(',')+'){\n'+current.func+'\n})',{})(...Object.values(deps));
   });
  }
  const before=await run(baseline.nodes.find(n=>n.id===tc.id),'before');
  const after=await run(flows.find(n=>n.id===tc.id),'after');
  assert.deepEqual(comparable(after),comparable(before),'early outputs, SQL and DB close order must survive actual loader failure');
  assert.equal(loads.after.filter(n=>n==='osi-valve-control').length,loads.before.filter(n=>n==='osi-valve-control').length);
  if(tc.id!==CANCEL)assert.ok(!loads.after.includes('osi-valve-control'),'pure ingress must never consult valve control');
  if(tc.name.endsWith('/missing-bearer'))assert.equal(after.msg._osiAuthFailure.code,'MISSING_BEARER');
  if(tc.id===CANCEL&&tc.name==='cancel/valid'){
   assert.equal(after.value.statusCode,503);
   assert.equal(after.effects.at(-1)[0],'db.close');
  }
 });
}
