'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const exec = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const offline = path.join(__dirname, 'deploy-offline.sh');
const manifestTool = path.join(__dirname, 'deploy-bundle-manifest.js');
const deploy = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t, verdict = 'success', rawCode = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-outcome-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  fs.mkdirSync(path.join(stage, 'scripts'), { recursive: true });
  const start = deploy.indexOf('# deploy outcome begin\n');
  const end = deploy.indexOf('# deploy outcome end', start);
  const block = start >= 0 ? deploy.slice(start, end) : '';
  const setup = {
    success: 'DEPLOY_COMPLETED=1; PROBE_OK=0',
    unverified: 'DEPLOY_COMPLETED=1; PROBE_OK=unverified',
    'auto-rollback': 'ROLLBACK_RESTORED=1',
    hold: 'DEPLOY_HOLD_SERVICES=1; DEPLOY_SERVICE_STATE=stopped; DEPLOY_IDENTITYD_STATE=stopped',
    refused: '',
    failed: 'PAYLOAD_FLIPPED=1',
  }[verdict];
  fs.writeFileSync(path.join(stage, 'deploy.sh'), `#!/bin/sh\nset -eu\n${block}\ntouch ${quote(path.join(root, 'started'))}\nDEPLOY_STAMP=fixture-payload\nNODE_RED_START_REASON='fixture migration or health refusal'\n${setup}\ntrap 'write_deploy_outcome $?' EXIT\nexit ${rawCode}\n`);
  for (const file of ['deploy-local-server.js', 'deploy-bundle-manifest.js']) fs.copyFileSync(path.join(__dirname, file), path.join(stage, 'scripts', file));
  const gui = path.join(root, 'gui');
  fs.mkdirSync(gui); fs.writeFileSync(path.join(gui, 'index.html'), 'fixture gui');
  await exec('tar', ['czf', path.join(stage, 'react_gui.tar.gz'), '-C', gui, '.']);
  await exec(process.execPath, [manifestTool, 'create', stage, 'fixture-commit']);
  const bundle = path.join(root, 'bundle.tar.gz');
  async function pack() {
    await exec('tar', ['czf', bundle, '-C', stage, '.']);
    const { stdout } = await exec('sha256sum', [bundle]);
    fs.writeFileSync(`${bundle}.sha256`, stdout);
  }
  await pack();
  const env = { ...process.env, DEPLOY_OFFLINE_TMP_ROOT: path.join(root, 'tmp'), DEPLOY_OFFLINE_LOG_DIR: path.join(root, 'data'), DEPLOY_OFFLINE_TS: 'fixture' };
  fs.mkdirSync(env.DEPLOY_OFFLINE_TMP_ROOT);
  return { root, stage, pack, env, bundle, result: path.join(env.DEPLOY_OFFLINE_LOG_DIR, 'deploy-fixture.result') };
}
async function run(f, wait = true) {
  try {
    const { stdout, stderr } = await exec('sh', [offline, f.bundle, '--port', String(await freePort()), ...(wait ? ['--wait'] : [])], { env: f.env, timeout: 15000 });
    return { code: 0, output: stdout + stderr };
  } catch (error) { return { code: error.code, output: error.stdout + error.stderr }; }
}

for (const [verdict, rawCode, expected] of [['success', 0, 0], ['auto-rollback', 1, 1], ['hold', 1, 1], ['refused', 7, 7], ['failed', 1, 1], ['unverified', 0, 3]]) {
  test(`offline --wait reports ${verdict} durably with status ${expected}`, { timeout: 20000 }, async t => {
    const f = await fixture(t, verdict, rawCode);
    const result = await run(f);
    assert.equal(result.code, expected, result.output);
    const record = fs.readFileSync(f.result, 'utf8');
    assert.match(record, new RegExp(`^verdict=${verdict}$`, 'm'));
    assert.match(record, new RegExp(`^exit_code=${expected}$`, 'm'));
    assert.match(record, /^payload_stamp=fixture-payload$/m);
    assert.match(record, /^reason_code=[a-z_]+$/m);
    assert.doesNotMatch(record, /fixture migration or health refusal/);
    assert.match(result.output, /Read result: sh /);
  });
}
for (const defect of ['changed', 'extra', 'magic-key', 'missing', 'link', 'no-manifest']) {
  test(`offline refuses ${defect} bundle before executing deploy.sh, despite matching archive checksum`, { timeout: 20000 }, async t => {
    const f = await fixture(t);
    if (defect === 'changed') fs.appendFileSync(path.join(f.stage, 'deploy.sh'), '\n# changed\n');
    if (defect === 'extra') fs.writeFileSync(path.join(f.stage, 'extra'), 'unexpected');
    if (defect === 'magic-key') fs.writeFileSync(path.join(f.stage, '__proto__'), 'unexpected');
    if (defect === 'missing') fs.unlinkSync(path.join(f.stage, 'scripts/deploy-local-server.js'));
    if (defect === 'link') fs.symlinkSync('../outside', path.join(f.stage, 'escape'));
    if (defect === 'no-manifest') fs.unlinkSync(path.join(f.stage, 'bundle-manifest.json'));
    await f.pack();
    const result = await run(f);
    assert.notEqual(result.code, 0, result.output);
    assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
    assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=refused$/m);
  });
}
test('detached deploy publishes the final result after its launcher is gone', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'auto-rollback', 1);
  const script = path.join(f.stage, 'deploy.sh');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', 'sleep 2\ntouch '));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']);
  await f.pack();
  const result = await run(f, false);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /launched/);
  for (let n = 0; n < 100 && !/^state=complete$/m.test(fs.readFileSync(f.result, 'utf8')); n++) await pause(100);
  assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=auto-rollback$/m);
  for (let n = 0; n < 100 && !fs.existsSync(path.join(f.env.DEPLOY_OFFLINE_TMP_ROOT, 'deploy-bundle-fixture/.deploy.rc')); n++) await pause(100);
});


for (const [verdict, rawCode, expected] of [['success', 0, 0], ['auto-rollback', 1, 1], ['hold', 1, 1], ['unverified', 0, 3]]) {
  test(`push --wait prints the real ${verdict} result and returns ${expected}`, { timeout: 20000 }, async t => {
    const f = await fixture(t, verdict, rawCode);
    const ssh = path.join(f.root, 'ssh-stub');
    fs.writeFileSync(ssh, '#!/bin/sh\nshift\nexec sh -c "$1"\n', { mode: 0o755 });
    const args = [path.join(__dirname, 'deploy-push-bundle.sh'), 'fixture-host', f.bundle, '--wait', '--port', String(await freePort())];
    let result;
    try {
      const { stdout, stderr } = await exec('bash', args, { env: { ...f.env, SSH_CMD: ssh, REPO_ROOT: repo, REMOTE_TMP: path.join(f.root, 'remote') }, timeout: 15000 });
      result = { code: 0, output: stdout + stderr };
    } catch (error) { result = { code: error.code, output: error.stdout + error.stderr }; }
    assert.equal(result.code, expected, result.output);
    assert.match(result.output, new RegExp(`^verdict=${verdict}$`, 'm'));
    assert.match(fs.readFileSync(f.result, 'utf8'), new RegExp(`^exit_code=${expected}$`, 'm'));
  });
}


test('an SSH-style HUP during --wait leaves the detached deploy to publish its result', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'auto-rollback', 1);
  const script = path.join(f.stage, 'deploy.sh');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('DEPLOY_STAMP=fixture-payload', 'sleep 2\nDEPLOY_STAMP=fixture-payload'));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']);
  await f.pack();
  const launcher = spawn('sh', [offline, f.bundle, '--port', String(await freePort()), '--wait'], { env: f.env, stdio: 'ignore' });
  const exited = new Promise(resolve => launcher.once('exit', (code, signal) => resolve({ code, signal })));
  for (let n = 0; n < 100 && !fs.existsSync(path.join(f.root, 'started')); n++) await pause(100);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), true, 'deploy has started before HUP');
  launcher.kill('SIGHUP');
  const stopped = await exited;
  assert.equal(stopped.code, 129);
  for (let n = 0; n < 100 && !/^state=complete$/m.test(fs.readFileSync(f.result, 'utf8')); n++) await pause(100);
  assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=auto-rollback$/m);
  for (let n = 0; n < 100 && !fs.existsSync(path.join(f.env.DEPLOY_OFFLINE_TMP_ROOT, 'deploy-bundle-fixture/.deploy.rc')); n++) await pause(100);
  assert.equal(fs.readFileSync(path.join(f.env.DEPLOY_OFFLINE_TMP_ROOT, 'deploy-bundle-fixture/.deploy.rc'), 'utf8').trim(), '1');
});


for (const [rawCode, verdict, expected] of [[0, 'unverified', 3], [7, 'failed', 7]]) {
  test(`a missing lifecycle report with raw status ${rawCode} becomes ${verdict}`, { timeout: 20000 }, async t => {
    const f = await fixture(t, 'success', rawCode);
    const script = path.join(f.stage, 'deploy.sh');
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace(/^trap .* EXIT\n/m, ''));
    await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']);
    await f.pack();
    const result = await run(f);
    assert.equal(result.code, expected, result.output);
    assert.match(fs.readFileSync(f.result, 'utf8'), new RegExp(`^verdict=${verdict}$`, 'm'));
  });
}

for (const [termination, expected] of [['exit 7', 7], ['kill -KILL "$$"', 137]]) {
  test(`a process failure after writing success corrects the durable result (${expected})`, { timeout: 20000 }, async t => {
    const f = await fixture(t);
    const script = path.join(f.stage, 'deploy.sh');
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8')
      .replace(/^trap .* EXIT\n/m, '')
      .replace(/\nexit 0\n$/, () => `\nwrite_deploy_outcome 0\n${termination}\n`));
    await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']);
    await f.pack();
    const result = await run(f);
    assert.equal(result.code, expected, result.output);
    const record = fs.readFileSync(f.result, 'utf8');
    assert.match(record, /^verdict=failed$/m);
    assert.match(record, new RegExp(`^exit_code=${expected}$`, 'm'));
    assert.match(record, new RegExp(`^deploy_exit_code=${expected}$`, 'm'));
  });
}

test('an occupied port refuses deploy instead of accepting another server', { timeout: 20000 }, async t => {
  const http = require('node:http');
  const occupied = http.createServer((req, res) => res.end('other payload'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await fixture(t);
  await assert.rejects(exec('sh', [offline, f.bundle, '--port', String(occupied.address().port), '--wait'], { env: f.env, timeout: 10000 }), e => e.code === 1);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
  assert.match(fs.readFileSync(f.result, 'utf8'), /^reason_code=server_bind_failed$/m);
});
for (const defect of ['symlink', 'hardlink', 'traversal']) {
  test(`a nested GUI ${defect} refuses before payload or services change`, { timeout: 20000 }, async t => {
    const f = await fixture(t);
    const gui = path.join(f.root, 'gui');
    fs.writeFileSync(path.join(f.root, 'active-payload'), 'old complete');
    fs.writeFileSync(path.join(f.root, 'service-state'), 'running');
    if (defect === 'symlink') fs.symlinkSync('../../active-payload', path.join(gui, 'link'));
    if (defect === 'hardlink') fs.linkSync(path.join(gui, 'index.html'), path.join(gui, 'link'));
    const args = ['czf', path.join(f.stage, 'react_gui.tar.gz'), ...(defect === 'traversal' ? ['--transform=s|index.html|../active-payload|'] : []), '-C', gui, '.'];
    await exec('tar', args);
    await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
    const result = await run(f);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'active-payload'), 'utf8'), 'old complete');
    assert.equal(fs.readFileSync(path.join(f.root, 'service-state'), 'utf8'), 'running');
  });
}
test('a modified bundled verifier is rejected without executing it', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.stage, 'scripts/deploy-bundle-manifest.js'), `require('fs').writeFileSync(${JSON.stringify(path.join(f.root, 'verifier-executed'))}, 'unsafe');\n`);
  await f.pack();
  assert.notEqual((await run(f)).code, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'verifier-executed')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
});
test('private and public receipts stay 0600, unserved and free of sensitive diagnostics', { timeout: 20000 }, async t => {
  const http = require('node:http');
  const f = await fixture(t, 'hold', 1);
  const script = path.join(f.stage, 'deploy.sh');
  const sensitive = '0016C001F1000001 https://user:password@example.invalid/private';
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace("NODE_RED_START_REASON='fixture migration or health refusal'", `echo 'ERROR: ${sensitive}'\nNODE_RED_START_REASON='${sensitive}'`).replace('trap ', 'sleep 1\ntrap '));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
  const port = await freePort();
  const launcher = spawn('sh', [offline, f.bundle, '--port', String(port), '--wait'], { env: f.env, stdio: 'ignore' });
  const exited = new Promise(resolve => launcher.once('exit', resolve));
  for (let n = 0; n < 100 && !fs.existsSync(path.join(f.root, 'started')); n++) await pause(30);
  for (const file of ['.deploy.outcome', '.deploy-fixture/outcome', '../data/deploy-fixture.result']) {
    const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: `/${file}` }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
    assert.notEqual(status, 200);
  }
  assert.equal(await exited, 1);
  assert.match(fs.readFileSync(path.join(f.env.DEPLOY_OFFLINE_LOG_DIR, 'deploy-fixture.log'), 'utf8'), /password/);
  for (const file of [f.result, path.join(f.env.DEPLOY_OFFLINE_LOG_DIR, '.deploy-fixture/outcome')]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /0016C001F1000001|password|https:/);
  }
});
for (const signal of ['SIGTERM', 'SIGHUP']) {
  test(`the supervisor reaps a ${signal} child recovery and --wait returns its true status`, { timeout: 20000 }, async t => {
    const f = await fixture(t, 'hold', 1);
    const script = path.join(f.stage, 'deploy.sh');
    const code = signal === 'SIGTERM' ? 143 : 129;
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', `trap 'DEPLOY_HOLD_SERVICES=1; DEPLOY_SERVICE_STATE=stopped; DEPLOY_IDENTITYD_STATE=stopped; exit ${code}' ${signal.slice(3)}\ntrap 'write_deploy_outcome $?' EXIT\ntouch `).replace(/\nexit 1\n$/, '\nsleep 30\nexit 1\n'));
    await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
    const launcher = spawn('sh', [offline, f.bundle, '--port', String(await freePort()), '--wait'], { env: f.env, stdio: 'ignore' });
    const exited = new Promise(resolve => launcher.once('exit', resolve));
    for (let n = 0; n < 100 && !fs.existsSync(path.join(f.root, 'started')); n++) await pause(30);
    const pid = Number(fs.readFileSync(path.join(f.env.DEPLOY_OFFLINE_LOG_DIR, '.deploy-fixture/supervisor.pid')));
    process.kill(pid, signal);
    assert.equal(await exited, code);
    assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=hold$/m);
    assert.match(fs.readFileSync(f.result, 'utf8'), new RegExp(`^deploy_exit_code=${code}$`, 'm'));
  });
}
test('launcher loss at supervisor spawn transfers ownership without a false refusal', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const runtime = path.join(__dirname, 'deploy-offline-runtime.js');
  const args = [f.bundle, '--port', String(await freePort()), '--wait'];
  const launcher = spawn(process.execPath, ['-e', `const r=require(${JSON.stringify(runtime)}); r.launch(r.config(${JSON.stringify(args)}), {supervisorSpawned(){process.kill(process.pid,'SIGHUP')}}).then(c=>process.exitCode=c)`], { env: f.env, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => launcher.once('exit', resolve)), 129);
  for (let n = 0; n < 100 && (!fs.existsSync(f.result) || !/^state=complete$/m.test(fs.readFileSync(f.result, 'utf8'))); n++) await pause(30);
  assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=success$/m);
});
test('a signal at the verified-before-start boundary cancels without a false refusal', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const runtime = path.join(__dirname, 'deploy-offline-runtime.js');
  const cfg = require('./deploy-offline-runtime').config([f.bundle, '--port', String(await freePort())]);
  Object.assign(cfg, { ts: 'fixture', logDir: f.env.DEPLOY_OFFLINE_LOG_DIR, tmpRoot: f.env.DEPLOY_OFFLINE_TMP_ROOT, extract: path.join(f.env.DEPLOY_OFFLINE_TMP_ROOT, 'deploy-bundle-fixture'), private: path.join(f.env.DEPLOY_OFFLINE_LOG_DIR, '.deploy-fixture'), log: path.join(f.env.DEPLOY_OFFLINE_LOG_DIR, 'deploy-fixture.log'), result: f.result });
  fs.mkdirSync(cfg.logDir);
  const boundary = path.join(f.root, 'boundary');
  const supervisor = spawn(process.execPath, ['-e', `const r=require(${JSON.stringify(runtime)});r.supervise(${JSON.stringify(cfg)},{async beforeDeploy(){require('fs').writeFileSync(${JSON.stringify(boundary)},'ready');await new Promise(r=>setTimeout(r,250))}}).then(c=>process.exitCode=c)`], { env: f.env, stdio: 'ignore' });
  const exited = new Promise(resolve => supervisor.once('exit', resolve));
  for (let n = 0; n < 100 && !fs.existsSync(boundary); n++) await pause(30);
  assert.equal(fs.existsSync(boundary), true);
  supervisor.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
  assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=interrupted$/m);
});
test('a failed completion marker cannot strand --wait', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const script = path.join(f.stage, 'deploy.sh');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', `mkdir ${quote(path.join(f.env.DEPLOY_OFFLINE_TMP_ROOT, 'deploy-bundle-fixture/.deploy.rc'))}\ntouch `));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
  assert.equal((await run(f)).code, 0);
  assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=success$/m);
});
test('a dead supervisor cannot strand --wait or fabricate success', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  // Kill before deploy starts using a deterministic verified boundary hook.
  const runtime = path.join(__dirname, 'deploy-offline-runtime.js');
  const args = [f.bundle, '--port', String(await freePort()), '--wait'];
  const runner = spawn(process.execPath, ['-e', `const r=require(${JSON.stringify(runtime)});r.launch(r.config(${JSON.stringify(args)}),{supervisorSpawned(c){c.kill('SIGKILL')}}).then(c=>process.exitCode=c)`], { env: f.env, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => runner.once('exit', resolve)), 125);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
});

test('the deploy shell retains the sh applet name and identifies its verified source separately', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const script = path.join(f.stage, 'deploy.sh');
  const marker = path.join(f.root, 'shell-name');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', `printf '%s\\n' "$0" > ${quote(marker)}\ntest -f "$2"\ntouch `));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
  const result = await run(f);
  assert.equal(result.code, 0, result.output);
  assert.equal(path.basename(fs.readFileSync(marker, 'utf8').trim()), 'sh');
});

test('actual offline shell fetch uses the verified IPv4 listener despite IPv6 localhost, proxies and curlrc', { timeout: 20000 }, async t => {
  const http = require('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-endpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const good = http.createServer((req, res) => res.end('verified IPv4 bytes'));
  const wrong = http.createServer((req, res) => res.end('unverified IPv6 bytes'));
  const proxy = http.createServer((req, res) => res.end('proxy bytes'));
  for (const server of [good, wrong, proxy]) t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => good.listen(0, '127.0.0.1', resolve));
  const port = good.address().port;
  await new Promise((resolve, reject) => { wrong.once('error', reject); wrong.listen({ port, host: '::1', ipv6Only: true }, resolve); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const maliciousProxy = `http://127.0.0.1:${proxy.address().port}`;
  fs.writeFileSync(path.join(root, '.curlrc'), `proxy = "${maliciousProxy}"\nurl = "${maliciousProxy}/config"\n`);
  const prefix = deploy.slice(0, deploy.indexOf('DB_DIR='));
  const fetch = deploy.slice(deploy.indexOf('fetch() {'), deploy.indexOf('\nfile_sha256()'));
  const dest = path.join(root, 'received');
  await exec('sh', ['-c', `${prefix}\n${fetch}\nfetch payload ${quote(dest)}`, 'sh', String(port)], { env: { ...process.env, DEPLOY_OFFLINE_MODE: '1', HOME: root, CURL_HOME: root, http_proxy: maliciousProxy, ALL_PROXY: maliciousProxy, NO_PROXY: '', no_proxy: '' } });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'verified IPv4 bytes');
  const native = await exec('sh', ['-c', `${prefix}\nprintf '%s' "$BASE"`, 'sh', String(port)], { env: { ...process.env, DEPLOY_OFFLINE_MODE: '0' } });
  assert.equal(native.stdout, `http://localhost:${port}`, 'native tunnel endpoint is retained');
});

test('ENOSPC on the first child GET cannot kill the real supervisor or prevent a final receipt', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const script = path.join(f.stage, 'deploy.sh');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', 'curl -q --proxy "" --noproxy "*" -fsS "http://127.0.0.1:$1/deploy.sh" > /dev/null\ntouch '));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
  fs.mkdirSync(f.env.DEPLOY_OFFLINE_LOG_DIR);
  const runtime = path.join(__dirname, 'deploy-offline-runtime.js');
  const args = [f.bundle, '--port', String(await freePort())];
  const { stdout } = await exec(process.execPath, ['-e', `const r=require(${JSON.stringify(runtime)});let failed=false;r.supervise(r.config(${JSON.stringify(args)}),{accessLog(line){if(!failed && line.includes(' GET ')){failed=true;throw Object.assign(new Error('full access log'),{code:'ENOSPC'})}}}).then(code=>{if(!failed)throw Error('GET fault not exercised');process.exitCode=code})`], { env: f.env, timeout: 15000 });
  assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=success$/m, stdout);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), true);
});

// Round-three F3': a malformed absolute-form target made url.parse throw
// inside the request callback, which killed the supervisor and left the
// receipt at state=running while the deploy ran on unsupervised.
test('a malformed request target during the deploy answers 400 and the supervisor publishes the final receipt', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const script = path.join(f.stage, 'deploy.sh');
  const answer = path.join(f.root, 'malformed-answer');
  const after = path.join(f.root, 'after-status');
  const poke = `const s=require('net').connect(+process.argv[1],'127.0.0.1',()=>s.write('GET http://[::1/deploy.sh HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n'));let b='';s.on('data',d=>{b+=d;if(/\\r\\n\\r\\n/.test(b)){require('fs').writeFileSync(process.argv[2],b.split('\\r\\n')[0]);s.destroy();process.exit(0)}});s.on('error',()=>{});setTimeout(()=>process.exit(0),3000)`;
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', `${quote(process.execPath)} -e ${quote(poke)} "$1" ${quote(answer)}\ncurl -q --proxy "" --noproxy "*" -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/deploy.sh" > ${quote(after)}\ntouch `));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
  const result = await run(f);
  assert.equal(result.code, 0, result.output);
  assert.match(fs.readFileSync(answer, 'utf8'), /^HTTP\/1\.1 400 /);
  assert.equal(fs.readFileSync(after, 'utf8'), '200', 'the server keeps serving after the malformed request');
  const record = fs.readFileSync(f.result, 'utf8');
  assert.match(record, /^state=complete$/m);
  assert.match(record, /^verdict=success$/m);
  const log = fs.readFileSync(path.join(f.env.DEPLOY_OFFLINE_LOG_DIR, 'deploy-fixture.log'), 'utf8');
  assert.doesNotMatch(log, /ERR_INVALID_URL|offline supervisor fault/, log);
  assert.match(fs.readFileSync(path.join(f.env.DEPLOY_OFFLINE_TMP_ROOT, 'deploy-bundle-fixture', '.local-server.log'), 'utf8'), /^400 bad_request$/m);
});

test('any other exception inside the request handler answers 500 and keeps the server and supervisor running', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const script = path.join(f.stage, 'deploy.sh');
  const codes = path.join(f.root, 'codes');
  const get = `curl -q --proxy "" --noproxy "*" -sS -o /dev/null -w '%{http_code}\\n' "http://127.0.0.1:$1/deploy.sh" >> ${quote(codes)}`;
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', `${get}\n${get}\ntouch `));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
  fs.mkdirSync(f.env.DEPLOY_OFFLINE_LOG_DIR);
  const runtime = path.join(__dirname, 'deploy-offline-runtime.js');
  const args = [f.bundle, '--port', String(await freePort())];
  // The first GET from the deploy throws from inside the handler.
  const inject = `const http=require('http');const w=http.ServerResponse.prototype.writeHead;let armed=true;http.ServerResponse.prototype.writeHead=function(code,...rest){if(armed&&code===200&&this.req&&this.req.method==='GET'){armed=false;throw new Error('injected handler fault')}return w.call(this,code,...rest)};`;
  const { stdout, stderr } = await exec(process.execPath, ['-e', `${inject}const r=require(${JSON.stringify(runtime)});const lines=[];r.supervise(r.config(${JSON.stringify(args)}),{accessLog(line){lines.push(line)}}).then(code=>{if(armed)throw Error('handler fault not exercised');console.log('ACCESS '+JSON.stringify(lines));process.exitCode=code})`], { env: f.env, timeout: 15000 });
  assert.deepEqual(fs.readFileSync(codes, 'utf8').trim().split('\n'), ['500', '200']);
  assert.match(fs.readFileSync(f.result, 'utf8'), /^verdict=success$/m, stdout + stderr);
  assert.match(stdout, /"500 handler_error"/);
  assert.match(stderr, /WARN: deploy server request failed: handler_error/);
  assert.doesNotMatch(stderr, /injected handler fault/, 'the error text stays out of the log');
});

test('an exception outside every handler cannot strand the receipt at running; it records a terminal failure', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const script = path.join(f.stage, 'deploy.sh');
  const finished = path.join(f.root, 'child-finished');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('touch ', `touch ${quote(path.join(f.root, 'deploying'))}\nsleep 2\ntouch ${quote(finished)}\ntouch `));
  await exec(process.execPath, [manifestTool, 'create', f.stage, 'fixture-commit']); await f.pack();
  fs.mkdirSync(f.env.DEPLOY_OFFLINE_LOG_DIR);
  const runtime = path.join(__dirname, 'deploy-offline-runtime.js');
  const args = [f.bundle, '--port', String(await freePort())];
  const deploying = path.join(f.root, 'deploying');
  const thrower = `const fs=require('fs');const iv=setInterval(()=>{if(fs.existsSync(${JSON.stringify(deploying)})){clearInterval(iv);setImmediate(()=>{throw new Error('injected supervisor fault')})}},20);`;
  const { stdout, stderr } = await exec(process.execPath, ['-e', `${thrower}const r=require(${JSON.stringify(runtime)});r.supervise(r.config(${JSON.stringify(args)})).then(code=>{console.log('CODE '+code);process.exitCode=code===1?0:9})`], { env: f.env, timeout: 15000 });
  assert.match(stdout, /^CODE 1$/m, stdout + stderr);
  assert.equal(fs.existsSync(finished), true, 'the supervisor waited for the deploy');
  const record = fs.readFileSync(f.result, 'utf8');
  assert.match(record, /^state=complete$/m);
  assert.match(record, /^verdict=incomplete-recovery$/m);
  assert.match(record, /^reason_code=supervisor_failed$/m);
  assert.match(stderr, /ERROR: offline supervisor fault \(uncaught\)/);
  assert.doesNotMatch(stderr, /injected supervisor fault/);
  const read = await exec('sh', [offline, '--result', f.result]).then(r => ({ code: 0, out: r.stdout }), e => ({ code: e.code, out: e.stdout }));
  assert.equal(read.code, 1);
});

test('an exception before the deploy starts refuses with supervisor_failed and never runs deploy.sh', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.env.DEPLOY_OFFLINE_LOG_DIR);
  const runtime = path.join(__dirname, 'deploy-offline-runtime.js');
  const args = [f.bundle, '--port', String(await freePort())];
  // The hook never settles; only the fault can end the wait.
  const { stdout, stderr } = await exec(process.execPath, ['-e', `const r=require(${JSON.stringify(runtime)});r.supervise(r.config(${JSON.stringify(args)}),{beforeDeploy(){setImmediate(()=>{throw new Error('injected pre-start fault')});return new Promise(()=>{})}}).then(code=>{console.log('CODE '+code);process.exitCode=code===1?0:9})`], { env: f.env, timeout: 15000 });
  assert.match(stdout, /^CODE 1$/m, stdout + stderr);
  const record = fs.readFileSync(f.result, 'utf8');
  assert.match(record, /^state=complete$/m);
  assert.match(record, /^verdict=refused$/m);
  assert.match(record, /^reason_code=supervisor_failed$/m);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
});

test('two concurrent pushes with one source label isolate GUI hashes, launchers and expected digests', { timeout: 30000 }, async t => {
  const first = await fixture(t); const second = await fixture(t);
  fs.cpSync(first.stage, second.stage, { recursive: true });
  fs.writeFileSync(path.join(second.root, 'gui/index.html'), 'different GUI build');
  await exec('tar', ['czf', path.join(second.stage, 'react_gui.tar.gz'), '-C', path.join(second.root, 'gui'), '.']);
  const script = path.join(first.stage, 'deploy.sh');
  const download = `umask 077\ncurl -q --proxy '' --noproxy '*' -fsS "http://127.0.0.1:$1/react_gui.tar.gz" -o "$DEPLOY_OUTCOME_FILE.gui"\nsha256sum "$DEPLOY_OUTCOME_FILE.gui" > "$DEPLOY_OUTCOME_FILE.gui-sha"\n`;
  const bytes = fs.readFileSync(script, 'utf8').replace('touch ', download + 'touch ');
  for (const f of [first, second]) {
    fs.writeFileSync(path.join(f.stage, 'deploy.sh'), bytes);
    await exec(process.execPath, [manifestTool, 'create', f.stage, 'same-source-label']); await f.pack();
  }
  const remote = path.join(first.root, 'remote'); const data = path.join(first.root, 'data');
  const ready = path.join(first.root, 'first-ready'); const release = path.join(first.root, 'release');
  const ssh = path.join(first.root, 'ssh');
  fs.writeFileSync(ssh, `#!/bin/sh\nshift\ncase "$1" in sh\\ *) if [ -n "\${PAUSE_FIRST:-}" ]; then touch '${ready}'; while [ ! -f '${release}' ]; do sleep 0.05; done; fi ;; esac\nexec sh -c "$1"\n`, { mode: 0o755 });
  const push = path.join(__dirname, 'deploy-push-bundle.sh');
  const invoke = async (f, ts, pauseFirst = false) => exec('bash', [push, 'fixture-host', f.bundle, '--wait', '--port', String(await freePort())], { timeout: 25000, env: { ...f.env, DEPLOY_OFFLINE_TS: ts, DEPLOY_OFFLINE_LOG_DIR: data, SSH_CMD: ssh, REMOTE_TMP: remote, REPO_ROOT: repo, ...(pauseFirst ? { PAUSE_FIRST: '1' } : {}) } });
  const pendingFirst = invoke(first, 'push-first', true);
  pendingFirst.catch(() => {});
  try {
    for (let n = 0; n < 150 && !fs.existsSync(ready); n++) await pause(30);
    assert.equal(fs.existsSync(ready), true, 'first push is paused after upload verification');
    await invoke(second, 'push-second');
  } finally { fs.writeFileSync(release, 'go'); }
  await pendingFirst;
  const { hash } = require('./deploy-archive');
  const hashes = [];
  for (const [f, ts] of [[first, 'push-first'], [second, 'push-second']]) {
    const expected = hash(fs.readFileSync(f.bundle)); hashes.push(expected);
    const receipt = fs.readFileSync(path.join(data, `deploy-${ts}.result`), 'utf8');
    assert.match(receipt, new RegExp(`^bundle_sha256=${expected}$`, 'm'));
    assert.match(receipt, /^verdict=success$/m);
    const received = fs.readFileSync(path.join(data, `.deploy-${ts}/outcome.gui-sha`), 'utf8').split(/\s+/)[0];
    assert.equal(received, hash(fs.readFileSync(path.join(f.stage, 'react_gui.tar.gz'))));
  }
  assert.notEqual(hashes[0], hashes[1]);
  const runs = fs.readdirSync(remote).filter(n => n.startsWith('osi-deploy-run.'));
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(fs.statSync(path.join(remote, run)).mode & 0o777, 0o700);
    for (const file of ['deploy-offline.sh', 'deploy-offline-runtime.js', 'deploy-archive.js', 'deploy-local-server.js']) assert.equal(fs.statSync(path.join(remote, run, file)).mode & 0o077, 0);
  }
});
