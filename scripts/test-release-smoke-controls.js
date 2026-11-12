#!/usr/bin/env node
'use strict';
// Two serial real-runtime mutations in disposable scratch copies. Neither
// profile is edited. Rejection must come from the error check itself, not the
// independent byte-integrity case or an HTTP scenario failing incidentally.
const assert=require('node:assert/strict');
const {main}=require('./test-release-smoke');
const args=process.argv.slice(2);
if(args.length>1||args.some(arg=>!['--runtime=image','--runtime=stock'].includes(arg)))throw new Error('usage: node scripts/test-release-smoke-controls.js [--runtime=image|--runtime=stock]');
for(const control of ['late','caught']) {
  let observed;
  const status=main(args,{control,onSummary:(summary,evidence)=>{observed={summary,evidence};}});
  assert.equal(status,1,control+' negative control must turn the gate red');
  assert.ok(observed,control+' must complete the runtime');
  const id=control==='late'?'valve-observe-fn':'sync-outbox-build';
  const caseId=control==='late'?'startup-function-errors':'caught-node-errors';
  const rejection=observed.summary.failed.find(c=>c.id===caseId);
  assert.ok(rejection,control+' must fail '+caseId);
  assert.match(JSON.stringify(rejection.failures),/smokeNegativeControlIdentifier is not defined/);
  assert.match(JSON.stringify(rejection.failures),new RegExp(id));
  assert.ok(observed.evidence.sweep.some(s=>s.received.includes(id)),control+' must reach the broken handler in the sweep');
  if(control==='caught')assert.ok(observed.evidence.caught.some(c=>c.sourceId===id&&c.sourceType==='function'&&c.message.includes('smokeNegativeControlIdentifier is not defined')));
  console.log('NEGATIVE CONTROL PASS',control,': exit=1;',caseId,'rejected',id);
}
