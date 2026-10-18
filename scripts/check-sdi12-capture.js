#!/usr/bin/env node
'use strict';
const examples = require('./fixtures/device-integration/sdi12/bench-captures.json');
const { readBoundedJsonFile } = require('./lib/read-bounded-json-file');
const { createCaptureTemplate, inspectCapture } = require('./lib/sdi12-bench-capture');
function failure(code) {
  return { ok: false, disposition: 'invalid', code, hardware_verified: false,
    configuration_verified: false, acquisition_available: false, eligible: false,
    recipe_deployable: false };
}
function main(args) {
  if (args.length === 1 && args[0] === '--list') {
    return { ok: true, hardware_verified: false, configuration_verified: false,
      acquisition_available: false, eligible: false, recipe_deployable: false,
      examples: examples.map(({ name, evidence, description }) => ({ name, evidence, description })) };
  }
  if (args.length === 2 && args[0] === '--example') {
    const example = examples.find(item => item.name === args[1]);
    return example ? inspectCapture(example.input) : failure('unknown_example');
  }
  if (args.length === 2 && args[0] === '--template') {
    const input = readBoundedJsonFile(args[1]);
    return input.ok ? createCaptureTemplate(input.value) : failure(input.code);
  }
  if (args.length !== 1 || args[0].startsWith('--')) return failure('invalid_usage');
  const input = readBoundedJsonFile(args[0]);
  return input.ok ? inspectCapture(input.value) : failure(input.code);
}
try {
  const output = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = output.ok ? 0 : 1;
} catch (err) {
  process.stdout.write(JSON.stringify(failure('capture_check_failed')) + '\n');
  process.exitCode = 1;
}
