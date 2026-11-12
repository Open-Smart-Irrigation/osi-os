#!/usr/bin/env node
'use strict';
// The workflow runs the full smoke suite before this list gate. Its event
// choice lives here because the test inventory cannot model startsWith in if.
function releaseEvent(event,ref) {
  return event==='workflow_dispatch'||String(ref||'').startsWith('refs/tags/v');
}
function gate(known,{ci=false,event,ref}={}) {
  return (!ci||releaseEvent(event,ref))&&known.length>0?1:0;
}
if(require.main===module) {
  const args=process.argv.slice(2);
  if(args.length>1||args.some(a=>a!=='--ci'))throw new Error('usage: node scripts/release-smoke-gate.js [--ci]');
  const known=require('./fixtures/release-smoke/known-failures.json');
  process.exitCode=gate(known,{ci:args.includes('--ci'),event:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF});
  if(process.exitCode){console.error('RELEASE REFUSED: '+known.length+' known failing cases remain');for(const c of known)console.error(c.finding+' '+c.id);}
  else console.log(args.includes('--ci')&&!releaseEvent(process.env.GITHUB_EVENT_NAME,process.env.GITHUB_REF)?'RELEASE LIST: ordinary PR/branch run; runtime suite enforces known signatures':'RELEASE LIST: empty');
}
module.exports={gate,releaseEvent};
