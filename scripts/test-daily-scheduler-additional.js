#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { additionalCases, assertBranch } = require('./lib/daily-scheduler-additional-cases');
const { execute, PROFILES } = require('./lib/daily-scheduler-harness');
const { verifyFrozen, createExclusive, fixture } = require('./lib/daily-scheduler-oracles');
const legacy = require('./fixtures/daily-scheduler/legacy-nodes.json');
const adapters = require('./fixtures/daily-scheduler/adapters.json');
async function main() {
  const pins = verifyFrozen();
  const file = path.join(fixture, 'additional-expected.json');
  const capture = process.argv.includes('--capture');
  if(capture) assert.ok(!fs.existsSync(file), 'additive oracle is write-once');
  const expected = capture ? { source: pins['legacy-nodes.json'], cases: {} } : JSON.parse(fs.readFileSync(file));
  let count=0;
  for(const profile of PROFILES) for(const c of additionalCases()) {
    const before=await execute(legacy.find(n=>n.id===c.id).func,c,profile);
    assertBranch(c,before);
    if(capture) expected.cases[c.name]=before;
    else assert.deepStrictEqual(before,expected.cases[c.name],c.name+' frozen additive case');
    const after=await execute(adapters.find(n=>n.id===c.id).func,c,profile);
    assertBranch(c,after); assert.deepStrictEqual(after,before,profile+'/'+c.name); count++;
  }
  if(capture) createExclusive(file,expected);
  console.log('additional daily-scheduler parity: OK ('+count+' branch-asserted cases, frozen original oracle unchanged)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
