#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const h=require('./lib/valve-ingress-x2-handoff');
const args=process.argv.slice(2);
assert.ok(args.length<=1&&args.every(a=>['--refresh-handoff','--write-with-dispatcher-reservation'].includes(a)),'unknown handoff option');
if(args[0]==='--refresh-handoff'){
 const files=h.canonicalHandoff();
 for(const f of files)assert.equal(fs.readFileSync(path.join(h.ROOT,f.rel),'utf8'),f.before,'refresh requires untouched source flows/baselines');
 fs.writeFileSync(path.join(h.ROOT,h.PATCH),h.canonicalPatch(files));
 fs.writeFileSync(path.join(h.ROOT,h.RECEIPT),JSON.stringify(h.receipt(files),null,2)+'\n');
 console.log('Refreshed independent patch and staged baseline receipt; flows untouched');
}else{
 const {files,state}=h.verifyHandoff();
 if(args.length)h.writeHandoff(h.ROOT);
 console.log(`${args.length?'APPLIED':'DRY RUN'}: ${state}; ${files.length} flow/baseline files match the checked-in patch and canonical renderer`);
}
