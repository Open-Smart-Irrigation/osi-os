'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classify}=require('./test-release-smoke');
const known=[{id:'case',finding:'F-1',failures:[{code:'http',symptom:'http-timeout'}]}];
const failed={id:'case',failures:[{code:'http',actual:{timeout:true}}]};
test('exact known failure is counted separately',()=>{
  const r=classify([failed,{id:'healthy',failures:[]}],known);
  assert.equal(r.failed.length,0);assert.equal(r.knownToFail.length,1);assert.equal(r.passed.length,1);
});
test('a known case passing is a blocking error',()=>{
  assert.match(classify([{id:'case',failures:[]}],known).failed[0].reason,/passed/);
});
test('an additional failure in a known case is blocking',()=>{
  assert.equal(classify([{...failed,failures:[...failed.failures,{code:'radio'}]}],known).failed.length,1);
});
test('missing and renamed known cases cannot disappear',()=>{
  assert.equal(classify([],known).failed.length,1);
  assert.equal(classify([{id:'renamed',failures:[]}],known).failed.length,1);
});
test('new failures and unexpected exceptions are never allowlisted by finding',()=>{
  assert.equal(classify([{id:'new',failures:[{code:'http'}]}],known).failed.length,2);
  assert.throws(()=>classify([failed],[...known,...known]),/duplicate/);
  assert.throws(()=>classify([failed,failed],known),/duplicate/);
});

test('same assertion failing with a different symptom is blocking',()=>{
  const changed={id:'case',failures:[{code:'http',actual:{status:500,json:{error:'new error'}}}]};
  assert.equal(classify([changed],known).failed.length,1);
});

const {gate}=require('./release-smoke-gate');
test('release mode refuses a nonempty list and permits an empty list',()=>{
  assert.equal(gate(known),1);assert.equal(gate([]),0);
});
test('CI permits listed failures on ordinary PR and branch runs',()=>{
  assert.equal(gate(known,{ci:true,event:'pull_request',ref:'refs/pull/1/merge'}),0);
  assert.equal(gate(known,{ci:true,event:'push',ref:'refs/heads/main'}),0);
});
test('CI refuses listed failures on manual release checks and version tags',()=>{
  assert.equal(gate(known,{ci:true,event:'workflow_dispatch',ref:'refs/heads/main'}),1);
  assert.equal(gate(known,{ci:true,event:'push',ref:'refs/tags/v0.0.0'}),1);
  assert.equal(gate([],{ci:true,event:'push',ref:'refs/tags/v0.0.0'}),0);
});

test('each known case names exactly one finding',()=>{
  for(const finding of ['F-1 / F-2','F-5 / known defect 2','untracked']) {
    assert.throws(()=>classify([failed],[{...known[0],finding}]),/exactly one finding/);
  }
  for(const finding of ['F-1','A-1','S-1','NEW-1','known defect 1']) {
    assert.equal(classify([failed],[{...known[0],finding}]).knownToFail.length,1);
  }
});

const {isExpectedRefusal}=require('./fixtures/release-smoke/observation');
test('expected refusals are exact by scenario, source, type and full message',()=>{
  const refusal={caseId:'no-token:GET /example',sourceId:'auth',sourceType:'function',message:'Error: Unauthorized'};
  assert.equal(isExpectedRefusal(refusal,[refusal]),true);
  for(const changed of [{caseId:'boot'},{sourceId:'late-handler'},{sourceType:'sqlite'},{message:'Unauthorized: ReferenceError'}]) {
    assert.equal(isExpectedRefusal({...refusal,...changed},[refusal]),false);
  }
  assert.equal(isExpectedRefusal({...refusal,message:'SQLITE_BUSY: database is locked'},[refusal]),false);
});

const {runtimeConfig,combineKnown,parseVersions,checkRuntime}=require('./lib/release-smoke-runtimes');
test('both deployed runtimes have pinned versions and unknown runtimes fail closed',()=>{
  assert.equal(runtimeConfig('image').nodeRed,'3.1.15');
  assert.equal(runtimeConfig('stock').nodeRed,'4.0.9');
  assert.equal(runtimeConfig('stock').node,'20.18.3');
  assert.throws(()=>runtimeConfig('typo'),/unknown runtime/);
  assert.throws(()=>parseVersions('env:\n  OSI_SMOKE_NODE_VERSION: lts\n'),/version/);
});
test('workflow runtime versions must match both fixture locks',t=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  for(const name of ['image','stock']) {
    const config=runtimeConfig(name);
    const lock=require(path.join(config.fixture,'package-lock.json'));
    assert.equal(lock.packages['node_modules/node-red'].version,config.nodeRed);
    assert.equal(require(path.join(config.fixture,'package.json')).dependencies['node-red'],config.nodeRed);
    assert.throws(()=>checkRuntime({...config,node:process.versions.node,nodeRed:'0.0.0'}),/differs from workflow/);
  }
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'smoke-pin-test-'));t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({dependencies:{'node-red':'4.0.9'}}));
  fs.writeFileSync(path.join(fixture,'package-lock.json'),JSON.stringify({packages:{'node_modules/node-red':{version:'4.0.8'}}}));
  assert.throws(()=>checkRuntime({name:'stock',node:process.versions.node,nodeRed:'4.0.9',fixture}),/package-lock.json.*differs from workflow/);
});
test('release policy includes the stock list even when the image list is empty',()=>{
  const both=combineKnown({image:[],stock:known});
  assert.equal(both[0].runtime,'stock');
  assert.equal(gate(both,{ci:true,event:'push',ref:'refs/tags/v0.0.0'}),1);
  assert.equal(gate(both,{ci:true,event:'workflow_dispatch'}),1);
  assert.equal(gate(combineKnown({image:[],stock:[]})),0);
  assert.throws(()=>combineKnown({image:[]}),/stock/);
  assert.throws(()=>combineKnown({image:[],stock:null}),/stock/);
});
