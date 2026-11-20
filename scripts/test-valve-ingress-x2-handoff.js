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

test('binary patch bytes ignore host deflate choices and reject damaged payloads',()=>{
 const {deflateSync,inflateSync}=require('node:zlib');
 const {canonicalBinaryPatch,encode,storedZlib}=require('./lib/valve-ingress-x2-patch-codec');
 const raw=Buffer.from('deterministic renderer payload '.repeat(10000));
 const patch=level=>'GIT binary patch\nliteral '+raw.length+'\n'+encode(deflateSync(raw,{level})).join('\n')+'\n';
 assert.deepEqual(inflateSync(storedZlib(raw)),raw);
 assert.equal(canonicalBinaryPatch(patch(1)),canonicalBinaryPatch(patch(9)));
 assert.equal(canonicalBinaryPatch(canonicalBinaryPatch(patch(9))),canonicalBinaryPatch(patch(9)));
 assert.throws(()=>canonicalBinaryPatch('GIT binary patch\nliteral 999\nA00000\n'));
});

test('all environment evidence writers refuse existing oracle paths, aliases and repeated writes',()=>{
 const os=require('node:os'),{stagedTree}=require('./lib/valve-ingress-x2-stage');
 const tree=stagedTree({applyHandoff:false}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'x2-evidence-guard-'));
 const files=['baseline.json','hashes.json','additive-hashes.json','oracle-sha256.json'];
 const expected=files.map(file=>fs.readFileSync(path.join(tree.dir,'scripts/fixtures/valve-ingress-x2',file)));
 const writers=[
  ['scripts/test-valve-ingress-x2-parity.js','X2_EVIDENCE'],
  ['scripts/test-valve-ingress-x2-additive.js','X2_ADDITIVE_EVIDENCE'],
  ['scripts/lib/valve-ingress-x2-runtime.js','X2_EVIDENCE'],
  ['scripts/test-valve-ingress-x2-stateful.js','X2_STATE_EVIDENCE'],
 ];
 try{
  for(const [script,key]of writers)for(const target of files){
   const env={...process.env};for(const name of ['X2_EVIDENCE','X2_ADDITIVE_EVIDENCE','X2_STATE_EVIDENCE'])delete env[name];
   env[key]=path.join(tree.dir,'scripts/fixtures/valve-ingress-x2',target);
   const result=spawnSync(process.execPath,[script],{cwd:tree.dir,env,encoding:'utf8'});
   assert.equal(result.status,1,script+' must reject an existing evidence path');assert.match(result.stderr,/EEXIST/);
   assert.deepEqual(files.map(file=>fs.readFileSync(path.join(tree.dir,'scripts/fixtures/valve-ingress-x2',file))),expected,'oracles remain byte-identical');
  }
  const {createEvidenceWriter}=require('./lib/valve-ingress-x2-evidence');
  const source=path.join(tree.dir,'scripts/fixtures/valve-ingress-x2/hashes.json'),alias=path.join(dir,'alias.json');fs.symlinkSync(source,alias);
  assert.throws(()=>createEvidenceWriter('X2_EVIDENCE',{X2_EVIDENCE:alias}),{code:'EEXIST'});
  const output=path.join(dir,'new.json'),write=createEvidenceWriter('X2_EVIDENCE',{X2_EVIDENCE:output});write({ok:true});
  assert.deepEqual(JSON.parse(fs.readFileSync(output)),{ok:true});assert.throws(()=>write({ok:false}),/already written/);
  assert.throws(()=>createEvidenceWriter('X2_EVIDENCE',{X2_EVIDENCE:output}),{code:'EEXIST'});
  // A replaced pathname cannot redirect a reserved descriptor into an oracle.
  const reserved=path.join(dir,'reserved.json'),finish=createEvidenceWriter('X2_EVIDENCE',{X2_EVIDENCE:reserved});fs.unlinkSync(reserved);fs.symlinkSync(source,reserved);finish({owned:true});
  assert.deepEqual(fs.readFileSync(source),expected[1]);
 }finally{tree.close();fs.rmSync(dir,{recursive:true,force:true});}
});
