'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const examples = require('./fixtures/device-integration/sdi12/bench-captures.json');
const script = path.join(__dirname, 'check-sdi12-capture.js');
const flags = ['hardware_verified', 'configuration_verified', 'acquisition_available', 'eligible', 'recipe_deployable'];
function run(args, cwd) {
  const child = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.equal(child.stderr, '');
  const output = JSON.parse(child.stdout);
  for (const key of flags) assert.equal(output[key], false, key);
  assert.equal(output.channels, undefined);
  return { status: child.status, output };
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-capture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('every synthetic capture has provenance and pinned complete or diagnostic results', () => {
  const listed = run(['--list']);
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.output.examples.map(e => e.name), examples.map(e => e.name));
  for (const example of examples) {
    assert.equal(example.evidence, 'synthetic');
    assert.equal(example.input.evidence, 'synthetic');
    assert.ok(example.source && example.source_locator && example.transformation);
    const { status, output } = run(['--example', example.name]);
    assert.equal(status, example.expected.ok ? 0 : 1, example.name);
    for (const [key, expected] of Object.entries(example.expected)) {
      const actual = key.split('.').reduce((value, part) => value && value[part], output);
      assert.deepEqual(actual, expected, example.name + ':' + key);
    }
    if (output.ok) {
      assert.equal(output.timing_verified, false);
      assert.equal(output.bindings_verified, false);
      assert.deepEqual(output.capture, example.input);
      assert.equal(output.preview.simulation.protocol.channels, undefined);
    }
  }
});
test('template and filled capture work outside checkout without inventing evidence', t => {
  const dir = temp(t), input = path.join(dir, 'recipe.json'), record = path.join(dir, 'capture.json');
  const recipe = structuredClone(examples[1].input.recipe_input); recipe.exchange = null;
  fs.writeFileSync(input, JSON.stringify(recipe));
  const generated = run(['--template', input], dir);
  assert.equal(generated.status, 0);
  assert.equal(generated.output.disposition, 'template');
  const capture = generated.output.capture;
  assert.equal(capture.capture_id, null);
  assert.equal(capture.recipe_input.exchange, null);
  assert.equal(capture.radio, null);
  assert.equal(capture.evidence, 'bench');
  assert.equal(capture.setup.converter_firmware, null);
  assert.deepEqual(capture.discovery.map(d => d.command), ['0I!', '0XRM3S1!', '0XRM3S2!', '0XRM3S3!', '0XRM3S4!', '0XRM3S5!', '0XRM3S6!']);
  assert.ok(capture.discovery.every(d => d.response_bytes === null));
  fs.writeFileSync(record, JSON.stringify(capture));
  const incomplete = run([record], dir);
  assert.equal(incomplete.status, 1);
  assert.equal(incomplete.output.code, 'capture_incomplete');
  fs.writeFileSync(record, JSON.stringify(examples[1].input));
  const replay = run([record], dir);
  assert.equal(replay.status, 0);
  assert.equal(replay.output.radio_check.wrapper.raw_bytes.length, 58);
  assert.deepEqual(replay.output.radio_check.wrapper.records.map(r => r.slot), [3,5,7]);
});
test('CLI input modes reject malformed requests and bound file reads', t => {
  const dir = temp(t), file = path.join(dir, 'input.json');
  for (const value of [null, [], {}, { ...examples[0].input, enable: true }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.equal(run([file]).output.code, 'invalid_capture');
  }
  // A bounded file can still exceed structuredClone's recursion depth.
  const record = { ...examples[0].input };
  delete record.recipe_input;
  const encoded = JSON.stringify(record).replace(/}$/, ',"recipe_input":' + '['.repeat(5000) + '0' + ']'.repeat(5000) + '}');
  fs.writeFileSync(file, encoded);
  assert.equal(run([file]).output.code, 'invalid_capture');
  fs.writeFileSync(file, JSON.stringify(examples[0].input.recipe_input));
  assert.equal(run(['--template', file]).output.code, 'template_requires_plan');
  for (const [content, code] of [['{', 'invalid_json'], [' '.repeat(1024 * 1024 + 1), 'input_too_large']]) {
    fs.writeFileSync(file, content);
    assert.equal(run([file]).output.code, code);
    assert.equal(run(['--template', file]).output.code, code);
  }
  assert.equal(run([dir]).output.code, 'input_not_regular');
  const fifo = path.join(dir, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.equal(run([fifo]).output.code, 'input_not_regular');
  for (const args of [[], ['--bad'], ['--example','absent'], ['--template'], ['--template',file,'extra'], ['--list','extra'], [file + '.missing']]) {
    assert.equal(run(args).status, 1);
  }
});
