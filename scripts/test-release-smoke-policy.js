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
