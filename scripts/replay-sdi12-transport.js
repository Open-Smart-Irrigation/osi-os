#!/usr/bin/env node
'use strict';

// Offline replay only. No device commands, persistence, or eligibility promotion.
const fs = require('node:fs');
const path = require('node:path');
const { readBoundedJsonFile } = require('./lib/read-bounded-json-file');
const { replay } = require('./lib/sdi12-transport-lab');
const examplesPath = path.join(__dirname, 'fixtures/device-integration/sdi12/transport-scenarios.json');

function failure(code) {
  return { ok: false, code, hardware_verified: false, acquisition_available: false, eligible: false };
}

function main(args) {
  if (args.length === 1 && args[0] === '--list') {
    const examples = JSON.parse(fs.readFileSync(examplesPath, 'utf8'));
    return { ok: true, hardware_verified: false, acquisition_available: false, eligible: false,
      examples: examples.map(({ name, description }) => ({ name, description })) };
  }
  if (args.length === 2 && args[0] === '--example') {
    const examples = JSON.parse(fs.readFileSync(examplesPath, 'utf8'));
    const example = examples.find(item => item.name === args[1]);
    return example ? replay(example.input) : failure('unknown_example');
  }
  if (args.length !== 1 || args[0].startsWith('--')) return failure('invalid_usage');
  const input = readBoundedJsonFile(args[0]);
  return input.ok ? replay(input.value) : failure(input.code);
}

try {
  const output = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = output.ok ? 0 : 1;
} catch (err) {
  process.stdout.write(JSON.stringify(failure('replay_failed')) + '\n');
  process.exitCode = 1;
}
