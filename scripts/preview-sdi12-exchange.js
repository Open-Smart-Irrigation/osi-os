#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readBoundedJsonFile } = require('./lib/read-bounded-json-file');
const { inspectExchange, calculateCapacity } = require('./lib/sdi12-protocol-lab');
const examplesPath = path.join(__dirname, 'fixtures/device-integration/sdi12/protocol-examples.json');

function failure(code) {
  return { ok: false, disposition: 'invalid', code,
    hardware_verified: false, acquisition_available: false, eligible: false };
}

function preview(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'input,operation') return failure('invalid_input');
  if (value.operation === 'exchange') return inspectExchange(value.input);
  if (value.operation === 'capacity') return calculateCapacity(value.input);
  return failure('invalid_operation');
}

function main(args) {
  if (args.length === 1 && args[0] === '--list') {
    const examples = JSON.parse(fs.readFileSync(examplesPath, 'utf8'));
    return { ok: true, hardware_verified: false, acquisition_available: false, eligible: false,
      examples: examples.map(({ name, evidence, description }) => ({ name, evidence, description })) };
  }
  if (args.length === 2 && args[0] === '--example') {
    const examples = JSON.parse(fs.readFileSync(examplesPath, 'utf8'));
    const selected = examples.find(item => item.name === args[1]);
    return selected ? preview(selected.input) : failure('unknown_example');
  }
  if (args.length !== 1 || args[0].startsWith('--')) return failure('invalid_usage');
  const input = readBoundedJsonFile(args[0]);
  return input.ok ? preview(input.value) : failure(input.code);
}

try {
  const output = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = output.ok ? 0 : 1;
} catch (err) {
  process.stdout.write(JSON.stringify(failure('preview_failed')) + '\n');
  process.exitCode = 1;
}
