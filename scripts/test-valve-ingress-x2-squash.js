#!/usr/bin/env node
'use strict';
// Create a local verification commit with the PR tree and only the main base as
// parent, then clone only that branch over Git's transport (no local hardlinks).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync,spawnSync}=require('node:child_process');
const {stagedTree}=require('./lib/valve-ingress-x2-stage');
const ROOT=path.resolve(__dirname,'..'),BASE='1a984f31fabc28b60ba7695087984e1758dbe0f1';
function main(){
 const source=stagedTree({applyHandoff:false}),fresh=fs.mkdtempSync(path.join(os.tmpdir(),'x2-squash-clone-'));
 const git=(args,cwd=source.dir,options={})=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe'],...options});
 const env={...process.env};for(const key of ['X2_EVIDENCE','X2_ADDITIVE_EVIDENCE','X2_STATE_EVIDENCE'])delete env[key];
 try{
  const original=git(['rev-parse','HEAD']),tree=git(['write-tree']).trim();
  const squash=git(['-c','user.name=X2 fixture','-c','user.email=x2-fixture@example.invalid','commit-tree',tree,'-p',BASE],source.dir,{input:'X2 squash-equivalent verification fixture\n'}).trim();
  git(['update-ref','refs/heads/main',squash]);
  git(['clone','--quiet','--no-local','--no-tags','--single-branch','--branch','main',source.dir,fresh]);
  assert.equal(git(['rev-parse','HEAD'],fresh).trim(),squash);
  assert.equal(spawnSync('git',['cat-file','-e',original.trim()+'^{commit}'],{cwd:fresh,stdio:'pipe'}).status,128,'fresh clone must not contain PR head history');
  assert.equal(git(['for-each-ref','--format=%(refname)','refs/heads'],fresh).trim(),'refs/heads/main');
  assert.equal(git(['for-each-ref','--format=%(refname)','refs/tags','refs/pull'],fresh).trim(),'');
  const commits=git(['cat-file','--batch-all-objects','--batch-check=%(objectname) %(objecttype)'],fresh).trim().split('\n').filter(line=>line.endsWith(' commit')).map(line=>line.split(' ')[0]).sort();
  assert.deepEqual(commits,git(['rev-list','HEAD'],fresh).trim().split('\n').sort(),'fresh clone contains only squash/main-ancestry commit objects');
  git(['merge-base','--is-ancestor',require('./fixtures/valve-ingress-x2/baseline.json').source,'HEAD'],fresh);
  for(const args of [
   ['scripts/test-valve-ingress-x2-parity.js'],
   ['scripts/test-valve-ingress-x2-additive.js'],
   ['scripts/apply-valve-ingress-x2-adapters.js'],
   ['scripts/apply-valve-ingress-x2-adapters.js','--write-with-dispatcher-reservation'],
   ['scripts/test-valve-ingress-x2-parity.js'],
   ['scripts/apply-valve-ingress-x2-adapters.js'],
  ]){
   const result=spawnSync(process.execPath,args,{cwd:fresh,env,stdio:'inherit'});
   assert.equal(result.status,0,'squash-only clone: '+args.join(' '));
  }
  console.log('X2 squash-only clone: PR head absent, main source reachable; parity and handoff pass before and after application');
 }finally{source.close();fs.rmSync(fresh,{recursive:true,force:true});}
}
if(require.main===module)main();
module.exports={main};
