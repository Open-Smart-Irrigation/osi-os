'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const examples = require('./fixtures/device-integration/sdi12/converter-examples.json');
const script = path.join(__dirname, 'preview-sdi12-converter.js');

function run(args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.stderr, '');
  assert.equal(result.error, undefined);
  const output = JSON.parse(result.stdout);
  for (const key of ['hardware_verified', 'acquisition_available', 'eligible', 'configuration_verified']) {
    assert.equal(output[key], false, key);
  }
  return { ...result, output };
}

test('listed converter examples pin values, byte preservation and diagnostic outcomes', () => {
  const listed = run(['--list']);
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.output.examples.map(item => item.name), examples.map(item => item.name));
  for (const example of examples) {
    assert.ok(['synthetic', 'vendor_example'].includes(example.evidence));
    assert.ok(example.source && example.transformation);
    const result = run(['--example', example.name]);
    assert.equal(result.status, example.expected.ok ? 0 : 1, example.name);
    for (const [key, expected] of Object.entries(example.expected)) {
      const actual = key === 'text' ? result.output.records[0].text
        : key === 'values' ? result.output.exchange.values : result.output[key];
      assert.deepEqual(actual, expected, example.name + ':' + key);
    }
    if (example.input.operation === 'exchange') assert.equal(result.output.bindings_verified, false);
  }
});

test('vendor log bytes remain exact through file mode outside the repository', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-converter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  fs.writeFileSync(file, JSON.stringify(examples[0].input));
  const result = run([file], directory);
  assert.equal(result.status, 0);
  assert.deepEqual(result.output.raw_bytes, examples[0].input.input.bytes);
  assert.equal(result.output.header.battery_mv, 3204);
  assert.equal(result.output.records[0].offset, 3);
  assert.equal(result.output.records[0].length, 13);
});

test('CLI refuses malformed envelopes, oversized files, nonregular input and unknown usage', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-converter-errors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  for (const input of [null, [], {}, { operation: 'send', input: {} },
    { ...examples[0].input, extra: true }, { operation: 'frame', input: {} }]) {
    fs.writeFileSync(file, JSON.stringify(input));
    const result = run([file]);
    assert.equal(result.status, 1);
    assert.equal(result.output.ok, false);
    assert.ok(result.stdout.length < 500);
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

test('raw inspection preserves DEL and split markers that the shipped codec loses', () => {
  const { inspectFrame } = require('./lib/sdi12-converter-lab');
  const source = fs.readFileSync(path.join(__dirname,
    '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js'), 'utf8');
  const sandbox = {};
  new vm.Script(source).runInNewContext(sandbox);
  const configuration = examples[0].input.input.configuration;
  const bytes = [12,132,1,241,4,48,127,13,10];
  const raw = inspectFrame({ fport: 2, bytes, configuration });
  assert.equal(raw.ok, true);
  assert.deepEqual(raw.records[0].bytes, [48,127,13,10]);
  assert.equal(raw.records[0].text, '0\x7f\r\n');
  assert.equal(sandbox.decodeUplink({ fPort: 2, bytes }).data.data_sum, '0\r\n');
  const fragmentBytes = [12,132,2,2,0,241];
  const fragment = inspectFrame({ fport: 2, bytes: fragmentBytes,
    configuration: { ...configuration, dataup: 1, payver: 2 } });
  assert.equal(fragment.disposition, 'fragment');
  assert.deepEqual(fragment.body_bytes, [241]);
  assert.equal(fragment.records, undefined);
  assert.equal(sandbox.decodeUplink({ fPort: 2, bytes: fragmentBytes }).data.data_sum, '');
});
