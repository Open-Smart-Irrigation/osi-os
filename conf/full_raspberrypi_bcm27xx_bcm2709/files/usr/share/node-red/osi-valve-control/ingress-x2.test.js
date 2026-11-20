'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '../../../../../../..');
const VC = require('./index');
const baseline = require(path.join(ROOT, 'scripts/fixtures/valve-ingress-x2/baseline.json'));
const { cases, ROUTER, AUTH } = require(path.join(ROOT, 'scripts/lib/valve-ingress-x2-cases'));
const { environment, execute } = require(path.join(ROOT, 'scripts/lib/valve-ingress-x2-harness'));
const manifestPath = path.join(ROOT, 'scripts/fixtures/valve-ingress-x2/adapters.json');

test('X2 exposes all thirteen request/router/log entry points beside existing dispatch APIs', () => {
  for (const name of ['routeCommand','authenticateValveCommand','checkValveOwnership','buildValveCommand','cancelValveRequest','parseStregaIntervalRequest','parseStregaModelRequest','parseStregaTimedRequest','parseStregaMagnetRequest','parseStregaPartialRequest','parseStregaFlushRequest','formatStregaResponse','buildActuatorLog','executeValveAttempt','cancelActuation','cancelHttpResponse']) assert.equal(typeof VC[name], 'function', name);
});

test('copied bodies stay verbatim; the router splits only whole top-level branches', () => {
  const manifest = require(manifestPath);
  for (const patch of manifest.nodes) {
    const original = baseline.nodes.find(node => node.id === patch.id).func;
    const source = VC[patch.entry].toString();
    if (patch.id !== ROUTER) assert.ok(source.includes(original), patch.entry + ': body changed');
    else {
      const nonValve = require('./command-routing').routeNonValveCommand.toString();
      const branches = [...original.matchAll(/^if \([\s\S]*?^\}/gm)].map(match => match[0]);
      assert.equal(branches.length, 22, 'every original top-level branch is accounted for');
      for (const branch of branches) assert.equal(Number(source.includes(branch)) + Number(nonValve.includes(branch)), 1, 'branch copied once: ' + branch.slice(0, 70));
    }
  }
});

test('manual builder defers success, keeps HTTP handles on top, and writes no log or target state', async () => {
  const tc = cases().find(entry => entry.name === 'build/valid');
  const state = environment(tc, __dirname);
  const outputs = await VC.buildValveCommand(state.msg, state.deps);
  assert.equal(outputs.length, 3);
  const command = outputs[0];
  assert.deepEqual(outputs.slice(1), [null, null]);
  assert.equal(command.req, state.originalReq);
  assert.equal(command.res, state.originalRes);
  assert.equal(command._stregaHttpResponse.req, undefined);
  assert.equal(command._stregaHttpResponse.res, undefined);
  assert.equal(command._stregaHttpResponse.statusCode, 202);
  assert.equal(command._stregaHttpResponse._stregaDeferredSuccess, true);
  assert.deepEqual(state.effects.map(effect => effect[0]), ['uuid']);
  assert.equal(command.payload.data.action, 'OPEN_FOR_DURATION');
  assert.equal(command.payload.data.duration_minutes, 2);
});

test('router preserves duration precedence, actor propagation, port lengths and exact rejection ACK text', () => {
  const input = cases().find(entry => entry.name === 'route/duration-precedence');
  const state = environment(input, __dirname);
  const outputs = VC.routeCommand(state.msg, state.deps);
  assert.equal(outputs.length, 5);
  assert.equal(outputs[0]._actorUserUuid, 'actor-1');
  assert.equal(outputs[0].payload.data.duration_minutes, 2);
  assert.equal(outputs[0].payload.data.appliedSyncVersion, 0);
  const denied = environment(cases().find(entry => entry.name === 'route/valve-close-refused'), __dirname);
  const result = VC.routeCommand(denied.msg, denied.deps);
  assert.equal(result.length, 5);
  assert.deepEqual(result.map(Boolean), [false,false,true,false,false]);
  assert.equal(result[2].qos, 1);
  assert.equal(JSON.parse(result[2].payload).reason, 'valve_action_not_allowed');
});

test('concurrent manual requests retain separate request context', async () => {
  const tc = cases().find(entry => entry.id === AUTH && entry.name === 'manual/valid');
  const first = environment(tc, __dirname), second = environment(tc, __dirname);
  second.msg._msgid = 'request-2'; second.msg.payload.duration_minutes = 9;
  const [a, b] = await Promise.all([VC.authenticateValveCommand(first.msg, first.deps), VC.authenticateValveCommand(second.msg, second.deps)]);
  assert.equal(a[0].osi.request.requestId, 'request-1');
  assert.equal(b[0].osi.request.requestId, 'request-2');
  assert.equal(a[0].osi.request.durationMinutes, 2);
  assert.equal(b[0].osi.request.durationMinutes, 9);
});

test('a missing outer module returns exactly one HTTP refusal and never invokes a command entry', async () => {
  const manifest = require(manifestPath);
  for (const patch of manifest.nodes.filter(node => !['routeCommand','buildActuatorLog'].includes(node.entry))) {
    const tc = cases().find(entry => entry.id === patch.id);
    const modified = { ...tc, options: { ...tc.options } };
    const out = await execute({ ...baseline.nodes.find(node => node.id === patch.id), ...patch.replacement }, modified, __dirname, (node, deps) => {
      deps.osiLib = { require() { return { ok: false, error: 'fixture module absent' }; } };
      return new Function(...Object.keys(deps), node.func)(...Object.values(deps));
    });
    assert.equal(out.error, null, patch.entry);
    const messages = (Array.isArray(out.value) ? out.value : [out.value]).filter(Boolean);
    assert.equal(messages.length, 1, patch.entry);
    assert.equal(messages[0].statusCode, patch.entry === 'cancelValveRequest' ? 500 : 503);
    assert.deepEqual(out.effects.map(effect => effect[0]), ['error']);
    assert.deepEqual(out.effects[0][2], { $undefined: true }, 'logging must not also send msg into the HTTP catch lane');
  }
});

test('auth retains the legacy directive mode when a message property cannot be deleted', async () => {
  const tc = cases().find(entry => entry.name === 'manual/valid');
  const original = baseline.nodes.find(node => node.id === AUTH);
  const expected = environment(tc, __dirname), actual = environment(tc, __dirname);
  for (const state of [expected, actual]) Object.defineProperty(state.msg, '_osiAuthFailure', { value: 'legacy-marker', writable: true, configurable: false, enumerable: true });
  const fn = require('node:vm').runInNewContext('(function (' + Object.keys(expected.deps).join(',') + ') {\n' + original.func + '\n})');
  const before = await fn(...Object.values(expected.deps));
  const after = await VC.authenticateValveCommand(actual.msg, actual.deps);
  assert.deepEqual(after[0].osi, JSON.parse(JSON.stringify(before[0].osi)));
  assert.equal(after[0]._osiAuthFailure, 'legacy-marker');
});

test('adapter handoff refuses changed source, ports, wiring and libs without mutating input', () => {
  const { adaptFlows } = require(path.join(ROOT, 'scripts/lib/valve-ingress-x2-adapters'));
  const flowFile = path.join(__dirname, '../../flows.json');
  const flows = JSON.parse(fs.readFileSync(flowFile));
  const original = JSON.stringify(flows);
  const adapted = adaptFlows(flows);
  assert.equal(JSON.stringify(flows), original);
  assert.equal(adapted.length, flows.length);
  for (const field of ['func','wires','outputs','libs']) {
    const changed = JSON.parse(original);
    const node = changed.find(node => node.id === AUTH);
    node[field] = field === 'func' ? node[field] + '\n// changed' : field === 'outputs' ? 4 : [];
    assert.throws(() => adaptFlows(changed), /changed/);
  }
});
