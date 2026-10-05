#!/usr/bin/env node
'use strict';

// chirpstack-bootstrap.js and the TEKTELIC Clover device profile.
//
// The bootstrap once wrote CHIRPSTACK_PROFILE_CLOVER as an alias of the RAK10701
// field-tester profile, which carries no payload codec. A Clover registered on a
// bootstrapped gateway therefore never produced a decoded `object`, and Process
// Data dropped every uplink. These cases run the real script source as a CLI
// against an in-memory ChirpStack, file system and UCI store, and check:
//   - a fresh gateway gets its own Clover profile with the Tektelic codec;
//   - a gateway that already has a Clover profile keeps it, and its own codec;
//   - `--repair-clover-profile` fixes an already provisioned gateway without a
//     re-provision: one profile, one UCI key, one env line, nothing else;
//   - `--repoint-clover-device` moves a registered Clover off the field-tester
//     profile through the ChirpStack API, and refuses anything else.
//
// Run: node --test scripts/test-chirpstack-bootstrap-clover.js
// OSI_BOOTSTRAP_UNDER_TEST=<path> runs the cases against another copy of the
// script (used to show the cases fail on the unfixed script).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = process.env.OSI_BOOTSTRAP_UNDER_TEST
  ? path.resolve(process.env.OSI_BOOTSTRAP_UNDER_TEST)
  : path.join(ROOT, 'scripts', 'chirpstack-bootstrap.js');
const CODEC_DIR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs');
const TEKTELIC_CODEC = path.join(CODEC_DIR, 'tektelic_agriculture_decoder.js');
const ENV_FILE = '/srv/node-red/.chirpstack.env';
const API_KEY = 'synthetic-api-key-0001';
const JS_RUNTIME = 2;

let uuidCounter = 0;
function nextUuid() {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

// ------------------------------------------------------------ fake world --

function makeWorld(seed = {}) {
  const world = {
    tenants: (seed.tenants || []).map((t) => ({ ...t })),
    apps: (seed.apps || []).map((a) => ({ ...a })),
    profiles: (seed.profiles || []).map((p) => ({ ...p })),
    devices: new Map(Object.entries(seed.devices || {}).map(([eui, d]) => [eui, { ...d }])),
    files: new Map(Object.entries(seed.files || {})),
    fileModes: new Map(),
    uci: new Map(Object.entries(seed.uci || {})),
    uciAvailable: seed.uciAvailable !== false,
    writes: [],
    uciCommands: [],
    cliApiKeyCalls: 0,
    logs: [],
    exitCode: null,
  };
  return world;
}

function profileView(profile) {
  return {
    getPayloadCodecRuntime: () => profile.runtime,
    getPayloadCodecScript: () => profile.script,
    getAutoDetectMeasurements: () => profile.autoDetect,
  };
}

function makeChirpStack(world) {
  const client = {
    async listTenants() { return world.tenants.map((t) => ({ id: t.id, name: t.name })); },
    async createTenant(input) {
      const id = nextUuid();
      world.tenants.push({ id, name: input.name });
      world.writes.push(['createTenant', input.name]);
      return { getId: () => id };
    },
    async listApplications(tenantId) {
      return world.apps.filter((a) => a.tenantId === tenantId).map((a) => ({ id: a.id, name: a.name }));
    },
    async createApplication(input) {
      const id = nextUuid();
      world.apps.push({ id, name: input.name, tenantId: input.tenantId });
      world.writes.push(['createApplication', input.name]);
      return { getId: () => id };
    },
    async listDeviceProfiles(tenantId) {
      return world.profiles.filter((p) => p.tenantId === tenantId).map((p) => ({ id: p.id, name: p.name }));
    },
    async getDeviceProfile(id) {
      const profile = world.profiles.find((p) => p.id === id);
      return profile ? profileView(profile) : null;
    },
    async createDeviceProfile(input) {
      const id = nextUuid();
      const script = input.payloadCodecScript === undefined ? '' : String(input.payloadCodecScript);
      world.profiles.push({
        id,
        name: input.name,
        tenantId: input.tenantId,
        runtime: script.trim() ? JS_RUNTIME : 0,
        script,
        autoDetect: Boolean(input.autoDetectMeasurements),
      });
      world.writes.push(['createDeviceProfile', input.name]);
      return { getId: () => id };
    },
    async updateDeviceProfile(input) {
      const profile = world.profiles.find((p) => p.id === input.id);
      const script = String(input.payloadCodecScript || '');
      profile.script = script;
      profile.runtime = script.trim() ? JS_RUNTIME : 0;
      profile.autoDetect = Boolean(input.autoDetectMeasurements);
      world.writes.push(['updateDeviceProfile', input.name]);
    },
    async getDevice(devEui) {
      const device = world.devices.get(devEui);
      return device ? { getDeviceProfileId: () => device.profileId } : null;
    },
    async setDeviceProfile(devEui, profileId) {
      const device = world.devices.get(devEui);
      if (!device || device.profileId === profileId) return false;
      device.profileId = profileId;
      world.writes.push(['setDeviceProfile', devEui, profileId]);
      return true;
    },
  };
  return {
    createClient: () => client,
    listItemToObject: (item) => item,
    normalizeDevEui: (value) => String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase(),
  };
}

function enoent(file) {
  const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
  error.code = 'ENOENT';
  return error;
}

function makeFs(world) {
  const codecFor = (file) => {
    const match = /^\/srv\/node-red\/codecs\/([^/]+)$/.exec(String(file));
    if (!match) return null;
    const local = path.join(CODEC_DIR, match[1]);
    return fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null;
  };
  return {
    readFileSync(file) {
      if (world.files.has(file)) return world.files.get(file);
      const codec = codecFor(file);
      if (codec !== null) return codec;
      throw enoent(file);
    },
    writeFileSync(file, content, options) {
      world.files.set(file, String(content));
      if (options && typeof options === 'object' && options.mode !== undefined) world.fileModes.set(file, options.mode);
    },
    existsSync(file) { return world.files.has(file) || codecFor(file) !== null; },
    statSync(file) {
      if (!world.files.has(file)) throw enoent(file);
      return { mode: world.fileModes.has(file) ? world.fileModes.get(file) : 0o100600 };
    },
    renameSync(from, to) {
      if (!world.files.has(from)) throw enoent(from);
      world.files.set(to, world.files.get(from));
      world.files.delete(from);
      if (world.fileModes.has(from)) {
        world.fileModes.set(to, world.fileModes.get(from));
        world.fileModes.delete(from);
      }
    },
    unlinkSync(file) { world.files.delete(file); },
  };
}

function makeChildProcess(world) {
  const uci = (args) => {
    if (!world.uciAvailable) {
      const error = new Error('spawnSync uci ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    world.uciCommands.push(args.join(' '));
    if (args[0] === 'set') {
      const [key, ...rest] = args[1].split('=');
      world.uci.set(key, rest.join('='));
      return '';
    }
    if (args[0] === 'commit') return '';
    if (args[0] === '-q' && args[1] === 'get') {
      if (!world.uci.has(args[2])) {
        const error = new Error('uci: Entry not found');
        error.status = 1;
        throw error;
      }
      return `${world.uci.get(args[2])}\n`;
    }
    throw new Error(`unexpected uci call: ${args.join(' ')}`);
  };
  return {
    execSync(command) {
      if (/create-api-key/.test(command)) {
        world.cliApiKeyCalls += 1;
        return Buffer.from('id: x\ntoken: minted-by-cli\n');
      }
      throw new Error(`unexpected execSync: ${command}`);
    },
    execFileSync(file, args) {
      if (file === 'uci') return uci(args);
      throw new Error(`unexpected execFileSync: ${file}`);
    },
  };
}

// Runs the script source as `node chirpstack-bootstrap.js <args>` would, with
// every side effect redirected into `world`. The fakes resolve synchronously or
// as already-settled promises, so one macrotask turn drains the whole run.
async function runBootstrap(world, { args = [], env = {} } = {}) {
  const source = fs.readFileSync(SCRIPT, 'utf8').replace(/^#!.*\n/, '');
  const helper = makeChirpStack(world);
  const fakeFs = makeFs(world);
  const fakeCp = makeChildProcess(world);
  const fakeRequire = (name) => {
    if (/osi-chirpstack-helper$/.test(name)) return helper;
    if (name === 'fs') return fakeFs;
    if (name === 'child_process') return fakeCp;
    if (name === 'path') return path;
    throw new Error(`unexpected require: ${name}`);
  };
  const fakeModule = { exports: {} };
  fakeRequire.main = fakeModule;
  const fakeProcess = {
    env: { ENV_FILE, CHIRPSTACK_API_KEY: API_KEY, ...env },
    argv: ['node', '/srv/node-red/chirpstack-bootstrap.js', ...args],
    exit: (code) => { if (world.exitCode === null) world.exitCode = code; },
  };
  const fakeConsole = {
    log: (...parts) => world.logs.push(parts.join(' ')),
    error: (...parts) => world.logs.push(parts.join(' ')),
    warn: (...parts) => world.logs.push(parts.join(' ')),
  };
  // eslint-disable-next-line no-new-func
  const run = new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', source);
  run(fakeRequire, fakeModule, fakeModule.exports, '/srv/node-red', '/srv/node-red/chirpstack-bootstrap.js', fakeProcess, fakeConsole);
  await new Promise((resolve) => setImmediate(resolve));
  if (world.exitCode === null) world.exitCode = 0;
  return world;
}

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function profileByName(world, name) {
  return world.profiles.find((p) => p.name === name) || null;
}

function tektelicCodec() {
  return fs.readFileSync(TEKTELIC_CODEC, 'utf8');
}

// A gateway provisioned by an earlier bootstrap: every profile present, the
// env file and UCI with CLOVER aliased to the field-tester profile, and lines
// an operator or deploy.sh added after the bootstrap.
function provisionedGatewaySeed() {
  const tenantId = nextUuid();
  const sensorsApp = nextUuid();
  const fieldTesterApp = nextUuid();
  const kiwi = nextUuid();
  const lsn50 = nextUuid();
  const rak = nextUuid();
  const envText = [
    'CHIRPSTACK_API_URL=http://localhost:8080',
    `CHIRPSTACK_API_KEY=${API_KEY}`,
    `CHIRPSTACK_APP_SENSORS=${sensorsApp}`,
    `CHIRPSTACK_APP_FIELD_TESTER=${fieldTesterApp}`,
    `CHIRPSTACK_PROFILE_KIWI=${kiwi}`,
    `CHIRPSTACK_PROFILE_LSN50=${lsn50}`,
    `CHIRPSTACK_PROFILE_CLOVER=${rak}`,
    `CHIRPSTACK_PROFILE_RAK10701=${rak}`,
    'DEVICE_EUI=0016C001F1000001',
    'OPERATOR_NOTE=kept',
    '',
  ].join('\n');
  return {
    ids: { tenantId, sensorsApp, fieldTesterApp, kiwi, lsn50, rak },
    envText,
    seed: {
      tenants: [{ id: tenantId, name: 'Open Smart Irrigation' }],
      apps: [
        { id: sensorsApp, name: 'OSI Sensors', tenantId },
        { id: fieldTesterApp, name: 'OSI Field Tester', tenantId },
      ],
      profiles: [
        { id: kiwi, name: 'OSI KIWI Sensor', tenantId, runtime: 0, script: '', autoDetect: false },
        { id: lsn50, name: 'OSI Dragino LSN50', tenantId, runtime: JS_RUNTIME, script: 'function decodeUplink(){return {data:{}};}', autoDetect: true },
        { id: rak, name: 'OSI RAK Field Tester', tenantId, runtime: 0, script: '', autoDetect: false },
      ],
      files: { [ENV_FILE]: envText },
      uci: {
        'osi-server.cloud.chirpstack_profile_clover': rak,
        'osi-server.cloud.chirpstack_profile_rak10701': rak,
        'osi-server.cloud.chirpstack_profile_kiwi': kiwi,
      },
    },
  };
}

// ------------------------------------------------------------------ cases --

test('the Tektelic agriculture codec ships in the codecs directory', () => {
  assert.ok(fs.existsSync(TEKTELIC_CODEC), `missing ${path.relative(ROOT, TEKTELIC_CODEC)}`);
});

test('fresh gateway: Clover gets its own profile with the Tektelic codec; the field tester keeps its profile', async () => {
  const world = await runBootstrap(makeWorld());
  assert.equal(world.exitCode, 0, world.logs.join('\n'));
  const env = parseEnv(world.files.get(ENV_FILE));
  const rak = profileByName(world, 'OSI RAK Field Tester');
  const clover = profileByName(world, 'OSI CLOVER Sensor');

  assert.ok(rak, 'field-tester profile created');
  assert.equal(env.CHIRPSTACK_PROFILE_RAK10701, rak.id);
  assert.equal(rak.runtime, 0, 'field-tester profile stays without a codec');

  assert.notEqual(env.CHIRPSTACK_PROFILE_CLOVER, env.CHIRPSTACK_PROFILE_RAK10701,
    'CHIRPSTACK_PROFILE_CLOVER must not alias the field-tester profile');
  assert.ok(clover, 'a profile named "OSI CLOVER Sensor" exists');
  assert.equal(env.CHIRPSTACK_PROFILE_CLOVER, clover.id);
  assert.equal(world.uci.get('osi-server.cloud.chirpstack_profile_clover'), clover.id);
  assert.equal(clover.runtime, JS_RUNTIME, 'Clover profile runs a JS codec');
  assert.equal(clover.script.trim(), tektelicCodec().trim(), 'Clover profile carries the shipped Tektelic codec');
  assert.equal(clover.autoDetect, true);
});

test('full bootstrap keeps an existing Clover profile and its own codec', async () => {
  const tenantId = nextUuid();
  const legacyId = nextUuid();
  const ownCodec = 'function decodeUplink(input){return {data:{ambient_temperature:1}};}';
  const world = await runBootstrap(makeWorld({
    tenants: [{ id: tenantId, name: 'Open Smart Irrigation' }],
    profiles: [{ id: legacyId, name: 'OSI CLOVER Sensor', tenantId, runtime: JS_RUNTIME, script: ownCodec, autoDetect: true }],
  }));
  assert.equal(world.exitCode, 0, world.logs.join('\n'));
  const env = parseEnv(world.files.get(ENV_FILE));
  assert.equal(env.CHIRPSTACK_PROFILE_CLOVER, legacyId, 'the existing Clover profile is reused');
  const legacy = world.profiles.find((p) => p.id === legacyId);
  assert.equal(legacy.script, ownCodec, 'a codec already on the Clover profile is left alone');
  assert.ok(!world.writes.some(([op, name]) => op === 'updateDeviceProfile' && name === 'OSI CLOVER Sensor'));
});

test('full bootstrap attaches the codec to an existing Clover profile that has none', async () => {
  const tenantId = nextUuid();
  const bareId = nextUuid();
  const world = await runBootstrap(makeWorld({
    tenants: [{ id: tenantId, name: 'Open Smart Irrigation' }],
    profiles: [{ id: bareId, name: 'OSI CLOVER Sensor', tenantId, runtime: 0, script: '', autoDetect: false }],
  }));
  assert.equal(world.exitCode, 0, world.logs.join('\n'));
  const bare = world.profiles.find((p) => p.id === bareId);
  assert.equal(bare.runtime, JS_RUNTIME);
  assert.equal(bare.script.trim(), tektelicCodec().trim());
  assert.equal(parseEnv(world.files.get(ENV_FILE)).CHIRPSTACK_PROFILE_CLOVER, bareId);
});

test('--repair-clover-profile: provisioned gateway gets one new profile, one UCI key and one env line', async () => {
  const gw = provisionedGatewaySeed();
  const world = makeWorld(gw.seed);
  const profilesBefore = world.profiles.map((p) => ({ ...p }));
  await runBootstrap(world, { args: ['--repair-clover-profile'] });
  assert.equal(world.exitCode, 0, world.logs.join('\n'));

  const clover = profileByName(world, 'OSI CLOVER Sensor');
  assert.ok(clover, 'Clover profile created');
  assert.equal(clover.runtime, JS_RUNTIME);
  assert.equal(clover.script.trim(), tektelicCodec().trim());
  assert.notEqual(clover.id, gw.ids.rak);

  assert.deepEqual(world.writes, [['createDeviceProfile', 'OSI CLOVER Sensor']],
    'no tenant, application or other profile is created or changed');
  for (const before of profilesBefore) {
    assert.deepEqual(world.profiles.find((p) => p.id === before.id), before, `${before.name} untouched`);
  }
  assert.equal(world.cliApiKeyCalls, 0, 'no new API key is minted');

  const expectedEnv = gw.envText.replace(`CHIRPSTACK_PROFILE_CLOVER=${gw.ids.rak}`, `CHIRPSTACK_PROFILE_CLOVER=${clover.id}`);
  assert.equal(world.files.get(ENV_FILE), expectedEnv, 'only the CLOVER line changes; order and other lines are kept');
  assert.deepEqual(world.uciCommands.filter((c) => c.startsWith('set')),
    [`set osi-server.cloud.chirpstack_profile_clover=${clover.id}`], 'only the Clover UCI key is set');
  assert.equal(world.uci.get('osi-server.cloud.chirpstack_profile_rak10701'), gw.ids.rak);
  assert.equal(world.uci.get('osi-server.cloud.chirpstack_profile_kiwi'), gw.ids.kiwi);
});

test('--repair-clover-profile is idempotent: a second run changes nothing', async () => {
  const gw = provisionedGatewaySeed();
  const world = makeWorld(gw.seed);
  await runBootstrap(world, { args: ['--repair-clover-profile'] });
  assert.equal(world.exitCode, 0, world.logs.join('\n'));
  const envAfterFirst = world.files.get(ENV_FILE);
  const writesAfterFirst = world.writes.length;
  const uciSetsAfterFirst = world.uciCommands.filter((c) => c.startsWith('set')).length;

  world.exitCode = null;
  await runBootstrap(world, { args: ['--repair-clover-profile'] });
  assert.equal(world.exitCode, 0, world.logs.join('\n'));
  assert.equal(world.files.get(ENV_FILE), envAfterFirst);
  assert.equal(world.writes.length, writesAfterFirst, 'no ChirpStack write on the second run');
  assert.equal(world.uciCommands.filter((c) => c.startsWith('set')).length, uciSetsAfterFirst, 'no UCI write on the second run');
});

test('--repair-clover-profile also repairs a UCI key still aliased when the env line is already distinct', async () => {
  const gw = provisionedGatewaySeed();
  const world = makeWorld(gw.seed);
  const existingClover = nextUuid();
  world.profiles.push({ id: existingClover, name: 'OSI CLOVER Sensor', tenantId: gw.ids.tenantId, runtime: JS_RUNTIME, script: tektelicCodec(), autoDetect: true });
  world.files.set(ENV_FILE, gw.envText.replace(`CHIRPSTACK_PROFILE_CLOVER=${gw.ids.rak}`, `CHIRPSTACK_PROFILE_CLOVER=${existingClover}`));
  await runBootstrap(world, { args: ['--repair-clover-profile'] });
  assert.equal(world.exitCode, 0, world.logs.join('\n'));
  assert.equal(world.uci.get('osi-server.cloud.chirpstack_profile_clover'), existingClover);
  assert.deepEqual(world.writes, [], 'the existing Clover profile is reused, not recreated');
});

test('--repair-clover-profile refuses to run without the existing API key', async () => {
  const gw = provisionedGatewaySeed();
  const world = makeWorld(gw.seed);
  world.files.set(ENV_FILE, gw.envText.replace(`CHIRPSTACK_API_KEY=${API_KEY}\n`, ''));
  await runBootstrap(world, { args: ['--repair-clover-profile'], env: { CHIRPSTACK_API_KEY: '' } });
  assert.equal(world.exitCode, 1);
  assert.equal(world.cliApiKeyCalls, 0, 'never mints a second API key');
  assert.deepEqual(world.writes, []);
  assert.equal(world.files.get(ENV_FILE), gw.envText.replace(`CHIRPSTACK_API_KEY=${API_KEY}\n`, ''));
});

test('--repair-clover-profile refuses a gateway that was never provisioned', async () => {
  const world = makeWorld();
  await runBootstrap(world, { args: ['--repair-clover-profile'] });
  assert.equal(world.exitCode, 1);
  assert.deepEqual(world.writes, [], 'never creates a tenant or profile on an unprovisioned gateway');
  assert.equal(world.files.has(ENV_FILE), false);
});

test('--repoint-clover-device moves a Clover off the field-tester profile and refuses anything else', async () => {
  const gw = provisionedGatewaySeed();
  const world = makeWorld(gw.seed);
  const otherProfile = nextUuid();
  world.devices.set('A840410000000001', { profileId: gw.ids.rak });
  world.devices.set('A840410000000002', { profileId: otherProfile });
  await runBootstrap(world, {
    args: ['--repair-clover-profile', '--repoint-clover-device=a840410000000001', '--repoint-clover-device=A840410000000002', '--repoint-clover-device=A840410000000003'],
  });
  const clover = profileByName(world, 'OSI CLOVER Sensor');
  assert.equal(world.devices.get('A840410000000001').profileId, clover.id, 'Clover on the field-tester profile is repointed');
  assert.equal(world.devices.get('A840410000000002').profileId, otherProfile, 'a device on any other profile is left alone');
  assert.equal(world.exitCode, 1, 'a refused or unknown device makes the run fail visibly');
  assert.ok(world.logs.some((l) => /A840410000000002/.test(l)), 'the refused device is named');
  assert.ok(world.logs.some((l) => /A840410000000003/.test(l)), 'the unknown device is named');

  // Second run with only the repointed device: unchanged, success.
  world.exitCode = null;
  const writes = world.writes.length;
  await runBootstrap(world, { args: ['--repair-clover-profile', '--repoint-clover-device=A840410000000001'] });
  assert.equal(world.exitCode, 0, world.logs.join('\n'));
  assert.equal(world.writes.length, writes, 'repointing is idempotent');
});

test('an unknown option fails instead of running a full provisioning pass', async () => {
  const gw = provisionedGatewaySeed();
  const world = makeWorld(gw.seed);
  await runBootstrap(world, { args: ['--repair-clover-profiles'] });
  assert.equal(world.exitCode, 1);
  assert.deepEqual(world.writes, []);
  assert.equal(world.files.get(ENV_FILE), gw.envText);
});
