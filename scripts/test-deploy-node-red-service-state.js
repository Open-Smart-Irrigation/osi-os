#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const deploy = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
const begin = '# node-red service state begin';
const end = '# node-red service state end';

function serviceStateFragment() {
  const start = deploy.indexOf(begin);
  const finish = deploy.indexOf(end);
  assert.ok(start >= 0 && finish > start, 'deploy.sh must expose the service-state helper between stable markers');
  return deploy.slice(start + begin.length, finish);
}

function healthWaitFragment() {
  const healthBegin = '# node-red health wait begin';
  const healthEnd = '# node-red health wait end';
  const start = deploy.indexOf(healthBegin);
  const finish = deploy.indexOf(healthEnd);
  assert.ok(start >= 0 && finish > start, 'deploy.sh must expose the health wait between stable markers');
  return deploy.slice(start + healthBegin.length, finish);
}

function stopWaitFragment() {
  const stopBegin = '# node-red stop wait begin';
  const stopEnd = '# node-red stop wait end';
  const start = deploy.indexOf(stopBegin);
  const finish = deploy.indexOf(stopEnd);
  assert.ok(start >= 0 && finish > start, 'deploy.sh must expose the stop wait between stable markers');
  return deploy.slice(start + stopBegin.length, finish);
}

function runState({ json = '{}', ubusExit = 0 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-node-red-state-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    const ubus = path.join(bin, 'ubus');
    fs.writeFileSync(ubus, `#!/bin/sh\ncat <<'JSON'\n${json}\nJSON\nexit ${ubusExit}\n`);
    fs.chmodSync(ubus, 0o755);
    const script = `set -eu\n${serviceStateFragment()}\nrc=0\nnode_red_service_state || rc=$?\nexit "$rc"\n`;
    return spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('named procd service with a running instance reports running', () => {
  const result = runState({
    json: JSON.stringify({ 'node-red': { instances: { instance1: { running: true } } } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'running');
});

test('successful procd query without the named service reports stopped', () => {
  const result = runState({ json: '{}' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'stopped');
});

test('stopped named instance reports stopped regardless of unrelated process names or stale pids', () => {
  const result = runState({
    json: JSON.stringify({ 'node-red': { instances: { instance1: { running: false, pid: 4242 } } } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'stopped');
  assert.doesNotMatch(deploy, /pgrep\s+-f\s+['"]node-red['"]/, 'deploy gates must not search unrelated command lines');
});

test('unavailable service manager reports unknown and fails closed', () => {
  const result = runState({ ubusExit: 1 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), 'unknown');
});

test('ambiguous procd state reports unknown and fails closed', () => {
  const result = runState({
    json: JSON.stringify({ 'node-red': { instances: { instance1: { running: 'true' } } } }),
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), 'unknown');
});

for (const malformed of ['[]', 'true', '"text"', '{"node-red":{"instances":[]}}']) {
  test(`malformed procd shape fails closed: ${malformed}`, () => {
    const result = runState({ json: malformed });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), 'unknown');
  });
}

test('migration stop and local health gates consume the named service state', () => {
  const stop = deploy.indexOf('/etc/init.d/node-red stop');
  const stopProbe = deploy.indexOf('wait_for_node_red_stop "$NODE_RED_STOP_TIMEOUT"', stop);
  const checkpoint = deploy.indexOf('if ! checkpoint_live_db; then', stop);
  const health = deploy.indexOf('--- Flip payload + local health self-check');
  const healthCall = deploy.indexOf('wait_for_node_red_health "$NODE_RED_HEALTH_TIMEOUT"', health);
  const healthWait = healthWaitFragment();
  const healthProbe = healthWait.indexOf('node_red_state="$(node_red_service_state)"');
  const guiProbe = healthWait.indexOf('127.0.0.1:1880/gui');
  assert.ok(stop < stopProbe && stopProbe < checkpoint, 'migration stop must prove named service state before checkpointing');
  assert.ok(healthCall > health, 'local health block must call the bounded wait helper');
  assert.ok(healthProbe >= 0 && healthProbe < guiProbe, 'local health must prove named service state before probing /gui');
  assert.match(deploy, /could not determine Node-RED service state/);
});

function runHealth({ readyOnProbe, timeout, state = 'running' }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-node-red-health-'));
  try {
    const bin = path.join(temp, 'bin');
    const count = path.join(temp, 'count');
    fs.mkdirSync(bin);
    fs.writeFileSync(count, '0\n');
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, 'sleep'), 0o755);
    fs.writeFileSync(path.join(bin, 'wget'), `#!/bin/sh\ncount=$(cat '${count}')\ncount=$((count + 1))\nprintf '%s\\n' "$count" > '${count}'\n[ "$count" -ge ${readyOnProbe} ]\n`);
    fs.chmodSync(path.join(bin, 'wget'), 0o755);
    const stateFunction = state === 'unknown'
      ? 'node_red_service_state() { echo unknown; return 2; }'
      : `node_red_service_state() { echo ${state}; }`;
    const script = `set -eu\n${healthWaitFragment()}\n${stateFunction}\nrc=0\nwait_for_node_red_health ${timeout} || rc=$?\nprintf 'rc=%s elapsed=%s state=%s\\n' "$rc" "$probe_elapsed" "$node_red_state"\nexit "$rc"\n`;
    return spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function runStop({ states, timeout }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-node-red-stop-'));
  try {
    const bin = path.join(temp, 'bin');
    const count = path.join(temp, 'count');
    const stateFile = path.join(temp, 'states');
    fs.mkdirSync(bin);
    fs.writeFileSync(count, '0\n');
    fs.writeFileSync(stateFile, `${states.join('\n')}\n`);
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, 'sleep'), 0o755);
    const script = `set -eu\n${stopWaitFragment()}\nnode_red_service_state() {\n  count=$(cat '${count}')\n  count=$((count + 1))\n  printf '%s\\n' "$count" > '${count}'\n  state=$(sed -n "${'$'}{count}p" '${stateFile}')\n  [ -n "$state" ] || state=$(tail -n 1 '${stateFile}')\n  [ "$state" != unknown ] || { echo unknown; return 2; }\n  echo "$state"\n}\nrc=0\nwait_for_node_red_stop ${timeout} || rc=$?\nprintf 'rc=%s elapsed=%s state=%s\\n' "$rc" "$stop_wait" "$node_red_state"\nexit "$rc"\n`;
    return spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('stop wait follows the named service from running to stopped', () => {
  const result = runStop({ states: ['running', 'running', 'stopped'], timeout: 30 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 elapsed=2 state=stopped/);
});

test('stop wait fails closed on unknown state', () => {
  const result = runStop({ states: ['unknown'], timeout: 30 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /rc=2 elapsed=0 state=unknown/);
});

test('stop wait fails after its bound while the service stays running', () => {
  const result = runStop({ states: ['running'], timeout: 3 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /rc=1 elapsed=3 state=running/);
});

test('health wait accepts readiness within five seconds', () => {
  const result = runHealth({ readyOnProbe: 3, timeout: 30 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 elapsed=2 state=running/);
});

test('health wait accepts readiness after the old five-second window', () => {
  const result = runHealth({ readyOnProbe: 8, timeout: 30 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rc=0 elapsed=7 state=running/);
});

test('health wait fails at its configured timeout', () => {
  const result = runHealth({ readyOnProbe: 99, timeout: 3 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /rc=1 elapsed=3 state=running/);
});

test('health wait fails immediately when service identity is unavailable', () => {
  const result = runHealth({ readyOnProbe: 1, timeout: 30, state: 'unknown' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /rc=2 elapsed=0 state=unknown/);
});
