'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, 'replay-sdi12-transport.js');
const examples = require('./fixtures/device-integration/sdi12/transport-scenarios.json');

function run(args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd });
  assert.equal(result.stderr, '', result.stderr);
  return { ...result, report: JSON.parse(result.stdout) };
}
function unqualified(report) {
  assert.equal(report.hardware_verified, false);
  assert.equal(report.acquisition_available, false);
  assert.equal(report.eligible, false);
}

test('list exposes every named scenario and its limitation', () => {
  const { status, report } = run(['--list']);
  assert.equal(status, 0);
  unqualified(report);
  assert.deepEqual(report.examples, examples.map(({ name, description }) => ({ name, description })));
});

test('named scenarios reproduce pinned legacy and candidate outcomes through the CLI', () => {
  for (const example of examples) {
    const { status, report } = run(['--example', example.name]);
    assert.equal(status, 0, example.name);
    assert.equal(report.ok, true);
    assert.equal(report.name, example.name);
    assert.equal(report.evidence_kind, 'synthetic');
    unqualified(report);
    assert.deepEqual(report.results.map(row => row.legacy.action), example.expected_legacy_actions, example.name);
    assert.deepEqual(report.results.map(row => row.candidate.action), example.expected_candidate_actions, example.name);
    if (example.expected_candidate_ascii) {
      assert.equal(report.results.at(-1).candidate.ascii, example.expected_candidate_ascii, example.name);
    }
  }
});

test('JSON file replay works outside the repository and preserves raw bytes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-transport-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = examples.find(example => example.name === 'mixed-cycle-gap').input;
  const file = path.join(directory, 'capture.json');
  fs.writeFileSync(file, JSON.stringify(input));
  const { status, report } = run([file], directory);
  assert.equal(status, 0);
  assert.deepEqual(report.results[0].raw_bytes, [...Buffer.from(input.events[0].event.data, 'base64')]);
  assert.equal(report.results[1].legacy.ascii, '+10+40');
  assert.equal(report.results[1].candidate.action, 'rejected');
  unqualified(report);
});

test('PAYVER and DATAUP mismatches cannot qualify through the legacy convention', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-layout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  const wrongLayouts = [
    [12, 228, 2, ...Buffer.from('+10')], // DATAUP 0 body, PAYVER 2.
    [12, 228, 1, 2, 0, ...Buffer.from('+10')], // DATAUP 1 body, PAYVER 1.
  ];
  for (const bytes of wrongLayouts) {
    const input = structuredClone(examples.find(example => example.name === 'single').input);
    input.events[0].event.data = Buffer.from(bytes).toString('base64');
    fs.writeFileSync(file, JSON.stringify(input));
    const { status, report } = run([file], directory);
    assert.equal(status, 0);
    assert.equal(report.results[0].candidate.action, 'rejected');
    unqualified(report);
  }
});

test('usage, file, JSON, size and scenario errors produce bounded failures', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-transport-errors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const invalid = path.join(directory, 'invalid.json');
  const malformed = path.join(directory, 'malformed.json');
  const oversized = path.join(directory, 'oversized.json');
  fs.writeFileSync(invalid, '{');
  fs.writeFileSync(malformed, JSON.stringify({ name: 'secret-payload-not-for-errors', events: [] }));
  fs.writeFileSync(oversized, ' '.repeat(1024 * 1024 + 1));
  for (const args of [[], ['--send'], ['--example', 'missing'], ['--list', 'extra'],
    [path.join(directory, 'missing.json')], [invalid], [malformed], [oversized]]) {
    const { status, report, stdout } = run(args);
    assert.equal(status, 1, JSON.stringify(args));
    assert.equal(report.ok, false);
    assert.equal(typeof report.code, 'string');
    assert.ok(stdout.length < 400);
    assert.doesNotMatch(stdout, /secret-payload-not-for-errors/);
    unqualified(report);
  }
});
