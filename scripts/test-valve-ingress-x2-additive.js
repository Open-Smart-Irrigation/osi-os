#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {ROOT,FIXTURE,baseline,digest}=require('./test-valve-ingress-x2-parity');
const {cases,assertBranch}=require('./lib/valve-ingress-x2-additive-cases');
const {execute}=require('./lib/valve-ingress-x2-harness');
const {adaptFlows,entryBridge,comparable}=require('./lib/valve-ingress-x2-adapters');
const file=path.join(FIXTURE,'additive-hashes.json');
const {pinnedSource,assertOracleContent,ADDITIVE}=require('./lib/valve-ingress-x2-frozen');
async function main(){
 const capture=process.argv[2];assert.ok(!capture||capture==='--capture-additive='+file,'capture requires the distinct additive fixture path');
 if(capture)assert.ok(!fs.existsSync(file),'additive capture is write-once');
 const writeEvidence=require('./lib/valve-ingress-x2-evidence').createEvidenceWriter('X2_ADDITIVE_EVIDENCE');
 pinnedSource({allowMissingAdditive:!!capture});
 const tcases=cases(),hashes={},evidence=[];
 for(const profile of ['bcm2712','bcm2709']){
  const share=path.join(ROOT,`conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`),moduleRoot=path.join(share,'node-red/osi-valve-control');
  const adapted=adaptFlows(JSON.parse(fs.readFileSync(path.join(share,'flows.json'))));
  const ingress=require(path.join(share,'node-red/osi-command-ingress'));
  for(const tc of tcases){
   const before=await execute(baseline.nodes.find(n=>n.id===tc.id),tc,moduleRoot);
   assertBranch(tc,before);
   hashes[profile+'/'+tc.name]=digest(before);
   const after=await execute(adapted.find(n=>n.id===tc.id),tc,moduleRoot,(node,deps)=>{
    const bridge=entryBridge(ingress,deps.osiLib),names=Object.keys(deps);
    return new Function(...names,node.func)(...names.map(k=>k==='osiLib'?bridge:deps[k]));
   });
   assertBranch(tc,after);assert.deepEqual(comparable(after),comparable(before),profile+'/'+tc.name);
   evidence.push({profile,case:tc.name,before,after});
  }
 }
 const record={source:baseline.source,casesSha256:digest(tcases),hashes};
 if(capture){
  const bytes=JSON.stringify(record,null,2)+'\n';assertOracleContent(ADDITIVE,bytes);
  fs.writeFileSync(file,bytes,{flag:'wx'});
 }
 else assert.deepEqual(record,JSON.parse(fs.readFileSync(file)),'additive legacy capture changed');
 writeEvidence(evidence);
 console.log(`X2 additive: ${tcases.length} branch-asserted cases x 2 profiles identical`);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={pinnedSource};
