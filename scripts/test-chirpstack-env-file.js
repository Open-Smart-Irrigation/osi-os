#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.resolve(process.env.OSI_BOOTSTRAP_UNDER_TEST || path.join(ROOT, 'scripts/chirpstack-bootstrap.js'));
const DEPLOY = path.resolve(process.env.OSI_DEPLOY_UNDER_TEST || path.join(ROOT, 'deploy.sh'));
const CANONICAL = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js');
const MIRROR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js');
const INIT_A = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap');
const INIT_B = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap');
const API_KEY = 'synthetic-issue-183-api-key';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-issue-183-'));
  const envFile = path.join(dir, '.chirpstack.env');
  return { dir, envFile, backup: envFile + '.pre-gen2' };
}
function clean(fx) { fs.rmSync(fx.dir, { recursive: true, force: true }); }
function mode(file) { return fs.statSync(file).mode & 0o7777; }
function syntheticError(code) { const e = new Error('synthetic-secret-must-not-escape'); e.code = code || 'EIO'; return e; }

function helper(events) {
  let id = 2;
  const next = () => '00000000-0000-4000-8000-' + String(id++).padStart(12, '0');
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const profiles = [
    { id: '00000000-0000-4000-8000-000000000011', name: 'OSI KIWI Sensor', tenantId, runtime: 0, script: '', auto: false },
    { id: '00000000-0000-4000-8000-000000000012', name: 'OSI RAK Field Tester', tenantId, runtime: 0, script: '', auto: false },
    { id: '00000000-0000-4000-8000-000000000013', name: 'OSI CLOVER Sensor', tenantId, runtime: 2, script: 'function decodeUplink(input) { return input; }', auto: true }
  ];
  const view = p => ({
    getPayloadCodecRuntime: () => p.runtime, getPayloadCodecScript: () => p.script,
    getAutoDetectMeasurements: () => p.auto, getName: () => p.name,
    getDescription: () => p.description || '', getTenantId: () => p.tenantId,
    getUplinkInterval: () => p.uplinkInterval || 3600, getDeviceStatusReqInterval: () => p.deviceStatusReqInterval || 1
  });
  const client = {
    async listTenants() { return [{ id: tenantId, name: 'Open Smart Irrigation' }]; },
    async createTenant() { const value = next(); events.push(['createTenant']); return { getId: () => value }; },
    async listApplications() { return []; },
    async createApplication(x) { const value = next(); events.push(['createApplication', x.name]); return { getId: () => value }; },
    async listDeviceProfiles() { return profiles.map(x => ({ id: x.id, name: x.name })); },
    async getDeviceProfile(value) { const p = profiles.find(x => x.id === value); return p ? view(p) : null; },
    async createDeviceProfile(x) {
      const p = { id: next(), name: x.name, tenantId: x.tenantId, runtime: x.payloadCodecScript ? 2 : 0, script: x.payloadCodecScript || '', auto: Boolean(x.autoDetectMeasurements) };
      profiles.push(p); events.push(['createProfile', p.name]); return { getId: () => p.id };
    },
    async updateDeviceProfile(x) {
      const p = profiles.find(y => y.id === x.id);
      Object.assign(p, { runtime: 2, script: x.payloadCodecScript, auto: Boolean(x.autoDetectMeasurements) });
      events.push(['updateProfile', p.name]);
    },
    async getDevice() { return null; }, async setDeviceProfile() { return false; }
  };
  return { createClient() { events.push(['client']); return client; }, listItemToObject: x => x, normalizeDevEui: x => String(x).toUpperCase() };
}
function childProcess(events, options = {}) {
  return {
    execSync(command) {
      if (/create-api-key/.test(command)) { events.push(['api-key']); return Buffer.from('id: synthetic\ntoken: ' + API_KEY + '\n'); }
      throw new Error('unexpected synthetic execSync');
    },
    execFileSync(file, args) {
      if (file !== 'uci') throw new Error('unexpected synthetic executable');
      events.push(['uci', ...args]);
      if (args[0] === 'set' || args[0] === 'commit') return '';
      if (args[0] === '-q' && args[1] === 'get') {
        const value = options.uci && options.uci[args[2]];
        if (value) return value;
        const e = new Error('not configured'); e.status = 1; throw e;
      }
      throw new Error('unexpected synthetic UCI command');
    }
  };
}
function hooks(fx, opts = {}) {
  const events = opts.events || [];
  const env = {
    ENV_FILE: fx.envFile, CHIRPSTACK_API_KEY: API_KEY,
    TEKTELIC_CODEC_PATH: path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/tektelic_agriculture_decoder.js'),
    ...opts.env
  };
  let source = fs.readFileSync(SOURCE, 'utf8').replace(/^#!.*\n/, '');
  source = source.replace(/\nrun\(process\.argv\.slice\(2\)\)\.catch\([\s\S]*?\);\s*$/, '\nmodule.exports.__issue183 = { run, writeEnvFile, writeEnvFileAtomic, secureEnvFiles, readEnvFileForMutation, backupEnvFile, decodeEnvUtf8, publishEnvContent, CredentialEnvError, UsageError, CFG };\n');
  const fakeProcess = { env, argv: ['node', SOURCE], platform: process.platform, getuid: () => process.getuid(), geteuid: () => process.geteuid(), exit: code => events.push(['exit', code]) };
  const fakeModule = { exports: {} };
  const fakeRequire = name => {
    if (name === 'fs') return opts.fs || fs;
    if (name === 'path') return path;
    if (name === 'child_process') return childProcess(events, opts);
    if (typeof name === 'string' && name.endsWith('osi-chirpstack-helper')) return helper(events);
    return require(name);
  };
  fakeRequire.main = fakeModule;
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', source)(
    fakeRequire, fakeModule, fakeModule.exports, path.dirname(SOURCE), SOURCE, fakeProcess,
    opts.console || { log: (...x) => events.push(['log', ...x]), error: (...x) => events.push(['error', ...x]), warn: (...x) => events.push(['warn', ...x]) }
  );
  assert.ok(fakeModule.exports.__issue183, 'test-only hook extraction found the planned operations');
  return { api: fakeModule.exports.__issue183, events };
}
function noExternalPreload(fx) {
  const preload = path.join(fx.dir, 'deny-external.cjs');
  const trace = path.join(fx.dir, 'external-loads.log');
  const code = [
    "const Module=require('node:module');",
    "const path=require('node:path');",
    "const fs=require('node:fs');",
    "const allowed=new Set(Module.builtinModules);",
    "const target=path.resolve(process.env.OSI_GUARD_TARGET);",
    "const original=Module._load;",
    "Module._load=function(request,parent,isMain){",
    " if(parent && parent.filename && path.resolve(parent.filename)===target && !allowed.has(request) && !String(request).startsWith('node:')){",
    "  fs.appendFileSync(process.env.OSI_GUARD_TRACE,String(request)+'\\n');",
    "  throw new Error('external module denied by test preload');",
    " }",
    " return original.apply(this,arguments);",
    "};"
  ].join("\n");
  fs.writeFileSync(preload, code);
  return { preload, trace };
}

function credentialError(error) {
  assert.equal(error && error.name, 'CredentialEnvError');
  assert.equal(error.exitStatus, 74);
  assert.equal(error.message, 'Credential env-file operation failed');
  assert.doesNotMatch(JSON.stringify(error), /synthetic-secret|CHIRPSTACK_API_KEY=/);
  return true;
}
function cli(args, fx, options = {}) {
  const env = { PATH: '/usr/bin:/bin', ENV_FILE: fx.envFile, ...options.env };
  if (options.preload) env.NODE_OPTIONS = '--require ' + options.preload;
  return cp.spawnSync(process.execPath, [SOURCE, ...args], { encoding: 'utf8', env, timeout: options.timeout || 5000, maxBuffer: 2 * 1024 * 1024, uid: options.uid, gid: options.gid });
}

if (process.geteuid() !== 0) {
  test('issue 183 root qualification re-entry', t => {
    const cleanEnv = ['PATH=/usr/bin:/bin'];
    if (process.env.OSI_BOOTSTRAP_UNDER_TEST) cleanEnv.push('OSI_BOOTSTRAP_UNDER_TEST=' + process.env.OSI_BOOTSTRAP_UNDER_TEST);
    if (process.env.OSI_DEPLOY_UNDER_TEST) cleanEnv.push('OSI_DEPLOY_UNDER_TEST=' + process.env.OSI_DEPLOY_UNDER_TEST);
    const result = cp.spawnSync('sudo', ['-n', 'env', '-i', ...cleanEnv, process.execPath, '--test', '--test-concurrency=1', path.resolve(__filename)], { encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    t.diagnostic((result.stdout || '') + (result.stderr || ''));
    assert.equal(result.error && result.error.code, undefined, 'root child did not time out or fail to spawn');
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    for (const name of ['T1 creation', 'T2 narrowing', 'T3 full merge', 'T4 soil repair', 'T5 raw backup', 'T6 hostile paths and CLI', 'T7 deploy routing', 'T8 failure preservation', 'T9 interruption', 'T10 mirrors and init']) assert.ok((result.stdout || '').includes(name));
    assert.doesNotMatch(result.stdout || '', /# (?:SKIP|TODO)|cancelled/i);
  });
} else {
  test('T1 creation', async () => {
    const fx = fixture(); const old = process.umask(0o022); const events = [];
    const traced = new Proxy(fs, { get(target, key) {
      if (key === 'writeFileSync') return (file, data, ...rest) => {
        if (typeof file === 'number') {
          const st = target.fstatSync(file);
          events.push(['first-write', st.uid, st.gid, st.mode & 0o7777]);
        }
        return target.writeFileSync(file, data, ...rest);
      };
      if (key === 'linkSync') return (from, to) => {
        if (path.basename(String(to)) === path.basename(fx.envFile)) {
          const st = target.statSync(from); const bytes = target.readFileSync(from);
          events.push(['publish', st.uid, st.gid, st.mode & 0o7777, st.size, bytes.length]);
        }
        return target.linkSync(from, to);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }});
    try {
      const state = hooks(fx, { fs: traced, events });
      await state.api.run([]);
      assert.equal(mode(fx.envFile), 0o600);
      const stat = fs.statSync(fx.envFile);
      assert.equal(stat.uid, 0); assert.equal(stat.gid, 0); assert.equal(stat.nlink, 1);
      assert.ok(fs.readFileSync(fx.envFile).includes(Buffer.from('CHIRPSTACK_API_KEY=')));
      assert.deepEqual(events.find(x => x[0] === 'first-write'), ['first-write', 0, 0, 0o600]);
      const published = events.find(x => x[0] === 'publish');
      assert.deepEqual(published.slice(0, 4), ['publish', 0, 0, 0o600]);
      assert.equal(published[4], published[5], 'complete byte count verified before publication');
      assert.ok(events.findIndex(x => x[0] === 'first-write') < events.findIndex(x => x[0] === 'publish'));
      assert.doesNotMatch(JSON.stringify(events), new RegExp(API_KEY));
      for (const mask of [0o077, 0o000, 0o777]) {
        process.umask(mask); const other = fixture();
        try { await hooks(other).api.run([]); assert.equal(mode(other.envFile), 0o600); assert.equal(fs.statSync(other.envFile).uid, 0); }
        finally { clean(other); }
      }
    } finally { process.umask(old); clean(fx); }
  });
  test('T2 narrowing', async () => {
    for (const initial of [0o644, 0o666, 0o600, 0o400, 0o4644]) {
      const fx = fixture(); const bytes = Buffer.from('CHIRPSTACK_API_KEY=' + API_KEY + '\n');
      fs.writeFileSync(fx.envFile, bytes, { mode: initial }); fs.chmodSync(fx.envFile, initial);
      try {
        const api = hooks(fx).api; await api.run(['--secure-env-file']);
        const first = fs.statSync(fx.envFile);
        assert.equal(mode(fx.envFile), 0o600); assert.equal(first.uid, 0); assert.equal(first.gid, 0);
        assert.deepEqual(fs.readFileSync(fx.envFile), bytes);
        await api.run(['--secure-env-file']);
        assert.equal(fs.statSync(fx.envFile).ino, first.ino);
      } finally { clean(fx); }
    }
    const missing = fixture();
    try { await hooks(missing).api.run(['--secure-env-file']); assert.equal(fs.existsSync(missing.envFile), false); }
    finally { clean(missing); }
    const backupOnly = fixture(); const backupBytes = Buffer.from('OLD_BACKUP=retained\n');
    fs.writeFileSync(backupOnly.backup, backupBytes, { mode: 0o644 }); fs.chmodSync(backupOnly.backup, 0o644);
    try {
      await hooks(backupOnly).api.run(['--secure-env-file']);
      assert.equal(fs.existsSync(backupOnly.envFile), false);
      assert.deepEqual(fs.readFileSync(backupOnly.backup), backupBytes);
      assert.equal(mode(backupOnly.backup), 0o600);
    } finally { clean(backupOnly); }
    const nonroot = fixture(); const nonrootBytes = Buffer.from('UNCHANGED=1\n');
    fs.writeFileSync(nonroot.envFile, nonrootBytes, { mode: 0o644 }); fs.chmodSync(nonroot.envFile, 0o644);
    try {
      const result = cp.spawnSync(process.execPath, [SOURCE, '--secure-env-file'], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ENV_FILE: nonroot.envFile },
        uid: 65534, gid: 65534, timeout: 5000, maxBuffer: 2 * 1024 * 1024
      });
      assert.equal(result.status, 74);
      assert.deepEqual(fs.readFileSync(nonroot.envFile), nonrootBytes);
      assert.equal(mode(nonroot.envFile), 0o644);
    } finally { clean(nonroot); }
  });
  test('T3 full merge', async () => {
    const fx = fixture(); const prior = Buffer.from('# operator\r\n\r\nAGROSCOPE_LABEL=é🌱\r\nLOG_LEVEL=debug\nDEVICE_EUI=0016C001F1000001\r\nCHIRPSTACK_EXTRA=operator\nQUOTED="a=b"\r\nDUP=one\nDUP=two\r\nFINAL=value');
    fs.writeFileSync(fx.envFile, prior, { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
    try {
      await hooks(fx).api.run([]);
      const result = fs.readFileSync(fx.envFile);
      assert.deepEqual(result.subarray(0, prior.length), prior, 'all unrelated raw line bytes, endings, duplicates and unterminated final line survive');
      for (const line of ['# operator\r', 'AGROSCOPE_LABEL=é🌱\r', 'LOG_LEVEL=debug', 'DEVICE_EUI=0016C001F1000001', 'CHIRPSTACK_EXTRA=operator', 'QUOTED="a=b"\r', 'DUP=one', 'DUP=two\r', 'FINAL=value']) assert.ok(result.includes(Buffer.from(line)));
      assert.equal(fs.statSync(fx.envFile).size, Buffer.byteLength(result.toString('utf8')));
      assert.equal(mode(fx.envFile), 0o600);
    } finally { clean(fx); }
    const bad = fixture(); const bytes = Buffer.from([0x41, 0x3d, 0xe9]);
    fs.writeFileSync(bad.envFile, bytes, { mode: 0o644 }); fs.chmodSync(bad.envFile, 0o644);
    try {
      const state = hooks(bad);
      await assert.rejects(state.api.run([]), credentialError);
      assert.deepEqual(fs.readFileSync(bad.envFile), bytes); assert.equal(mode(bad.envFile), 0o600);
      assert.equal(state.events.some(x => x[0] === 'client' || x[0] === 'api-key'), false);
    } finally { clean(bad); }
  });
  test('T4 soil repair', async () => {
    const fx = fixture();
    const content = 'CHIRPSTACK_API_KEY=' + API_KEY + '\r\nCHIRPSTACK_APP_SENSORS=00000000-0000-4000-8000-000000000001\r\nCHIRPSTACK_PROFILE_KIWI=00000000-0000-4000-8000-000000000011\r\nCHIRPSTACK_PROFILE_RAK10701=00000000-0000-4000-8000-000000000012\r\nCHIRPSTACK_PROFILE_CLOVER=00000000-0000-4000-8000-000000000012\r\nOPERATOR=é🌱\r\n';
    const bytes = Buffer.from(content); fs.writeFileSync(fx.envFile, bytes, { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
    try {
      const state = hooks(fx); await state.api.run(['--repair-soil-profiles']);
      assert.equal(mode(fx.envFile), 0o600);
      assert.ok(fs.readFileSync(fx.envFile).includes(Buffer.from('OPERATOR=é🌱\r')));
      assert.ok(state.events.some(x => x[0] === 'client'));
      const repaired = fs.readFileSync(fx.envFile);
      assert.ok(repaired.includes(Buffer.from('OPERATOR=é🌱\r\n')));
      assert.ok(repaired.includes(Buffer.from('CHIRPSTACK_PROFILE_CLOVER=00000000-0000-4000-8000-')));
      const changed = Buffer.from(content.replace('OPERATOR=', 'OPERATOR_EDIT='));
      await assert.rejects(state.api.writeEnvFileAtomic('OPERATOR=write\n', changed), credentialError);
      fs.writeFileSync(fx.envFile, Buffer.from([0xe9]));
      await assert.rejects(state.api.readEnvFileForMutation(), credentialError);
    } finally { clean(fx); }
    const noOp = fixture();
    const clover = '00000000-0000-4000-8000-000000000013';
    const rak = '00000000-0000-4000-8000-000000000012';
    const noOpBytes = Buffer.from('CHIRPSTACK_API_KEY=' + API_KEY + '\r\nCHIRPSTACK_PROFILE_RAK10701=' + rak + '\r\nCHIRPSTACK_PROFILE_CLOVER=' + clover + '\r\nOPERATOR=é🌱\r\n');
    fs.writeFileSync(noOp.envFile, noOpBytes, { mode: 0o644 }); fs.chmodSync(noOp.envFile, 0o644);
    try {
      const state = hooks(noOp, { uci: {
        'osi-server.cloud.chirpstack_profile_clover': clover,
        'osi-server.cloud.chirpstack_profile_rak10701': rak
      }});
      await state.api.run(['--repair-soil-profiles']);
      assert.deepEqual(fs.readFileSync(noOp.envFile), noOpBytes);
      assert.equal(mode(noOp.envFile), 0o600);
      assert.equal(state.events.some(x => ['createProfile','updateProfile','uci'].includes(x[0])), false);
    } finally { clean(noOp); }
  });
  test('T5 raw backup', async () => {
    const fx = fixture(); const bytes = Buffer.from([0x41, 0x3d, 0xe9, 0x0d, 0x0a, 0xf0, 0x9f, 0x8c, 0xb1]);
    fs.writeFileSync(fx.envFile, bytes, { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
    try {
      const api = hooks(fx).api; await api.backupEnvFile();
      assert.deepEqual(fs.readFileSync(fx.backup), bytes); assert.equal(fs.statSync(fx.backup).size, bytes.length);
      assert.equal(mode(fx.backup), 0o600); assert.equal(fs.statSync(fx.backup).uid, 0);
      const saved = fs.statSync(fx.backup); fs.writeFileSync(fx.envFile, 'different');
      await api.backupEnvFile(); assert.equal(fs.statSync(fx.backup).ino, saved.ino); assert.deepEqual(fs.readFileSync(fx.backup), bytes);
    } finally { clean(fx); }
    const missing = fixture();
    try { await assert.rejects(hooks(missing).api.backupEnvFile(), credentialError); }
    finally { clean(missing); }
  });
  test('T6 hostile paths and CLI', async () => {
    const fx = fixture(); const sentinel = path.join(fx.dir, 'sentinel');
    fs.writeFileSync(sentinel, 'untouched'); fs.chmodSync(sentinel, 0o644);
    try {
      fs.symlinkSync(sentinel, fx.envFile);
      const result = cli(['--secure-env-file'], fx);
      assert.equal(result.status, 74); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched'); assert.equal(mode(sentinel), 0o644);
      fs.unlinkSync(fx.envFile);
      fs.writeFileSync(fx.envFile, 'synthetic=secret\n', { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
      const guard = noExternalPreload(fx);
      const safe = cli(['--secure-env-file'], fx, { preload: guard.preload, env: { OSI_GUARD_TARGET: SOURCE, OSI_GUARD_TRACE: guard.trace } });
      assert.equal(safe.status, 0, safe.stderr);
      assert.equal(mode(fx.envFile), 0o600);
      assert.equal(fs.existsSync(guard.trace), false, 'file-only CLI made no external helper load');
      const control = path.join(fx.dir, 'positive-control.cjs');
      fs.writeFileSync(control, "require('definitely-not-installed-by-test');\n");
      const controlResult = cp.spawnSync(process.execPath, [control], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require ' + guard.preload, OSI_GUARD_TARGET: control, OSI_GUARD_TRACE: guard.trace } });
      assert.notEqual(controlResult.status, 0);
      assert.match(fs.readFileSync(guard.trace, 'utf8'), /definitely-not-installed-by-test/);
      for (const args of [['--secure-env-file', '--backup-env-file'], ['--secure-env-file', '--secure-env-file'], ['--backup-env-file=value'], ['--unknown']]) {
        const invalid = cli(args, fx, { preload: guard.preload, env: { OSI_GUARD_TARGET: SOURCE, OSI_GUARD_TRACE: guard.trace } });
        assert.equal(invalid.status, 2, args.join(' '));
      }
      assert.equal(fs.existsSync(fx.backup), false);
      const dangling = fixture();
      try { fs.symlinkSync(path.join(dangling.dir, 'absent'), dangling.envFile); assert.equal(cli(['--secure-env-file'], dangling).status, 74); }
      finally { clean(dangling); }
      const hardlink = fixture(); const hardTarget = path.join(hardlink.dir, 'sentinel');
      fs.writeFileSync(hardTarget, 'HARDLINK=untouched\n', { mode: 0o640 });
      try {
        fs.linkSync(hardTarget, hardlink.envFile); const before = fs.statSync(hardTarget);
        assert.equal(cli(['--secure-env-file'], hardlink).status, 74);
        assert.deepEqual(fs.readFileSync(hardTarget), Buffer.from('HARDLINK=untouched\n'));
        assert.equal(mode(hardTarget), 0o640); assert.equal(fs.statSync(hardTarget).ino, before.ino); assert.equal(fs.statSync(hardTarget).nlink, 2);
      } finally { clean(hardlink); }
      const backupLink = fixture(); const backupTarget = path.join(backupLink.dir, 'backup-sentinel');
      fs.writeFileSync(backupTarget, 'BACKUP=untouched\n', { mode: 0o644 });
      try {
        fs.symlinkSync(backupTarget, backupLink.backup);
        assert.equal(cli(['--secure-env-file'], backupLink).status, 74);
        assert.equal(fs.readFileSync(backupTarget, 'utf8'), 'BACKUP=untouched\n'); assert.equal(mode(backupTarget), 0o644);
      } finally { clean(backupLink); }
      const directory = fixture();
      try { fs.mkdirSync(directory.envFile); assert.equal(cli(['--secure-env-file'], directory).status, 74); }
      finally { clean(directory); }
      const fifo = fixture();
      try {
        cp.execFileSync('mkfifo', [fifo.envFile]);
        assert.equal(cli(['--secure-env-file'], fifo).status, 74);
      } finally { clean(fifo); }
      const parentLink = fixture(); const realParent = path.join(parentLink.dir, 'real');
      const aliasParent = path.join(parentLink.dir, 'alias');
      fs.mkdirSync(realParent); fs.symlinkSync(realParent, aliasParent);
      const parentTarget = path.join(realParent, 'env');
      fs.writeFileSync(parentTarget, 'PARENT=untouched\n', { mode: 0o644 });
      try {
        assert.equal(cli(['--secure-env-file'], parentLink, { env: { ENV_FILE: path.join(aliasParent, 'env') } }).status, 74);
        assert.equal(fs.readFileSync(parentTarget, 'utf8'), 'PARENT=untouched\n'); assert.equal(mode(parentTarget), 0o644);
      } finally { clean(parentLink); }
      const unsupported = hooks(fx, { fs: new Proxy(fs, { get(target, key) {
        if (key === 'constants') return { ...target.constants, O_NOFOLLOW: undefined };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }}) });
      assert.throws(() => unsupported.api.secureEnvFiles(), credentialError);
      const noProc = hooks(fx, { fs: new Proxy(fs, { get(target, key) {
        if (key === 'statSync') return (file, ...args) => {
          if (file === '/proc/self/fd') throw syntheticError('ENOENT');
          return target.statSync(file, ...args);
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }}) });
      assert.throws(() => noProc.api.secureEnvFiles(), credentialError);
      const soilTemp = path.join(fx.dir, '.soil-repair.tmp');
      fs.writeFileSync(soilTemp, 'OLD_TMP=untouched\n', { mode: 0o640 });
      await hooks(fx).api.writeEnvFile({ MANAGED: 'updated' });
      assert.deepEqual(fs.readFileSync(soilTemp), Buffer.from('OLD_TMP=untouched\n'));
      assert.equal(mode(soilTemp), 0o640);
      const collision = fixture(); const colliding = path.join(collision.dir, '.chirpstack.env.tmp-collision');
      fs.writeFileSync(collision.envFile, 'OLD=whole\n', { mode: 0o600 });
      fs.writeFileSync(colliding, 'COLLISION=untouched\n', { mode: 0o600 });
      try {
        const injected = new Proxy(fs, { get(target, key) {
          if (key === 'mkdtempSync') return () => { throw syntheticError('EEXIST'); };
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        }});
        await assert.rejects(hooks(collision, { fs: injected }).api.writeEnvFile({ MANAGED: 'value' }), error => {
          credentialError(error); assert.equal(error.phase, 'stage'); assert.equal(error.published, false); return true;
        });
        assert.deepEqual(fs.readFileSync(collision.envFile), Buffer.from('OLD=whole\n'));
        assert.deepEqual(fs.readFileSync(colliding), Buffer.from('COLLISION=untouched\n'));
      } finally { clean(collision); }
    } finally { clean(fx); }
  });
  test('T7 deploy routing', () => {
    const deploy = fs.readFileSync(DEPLOY, 'utf8');
    const marked = (begin, end) => {
      const a = deploy.indexOf('# issue-183 ' + begin + ' begin');
      const b = deploy.indexOf('# issue-183 ' + end + ' end', a);
      assert.ok(a >= 0 && b > a, begin + ' fragment markers');
      return deploy.slice(a, b + ('# issue-183 ' + end + ' end').length);
    };
    const early = marked('early secure', 'early secure');
    const gen2 = marked('Gen2', 'Gen2');
    const soil = marked('soil', 'soil');
    const final = marked('final secure', 'final secure');
    const realNode = process.execPath;
    const runFragments = (fx, initial, opts = {}) => {
      const publisherRunner = path.join(fx.dir, 'publisher-child.cjs');
      fs.writeFileSync(publisherRunner, [
      "const fs=require('node:fs'),path=require('node:path');",
      "const sourcePath=process.argv[2],target=process.argv[3],operation=process.argv[4];",
      "let source=fs.readFileSync(sourcePath,'utf8').replace(/^#!.*\\n/,'');",
      "source=source.replace(/\\nrun\\(process\\.argv\\.slice\\(2\\)\\)\\.catch\\([\\s\\S]*?\\);\\s*$/,'\\nmodule.exports.__child={writeEnvFile,writeEnvFileAtomic,readEnvFileForMutation,CredentialEnvError};\\n');",
      "let published=false;const injected=new Proxy(fs,{get(o,k){if(k==='renameSync'||k==='linkSync')return(...a)=>{const r=o[k](...a);published=true;return r;};if(k==='fsyncSync')return fd=>{if(published&&o.fstatSync(fd).isDirectory()){const e=new Error('private publisher fault');e.code='EIO';throw e;}return o.fsyncSync(fd);};const v=o[k];return typeof v==='function'?v.bind(o):v;}});",
      "const fakeProcess={env:{ENV_FILE:target},argv:['node',sourcePath],platform:process.platform,getuid:()=>process.getuid(),geteuid:()=>process.geteuid(),exit:()=>{}};",
      "const fakeModule={exports:{}},fakeRequire=n=>n==='fs'?injected:n==='path'?path:n==='child_process'?require('node:child_process'):require(n);fakeRequire.main=fakeModule;",
      "new Function('require','module','exports','__dirname','__filename','process','console',source)(fakeRequire,fakeModule,fakeModule.exports,path.dirname(sourcePath),sourcePath,fakeProcess,console);",
      "(async()=>{try{const api=fakeModule.exports.__child;if(operation==='full')await api.writeEnvFile({MANAGED:'full'});else{const snapshot=await api.readEnvFileForMutation();await api.writeEnvFileAtomic(snapshot.text+'SOIL=updated\\n',snapshot.bytes);}}catch(e){process.stderr.write((e&&e.exitStatus===74?'credential publisher status 74':'unexpected publisher failure')+'\\n');process.exitCode=e&&e.exitStatus===74?74:1;}})();"
      ].join('\n'));
      const canonical = path.join(fx.dir, 'canonical.env');
      const decoy = path.join(fx.dir, 'decoy.env');
      const log = path.join(fx.dir, 'commands.log');
      if (initial !== null) fs.writeFileSync(canonical, initial, { mode: 0o644 });
      fs.writeFileSync(decoy, 'DECOY=untouched\n', { mode: 0o644 });
      const script = [
        'set -eu',
        'CHIRPSTACK_ENV_FILE=' + JSON.stringify(canonical),
        'MIGRATION_MARKER=' + JSON.stringify(path.join(fx.dir, 'migration')),
        'export CHIRPSTACK_ENV_FILE MIGRATION_MARKER',
        'SECURE_COUNT=0',
        'node() {',
        '  printf "%s|%s\\n" "$ENV_FILE" "$*" >> "$COMMAND_LOG"',
        '  case "$*" in',
        '    *--secure-env-file*) SECURE_COUNT=$((SECURE_COUNT + 1)); if [ "$SECURE_FAIL_AT" -eq "$SECURE_COUNT" ]; then return "$SECURE_STATUS"; fi; "$REAL_NODE" "$SOURCE" --secure-env-file ;;',
        '    *--repair-soil-profiles*) if [ -n "$PUBLISHER_MODE" ]; then "$REAL_NODE" "$PUBLISHER_RUNNER" "$SOURCE" "$ENV_FILE" soil; else return "$SOIL_STATUS"; fi ;;',
        '    *--backup-env-file*) if [ "$BACKUP_STATUS" -ne 0 ]; then return "$BACKUP_STATUS"; fi; "$REAL_NODE" "$SOURCE" --backup-env-file ;;',
        '    *) if [ -n "$PUBLISHER_MODE" ]; then "$REAL_NODE" "$PUBLISHER_RUNNER" "$SOURCE" "$ENV_FILE" full; else return "$GEN2_STATUS"; fi ;;',
        '  esac',
        '}',
        'export -f node',
        early, gen2, soil, final,
        ': > "$MIGRATION_MARKER"'
      ].join('\n');
      const commandLog = log;
      const result = cp.spawnSync('/bin/bash', ['-eu', '-c', script], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin', ENV_FILE: decoy, REAL_NODE: realNode, SOURCE,
          COMMAND_LOG: commandLog, PUBLISHER_RUNNER: publisherRunner, PUBLISHER_MODE: String(opts.publisherMode || ''), GEN2_STATUS: String(opts.gen2Status ?? 1),
          SOIL_STATUS: String(opts.soilStatus ?? 0), SECURE_FAIL_AT: String(opts.secureFailAt ?? 0),
          SECURE_STATUS: String(opts.secureStatus ?? 74), BACKUP_STATUS: String(opts.backupStatus ?? 0), ...opts.env
        }
      });
      return { result, canonical, decoy, log, migration: path.join(fx.dir, 'migration') };
    };
    const sensors = 'CHIRPSTACK_APP_SENSORS=00000000-0000-4000-8000-000000000001\n';
    for (const [label, initial] of [
      ['Gen2 present and no-op soil', sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n'],
      ['Gen2 absent and provisioning branch', sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\nOPERATOR=é🌱\n'],
      ['canonical absent', null]
    ]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, initial);
        assert.equal(run.result.status, 0, label + ': ' + run.result.stderr);
        assert.deepEqual(fs.readFileSync(run.decoy), Buffer.from('DECOY=untouched\n'));
        assert.equal(mode(run.decoy), 0o644);
        assert.equal(fs.existsSync(run.migration), true);
        const calls = fs.readFileSync(run.log, 'utf8').trim().split('\n').filter(Boolean);
        assert.ok(calls.length >= 2);
        assert.ok(calls.every(line => line.startsWith(run.canonical + '|')), 'all invocations bind canonical ENV_FILE');
        if (initial === null) assert.equal(fs.existsSync(run.canonical), false);
        else assert.equal(mode(run.canonical), 0o600);
        if (initial && !initial.includes('CHIRPSTACK_PROFILE_STREGA_GEN2=')) {
          const backup = run.canonical + '.pre-gen2';
          assert.deepEqual(fs.readFileSync(backup), Buffer.from(initial));
          assert.equal(mode(backup), 0o600);
        }
      } finally { clean(fx); }
    }
    for (const status of [74, 2]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n', { gen2Status: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        assert.equal(fs.existsSync(run.canonical + '.pre-gen2'), true);
      } finally { clean(fx); }
    }
    for (const status of [74, 2]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n', { soilStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        const calls = fs.readFileSync(run.log, 'utf8').split('\n').filter(Boolean);
        assert.equal(calls.filter(line => line.includes('--secure-env-file')).length, 1, 'only early secure ran; final secure cannot clear soil failure');
      } finally { clean(fx); }
    }
    for (const status of [1, 2, 74]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n', { secureFailAt: 1, secureStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        assert.equal(fs.readFileSync(run.log, 'utf8').split('\n').filter(Boolean).length, 1);
      } finally { clean(fx); }
    }
    for (const status of [1, 2, 74]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n', { backupStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        const calls = fs.readFileSync(run.log, 'utf8').split('\n').filter(Boolean);
        assert.ok(calls.some(line => line.endsWith('--backup-env-file')));
        assert.equal(calls.filter(line => line.endsWith('|/srv/node-red/chirpstack-bootstrap.js')).length, 0, 'backup failure precedes full bootstrap');
      } finally { clean(fx); }
    }
    for (const status of [1, 2, 74]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n', { gen2Status: 1, secureFailAt: 2, secureStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        assert.equal(fs.readFileSync(run.log, 'utf8').split('\n').filter(line => line.includes('--secure-env-file')).length, 2);
      } finally { clean(fx); }
    }
    for (const status of [1, 2, 74]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n', { soilStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        assert.equal(fs.readFileSync(run.log, 'utf8').split('\n').filter(line => line.includes('--secure-env-file')).length, 1);
      } finally { clean(fx); }
    }
    for (const operation of ['full', 'soil']) {
      const fx = fixture();
      const initial = sensors + (operation === 'soil' ? 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n' : '') + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n';
      try {
        const run = runFragments(fx, initial, { publisherMode: operation });
        assert.equal(run.result.status, 74, operation + ' real publisher failure must stay fatal');
        assert.equal(fs.existsSync(run.migration), false, operation + ' failure stops later deploy markers');
        assert.equal(mode(run.canonical), 0o600);
        if (operation === 'full') assert.deepEqual(fs.readFileSync(run.canonical + '.pre-gen2'), Buffer.from(initial));
        const metadata = cli(['--secure-env-file'], fx);
        assert.equal(metadata.status, 0, 'a separate metadata-only check can succeed after the retained safe publication');
      } finally { clean(fx); }
    }
    const noSensors = fixture();
    try {
      const run = runFragments(noSensors, 'OPERATOR=kept\n', { gen2Status: 0, soilStatus: 0 });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(fs.existsSync(run.migration), true);
      assert.equal(fs.statSync(run.canonical).mode & 0o7777, 0o600);
    } finally { clean(noSensors); }

  });
  test('T8 failure preservation', async () => {
    const faults = ['open', 'fchown', 'fchmod', 'write', 'file-fsync', 'stage-close', 'rename', 'link', 'verify-read', 'dir-fsync', 'private-unlink', 'published-close', 'rmdir', 'outer-close', 'rename-and-close'];
    for (const fault of faults) {
      const fx = fixture();
      const oldBytes = Buffer.from('OLD=complete\n');
      if (!['link', 'private-unlink'].includes(fault)) fs.writeFileSync(fx.envFile, oldBytes, { mode: 0o600 });
      let published = false;
      let failClose = fault === 'outer-close' || fault === 'rename-and-close';
      let failedOnce = false;
      const injected = new Proxy(fs, { get(target, key) {
        if (key === 'openSync' && fault === 'open') return (file, ...args) => {
          if (String(file).endsWith('/env') && String(file).includes('.tmp-')) throw syntheticError('EIO');
          return target.openSync(file, ...args);
        };
        if (key === 'fchownSync' && fault === 'fchown') return () => { throw syntheticError('EPERM'); };
        if (key === 'fchmodSync' && fault === 'fchmod') return () => { throw syntheticError('EIO'); };
        if (key === 'writeFileSync' && fault === 'write') return (fd, bytes, ...args) => {
          target.writeFileSync(fd, Buffer.from(bytes).subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...args);
          throw syntheticError('ENOSPC');
        };
        if (key === 'fsyncSync' && fault === 'file-fsync') return fd => {
          if (!target.fstatSync(fd).isDirectory()) throw syntheticError('EIO');
          return target.fsyncSync(fd);
        };
        if (key === 'renameSync' && ['rename', 'rename-and-close'].includes(fault)) return () => { throw syntheticError('EIO'); };
        if (key === 'linkSync' && fault === 'link') return () => { throw syntheticError('EEXIST'); };
        if (key === 'linkSync' && fault === 'private-unlink') return (from, to) => { const r = target.linkSync(from, to); published = true; return r; };
        if (key === 'renameSync' && fault === 'stage-close') return target.renameSync.bind(target);
        if (key === 'renameSync' || key === 'linkSync') {
          return (...args) => { const r = target[key](...args); published = true; return r; };
        }
        if (key === 'readFileSync' && fault === 'verify-read') return (file, ...args) => {
          if (published && typeof file === 'number') throw syntheticError('EIO');
          return target.readFileSync(file, ...args);
        };
        if (key === 'fsyncSync' && fault === 'dir-fsync') return fd => {
          if (target.fstatSync(fd).isDirectory() && published) throw syntheticError('EIO');
          return target.fsyncSync(fd);
        };
        if (key === 'unlinkSync' && fault === 'private-unlink') return file => {
          if (published && String(file).endsWith('/env') && String(file).includes('.tmp-')) throw syntheticError('EIO');
          return target.unlinkSync(file);
        };
        if (key === 'closeSync' && ['outer-close', 'rename-and-close', 'stage-close', 'published-close'].includes(fault)) return fd => {
          const st = target.fstatSync(fd);
          const name = target.readlinkSync('/proc/self/fd/' + fd);
          if (fault === 'stage-close' && st.isFile() && String(name).endsWith('/env')) {
            target.closeSync(fd); throw syntheticError('EIO');
          }
          if (fault === 'published-close' && published && st.isFile() && path.resolve(name) === path.resolve(fx.envFile)) {
            target.closeSync(fd); throw syntheticError('EIO');
          }
          const outer = st.isDirectory() && path.resolve(name) === path.dirname(fx.envFile);
          target.closeSync(fd);
          if (outer && failClose && !failedOnce) { failedOnce = true; throw syntheticError('EIO'); }
        };
        if (key === 'rmdirSync' && fault === 'rmdir') return () => { throw syntheticError('EIO'); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }});
      try {
        await assert.rejects(hooks(fx, { fs: injected }).api.writeEnvFile({ MANAGED: 'new-value' }), error => {
          credentialError(error);
          const postPublish = ['verify-read','dir-fsync','private-unlink','published-close','rmdir','outer-close'].includes(fault);
          assert.equal(error.published, postPublish, fault);
          if (postPublish) assert.equal(error.publication, ['private-unlink'].includes(fault) ? 'link' : 'rename');
          if (fault === 'link') assert.equal(error.publication, null);
          if (fault === 'rename-and-close') {
            assert.equal(error.operation, 'publishEnvContent');
            assert.equal(error.phase, 'publish');
            assert.equal(error.reason, 'OS_ERROR');
            assert.ok(error.cleanupErrors.length > 0);
            assert.equal(error.published, false);
          }
          assert.doesNotMatch(JSON.stringify(error), /synthetic-secret-must-not-escape/);
          return true;
        });
        if (fault === 'rename' || fault === 'rename-and-close' || fault === 'open' || fault === 'fchown' || fault === 'fchmod' || fault === 'write' || fault === 'file-fsync' || fault === 'stage-close') {
          assert.deepEqual(fs.readFileSync(fx.envFile), oldBytes);
        } else if (fault === 'link') {
          assert.equal(fs.existsSync(fx.envFile), false);
        } else if (fault === 'private-unlink') {
          assert.deepEqual(fs.readFileSync(fx.envFile), Buffer.from('MANAGED=new-value\n'));
          assert.equal(fs.statSync(fx.envFile).nlink, 2);
        } else {
          assert.deepEqual(fs.readFileSync(fx.envFile), Buffer.from('OLD=complete\nMANAGED=new-value\n'));
        }
      } finally { clean(fx); }
    }
    const combine = fixture();
    fs.writeFileSync(combine.envFile, 'OLD=complete\n', { mode: 0o600 });
    try {
      let failed = false;
      const injected = new Proxy(fs, { get(target, key) {
        if (key === 'renameSync') return () => { throw syntheticError('EIO'); };
        if (key === 'closeSync') return fd => {
          const st = target.fstatSync(fd); const name = target.readlinkSync('/proc/self/fd/' + fd);
          target.closeSync(fd);
          if (!failed && st.isDirectory() && path.resolve(name) === path.dirname(combine.envFile)) { failed = true; throw syntheticError('EIO'); }
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }});
      await assert.rejects(hooks(combine, { fs: injected }).api.writeEnvFile({ MANAGED: 'new' }), error => {
        credentialError(error); assert.equal(error.operation, 'publishEnvContent'); assert.equal(error.phase, 'publish');
        assert.ok(error.cleanupErrors.length); assert.equal(error.published, false); return true;
      });
    } finally { clean(combine); }
    const nonCredential = fixture();
    try {
      let failed = false;
      const injected = new Proxy(fs, { get(target, key) {
        if (key === 'closeSync') return fd => {
          const st = target.fstatSync(fd); const name = target.readlinkSync('/proc/self/fd/' + fd); target.closeSync(fd);
          if (!failed && st.isDirectory() && path.resolve(name) === path.dirname(nonCredential.envFile)) { failed = true; throw syntheticError('EIO'); }
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }});
      await assert.rejects(hooks(nonCredential, {
        fs: injected,
        console: { log() { throw new Error('non-credential synthetic'); }, error() {}, warn() {} }
      }).api.writeEnvFile({ MANAGED: 'new' }), error => {
        credentialError(error); assert.equal(error.reason, 'OS_ERROR'); assert.equal(error.published, true);
        assert.ok(error.cleanupErrors.some(entry => entry.reason === 'NON_CREDENTIAL_FAILURE')); return true;
      });
    } finally { clean(nonCredential); }
    const invalidText = fixture(); const invalidRaw = Buffer.from('RAW=whole\n');
    fs.writeFileSync(invalidText.envFile, invalidRaw, { mode: 0o600 });
    try {
      await assert.rejects(hooks(invalidText).api.writeEnvFile({ MANAGED: '\ud800' }), error => {
        credentialError(error); assert.equal(error.reason, 'NON_LOSSLESS_UTF8'); assert.equal(error.phase, 'encode'); return true;
      });
      assert.deepEqual(fs.readFileSync(invalidText.envFile), invalidRaw);
    } finally { clean(invalidText); }
    const fx = fixture();
    try { assert.throws(() => hooks(fx).api.decodeEnvUtf8(Buffer.from([0xe9])), credentialError); }
    finally { clean(fx); }
  });
  test('T9 interruption', () => {
    const fx = fixture();
    try {
      const original = Buffer.from('OLD=whole\n');
      fs.writeFileSync(fx.envFile, original, { mode: 0o600 });
      fs.writeFileSync(fx.backup, original, { mode: 0o600 });
      const runner = path.join(fx.dir, 'publisher-child.cjs');
      fs.writeFileSync(runner, [
        "const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');",
        "const sourcePath=process.argv[2],target=process.argv[3],mode=process.argv[4],marker=process.argv[5];",
        "let source=fs.readFileSync(sourcePath,'utf8').replace(/^#!.*\\n/,'');",
        "source=source.replace(/\\nrun\\(process\\.argv\\.slice\\(2\\)\\)\\.catch\\([\\s\\S]*?\\);\\s*$/,'\\nmodule.exports.__child={writeEnvFile,backupEnvFile,secureEnvFiles};\\n');",
        "const pause=()=>{fs.writeFileSync(marker,'paused');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);};",
        "const injectedFs=new Proxy(fs,{get(o,k){if(k==='renameSync'&&mode.startsWith('rename-'))return(...a)=>{if(mode==='rename-before')pause();const r=o.renameSync(...a);if(mode==='rename-after')pause();return r;};if(k==='linkSync'&&mode==='link-after')return(...a)=>{const r=o.linkSync(...a);pause();return r;};const v=o[k];return typeof v==='function'?v.bind(o):v;}});",
        "const fakeProcess={env:{...process.env,ENV_FILE:target},argv:['node',sourcePath],platform:process.platform,getuid:()=>process.getuid(),geteuid:()=>process.geteuid(),exit:c=>process.exit(c)};",
        "const fakeModule={exports:{}},fakeRequire=n=>n==='fs'?injectedFs:n==='path'?path:n==='child_process'?cp:require(n);fakeRequire.main=fakeModule;",
        "new Function('require','module','exports','__dirname','__filename','process','console',source)(fakeRequire,fakeModule,fakeModule.exports,path.dirname(sourcePath),sourcePath,fakeProcess,console);",
        "const api=fakeModule.exports.__child;if(mode.startsWith('rename-'))api.writeEnvFile({MANAGED:'NEW=complete'});else api.backupEnvFile();"
      ].join('\n'));
      const interrupt = mode => {
        const marker = path.join(fx.dir, 'pause-' + mode);
        const child = cp.spawn(process.execPath, [runner, SOURCE, fx.envFile, mode, marker], {
          stdio: 'ignore', env: { PATH: '/usr/bin:/bin' }
        });
        const deadline = Date.now() + 7000;
        while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        assert.equal(fs.existsSync(marker), true, mode + ' reached publication pause');
        child.kill('SIGKILL');
        const until = Date.now() + 3000;
        while (child.exitCode === null && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        assert.equal(child.signalCode, 'SIGKILL');
      };
      interrupt('rename-before');
      assert.deepEqual(fs.readFileSync(fx.envFile), original);
      interrupt('rename-after');
      assert.equal(fs.readFileSync(fx.envFile, 'utf8'), 'OLD=whole\nMANAGED=NEW=complete\n');
      assert.equal(mode(fx.envFile), 0o600);
      assert.deepEqual(fs.readFileSync(fx.backup), original);
      fs.unlinkSync(fx.backup);
      fs.writeFileSync(fx.envFile, original, { mode: 0o600 });
      interrupt('link-after');
      assert.equal(fs.statSync(fx.envFile).nlink, 1);
      assert.equal(fs.statSync(fx.backup).nlink, 2);
      const next = cli(['--secure-env-file'], fx);
      assert.equal(next.status, 74);
      assert.equal(fs.statSync(fx.backup).nlink, 2);
    } finally { clean(fx); }
  });
  test('T10 mirrors and init', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/chirpstack-bootstrap.js'));
    assert.deepEqual(fs.readFileSync(CANONICAL), source); assert.deepEqual(fs.readFileSync(MIRROR), source);
    assert.deepEqual(fs.readFileSync(INIT_A), fs.readFileSync(INIT_B));
    assert.match(fs.readFileSync(INIT_A, 'utf8'), /\/usr\/share\/node-red\/chirpstack-bootstrap\.js/);
    const deploy = fs.readFileSync(DEPLOY, 'utf8');
    assert.match(deploy, /older ROM script/); assert.match(deploy, /updated \/srv\/node-red script/);
  });
}
