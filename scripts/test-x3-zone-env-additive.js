#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execute,LEGACY,PROFILES,FIXTURES,share}=require('./lib/x3-zone-env-harness');
const {cases,assertCase}=require('./lib/x3-zone-env-extra-cases');
const {adaptNode}=require('./x3-zone-env-adapters');
const {compare,assertFrozenInput,assertOriginalBlobs}=require('./lib/x3-parity-contract');
async function main() {
 assertOriginalBlobs();
 const capture=process.argv.includes('--capture-additive');
 const destination=process.argv.find(a=>a.startsWith('--out='))?.slice(6)||path.join(FIXTURES,'additional.expected.json');
 if(capture) {
  for(const profile of PROFILES) assertFrozenInput(JSON.parse(fs.readFileSync(path.join(share(profile),'flows.json'))));
  assert.ok(!fs.existsSync(destination),'additive capture refuses to replace an existing fixture');
 }
 const frozen=capture?null:JSON.parse(fs.readFileSync(destination));
 const output={schema:1,timezone:process.env.TZ,cases:{}};
 let count=0;
 for(const profile of PROFILES) for(const c of cases) {
  const legacy=LEGACY.find(n=>n.id===c.node);
  const before=await execute(profile,legacy,c);
  assertCase(c,before,false);
  if(frozen&&process.env.TZ===frozen.timezone) assert.deepEqual(before,frozen.cases[c.name],c.name+' frozen legacy result');
  if(capture) { if(profile===PROFILES[0]) output.cases[c.name]=before; else assert.deepEqual(before,output.cases[c.name],c.name+' profiles'); }
  else {
   const after=await execute(profile,adaptNode(legacy),c);
   assertCase(c,after,true);
   if(!c.loaderChange) compare(before,after,profile+' '+c.name);
  }
  count++;
 }
 if(capture) fs.writeFileSync(destination,JSON.stringify(output)+'\n',{flag:'wx'});
 assertOriginalBlobs();
 console.log(`X3 additive ${capture?'capture':'parity'}: ${count} branch-asserted cases, both profiles; Node ${process.versions.node}; TZ=${process.env.TZ}`);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={cases,assertCase};
