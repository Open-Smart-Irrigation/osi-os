#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {execute,LEGACY,PROFILES,share}=require('./lib/x3-zone-env-harness');
const {adaptNode,applyTo,body}=require('./x3-zone-env-adapters');
const {compare,assertFrozenInput,assertOriginalBlobs}=require('./lib/x3-parity-contract');
const {assertCase,cases}=require('./lib/x3-zone-env-extra-cases');
async function main() {
 assertOriginalBlobs();
 const candidate=LEGACY.map(n=>({...n}));candidate[0].func+='\n';
 assert.throws(()=>assertFrozenInput(candidate),/capture requires/);
 const capture=spawnSync(process.execPath,['scripts/test-x3-zone-env-parity.js','--capture'],{encoding:'utf8'});
 assert.equal(capture.status,1);assert.match(capture.stderr,/immutable|capture requires/);assertOriginalBlobs();
 const {countSilentCatchesInFlow}=require('./verify-no-new-silent-catch');
 for(const profile of PROFILES) {
  const root=path.join(share(profile),'node-red/osi-zone-env');
  assert.equal(countSilentCatchesInFlow([{type:'function',func:fs.readFileSync(path.join(root,'http-facade.js'),'utf8')}]).silentCatchCount,0,'no silent module catches');
  const flows=JSON.parse(fs.readFileSync(path.join(share(profile),'flows.json')));
  const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/silent-catch-baseline.json'))).profiles[profile].silentCatchCount;
  const swapped=LEGACY.every(old=>flows.find(n=>n.id===old.id).func===body(old.id));
  const removed=countSilentCatchesInFlow(LEGACY).silentCatchCount;
  assert.equal(countSilentCatchesInFlow(applyTo(flows)).silentCatchCount,baseline-(swapped?0:removed),'candidate silent-catch recount');
  for(const id of ['zone-env-fn','get-actuations-query']) {
   const source=LEGACY.find(n=>n.id===id),c={node:id};
   const before=await execute(profile,source,c),after=await execute(profile,adaptNode(source),c);
   compare(before,after,id+' all legacy effects');
   const ddl=result=>result.trace.filter(t=>t.kind==='run'&&/^(?:ALTER TABLE|CREATE TABLE|CREATE INDEX)/.test(t.sql)).map(t=>t.sql);
   assert.equal(ddl(before).length,id==='zone-env-fn'?16:1,'reviewed compatibility DDL scope');
   assert.deepEqual(ddl(after),ddl(before),'compatibility DDL order and SQL are unchanged');
   if(id==='zone-env-fn') assert.equal(after.diagnostics.filter(d=>String(d.value).startsWith('zone-env compatibility DDL already present:')).length,10,'expected duplicate-column diagnostics');
  }
  for(const [options,prefix] of [[{faultSql:1},'zone-env compatibility DDL failed:'],[{closeError:true},'zone-env error-path close failed:']]) {
   const source=LEGACY.find(n=>n.id==='zone-env-fn'),c={node:source.id,...options};
   const before=await execute(profile,source,c),after=await execute(profile,adaptNode(source),c);
   compare(before,after,prefix);assert.ok(after.diagnostics.some(d=>String(d.value).startsWith(prefix)),prefix);
  }
  const transport=cases.find(c=>c.name==='extra/http-transport');
  const source=LEGACY.find(n=>n.id===transport.node);
  const mutated={...source,func:source.func.replace("? httpsLib : httpLib", "? httpLib : httpsLib")};
  assert.notEqual(mutated.func,source.func);
  const wrong=await execute(profile,mutated,transport);
  assert.throws(()=>assertCase(transport,wrong),/transport chosen by URL/);
 }
 console.log('X3 revision guards: PASS (immutable capture, DDL scope/order, diagnostics and transport negative control)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
