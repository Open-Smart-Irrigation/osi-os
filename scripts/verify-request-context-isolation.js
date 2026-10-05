#!/usr/bin/env node
'use strict';

// verify-request-context-isolation (osi-os #377).
//
// The valve and zone-schedule mutation chains carry each request's identity, target
// and payload on msg (msg.osi.request). Shared flow/global context is one store for
// every concurrent request, so a per-request value kept there is read by whichever
// request runs next. This guard fails when:
//   1. any function node in a maintained flows.json profile reads or writes a
//      per-request key (valve_cmd_*, sched_*, lastCommand, lastCommandId) in flow,
//      global or node context;
//   2. a node of the converted chains touches flow/global/node context beyond its
//      explicit allowlist (process configuration such as global.get('fs') only), or
//      with a key that is not a string literal;
//   3. a converted chain node no longer names its request envelope kind, or its id
//      now belongs to a different node.
// Behaviour under interleaving is proven by scripts/test-request-context-isolation.js.
//
// Usage: node scripts/verify-request-context-isolation.js [--flows <path>]...

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

const REQUEST_SCRATCH_KEY = /^(valve_cmd_|sched_|lastCommand(Id)?$)/;

const CONVERTED = {
  '83bb4a452dd9ae37': { name: 'Auth + Validate + Normalize', kind: 'valve_command', allowed: ["global.get('fs')"] },
  '9ad895844533fb35': { name: 'Check device ownership + type', kind: 'valve_command', allowed: [] },
  'dde8e1ef265e96d7': { name: 'Build actuator_command + DB writes', kind: 'valve_command', allowed: [] },
  '22cc64fa2a899cea': { name: 'Verify Zone Ownership', kind: 'zone_schedule_put', allowed: [] },
  'd7e5c762c820aa16': { name: 'Build UPSERT', kind: 'zone_schedule_put', allowed: [] },
  '636ed15f34fa99c4': { name: 'Format Response', kind: 'zone_schedule_put', allowed: [] },
  'c8628cffe45f64f7': { name: 'Build Status + ACK', kind: null, allowed: [] },
  'e2e139678c3ddded': { name: 'Build Schedule ACK', kind: null, allowed: [] },
  '934bf2bc19a8ce22': { name: 'Route Command', kind: null, allowed: ["global.get('fs')", "global.get('cp')"] },
};

const CONTEXT_CALL = /\b(flow|global|context)\s*\.\s*(get|set|keys)\s*\(\s*([^,)]*)/g;
const STRING_LITERAL = /^(['"`])([^'"`]*)\1$/;

function parseArgs(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--flows' && argv[i + 1]) files.push(path.resolve(argv[++i]));
    else throw new Error('unknown argument: ' + argv[i]);
  }
  return files.length ? files : DEFAULT_PROFILES.map((rel) => path.join(ROOT, rel));
}

function contextCalls(source) {
  const calls = [];
  for (const match of String(source || '').matchAll(CONTEXT_CALL)) {
    const arg = match[3].trim();
    const literal = STRING_LITERAL.exec(arg);
    calls.push({
      text: match[1] + '.' + match[2] + '(' + arg + ')',
      key: literal ? literal[2] : null,
    });
  }
  return calls;
}

function checkProfile(file) {
  const label = path.relative(ROOT, file) || file;
  const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const failures = [];
  let functionNodes = 0;
  for (const node of flows) {
    if (!node || node.type !== 'function') continue;
    functionNodes += 1;
    const sources = [node.func, node.initialize, node.finalize].filter(Boolean).join('\n');
    const calls = contextCalls(sources);
    for (const call of calls) {
      if (call.key && REQUEST_SCRATCH_KEY.test(call.key)) {
        failures.push(label + ': ' + node.id + ' (' + node.name + ') keeps per-request state in shared context: ' + call.text);
      }
    }
    const converted = CONVERTED[node.id];
    if (!converted) continue;
    if (node.name !== converted.name) {
      failures.push(label + ': ' + node.id + ' is now named "' + node.name + '", expected "' + converted.name + '"; update this guard deliberately');
    }
    for (const call of calls) {
      if (!converted.allowed.includes(call.text)) {
        failures.push(label + ': ' + node.id + ' (' + node.name + ') touches shared context outside its allowlist: ' + call.text);
      }
    }
    if (converted.kind && !node.func.includes("'" + converted.kind + "'")) {
      failures.push(label + ': ' + node.id + ' (' + node.name + ") no longer handles the '" + converted.kind + "' request envelope");
    }
  }
  for (const id of Object.keys(CONVERTED)) {
    if (!flows.some((node) => node && node.id === id)) failures.push(label + ': converted node ' + id + ' is missing');
  }
  return { label, failures, functionNodes };
}

function main() {
  const files = parseArgs(process.argv.slice(2));
  const failures = [];
  for (const file of files) {
    const result = checkProfile(file);
    failures.push(...result.failures);
    if (!result.failures.length) {
      console.log('OK ' + result.label + ' (' + result.functionNodes + ' function nodes, ' + Object.keys(CONVERTED).length + ' converted)');
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error('FAIL ' + failure);
    console.error('verify-request-context-isolation: FAIL (' + failures.length + ')');
    process.exit(1);
  }
  console.log('verify-request-context-isolation: OK');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('verify-request-context-isolation: FAIL - ' + error.message);
    process.exit(1);
  }
}

module.exports = { checkProfile, contextCalls, CONVERTED, REQUEST_SCRATCH_KEY };
