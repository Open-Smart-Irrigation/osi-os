'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ROOT,FIXTURE}=require('./test-valve-ingress-x2-parity');
const {validateManifest,replacement}=require('./lib/valve-ingress-x2-renderer');
const {canonicalHandoff,canonicalPatch,PATCH,verifyHandoff}=require('./lib/valve-ingress-x2-handoff');
// Raw application controls always start from the committed legacy bytes, even
// when this suite itself runs after the staged handoff.
function legacyHandoffTree(){
 const tree=require('./lib/valve-ingress-x2-stage').stagedTree({applyHandoff:false});
 for(const file of canonicalHandoff())fs.writeFileSync(path.join(tree.dir,file.rel),file.before);
 const staged=spawnSync('git',['add','--',...canonicalHandoff().map(file=>file.rel)],{cwd:tree.dir,encoding:'utf8'});
 assert.equal(staged.status,0,staged.stderr);
 return tree;
}
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

test('raw binary handoff applies every receipt file in the index and reverses exactly',()=>{
 const tree=legacyHandoffTree();
 const git=args=>spawnSync('git',args,{cwd:tree.dir,encoding:'utf8',maxBuffer:8*1024*1024});
 try{
  const before=git(['write-tree']).stdout;
  for(const reverse of [false,true]){
   const result=git(['apply','--cached',...(reverse?['--reverse']:[]),path.join(ROOT,PATCH)]);
   assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'','any Git patch diagnostic must fail the gate');
   for(const file of canonicalHandoff())assert.equal(git(['show',':'+file.rel]).stdout,reverse?file.before:file.after,'raw patch receipt content: '+file.rel);
  }
  assert.equal(git(['write-tree']).stdout,before,'reverse restores the complete index tree');
 }finally{tree.close();}
});

test('first additive capture recreates the committed bytes and remains write-once',()=>{
 const {stagedTree}=require('./lib/valve-ingress-x2-stage');
 const tree=stagedTree({applyHandoff:false});
 const target=path.join(tree.dir,'scripts/fixtures/valve-ingress-x2/additive-hashes.json'),expected=fs.readFileSync(target);
 const env={...process.env};for(const key of ['X2_EVIDENCE','X2_ADDITIVE_EVIDENCE','X2_STATE_EVIDENCE'])delete env[key];
 const capture=()=>spawnSync(process.execPath,['scripts/test-valve-ingress-x2-additive.js','--capture-additive='+target],{cwd:tree.dir,env,encoding:'utf8',maxBuffer:4*1024*1024});
 try{
  fs.unlinkSync(target);const first=capture();assert.equal(first.status,0,first.stderr);assert.deepEqual(fs.readFileSync(target),expected,'first capture exactly matches committed digest');
  const second=capture();assert.equal(second.status,1);assert.match(second.stderr,/write-once/);assert.deepEqual(fs.readFileSync(target),expected);
  fs.unlinkSync(target);
  const casesFile=path.join(tree.dir,'scripts/lib/valve-ingress-x2-additive-cases.js');
  const original=fs.readFileSync(casesFile,'utf8'),mutated=original.replace("tc.name='add/'+name", "tc.name='add/mutant-'+name");
  assert.notEqual(mutated,original,'capture mutant anchor exists');fs.writeFileSync(casesFile,mutated);
  const refused=capture();assert.equal(refused.status,1);assert.match(refused.stderr,/frozen oracle content digest changed/);
  assert.equal(fs.existsSync(target),false,'unapproved first-capture bytes are never created');

 }finally{tree.close();}
});

test('strict patch application rejects a truncated or omitted baseline hunk without changing the target',()=>{
 const os=require('node:os'),{applyReceiptPatch}=require('./lib/valve-ingress-x2-apply');
 const tree=legacyHandoffTree(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'x2-bad-patch-'));
 const full=fs.readFileSync(path.join(ROOT,PATCH),'utf8'),files=canonicalHandoff();
 const git=args=>spawnSync('git',args,{cwd:tree.dir,encoding:'utf8'});
 try{
  assert.ok(full.endsWith('\n\n'),'final binary hunk has its required blank separator');
  const offset=full.indexOf('diff --git a/scripts/fixtures/silent-catch-baseline.json ');assert.ok(offset>0);
  const before=git(['write-tree']).stdout;
  for(const [name,bytes]of [['truncated',full.slice(0,-1)],['omitted-baseline',full.slice(0,offset)]]){
   const patch=path.join(tmp,name+'.patch');fs.writeFileSync(patch,bytes);
   for(const cached of [false,true]){
    assert.throws(()=>applyReceiptPatch(tree.dir,files,{patch,cached}),/handoff (?:Git apply|receipt mismatch)/);
    assert.equal(git(['write-tree']).stdout,before,'rejected patch leaves the real index unchanged');
    for(const file of files)assert.equal(fs.readFileSync(path.join(tree.dir,file.rel),'utf8'),file.before,'rejected patch leaves working file unchanged: '+file.rel);
   }
  }
 }finally{tree.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
