'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CLI_PATH = path.join(__dirname, 'sync-protocol-capability-cli.js');
const cli = require('./sync-protocol-capability-cli');

const tempDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-protocol-cli-test-'));
  tempDirs.push(d);
  return d;
}

test.after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function runCli(argv) {
  const result = cp.spawnSync(process.execPath, [CLI_PATH, ...argv], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function rootFlags(tmp) {
  return [
    '--root', path.join(tmp, 'osi-sync'),
    '--witness-root', path.join(tmp, 'osi-sync-witness', 'protocol-capability-witnesses'),
    '--activity-witness-root', path.join(tmp, 'osi-sync-witness', 'command-activity-witnesses'),
  ];
}

function writeDeploymentState(tmp, obj) {
  const p = path.join(tmp, 'osi-deploy', 'deployment-state.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function initializeFlags(tmp, overrides) {
  // Real deployment-state envelope (repair-program plan line 160):
  // {format:2, parentDeployment, activeSubOperation} with identity/phase/
  // generation nested under parentDeployment.
  const o = overrides || {};
  const stateObj = {
    format: 2,
    parentDeployment: Object.assign(
      { deploymentId: 'dep-1', phase: 'protocol-initializing', generation: 0, leaseActive: true },
      o.parentDeployment
    ),
    activeSubOperation: o.activeSubOperation !== undefined ? o.activeSubOperation : null,
  };
  const statePath = writeDeploymentState(tmp, stateObj);
  return [
    'initialize',
    ...rootFlags(tmp),
    '--deployment-state', statePath,
    '--expected-deployment-id', (overrides && overrides.expectedDeploymentId) || 'dep-1',
    '--expected-phase', (overrides && overrides.expectedPhase) || 'protocol-initializing',
    '--expected-parent-generation', String((overrides && overrides.expectedParentGeneration) != null ? overrides.expectedParentGeneration : 0),
    '--operation-id', (overrides && overrides.operationId) || '11111111-1111-4111-8111-111111111111',
    '--ack-audit-report', path.join(tmp, 'ack.json'),
    '--backup-manifest', path.join(tmp, 'backup.json'),
    '--expected-capability-head-sha256', 'absent',
    '--expected-witness-head-sha256', 'absent',
  ];
}

// ===========================================================================
// initialize / status happy path
// ===========================================================================

test('CLI initialize: positive path with a protocol-initializing deployment-state creates the roots', () => {
  const tmp = tmpDir();
  const result = runCli(initializeFlags(tmp));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.operationResult, 'CREATED');
  assert.equal(parsed.mode, 'UNNEGOTIATED');
  assert.equal(parsed.activeIdentitySha256, null);
  assert.match(parsed.capabilityHeadSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(tmp, 'osi-sync', 'protocol-capabilities', 'head.json')), true);
});

test('CLI initialize: re-running against an already-initialized root set is idempotent', () => {
  const tmp = tmpDir();
  const flags = initializeFlags(tmp);
  const first = runCli(flags);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(flags);
  assert.equal(second.status, 0, second.stderr);
  const parsed = JSON.parse(second.stdout.trim());
  assert.equal(parsed.operationResult, 'ALREADY_INITIALIZED');
});

test('CLI initialize: wrong deployment-state phase is rejected and creates nothing', () => {
  const tmp = tmpDir();
  const result = runCli(initializeFlags(tmp, { parentDeployment: { phase: 'protocol-dispositioning' } }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deployment_state_wrong_phase/);
  assert.equal(fs.existsSync(path.join(tmp, 'osi-sync')), false);
});

test('CLI initialize: a non-null activeSubOperation is rejected and creates nothing', () => {
  const tmp = tmpDir();
  const result = runCli(
    initializeFlags(tmp, { activeSubOperation: { kind: 'recovery', operationId: '33333333-3333-4333-8333-333333333333', phase: 'recovering' } })
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deployment_state_active_sub_operation/);
  assert.equal(fs.existsSync(path.join(tmp, 'osi-sync')), false);
});

test('CLI initialize: a legacy format-1 deployment-state is rejected', () => {
  const tmp = tmpDir();
  const flags = initializeFlags(tmp);
  // Overwrite the fixture with a format-1 envelope at the same path.
  writeDeploymentState(tmp, { format: 1, deploymentId: 'dep-1', phase: 'protocol-initializing', parentGeneration: 0 });
  const result = runCli(flags);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(tmp, 'osi-sync')), false);
});

test('CLI initialize: deployment/expected id mismatch is rejected', () => {
  const tmp = tmpDir();
  const result = runCli(initializeFlags(tmp, { expectedDeploymentId: 'dep-other' }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deployment_state_wrong_deployment_id/);
});

test('CLI status: healthy roots report HEALTHY', () => {
  const tmp = tmpDir();
  const init = runCli(initializeFlags(tmp));
  assert.equal(init.status, 0, init.stderr);
  const result = runCli(['status', ...rootFlags(tmp)]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.operationResult, 'HEALTHY');
});

test('CLI status: uninitialized roots report UNINITIALIZED without creating anything', () => {
  const tmp = tmpDir();
  const result = runCli(['status', ...rootFlags(tmp)]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.operationResult, 'UNINITIALIZED');
  assert.equal(fs.existsSync(path.join(tmp, 'osi-sync')), false);
});

test('CLI status: corrupt roots (forked generation) exit nonzero', () => {
  const tmp = tmpDir();
  const init = runCli(initializeFlags(tmp));
  assert.equal(init.status, 0, init.stderr);
  // Corrupt the genesis generation file's operationId after the fact so its
  // canonical hash no longer matches head.json's recorded generationSha256.
  const genPath = path.join(tmp, 'osi-sync', 'protocol-capabilities', 'generations', '0000000000000000.json');
  const gen = JSON.parse(fs.readFileSync(genPath, 'utf8'));
  gen.operationId = '99999999-9999-4999-8999-999999999999';
  fs.writeFileSync(genPath, JSON.stringify(gen));
  const result = runCli(['status', ...rootFlags(tmp)]);
  assert.notEqual(result.status, 0);
});

// ===========================================================================
// every not-implemented verb exits nonzero, bounded
// ===========================================================================

function dummyValueForType(spec) {
  if (typeof spec === 'function') return 'not-applicable';
  if (spec === 'string') return 'x';
  if (spec === 'generation') return '0';
  if (spec === 'sha256') return 'a'.repeat(64);
  if (spec === 'sha256OrAbsent') return 'absent';
  return 'x'; // 'path' is handled by the caller (needs an absolute tmp path)
}

function dummyArgvForVerb(verb, tmp) {
  const spec = cli.VERB_FLAGS[verb];
  const argv = [verb];
  let counter = 0;
  for (const [flag, type] of Object.entries(spec)) {
    argv.push(flag);
    if (type === 'path') {
      counter += 1;
      argv.push(path.join(tmp, `dummy-${counter}.json`));
    } else {
      argv.push(dummyValueForType(type));
    }
  }
  return argv;
}

test('CLI: every not-implemented verb is pinned in the verb table and exits nonzero with a bounded error', () => {
  for (const verb of cli.NOT_IMPLEMENTED_VERBS) {
    const tmp = tmpDir();
    const result = runCli(dummyArgvForVerb(verb, tmp));
    assert.notEqual(result.status, 0, `verb "${verb}" should exit nonzero`);
    assert.match(result.stderr, /NOT_IMPLEMENTED_IN_THIS_SLICE/, `verb "${verb}" should report the bounded not-implemented error: ${result.stderr}`);
    // Bounded: it must not have created any of the four roots.
    assert.equal(fs.existsSync(path.join(tmp, 'osi-sync')), false, `verb "${verb}" must not create the capability root`);
  }
});

test('CLI: an unknown verb exits nonzero', () => {
  const tmp = tmpDir();
  const result = runCli(['not-a-real-verb', ...rootFlags(tmp)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_unknown_verb/);
});

test('CLI: a missing verb exits nonzero', () => {
  const result = runCli([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_missing_verb/);
});

// ===========================================================================
// unknown/duplicate flags, relative/symlinked paths, extra positionals
// ===========================================================================

test('CLI: an unknown flag fails', () => {
  const tmp = tmpDir();
  const result = runCli(['status', ...rootFlags(tmp), '--bogus-flag', 'x']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_unknown_flag/);
});

test('CLI: a duplicate flag fails', () => {
  const tmp = tmpDir();
  const result = runCli(['status', ...rootFlags(tmp), '--root', path.join(tmp, 'other')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_duplicate_flag/);
});

test('CLI: a missing required flag fails', () => {
  const tmp = tmpDir();
  const result = runCli(['status', '--root', path.join(tmp, 'osi-sync')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_flag_missing/);
});

test('CLI: an extra positional argument fails', () => {
  const tmp = tmpDir();
  const result = runCli(['status', ...rootFlags(tmp), 'extra-positional']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_unexpected_positional_argument/);
});

test('CLI: a flag missing its value fails', () => {
  const tmp = tmpDir();
  const result = runCli(['status', '--root', path.join(tmp, 'osi-sync'), '--witness-root']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_flag_missing_value/);
});

test('CLI: a relative path flag value fails', () => {
  const result = runCli(['status', '--root', 'relative/osi-sync', '--witness-root', '/tmp/w', '--activity-witness-root', '/tmp/a']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_flag_not_absolute_path/);
});

test('CLI: a symlinked path component in a flag value fails', () => {
  const tmp = tmpDir();
  const real = path.join(tmp, 'real-dir');
  fs.mkdirSync(real);
  const link = path.join(tmp, 'link-dir');
  fs.symlinkSync(real, link);
  const result = runCli(['status', '--root', path.join(link, 'osi-sync'), '--witness-root', path.join(tmp, 'w'), '--activity-witness-root', path.join(tmp, 'a')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink_component/);
});

test('CLI: an invalid generation value fails', () => {
  const tmp = tmpDir();
  const flags = initializeFlags(tmp);
  const idx = flags.indexOf('--expected-parent-generation');
  flags[idx + 1] = '-1';
  const result = runCli(flags);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_flag_invalid_generation/);
});

test('CLI: an invalid sha256 value fails', () => {
  const tmp = tmpDir();
  const flags = initializeFlags(tmp);
  const idx = flags.indexOf('--expected-capability-head-sha256');
  flags[idx + 1] = 'not-a-sha';
  const result = runCli(flags);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cli_flag_invalid_sha256/);
});
