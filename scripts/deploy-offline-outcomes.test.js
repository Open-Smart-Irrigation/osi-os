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
    hold: 'DEPLOY_HOLD_SERVICES=1',
    refused: '',
    failed: 'PAYLOAD_FLIPPED=1',
  }[verdict];
  fs.writeFileSync(path.join(stage, 'deploy.sh'), `#!/bin/sh\nset -eu\n${block}\ntouch ${quote(path.join(root, 'started'))}\nDEPLOY_STAMP=fixture-payload\nNODE_RED_START_REASON='fixture migration or health refusal'\n${setup}\ntrap 'write_deploy_outcome $?' EXIT\nexit ${rawCode}\n`);
  for (const file of ['deploy-local-server.js', 'deploy-bundle-manifest.js']) fs.copyFileSync(path.join(__dirname, file), path.join(stage, 'scripts', file));
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
  test(`offline --wait reports ${verdict} durably with status ${expected}`, async t => {
    const f = await fixture(t, verdict, rawCode);
    const result = await run(f);
    assert.equal(result.code, expected, result.output);
    const record = fs.readFileSync(f.result, 'utf8');
    assert.match(record, new RegExp(`^verdict=${verdict}$`, 'm'));
    assert.match(record, new RegExp(`^exit_code=${expected}$`, 'm'));
    assert.match(record, /^payload_stamp=fixture-payload$/m);
    assert.match(record, verdict === 'success' ? /^reason=.*health self-check passed/m : /^reason=.*fixture migration or health refusal/m);
    assert.match(result.output, /Read result: cat /);
  });
}
for (const defect of ['changed', 'extra', 'magic-key', 'missing', 'link', 'no-manifest']) {
  test(`offline refuses ${defect} bundle before executing deploy.sh, despite matching archive checksum`, async t => {
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
test('detached deploy publishes the final result after its launcher is gone', async t => {
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
  test(`push --wait prints the real ${verdict} result and returns ${expected}`, async t => {
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


test('an SSH-style HUP during --wait leaves the detached deploy to publish its result', async t => {
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
  test(`a missing lifecycle report with raw status ${rawCode} becomes ${verdict}`, async t => {
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
  test(`a process failure after writing success corrects the durable result (${expected})`, async t => {
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
