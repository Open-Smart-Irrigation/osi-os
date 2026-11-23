#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PROFILES}=require('./lib/daily-scheduler-harness');
const {sequence,scenarios}=require('./lib/daily-scheduler-sequences');
const {verifyFrozen,createExclusive,fixture}=require('./lib/daily-scheduler-oracles');
(async()=>{
 verifyFrozen();const capture=process.argv.includes('--capture');const file=path.join(fixture,'sequence-expected.json');
 if(capture)assert.ok(!fs.existsSync(file),'sequence oracle is write-once');
 const expected=capture?{}:JSON.parse(fs.readFileSync(file));let count=0;
 for(const profile of PROFILES) for(const scenario of scenarios) {
  const before=await sequence('legacy',profile,scenario);if(capture)expected[profile+'/'+scenario]=before;else assert.deepStrictEqual(before,expected[profile+'/'+scenario],scenario+' frozen legacy trace');
  assert.deepStrictEqual(await sequence('adapter',profile,scenario),before,profile+'/'+scenario);count++;
 }
 if(capture)createExclusive(file,expected);console.log('scheduler sequence parity: OK ('+count+' real SQLite/reservation traces)');
})().catch(e=>{console.error(e);process.exitCode=1;});
