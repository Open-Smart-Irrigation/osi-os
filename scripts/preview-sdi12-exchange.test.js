'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const examples = require('./fixtures/device-integration/sdi12/protocol-examples.json');
const script = path.join(__dirname, 'preview-sdi12-exchange.js');

function run(args, cwd) {
  const processResult = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  assert.equal(processResult.stderr, '');
  const output = JSON.parse(processResult.stdout);
  assert.equal(output.hardware_verified, false);
  assert.equal(output.acquisition_available, false);
  assert.equal(output.eligible, false);
  return { ...processResult, output };
}

test('all listed examples have explicit provenance and pinned protocol outcomes', () => {
  const listed = run(['--list']);
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.output.examples.map(item => item.name), examples.map(item => item.name));
  for (const example of examples) {
    assert.ok(['synthetic', 'standard_example'].includes(example.evidence));
    const { status, output } = run(['--example', example.name]);
    assert.equal(status, example.expected.ok ? 0 : 1, example.name);
    for (const [key, value] of Object.entries(example.expected)) assert.deepEqual(output[key], value, example.name + ':' + key);
    if (output.disposition === 'capacity') assert.equal(output.actual_block_count_known, false);
  }
});

test('explicit exchange file runs outside the checkout without stripping its reply', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-exchange-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'exchange.json');
  const input = examples[0].input;
  fs.writeFileSync(file, JSON.stringify(input));
  const { status, output } = run([file], directory);
  assert.equal(status, 0);
  assert.equal(output.blocks[0].raw_response, input.input.blocks[0].response);
  assert.deepEqual(output.tokens, ['+3.14', '+2.718', '+1.414']);
});

test('CLI rejects malformed envelopes, JSON, paths, size and usage with bounded errors', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-exchange-errors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  for (const input of [null, [], {}, { operation: 'send', input: {} },
    { ...examples[0].input, send: true }, { operation: 'exchange', input: {} }]) {
    fs.writeFileSync(file, JSON.stringify(input));
    const result = run([file]);
    assert.equal(result.status, 1);
    assert.equal(result.output.ok, false);
    assert.ok(result.stdout.length < 500);
  }
  for (const text of ['{', ' '.repeat(1024 * 1024 + 1)]) {
    fs.writeFileSync(file, text);
    assert.equal(run([file]).status, 1);
  }
  for (const args of [[], ['--send'], ['--example', 'missing'], ['--list', 'extra'],
    [path.join(directory, 'missing.json')]]) assert.equal(run(args).status, 1);
});

test('audit capacity arithmetic is checked as packed estimates, never firmware block counts', () => {
  const { calculateCapacity } = require('./lib/sdi12-protocol-lab');
  const cases = require('../docs/devices/sdi12-protocol-audit/calculations.json').cases
    .filter(item => item.sensor === 'SDI-12');
  assert.equal(cases.length, 36);
  for (const item of cases) {
    const output = calculateCapacity({ family: item.input.mode, value_count: item.input.values,
      value_width: item.input.width, crc: false });
    assert.equal(output.ok, true);
    assert.equal(output.packed_blocks, item.expected.blocks);
    assert.equal(output.values_per_packed_block, item.expected.values_per_block);
    assert.equal(output.actual_block_count_known, false);
    assert.equal(output.eligible, false);
  }
});

test('both bounded offline CLIs refuse nonregular inputs and cap bytes after a stale size check', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-input-bound-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fifo = path.join(directory, 'pipe.json');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const preload = path.join(directory, 'stale-stat.js');
  fs.writeFileSync(preload, "const fs = require('node:fs');\nfor (const key of ['statSync', 'fstatSync']) {\n const original = fs[key];\n fs[key] = (...args) => { const stat = original(...args); stat.size = 0; return stat; };\n}\n");
  const transportInput = require('./fixtures/device-integration/sdi12/transport-scenarios.json')[0].input;
  for (const [cli, input] of [[script, examples[0].input],
    [path.join(__dirname, 'replay-sdi12-transport.js'), transportInput]]) {
    const pipeResult = spawnSync(process.execPath, [cli, fifo], { encoding: 'utf8', timeout: 1500 });
    assert.equal(pipeResult.status, 1, 'nonregular input must fail without waiting for a writer');
    assert.equal(JSON.parse(pipeResult.stdout).code, 'input_not_regular');
    const large = path.join(directory, 'large.json');
    fs.writeFileSync(large, ' '.repeat(1024 * 1024) + JSON.stringify(input));
    const grown = spawnSync(process.execPath, ['--require', preload, cli, large], { encoding: 'utf8' });
    assert.equal(grown.status, 1, 'actual reads must remain bounded after stat becomes stale');
    assert.equal(JSON.parse(grown.stdout).code, 'input_too_large');
  }
});
