'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
const HELPER_PATH = path.join(__dirname, 'deploy-command-ledger-dependency.js');
const PROFILE = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files');
const NODE_RED = path.join(PROFILE, 'usr/share/node-red');
const LEDGER = path.join(NODE_RED, 'osi-command-ledger');
const BINDING = path.join(NODE_RED, 'osi-watermark-binding');
// The ledger pair gateways run before this feature (main 90ea6e56c, see the
// fixture README) and a main commit whose seed predates migration 0068. Both are
// independent of the feature branch's history, so the test survives a squash merge.
const OLD_LEDGER_FIXTURE = path.join(__dirname, 'fixtures/command-ledger-pre-watermark/osi-command-ledger');
const PRE_0068_MAIN_COMMIT = '90ea6e56c';
const BINDING_INDEX = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-binding/canonicalization.js';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gitFile(revision, relative) {
  return execFileSync('git', ['show', `${revision}:${relative}`], { cwd: ROOT });
}

// database/seed-blank.sql at a main commit before migration 0068. The guard keeps
// the pre-migration probes meaningful: a seed that already carries 0068 objects
// would make them compare the new schema with itself.
function preMigrationSeed() {
  const seed = gitFile(PRE_0068_MAIN_COMMIT, 'database/seed-blank.sql').toString('utf8');
  assert.doesNotMatch(seed, /binding_hash|idx_applied_commands_protected_effect|trg_watermark_calibrations_outbox/,
    'the pre-migration seed must predate migration 0068');
  return seed;
}

function mkdirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function copyCandidate(stage) {
  fs.mkdirSync(path.join(stage, 'osi-command-ledger'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'osi-watermark-binding'), { recursive: true });
  fs.copyFileSync(path.join(LEDGER, 'package.json'), path.join(stage, 'osi-command-ledger/package.json'));
  fs.copyFileSync(path.join(LEDGER, 'index.js'), path.join(stage, 'osi-command-ledger/index.js'));
  fs.copyFileSync(path.join(BINDING, 'canonicalization.js'), path.join(stage, 'osi-watermark-binding/canonicalization.js'));
}

function writeOldPair(root, { withBinding = false } = {}) {
  mkdirFor(path.join(root, 'osi-command-ledger/index.js'));
  fs.copyFileSync(path.join(OLD_LEDGER_FIXTURE, 'package.json'), path.join(root, 'osi-command-ledger/package.json'));
  fs.copyFileSync(path.join(OLD_LEDGER_FIXTURE, 'index.js'), path.join(root, 'osi-command-ledger/index.js'));
  if (withBinding) {
    mkdirFor(path.join(root, 'osi-watermark-binding/canonicalization.js'));
    fs.copyFileSync(path.join(BINDING, 'canonicalization.js'), path.join(root, 'osi-watermark-binding/canonicalization.js'));
  }
}

function writeCurrentPair(root) {
  mkdirFor(path.join(root, 'osi-command-ledger/index.js'));
  mkdirFor(path.join(root, 'osi-watermark-binding/canonicalization.js'));
  fs.copyFileSync(path.join(LEDGER, 'package.json'), path.join(root, 'osi-command-ledger/package.json'));
  fs.copyFileSync(path.join(LEDGER, 'index.js'), path.join(root, 'osi-command-ledger/index.js'));
  fs.copyFileSync(path.join(BINDING, 'canonicalization.js'), path.join(root, 'osi-watermark-binding/canonicalization.js'));
}

function expectedHashes() {
  return {
    packageJson: sha256(path.join(LEDGER, 'package.json')),
    ledgerIndex: sha256(path.join(LEDGER, 'index.js')),
    bindingCanonicalization: sha256(path.join(BINDING, 'canonicalization.js')),
  };
}

function indexOfDeploy(needle) {
  const index = DEPLOY.indexOf(needle);
  assert.notEqual(index, -1, `missing deploy.sh snippet: ${needle}`);
  return index;
}

function probeFreshLedger(root) {
  const probe = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { DatabaseSync } = require('node:sqlite');
    const ledger = require(${JSON.stringify(path.join(root, 'osi-command-ledger'))});
    const native = new DatabaseSync(':memory:');
    native.exec(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'database/seed-blank.sql'))}, 'utf8'));
    const db = {
      get: (sql, params) => native.prepare(sql).get(...(params || [])),
      run: (sql, params) => native.prepare(sql).run(...(params || [])),
      transaction: async (fn) => { native.exec('BEGIN IMMEDIATE'); try { const result = await fn(db); native.exec('COMMIT'); return result; } catch (error) { native.exec('ROLLBACK'); throw error; } }
    };
    ledger.queueCommandAck(db, {
      commandId: 701,
      commandType: 'CONFIG_UPDATE',
      result: 'APPLIED',
      deviceEui: '0016C001F1000001',
      gatewayDeviceEui: '0016C001F1000001',
      effectKey: 'config:0016C001F1000001:probe:1'
    }, { gateway_device_eui: '0016C001F1000001' }).then((ack) => {
      if (!ack || ack.result !== 'APPLIED') throw new Error('legacy ACK probe did not apply');
      const durableBefore = {
        applied: db.get('SELECT COUNT(*) AS n FROM applied_commands').n,
        outbox: db.get('SELECT COUNT(*) AS n FROM command_ack_outbox').n,
        detail: db.get('SELECT result_detail FROM applied_commands WHERE command_id=?', ['701']).result_detail,
        payload: db.get('SELECT payload_json FROM command_ack_outbox WHERE command_id=?', ['701']).payload_json,
      };
      if (durableBefore.applied !== 1 || durableBefore.outbox !== 1) throw new Error('legacy ACK probe did not persist one ledger row and ACK');
      return ledger.deduplicatePendingCommand(db, {
        commandId: 701,
        commandType: 'CONFIG_UPDATE',
        payload: { malformed: true }
      }, { gateway_device_eui: '0016C001F1000001' }).then((replay) => ({ replay, durableBefore }));
    }).then(({ replay, durableBefore }) => {
      if (!replay || !replay.handled || replay.ack.result !== 'APPLIED') throw new Error('legacy dedupe probe did not replay');
      assert.deepEqual(replay.ack, JSON.parse(durableBefore.detail), 'legacy replay ACK differs from durable result_detail');
      const durableAfter = {
        applied: db.get('SELECT COUNT(*) AS n FROM applied_commands').n,
        outbox: db.get('SELECT COUNT(*) AS n FROM command_ack_outbox').n,
        detail: db.get('SELECT result_detail FROM applied_commands WHERE command_id=?', ['701']).result_detail,
        payload: db.get('SELECT payload_json FROM command_ack_outbox WHERE command_id=?', ['701']).payload_json,
      };
      if (durableAfter.applied !== durableBefore.applied || durableAfter.outbox !== durableBefore.outbox || durableAfter.detail !== durableBefore.detail || durableAfter.payload !== durableBefore.payload) throw new Error('legacy replay mutated durable ledger or ACK');
      native.close();
    }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', probe], { cwd: ROOT, stdio: 'pipe' });
}

function probePreMigrationLegacyFlow(root, seedOverride, expectLegacyApply = false) {
  const seedFile = path.join(root, 'pre-migration-seed.sql');
  fs.writeFileSync(seedFile, seedOverride || preMigrationSeed());
  const probe = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { DatabaseSync } = require('node:sqlite');
    const ledger = require(${JSON.stringify(path.join(root, 'osi-command-ledger'))});
    const native = new DatabaseSync(':memory:');
    native.exec(fs.readFileSync(${JSON.stringify(seedFile)}, 'utf8'));
    const db = {
      get: (sql, params) => Promise.resolve(native.prepare(sql).get(...(params || []))),
      all: (sql, params) => Promise.resolve(native.prepare(sql).all(...(params || []))),
      run: (sql, params) => Promise.resolve(native.prepare(sql).run(...(params || []))),
      transaction: async (fn) => { native.exec('BEGIN IMMEDIATE'); try { const result = await fn(db); native.exec('COMMIT'); return result; } catch (error) { native.exec('ROLLBACK'); throw error; } }
    };
    if (${expectLegacyApply ? 'true' : 'false'}) {
      native.prepare('INSERT INTO devices(deveui,name,type_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(
        'A84041A171000001', 'legacy-depth-probe', 'DRAGINO_LSN50', '0016C001F1000001', 0,
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
      );
    }
    const legacySoil = {
      commandId: 17,
      commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
      payload: {
        deviceEui: 'A84041A171000001',
        gatewayDeviceEui: '0016C001F1000001',
        soilMoistureProbeDepthsJson: { probe_1: 30 },
        soilMoistureProbeDepthsConfigured: true,
        syncVersion: 1
      }
    };
    ledger.deduplicatePendingCommand(db, legacySoil, {
      gateway_device_eui: '0016C001F1000001'
    }).then(async (result) => {
      assert.equal(result.handled, ${expectLegacyApply ? 'true' : 'false'},
        ${expectLegacyApply ? "'new ledger must atomically consume the legacy soil command'" : "'old ledger must leave the legacy soil command for its existing route'"});
      if (${expectLegacyApply ? 'true' : 'false'}) {
        const row = await db.get('SELECT result_detail FROM applied_commands WHERE command_id=?', ['17']);
        assert.match(row.result_detail, /legacyPayloadHash/);
        const device = await db.get('SELECT soil_moisture_probe_depths_json,sync_version FROM devices WHERE deveui=?', ['A84041A171000001']);
        assert.equal(device.soil_moisture_probe_depths_json, JSON.stringify({ probe_1: 30 }));
        assert.equal(device.sync_version, 1);
      }
      return ledger.queueCommandAck(db, {
        commandId: 18,
        commandType: 'CONFIG_UPDATE',
        result: 'APPLIED',
        deviceEui: '0016C001F1000001',
        effectKey: 'config:0016C001F1000001:probe:1'
      });
    }).then(async (ack) => {
      assert.equal(ack.result, 'APPLIED');
      assert.equal(native.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, ${expectLegacyApply ? '2' : '1'});
      if (${expectLegacyApply ? 'true' : 'false'}) {
            const before = (await db.get('SELECT result_detail FROM applied_commands WHERE command_id=?', ['17'])).result_detail;
        const changed = JSON.parse(JSON.stringify(legacySoil));
        changed.payload.soilMoistureProbeDepthsJson.probe_1 = 31;
        return ledger.deduplicatePendingCommand(db, changed, {
          gateway_device_eui: '0016C001F1000001'
        }).then(async (conflict) => {
          assert.equal(conflict.handled, true);
          assert.equal(conflict.ack.result, 'CONFLICT');
          assert.equal((await db.get('SELECT result_detail FROM applied_commands WHERE command_id=?', ['17'])).result_detail, before);
          if (native.prepare('PRAGMA table_info(applied_commands)').all().some((column) => column.name === 'binding_hash')) {
          native.prepare(
            'INSERT INTO applied_commands (' +
              'command_id,effect_key,device_eui,command_type,result,applied_at,result_detail,originator,' +
              'binding_hash,intent_hash,resource_type,resource_id,gateway_device_eui,actor_user_uuid,base_sync_version,operation' +
            ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).run(
            '19', 'watermark_calibration:set:0016C001F1000001:A84041A171000001:4',
            'A84041A171000001', 'SET_WATERMARK_CALIBRATION', 'APPLIED',
            '2026-10-01T00:00:00.000Z', JSON.stringify({ commandId: 19, result: 'APPLIED' }), 'edge',
            'a'.repeat(64), 'b'.repeat(64), 'WATERMARK_CALIBRATION', 'A84041A171000001',
            '0016C001F1000001', '12345678-1234-4234-8234-123456789abc', 4, 'set'
          );
          const collision = await ledger.deduplicatePendingCommand(db, { ...legacySoil, commandId: 19 }, {
            gateway_device_eui: '0016C001F1000001'
          });
          assert.equal(collision.handled, true);
          assert.equal(collision.ack.result, 'CONFLICT');
          assert.equal((await db.get('SELECT command_type,result FROM applied_commands WHERE command_id=?', ['19'])).command_type, 'SET_WATERMARK_CALIBRATION');
          await db.run('UPDATE devices SET gateway_device_eui=? WHERE deveui=?', ['0016C001F1000002', 'A84041A171000001']);
          const rebound = await ledger.deduplicatePendingCommand(db, legacySoil, {
            gateway_device_eui: '0016C001F1000001'
          });
          assert.equal(rebound.handled, true);
          assert.equal(rebound.ack.result, 'CONFLICT');
          }
        }).then(() => native.close());
      }
      native.close();
    }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', probe], { cwd: ROOT, stdio: 'pipe' });
}

function installOptions(root, stage, extra = {}) {
  return {
    liveRoot: root,
    stageDir: stage,
    expectedHashes: expectedHashes(),
    ...extra,
  };
}

function runChild(root, stage, marker, signalAt) {
  const child = spawn(process.execPath, [HELPER_PATH, '--install', JSON.stringify(installOptions(root, stage, {
    checkpoint: signalAt,
    checkpointMarker: marker,
  }))], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(`CHECKPOINT ${signalAt}`)) child.kill('SIGKILL');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('the deploy script uses a pinned staged dependency installer and seed installs binding first', () => {
  assert.ok(fs.existsSync(HELPER_PATH), 'expected a checked-in installer helper');
  assert.match(DEPLOY, /scripts\/deploy-command-ledger-dependency\.js/);
  assert.match(DEPLOY, /osi-command-ledger package\.json/);
  assert.match(DEPLOY, /osi-command-ledger index\.js/);
  assert.match(DEPLOY, /osi-watermark-binding canonicalization\.js/);
  for (const [label, livePath] of [
    ['package', '/srv/node-red/osi-command-ledger/package.json'],
    ['index', '/srv/node-red/osi-command-ledger/index.js'],
    ['binding', '/srv/node-red/osi-watermark-binding/canonicalization.js'],
  ]) {
    assert.doesNotMatch(DEPLOY, new RegExp(`fetch_required[\\s\\S]{0,300}\\"${livePath.replaceAll('/', '\\\\/')}\\"`),
      `${label} must not be fetched directly over its live pathname`);
  }
  assert.match(DEPLOY, /sha256/);
  assert.match(DEPLOY, /atomic|rename|install-command-ledger/i);
  for (const [name, file] of [
    ['COMMAND_LEDGER_HELPER_SHA256', HELPER_PATH],
    ['COMMAND_LEDGER_PACKAGE_SHA256', path.join(LEDGER, 'package.json')],
    ['COMMAND_LEDGER_INDEX_SHA256', path.join(LEDGER, 'index.js')],
    ['COMMAND_LEDGER_BINDING_SHA256', path.join(BINDING, 'canonicalization.js')],
  ]) {
    const match = new RegExp(`${name}="([0-9a-f]{64})"`).exec(DEPLOY);
    assert.ok(match, `missing independent ${name} pin`);
    assert.equal(match[1], sha256(file), `${name} must match the checked-in source`);
  }
  for (const profile of ['bcm2712', 'bcm2709']) {
    const seed = fs.readFileSync(path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/etc/uci-defaults/98_osi_node_red_seed`), 'utf8');
    const bindingIndex = seed.indexOf('osi-watermark-binding');
    const ledgerIndex = seed.indexOf('osi-command-ledger');
    assert.ok(bindingIndex >= 0, `${profile} seed must install the binding`);
    assert.ok(bindingIndex < ledgerIndex, `${profile} seed must install binding before ledger`);
  }
});

test('stages and activates a new pair while retaining a runnable old pair on every injected failure', () => {
  const { install } = require(HELPER_PATH);
  const scenarios = [
    ['missing binding fetch', (stage) => fs.rmSync(path.join(stage, 'osi-watermark-binding/canonicalization.js'))],
    ['failed fetch', (stage) => fs.rmSync(path.join(stage, 'osi-command-ledger/index.js'))],
    ['checksum failure', (stage) => fs.appendFileSync(path.join(stage, 'osi-watermark-binding/canonicalization.js'), '\n')],
    ['binding rename failure', null],
    ['ledger package rename failure', null],
    ['ledger index rename failure', null],
  ];
  for (const withBinding of [false, true]) {
    for (const [label, mutate] of scenarios) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-live-'));
      const stage = path.join(root, '.stage');
      try {
        if (withBinding) writeCurrentPair(root);
        else writeOldPair(root);
        copyCandidate(stage);
        if (mutate) mutate(stage);
        const failAt = label === 'binding rename failure' ? 'binding' :
          label === 'ledger package rename failure' ? 'ledger-package' :
            label === 'ledger index rename failure' ? 'ledger-index' : null;
        assert.throws(() => install(installOptions(root, stage, failAt ? {
          rename: (from, to) => { if (to.endsWith(failAt === 'binding' ? 'canonicalization.js' : `${failAt === 'ledger-package' ? 'package.json' : 'index.js'}`)) throw new Error(`injected ${label}`); fs.renameSync(from, to); },
        } : {})), label === 'missing binding fetch' ? /bindingCanonicalization missing/ :
          label === 'failed fetch' ? /ledgerIndex missing/ :
            label === 'checksum failure' ? /checksum mismatch/ : new RegExp(label));
        probeFreshLedger(root);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test('defers activation so pre-0068 database and legacy flows keep the old ledger', () => {
  const { install } = require(HELPER_PATH);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-live-'));
  const stage = path.join(root, '.stage');
  try {
    writeOldPair(root);
    copyCandidate(stage);
    const oldIndexHash = sha256(path.join(root, 'osi-command-ledger/index.js'));
    const result = install(installOptions(root, stage, { deferActivation: true }));
    assert.deepEqual(result, { activated: false, staged: true });
    assert.equal(sha256(path.join(root, 'osi-command-ledger/index.js')), oldIndexHash,
      'staging must not replace the old ledger before migration');
    assert.ok(fs.existsSync(path.join(stage, 'osi-command-ledger/index.js')),
      'candidate ledger must remain available for post-migration activation');
    probePreMigrationLegacyFlow(root);

    install(installOptions(root, stage));
    probeFreshLedger(root);
    probePreMigrationLegacyFlow(root, preMigrationSeed(), true);
    probePreMigrationLegacyFlow(root, fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deploy stages the ledger pair before migration and activates it only after migration', () => {
  const stageIdx = indexOfDeploy('stage_command_ledger_dependency');
  const migrationIdx = indexOfDeploy('run_schema_migration || exit 1');
  const activationIdx = DEPLOY.indexOf('activate_command_ledger_dependency || exit 1', migrationIdx);
  assert.ok(stageIdx < migrationIdx, 'ledger candidate must be staged before schema migration');
  assert.notEqual(activationIdx, -1, 'post-migration ledger activation must be explicit');
  assert.ok(migrationIdx < activationIdx, 'ledger activation must follow schema migration');
});

test('an aborted local fetch leaves a partial candidate unactivated and the retained pair runnable', async () => {
  const { install } = require(HELPER_PATH);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-live-'));
  const stage = path.join(root, '.stage');
  let emittedBytes = 0;
  const server = http.createServer((_request, response) => {
    const bytes = fs.readFileSync(path.join(BINDING, 'canonicalization.js'));
    const partial = bytes.subarray(0, 19);
    emittedBytes = partial.length;
    response.writeHead(200, { 'content-length': bytes.length, connection: 'close' });
    response.end(partial);
  });
  try {
    writeCurrentPair(root);
    copyCandidate(stage);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const destination = path.join(stage, 'osi-watermark-binding/canonicalization.js');
    const result = await runProcess('curl', ['--max-time', '2', '-fsSLo', destination, `http://127.0.0.1:${server.address().port}/binding`]);
    assert.notEqual(result.code, 0, 'the injected fetch must fail at the transport boundary');
    assert.equal(emittedBytes, 19, 'the fixture server must emit a partial response');
    assert.equal(fs.statSync(destination).size, emittedBytes, 'the failed fetch must leave exactly the emitted partial file');
    assert.throws(() => install(installOptions(root, stage)), /checksum mismatch/);
    probeFreshLedger(root);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses symlinked layouts and cross-filesystem staging', () => {
  const { install } = require(HELPER_PATH);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-live-'));
  try {
    writeCurrentPair(root);
    const stage = path.join(root, '.stage');
    copyCandidate(stage);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-outside-'));
    fs.rmSync(path.join(root, 'osi-command-ledger/package.json'));
    fs.symlinkSync(path.join(outside, 'package.json'), path.join(root, 'osi-command-ledger/package.json'));
    assert.throws(() => install(installOptions(root, stage)), /must not be a symlink/);
    fs.rmSync(path.join(root, 'osi-command-ledger/package.json'));
    fs.copyFileSync(path.join(LEDGER, 'package.json'), path.join(root, 'osi-command-ledger/package.json'));
    if (fs.existsSync('/dev/shm') && fs.statSync('/dev/shm').dev !== fs.statSync(root).dev) {
      const foreignStage = fs.mkdtempSync('/dev/shm/osi-ledger-stage-');
      try {
        copyCandidate(foreignStage);
        assert.throws(() => install(installOptions(root, foreignStage)), /same filesystem/);
      } finally {
        fs.rmSync(foreignStage, { recursive: true, force: true });
      }
    }
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validates old-ledger plus candidate-binding compatibility and preserves it across SIGKILL checkpoints', async () => {
  const { install } = require(HELPER_PATH);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-live-'));
  try {
    writeOldPair(root);
    const stage = path.join(root, '.stage');
    copyCandidate(stage);
    const marker = path.join(root, 'marker-staged');
    const staged = await runChild(root, stage, marker, 'after-staging');
    assert.equal(staged.signal, 'SIGKILL');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'after-staging');
    probeFreshLedger(root);

    copyCandidate(stage);
    const activatedMarker = path.join(root, 'marker-binding');
    const activated = await runChild(root, stage, activatedMarker, 'after-binding');
    assert.equal(activated.signal, 'SIGKILL');
    assert.equal(fs.readFileSync(activatedMarker, 'utf8'), 'after-binding');
    probeFreshLedger(root);

    // A fresh process must also load the fully activated, binding-aware ledger.
    copyCandidate(stage);
    install(installOptions(root, stage));
    probeFreshLedger(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A killed deploy (SIGKILL skips the EXIT trap) leaves its PID-named stage
// directory behind, and the next deploy has another PID. Staging starts by
// removing every earlier stage directory, so they do not accumulate.
test('staging removes stage directories left by earlier killed deploys', () => {
  const match = /^stage_command_ledger_dependency\(\) \{\n[\s\S]*?\n\}\n/m.exec(DEPLOY);
  assert.ok(match, 'stage_command_ledger_dependency must be defined in deploy.sh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-stage-root-'));
  try {
    for (const leftover of ['.osi-command-ledger-stage.111', '.osi-command-ledger-stage.222']) {
      fs.mkdirSync(path.join(root, leftover, 'osi-command-ledger'), { recursive: true });
      fs.writeFileSync(path.join(root, leftover, 'osi-command-ledger', 'index.js'), 'stale');
    }
    fs.mkdirSync(path.join(root, 'osi-command-ledger'));
    fs.writeFileSync(path.join(root, '.osi-command-ledger-stage-notes'), 'not a stage directory');
    const script = [
      'set -e',
      `COMMAND_LEDGER_STAGE_ROOT='${root}'`,
      `COMMAND_LEDGER_STAGE='${root}/.osi-command-ledger-stage.333'`,
      `COMMAND_LEDGER_INSTALLER='${root}/installer.js'`,
      `COMMAND_LEDGER_HELPER_SHA256='${'c'.repeat(64)}'`,
      'fetch_required() { :; }',
      'node() { printf %s "$COMMAND_LEDGER_HELPER_SHA256"; }',
      match[0],
      'stage_command_ledger_dependency',
    ].join('\n');
    execFileSync('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const entries = fs.readdirSync(root).sort();
    assert.deepEqual(entries, ['.osi-command-ledger-stage-notes', '.osi-command-ledger-stage.333', 'osi-command-ledger']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Failure paths of staging and activation under a suspended set -e --------
//
// deploy.sh calls run_schema_migration and activate_command_ledger_dependency
// as `f || exit 1`, and run_schema_migration calls the activation inside
// `if !`. A shell does not apply set -e inside a function called from such a
// condition, so every step of these functions must check its own status. The
// harness below runs the shipped text of the staging and activation functions,
// run_schema_migration, restart_node_red, fetch_required, swap_call, the
// payload and identityd lifecycles (including the real EXIT handler) and the
// deploy.sh call sequence from install_deploy_exit_trap to the explicit
// post-migration activation. Stubbed: fetch (copies from the working tree),
// the Node-RED and identityd services, migrate-cli and verify-head-cli (a
// one-row schema_migrations table stands in for the database), and the
// migration-runner fetch.

const SWAP_JS = path.join(__dirname, 'deploy-payload-swap.js');
const ACTIVATED_LINE = 'OK: command-ledger dependency pair activated after schema migration';
const STAGED_LINE = 'OK: command-ledger dependency pair staged; activation deferred until schema migration';

function shellFunction(name, endNeedle = '\n}\n') {
  const open = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(DEPLOY);
  assert.ok(open, `deploy.sh must define ${name}()`);
  const close = DEPLOY.indexOf(endNeedle, open.index);
  assert.notEqual(close, -1, `deploy.sh's ${name}() has no closing brace`);
  return DEPLOY.slice(open.index, close + 3);
}

function deployFragment(begin, end) {
  const start = DEPLOY.indexOf(begin);
  const finish = DEPLOY.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, `deploy.sh fragment markers missing: ${begin} -> ${end}`);
  return DEPLOY.slice(start + begin.length, finish);
}

// The deploy.sh call sequence from the EXIT trap through the explicit
// post-migration activation, verbatim.
function postMigrationCallSequence() {
  const start = DEPLOY.indexOf('\ninstall_deploy_exit_trap\n');
  const last = 'activate_command_ledger_dependency || exit 1\n';
  const end = DEPLOY.indexOf(last, start);
  assert.ok(start >= 0 && end > start, 'deploy.sh must run the exit trap, migration and activation in sequence');
  const sequence = DEPLOY.slice(start + 1, end + last.length);
  assert.match(sequence, /^run_schema_migration \|\| exit 1$/m);
  return sequence;
}

function commandLedgerPins() {
  const pins = DEPLOY.match(/^COMMAND_LEDGER_(?:HELPER|PACKAGE|INDEX|BINDING)_SHA256="[0-9a-f]{64}"$/gm) || [];
  assert.equal(pins.length, 4, 'deploy.sh must pin the installer, ledger package, ledger index and binding');
  return pins.join('\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function activationHarness(root, inject, options = {}) {
  const initPath = '/etc/init.d/node-red';
  const identity = deployFragment('# identityd deploy lifecycle begin\n', '# identityd deploy lifecycle end')
    .replace('deploy_exit_handler() {', 'deploy_exit_handler_under_test() {');
  const payload = deployFragment('# deploy payload lifecycle begin\n', '# deploy payload lifecycle end');
  const migration = shellFunction('run_schema_migration', '\n}\n\necho "=== OSI OS Deploy ==="')
    .replaceAll(initPath, '"$NODE_RED_INIT"');
  assert.match(migration, /if ! activate_command_ledger_dependency; then/);
  return `set -eu
REPO_ROOT=${shellQuote(ROOT)}
ROOT_DIR=${shellQuote(root)}
TMP_DIR="$ROOT_DIR/tmp"
DB_DIR="$ROOT_DIR"
DB_PATH="$ROOT_DIR/farming.db"
SWAP_ROOT="$ROOT_DIR"
SWAP_JS=${shellQuote(SWAP_JS)}
export SWAP_ROOT SWAP_JS
PAYLOADS_ROOT="$ROOT_DIR/payloads"
GUI_ROOT="$ROOT_DIR/gui"
NODE_RED_INIT="$ROOT_DIR/node-red-init"
NODE_RED_STATE_FILE="$ROOT_DIR/node-red.state"
NODE_RED_LOG="$ROOT_DIR/node-red.log"
export NODE_RED_STATE_FILE NODE_RED_LOG
IDENTITYD_LOCK_PATH="$ROOT_DIR/identityd.lock"
IDENTITYD_STATE_FILE="$ROOT_DIR/identityd.state"
HARNESS_STATE="$ROOT_DIR/exit-state"
NODE_RED_ROOT="$ROOT_DIR/node-red"
COMMAND_LEDGER_STAGE_ROOT="$NODE_RED_ROOT"
COMMAND_LEDGER_STAGE="$COMMAND_LEDGER_STAGE_ROOT/.osi-command-ledger-stage.harness"
COMMAND_LEDGER_INSTALLER="$TMP_DIR/deploy-command-ledger-dependency.js"
COMMAND_LEDGER_ACTIVATED=0
${commandLedgerPins()}
MIGRATE_BACKUP_DIR="$TMP_DIR/backups"
DEPLOY_STAMP=new
PREV_STAMP=prev
PREV_CAPTURED=0
PAYLOAD_FLIPPED=0
ROLLBACK_RESTORED=0
DB_MIGRATION_COMMITTED=0
DEPLOY_HOLD_SERVICES=0
MIGRATION_RUNNER_AVAILABLE=0
NODE_RED_LOG_MARK=""
node_red_restart_needed=0
mkdir -p "$TMP_DIR" "$PAYLOADS_ROOT" "$GUI_ROOT"

# HARNESS_FETCH_PATH names one repo path whose download fails: "missing" is
# a 404 (curl -f writes nothing and exits 22); "truncated" and "empty" are a
# server that answers 200 with half of the file or with no bytes at all;
# "unwritten" reports success but leaves no file, so the file is absent from
# the directory although CHECKSUMS.json names it.
fetch() {
    mkdir -p "$(dirname "$2")"
    if [ -n "\${HARNESS_FETCH_PATH:-}" ] && [ "$1" = "$HARNESS_FETCH_PATH" ]; then
        case "\${HARNESS_FETCH_FAULT:-missing}" in
            missing) return 22 ;;
            unwritten) return 0 ;;
            empty) : > "$2"; return 0 ;;
            truncated) head -c "$(( $(wc -c < "$REPO_ROOT/$1") / 2 ))" "$REPO_ROOT/$1" > "$2"; return 0 ;;
        esac
    fi
    cp "$REPO_ROOT/$1" "$2"
}
${shellFunction('fetch_required')}
${shellFunction('swap_call')}
${shellFunction('stage_command_ledger_dependency')}
${shellFunction('activate_command_ledger_dependency')}
${shellFunction('check_fetched_manifest')}
${shellFunction('check_fetched_js_files')}
${identity}
${payload}
${shellFunction('checkpoint_live_db')}
${shellFunction('ensure_sqlite3_cli')}
${shellFunction('restart_node_red').replaceAll(initPath, '"$NODE_RED_INIT"')}
${shellFunction('fetch_reconciliation_assets')}
${options.realRunner ? shellFunction('fetch_migration_runner') : `fetch_migration_runner() {
    migrations_dir="$REPO_ROOT/database/migrations/ordered"
    MIGRATION_RUNNER_AVAILABLE=1
}`}
${migration}

deploy_exit_handler() {
    printf 'activated=%s flipped=%s committed=%s\\n' "$COMMAND_LEDGER_ACTIVATED" "$PAYLOAD_FLIPPED" "$DB_MIGRATION_COMMITTED" > "$HARNESS_STATE"
    deploy_exit_handler_under_test "$1"
}
cleanup() { :; }
wait_for_node_red_stop() { return 0; }
wait_for_node_red_health() { return 0; }
identityd_service() {
    case "$1" in
        running) [ "$(cat "$IDENTITYD_STATE_FILE" 2>/dev/null || echo 0)" = 1 ] ;;
        stop) echo 0 > "$IDENTITYD_STATE_FILE"; rm -f "$IDENTITYD_LOCK_PATH" ;;
        start) echo 1 > "$IDENTITYD_STATE_FILE" ;;
        ready) [ "$(cat "$IDENTITYD_STATE_FILE" 2>/dev/null || echo 0)" = 1 ] ;;
        *) return 0 ;;
    esac
}
identityd_sleep() { :; }

cat > "$NODE_RED_INIT" <<'NODEINIT'
#!/bin/sh
printf '%s\\n' "$1" >> "$NODE_RED_LOG"
case "$1" in stop) echo 0 > "$NODE_RED_STATE_FILE" ;; start|restart) echo 1 > "$NODE_RED_STATE_FILE" ;; esac
NODEINIT
chmod 755 "$NODE_RED_INIT"
echo 1 > "$NODE_RED_STATE_FILE"
echo 1 > "$IDENTITYD_STATE_FILE"
if [ -n "\${HARNESS_DB_SOURCE:-}" ]; then
    cp "$HARNESS_DB_SOURCE" "$DB_PATH"
else
    sqlite3 "$DB_PATH" "CREATE TABLE schema_migrations(version INTEGER, checksum TEXT, status TEXT); INSERT INTO schema_migrations VALUES (12, 'old', 'applied');"
    if [ "\${HARNESS_FOREIGN_ROW:-0}" = 1 ]; then
        # A ledger row above 0021 whose checksum is not main's: the probe
        # sends the deploy into ledger numbering reconciliation.
        sqlite3 "$DB_PATH" "INSERT INTO schema_migrations VALUES (22, 'feedface', 'applied');"
    fi
fi
for stamp in prev new; do
    mkdir -p "$ROOT_DIR/src-gui-$stamp"
    printf '%s\\n' "[{\\"id\\":\\"$stamp\\"}]" > "$ROOT_DIR/src-flows-$stamp.json"
    printf '%s\\n' "$stamp" > "$ROOT_DIR/src-gui-$stamp/index.html"
done
swap_call stagePayload prev "$ROOT_DIR/src-flows-prev.json" "$ROOT_DIR/src-gui-prev" >/dev/null
write_payload_compatibility prev
swap_call flipTo prev "$GUI_ROOT" >/dev/null
swap_call stagePayload new "$ROOT_DIR/src-flows-new.json" "$ROOT_DIR/src-gui-new" >/dev/null

stage_command_ledger_dependency
# --- injected failure ---
${inject}
# --- deploy.sh call sequence ---
${postMigrationCallSequence()}
echo "REACHED: post-migration deploy steps"
`;
}

// Stands in for migrate-cli.js and verify-head-cli.js; every other node call
// runs the real node.
function writeNodeShim(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
if [ "\${HARNESS_REAL_MIGRATE:-0}" = 1 ]; then
  exec ${shellQuote(process.execPath)} "$@"
fi
case "$1" in
  *migrate-cli.js)
    case " $* " in *" --prune-only "*) exit 0 ;; esac
    if [ "\${HARNESS_MIGRATION_COMMITS:-0}" = 1 ]; then
      sqlite3 "$2" "INSERT INTO schema_migrations VALUES (13, 'new', 'applied');" || exit 1
      echo '[migrate] applied: [13]'
    else
      echo '[migrate] applied: []'
    fi
    exit 0 ;;
  *verify-head-cli.js) exit 0 ;;
  *) exec ${shellQuote(process.execPath)} "$@" ;;
esac
`, { mode: 0o755 });
  return bin;
}

function runActivationHarness(root, inject, env = {}, options = {}) {
  writeOldPair(path.join(root, 'node-red'));
  const bin = writeNodeShim(root);
  const result = spawnSync('sh', ['-c', activationHarness(root, inject, options)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    timeout: 120000,
  });
  const read = (name) => (fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8').trim() : null);
  return {
    ...result,
    exitState: read('exit-state'),
    nodeRed: read('node-red.state'),
    identityd: read('identityd.state'),
    nodeRedLog: read('node-red.log') || '',
    activeFlows: swapStamp(root),
    newPayloadKept: fs.existsSync(path.join(root, 'payloads', 'new')),
    liveLedger: Object.fromEntries(['osi-command-ledger/package.json', 'osi-command-ledger/index.js', 'osi-watermark-binding/canonicalization.js']
      .map((file) => {
        const live = path.join(root, 'node-red', file);
        return [file, fs.existsSync(live) ? sha256(live) : null];
      })),
  };
}

function swapStamp(root) {
  const swap = require(SWAP_JS);
  return swap.currentStamp(root);
}

function oldPairHashes() {
  return {
    'osi-command-ledger/package.json': sha256(path.join(OLD_LEDGER_FIXTURE, 'package.json')),
    'osi-command-ledger/index.js': sha256(path.join(OLD_LEDGER_FIXTURE, 'index.js')),
    'osi-watermark-binding/canonicalization.js': null,
  };
}

function candidateHashes() {
  return {
    'osi-command-ledger/package.json': sha256(path.join(LEDGER, 'package.json')),
    'osi-command-ledger/index.js': sha256(path.join(LEDGER, 'index.js')),
    'osi-watermark-binding/canonicalization.js': sha256(path.join(BINDING, 'canonicalization.js')),
  };
}

function withActivationRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-ledger-activation-'));
  try {
    return fn(root);
  } finally {
    for (const dir of ['osi-watermark-binding', 'osi-command-ledger']) {
      const blocked = path.join(root, 'node-red', dir);
      if (fs.existsSync(blocked)) fs.chmodSync(blocked, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function harnessOutput(result) {
  return `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

test('the activation harness completes a deploy when nothing fails', () => {
  withActivationRoot((root) => {
    const result = runActivationHarness(root, ':');
    assert.equal(result.status, 0, harnessOutput(result));
    assert.equal(result.stdout.split(ACTIVATED_LINE).length - 1, 1, harnessOutput(result));
    assert.match(result.stdout, /REACHED: post-migration deploy steps/);
    assert.equal(result.exitState, 'activated=1 flipped=1 committed=0');
    assert.equal(result.activeFlows, 'new');
    assert.deepEqual(result.liveLedger, candidateHashes());
    assert.equal(result.identityd, '1');
  });
});

// Each step that can fail during activation, injected after a successful
// staging run. The live ledger files each scenario must leave behind: before
// any rename the previous pair; the post-activation check runs after all three
// renames, and the installer does not undo them.
const ACTIVATION_FAILURES = [
  ['digest verification', 'printf "\\n" >> "$COMMAND_LEDGER_STAGE/osi-watermark-binding/canonicalization.js"', {}, oldPairHashes],
  ['the installer', 'printf "%s\\n" "console.error(\\"injected installer failure\\"); process.exit(1);" > "$COMMAND_LEDGER_INSTALLER"', {}, oldPairHashes],
  ['the move into place', 'mkdir -p "$NODE_RED_ROOT/osi-watermark-binding" && chmod 555 "$NODE_RED_ROOT/osi-watermark-binding"', { skipAsRoot: true }, oldPairHashes],
  ['the post-activation check', 'NODE_OPTIONS="--require $ROOT_DIR/fail-live-ledger-load.js"; export NODE_OPTIONS', { preload: true }, candidateHashes],
];

for (const [step, inject, options, expectedLedger] of ACTIVATION_FAILURES) {
  test(`a failing activation step (${step}) aborts the deploy before the payload flip`, (t) => {
    if (options.skipAsRoot && typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root ignores directory permissions');
      return;
    }
    withActivationRoot((root) => {
      if (options.preload) {
        // Fails only the installer's fresh-process load of the LIVE ledger,
        // which it runs after moving the candidate into place.
        fs.writeFileSync(path.join(root, 'fail-live-ledger-load.js'),
          `if (process.argv.includes(${JSON.stringify(path.join(root, 'node-red', 'osi-command-ledger'))})) {\n` +
          "  console.error('injected post-activation load failure');\n  process.exit(42);\n}\n");
      }
      const result = runActivationHarness(root, inject);
      assert.notEqual(result.status, 0, `deploy must fail when ${step} fails\n${harnessOutput(result)}`);
      assert.doesNotMatch(result.stdout, new RegExp(ACTIVATED_LINE), harnessOutput(result));
      assert.doesNotMatch(result.stdout, /REACHED: post-migration deploy steps/);
      assert.doesNotMatch(result.stdout, /OK: activated flows\+GUI payloads\/new/);
      assert.equal(result.exitState, 'activated=0 flipped=0 committed=0', harnessOutput(result));
      // The existing failure path of the schema phase: the staged payload is
      // discarded and the previous, schema-compatible payload restarted.
      assert.equal(result.activeFlows, 'prev');
      assert.equal(result.newPayloadKept, false);
      assert.equal(result.nodeRed, '1', 'the previous payload must be running again');
      assert.equal(result.identityd, '1', 'identityd must be restored');
      assert.deepEqual(result.liveLedger, expectedLedger());
    });
  });
}

test('a failing activation after a committed migration holds services on the previous payload', () => {
  withActivationRoot((root) => {
    const result = runActivationHarness(root,
      'printf "%s\\n" "process.exit(1);" > "$COMMAND_LEDGER_INSTALLER"',
      { HARNESS_MIGRATION_COMMITS: '1' });
    assert.notEqual(result.status, 0, harnessOutput(result));
    assert.doesNotMatch(result.stdout, new RegExp(ACTIVATED_LINE), harnessOutput(result));
    assert.equal(result.exitState, 'activated=0 flipped=0 committed=1', harnessOutput(result));
    // The previous payload was recorded for the pre-migration head, so the
    // existing path refuses to restart it and holds both services stopped.
    assert.match(result.stderr, /migrated database has no proven compatible active payload; keeping Node-RED stopped/);
    assert.equal(result.activeFlows, 'prev');
    assert.equal(result.newPayloadKept, false);
    assert.equal(result.nodeRed, '0');
    assert.equal(result.identityd, '0');
    assert.deepEqual(result.liveLedger, oldPairHashes());
  });
});

test('staging returns failure from inside a condition when a fetch fails', () => {
  withActivationRoot((root) => {
    const tmp = path.join(root, 'tmp');
    const stage = path.join(root, 'node-red', '.osi-command-ledger-stage.harness');
    fs.mkdirSync(tmp, { recursive: true });
    const script = `set -eu
REPO_ROOT=${shellQuote(ROOT)}
TMP_DIR=${shellQuote(tmp)}
NODE_RED_ROOT=${shellQuote(path.join(root, 'node-red'))}
COMMAND_LEDGER_STAGE_ROOT="$NODE_RED_ROOT"
COMMAND_LEDGER_STAGE=${shellQuote(stage)}
COMMAND_LEDGER_INSTALLER="$TMP_DIR/deploy-command-ledger-dependency.js"
${commandLedgerPins()}
mkdir -p "$NODE_RED_ROOT"
fetch() {
    mkdir -p "$(dirname "$2")"
    if [ "$1" = "$HARNESS_FAIL_FETCH" ]; then
        return 22
    fi
    cp "$REPO_ROOT/$1" "$2"
}
${shellFunction('fetch_required')}
${shellFunction('stage_command_ledger_dependency')}
if stage_command_ledger_dependency; then
    echo "STAGE-RC=0"
else
    echo "STAGE-RC=$?"
fi
`;
    const result = spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_FAIL_FETCH: 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js' },
      timeout: 60000,
    });
    assert.equal(result.status, 0, harnessOutput(result));
    assert.doesNotMatch(result.stdout, /STAGE-RC=0/, harnessOutput(result));
    assert.match(result.stdout, /STAGE-RC=[1-9]/);
    assert.doesNotMatch(result.stdout, new RegExp(STAGED_LINE));
    assert.doesNotMatch(result.stdout, /--- osi-command-ledger index\.js ---\nOK\n/,
      'fetch_required must not report OK for a failed fetch');
    assert.doesNotMatch(result.stdout, /--- osi-watermark-binding canonicalization\.js ---/,
      'staging must stop at the failed fetch');
  });
});

// --- Migration runner fetch -------------------------------------------------
//
// The bundled seed of a main commit before migration 0068 is a real database
// stamped at 0067. These tests run the shipped fetch_migration_runner and the
// real migrate-cli.js and verify-head-cli.js against a copy of it.

let preMigrationDb = null;
function preMigrationDbFile() {
  if (!preMigrationDb) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-pre-0068-db-'));
    preMigrationDb = path.join(dir, 'farming.db');
    fs.writeFileSync(preMigrationDb, execFileSync('git', ['show', `${PRE_0068_MAIN_COMMIT}:conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  return preMigrationDb;
}

function dbHead(root) {
  return execFileSync('sqlite3', [path.join(root, 'farming.db'), "SELECT MAX(version) FROM schema_migrations WHERE status='applied'"], { encoding: 'utf8' }).trim();
}

const MIGRATION_NAMES = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/CHECKSUMS.json'), 'utf8'))).sort();
const LAST_MIGRATION = MIGRATION_NAMES[MIGRATION_NAMES.length - 1];
const LAST_VERSION = String(Number(LAST_MIGRATION.slice(0, 4)));

function runRunnerHarness(root, env = {}, inject = ':') {
  return runActivationHarness(root, inject, { HARNESS_REAL_MIGRATE: '1', HARNESS_DB_SOURCE: preMigrationDbFile(), ...env }, { realRunner: true });
}

test('the real migration runner takes a pre-0068 database to head and activates the ledger', () => {
  assert.equal(LAST_MIGRATION.slice(0, 4), '0068', 'these tests assume 0068 is the newest migration on this line');
  withActivationRoot((root) => {
    const result = runRunnerHarness(root);
    assert.equal(result.status, 0, harnessOutput(result));
    assert.equal(dbHead(root), LAST_VERSION);
    assert.equal(result.exitState, 'activated=1 flipped=1 committed=1');
    assert.equal(result.activeFlows, 'new');
  });
});

const RUNNER_FETCH_TARGETS = [
  [`database/migrations/ordered/${LAST_MIGRATION}`, LAST_MIGRATION],
  ['database/migrations/ordered/CHECKSUMS.json', 'CHECKSUMS.json'],
  ['lib/osi-migrate/runner.js', 'runner.js'],
];

for (const [target, name] of RUNNER_FETCH_TARGETS) {
  for (const fault of ['missing', 'truncated', 'empty', 'unwritten']) {
    test(`a ${fault} download of ${name} stops the deploy before the migration`, () => {
      withActivationRoot((root) => {
        const result = runRunnerHarness(root, { HARNESS_FETCH_PATH: target, HARNESS_FETCH_FAULT: fault });
        assert.notEqual(result.status, 0, harnessOutput(result));
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(result.stderr, new RegExp(`ERROR: [^\\n]*${escaped}`), harnessOutput(result));
        assert.doesNotMatch(result.stdout, /\[migrate\] applied/, harnessOutput(result));
        assert.doesNotMatch(result.stdout, /--- Stop Node-RED for schema migration ---/);
        assert.equal(dbHead(root), '67', 'nothing may be migrated');
        assert.equal(result.exitState, 'activated=0 flipped=0 committed=0', harnessOutput(result));
        assert.equal(result.activeFlows, 'prev');
        assert.equal(result.newPayloadKept, false);
        // The fetch runs before Node-RED is stopped for the migration: it was
        // never stopped and identityd is restored.
        assert.doesNotMatch(result.nodeRedLog, /stop/);
        assert.equal(result.nodeRed, '1');
        assert.equal(result.identityd, '1');
        assert.deepEqual(result.liveLedger, oldPairHashes());
      });
    });
  }
}

// --- Other steps of the schema phase that ran without set -e ------------------

function assertSchemaPhaseStopped(result, message, { nodeRedStopped }) {
  assert.notEqual(result.status, 0, harnessOutput(result));
  assert.match(result.stderr, message, harnessOutput(result));
  assert.doesNotMatch(result.stdout, /\[migrate\] applied/, harnessOutput(result));
  assert.equal(result.exitState, 'activated=0 flipped=0 committed=0', harnessOutput(result));
  assert.equal(result.activeFlows, 'prev');
  assert.equal(result.newPayloadKept, false);
  assert.equal(/stop/.test(result.nodeRedLog), nodeRedStopped, harnessOutput(result));
  // Never stopped, or restarted on the previous payload: running either way.
  assert.equal(result.nodeRed, '1');
  assert.equal(result.identityd, '1');
}

test('a failed fetch of the reconciliation assets stops the deploy at that step', () => {
  withActivationRoot((root) => {
    const result = runActivationHarness(root, ':', {
      HARNESS_FOREIGN_ROW: '1',
      HARNESS_FETCH_PATH: 'scripts/reconcile-ledger-numbering.js',
    });
    assert.match(result.stdout, /Foreign-numbered schema_migrations ledger detected/, harnessOutput(result));
    assertSchemaPhaseStopped(result, /ERROR: could not fetch scripts\/reconcile-ledger-numbering\.js/, { nodeRedStopped: true });
    assert.match(result.stderr, /ERROR: could not fetch the ledger numbering reconciliation assets/);
    assert.doesNotMatch(result.stderr, /Cannot find module/, 'the reconciliation tool must not be started');
  });
});

test('a migration backup directory that cannot be created stops the deploy at that step', () => {
  withActivationRoot((root) => {
    const result = runActivationHarness(root, 'printf x > "$TMP_DIR/blocker"; MIGRATE_BACKUP_DIR="$TMP_DIR/blocker/backups"');
    assertSchemaPhaseStopped(result, /ERROR: could not create the migration backup directory/, { nodeRedStopped: false });
  });
});

test('a failed ledger read in the reconciliation probe stops the deploy at that step', () => {
  withActivationRoot((root) => {
    const result = runActivationHarness(root,
      'sqlite3() { case "$*" in *"version > 21"*) return 1 ;; esac; command sqlite3 "$@"; }');
    assertSchemaPhaseStopped(result, /ERROR: could not read the schema_migrations ledger for the reconciliation probe/, { nodeRedStopped: true });
  });
});

test('a failed comparison in the reconciliation probe stops the deploy at that step', () => {
  withActivationRoot((root) => {
    const result = runActivationHarness(root,
      'node() { case "$2" in *ledgerChecksum*) return 1 ;; esac; command node "$@"; }');
    assertSchemaPhaseStopped(result, /ERROR: the reconciliation probe could not compare the ledger with CHECKSUMS\.json/, { nodeRedStopped: true });
  });
});
