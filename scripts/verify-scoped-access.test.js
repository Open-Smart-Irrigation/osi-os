'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ALLOWLIST,
  PHASE_C_PENDING,
  findFailures,
  verifyProfiles,
} = require('./verify-scoped-access');

const ROOT = path.resolve(__dirname, '..');
const PROFILE =
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';

function loadFlows() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, PROFILE), 'utf8'));
}

test('maintained profiles satisfy the scoped-access ratchet', () => {
  assert.deepEqual(verifyProfiles(), []);
});

test('new unguarded HTTP endpoint fails the ratchet', () => {
  const flows = loadFlows();
  flows.push({
    id: 'ratchet-negative-http',
    type: 'http in',
    method: 'get',
    url: '/api/ratchet-negative',
    wires: [['ratchet-negative-fn']],
  });
  flows.push({
    id: 'ratchet-negative-fn',
    type: 'function',
    func: 'return msg;',
    wires: [[]],
  });

  assert.match(
    findFailures(flows, 'mutation').join('\n'),
    /ratchet-negative-http.*has no scope call/
  );
});

test('removing the scope call from a guarded chain fails the ratchet', () => {
  const flows = loadFlows();
  const route = flows.find((node) => node.id === 'sync-state-http');
  assert.ok(route, 'sync-state-http fixture exists');

  const byId = new Map(flows.map((node) => [node.id, node]));
  const guardId = route.wires.flat()[0];
  const guard = byId.get(guardId);
  assert.ok(guard, 'sync state guard exists');
  guard.func = guard.func.replace("osiLib.require('scope')", 'undefined');

  assert.match(
    findFailures(flows, 'mutation').join('\n'),
    /sync-state-http.*has no scope call/
  );
});

test('public endpoint exemption is exact and remove-one controlled', () => {
  const flows = loadFlows();
  const withoutLogin = new Set(ALLOWLIST);
  withoutLogin.delete('auth-login-http');

  assert.match(
    findFailures(flows, 'mutation', withoutLogin).join('\n'),
    /auth-login-http.*has no scope call/
  );
});

test('Phase C debt is empty and provisioning remains guarded', () => {
  const flows = loadFlows();
  assert.deepEqual([...PHASE_C_PENDING], []);
  const route = flows.find((node) => node.id === 'post-devices-http');
  assert.ok(route, 'post-devices-http fixture exists');
  const byId = new Map(flows.map((node) => [node.id, node]));
  const guard = byId.get(route.wires.flat()[0]);
  assert.ok(guard, 'device provisioning guard exists');
  guard.func = guard.func.replace("osiLib.require('scope')", 'undefined');

  assert.match(
    findFailures(flows, 'mutation', ALLOWLIST).join('\n'),
    /post-devices-http.*has no scope call/
  );
});

test('umbrella verifier and workflow pin the scoped-access command', () => {
  const umbrella = fs.readFileSync(path.join(ROOT, 'scripts/verify-sync-flow.js'), 'utf8');
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/verify-sync-flow.yml'),
    'utf8'
  );
  assert.match(umbrella, /verify-scoped-access\.js/);
  assert.match(workflow, /name: Scoped-access endpoint ratchet[\s\S]*node scripts\/verify-scoped-access\.js/);
});
