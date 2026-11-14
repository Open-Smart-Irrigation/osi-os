'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classify,report}=require('./test-release-smoke');
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
test('a listed case that was not executed fails with exit 1 and a summary',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'osi-release-smoke-policy-'));
  try {
    const errors=console.error;console.error=()=>{};
    let code;try{code=report({cases:[],seconds:1,maxRSSKiB:1},known,run);}finally{console.error=errors;}
    assert.equal(code,1);
    const summary=JSON.parse(fs.readFileSync(path.join(run,'summary.json'),'utf8'));
    assert.deepEqual(summary.failed.map(c=>[c.id,c.reason,c.failures]),[['case','known case was not executed',[]]]);
  } finally {fs.rmSync(run,{recursive:true,force:true});}
});
