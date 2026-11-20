#!/usr/bin/env node
'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const assert=require('node:assert/strict');
for(const control of ['--negative-extra-port','--negative-duplicate-send']) {
 const run=spawnSync(process.execPath,[path.join(__dirname,'test-daily-scheduler-node-red.js'),control],{env:process.env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 assert.ifError(run.error);assert.equal(run.status,1,control+' must fail');
 assert.match(run.stderr,/NATIVE_PORT_PARITY_MISMATCH/,'control must reach the native comparison, not fail setup');
 console.log('native negative control rejected: '+control);
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'x1-native-write-once-'));
try {
 const original=fs.readFileSync(path.join(__dirname,'fixtures/daily-scheduler/expected.json'));
 const target=path.join(dir,'expected.json');fs.writeFileSync(target,original,{flag:'wx'});
 const run=spawnSync(process.execPath,[path.join(__dirname,'test-daily-scheduler-node-red.js'),'--child','full_raspberrypi_bcm27xx_bcm2712','legacy',target],{env:{...process.env,OSI_X1_EVIDENCE:target,OSI_X1_OUTPUT:target},encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
 assert.ifError(run.error);assert.equal(run.status,1,'native evidence must refuse an existing output');
 assert.match(run.stderr,/EEXIST/,'control reaches the exclusive evidence write');
 assert.deepStrictEqual(fs.readFileSync(target),original,'existing oracle bytes remain unchanged');
 console.log('native evidence overwrite rejected: EEXIST; oracle bytes unchanged');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
