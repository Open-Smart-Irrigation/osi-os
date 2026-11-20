'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ROOT,FIXTURE}=require('./test-valve-ingress-x2-parity');
const {validateManifest,replacement}=require('./lib/valve-ingress-x2-renderer');
const {canonicalHandoff,canonicalPatch,PATCH,verifyHandoff}=require('./lib/valve-ingress-x2-handoff');
test('checked-in patch equals independent renderer bytes, including staged catch/DDL receipt',()=>{
 assert.equal(canonicalPatch(canonicalHandoff()),fs.readFileSync(path.join(ROOT,PATCH),'utf8'));
 assert.ok(['legacy','rendered'].includes(verifyHandoff().state));
});
test('manifest forbids undeclared mutations, and exactly five libs append one named loader',()=>{
 const manifest=require('./fixtures/valve-ingress-x2/adapters.json'),baseline=require('./fixtures/valve-ingress-x2/baseline.json');let changed=0;
 for(const node of baseline.nodes){const libs=replacement(node.id).libs;if(JSON.stringify(libs)!==JSON.stringify(node.libs)){changed++;assert.deepEqual(libs,[...node.libs,{var:'osiLib',module:'osi-lib'}]);}}
 assert.equal(changed,5);validateManifest();
 manifest.nodes[0].replacement.outputs=99;
 try{assert.throws(validateManifest,/deep-equal|Expected values/);}finally{delete manifest.nodes[0].replacement.outputs;}
 validateManifest();
});
test('capture refuses the frozen oracle option and overwriting additive evidence',()=>{
 const before=['baseline.json','hashes.json','additive-hashes.json'].map(file=>fs.readFileSync(path.join(FIXTURE,file),'utf8'));
 for(const [script,args,reason]of [
  ['scripts/test-valve-ingress-x2-parity.js',['--record-baseline'],/unknown X2 parity option/],
  ['scripts/test-valve-ingress-x2-additive.js',['--capture-additive='+path.join(FIXTURE,'additive-hashes.json')],/write-once/],
  ['scripts/test-valve-ingress-x2-additive.js',['--capture-additive='+path.join(FIXTURE,'hashes.json')],/distinct additive fixture path/],
 ]){const result=spawnSync(process.execPath,[script,...args],{cwd:ROOT,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,reason);}
 assert.deepEqual(['baseline.json','hashes.json','additive-hashes.json'].map(file=>fs.readFileSync(path.join(FIXTURE,file),'utf8')),before);
});
