'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const launcher = path.join(__dirname, 'node-red-guarded-launch.js');

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for child fixture'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function tokenProcessPids(token) {
  const pids = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const entries = fs.readFileSync(`/proc/${name}/environ`).toString('utf8').split('\0');
      if (entries.includes(`OSI_DEPLOY_LAUNCH_TOKEN=${token}`)) pids.push(Number(name));
    } catch (_error) {
      // Processes can exit while /proc is being sampled; an absent sample is safe.
    }
  }
  return pids;
}

function fixture(stateExit = 0, childBody = 'setTimeout(() => process.exit(0), 80);', stateBody = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-launch-'));
  const log = path.join(root, 'calls.log');
  const stateCli = path.join(root, 'state-cli.js');
  const child = path.join(root, 'child.js');
  fs.writeFileSync(stateCli, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst log = ${JSON.stringify(log)};\nconst args = process.argv.slice(2);\nfs.appendFileSync(log, 'state ' + args.join(' ') + '\\n');\nif (${stateExit} === 0 && args[0] === 'startup-check' && args.includes('--consume-probe-permit')) {\n  const nonce = args[args.indexOf('--probe-nonce-file') + 1];\n  const tokenPath = nonce.slice(0, -6) + '.launch-token.json';\n  fs.mkdirSync(require('node:path').dirname(tokenPath), { recursive: true, mode: 0o700 });\n  fs.writeFileSync(tokenPath, JSON.stringify({ format: 1, operationId: 'op', permitGeneration: 1, token: 'a'.repeat(64) }), { mode: 0o600 });\n}\n${stateBody}\nprocess.exit(${stateExit});\n`, { mode: 0o755 });
  fs.writeFileSync(child, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, 'child-work pid=' + process.pid + '\\n');\n${childBody}\n`, { mode: 0o755 });
  const args = [
    '--state-cli', stateCli,
    '--root', path.join(root, 'osi-deploy'),
    '--guard-marker', path.join(root, 'osi-deploy', 'guard-installed.json'),
    '--state', path.join(root, 'osi-deploy', 'deployment-state.json'),
    '--receipts', path.join(root, 'osi-deploy', 'receipts'),
    '--probe-nonce-file', path.join(root, 'osi-deploy', 'permits', 'op.1.nonce'),
    '--', process.execPath, child, 'arg-one',
  ];
  fs.mkdirSync(path.join(root, 'osi-deploy'), { recursive: true, mode: 0o700 });
  const markerPath = path.join(root, 'osi-deploy', 'guard-installed.json');
  fs.writeFileSync(markerPath, JSON.stringify({
    residents: {
      stateCli: {
        path: stateCli,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(stateCli)).digest('hex'),
        mode: 0o755,
      },
      guardedLauncher: {
        path: launcher,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(launcher)).digest('hex'),
        mode: 0o755,
      },
    },
    nodeRedLaunch: {
      executable: process.execPath,
      argvSha256: crypto.createHash('sha256').update(JSON.stringify([process.execPath, child, 'arg-one'])).digest('hex'),
    },
  }), { mode: 0o600 });
  return { root, log, stateCli, child, markerPath, args };
}

test('state CLI must exactly match the marker-bound path, hash, and lstat before permit consumption', () => {
  for (const mutation of ['path', 'hash', 'symlink', 'mode']) {
    const f = fixture(0);
    if (mutation === 'path') {
      const fake = path.join(f.root, 'fake-state-cli.js');
      fs.writeFileSync(fake, `require('node:fs').appendFileSync(${JSON.stringify(f.log)}, 'fake-state\\n');\n`, { mode: 0o755 });
      f.args[f.args.indexOf('--state-cli') + 1] = fake;
    } else if (mutation === 'hash') {
      fs.appendFileSync(f.stateCli, '\n// marker hash drift\n');
    } else if (mutation === 'symlink') {
      const real = `${f.stateCli}.real`;
      fs.renameSync(f.stateCli, real);
      fs.symlinkSync(real, f.stateCli);
    } else {
      fs.chmodSync(f.stateCli, 0o777);
    }
    const result = spawnSync(launcher, f.args, { encoding: 'utf8' });
    assert.notEqual(result.status, 0, mutation);
    assert.equal(fs.existsSync(f.log), false, `${mutation}: permit consumer must not run`);
  }
});

test('launcher pins the Node runtime and replaces a caller-controlled PATH before permit consumption', () => {
  const f = fixture(0);
  const shadowDir = path.join(f.root, 'shadow-bin');
  const shadowLog = path.join(f.root, 'shadow-node.log');
  fs.mkdirSync(shadowDir, { mode: 0o700 });
  fs.writeFileSync(path.join(shadowDir, 'node'), `#!/bin/sh\nprintf 'shadowed\\n' >> ${JSON.stringify(shadowLog)}\nexit 99\n`, { mode: 0o755 });
  const result = spawnSync(launcher, f.args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: shadowDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(shadowLog), false, 'PATH-shadowed node must never execute');
  assert.match(fs.readFileSync(f.log, 'utf8'), /^state startup-check /);
  const source = fs.readFileSync(launcher, 'utf8');
  assert.doesNotMatch(source, /(?:^|\/)setsid(?:\s|$)/m, 'private process groups use pinned Node/libuv, not ambient setsid');
});

test('an arbitrary absolute executable is rejected before the startup permit is consumed', () => {
  const f = fixture(0);
  const args = [...f.args.slice(0, -4), '--', '/bin/true'];
  const result = spawnSync(launcher, args, { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.log), false, 'the state CLI must not consume a permit for an unbound command');
});

test('same authorization supervises one child and records its exact process start before returning', async () => {
  const f = fixture(0, 'setTimeout(() => process.exit(0), 40);');
  const proc = spawn(launcher, f.args, { stdio: 'ignore' });
  const status = await new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  assert.equal(status, 0);
  const lines = fs.readFileSync(f.log, 'utf8').trim().split('\n');
  assert.match(lines[0], /^state startup-check /);
  assert.match(lines[0], /--consume-probe-permit(?: |$)/);
  assert.match(lines[1], /^state record-launch-start /);
  const childPid = Number(lines[2].match(/^child-work pid=(\d+)$/)[1]);
  assert.notEqual(childPid, proc.pid, 'wrapper remains the signal-forwarding supervisor');
  assert.match(lines[1], new RegExp(`--child-pid ${childPid}(?: |$)`));
  assert.match(lines[1], new RegExp(`--supervisor-pid ${proc.pid}(?: |$)`));
  assert.match(lines[1], /--launch-gate-file [^ ]+\.launch-gate(?: |$)/);
});

test('the target cannot execute before record-launch-start durably accepts its gated carrier', () => {
  const stateBody = "if (args[0] === 'record-launch-start' && /child-work/.test(fs.readFileSync(log, 'utf8'))) process.exit(91);";
  const f = fixture(0, 'process.exit(0);', stateBody);
  const result = spawnSync(launcher, f.args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(f.log, 'utf8').trim().split('\n');
  assert.match(lines[1], /^state record-launch-start /);
  assert.match(lines[2], /^child-work pid=/);
});

test('supervisor death while start recording is blocked closes the gate without target work or an orphan', async () => {
  const stateBody = "if (args[0] === 'record-launch-start') process.kill(process.ppid, 'SIGSTOP');";
  const f = fixture(0, 'setInterval(() => {}, 1000);', stateBody);
  const proc = spawn(launcher, f.args, { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(f.log) && /state record-launch-start /.test(fs.readFileSync(f.log, 'utf8')));
  proc.kill('SIGKILL');
  await new Promise((resolve) => proc.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^child-work /m);
});

test('supervisor death after carrier spawn but before child identity publication leaves no token process for retry', async () => {
  const f = fixture(0, 'process.exit(0);');
  const noncePath = f.args[f.args.indexOf('--probe-nonce-file') + 1];
  const tokenPath = noncePath.slice(0, -'.nonce'.length) + '.launch-token.json';
  const holdFile = path.join(f.root, 'spawner-hold.ready');
  const env = {
    ...process.env,
    OSI_REPAIR_PROGRAM_MODE: '1',
    OSI_DEPLOY_ARTIFACT_MODE: 'test',
    OSI_DEPLOY_LAUNCH_TEST_HOLD_AFTER_SPAWN_FILE: holdFile,
  };
  const first = spawn(launcher, f.args, { stdio: 'ignore', env });
  await waitFor(() => fs.existsSync(holdFile));
  first.kill('SIGKILL');
  await new Promise((resolve) => first.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^child-work /m);
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).token;
  await waitFor(() => tokenProcessPids(token).length === 0, 2000);
  const retryEnv = { ...env };
  delete retryEnv.OSI_DEPLOY_LAUNCH_TEST_HOLD_AFTER_SPAWN_FILE;
  const retry = spawnSync(launcher, f.args, { encoding: 'utf8', timeout: 5000, env: retryEnv });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal((fs.readFileSync(f.log, 'utf8').match(/^child-work /gm) || []).length, 1);
});

test('supervisor death before spawner identity publication leaves an exact token spawner for retry scanning', async () => {
  const f = fixture(0, 'process.exit(0);');
  const noncePath = f.args[f.args.indexOf('--probe-nonce-file') + 1];
  const tokenPath = noncePath.slice(0, -'.nonce'.length) + '.launch-token.json';
  const spawnerIdentityPath = noncePath.slice(0, -'.nonce'.length) + '.launch-spawner.json';
  const holdFile = path.join(f.root, 'spawner-identity-hold.ready');
  const env = {
    ...process.env,
    OSI_REPAIR_PROGRAM_MODE: '1',
    OSI_DEPLOY_ARTIFACT_MODE: 'test',
    OSI_DEPLOY_LAUNCH_TEST_HOLD_BEFORE_SPAWNER_IDENTITY_FILE: holdFile,
  };
  const first = spawn(launcher, f.args, { stdio: 'ignore', env });
  await waitFor(() => fs.existsSync(holdFile));
  const spawnerPid = Number(fs.readFileSync(holdFile, 'utf8').trim());
  await waitFor(() => {
    try {
      const raw = fs.readFileSync(`/proc/${spawnerPid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
      return fields[0] !== 'Z';
    } catch (_error) { return false; }
  });
  assert.equal(fs.existsSync(spawnerIdentityPath), false, 'identity must not be published during the hold');
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).token;
  const spawnerEnviron = fs.readFileSync(`/proc/${spawnerPid}/environ`).toString('utf8').split('\0');
  assert.ok(spawnerEnviron.includes(`OSI_DEPLOY_LAUNCH_TOKEN=${token}`));
  const spawnerArgv = fs.readFileSync(`/proc/${spawnerPid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  assert.equal(spawnerArgv[0], '/usr/bin/node');
  assert.equal(spawnerArgv[1], '-');
  assert.equal(spawnerArgv[2], noncePath.slice(0, -'.nonce'.length) + '.launch-child.json');
  assert.equal(spawnerArgv[3], spawnerIdentityPath);
  first.kill('SIGKILL');
  fs.writeFileSync(`${holdFile}.continue`, '\n', { mode: 0o600 });
  await waitFor(() => {
    try {
      const raw = fs.readFileSync(`/proc/${spawnerPid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
      return fields[0] === 'Z';
    } catch (error) { return error.code === 'ENOENT'; }
  });
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^child-work /m);
  const retryEnv = { ...env };
  delete retryEnv.OSI_DEPLOY_LAUNCH_TEST_HOLD_BEFORE_SPAWNER_IDENTITY_FILE;
  const cleanRetry = spawnSync(launcher, f.args, { encoding: 'utf8', timeout: 5000, env: retryEnv });
  assert.equal(cleanRetry.status, 0, cleanRetry.stderr);
  assert.equal((fs.readFileSync(f.log, 'utf8').match(/^child-work /gm) || []).length, 1);
});

test('retry after pre-gate supervisor death reclaims only its stale launch artifacts and starts once', async () => {
  const stateBody = "if (args[0] === 'record-launch-start' && !fs.existsSync(log + '.stopped')) { fs.writeFileSync(log + '.stopped', '1'); process.kill(process.ppid, 'SIGSTOP'); }";
  const f = fixture(0, 'process.exit(0);', stateBody);
  const first = spawn(launcher, f.args, { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(f.log) && /state record-launch-start /.test(fs.readFileSync(f.log, 'utf8')));
  first.kill('SIGKILL');
  await new Promise((resolve) => first.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^child-work /m);
  const retry = spawnSync(launcher, f.args, { encoding: 'utf8', timeout: 5000 });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal((fs.readFileSync(f.log, 'utf8').match(/^child-work /gm) || []).length, 1);
});

test('supervisor death after gate release terminates the exact target process group', async () => {
  const f = fixture(0, 'setInterval(() => {}, 1000);');
  const proc = spawn(launcher, f.args, { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(f.log) && /child-work pid=/.test(fs.readFileSync(f.log, 'utf8')));
  const childPid = Number(fs.readFileSync(f.log, 'utf8').match(/child-work pid=(\d+)/)[1]);
  proc.kill('SIGKILL');
  await new Promise((resolve) => proc.once('exit', resolve));
  await waitFor(() => {
    try { process.kill(childPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  });
});

test('failed startup check and failed exec leave no permitted unsupervised child', () => {
  const denied = fixture(1);
  const deniedResult = spawnSync(launcher, denied.args, { encoding: 'utf8' });
  assert.notEqual(deniedResult.status, 0);
  assert.doesNotMatch(fs.readFileSync(denied.log, 'utf8'), /^child-pid=/m);

  const allowed = fixture(0);
  const missing = [...allowed.args];
  missing[missing.length - 2] = path.join(allowed.root, 'missing-executable');
  const missingResult = spawnSync(launcher, missing, { encoding: 'utf8' });
  assert.notEqual(missingResult.status, 0);
  if (fs.existsSync(allowed.log)) assert.doesNotMatch(fs.readFileSync(allowed.log, 'utf8'), /^child-pid=/m);
});

test('TERM is forwarded to the recorded child and cannot orphan a permitted process', async () => {
  const f = fixture(0, 'process.on("SIGTERM", () => process.exit(42)); setInterval(() => {}, 1000);');
  const proc = spawn(launcher, f.args, { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(f.log) && /child-work pid=/.test(fs.readFileSync(f.log, 'utf8')));
  const childPid = Number(fs.readFileSync(f.log, 'utf8').match(/child-work pid=(\d+)/)[1]);
  assert.notEqual(childPid, proc.pid);
  proc.kill('SIGTERM');
  await new Promise((resolve) => proc.on('exit', resolve));
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});

test('unknown, duplicate, relative-path, and missing child arguments fail closed', () => {
  const f = fixture();
  for (const args of [
    ['--unknown', 'x'],
    [...f.args.slice(0, -3), '--state', '/duplicate', '--', process.execPath, f.args.at(-2)],
    ['--state-cli', 'relative'],
    f.args.slice(0, -3),
  ]) assert.notEqual(spawnSync(launcher, args, { encoding: 'utf8' }).status, 0);
});
