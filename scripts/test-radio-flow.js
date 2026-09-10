'use strict';
const fs=require('fs');const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const flows=JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'));
test('radio capture has an enabled always-loaded input and leaves field testing disabled',()=>{
 const inputs=flows.filter(n=>n.type==='mqtt in'&&n.topic==='application/+/device/+/event/up');
 const capture=flows.find(n=>n.id==='radio-capture-fn');
 const captureTab=flows.find(n=>n.id===capture.z);
 const fieldTesting=flows.find(n=>n.id==='a3f03829ad106e10');
 assert.equal(captureTab.disabled,false);
 assert.equal(captureTab.label,'Radio observations');
 assert.equal(fieldTesting.disabled,true);
 assert.equal(inputs.filter(n=>n.wires.flat().includes('radio-capture-fn')).length,1);
 assert.equal(inputs.find(n=>n.wires.flat().includes('radio-capture-fn')).z,captureTab.id);
 assert.equal(inputs.find(n=>n.id==='e382bbf0dde572b1').wires[0].length,2);
});
test('disabled capture returns without loading dependencies or touching DB',async()=>{const code=flows.find(n=>n.id==='radio-capture-fn').func;const fn=vm.runInNewContext('(async function(){'+code+'})',{env:{get:()=>''}});assert.equal(await fn(),null);});
test('all source reads use radio adapter but bookkeeping remains farming based',()=>{const code=flows.find(n=>n.id==='sync-history-build').func;assert.match(code,/sourceQuery\(tableName,helper.snapshotHighQuery/);assert.match(code,/sourceQuery\(tableName,lookup.sql/);assert.match(code,/sourceQuery\(tableName,\s*helper.batchQuery/);assert.match(code,/bridgeDirty\(_db\)/);assert.match(flows.find(n=>n.id==='sync-history-mark').func,/rb.generation=\?/);});
