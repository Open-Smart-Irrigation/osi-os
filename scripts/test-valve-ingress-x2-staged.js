#!/usr/bin/env node
'use strict';
const {spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {stagedTree}=require('./lib/valve-ingress-x2-stage');
const mode=process.argv[2];
assert.ok(['--focused','--ci','--runtime'].includes(mode),'choose a staged gate');
if(mode==='--ci')assert.equal(process.env.CI,'true','full staged gates run in GitHub CI');
const tree=stagedTree();
function run(args,env={}){
 console.log('staged X2:',process.execPath,...args);
 const result=spawnSync(process.execPath,args,{cwd:tree.dir,env:{...process.env,...env},stdio:'inherit'});
 assert.equal(result.status,0,'staged gate failed: '+args.join(' '));
}
try{
 if(mode==='--ci'){
  const installed=spawnSync('npm',['ci','--ignore-scripts','--prefix','scripts','--no-audit','--no-fund'],{cwd:tree.dir,stdio:'inherit'});
  assert.equal(installed.status,0,'staged CI dependencies');
 }
 if(mode==='--runtime'){
  run(['scripts/lib/valve-ingress-x2-runtime.js']);
  for(const control of ['extra-port','returned-auth']){
   const result=spawnSync(process.execPath,['scripts/lib/valve-ingress-x2-runtime.js','--control='+control],{cwd:tree.dir,env:{...process.env,X2_EVIDENCE:''},encoding:'utf8',maxBuffer:4*1024*1024});
   assert.equal(result.status,1,'native '+control+' control did not fail');
   assert.match(result.stderr,/X2 native differential/,'control failed outside the differential assertion: '+result.stderr);
   if(control==='returned-auth')assert.match(result.stdout,/one 401 per receiver on output 2, zero Catch deliveries/);
   console.log('native negative control rejected:',control);
  }
 }else{
  run(['scripts/test-valve-ingress-x2-parity.js']);
  run(['scripts/test-valve-ingress-x2-additive.js']);
  run(['scripts/apply-valve-ingress-x2-adapters.js']);
  run(['scripts/verify-command-safety.js']);
  run(['scripts/verify-request-context-isolation.js']);
  run(['scripts/verify-auth-flag-off-hermetic.js']);
  run(['--test','--test-concurrency=1','scripts/test-valve-ingress-x2-failures.js','scripts/test-valve-ingress-x2-stateful.js','scripts/test-valve-ingress-x2-handoff.js','scripts/verify-auth-flag-off-hermetic.test.js','scripts/test-sdi12-recipe-flow.js','scripts/test-conditional-irrigation-writer-wrappers.js','scripts/test-request-context-isolation.js','scripts/test-valve-http-reply-once.js']);
  run(['scripts/run-module-tests.js',...['bcm2712','bcm2709'].map(p=>`conf/full_raspberrypi_bcm27xx_${p}/files/usr/share/node-red/osi-valve-control/ingress-x2.test.js`)]);
  if(mode==='--ci'){
   for(const file of ['verify-no-new-silent-catch.js','verify-no-stray-ddl.js','verify-flows-size-ratchet.js','verify-profile-parity.js','verify-osi-lib-db-caller-binding.js','verify-command-ack-postconditions.js','verify-flows-fn-parse.js','verify-flows-output-arity.js','verify-flows-sandbox.js','verify-migrations.js','verify-seed-db-ledger.js','verify-sync-flow.js'])run(['scripts/'+file]);
  }
 }
}finally{tree.close();}
