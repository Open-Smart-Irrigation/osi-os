'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { checkSource, checkFlows, discoverFlowFiles, sourceHash } = require('./verify-flows-sandbox');

const root = path.resolve(__dirname, '..');
const canonical = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

test('all repository variants have no unexcepted sandbox identifiers', () => {
  const files = discoverFlowFiles();
  assert.ok(files.length >= 3);
  for (const file of files) {
    const result = checkFlows(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.ok(result.functionNodes > 0, file);
    assert.deepEqual(result.failures, [], file);
  }
});

test('uses the VM sandbox rather than host Node globals', () => {
  for (const identifier of ['crypto', 'require', 'URL', 'fetch', 'process', 'structuredClone', 'setImmediate']) {
    const findings = checkSource(`return ${identifier};`, 'func');
    assert.equal(findings.length, 1, identifier);
    assert.equal(findings[0].message, `'${identifier}' is not defined.`);
  }
  assert.deepEqual(checkSource('return [Buffer, Date, console, util, RED, context, flow, global, env,\n' +
    'setTimeout, clearTimeout, setInterval, clearInterval, promisify, Intl, Promise, Map, JSON, globalThis];', 'func'), []);
});

test('checks lexical scope, closures and each node\'s own declared modules', () => {
  const good = { type: 'function', id: 'bound', libs: [{ var: 'crypto', module: 'crypto' }],
    func: 'const { randomUUID } = crypto; function make(){ return randomUUID(); } return {payload: make()};' };
  assert.deepEqual(checkFlows([good], []).failures, []);
  const bad = { type: 'function', id: 'unbound', func: 'return crypto.randomUUID();' };
  assert.equal(checkFlows([good, bad], []).failures[0].id, 'unbound');
  assert.equal(checkSource('try { const value = 1; } catch (e) {} return value;', 'func').length, 1);
  assert.deepEqual(checkSource('const value = { missing: "missing" }; return value.missing;', 'func'), []);
});

test('checks setup and close independently with their actual wrapper names', () => {
  const result = checkFlows([{ id: 'three-fields', type: 'function',
    func: 'return missingBody;', initialize: 'await missingSetup();', finalize: 'missingClose();' }], []);
  assert.deepEqual(result.failures.map((f) => f.field), ['func', 'initialize', 'finalize']);
  assert.deepEqual(checkSource('node.send(msg); __done__();', 'func'), []);
  assert.deepEqual(checkSource('node.send({}); await Promise.resolve();', 'initialize'), []);
  assert.deepEqual(checkSource('node.log("closed");', 'finalize'), []);
  for (const field of ['initialize', 'finalize']) {
    assert.equal(checkSource('node.log(msg);', field).length, 1);
  }
  assert.ok(checkSource('await Promise.resolve();', 'finalize')[0].fatal);
  assert.equal(checkFlows([{ type: 'function', func: 'const value = 1;', finalize: 'node.log(value);' }], []).failures.length, 1);
});

test('typeof probes are safe but uses and inline suppression comments are checked', () => {
  assert.deepEqual(checkSource('return typeof optionalApi;', 'func'), []);
  assert.equal(checkSource('if (typeof URL === "function") return new URL("https://example.invalid");', 'func').length, 1);
  const findings = checkSource('/* eslint-disable no-undef */\nreturn crypto;', 'func');
  assert.ok(findings.some((f) => f.ruleId === 'no-undef'));
});

test('exceptions match exact node, field, identifier, location and complete source hash', () => {
  const node = { id: 'reviewed', type: 'function', func: 'return missing;' };
  const exception = { id: node.id, field: 'func', identifier: 'missing', locations: [[1, 8]],
    sha256: sourceHash(node.func), reason: 'Synthetic reviewed fixture' };
  assert.deepEqual(checkFlows([node], [exception]).failures, []);
  for (const changed of [
    { ...node, id: 'other' },
    { ...node, func: node.func + '\nmissing();' },
    { ...node, func: 'return 1;' },
    { ...node, func: 'return missingOther;' },
    { ...node, initialize: node.func },
  ]) assert.ok(checkFlows([changed], [exception]).failures.length > 0);
  assert.ok(checkFlows([node], [{ ...exception, locations: [[2, 8]] }]).failures.length > 0);
});

test('new flow variants are discovered without changing a hardcoded profile list', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sandbox-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', temp]);
  const file = path.join(temp, 'new-profile', 'flows.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '[]');
  assert.deepEqual(discoverFlowFiles(temp), [file]);
});

test('CLI fails on unknown identifiers and malformed or missing inputs', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sandbox-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'flows.json');
  const cli = path.join(__dirname, 'verify-flows-sandbox.js');
  fs.writeFileSync(file, JSON.stringify([{ id: 'bad', name: 'Bad fixture', type: 'function', func: 'return crypto;' }]));
  const bad = spawnSync(process.execPath, [cli, '--flows', file], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /bad.*crypto.*not defined/);
  fs.writeFileSync(file, '{');
  assert.equal(spawnSync(process.execPath, [cli, '--flows', file]).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, '--flows', file + '.absent']).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, '--typo']).status, 1);
});

test('removing crypto bindings reproduces all nine reported nodes', () => {
  const flows = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  const ids = ['delete-device-unlink', 'delete-zone-unassign', 'assign-device-update',
    'unassign-device-update', 'scoped-device-assign-router', 'scoped-device-unassign-router',
    'scoped-device-delete-router', 'conditional-legacy-schedule-adapter', 'conditional-lifecycle-command-adapter'];
  for (const node of flows) {
    if (ids.includes(node.id)) node.libs = node.libs.filter((lib) => lib.var !== 'crypto');
  }
  const failures = checkFlows(flows).failures;
  assert.deepEqual([...new Set(failures.map((f) => f.id))].sort(), ids.sort());
  assert.ok(failures.every((f) => f.message === "'crypto' is not defined."));
});
