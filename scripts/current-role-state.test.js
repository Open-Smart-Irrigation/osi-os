'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const roleState = require('./current-role-state');

const helper = path.join(__dirname, 'current-role-state.js');
const boundary = path.join('/tmp', `osi-factory-zero-tests-${process.getuid()}`);
const roleLinks = {
  'osi-identityd': ['/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd'],
  'node-red': ['/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red'],
  'osi-bootstrap': ['/etc/rc.d/S99osi-bootstrap'],
  'osi-db-integrity': ['/etc/rc.d/S90osi-db-integrity'],
};
const generation = { 'osi-identityd': 3, 'node-red': 5, 'osi-bootstrap': 2, 'osi-db-integrity': 4 };
const roles = Object.fromEntries(Object.entries(generation).map(([role, value]) => [role, {
  running: false, ready: false, pid: null, processStartTime: null, generation: value, bootId: 'test-boot',
  rcLinks: roleLinks[role].map((linkPath) => ({ path: linkPath, state: 'absent' })),
}]));
function run(snapshot) {
  return cp.spawnSync(helper, ['--json'], { encoding: 'utf8', env: {
    ...process.env, OSI_REPAIR_PROGRAM_MODE: '1', OSI_DEPLOY_ARTIFACT_MODE: 'test',
    OSI_CURRENT_ROLE_STATE_TEST_SNAPSHOT: snapshot,
  } });
}

test('production current-role-state dependency validates and emits the exact role contract', () => {
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 }); fs.chmodSync(boundary, 0o700);
  const d = fs.mkdtempSync(path.join(boundary, 'role-state-'));
  const snapshot = path.join(d, 'snapshot.json');
  fs.writeFileSync(snapshot, JSON.stringify({ format: 1, bootId: 'test-boot', roles }), { mode: 0o600 });
  const result = run(snapshot);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { format: 1, bootId: 'test-boot', roles });
});

test('current role-state represents running and readiness independently but never reports stopped as ready', () => {
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 }); fs.chmodSync(boundary, 0o700);
  const d = fs.mkdtempSync(path.join(boundary, 'role-ready-shape-'));
  const snapshot = path.join(d, 'snapshot.json');
  const runningNotReady = structuredClone(roles);
  runningNotReady['node-red'] = {
    ...runningNotReady['node-red'], running: true, ready: false, pid: 4242, processStartTime: '98765',
  };
  fs.writeFileSync(snapshot, JSON.stringify({ format: 1, bootId: 'test-boot', roles: runningNotReady }), { mode: 0o600 });
  const accepted = run(snapshot);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).roles['node-red'].ready, false);

  const stoppedReady = structuredClone(roles);
  stoppedReady['node-red'].ready = true;
  fs.writeFileSync(snapshot, JSON.stringify({ format: 1, bootId: 'test-boot', roles: stoppedReady }), { mode: 0o600 });
  const rejected = run(snapshot);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /current role-state entry is invalid: node-red/);
});

test('current-role-state test input is confined and rejects symlinks', () => {
  const outside = path.join('/tmp', `role-state-outside-${process.getuid()}.json`);
  fs.writeFileSync(outside, JSON.stringify({ format: 1, bootId: 'test-boot', roles }), { mode: 0o600 });
  assert.notEqual(run(outside).status, 0);
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 }); fs.chmodSync(boundary, 0o700);
  const link = path.join(boundary, 'role-state-link.json');
  fs.rmSync(link, { force: true }); fs.symlinkSync(outside, link);
  assert.notEqual(run(link).status, 0);
});

test('lifecycle generation advances across start then stop even when the procd response is identical', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-generation-'));
  const generationRoot = path.join(d, 'generations');
  const bootId = '11111111-1111-4111-8111-111111111111';
  const stopped = { instances: {} };
  const queryRole = () => stopped;
  roleState.recordRoleStart('node-red', { bootId, generationRoot });
  for (const role of roleState.ROLES.filter((name) => name !== 'node-red')) {
    roleState.recordRoleStart(role, { bootId, generationRoot });
  }
  const before = roleState.productionState({ bootId, generationRoot, queryRole });
  roleState.recordRoleStart('node-red', { bootId, generationRoot });
  const afterStartAndStop = roleState.productionState({ bootId, generationRoot, queryRole });
  assert.deepEqual(before.roles['node-red'], {
    running: false, ready: false, pid: null, processStartTime: null, generation: 1, bootId,
    rcLinks: roleLinks['node-red'].map((linkPath) => ({ path: linkPath, state: 'absent' })),
  });
  assert.deepEqual(afterStartAndStop.roles['node-red'], { ...before.roles['node-red'], generation: 2 });
  assert.equal(roleState.generationFor, undefined, 'response hashing is not a generation authority');
});

test('role readiness invokes only the pinned shipped daemon health contracts', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: command === '/etc/init.d/osi-identityd' ? 0 : 1 };
  };
  assert.equal(roleState.queryRoleReady('osi-identityd', { spawn }), true);
  assert.equal(roleState.queryRoleReady('node-red', { spawn }), false);
  assert.equal(roleState.queryRoleReady('osi-bootstrap', { spawn }), false);
  assert.equal(roleState.queryRoleReady('osi-db-integrity', { spawn }), false);
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: '/etc/init.d/osi-identityd', args: ['ready'] },
    { command: '/bin/wget', args: ['-q', '-T', '3', '-Y', 'off', '-O', '/dev/null', '--spider', 'http://127.0.0.1:1880/gui'] },
  ]);
  for (const { options } of calls) {
    assert.deepEqual(options.env, { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' });
    assert.equal(options.timeout, 5000);
  }
  assert.equal(roleState.queryRoleReady('node-red', { spawn: () => ({ status: null, error: new Error('timeout') }) }), false);
  assert.equal(roleState.queryRoleReady('node-red', { spawn: () => { throw new Error('adapter missing'); } }), false);
});

test('the pinned Node-RED readiness path is backed by both image profiles and the shipped health contract', () => {
  for (const profile of ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709']) {
    const config = fs.readFileSync(path.join(__dirname, '..', 'conf', profile, '.config'), 'utf8');
    assert.match(config, /^CONFIG_PACKAGE_uclient-fetch=y$/m, `${profile} must provide /bin/wget`);
  }
  const deploy = fs.readFileSync(path.join(__dirname, '..', 'deploy.sh'), 'utf8');
  assert.match(deploy, /wget -q -O \/dev\/null --spider "http:\/\/127\.0\.0\.1:1880\/gui"/);
});

test('production role state binds one ready process to exact PID/starttime and all six canonical rc links', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-process-'));
  const generationRoot = path.join(d, 'generations');
  const liveRoot = path.join(d, 'root');
  const procRoot = path.join(d, 'proc');
  const bootId = '11111111-1111-4111-8111-111111111111';
  for (const role of roleState.ROLES) roleState.recordRoleStart(role, { bootId, generationRoot });
  for (const [role, links] of Object.entries(roleLinks)) {
    for (const linkPath of links) {
      const full = path.join(liveRoot, linkPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.symlinkSync(`../init.d/${role}`, full);
    }
  }
  fs.mkdirSync(path.join(procRoot, '4242'), { recursive: true });
  fs.writeFileSync(path.join(procRoot, '4242/stat'), `4242 (node red) S ${Array(18).fill('0').join(' ')} 98765 0\n`);
  const state = roleState.productionState({ bootId, generationRoot, liveRoot, procRoot,
    queryRole: (role) => role === 'node-red'
      ? { 'node-red': { instances: { instance1: { running: true, pid: 4242 } } } }
      : { [role]: { instances: {} } },
    queryReady: (role) => role === 'node-red',
  });
  assert.equal(state.roles['node-red'].ready, true);
  assert.equal(state.roles['node-red'].pid, 4242);
  assert.equal(state.roles['node-red'].processStartTime, '98765');
  assert.equal(Object.values(state.roles).flatMap((entry) => entry.rcLinks).length, 6);
  assert.ok(Object.values(state.roles).flatMap((entry) => entry.rcLinks).every((entry) => entry.state === 'symlink'));
});

test('production role state keeps a live process running while its role-specific readiness probe is false', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-not-ready-'));
  const generationRoot = path.join(d, 'generations');
  const procRoot = path.join(d, 'proc');
  const bootId = '11111111-1111-4111-8111-111111111111';
  for (const role of roleState.ROLES) roleState.recordRoleStart(role, { bootId, generationRoot });
  fs.mkdirSync(path.join(procRoot, '4242'), { recursive: true });
  fs.writeFileSync(path.join(procRoot, '4242/stat'), `4242 (node red) S ${Array(18).fill('0').join(' ')} 98765 0\n`);
  const state = roleState.productionState({ bootId, generationRoot, procRoot,
    queryRole: (role) => role === 'node-red'
      ? { 'node-red': { instances: { instance1: { running: true, pid: 4242 } } } }
      : { [role]: { instances: {} } },
    queryReady: () => false,
  });
  assert.equal(state.roles['node-red'].running, true);
  assert.equal(state.roles['node-red'].ready, false);
  assert.ok(Object.values(state.roles).filter((entry) => !entry.running).every((entry) => entry.ready === false));
});

test('lifecycle publication resumes exact hardlink debris without counting a second start', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-publication-resume-'));
  const generationRoot = path.join(d, 'generations');
  const bootId = '11111111-1111-4111-8111-111111111111';
  const childScript = [
    `const roleState=require(${JSON.stringify(path.join(__dirname, 'current-role-state.js'))})`,
    `roleState.recordRoleStart('node-red',{bootId:${JSON.stringify(bootId)},generationRoot:${JSON.stringify(generationRoot)},crashHook(boundaryName){if(boundaryName==='after-link')process.kill(process.pid,'SIGKILL')}})`,
  ].join(';');
  const child = cp.spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const roleDir = path.join(generationRoot, 'node-red');
  const debris = fs.readdirSync(roleDir).sort();
  assert.equal(debris.length, 2);
  const temporary = debris.find((name) => name.endsWith('.tmp'));
  const finalName = debris.find((name) => name.endsWith('.json'));
  const tempStat = fs.lstatSync(path.join(roleDir, temporary));
  const finalStat = fs.lstatSync(path.join(roleDir, finalName));
  assert.equal(tempStat.dev, finalStat.dev);
  assert.equal(tempStat.ino, finalStat.ino);

  const synced = [];
  const resumed = roleState.recordRoleStart('node-red', {
    bootId, generationRoot, fsyncDirectory(dir) { synced.push(dir); },
  });
  assert.equal(resumed.token, finalName.slice(0, -5));
  assert.deepEqual(fs.readdirSync(roleDir), [finalName]);
  assert.deepEqual(synced, [roleDir]);
  assert.equal(roleState.roleGeneration('node-red', bootId, generationRoot), 1);
});

test('lifecycle publication resumes a fully fsynced orphan temp after the publisher dies before link', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-publication-before-link-'));
  const generationRoot = path.join(d, 'generations');
  const bootId = '11111111-1111-4111-8111-111111111111';
  const childScript = [
    `const roleState=require(${JSON.stringify(path.join(__dirname, 'current-role-state.js'))})`,
    `roleState.recordRoleStart('node-red',{bootId:${JSON.stringify(bootId)},generationRoot:${JSON.stringify(generationRoot)},crashHook(boundaryName){if(boundaryName==='after-fsync-before-link')process.kill(process.pid,'SIGKILL')}})`,
  ].join(';');
  const child = cp.spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const roleDir = path.join(generationRoot, 'node-red');
  const debris = fs.readdirSync(roleDir).sort();
  assert.equal(debris.length, 1);
  assert.match(debris[0], /^\.[0-9a-f]{32}\.tmp$/);

  const synced = [];
  const resumed = roleState.recordRoleStart('node-red', {
    bootId, generationRoot, fsyncDirectory(dir) { synced.push(dir); },
  });
  const finalName = `${debris[0].slice(1, -4)}.json`;
  assert.equal(resumed.token, finalName.slice(0, -5));
  assert.deepEqual(fs.readdirSync(roleDir), [finalName]);
  assert.deepEqual(synced, [roleDir, roleDir]);
  assert.equal(roleState.roleGeneration('node-red', bootId, generationRoot), 1);
});

test('lifecycle publication treats a reused PID with a different starttime as a dead publisher', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-publication-pid-reuse-'));
  const generationRoot = path.join(d, 'generations');
  const bootId = '11111111-1111-4111-8111-111111111111';
  const roleDir = path.join(generationRoot, 'node-red');
  fs.mkdirSync(roleDir, { recursive: true, mode: 0o700 });
  const token = 'c'.repeat(32);
  const event = {
    format: 1, role: 'node-red', bootId, pid: process.pid, processStartTime: '0', token,
    createdAt: '2026-07-19T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(roleDir, `.${token}.tmp`), `${roleState.canonical(event)}\n`, { mode: 0o600 });
  const resumed = roleState.recordRoleStart('node-red', { bootId, generationRoot });
  assert.equal(resumed.token, token);
  assert.deepEqual(fs.readdirSync(roleDir), [`${token}.json`]);
});

test('lifecycle publication does not steal an exact hardlink from a live publisher', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-publication-live-owner-'));
  const generationRoot = path.join(d, 'generations');
  const bootId = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => roleState.recordRoleStart('node-red', {
    bootId, generationRoot,
    crashHook(boundaryName) { if (boundaryName === 'after-link') throw new Error('publisher still alive'); },
  }), /publisher still alive/);
  assert.throws(
    () => roleState.recordRoleStart('node-red', { bootId, generationRoot }),
    /live publisher/,
  );
});

test('lifecycle publication rejects foreign-inode and tampered temp debris', () => {
  const bootId = '11111111-1111-4111-8111-111111111111';
  const rawEvent = (token) => `${JSON.stringify({
    bootId, createdAt: '2026-07-19T00:00:00.000Z', format: 1, pid: 42, processStartTime: '1', role: 'node-red', token,
  })}\n`;
  for (const kind of ['foreign-inode', 'tampered']) {
    const d = fs.mkdtempSync(path.join(boundary, `role-publication-${kind}-`));
    const generationRoot = path.join(d, 'generations');
    const roleDir = path.join(generationRoot, 'node-red');
    fs.mkdirSync(roleDir, { recursive: true, mode: 0o700 });
    const token = kind === 'tampered' ? 'a'.repeat(32) : 'b'.repeat(32);
    const temporary = path.join(roleDir, `.${token}.tmp`);
    const finalPath = path.join(roleDir, `${token}.json`);
    if (kind === 'tampered') {
      fs.writeFileSync(temporary, '{}\n', { mode: 0o600 });
      fs.linkSync(temporary, finalPath);
    } else {
      fs.writeFileSync(temporary, rawEvent(token), { mode: 0o600 });
      if (kind === 'foreign-inode') fs.writeFileSync(finalPath, rawEvent(token), { mode: 0o600 });
    }
    assert.throws(
      () => roleState.recordRoleStart('node-red', { bootId, generationRoot }),
      /lifecycle publication debris|invalid lifecycle event/,
      kind
    );
    assert.equal(fs.existsSync(temporary), true, `${kind}: unsafe evidence must not be removed`);
  }
});

test('role lifecycle event authority rejects symlinked roots and malformed or foreign-boot records', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-generation-safe-'));
  const bootId = '11111111-1111-4111-8111-111111111111';
  const outside = path.join(d, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  const linked = path.join(d, 'linked');
  fs.symlinkSync(outside, linked);
  assert.throws(() => roleState.recordRoleStart('node-red', { bootId, generationRoot: linked }), /symlink/);

  const generationRoot = path.join(d, 'generations');
  roleState.recordRoleStart('node-red', { bootId, generationRoot });
  const roleDir = path.join(generationRoot, 'node-red');
  fs.writeFileSync(path.join(roleDir, 'malformed.json'), '{}\n', { mode: 0o600 });
  assert.throws(() => roleState.roleGeneration('node-red', bootId, generationRoot), /invalid lifecycle event/);
});

test('production role state fails closed when any lifecycle authority is absent', () => {
  const d = fs.mkdtempSync(path.join(boundary, 'role-generation-absent-'));
  const generationRoot = path.join(d, 'generations');
  const bootId = '11111111-1111-4111-8111-111111111111';
  assert.throws(
    () => roleState.productionState({ bootId, generationRoot, queryRole: () => ({ instances: {} }) }),
    /lifecycle authority is unavailable/
  );
});
