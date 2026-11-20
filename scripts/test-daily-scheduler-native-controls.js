#!/usr/bin/env node
'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const assert=require('node:assert/strict');
for(const control of ['--negative-extra-port','--negative-duplicate-send']) {
 const run=spawnSync(process.execPath,[path.join(__dirname,'test-daily-scheduler-node-red.js'),control],{env:process.env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 assert.ifError(run.error);assert.equal(run.status,1,control+' must fail');
 assert.match(run.stderr,/NATIVE_PORT_PARITY_MISMATCH/,'control must reach the native comparison, not fail setup');
 console.log('native negative control rejected: '+control);
}
