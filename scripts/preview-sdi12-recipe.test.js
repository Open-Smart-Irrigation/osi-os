'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const examples = require('./fixtures/device-integration/sdi12/recipe-examples.json');
const script = path.join(__dirname, 'preview-sdi12-recipe.js');

function run(args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  for (const key of ['hardware_verified', 'configuration_verified', 'acquisition_available', 'eligible', 'recipe_deployable']) {
    assert.equal(output[key], false, key);
  }
  assert.equal(output.channels, undefined);
  return { ...result, output };
}

test('all recipe examples pin logical commands, capacities and raw-only outcomes', () => {
  const listed = run(['--list']);
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.output.examples.map(item => item.name), examples.map(item => item.name));
  for (const example of examples) {
    assert.equal(example.evidence, 'synthetic');
    assert.ok(example.source && example.source_locator && example.transformation);
    const { status, output } = run(['--example', example.name]);
    assert.equal(status, example.expected.ok ? 0 : 1, example.name);
    for (const [key, expected] of Object.entries(example.expected)) {
      const actual = key.split('.').reduce((value, part) => value && value[part], output);
      assert.deepEqual(actual, expected, example.name + ':' + key);
    }
    if (output.recipe) {
      assert.equal(output.recipe.fixed_converter_recipe, null);
      assert.equal(output.recipe.power_window_ms, null);
      assert.equal(output.recipe.channels, undefined);
    }
    if (output.disposition === 'simulated') {
      assert.deepEqual(output.simulation.roundtrip.exchange.tokens, output.simulation.protocol.tokens);
      assert.equal(output.simulation.evidence, 'modelled_from_supplied_exchange');
      assert.equal(output.simulation.timing_verified, false);
    }
  }
});

test('plan file works outside checkout and lists every PR2 readback with exact command bytes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-recipe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  fs.writeFileSync(file, JSON.stringify(examples[0].input));
  const result = run([file], directory);
  assert.equal(result.status, 0);
  const commands = result.output.recipe.discovery;
  assert.deepEqual(commands.map(item => item.command), ['AI!', 'AXRM3S1!', 'AXRM3S2!', 'AXRM3S3!', 'AXRM3S4!']);
  for (const item of commands) assert.deepEqual(item.bytes, [...Buffer.from(item.command, 'ascii')]);
  assert.deepEqual(result.output.recipe.measurement.bytes, [65,77,51,33]);
});

test('CLI refuses malformed requests and bounds input files and usage', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-recipe-errors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  for (const input of [null, [], {}, { ...examples[0].input, deploy: true },
    { ...examples[0].input, converter: {} }, { ...examples[0].input, exchange: 'NULL' }]) {
    fs.writeFileSync(file, JSON.stringify(input));
    const result = run([file]);
    assert.equal(result.status, 1);
    assert.equal(result.output.ok, false);
  }
  for (const [content, code] of [['{', 'invalid_json'], [' '.repeat(1024 * 1024 + 1), 'input_too_large']]) {
    fs.writeFileSync(file, content);
    assert.equal(run([file]).output.code, code);
  }
  assert.equal(run([directory]).output.code, 'input_not_regular');
  const fifo = path.join(directory, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.equal(run([fifo]).output.code, 'input_not_regular');
  for (const args of [[], ['--bad'], ['--example', 'absent'], ['--list', 'extra'], [file + '.missing']]) {
    assert.equal(run(args).status, 1);
  }
});
