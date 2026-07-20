'use strict';

// Direct + CLI-spawn tests for the ordinary Train A deployment-state
// lifecycle (A0 commit-1 sub-tranche). See
// docs/superpowers/plans/2026-07-15-refactor-repair-program.md Task A0 and
// /tmp/.../scratchpad/briefs/deployment-state-core-brief.md for scope.
//
// Section 1 (this checkpoint): codec/envelope unit tests against
// scripts/lib/deployment-state.js directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const lib = require('./lib/deployment-state');

const CLI = path.join(__dirname, 'deployment-state-cli.js');
const TEST_BOUNDARY = path.join(os.tmpdir(), `osi-deploy-startup-tests-${process.getuid()}`);
test.beforeEach(() => {
  fs.mkdirSync(TEST_BOUNDARY, { recursive: true, mode: 0o700 });
  fs.chmodSync(TEST_BOUNDARY, 0o700);
  const mutationMountInfo = path.join(TEST_BOUNDARY, 'mutation-mountinfo.test');
  fs.writeFileSync(mutationMountInfo,
    `36 25 8:1 / ${TEST_BOUNDARY} rw,relatime - ext4 /dev/osi-test rw\n`, { mode: 0o600 });
  fs.chmodSync(mutationMountInfo, 0o600);
  process.env.OSI_REPAIR_PROGRAM_MODE = '1';
  process.env.OSI_DEPLOY_ARTIFACT_MODE = 'test';
  process.env.OSI_DEPLOY_TEST_BOUNDARY = TEST_BOUNDARY;
  process.env.OSI_DEPLOY_MUTATION_TEST_MOUNTINFO = mutationMountInfo;
});
test.afterEach(() => {
  delete process.env.OSI_REPAIR_PROGRAM_MODE;
  delete process.env.OSI_DEPLOY_ARTIFACT_MODE;
  delete process.env.OSI_DEPLOY_TEST_BOUNDARY;
  delete process.env.OSI_DEPLOY_MUTATION_TEST_MOUNTINFO;
});

function runCli(args, opts = {}) {
  let effectiveArgs = args;
  if (args[0] === 'startup-check' && args.includes('--consume-probe-permit')
      && !args.includes('--supervisor-pid')) {
    effectiveArgs = [...args, '--supervisor-pid', String(process.pid),
      '--supervisor-process-starttime', testProcessStartTime(process.pid)];
  }
  const rootIndex = ['startup-check', 'record-launch-start'].includes(effectiveArgs[0]) ? effectiveArgs.indexOf('--root') : -1;
  const startupRoot = rootIndex >= 0 ? effectiveArgs[rootIndex + 1] : null;
  const guardRootIndex = effectiveArgs.indexOf('--guard-bootstrap-root');
  const guardRoot = guardRootIndex >= 0 ? effectiveArgs[guardRootIndex + 1] : null;
  const startupTestEnv = startupRoot ? {
    OSI_DEPLOY_STARTUP_TEST_MOUNTINFO: path.join(startupRoot, 'mountinfo.test'),
  } : guardRoot ? {
    OSI_DEPLOY_STARTUP_TEST_MOUNTINFO: path.join(path.dirname(guardRoot), 'mountinfo.test'),
  } : {};
  const artifactTestEnv = {
    OSI_DEPLOY_ARTIFACT_MODE: 'test',
    OSI_DEPLOY_TEST_BOUNDARY: path.join(os.tmpdir(), `osi-deploy-startup-tests-${process.getuid()}`),
    OSI_DEPLOY_TEST_BOOT_ID: GB1,
  };
  return spawnSync(process.execPath, [CLI, ...effectiveArgs], {
    encoding: 'utf8',
    ...opts,
    env: { ...process.env, ...artifactTestEnv, ...startupTestEnv, ...(opts.env || {}) },
  });
}

function runCliOk(args, opts = {}) {
  const res = runCli(args, opts);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function runCliFail(args, opts = {}) {
  const res = runCli(args, opts);
  assert.notEqual(res.status, 0, `expected nonzero exit, got 0\nstdout: ${res.stdout}`);
  let parsed = null;
  try {
    parsed = JSON.parse(res.stderr);
  } catch (_err) {
    // fall through with parsed === null; caller can inspect res directly
  }
  return { res, parsed };
}

function writeJsonFile(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

function tmpDir() {
  const boundary = path.join(os.tmpdir(), `osi-deploy-startup-tests-${process.getuid()}`);
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  fs.chmodSync(boundary, 0o700);
  return fs.mkdtempSync(path.join(boundary, 'case-'));
}

function traceGuardFsEvents(fn) {
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalFsyncSync = fs.fsyncSync;
  const originalLinkSync = fs.linkSync;
  const fdPaths = new Map();
  const events = [];
  fs.openSync = (...args) => {
    const fd = originalOpenSync(...args);
    fdPaths.set(fd, path.resolve(String(args[0])));
    return fd;
  };
  fs.closeSync = (fd) => {
    try {
      return originalCloseSync(fd);
    } finally {
      fdPaths.delete(fd);
    }
  };
  fs.fsyncSync = (fd) => {
    const fsyncedPath = fdPaths.get(fd) || null;
    let directoryEntries = null;
    if (fsyncedPath && fs.existsSync(fsyncedPath) && fs.lstatSync(fsyncedPath).isDirectory()) {
      directoryEntries = fs.readdirSync(fsyncedPath).sort();
    }
    events.push({ kind: 'fsync', path: fsyncedPath, directoryEntries });
    return originalFsyncSync(fd);
  };
  fs.linkSync = (existingPath, newPath) => {
    events.push({ kind: 'link', path: path.resolve(String(newPath)) });
    return originalLinkSync(existingPath, newPath);
  };
  try {
    return { result: fn(), events };
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.fsyncSync = originalFsyncSync;
    fs.linkSync = originalLinkSync;
  }
}

function assertGeneration1DurabilityTrace(events, { root, chainDir, generationPath }) {
  const rootParent = path.dirname(root);
  const rootParentFsync = events.findIndex((event) => event.kind === 'fsync' && event.path === rootParent);
  const rootFsync = events.findIndex((event) => event.kind === 'fsync' && event.path === root);
  const generationLink = events.findIndex((event) => event.kind === 'link' && event.path === generationPath);
  const chainFsync = events.findIndex((event, index) => (
    index > generationLink && event.kind === 'fsync' && event.path === chainDir
  ));
  assert.notEqual(rootParentFsync, -1, 'generation 1 must fsync the guard-root parent');
  assert.notEqual(rootFsync, -1, 'generation 1 must fsync the guard root');
  assert.notEqual(generationLink, -1, 'generation 1 must link its immutable entry');
  assert.notEqual(chainFsync, -1, 'generation 1 must fsync the chain directory after link');
  assert.ok(
    events[rootParentFsync].directoryEntries.includes(path.basename(root)),
    'guard-root parent fsync must observe the guard root'
  );
  assert.ok(
    events[rootFsync].directoryEntries.includes(path.basename(chainDir)),
    'guard-root fsync must observe the chain directory'
  );
  assert.ok(rootParentFsync < rootFsync, 'guard-root parent fsync must precede guard-root fsync');
  assert.ok(rootFsync < generationLink, 'guard-root fsync must precede generation-1 link');
  assert.ok(generationLink < chainFsync, 'chain-directory fsync must follow generation-1 link');
}

function baseParentDeployment(overrides = {}) {
  return {
    deploymentId: 'dep-0001',
    phase: 'armed',
    leaseActive: true,
    generation: 1,
    attemptSha256: 'a'.repeat(64),
    targetCommitSha: 'deadbeefcafef00d',
    controllerGeneration: 1,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    databaseLineage: { status: 'not-applicable' },
    ...overrides,
  };
}

function baseEnvelope(overrides = {}) {
  return {
    format: 2,
    parentDeployment: baseParentDeployment(overrides.parentDeployment),
    activeSubOperation: overrides.activeSubOperation === undefined ? null : overrides.activeSubOperation,
  };
}

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

test('codec: accepts a well-formed format-2 envelope', () => {
  const env = baseEnvelope();
  assert.deepEqual(lib.validateEnvelope(env), env);
});

test('codec: rejects an unknown top-level field', () => {
  const env = baseEnvelope();
  env.extra = 'nope';
  assert.throws(() => lib.validateEnvelope(env), /unknown field/);
});

test('codec: rejects a missing top-level field', () => {
  const env = baseEnvelope();
  delete env.activeSubOperation;
  assert.throws(() => lib.validateEnvelope(env), /missing required field/);
});

test('codec: rejects format != 2', () => {
  const env = baseEnvelope();
  env.format = 1;
  assert.throws(() => lib.validateEnvelope(env), /format must be 2/);
});

test('codec: ordinary phase list matches the plan verbatim', () => {
  assert.deepEqual(lib.ORDINARY_PARENT_PHASES, [
    'armed',
    'writers-stopped',
    'protocol-initializing',
    'protocol-dispositioning',
    'protocol-ready',
    'protocol-reconciliation-required',
    'resident-mutating',
    'payload-mutating',
    'probes-running',
    'runtime-verified',
    'verification-in-flight',
    'completed',
    'recovered',
  ]);
});

test('codec: rejects the factory-only phase on parentDeployment', () => {
  const env = baseEnvelope({ parentDeployment: { phase: 'image-baseline-initializing' } });
  assert.throws(() => lib.validateEnvelope(env), /factory-only phase/);
});

test('codec: rejects an unrecognized phase', () => {
  const env = baseEnvelope({ parentDeployment: { phase: 'not-a-real-phase' } });
  assert.throws(() => lib.validateEnvelope(env), /parentDeployment\.phase/);
});

test('codec: rejects unknown field on parentDeployment', () => {
  const env = baseEnvelope();
  env.parentDeployment.notAField = true;
  assert.throws(() => lib.validateEnvelope(env), /unknown field/);
});

test('databaseLineage: accepts only the exact five-branch closed union', () => {
  const sha = 'a'.repeat(64);
  const cases = [
    { status: 'not-applicable' },
    { status: 'factory-pending', baselineId: 'baseline-1' },
    { status: 'valid', databaseLineageSha256: sha, seedReceiptSha256: 'b'.repeat(64) },
    { status: 'invalidating', databaseLineageSha256: sha, operationId: 'restore-1', reasonCode: 'general-database-restore' },
    { status: 'invalidated', databaseLineageSha256: sha, operationId: 'restore-1', invalidationReceiptSha256: 'c'.repeat(64) },
  ];
  for (const value of cases) assert.deepEqual(lib.validateDatabaseLineage(value), value);
});

test('databaseLineage: rejects missing, extra, and cross-branch fields', () => {
  const sha = 'a'.repeat(64);
  for (const value of [
    { status: 'not-applicable', baselineId: 'smuggled' },
    { status: 'factory-pending' },
    { status: 'factory-pending', baselineId: 'base', databaseLineageSha256: sha },
    { status: 'valid', databaseLineageSha256: sha },
    { status: 'valid', databaseLineageSha256: sha, seedReceiptSha256: 'b'.repeat(64), operationId: 'cross' },
    { status: 'invalidating', databaseLineageSha256: sha, operationId: 'op' },
    { status: 'invalidating', databaseLineageSha256: sha, operationId: 'op', reasonCode: 'restore', invalidationReceiptSha256: sha },
    { status: 'invalidated', databaseLineageSha256: sha, operationId: 'op' },
    { status: 'invalidated', databaseLineageSha256: sha, operationId: 'op', invalidationReceiptSha256: sha, reasonCode: 'cross' },
  ]) {
    assert.throws(() => lib.validateDatabaseLineage(value));
  }
});

// ---------------------------------------------------------------------------
// receipt-kind enum
// ---------------------------------------------------------------------------

test('codec: receipt-kind enum matches the plan verbatim', () => {
  assert.deepEqual(lib.RECEIPT_KINDS, [
    'deployment',
    'rehearsal',
    'recovery',
    'acceptance',
    'abandonment',
    'staging-gc',
    'topology-activation',
    'factory-seed',
    'factory-protocol-zero',
    'database-lineage-invalidation',
  ]);
});

// ---------------------------------------------------------------------------
// restoredPredecessor closed union
// ---------------------------------------------------------------------------

function managedTerminalPredecessor(overrides = {}) {
  return {
    kind: 'managed-terminal',
    deploymentId: 'dep-0000',
    terminalTupleSha256: 'b'.repeat(64),
    ...overrides,
  };
}

function legacyCompatibilityPredecessor(overrides = {}) {
  return {
    kind: 'legacy-compatibility',
    compatibilityManifestSha256: 'c'.repeat(64),
    topologySha256: 'd'.repeat(64),
    databaseIdentitySha256: 'e'.repeat(64),
    flowStamp: '2026-07-01T00-00-00Z',
    ...overrides,
  };
}

test('restoredPredecessor: accepts managed-terminal branch', () => {
  const obj = managedTerminalPredecessor();
  assert.deepEqual(lib.validateRestoredPredecessor(obj), obj);
});

test('restoredPredecessor: accepts legacy-compatibility branch', () => {
  const obj = legacyCompatibilityPredecessor();
  assert.deepEqual(lib.validateRestoredPredecessor(obj), obj);
});

test('restoredPredecessor: rejects cross-kind fields (legacy field on managed-terminal)', () => {
  const obj = managedTerminalPredecessor({ flowStamp: 'nope' });
  assert.throws(() => lib.validateRestoredPredecessor(obj), /unknown field/);
});

test('restoredPredecessor: rejects cross-kind fields (managed field on legacy-compatibility)', () => {
  const obj = legacyCompatibilityPredecessor({ terminalTupleSha256: 'f'.repeat(64) });
  assert.throws(() => lib.validateRestoredPredecessor(obj), /unknown field/);
});

test('restoredPredecessor: rejects missing field in chosen branch', () => {
  const obj = managedTerminalPredecessor();
  delete obj.terminalTupleSha256;
  assert.throws(() => lib.validateRestoredPredecessor(obj), /missing required field/);
});

test('restoredPredecessor: rejects unknown kind', () => {
  assert.throws(
    () => lib.validateRestoredPredecessor({ kind: 'mystery' }),
    /restoredPredecessor\.kind/
  );
});

test('restoredPredecessor: canonical hash is stable across key order', () => {
  const a = managedTerminalPredecessor();
  const b = { terminalTupleSha256: a.terminalTupleSha256, kind: a.kind, deploymentId: a.deploymentId };
  assert.equal(lib.restoredPredecessorSha256(a), lib.restoredPredecessorSha256(b));
});

// ---------------------------------------------------------------------------
// Terminal-receipts identity, phase-discriminated
// ---------------------------------------------------------------------------

test('terminalReceiptIdentity: verification-in-flight requires exactly deploymentReceiptSha256', () => {
  const ok = { deploymentReceiptSha256: 'a'.repeat(64) };
  assert.deepEqual(lib.validateTerminalReceiptIdentity('verification-in-flight', ok), ok);
  assert.throws(
    () => lib.validateTerminalReceiptIdentity('verification-in-flight', { ...ok, extra: 1 }),
    /unknown field/
  );
});

test('terminalReceiptIdentity: ordinary completed requires completionKind+both receipts, nothing else', () => {
  const ok = {
    completionKind: 'deployment',
    deploymentReceiptSha256: 'a'.repeat(64),
    acceptanceReceiptSha256: 'b'.repeat(64),
  };
  assert.deepEqual(lib.validateTerminalReceiptIdentity('completed', ok), ok);
  assert.throws(
    () => lib.validateTerminalReceiptIdentity('completed', { ...ok, factorySeedReceiptSha256: 'c'.repeat(64) }),
    /unknown field/
  );
});

test('terminalReceiptIdentity: factory completed validates shape only (codec-level)', () => {
  const ok = {
    completionKind: 'factory-baseline',
    deploymentReceiptSha256: 'a'.repeat(64),
    acceptanceReceiptSha256: 'b'.repeat(64),
    factorySeedReceiptSha256: 'c'.repeat(64),
    databaseLineageSha256: 'd'.repeat(64),
    factoryProtocolZeroReceiptSha256: 'e'.repeat(64),
    historicalV2DispositionReceiptSha256: 'f'.repeat(64),
    factoryCapabilityAnchorSha256: '1'.repeat(64),
    factoryWitnessAnchorSha256: '2'.repeat(64),
    factoryCommandActivityAnchorSha256: '3'.repeat(64),
  };
  assert.deepEqual(lib.validateTerminalReceiptIdentity('completed', ok), ok);
});

test('parentDeployment: factory completionKind is rejected even with no other unknown fields (factory CAS out of scope)', () => {
  // parentDeployment's live schema deliberately has no room for the
  // factory-only receipt/anchor fields (no in-scope verb ever produces
  // them), so this exercises the dedicated out-of-scope rejection branch
  // rather than a generic unknown-field error.
  const env = baseEnvelope({
    parentDeployment: {
      phase: 'completed',
      completionKind: 'factory-baseline',
    },
  });
  assert.throws(() => lib.validateEnvelope(env), /factory-completion-rejected|out of scope/);
});

test('parentDeployment: a completed factory tuple smuggled via extra fields is still rejected (unknown-field)', () => {
  const env = baseEnvelope({
    parentDeployment: {
      phase: 'completed',
      completionKind: 'factory-baseline',
      deploymentReceiptSha256: 'a'.repeat(64),
      acceptanceReceiptSha256: 'b'.repeat(64),
      factorySeedReceiptSha256: 'c'.repeat(64),
      databaseLineageSha256: 'd'.repeat(64),
      factoryProtocolZeroReceiptSha256: 'e'.repeat(64),
      historicalV2DispositionReceiptSha256: 'f'.repeat(64),
      factoryCapabilityAnchorSha256: '1'.repeat(64),
      factoryWitnessAnchorSha256: '2'.repeat(64),
      factoryCommandActivityAnchorSha256: '3'.repeat(64),
    },
  });
  assert.throws(() => lib.validateEnvelope(env), /unknown field/);
});

test('terminalReceiptIdentity: recovered requires restoredPredecessorSha256 to match restoredPredecessor', () => {
  const restoredPredecessor = managedTerminalPredecessor();
  const ok = {
    recoveryReceiptSha256: 'a'.repeat(64),
    topologyActivationReceiptSha256: 'b'.repeat(64),
    restoredPredecessor,
    restoredPredecessorSha256: lib.restoredPredecessorSha256(restoredPredecessor),
  };
  assert.deepEqual(lib.validateTerminalReceiptIdentity('recovered', ok), ok);
  const bad = { ...ok, restoredPredecessorSha256: 'f'.repeat(64) };
  assert.throws(() => lib.validateTerminalReceiptIdentity('recovered', bad), /hash-mismatch|does not match/);
});

test('parentDeployment: a recovered lease can be reactivated only by an exact linked recovery', () => {
  const restoredPredecessor = managedTerminalPredecessor();
  const envelope = baseEnvelope({ parentDeployment: {
    phase: 'recovered', leaseActive: true, recoveryOperationId: 'rec-prior',
    recoveryReceiptSha256: 'a'.repeat(64),
    topologyActivationReceiptSha256: 'b'.repeat(64),
    restoredPredecessor,
    restoredPredecessorSha256: lib.restoredPredecessorSha256(restoredPredecessor),
  } });
  assert.throws(() => lib.validateEnvelope(envelope), /linked recovery|cross-link-mismatch/);
});

// ---------------------------------------------------------------------------
// Atomic + fsynced write/read, root-only + symlink rejection
// ---------------------------------------------------------------------------

test('writeState + readState round-trip', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'deployment-state.json');
  const env = baseEnvelope();
  lib.writeState(statePath, env);
  const stat = fs.statSync(statePath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(lib.readState(statePath), env);
});

test('readState returns null when the file does not exist', () => {
  const dir = tmpDir();
  assert.equal(lib.readState(path.join(dir, 'nope.json')), null);
});

test('readState rejects a symlinked state path', () => {
  const dir = tmpDir();
  const real = path.join(dir, 'real-state.json');
  lib.writeState(real, baseEnvelope());
  const link = path.join(dir, 'deployment-state.json');
  fs.symlinkSync(real, link);
  assert.throws(() => lib.readState(link), /symlink/);
});

test('readState rejects a file with the wrong mode', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'deployment-state.json');
  lib.writeState(statePath, baseEnvelope());
  fs.chmodSync(statePath, 0o644);
  assert.throws(() => lib.readState(statePath), /mode/);
});

test('writeJsonExclusive refuses to reuse an existing path', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'receipts', 'op1.deployment.json');
  lib.writeJsonExclusive(p, { a: 1 });
  assert.throws(() => lib.writeJsonExclusive(p, { a: 2 }), /exclusive-create-conflict|refusing to overwrite/);
});

test('immutable publication: operation identifiers are one shared bounded filename-safe type', () => {
  for (const value of ['ok-1', 'A_b.c', 'x'.repeat(128)]) {
    assert.equal(lib.validateOperationId(value, 'test id'), value);
  }
  for (const value of [
    '', '.', '..', '../escape', 'a/b', 'a\\b', 'a..b', 'line\nbreak',
    'x'.repeat(129), '\u00e9',
  ]) {
    assert.throws(() => lib.validateOperationId(value, 'test id'), /operation-id|filename-safe|bounded/);
  }
});

test('immutable publication: identifier validation precedes every interpolated receipt and attempt path', () => {
  const dir = tmpDir();
  for (const bad of ['../escape', 'a/b', 'a\\b', '..', 'x'.repeat(129)]) {
    assert.throws(() => lib.receiptPath(path.join(dir, 'receipts'), bad, 'deployment'));
    assert.throws(() => lib.attemptTombstonePath(path.join(dir, 'attempts'), bad));
  }
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('immutable publication: readReceipt applies the closed per-kind schema, including missing and extra fields', () => {
  const dir = tmpDir();
  const receipts = path.join(dir, 'receipts');
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const target = path.join(receipts, 'op-1.deployment.json');
  for (const malformed of [
    { ...validDeploymentReceiptContent(), unexpected: true },
    (() => { const value = validDeploymentReceiptContent(); delete value.result; return value; })(),
    { ...validDeploymentReceiptContent(), receiptKind: 'acceptance' },
  ]) {
    fs.writeFileSync(target, JSON.stringify(malformed), { mode: 0o600 });
    assert.throws(() => lib.readReceipt(receipts, 'op-1', 'deployment'));
    fs.rmSync(target);
  }
});

test('immutable publication: child death never exposes torn final JSON at any publication boundary', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'receipts', 'op-1.deployment.json');
  const body = validDeploymentReceiptContent();
  const script = [
    `const lib=require(${JSON.stringify(path.join(__dirname, 'lib', 'deployment-state.js'))})`,
    `lib.writeJsonExclusive(${JSON.stringify(target)},${JSON.stringify(body)},{crashLabelPrefix:'exclusive-test'})`,
  ].join(';');
  for (const boundary of ['mid-write', 'after-temp-fsync', 'after-link', 'after-unlink', 'after-parent-fsync']) {
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OSI_DEPLOY_ARTIFACT_MODE: 'test',
        OSI_DEPLOY_TEST_BOUNDARY: path.join(os.tmpdir(), `osi-deploy-startup-tests-${process.getuid()}`),
        OSI_DEPLOY_STATE_CRASH_AT: `exclusive-test:${boundary}`,
      },
    });
    assert.equal(child.status, 137, `${boundary}: ${child.stderr}`);
    if (fs.existsSync(target)) {
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), body, boundary);
      assert.equal(fs.statSync(target).mode & 0o777, 0o600, boundary);
    }
  }
});

test('immutable publication: retry after link or unlink re-fsyncs the exact target and parent before success', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'receipts', 'retry-durable.json');
  const body = Buffer.from('{"durable":true}\n');
  const modulePath = path.join(__dirname, 'lib', 'deployment-state.js');
  const script = [
    `const lib=require(${JSON.stringify(modulePath)})`,
    `lib.publishImmutableBytes(${JSON.stringify(target)},Buffer.from(${JSON.stringify(body.toString())}),{allowExactExisting:true,crashLabelPrefix:'retry-durable'})`,
  ].join(';');

  for (const boundary of ['after-link', 'after-unlink']) {
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: `retry-durable:${boundary}` },
    });
    assert.equal(child.status, 137, `${boundary}: ${child.stderr}`);
    assert.equal(fs.readFileSync(target).equals(body), true, boundary);

    const { result, events } = traceGuardFsEvents(() => lib.publishImmutableBytes(target, body, {
      allowExactExisting: true,
      crashLabelPrefix: 'retry-durable-resume',
    }));
    assert.equal(result.resumed, true, boundary);
    const targetFsync = events.findIndex((event) => event.kind === 'fsync' && event.path === target);
    const parentFsync = events.findIndex((event, index) => (
      index > targetFsync && event.kind === 'fsync' && event.path === path.dirname(target)
    ));
    assert.notEqual(targetFsync, -1, `${boundary}: retry must fsync final target`);
    assert.notEqual(parentFsync, -1, `${boundary}: retry must fsync parent after final target`);
  }
});

test('immutable publication: concurrent same-body publishers serialize without deleting another writer intent', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'receipts', 'same-body.json');
  const modulePath = path.join(__dirname, 'lib', 'deployment-state.js');
  const script = `
const lib = require(process.argv[1]);
const target = process.argv[2];
const body = Buffer.alloc(16 * 1024 * 1024, 0x61);
lib.publishImmutableBytes(target, body, { allowExactExisting: true, crashLabelPrefix: 'same-body-race' });
`;
  const runPublisher = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, modulePath, target], {
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  const results = await Promise.all(Array.from({ length: 8 }, runPublisher));
  assert.deepEqual(results.map((result) => result.code), Array(8).fill(0), JSON.stringify(results));
  assert.equal(fs.statSync(target).size, 16 * 1024 * 1024);
  assert.equal(fs.readFileSync(target).every((byte) => byte === 0x61), true);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['same-body.json']);
});

test('literal production authority separates persistent records from the one same-boot lock path', () => {
  assert.equal(lib.classifyDeploymentAuthorityPath('/data/osi-deploy/deployment-state.json'), 'persistent');
  assert.equal(lib.classifyDeploymentAuthorityPath('/data/osi-deploy/receipts/op.deployment.json'), 'persistent');
  assert.equal(lib.classifyDeploymentAuthorityPath('/var/lock/osi-deploy.lock.d'), 'attempt-lock');
  for (const unsafe of ['/var/lock/other.lock.d', '/var/lock/osi-deploy.lock.d/child', '/data/other/state.json']) {
    assert.throws(() => lib.classifyDeploymentAuthorityPath(unsafe), /authority|path|root/i);
  }
});

test('canonicalHash is stable regardless of key order', () => {
  const a = { z: 1, a: { y: 2, x: 3 } };
  const b = { a: { x: 3, y: 2 }, z: 1 };
  assert.equal(lib.canonicalHash(a), lib.canonicalHash(b));
});

// ---------------------------------------------------------------------------
// Section 2: receipts (immutable, exclusive creation, closed kind enum)
// ---------------------------------------------------------------------------

function validDeploymentReceiptContent(overrides = {}) {
  return {
    format: 1,
    receiptKind: 'deployment',
    operationId: 'op-1',
    deploymentId: 'op-1',
    phaseAtIssuance: 'runtime-verified',
    result: 'verified',
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

function validAcceptanceReceiptContent(overrides = {}) {
  return {
    format: 1,
    receiptKind: 'acceptance',
    operationId: 'op-1',
    deploymentId: 'op-1',
    deploymentReceiptSha256: 'a'.repeat(64),
    result: 'accepted',
    evidenceSha256: 'b'.repeat(64),
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

test('receipts: writeReceipt uses the exact receipts/<operation-id>.<receipt-kind>.json convention', () => {
  const dir = tmpDir();
  const receiptsDir = path.join(dir, 'receipts');
  const result = lib.writeReceipt(receiptsDir, 'op-1', 'deployment', validDeploymentReceiptContent());
  assert.equal(result.path, path.join(receiptsDir, 'op-1.deployment.json'));
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
});

test('receipts: rejects a kind outside the closed enum', () => {
  const dir = tmpDir();
  assert.throws(
    () => lib.writeReceipt(path.join(dir, 'receipts'), 'op-1', 'not-a-kind', {}),
    /unknown-receipt-kind|unknown receipt kind/
  );
});

test('receipts: exclusive creation forbids reuse of the same operation-id+kind', () => {
  const dir = tmpDir();
  const receiptsDir = path.join(dir, 'receipts');
  lib.writeReceipt(receiptsDir, 'op-1', 'deployment', validDeploymentReceiptContent());
  assert.throws(
    () => lib.writeReceipt(receiptsDir, 'op-1', 'deployment', validDeploymentReceiptContent({ result: 'verified' })),
    /exclusive-create-conflict|refusing to overwrite/
  );
});

test('receipts: the same operation-id may hold a deployment receipt and a later acceptance receipt without overwriting either', () => {
  const dir = tmpDir();
  const receiptsDir = path.join(dir, 'receipts');
  const dep = lib.writeReceipt(receiptsDir, 'op-1', 'deployment', validDeploymentReceiptContent());
  const acc = lib.writeReceipt(receiptsDir, 'op-1', 'acceptance', validAcceptanceReceiptContent());
  assert.notEqual(dep.path, acc.path);
  assert.equal(lib.readReceipt(receiptsDir, 'op-1', 'deployment').content.receiptKind, 'deployment');
  assert.equal(lib.readReceipt(receiptsDir, 'op-1', 'acceptance').content.receiptKind, 'acceptance');
});

test('receipts: readReceipt returns null for a receipt that does not exist', () => {
  const dir = tmpDir();
  assert.equal(lib.readReceipt(path.join(dir, 'receipts'), 'op-none', 'deployment'), null);
});

// ---------------------------------------------------------------------------
// Section 2: permanent attempt tombstones (one-use)
// ---------------------------------------------------------------------------

test('attempt tombstones: exact identity resumes but a changed identity is permanently refused', () => {
  const dir = tmpDir();
  const attemptsDir = path.join(dir, 'attempts');
  const tombstone = {
    deploymentId: 'dep-1',
    identitySha256: 'a'.repeat(64),
    targetCommitSha: 'b'.repeat(40),
    controllerGeneration: 1,
    claimSha256: 'c'.repeat(64),
    claimPath: path.join(dir, 'dep-1.claim.json'),
    createdAt: '2026-07-17T00:00:00.000Z',
  };
  lib.writeAttemptTombstone(attemptsDir, 'dep-1', tombstone);
  assert.equal(
    lib.writeAttemptTombstone(attemptsDir, 'dep-1', {
      ...tombstone,
      createdAt: '2026-07-17T00:00:01.000Z',
    }).resumed,
    true
  );
  assert.throws(
    () => lib.writeAttemptTombstone(attemptsDir, 'dep-1', {
      ...tombstone,
      identitySha256: 'c'.repeat(64),
    }),
    (err) => err.code === 'attempt-tombstone-conflict'
  );
  const read = lib.readAttemptTombstone(attemptsDir, 'dep-1');
  assert.deepEqual(read, tombstone);
});

test('attempt tombstones: readAttemptTombstone returns null when absent', () => {
  const dir = tmpDir();
  assert.equal(lib.readAttemptTombstone(path.join(dir, 'attempts'), 'dep-none'), null);
});

test('attempts and permit authority roots are exact in production and explicit in tests', () => {
  const f = fixture();
  assert.throws(() => lib.attemptTombstonePath(path.join(f.dir, 'not-attempts'), 'dep-1'),
    (error) => error.code === 'unsafe-test-adapter');
  assert.throws(() => lib.validatePermitNoncePath(path.join(f.dir, 'not-permits/dep-1.1.nonce')),
    (error) => error.code === 'unsafe-test-adapter');
  const savedArtifact = process.env.OSI_DEPLOY_ARTIFACT_MODE;
  const savedBoundary = process.env.OSI_DEPLOY_TEST_BOUNDARY;
  delete process.env.OSI_DEPLOY_ARTIFACT_MODE;
  delete process.env.OSI_DEPLOY_TEST_BOUNDARY;
  try {
    assert.throws(() => lib.validatePersistentAuthorityDirectory('/tmp/attempts', 'attempts'),
      (error) => error.code === 'mount-authority');
    assert.throws(() => lib.validatePersistentAuthorityDirectory('/data/osi-deploy/other-attempts', 'attempts'),
      (error) => error.code === 'mount-authority');
  } finally {
    process.env.OSI_DEPLOY_ARTIFACT_MODE = savedArtifact;
    process.env.OSI_DEPLOY_TEST_BOUNDARY = savedBoundary;
  }
});

test('boot identity: production parser rejects unavailable, empty, and malformed kernel boot IDs', () => {
  const dir = tmpDir();
  const missing = path.join(dir, 'missing-boot-id');
  const empty = path.join(dir, 'empty-boot-id');
  const malformed = path.join(dir, 'malformed-boot-id');
  const valid = path.join(dir, 'valid-boot-id');
  fs.writeFileSync(empty, '\n');
  fs.writeFileSync(malformed, 'unknown-boot\n');
  fs.writeFileSync(valid, '123e4567-e89b-42d3-a456-426614174000\n');
  assert.throws(() => lib.readBootId(missing), /boot.*unavailable|ENOENT/i);
  assert.throws(() => lib.readBootId(empty), /boot.*invalid|empty/i);
  assert.throws(() => lib.readBootId(malformed), /boot.*invalid|UUID/i);
  assert.equal(lib.readBootId(valid), '123e4567-e89b-42d3-a456-426614174000');
});

// ---------------------------------------------------------------------------
// Section 2: lock protocol
// ---------------------------------------------------------------------------

function freshLockFixture() {
  const dir = tmpDir();
  return {
    dir,
    lockDir: path.join(dir, 'osi-deploy.lock.d'),
    statePath: path.join(dir, 'deployment-state.json'),
  };
}

test('lock: acquire on an absent lock dir succeeds and writes owner metadata', () => {
  const { lockDir, statePath } = freshLockFixture();
  const res = lib.acquireLock({
    lockDir,
    statePath,
    deploymentId: 'dep-1',
    targetCommitSha: 'abc123',
    controllerGeneration: 1,
    bootId: 'boot-a',
  });
  assert.equal(res.acquired, true);
  assert.equal(res.reclaimed, false);
  const owner = lib.readLockOwner(lockDir);
  assert.equal(owner.deploymentId, 'dep-1');
  // Liveness is tracked against the *controlling* process (process.ppid),
  // not this test's own pid: a lock owned by a single short-lived verb
  // invocation's own pid would already be dead by the time a later verb
  // in the same attempt checked it (see verbRecover's lock-owner check).
  assert.equal(owner.pid, process.ppid);
  assert.match(owner.processStartTime, /^\d+$/);
});

test('lock: PID reuse is stale unless /proc starttime matches the owner record', () => {
  const { lockDir, statePath } = freshLockFixture();
  fs.mkdirSync(lockDir, 0o700);
  lib.writeLockOwner(lockDir, {
    deploymentId: 'dep-1', pid: process.ppid, processStartTime: '1', bootId: 'boot-a',
    targetCommitSha: 'a', controllerGeneration: 1, acquiredAt: '2026-07-16T00:00:00.000Z',
  });
  const result = lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1',
    targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  assert.equal(result.reclaimed, true);
  assert.notEqual(lib.readLockOwner(lockDir).processStartTime, '1');
});

test('lock: a live same-boot owner blocks every different-deployment contender', () => {
  const { lockDir, statePath } = freshLockFixture();
  lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  assert.throws(
    () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-2', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
    /lock-contended/
  );
});

// The former sequential "two-controller contention across a state save"
// test that lived here only demonstrated that a stale in-memory read
// diverges from disk; it never proved the CLI rejects a concurrent
// writer. It has been REPLACED by the real two-process races in the
// "Section 7: review fixes" block below (two concurrent first-arm spawns,
// two concurrent same-source-phase advance spawns).

test('lock: stale owner (dead PID, same boot) may be reclaimed by the same deployment', () => {
  const { lockDir, statePath } = freshLockFixture();
  fs.mkdirSync(lockDir, 0o700);
  lib.writeLockOwner(lockDir, {
    deploymentId: 'dep-1',
    pid: 999999, // not a live pid
    processStartTime: '1',
    bootId: 'boot-a',
    targetCommitSha: 'a',
    controllerGeneration: 1,
    acquiredAt: '2026-07-16T00:00:00.000Z',
  });
  const res = lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  assert.equal(res.acquired, true);
  assert.equal(res.reclaimed, true);
});

test('lock: same-operation reuse and reclaim reject target, controller-generation, or boot identity drift', () => {
  for (const changed of [
    { targetCommitSha: 'b', controllerGeneration: 1, bootId: 'boot-a' },
    { targetCommitSha: 'a', controllerGeneration: 2, bootId: 'boot-a' },
    { targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-b' },
  ]) {
    const { lockDir, statePath } = freshLockFixture();
    fs.mkdirSync(lockDir, 0o700);
    lib.writeLockOwner(lockDir, {
      deploymentId: 'dep-1', pid: 999999, processStartTime: '1', bootId: 'boot-a', targetCommitSha: 'a', controllerGeneration: 1,
      acquiredAt: '2026-07-16T00:00:00.000Z',
    });
    assert.throws(
      () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', ...changed }),
      (error) => error.code === 'lock-identity-mismatch'
    );
    assert.equal(lib.readLockOwner(lockDir).targetCommitSha, 'a');
  }
});

test('lock: same-operation reclaim is cross-bound to persistent state and its claimed authority bytes', () => {
  {
    const { lockDir, statePath } = freshLockFixture();
    fs.mkdirSync(lockDir, 0o700);
    lib.writeLockOwner(lockDir, {
      deploymentId: 'dep-1', pid: 999999, processStartTime: '1', bootId: 'boot-a', targetCommitSha: 'a', controllerGeneration: 1,
      acquiredAt: '2026-07-16T00:00:00.000Z',
    });
    lib.writeState(statePath, baseEnvelope({
      parentDeployment: { deploymentId: 'dep-1', targetCommitSha: 'different', controllerGeneration: 1 },
    }));
    assert.throws(
      () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
      (error) => error.code === 'lock-state-identity-mismatch'
    );
  }

  {
    const { lockDir, statePath } = freshLockFixture();
    const claimPath = path.join(path.dirname(statePath), 'dep-1.claim.json');
    const originalClaim = Buffer.from('{"deploymentId":"dep-1"}\n');
    fs.writeFileSync(claimPath, originalClaim, { mode: 0o600 });
    fs.mkdirSync(lockDir, 0o700);
    lib.writeLockOwner(lockDir, {
      deploymentId: 'dep-1', pid: 999999, processStartTime: '1', bootId: 'boot-a', targetCommitSha: 'a', controllerGeneration: 1,
      acquiredAt: '2026-07-16T00:00:00.000Z',
    });
    lib.writeState(statePath, baseEnvelope({
      parentDeployment: {
        deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1,
        claimPath, claimSha256: lib.sha256Hex(originalClaim),
      },
    }));
    fs.writeFileSync(claimPath, '{"deploymentId":"other"}\n', { mode: 0o600 });
    assert.throws(
      () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
      (error) => error.code === 'lock-claim-mismatch'
    );
  }
});

test('lock: stale reclaim revalidates the exact directory inode and owner bytes before deletion', () => {
  const { lockDir, statePath } = freshLockFixture();
  fs.mkdirSync(lockDir, 0o700);
  lib.writeLockOwner(lockDir, {
    deploymentId: 'dep-1', pid: 999999, processStartTime: '1', bootId: 'boot-a', targetCommitSha: 'a', controllerGeneration: 1,
    acquiredAt: '2026-07-16T00:00:00.000Z',
  });
  const realRename = fs.renameSync;
  let swapped = false;
  fs.renameSync = (source, destination) => {
    if (!swapped && source === lockDir) {
      swapped = true;
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir, 0o700);
      lib.writeLockOwner(lockDir, {
        deploymentId: 'dep-1', pid: process.pid, processStartTime: '1', bootId: 'boot-a', targetCommitSha: 'a', controllerGeneration: 1,
        acquiredAt: '2026-07-16T00:00:01.000Z',
      });
    }
    return realRename.call(fs, source, destination);
  };
  try {
    assert.throws(
      () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
      (error) => error.code === 'lock-reclaim-race'
    );
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(lib.readLockOwner(lockDir).pid, process.pid, 'concurrent replacement owner must survive');
});

test('lock: stale owner from a different, unlinked deployment is refused', () => {
  const { lockDir, statePath } = freshLockFixture();
  fs.mkdirSync(lockDir, 0o700);
  lib.writeLockOwner(lockDir, {
    deploymentId: 'dep-1',
    pid: 999999,
    processStartTime: '1',
    bootId: 'boot-a',
    targetCommitSha: 'a',
    controllerGeneration: 1,
    acquiredAt: '2026-07-16T00:00:00.000Z',
  });
  assert.throws(
    () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-2', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
    /lock-reclaim-refused/
  );
});

test('lock: reboot cannot silently reuse a same-operation owner from another boot', () => {
  const { lockDir, statePath } = freshLockFixture();
  lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  // Simulate reboot: new boot id, same live pid (this process), lock dir intact.
  assert.throws(
    () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-b' }),
    (error) => error.code === 'lock-identity-mismatch'
  );
});

test('lock: /var/lock loss at reboot does not grant progress to a different deployment while leaseActive is true', () => {
  const { lockDir, statePath } = freshLockFixture();
  const env = baseEnvelope({ parentDeployment: { deploymentId: 'dep-1', leaseActive: true } });
  lib.writeState(statePath, env);
  // Lock dir was never created (simulating /var/lock loss), but state still
  // authoritatively records an active lease for dep-1.
  assert.throws(
    () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-2', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
    /lease-active-different-deployment/
  );
});

test('lock: a linked recovery operation may reclaim a stale parent lock', () => {
  const { lockDir, statePath } = freshLockFixture();
  const restoredPredecessor = managedTerminalPredecessor();
  const env = {
    format: 2,
    parentDeployment: baseParentDeployment({
      deploymentId: 'dep-1',
      phase: 'verification-in-flight',
      leaseActive: true,
      deploymentReceiptSha256: 'a'.repeat(64),
    }),
    activeSubOperation: {
      kind: 'recovery',
      operationId: 'rec-1',
      parentDeploymentId: 'dep-1',
      parentDeploymentGeneration: 1,
      parentPhaseAtLink: 'verification-in-flight',
      parentReceiptsSha256: 'b'.repeat(64),
      phase: 'recovery-started',
      restoredPredecessor,
      restoredPredecessorSha256: lib.restoredPredecessorSha256(restoredPredecessor),
      generation: 1,
      createdAt: '2026-07-16T00:00:00.000Z',
    },
  };
  lib.writeState(statePath, env);
  fs.mkdirSync(lockDir, 0o700);
  lib.writeLockOwner(lockDir, {
    deploymentId: 'dep-1',
    pid: 999999,
    processStartTime: '1',
    bootId: 'boot-a',
    targetCommitSha: 'a',
    controllerGeneration: 1,
    acquiredAt: '2026-07-16T00:00:00.000Z',
  });
  const res = lib.acquireLock({ lockDir, statePath, deploymentId: 'rec-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  assert.equal(res.acquired, true);
  assert.equal(res.reclaimed, true);
  assert.equal(lib.readLockOwner(lockDir).deploymentId, 'rec-1');
});

test('lock: mismatched-ID contention against a live owner is refused regardless of receipts', () => {
  const { lockDir, statePath } = freshLockFixture();
  lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  assert.throws(
    () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-9', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
    /lock-contended/
  );
});

test('lock: releaseLock refuses when the final receipt hash does not match the recorded terminal receipt', () => {
  const { lockDir, statePath } = freshLockFixture();
  lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  const env = baseEnvelope({
    parentDeployment: {
      deploymentId: 'dep-1',
      phase: 'completed',
      leaseActive: false,
      completionKind: 'deployment',
      deploymentReceiptSha256: 'a'.repeat(64),
      acceptanceReceiptSha256: 'b'.repeat(64),
    },
  });
  lib.writeState(statePath, env);
  assert.throws(
    () => lib.releaseLock({ lockDir, statePath, operationId: 'dep-1', expectedFinalReceiptSha256: 'f'.repeat(64) }),
    /receipt-mismatch/
  );
  assert.equal(fs.existsSync(lockDir), true);
});

test('lock: releaseLock succeeds and removes the lock dir when the final receipt matches', () => {
  const { lockDir, statePath } = freshLockFixture();
  lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  const env = baseEnvelope({
    parentDeployment: {
      deploymentId: 'dep-1',
      phase: 'completed',
      leaseActive: false,
      completionKind: 'deployment',
      deploymentReceiptSha256: 'a'.repeat(64),
      acceptanceReceiptSha256: 'b'.repeat(64),
    },
  });
  env.parentDeployment.lockRelease = lib.createLockReleaseIntent({
    lockDir, operationId: 'dep-1', finalReceiptSha256: 'b'.repeat(64),
  });
  lib.writeState(statePath, env);
  const res = lib.releaseLock({ lockDir, statePath, operationId: 'dep-1', expectedFinalReceiptSha256: 'b'.repeat(64) });
  assert.equal(res.released, true);
  assert.equal(fs.existsSync(lockDir), false);
});

test('lock: delayed release cannot delete a concurrently replaced owner directory', () => {
  const { lockDir, statePath } = freshLockFixture();
  lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  const env = baseEnvelope({ parentDeployment: {
    deploymentId: 'dep-1', phase: 'completed', leaseActive: false, completionKind: 'deployment',
    deploymentReceiptSha256: 'a'.repeat(64), acceptanceReceiptSha256: 'b'.repeat(64),
  } });
  env.parentDeployment.lockRelease = lib.createLockReleaseIntent({
    lockDir, operationId: 'dep-1', finalReceiptSha256: 'b'.repeat(64),
  });
  lib.writeState(statePath, env);
  const realRename = fs.renameSync;
  let swapped = false;
  fs.renameSync = (source, destination) => {
    if (!swapped && source === lockDir) {
      swapped = true;
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir, 0o700);
      lib.writeLockOwner(lockDir, {
        deploymentId: 'dep-new', pid: process.pid, processStartTime: '1', bootId: 'boot-a',
        targetCommitSha: 'b', controllerGeneration: 2, acquiredAt: '2026-07-19T00:00:00.000Z',
      });
    }
    return realRename.call(fs, source, destination);
  };
  try {
    assert.throws(() => lib.releaseLock({ lockDir, statePath, operationId: 'dep-1',
      expectedFinalReceiptSha256: 'b'.repeat(64) }), (error) => error.code === 'lock-reclaim-race');
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(lib.readLockOwner(lockDir).deploymentId, 'dep-new');
});

// ---------------------------------------------------------------------------
// Section 3: CLI spawn tests, verbs batch 1
// (acquire-lock, arm, advance, status, finish, complete, release-lock)
// ---------------------------------------------------------------------------

function fixture() {
  const dir = tmpDir();
  return {
    dir,
    root: path.join(dir, 'guard-bootstrap'),
    state: path.join(dir, 'deployment-state.json'),
    receipts: path.join(dir, 'receipts'),
    attempts: path.join(dir, 'attempts'),
    lockDir: path.join(dir, 'osi-deploy.lock.d'),
    permits: path.join(dir, 'permits'),
  };
}

function armIdentity(overrides = {}) {
  return { deploymentId: 'dep-cli-1', targetCommitSha: 'a'.repeat(40), controllerGeneration: 1, ...overrides };
}

function prepareArmClaim(f, identity, bootId = GB1) {
  const head = buildGuardChain(f, 'ready', { bootId, deploymentId: identity.deploymentId });
  const result = cliClaim(f, {
    deploymentId: identity.deploymentId,
    bootId,
    gen: head.generation,
    sha: head.sha256,
    flags: {
      controllerGeneration: String(identity.controllerGeneration),
      targetCommit: identity.targetCommitSha,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return claimPathOf(f, identity.deploymentId);
}

function armViaCli(f, identityOverrides = {}) {
  const identity = armIdentity(identityOverrides);
  if (!fs.existsSync(f.lockDir)) {
    runCliOk(['acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
      '--deployment-id', identity.deploymentId, '--target-commit', identity.targetCommitSha,
      '--controller-generation', String(identity.controllerGeneration)], withBoot(GB1));
  }
  prepareArmClaim(f, identity);
  const identityPath = writeJsonFile(path.join(f.dir, 'identity.json'), identity);
  const expectedSha = lib.canonicalHash(identity);
  const out = runCliOk([
    'arm',
    '--state', f.state,
    '--receipts', f.receipts,
    '--attempts', f.attempts,
    '--expected-attempt-sha256', expectedSha,
    '--identity', identityPath,
  ], withBoot(GB1));
  return { out, identity, identityPath, expectedSha };
}

test('cli: import without dispatch is not the test strategy - VERBS table wires real handlers', () => {
  // Guard against accidentally testing the module by require()-and-call
  // instead of spawning the real CLI process end to end.
  const { VERBS } = require('./deployment-state-cli');
  assert.equal(typeof VERBS.arm, 'function');
  assert.equal(typeof VERBS.advance, 'function');
});

test('cli: unknown verb exits nonzero with a bounded JSON error', () => {
  const { res, parsed } = runCliFail(['not-a-real-verb']);
  assert.equal(res.status, 1);
  assert.equal(parsed.code, 'unknown-verb');
});

// Guard-bootstrap chain verbs (begin/advance/status-guard-bootstrap,
// claim-attempt, abandon-guard-bootstrap, authorize-topology-activation)
// were out-of-scope in the core slice and are implemented on this branch;
// only the image-baseline and staging-GC verbs remain rejected.
for (const verb of [
  'initialize-image-baseline',
  'complete-image-baseline',
  'collect-staging',
  'retry-staging-gc',
]) {
  test(`cli: out-of-scope verb '${verb}' is rejected, not silently unknown`, () => {
    const { parsed } = runCliFail([verb, '--whatever', 'x']);
    assert.equal(parsed.code, 'verb-out-of-scope');
  });
}

test('cli acquire-lock: happy path acquires and writes owner metadata', () => {
  const f = fixture();
  const out = runCliOk([
    'acquire-lock',
    '--state', f.state,
    '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1',
    '--target-commit', 'a'.repeat(40),
    '--controller-generation', '1',
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.acquired, true);
  assert.equal(fs.existsSync(f.lockDir), true);
});

test('cli acquire-lock: unknown flag is rejected', () => {
  const f = fixture();
  const { parsed } = runCliFail([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-1', '--target-commit', 'a', '--controller-generation', '1',
    '--bogus-flag', 'x',
  ]);
  assert.equal(parsed.code, 'unknown-flag');
});

test('cli acquire-lock: duplicate flag is rejected', () => {
  const f = fixture();
  const { parsed } = runCliFail([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-1', '--deployment-id', 'dep-2',
    '--target-commit', 'a', '--controller-generation', '1',
  ]);
  assert.equal(parsed.code, 'duplicate-flag');
});

test('cli acquire-lock: missing required flag is rejected', () => {
  const f = fixture();
  const { parsed } = runCliFail(['acquire-lock', '--state', f.state, '--lock-dir', f.lockDir]);
  assert.equal(parsed.code, 'missing-flag');
});

test('cli arm: happy path creates the first parentDeployment', () => {
  const f = fixture();
  const { out, identity } = armViaCli(f);
  assert.equal(out.ok, true);
  assert.equal(out.phase, 'armed');
  assert.equal(out.generation, 1);
  const status = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(status.parentDeployment.phase, 'armed');
  assert.equal(status.activeSubOperation, null);
});

test('cli arm: a caller identity without the exact prior claim-attempt authority is rejected', () => {
  const f = fixture();
  const identity = armIdentity();
  const identityPath = writeJsonFile(path.join(f.dir, 'identity-unclaimed.json'), identity);
  const { parsed } = runCliFail([
    'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', lib.canonicalHash(identity), '--identity', identityPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'claim-missing');
  assert.equal(fs.existsSync(f.state), false);
  assert.equal(fs.existsSync(path.join(f.attempts, `${identity.deploymentId}.attempt.json`)), false);
});

test('cli arm: a planted or tampered claim file cannot substitute for the claimed guard-chain bytes', () => {
  const f = fixture();
  const identity = armIdentity({ deploymentId: 'dep-cli-tampered-claim' });
  const claimPath = prepareArmClaim(f, identity);
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  claim.artifactSha256 = 'f'.repeat(64);
  fs.writeFileSync(claimPath, JSON.stringify(claim, null, 2), { mode: 0o600 });
  fs.chmodSync(claimPath, 0o600);
  const identityPath = writeJsonFile(path.join(f.dir, 'identity-tampered-claim.json'), identity);
  const { parsed } = runCliFail([
    'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', lib.canonicalHash(identity), '--identity', identityPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'claim-mismatch');
  assert.equal(fs.existsSync(f.state), false);
});

test('cli arm: wrong --expected-attempt-sha256 is rejected', () => {
  const f = fixture();
  const identity = armIdentity();
  const identityPath = writeJsonFile(path.join(f.dir, 'identity.json'), identity);
  const { parsed } = runCliFail([
    'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', 'f'.repeat(64), '--identity', identityPath,
  ]);
  assert.equal(parsed.code, 'attempt-sha-mismatch');
});

test('cli arm: symlinked --identity path is rejected', () => {
  const f = fixture();
  const identity = armIdentity();
  const realPath = writeJsonFile(path.join(f.dir, 'real-identity.json'), identity);
  const linkPath = path.join(f.dir, 'identity-link.json');
  fs.symlinkSync(realPath, linkPath);
  const { parsed } = runCliFail([
    'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', lib.canonicalHash(identity), '--identity', linkPath,
  ]);
  assert.equal(parsed.code, 'symlink-rejected');
});

test('cli arm: relative (non-absolute) --identity path is rejected', () => {
  const f = fixture();
  const identity = armIdentity();
  writeJsonFile(path.join(f.dir, 'identity.json'), identity);
  // The "absolute" half of the "absolute-root-only-json" rule. The
  // wrong-owner half is exercised directly in Section 7d via
  // process.getuid monkey-patching.
  const { parsed } = runCliFail([
    'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', lib.canonicalHash(identity), '--identity', 'relative/identity.json',
  ]);
  assert.equal(parsed.code, 'shape');
});

test('cli arm: an exact same-identity retry resumes after the permanent tombstone was published', () => {
  const f = fixture();
  const { out: first } = armViaCli(f);
  const resumed = runCliOk([
    'arm', '--state', path.join(f.dir, 'other-state.json'), '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', lib.canonicalHash(armIdentity()),
    '--identity', writeJsonFile(path.join(f.dir, 'identity2.json'), armIdentity()),
  ], withBoot(GB1));
  assert.equal(resumed.deploymentId, first.deploymentId);
  assert.equal(resumed.phase, 'armed');
});

test('cli advance: happy path walks armed -> writers-stopped -> protocol-initializing', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
  const a1 = runCliOk([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', emptyPatch,
  ]);
  assert.equal(a1.phase, 'writers-stopped');
  const a2 = runCliOk([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'writers-stopped', '--phase', 'protocol-initializing', '--patch', emptyPatch,
  ]);
  assert.equal(a2.phase, 'protocol-initializing');
});

test('cli advance: phase-skip is rejected', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
  const { parsed } = runCliFail([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'armed', '--phase', 'protocol-ready', '--patch', emptyPatch,
  ]);
  assert.equal(parsed.code, 'phase-skip-rejected');
});

test('cli advance: rejects the factory-only phase as a target', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
  const { parsed } = runCliFail([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'armed', '--phase', 'image-baseline-initializing', '--patch', emptyPatch,
  ]);
  assert.equal(parsed.code, 'factory-phase-rejected');
});

test('cli advance: stale expected-phase (two-controller contention) is rejected', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
  runCliOk([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', emptyPatch,
  ]);
  // A second controller still believes the phase is 'armed'.
  const { parsed } = runCliFail([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', emptyPatch,
  ]);
  assert.equal(parsed.code, 'cas-mismatch');
});

test('cli advance: unknown patch field is rejected', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  const patch = writeJsonFile(path.join(f.dir, 'patch-bad.json'), { notAllowed: true });
  const { parsed } = runCliFail([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', patch,
  ]);
  assert.equal(parsed.code, 'unknown-field');
});

function advanceToRuntimeVerified(f, deploymentId) {
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
  const chain = [
    'writers-stopped',
    'protocol-initializing',
    'protocol-ready',
    'resident-mutating',
    'payload-mutating',
    'probes-running',
    'runtime-verified',
  ];
  let expectedPhase = 'armed';
  for (const phase of chain) {
    runCliOk([
      'advance', '--state', f.state, '--deployment-id', deploymentId,
      '--expected-phase', expectedPhase, '--phase', phase, '--patch', emptyPatch,
    ]);
    expectedPhase = phase;
  }
}

test('cli finish: happy path writes a deployment receipt and advances to verification-in-flight', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const out = runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  assert.equal(out.phase, 'verification-in-flight');
  assert.match(out.deploymentReceiptSha256, /^[0-9a-f]{64}$/);
  const receiptPath = path.join(f.receipts, `${identity.deploymentId}.deployment.json`);
  assert.equal(fs.existsSync(receiptPath), true);
});

test('cli finish: wrong --expected-phase/--result literals are rejected', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const { parsed } = runCliFail([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'probes-running', '--result', 'verified',
  ]);
  assert.equal(parsed.code, 'shape');
});

test('cli finish: receipt-reuse - a second finish after a manual receipt conflict is rejected', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  // Pre-plant a conflicting receipt under the same operation id + kind,
  // via raw fs so writeReceipt's content validation cannot intervene.
  fs.mkdirSync(f.receipts, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(f.receipts, `${identity.deploymentId}.deployment.json`),
    JSON.stringify({ tampered: true }),
    { mode: 0o600 }
  );
  const { parsed } = runCliFail([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  assert.equal(parsed.code, 'unknown-field');
});

function acceptanceFile(f, extra = {}) {
  return writeJsonFile(path.join(f.dir, 'acceptance.json'), { result: 'accepted', evidenceSha256: 'a'.repeat(64), ...extra });
}

test('cli complete: happy path writes an acceptance receipt and completes', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const finished = runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  const out = runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
  ]);
  assert.equal(out.phase, 'completed');
  const status = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(status.parentDeployment.leaseActive, false);
  assert.equal(status.parentDeployment.completionKind, 'deployment');
});

test('cli re-arm records the exact immutable previous terminal tuple for managed recovery', () => {
  const f = fixture();
  const { identity: first } = armViaCli(f);
  advanceToRuntimeVerified(f, first.deploymentId);
  const finished = runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', first.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  const completed = runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', first.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
  ]);
  const terminal = lib.readState(f.state).parentDeployment;
  const terminalReceipts = {
    completionKind: 'deployment',
    deploymentReceiptSha256: finished.deploymentReceiptSha256,
    acceptanceReceiptSha256: completed.acceptanceReceiptSha256,
  };
  const terminalReceiptsPath = writeJsonFile(path.join(f.dir, 'previous-terminal-receipts.json'), terminalReceipts);
  const next = armIdentity({ deploymentId: 'dep-cli-2' });
  prepareArmClaim(f, next);
  const nextIdentityPath = writeJsonFile(path.join(f.dir, 'identity-next.json'), next);
  runCliOk([
    'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', lib.canonicalHash(next), '--identity', nextIdentityPath,
    '--expected-previous-generation', String(terminal.generation),
    '--expected-previous-terminal-phase', 'completed',
    '--expected-previous-terminal-receipts', terminalReceiptsPath,
  ], withBoot(GB1));
  assert.deepEqual(lib.readState(f.state).parentDeployment.previousTerminal, {
    deploymentId: first.deploymentId,
    generation: terminal.generation,
    phase: 'completed',
    receiptsSha256: lib.canonicalHash(terminalReceipts),
    terminalTupleSha256: lib.terminalTupleSha256('completed', terminalReceipts),
  });
});

test('cli complete: wrong expected-deployment-receipt-sha256 is rejected', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  const { parsed } = runCliFail([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', 'f'.repeat(64), '--acceptance', acceptanceFile(f),
  ]);
  assert.equal(parsed.code, 'cas-mismatch');
});

test('cli complete: an active sub-operation blocks terminal completion', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const finished = runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  const current = lib.readState(f.state);
  const restoredPredecessor = managedTerminalPredecessor();
  current.activeSubOperation = {
    kind: 'recovery', operationId: 'rec-complete-blocked', parentDeploymentId: identity.deploymentId,
    parentDeploymentGeneration: current.parentDeployment.generation,
    parentPhaseAtLink: 'verification-in-flight', parentReceiptsSha256: 'b'.repeat(64),
    phase: 'recovery-started', restoredPredecessor,
    restoredPredecessorSha256: lib.restoredPredecessorSha256(restoredPredecessor),
    generation: 1, createdAt: '2026-07-19T00:00:00.000Z',
  };
  lib.writeState(f.state, current);
  const { parsed } = runCliFail([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
  ]);
  assert.equal(parsed.code, 'suboperation-active');
  assert.equal(lib.readReceipt(f.receipts, identity.deploymentId, 'acceptance'), null);
});

test('cli release-lock: full ordinary lifecycle end to end, then lock release', () => {
  const f = fixture();
  runCliOk([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ]);
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const finished = runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  const completed = runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
  ]);
  const released = runCliOk([
    'release-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId, '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256,
  ]);
  assert.equal(released.released, true);
  assert.equal(fs.existsSync(f.lockDir), false);
});

test('cli release-lock: releasing state, volatile removal, and released state crash boundaries converge', () => {
  for (const crashAt of [
    'release-lock:after-releasing-state',
    'release-lock:after-lock-removal',
    'release-lock:after-released-state',
  ]) {
    const f = fixture();
    runCliOk([
      'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
      '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
    ], withBoot(GB1));
    const { identity } = armViaCli(f);
    advanceToRuntimeVerified(f, identity.deploymentId);
    const finished = runCliOk([
      'finish', '--state', f.state, '--receipts', f.receipts,
      '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
    ]);
    const completed = runCliOk([
      'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
      '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
    ]);
    const args = [
      'release-lock', '--state', f.state, '--lock-dir', f.lockDir,
      '--operation-id', identity.deploymentId,
      '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256,
    ];
    const crashed = runCli(args, withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: crashAt }));
    assert.equal(crashed.status, 137, crashAt);
    const resumed = runCliOk(args, withBoot(GB1));
    assert.equal(resumed.released, true, crashAt);
    assert.equal(fs.existsSync(f.lockDir), false, crashAt);
    assert.equal(lib.readState(f.state).parentDeployment.lockRelease.status, 'released', crashAt);
  }
});

test('cli complete: durable release intent precedes terminal CAS and survives reboot loss of the volatile lock', () => {
  const f = fixture();
  runCliOk(['acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1'], withBoot(GB1));
  const { identity, finished } = armAndFinish(f);
  const args = ['complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId, '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256,
    '--acceptance', acceptanceFile(f)];
  const crashed = runCli(args, withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: 'complete:after-release-intent' }));
  assert.equal(crashed.status, 137);
  const intentState = lib.readState(f.state).parentDeployment;
  assert.equal(intentState.phase, 'verification-in-flight');
  assert.equal(intentState.lockRelease.status, 'intent');
  fs.rmSync(f.lockDir, { recursive: true });
  const completed = runCliOk(args, withBoot('guard-boot-0002'));
  assert.equal(completed.phase, 'completed');
  const released = runCliOk(['release-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId, '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256],
  withBoot('guard-boot-0002'));
  assert.equal(released.lockRelease.status, 'released');
});

test('cli status: reports exists:false on a fresh gateway with no state file', () => {
  const f = fixture();
  const out = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', 'whatever']);
  assert.equal(out.exists, false);
});

// ---------------------------------------------------------------------------
// Crash-resume at write boundaries (verbs batch 1)
// ---------------------------------------------------------------------------

test('crash-resume: every tombstone/publication prefix converges only for the identical arm identity', () => {
  for (const point of ['attempt-tombstone:mid-write', 'attempt-tombstone:after-temp-fsync',
    'attempt-tombstone:after-link', 'attempt-tombstone:after-unlink',
    'attempt-tombstone:after-parent-fsync', 'arm:before-state-publication']) {
    const f = fixture();
    const identity = armIdentity({ deploymentId: `dep-${point.replace(/[^a-z]/g, '-')}` });
    prepareArmClaim(f, identity);
    const identityPath = writeJsonFile(path.join(f.dir, 'identity.json'), identity);
    fs.chmodSync(identityPath, 0o600);
    const expectedSha = lib.canonicalHash(identity);
    const args = ['arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
      '--expected-attempt-sha256', expectedSha, '--identity', identityPath];
    const crashed = runCli(args, withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: point }));
    assert.equal(crashed.status, 137, `${point}: ${crashed.stderr}`);
    assert.equal(fs.existsSync(f.state), false, point);
    const resumed = runCliOk(args, withBoot(GB1));
    assert.equal(resumed.phase, 'armed', point);
    assert.equal(lib.readState(f.state).parentDeployment.attemptSha256, expectedSha, point);

    fs.rmSync(f.state);
    const changed = { ...identity, targetCommitSha: 'b'.repeat(40) };
    const changedPath = writeJsonFile(path.join(f.dir, 'changed.json'), changed); fs.chmodSync(changedPath, 0o600);
    const rejected = runCliFail(['arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
      '--expected-attempt-sha256', lib.canonicalHash(changed), '--identity', changedPath], withBoot(GB1));
    assert.match(rejected.parsed.code, /attempt|conflict|mismatch/);
  }
});

test('crash-resume: finish killed after receipt fsync but before state rename resumes deterministically without rewriting the receipt', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const crashed = runCli([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ], { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'receipt:deployment:after-parent-fsync' } });
  assert.equal(crashed.status, 137);
  const statusAfterCrash = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(statusAfterCrash.parentDeployment.phase, 'runtime-verified', 'state must not have advanced yet');
  const receiptBefore = lib.readReceipt(f.receipts, identity.deploymentId, 'deployment');
  assert.ok(receiptBefore, 'receipt must already be on disk from the crashed attempt');

  const resumed = runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  assert.equal(resumed.phase, 'verification-in-flight');
  assert.equal(resumed.deploymentReceiptSha256, receiptBefore.sha256, 'resume must reuse the already-fsynced receipt, not rewrite it');
});

test('crash-resume: finish killed after the state rename but before parent-dir fsync still resumes correctly (idempotent CAS target)', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const crashed = runCli([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ], { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'state-write:after-rename' } });
  assert.equal(crashed.status, 137);
  const status = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(status.parentDeployment.phase, 'verification-in-flight', 'rename already landed the new phase durably');
  // A second finish attempt at this point correctly fails closed: the
  // parent is no longer at runtime-verified.
  const retry = runCliFail([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  assert.equal(retry.parsed.code, 'cas-mismatch');
});

test('crash-resume: arm killed after tmp-write fsync but before rename leaves no visible state change', () => {
  const f = fixture();
  const identity = armIdentity();
  prepareArmClaim(f, identity);
  const identityPath = writeJsonFile(path.join(f.dir, 'identity.json'), identity);
  const expectedSha = lib.canonicalHash(identity);
  const crashed = runCli([
    'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
    '--expected-attempt-sha256', expectedSha, '--identity', identityPath,
  ], withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: 'state-write:after-tmp-fsync' }));
  assert.equal(crashed.status, 137);
  assert.equal(fs.existsSync(f.state), false);
  // No stray temp files left in the target directory's final listing name
  // (best-effort: at minimum the real target must not exist).
});

// ---------------------------------------------------------------------------
// Section 4: CLI spawn tests, verbs batch 2 (begin-recovery, recover)
// ---------------------------------------------------------------------------

function armAndFinish(f, identityOverrides = {}) {
  const { identity } = armViaCli(f, identityOverrides);
  advanceToRuntimeVerified(f, identity.deploymentId);
  const finished = runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  return { identity, finished };
}

function plantStaleLockOwner(f, deploymentId, { pid = 999999, bootId = 'boot-test' } = {}) {
  fs.mkdirSync(f.lockDir, { recursive: true, mode: 0o700 });
  lib.writeLockOwner(f.lockDir, {
    deploymentId,
    pid,
    processStartTime: '1',
    bootId,
    targetCommitSha: 'a'.repeat(40),
    controllerGeneration: 1,
    acquiredAt: '2026-07-16T00:00:00.000Z',
  });
}

function parentReceiptsFileForVerificationInFlight(f, deploymentReceiptSha256) {
  return writeJsonFile(path.join(f.dir, 'parent-receipts.json'), { deploymentReceiptSha256 });
}

function restoredPredecessorIdentityFile(f, overrides = {}) {
  const state = lib.readState(f.state);
  const previous = state && state.parentDeployment.previousTerminal;
  const obj = previous ? {
    kind: 'managed-terminal',
    deploymentId: previous.deploymentId,
    terminalTupleSha256: previous.terminalTupleSha256,
    ...overrides,
  } : legacyCompatibilityPredecessor({
    compatibilityManifestSha256: '91'.repeat(32),
    topologySha256: '92'.repeat(32),
    databaseIdentitySha256: '94'.repeat(32),
    flowStamp: '2026-07-18T00-00-00Z',
    ...overrides,
  });
  return { obj, path: writeJsonFile(path.join(f.dir, 'restored-predecessor.json'), obj) };
}

function beginRecoveryViaCli(f, { identity, finished, operationId = 'rec-1' } = {}) {
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const { path: identityPath, obj: predecessor } = restoredPredecessorIdentityFile(f);
  const out = runCliOk([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', operationId, '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', parentReceiptsPath,
    '--identity', identityPath,
  ]);
  return { out, predecessor, operationId };
}

test('cli begin-recovery: happy path links a recovery sub-operation from verification-in-flight', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  const { out, predecessor } = beginRecoveryViaCli(f, { identity, finished });
  assert.equal(out.ok, true);
  const status = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(status.activeSubOperation.kind, 'recovery');
  assert.equal(status.activeSubOperation.operationId, 'rec-1');
  assert.equal(status.activeSubOperation.parentDeploymentId, identity.deploymentId);
  assert.equal(status.activeSubOperation.restoredPredecessorSha256, lib.restoredPredecessorSha256(predecessor));
  assert.equal(status.parentDeployment.leaseActive, true);
});

test('cli begin-recovery: verification-in-flight requires the exact immutable deployment receipt file', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  fs.rmSync(path.join(f.receipts, `${identity.deploymentId}.deployment.json`));
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-missing-deployment', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', parentReceiptsPath,
    '--identity', identityPath,
  ]);
  assert.match(parsed.code, /receipt/);
  assert.equal(lib.readState(f.state).activeSubOperation, null);
});

test('cli begin-recovery: tampered immutable deployment receipt bytes are rejected even when mutable state and caller tuple agree', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  const deploymentPath = path.join(f.receipts, `${identity.deploymentId}.deployment.json`);
  const content = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
  content.result = 'tampered-after-finish';
  fs.writeFileSync(deploymentPath, JSON.stringify(content), { mode: 0o600 });
  fs.chmodSync(deploymentPath, 0o600);
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-tampered-deployment', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', parentReceiptsPath,
    '--identity', identityPath,
  ]);
  assert.equal(parsed.code, 'receipt-mismatch');
  assert.equal(lib.readState(f.state).activeSubOperation, null);
});

test('cli begin-recovery: wrong-kind content at the immutable deployment receipt path is rejected', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  const deploymentPath = path.join(f.receipts, `${identity.deploymentId}.deployment.json`);
  fs.writeFileSync(deploymentPath, JSON.stringify(validAcceptanceReceiptContent({
    operationId: identity.deploymentId,
    deploymentId: identity.deploymentId,
    deploymentReceiptSha256: finished.deploymentReceiptSha256,
  })), { mode: 0o600 });
  fs.chmodSync(deploymentPath, 0o600);
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-wrong-kind-deployment', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', parentReceiptsPath,
    '--identity', identityPath,
  ]);
  assert.match(parsed.code, /shape|receipt|unknown-field/);
  assert.equal(lib.readState(f.state).activeSubOperation, null);
});

test('cli begin-recovery: completed terminal archives its tuple and clears prior release authority', () => {
  const f = fixture();
  runCliOk([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ], withBoot(GB1));
  const { identity, finished } = armAndFinish(f);
  const completed = runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256,
    '--acceptance', acceptanceFile(f),
  ], withBoot(GB1));
  runCliOk([
    'release-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId,
    '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256,
  ], withBoot(GB1));
  const terminal = lib.readState(f.state).parentDeployment;
  const receipts = {
    completionKind: 'deployment',
    deploymentReceiptSha256: terminal.deploymentReceiptSha256,
    acceptanceReceiptSha256: terminal.acceptanceReceiptSha256,
  };
  const receiptsPath = writeJsonFile(path.join(f.dir, 'completed-parent-receipts.json'), receipts);
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  runCliOk([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-after-completed', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'completed', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ], withBoot(GB1));
  const linked = lib.readState(f.state);
  assert.deepEqual(linked.parentDeployment.previousTerminal, {
    deploymentId: identity.deploymentId,
    generation: terminal.generation,
    phase: 'completed',
    receiptsSha256: lib.canonicalHash(receipts),
    terminalTupleSha256: lib.terminalTupleSha256('completed', receipts),
  });
  assert.equal(linked.parentDeployment.lockRelease, null);
  assert.equal(linked.parentDeployment.lockOwnerHandoff, null);
  assert.equal(linked.activeSubOperation.operationId, 'rec-after-completed');
});

test('cli begin-recovery: completed receipt hashes cannot conceal a broken deployment-to-acceptance cross-link', () => {
  const f = fixture();
  runCliOk([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ], withBoot(GB1));
  const { identity, finished } = armAndFinish(f);
  runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256,
    '--acceptance', acceptanceFile(f),
  ], withBoot(GB1));
  const acceptancePath = path.join(f.receipts, `${identity.deploymentId}.acceptance.json`);
  const acceptance = JSON.parse(fs.readFileSync(acceptancePath, 'utf8'));
  acceptance.deploymentReceiptSha256 = 'f'.repeat(64);
  fs.writeFileSync(acceptancePath, JSON.stringify(acceptance), { mode: 0o600 });
  fs.chmodSync(acceptancePath, 0o600);
  const tamperedAcceptanceSha256 = lib.sha256Hex(fs.readFileSync(acceptancePath));
  const state = lib.readState(f.state);
  state.parentDeployment.acceptanceReceiptSha256 = tamperedAcceptanceSha256;
  lib.writeState(f.state, state);
  const receipts = {
    completionKind: 'deployment',
    deploymentReceiptSha256: state.parentDeployment.deploymentReceiptSha256,
    acceptanceReceiptSha256: tamperedAcceptanceSha256,
  };
  const receiptsPath = writeJsonFile(path.join(f.dir, 'broken-cross-link-receipts.json'), receipts);
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-broken-cross-link', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'completed', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ]);
  assert.equal(parsed.code, 'receipt-mismatch');
  assert.equal(lib.readState(f.state).activeSubOperation, null);
});

test('cli begin-recovery: recovered terminal can link a second recovery with fresh owner authority', () => {
  const f = fixture();
  const predecessorTuple = {
    deploymentId: 'dep-before', generation: 8, phase: 'completed',
    receiptsSha256: '1'.repeat(64), terminalTupleSha256: '2'.repeat(64),
  };
  const predecessor = {
    kind: 'managed-terminal', deploymentId: predecessorTuple.deploymentId,
    terminalTupleSha256: predecessorTuple.terminalTupleSha256,
  };
  const restoredPredecessorSha256 = lib.restoredPredecessorSha256(predecessor);
  const proofPath = path.join(f.dir, 'compatibility-set', 'topology-restoration-proof.json');
  const targetSafetyManifestPath = path.join(f.dir, 'compatibility-set', 'target-safety-manifest.json');
  const proofContent = {
    format: 1,
    kind: 'TRAIN_A_TOPOLOGY_RESTORATION_PROOF',
    deploymentId: 'dep-current',
    liveRootPath: f.dir,
    compatibilityManifestSha256: '7'.repeat(64),
    topologyManifestSha256: '8'.repeat(64),
    targetSafetyManifestPath,
    targetSafetyManifestSha256: '9'.repeat(64),
    guardGenerationSha256: 'a'.repeat(64),
    restoredTopologySha256: 'b'.repeat(64),
    restoredMetadataSha256: 'c'.repeat(64),
    uciIdentitySha256: 'd'.repeat(64),
    uciReview: {
      previousUciIdentitySha256: 'd'.repeat(64),
      healedUciIdentitySha256: 'd'.repeat(64),
      decision: 'unchanged',
      comparisonPath: null,
      comparisonSha256: null,
    },
    sixLinkTopologySha256: 'e'.repeat(64),
    restoredPredecessor: predecessor,
    restoredPredecessorSha256,
  };
  writeJsonFile(proofPath, proofContent);
  fs.chmodSync(path.dirname(proofPath), 0o700);
  const proofSha256 = lib.sha256Hex(fs.readFileSync(proofPath));
  const recoveryReceipt = lib.writeReceipt(f.receipts, 'rec-first', 'recovery', {
    format: 1,
    receiptKind: 'recovery',
    operationId: 'rec-first',
    parentDeploymentId: 'dep-current',
    restoredPredecessorSha256,
    parentReceiptsSha256: predecessorTuple.receiptsSha256,
    jailedHealthResultSha256: 'f'.repeat(64),
    postProbeAuditSha256: '0'.repeat(64),
    zeroMutationProofSha256: '1'.repeat(64),
    createdAt: '2026-07-19T00:00:00.000Z',
  });
  const topologyReceipt = lib.writeReceipt(f.receipts, 'rec-first', 'topology-activation', {
    format: 1,
    receiptKind: 'topology-activation',
    authorityKind: 'guard-bootstrap',
    operationId: 'rec-first',
    deploymentId: 'dep-current',
    topologyOutcome: 'restored',
    guardGeneration: 9,
    guardGenerationSha256: proofContent.guardGenerationSha256,
    sixLinkTopologySha256: proofContent.sixLinkTopologySha256,
    guardAware94: { state: 'present', sha256: 'f'.repeat(64) },
    inhibitorSha256: '6'.repeat(64),
    topologyRestorationProofPath: proofPath,
    topologyRestorationProofSha256: proofSha256,
    compatibilityManifestSha256: proofContent.compatibilityManifestSha256,
    createdAt: '2026-07-19T00:00:01.000Z',
  });
  const recoveredReceipts = {
    recoveryReceiptSha256: recoveryReceipt.sha256,
    topologyActivationReceiptSha256: topologyReceipt.sha256,
    restoredPredecessor: predecessor,
    restoredPredecessorSha256,
  };
  const oldHandoff = {
    format: 1, kind: 'RECOVERY_LOCK_OWNER_HANDOFF', parentDeploymentId: 'dep-current',
    recoveryOperationId: 'rec-first', originalLockOwnerSha256: '5'.repeat(64),
    recoveryLockOwnerSha256: '6'.repeat(64), originalOwnerDeploymentId: 'dep-current',
    recoveryOwnerDeploymentId: 'rec-first', reason: 'stale-parent-lock-reclaimed-for-linked-recovery',
    parentGeneration: 9, recoveryGeneration: 3, createdAt: '2026-07-19T00:00:00.000Z',
  };
  const oldRelease = {
    format: 1, status: 'released', operationId: 'rec-first', lockDir: f.lockDir,
    lockOwnerSha256: oldHandoff.recoveryLockOwnerSha256, lockBootId: GB1,
    finalReceiptSha256: recoveredReceipts.recoveryReceiptSha256,
    releaseStartedAt: '2026-07-19T00:00:01.000Z', releasedAt: '2026-07-19T00:00:02.000Z',
  };
  lib.writeState(f.state, {
    format: 2,
    parentDeployment: baseParentDeployment({
      deploymentId: 'dep-current', phase: 'recovered', leaseActive: false, generation: 14,
      previousTerminal: predecessorTuple, recoveryOperationId: 'rec-first',
      recoveryReceiptSha256: recoveredReceipts.recoveryReceiptSha256,
      topologyActivationReceiptSha256: recoveredReceipts.topologyActivationReceiptSha256,
      restoredPredecessor: predecessor,
      restoredPredecessorSha256: recoveredReceipts.restoredPredecessorSha256,
      lockOwnerHandoff: oldHandoff, lockRelease: oldRelease,
    }),
    activeSubOperation: null,
  });
  const receiptsPath = writeJsonFile(path.join(f.dir, 'recovered-parent-receipts.json'), recoveredReceipts);
  const identityPath = writeJsonFile(path.join(f.dir, 'second-recovery-predecessor.json'), predecessor);
  runCliOk([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-second', '--parent-deployment-id', 'dep-current',
    '--parent-phase', 'recovered', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ], withBoot(GB1));
  const linked = lib.readState(f.state);
  assert.equal(linked.parentDeployment.previousTerminal.phase, 'recovered');
  assert.equal(linked.parentDeployment.previousTerminal.terminalTupleSha256,
    lib.terminalTupleSha256('recovered', recoveredReceipts));
  assert.equal(linked.parentDeployment.lockOwnerHandoff, null);
  assert.equal(linked.parentDeployment.lockRelease, null);
  assert.equal(linked.activeSubOperation.operationId, 'rec-second');
});

test('cli begin-recovery: caller cannot invent a managed terminal predecessor', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const inventedPath = writeJsonFile(path.join(f.dir, 'invented-managed-predecessor.json'), {
    kind: 'managed-terminal', deploymentId: 'dep-invented', terminalTupleSha256: 'f'.repeat(64),
  });
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-invented', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', parentReceiptsPath,
    '--identity', inventedPath,
  ]);
  assert.equal(parsed.code, 'predecessor-unverified');
  assert.equal(lib.readState(f.state).activeSubOperation, null);
});

test('cli begin-recovery: a second sub-operation cannot coexist with an active one', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  beginRecoveryViaCli(f, { identity, finished });
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-2', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', parentReceiptsPath,
    '--identity', identityPath,
  ]);
  assert.equal(parsed.code, 'sub-operation-conflict');
});

test('cli begin-recovery: parent-phase mismatch is rejected', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-1', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'completed', '--parent-receipts', parentReceiptsPath,
    '--identity', identityPath,
  ]);
  assert.equal(parsed.code, 'cas-mismatch');
});

test('cli begin-recovery: tampered parent-receipts content is rejected', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  const tamperedPath = writeJsonFile(path.join(f.dir, 'tampered-parent-receipts.json'), { deploymentReceiptSha256: 'f'.repeat(64) });
  const { path: identityPath } = restoredPredecessorIdentityFile(f);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-1', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', tamperedPath,
    '--identity', identityPath,
  ]);
  assert.equal(parsed.code, 'cas-mismatch');
});

test('cli begin-recovery: cross-kind restoredPredecessor identity is rejected', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  const parentReceiptsPath = parentReceiptsFileForVerificationInFlight(f, finished.deploymentReceiptSha256);
  const badPath = writeJsonFile(path.join(f.dir, 'bad-identity.json'), {
    kind: 'managed-terminal',
    deploymentId: 'dep-earlier',
    terminalTupleSha256: 'e'.repeat(64),
    flowStamp: 'nope', // legacy-compatibility-only field
  });
  const { parsed } = runCliFail([
    'begin-recovery', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', 'rec-1', '--parent-deployment-id', identity.deploymentId,
    '--parent-phase', 'verification-in-flight', '--parent-receipts', parentReceiptsPath,
    '--identity', badPath,
  ]);
  assert.equal(parsed.code, 'unknown-field');
});

// Recovery terminal-CAS coverage lives with the guard-bootstrap authorization\n// tests below; ordinary recovery no longer self-issues topology authority.

// ---------------------------------------------------------------------------
// Section 5: permits (issue-probe-permit, startup-check both forms)
// ---------------------------------------------------------------------------

function probeIdentityFile(f, overrides = {}) {
  const authority = startupAuthorityFixture(f);
  const obj = {
    candidateSha256: authority.marker.candidate.sha256,
    databaseIdentitySha256: authority.marker.database.identitySha256,
    mountIdentitySha256: authority.marker.mountIdentitySha256,
    lockOwnerSha256: authority.marker.lockOwner.sha256,
    ...overrides,
  };
  const p = writeJsonFile(path.join(f.dir, 'probe-identity.json'), obj);
  fs.chmodSync(p, 0o600);
  return p;
}

const TEST_GATED_LAUNCHER_BYTES = Buffer.from(`#!/bin/sh
set -eu
[ "$1" = --gated-child ]
gate=$2
shift 2
[ "$1" = --launch-token-sha256 ]
shift 2
[ "$1" = -- ]
shift
IFS= read -r signal < "$gate" || exit 125
[ "$signal" = GO ] || exit 125
exec "$@"
`);

function startupAuthorityFixture(f) {
  if (f.startupAuthority) return f.startupAuthority;
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const candidatePath = path.join(f.dir, 'candidate.json');
  const databasePath = path.join(f.dir, 'farming.db');
  const lockDir = f.lockDir || path.join(f.dir, 'osi-deploy.lock.d');
  const lockOwnerPath = path.join(lockDir, 'owner.json');
  fs.writeFileSync(candidatePath, '{"candidate":"tested"}\n', { mode: 0o600 });
  fs.writeFileSync(databasePath, 'sqlite-test-identity\n', { mode: 0o600 });
  if (!fs.existsSync(lockOwnerPath)) {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    lib.writeLockOwner(lockDir, {
      deploymentId: lib.readState(f.state).parentDeployment.deploymentId,
      pid: process.ppid,
      processStartTime: testProcessStartTime(process.ppid),
      bootId: GB1,
      targetCommitSha: lib.readState(f.state).parentDeployment.targetCommitSha,
      controllerGeneration: lib.readState(f.state).parentDeployment.controllerGeneration,
      acquiredAt: '2026-07-19T00:00:00.000Z',
    });
  }
  const dbStat = fs.statSync(databasePath);
  const residentDir = path.join(f.dir, 'resident');
  fs.mkdirSync(residentDir, { recursive: true, mode: 0o700 });
  const residentNames = {
    stateLibrary: 'osi-deployment-state.js',
    stateCli: 'osi-deployment-state-cli.js',
    guardedLauncher: 'node-red-guarded-launch.js',
  };
  const residents = {};
  for (const [role, name] of Object.entries(residentNames)) {
    const p = path.join(residentDir, name);
    const residentBody = role === 'guardedLauncher' ? TEST_GATED_LAUNCHER_BYTES : `resident:${role}\n`;
    fs.writeFileSync(p, residentBody, { mode: role === 'stateLibrary' ? 0o600 : 0o700 });
    const stat = fs.statSync(p);
    residents[role] = { path: p, sha256: lib.sha256Hex(fs.readFileSync(p)), mode: stat.mode & 0o777 };
  }
  const liveControlPaths = [
    '/etc/init.d/node-red', '/etc/init.d/osi-bootstrap', '/etc/init.d/osi-db-integrity', '/etc/init.d/osi-identityd',
    '/usr/libexec/osi-gateway-identity.sh', '/usr/libexec/osi-identityd.sh',
    '/etc/init.d/osi-deployment-inhibit', '/usr/libexec/osi-deployment-inhibit.sh',
    '/etc/uci-defaults/94_osi_identityd_enable',
    '/usr/libexec/osi-current-role-state', '/usr/libexec/osi-record-role-start',
  ];
  const liveControls = liveControlPaths.map((logicalPath) => {
    const actual = path.join(f.dir, `.${logicalPath}`);
    fs.mkdirSync(path.dirname(actual), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(actual)) {
      fs.writeFileSync(actual, `control:${logicalPath}\n`, { mode: 0o755 });
      fs.chmodSync(actual, 0o755);
    }
    const stat = fs.lstatSync(actual);
    return { path: logicalPath, sha256: lib.sha256Hex(fs.readFileSync(actual)), mode: stat.mode & 0o777 };
  });
  const s01 = path.join(f.dir, 'etc/rc.d/S01osi-deployment-inhibit');
  fs.mkdirSync(path.dirname(s01), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(s01)) fs.symlinkSync('../init.d/osi-deployment-inhibit', s01);
  const targetSafetyManifestPath = path.join(f.dir, 'compatibility-set/target-safety-manifest.json');
  let targetSafety;
  if (fs.existsSync(targetSafetyManifestPath)) {
    const existing = JSON.parse(fs.readFileSync(targetSafetyManifestPath));
    targetSafety = {
      manifestPath: targetSafetyManifestPath,
      manifestSha256: lib.sha256Hex(fs.readFileSync(targetSafetyManifestPath)),
      guardGenerationSha256: existing.guardGenerationSha256,
    };
  } else {
    const guardGenerationSha256 = 'fa'.repeat(32);
    const manifest = {
      format: 1, kind: 'TRAIN_A_TARGET_SAFETY',
      deploymentId: lib.readState(f.state).parentDeployment.deploymentId,
      manifestPath: targetSafetyManifestPath,
      guardGenerationSha256,
      entries: lib.collectTopologyPathSet(f.dir, lib.TARGET_SAFETY_PATHS),
    };
    writeJsonFile(targetSafetyManifestPath, manifest);
    targetSafety = {
      manifestPath: targetSafetyManifestPath,
      manifestSha256: lib.sha256Hex(fs.readFileSync(targetSafetyManifestPath)),
      guardGenerationSha256,
    };
  }
  const mountInfoText = `36 25 8:1 / ${f.dir} rw,relatime - ext4 /dev/osi-test rw\n`;
  const mountInfoPath = path.join(f.dir, 'mountinfo.test');
  fs.writeFileSync(mountInfoPath, mountInfoText, { mode: 0o600 });
  const marker = {
    format: 1,
    deploymentId: lib.readState(f.state).parentDeployment.deploymentId,
    rootPath: f.dir,
    statePath: f.state,
    receiptsPath: f.receipts,
    mountIdentitySha256: require('./deployment-state-cli').computeMountIdentity(f.dir, { mountInfoText, artifactMode: 'test' }).sha256,
    candidate: { path: candidatePath, sha256: lib.sha256Hex(fs.readFileSync(candidatePath)) },
    database: {
      path: databasePath,
      identitySha256: lib.canonicalHash({ device: dbStat.dev, inode: dbStat.ino }),
    },
    lockOwner: { path: lockOwnerPath, sha256: lib.sha256Hex(fs.readFileSync(lockOwnerPath)) },
    residents,
    liveRootPath: f.dir,
    liveControls,
    targetSafety,
    sixLinkTopologySha256: GUARD_SIXLINK_SHA,
    uciIdentitySha256: lib.canonicalHash({ status: 'absent' }),
    nodeRedLaunch: {
      executable: '/usr/bin/node-red',
      argvSha256: lib.sha256Hex(Buffer.from(JSON.stringify(['/usr/bin/node-red', '--userDir', '/srv/node-red']))),
    },
  };
  const markerPath = writeJsonFile(path.join(f.dir, 'guard-installed.json'), marker);
  fs.chmodSync(markerPath, 0o600);
  f.startupAuthority = { marker, markerPath };
  return f.startupAuthority;
}

function guardMarkerFile(f) {
  return startupAuthorityFixture(f).markerPath;
}

test('startup guard marker binds the complete live control, six-link, and UCI authority set', () => {
  const f = fixture();
  armViaCli(f);
  const { marker } = startupAuthorityFixture(f);
  assert.equal(marker.liveRootPath, f.dir);
  assert.deepEqual(marker.liveControls.map((entry) => entry.path), [
    '/etc/init.d/node-red', '/etc/init.d/osi-bootstrap', '/etc/init.d/osi-db-integrity', '/etc/init.d/osi-identityd',
    '/usr/libexec/osi-gateway-identity.sh', '/usr/libexec/osi-identityd.sh',
    '/etc/init.d/osi-deployment-inhibit', '/usr/libexec/osi-deployment-inhibit.sh',
    '/etc/uci-defaults/94_osi_identityd_enable',
    '/usr/libexec/osi-current-role-state', '/usr/libexec/osi-record-role-start',
  ]);
  assert.equal(marker.targetSafety.manifestPath,
    path.join(f.dir, 'compatibility-set/target-safety-manifest.json'));
  assert.match(marker.sixLinkTopologySha256, /^[0-9a-f]{64}$/);
  assert.match(marker.uciIdentitySha256, /^[0-9a-f]{64}$/);
});

test('startup mount authority rejects a caller-selected volatile-root waiver', () => {
  const f = fixture();
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  assert.throws(
    () => require('./deployment-state-cli').computeMountIdentity(f.dir, { allowVolatileTestRoot: true }),
    /test root|volatile|authority/i
  );
});

test('startup mount authority rejects a symlink in every root ancestor', () => {
  const d = tmpDir();
  const real = path.join(d, 'real');
  const alias = path.join(d, 'alias');
  fs.mkdirSync(path.join(real, 'osi-deploy'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(real, alias);
  assert.throws(
    () => require('./deployment-state-cli').computeMountIdentity(path.join(alias, 'osi-deploy'), { allowVolatileTestRoot: true }),
    /ancestor|symlink/i
  );
});

test('startup mount identity survives remount-generated mount and propagation IDs', () => {
  const f = fixture();
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const first = `36 25 8:1 / ${f.dir} rw,relatime shared:7 master:2 - ext4 /dev/osi-test rw,errors=continue`;
  const remounted = `903 811 8:1 / ${f.dir} relatime,rw shared:712 master:299 - ext4 /dev/osi-test errors=continue,rw`;
  const compute = (mountInfoText) => require('./deployment-state-cli').computeMountIdentity(
    f.dir, { mountInfoText, artifactMode: 'test' }
  );
  const before = compute(first);
  const after = compute(remounted);
  assert.equal(after.sha256, before.sha256, 'kernel-generated IDs and option ordering are not persistent identity');
  assert.equal(Object.hasOwn(before.facts.selected, 'id'), false);
  assert.equal(Object.hasOwn(before.facts.selected, 'parentId'), false);
  assert.equal(Object.hasOwn(before.facts.selected, 'optionalFields'), false);
});

test('persistent mutation root accepts direct/overlay persistence and rejects volatile, nested, and unsafe roots', () => {
  const boundary = path.join(os.tmpdir(), `osi-deploy-startup-tests-${process.getuid()}`);
  const adapter = path.join(boundary, 'mutation-mountinfo.test');
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  fs.chmodSync(boundary, 0o700);
  const saved = {
    artifact: process.env.OSI_DEPLOY_ARTIFACT_MODE,
    boundary: process.env.OSI_DEPLOY_TEST_BOUNDARY,
    adapter: process.env.OSI_DEPLOY_MUTATION_TEST_MOUNTINFO,
  };
  process.env.OSI_DEPLOY_ARTIFACT_MODE = 'test';
  process.env.OSI_DEPLOY_TEST_BOUNDARY = boundary;
  process.env.OSI_DEPLOY_MUTATION_TEST_MOUNTINFO = adapter;
  const writeMounts = (lines) => {
    fs.writeFileSync(adapter, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(adapter, 0o600);
  };
  try {
    writeMounts([`36 25 8:1 / ${boundary} rw,relatime - ext4 /dev/test rw`]);
    assert.equal(lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')).mode, 'persistent-direct');

    writeMounts([
      `36 25 8:1 / ${boundary} rw,relatime - ext4 /dev/test rw`,
      '37 25 8:1 / /full-filesystem-shadow rw,relatime - ext4 /dev/test rw',
    ]);
    assert.throws(
      () => lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')),
      /alias|duplicate|shadow/i,
      'a full-filesystem-root bind shadow has no bind token and must still be rejected'
    );

    writeMounts([
      `36 25 0:45 / ${boundary} rw,relatime - overlay overlay rw,lowerdir=/lower,upperdir=/persist/upper,workdir=/persist/work`,
      '37 25 8:1 / /persist rw,relatime - ext4 /dev/test rw',
    ]);
    assert.equal(lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')).mode, 'persistent-overlay-upperdir');

    writeMounts([
      `36 25 0:45 / ${boundary} rw,relatime - overlay overlay rw,lowerdir=/lower,upperdir=/persist/upper,workdir=/persist/work`,
      '39 25 0:45 / /duplicate-overlay-root rw,relatime - overlay overlay rw,lowerdir=/other-lower,upperdir=/other-upper,workdir=/other-work',
      '37 25 8:1 / /persist rw,relatime - ext4 /dev/test rw',
    ]);
    assert.throws(() => lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')),
      /overlay.*duplicate|duplicate.*overlay|filesystem-root/i);

    writeMounts([`36 25 0:44 / ${boundary} rw,relatime - tmpfs tmpfs rw`]);
    assert.throws(() => lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')), /volatile/i);

    writeMounts([`36 25 8:1 /aliased-root ${boundary} rw,relatime - ext4 /dev/test rw`]);
    assert.throws(
      () => lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')),
      /direct persistent|alias/i
    );

    writeMounts([
      `36 25 0:45 / ${boundary} rw,relatime - overlay overlay rw,lowerdir=/lower,upperdir=/persist/upper,workdir=/persist/work`,
      '37 25 8:1 / /persist rw,relatime - ext4 /dev/test rw',
      '38 25 8:2 / /persist rw,relatime - ext4 /dev/test2 rw',
    ]);
    assert.throws(
      () => lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')),
      /one unaliased persistent block mount|ambiguous/i
    );

    writeMounts([
      `36 25 8:1 / ${boundary} rw,relatime - ext4 /dev/test rw`,
      `37 36 8:2 / ${boundary}/receipts rw,relatime - ext4 /dev/test2 rw`,
    ]);
    assert.throws(() => lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')), /nested/i);

    writeMounts([`36 25 8:1 / ${boundary} rw,relatime - ext4 /dev/test rw`]);
    fs.chmodSync(boundary, 0o777);
    assert.throws(() => lib.validatePersistentMutationRoot(path.join(boundary, 'state.json')), /owner\/mode/i);
  } finally {
    fs.chmodSync(boundary, 0o700);
    if (saved.artifact === undefined) delete process.env.OSI_DEPLOY_ARTIFACT_MODE; else process.env.OSI_DEPLOY_ARTIFACT_MODE = saved.artifact;
    if (saved.boundary === undefined) delete process.env.OSI_DEPLOY_TEST_BOUNDARY; else process.env.OSI_DEPLOY_TEST_BOUNDARY = saved.boundary;
    if (saved.adapter === undefined) delete process.env.OSI_DEPLOY_MUTATION_TEST_MOUNTINFO; else process.env.OSI_DEPLOY_MUTATION_TEST_MOUNTINFO = saved.adapter;
    fs.rmSync(adapter, { force: true });
  }
});

test('mountinfo decoder handles the kernel newline escape in every decoded path field', () => {
  const [mount] = lib.parseMountInfo('36 25 8:1 /root\\012part /point\\012part rw - ext4 /dev/disk\\012name rw\n');
  assert.equal(mount.mountRoot, '/root\npart');
  assert.equal(mount.point, '/point\npart');
  assert.equal(mount.source, '/dev/disk\nname');
});

function ensureRoot(f) {
  fs.mkdirSync(f.dir, { recursive: true });
  return f.dir;
}

function advanceToProbesRunning(f, deploymentId) {
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty-probes.json'), {});
  const chain = ['writers-stopped', 'protocol-initializing', 'protocol-ready', 'resident-mutating', 'payload-mutating', 'probes-running'];
  let expectedPhase = 'armed';
  for (const phase of chain) {
    runCliOk([
      'advance', '--state', f.state, '--deployment-id', deploymentId,
      '--expected-phase', expectedPhase, '--phase', phase, '--patch', emptyPatch,
    ]);
    expectedPhase = phase;
  }
}

function armAndAdvanceToProbesRunning(f, identityOverrides = {}) {
  const { identity } = armViaCli(f, identityOverrides);
  advanceToProbesRunning(f, identity.deploymentId);
  return { identity };
}

test('cli issue-probe-permit: happy path for deployment-probe at probes-running', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = path.join(f.permits, `${identity.deploymentId}.1.nonce`);
  const out = runCliOk([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', noncePath,
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.noncePath, noncePath);
  assert.equal(out.generation, 1);
  assert.equal(fs.existsSync(noncePath), true);
  assert.equal(fs.statSync(noncePath).mode & 0o777, 0o600);
  // The raw nonce value must never appear in stdout.
  assert.equal(JSON.stringify(out).includes(JSON.parse(fs.readFileSync(noncePath, 'utf8')).nonce), false);
});

test('cli issue-probe-permit: rejects an unknown purpose', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const { parsed } = runCliFail([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'not-a-real-purpose', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', path.join(f.permits, `${identity.deploymentId}.1.nonce`),
  ]);
  assert.equal(parsed.code, 'shape');
});

test('cli issue-probe-permit: rejects a non-node-red service', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const { parsed } = runCliFail([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'osi-identityd',
    '--identity', probeIdentityFile(f), '--nonce-out', path.join(f.permits, `${identity.deploymentId}.1.nonce`),
  ]);
  assert.equal(parsed.code, 'shape');
});

test('cli issue-probe-permit: purposes with no satisfiable context in this slice are rejected', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const { parsed } = runCliFail([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'rehearsal-old-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', path.join(f.permits, `${identity.deploymentId}.1.nonce`),
  ]);
  assert.equal(parsed.code, 'purpose-not-satisfiable');
});

test('cli issue-probe-permit: rejects issuance outside probes-running', () => {
  const f = fixture();
  const { identity } = armViaCli(f);
  const { parsed } = runCliFail([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'armed', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', path.join(f.permits, `${identity.deploymentId}.1.nonce`),
  ]);
  assert.equal(parsed.code, 'cas-mismatch');
});

test('cli issue-probe-permit: wrong nonce-out generation is rejected', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const { parsed } = runCliFail([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', path.join(f.permits, `${identity.deploymentId}.7.nonce`),
  ]);
  assert.equal(parsed.code, 'generation-mismatch');
});

test('cli issue-probe-permit: re-issuing while a live permit is outstanding is refused', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  runCliOk([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', path.join(f.permits, `${identity.deploymentId}.1.nonce`),
  ]);
  const { parsed } = runCliFail([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', path.join(f.permits, `${identity.deploymentId}.2.nonce`),
  ]);
  assert.equal(parsed.code, 'permit-already-issued');
});

test('cli issue-probe-permit: recovery-health is unsatisfiable at every current recovery phase', () => {
  for (const phase of ['recovery-started', 'recovery-topology-verifying', 'recovery-topology-authorized']) {
    const f = fixture();
    const { identity, finished } = armAndFinish(f);
    const { operationId } = beginRecoveryViaCli(f, { identity, finished });
    const state = lib.readState(f.state);
    state.activeSubOperation.phase = phase;
    lib.writeState(f.state, state);
    const noncePath = path.join(f.permits, `${operationId}.1.nonce`);
    const { parsed } = runCliFail([
      'issue-probe-permit', '--state', f.state, '--operation-id', operationId,
      '--expected-phase', phase, '--purpose', 'recovery-health', '--service', 'node-red',
      '--identity', probeIdentityFile(f), '--nonce-out', noncePath,
    ]);
    assert.equal(parsed.code, 'purpose-not-satisfiable', phase);
    assert.equal(fs.existsSync(noncePath), false, `${phase}: nonce must not be published`);
    assert.equal(lib.readState(f.state).activeSubOperation.probePermit, undefined);
  }
});

function testOnlyRecoveryPermit(f, state, { status = 'consumed', noncePath, nonce = 'test-only-recovery-nonce' } = {}) {
  const identity = JSON.parse(fs.readFileSync(probeIdentityFile(f), 'utf8'));
  const sub = state.activeSubOperation;
  return {
    purpose: 'recovery-health',
    operationId: sub.operationId,
    deploymentId: state.parentDeployment.deploymentId,
    phaseAtIssuance: sub.phase,
    holderGenerationAtIssuance: sub.generation,
    service: 'node-red',
    candidateSha256: identity.candidateSha256,
    databaseIdentitySha256: identity.databaseIdentitySha256,
    mountIdentitySha256: identity.mountIdentitySha256,
    lockOwnerSha256: identity.lockOwnerSha256,
    bootId: lib.getBootId(),
    noncePath: noncePath || path.join(f.permits, `${sub.operationId}.1.nonce`),
    nonceSha256: lib.sha256Hex(nonce),
    generation: 1,
    status,
    launchAuthorization: null,
    issuedAt: '2026-07-19T00:00:00.000Z',
    expiresAt: '2099-07-19T00:05:00.000Z',
  };
}

test('cli startup-check: no public Commit 1 command can consume a planted recovery-health permit', () => {
  const f = fixture();
  const { identity, finished } = armAndFinish(f);
  beginRecoveryViaCli(f, { identity, finished });
  const state = lib.readState(f.state);
  const noncePath = path.join(f.permits, `${state.activeSubOperation.operationId}.1.nonce`);
  const nonce = 'test-only-recovery-nonce';
  fs.mkdirSync(path.dirname(noncePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(noncePath), 0o700);
  fs.writeFileSync(noncePath, JSON.stringify({ nonce }), { mode: 0o600 });
  state.activeSubOperation.probePermit = testOnlyRecoveryPermit(f, state, { status: 'issued', noncePath, nonce });
  lib.writeState(f.state, state);

  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  assert.equal(parsed.code, 'purpose-not-satisfiable');
  assert.equal(lib.readState(f.state).activeSubOperation.probePermit.status, 'issued');
  assert.equal(fs.existsSync(noncePath), true, 'failed consumption leaves the nonce and state unchanged');
});

function issuePermitAndGetNonceContents(f, identity, generation = 1) {
  const noncePath = path.join(f.permits, `${identity.deploymentId}.${generation}.nonce`);
  runCliOk([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', noncePath,
  ]);
  return noncePath;
}

test('cli startup-check: an issued permit is bound to the exact holder phase and generation', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const changed = lib.readState(f.state);
  changed.parentDeployment.generation += 1;
  changed.parentDeployment.updatedAt = '2026-07-19T00:00:01.000Z';
  lib.writeState(f.state, changed);
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  assert.equal(parsed.code, 'permit-state-mismatch');
  assert.equal(fs.existsSync(noncePath), true, 'a mismatched permit must not be consumed');
});

test('cli startup-check: non-node-red service cannot pass a nonterminal phase', () => {
  const f = fixture();
  ensureRoot(f);
  armViaCli(f);
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'osi-identityd',
  ]);
  assert.equal(parsed.code, 'phase-not-authorized');
});

test('cli startup-check: non-node-red service passes only after all completed terminal receipts verify', () => {
  const f = fixture();
  ensureRoot(f);
  runCliOk([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ], withBoot(GB1));
  const { identity, finished } = armAndFinish(f);
  const completed = runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
  ]);
  assert.equal(completed.phase, 'completed');
  const authority = startupAuthorityFixture(f);
  runCliOk([
    'release-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId, '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256,
  ], withBoot(GB1));
  assert.equal(fs.existsSync(authority.marker.lockOwner.path), false, 'release removes volatile same-boot owner');
  const out = runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'osi-identityd',
  ], withBoot('guard-boot-0002'));
  assert.equal(out.pass, true);
  assert.equal(out.mode, 'terminal-completed');
});

test('cli startup-check: completed terminal receipt operation IDs must bind to the parent deployment', () => {
  const f = fixture();
  ensureRoot(f);
  runCliOk([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ], withBoot(GB1));
  const { identity, finished } = armAndFinish(f);
  const completed = runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256,
    '--acceptance', acceptanceFile(f),
  ]);
  const authority = startupAuthorityFixture(f);
  runCliOk([
    'release-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId,
    '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256,
  ], withBoot(GB1));

  const deploymentPath = path.join(f.receipts, `${identity.deploymentId}.deployment.json`);
  const acceptancePath = path.join(f.receipts, `${identity.deploymentId}.acceptance.json`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
  deployment.operationId = 'wrong-owner';
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment), { mode: 0o600 });
  fs.chmodSync(deploymentPath, 0o600);
  const deploymentSha256 = lib.sha256Hex(fs.readFileSync(deploymentPath));
  const acceptance = JSON.parse(fs.readFileSync(acceptancePath, 'utf8'));
  acceptance.deploymentReceiptSha256 = deploymentSha256;
  fs.writeFileSync(acceptancePath, JSON.stringify(acceptance), { mode: 0o600 });
  fs.chmodSync(acceptancePath, 0o600);
  const acceptanceSha256 = lib.sha256Hex(fs.readFileSync(acceptancePath));
  const state = lib.readState(f.state);
  state.parentDeployment.deploymentReceiptSha256 = deploymentSha256;
  state.parentDeployment.acceptanceReceiptSha256 = acceptanceSha256;
  state.parentDeployment.lockRelease.finalReceiptSha256 = acceptanceSha256;
  lib.writeState(f.state, state);

  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'osi-identityd',
  ], withBoot('guard-boot-0002'));
  assert.equal(parsed.code, 'receipt-mismatch');
});

test('cli startup-check: terminal authority requires leaseActive false and no active sub-operation', () => {
  const f = fixture();
  ensureRoot(f);
  runCliOk([
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ], withBoot(GB1));
  const { identity, finished } = armAndFinish(f);
  const completed = runCliOk([
    'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
    '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
  ]);
  const authority = startupAuthorityFixture(f);
  runCliOk([
    'release-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--operation-id', identity.deploymentId, '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256,
  ], withBoot(GB1));
  const terminal = lib.readState(f.state);
  const leaseOnly = structuredClone(terminal);
  leaseOnly.parentDeployment.leaseActive = true;
  assert.throws(() => lib.writeState(f.state, leaseOnly), /linked recovery|cross-link-mismatch/);

  const restoredPredecessor = managedTerminalPredecessor();
  const subOperation = {
    kind: 'recovery', operationId: 'rec-terminal-blocked', parentDeploymentId: identity.deploymentId,
    parentDeploymentGeneration: terminal.parentDeployment.generation,
    parentPhaseAtLink: 'completed', parentReceiptsSha256: 'b'.repeat(64),
    phase: 'recovery-started', restoredPredecessor,
    restoredPredecessorSha256: lib.restoredPredecessorSha256(restoredPredecessor),
    generation: 1, createdAt: '2026-07-19T00:00:00.000Z',
  };
  const subOnly = structuredClone(terminal);
  subOnly.activeSubOperation = subOperation;
  assert.throws(() => lib.writeState(f.state, subOnly), /linked recovery|cross-link-mismatch/);

  const linkedRecovery = structuredClone(terminal);
  linkedRecovery.parentDeployment.leaseActive = true;
  linkedRecovery.activeSubOperation = subOperation;
  lib.writeState(f.state, linkedRecovery);
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'osi-identityd',
  ]);
  assert.equal(parsed.code, 'terminal-lease-active');
});

test('cli startup-check: terminal startup requires recorded release and rejects a durable lock-owner substitute', () => {
  {
    const f = fixture();
    ensureRoot(f);
    const { identity, finished } = armAndFinish(f);
    runCliOk([
      'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
      '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
    ]);
    const failed = runCliFail([
      'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
      '--state', f.state, '--receipts', f.receipts, '--service', 'osi-identityd',
    ], withBoot('guard-boot-0002'));
    assert.equal(failed.parsed.code, 'lock-release-missing');
  }

  {
    const f = fixture();
    ensureRoot(f);
    runCliOk([
      'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
      '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
    ], withBoot(GB1));
    const { identity, finished } = armAndFinish(f);
    const completed = runCliOk([
      'complete', '--state', f.state, '--receipts', f.receipts, '--lock-dir', f.lockDir, '--operation-id', identity.deploymentId,
      '--expected-deployment-receipt-sha256', finished.deploymentReceiptSha256, '--acceptance', acceptanceFile(f),
    ]);
    const authority = startupAuthorityFixture(f);
    runCliOk([
      'release-lock', '--state', f.state, '--lock-dir', f.lockDir,
      '--operation-id', identity.deploymentId, '--expected-final-receipt-sha256', completed.acceptanceReceiptSha256,
    ], withBoot(GB1));
    const substitutePath = path.join(f.dir, 'durable-lock-owner.json');
    fs.writeFileSync(substitutePath, '{"substitute":true}\n', { mode: 0o600 });
    const marker = JSON.parse(fs.readFileSync(authority.markerPath, 'utf8'));
    marker.lockOwner = { path: substitutePath, sha256: lib.sha256Hex(fs.readFileSync(substitutePath)) };
    fs.writeFileSync(authority.markerPath, JSON.stringify(marker), { mode: 0o600 });
    const failed = runCliFail([
      'startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'osi-identityd',
    ], withBoot('guard-boot-0002'));
    assert.equal(failed.parsed.code, 'marker-binding-mismatch');
  }
});

test('cli startup-check: non-node-red service with --probe-nonce-file is rejected (no probe-permit path)', () => {
  const f = fixture();
  ensureRoot(f);
  armViaCli(f);
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'osi-bootstrap',
    '--probe-nonce-file', path.join(f.permits, 'whatever.1.nonce'),
  ]);
  assert.equal(parsed.code, 'shape');
});

test('cli startup-check: node-red non-consuming preflight passes against an issued, matching permit', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const out = runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath,
  ]);
  assert.equal(out.pass, true);
  assert.equal(out.consumed, false);
  assert.equal(fs.existsSync(noncePath), true, 'non-consuming form must not touch the nonce file');
});

test('cli startup-check: node-red preflight rejects a nonce file whose content does not match', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  fs.writeFileSync(noncePath, JSON.stringify({ nonce: 'f'.repeat(64) }));
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath,
  ]);
  assert.equal(parsed.code, 'nonce-mismatch');
});

test('cli startup-check: node-red preflight fails closed when the nonce file is missing', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  fs.rmSync(noncePath);
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath,
  ]);
  assert.equal(parsed.code, 'nonce-missing');
});

test('cli startup-check: node-red preflight rejects a symlinked probe-nonce-file', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const linkPath = path.join(f.dir, 'nonce-link.json');
  fs.renameSync(noncePath, noncePath + '.real');
  fs.symlinkSync(noncePath + '.real', noncePath);
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath,
  ]);
  assert.equal(parsed.code, 'symlink-rejected');
  void linkPath;
});

test('cli startup-check: nonce consumption requires an owned mode-0600 regular file', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  fs.chmodSync(noncePath, 0o644);
  const failed = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  assert.equal(failed.parsed.code, 'wrong-mode');
  assert.equal(lib.readState(f.state).parentDeployment.probePermit.status, 'issued');
  assert.equal(fs.existsSync(noncePath), true);
});

test('cli startup-check: node-red consuming form consumes the permit and unlinks the nonce, proving absence', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const out = runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  assert.equal(out.consumed, true);
  assert.equal(fs.existsSync(noncePath), false);
  const status = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(status.parentDeployment.probePermit.status, 'consumed');
  assert.equal(status.parentDeployment.probePermit.launchAuthorization.status, 'authorized');
  assert.ok(fs.existsSync(out.launchTokenPath));
});

test('launch authorization attempt lineage is closed over the exact prior abort receipt', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  runCliOk(['startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const parent = lib.readState(f.state).parentDeployment;
  const retryWithoutReceipt = structuredClone(parent);
  retryWithoutReceipt.probePermit.launchAuthorization.attempt = 2;
  assert.throws(() => lib.validateParentDeployment(retryWithoutReceipt), /attempt lineage/);
  const firstWithReceipt = structuredClone(parent);
  firstWithReceipt.probePermit.launchAuthorization.previousAbortReceiptSha256 = 'a'.repeat(64);
  assert.throws(() => lib.validateParentDeployment(firstWithReceipt), /attempt lineage/);
});

test('cli startup-check: exact authorized token retries until a child-start phase is durable', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  const retried = runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  assert.equal(retried.resumed, true);
});

function tokenBoundChildFixture(f, authority) {
  const childPath = path.join(f.dir, 'token-bound-child.js');
  fs.writeFileSync(childPath, 'setInterval(() => {}, 1000);\n', { mode: 0o700 });
  const argv = [process.execPath, childPath, 'arg-one'];
  const marker = JSON.parse(fs.readFileSync(authority.markerPath));
  marker.nodeRedLaunch = { executable: process.execPath, argvSha256: lib.sha256Hex(Buffer.from(JSON.stringify(argv))) };
  fs.writeFileSync(authority.markerPath, JSON.stringify(marker), { mode: 0o600 });
  fs.chmodSync(authority.markerPath, 0o600);
  return { childPath, argv };
}

function gatedCarrierFixture(f, authority, consumed, childFixture, { environmentToken = null } = {}) {
  const launcherPath = authority.marker.residents.guardedLauncher.path;
  const token = JSON.parse(fs.readFileSync(consumed.launchTokenPath)).token;
  const gatePath = consumed.launchTokenPath.replace(/\.launch-token\.json$/, '.launch-gate');
  assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', gatePath]).status, 0);
  const gateFd = fs.openSync(gatePath, fs.constants.O_RDWR);
  const tokenSha256 = lib.sha256Hex(token);
  const carrier = spawn('/bin/sh',
    [launcherPath, '--gated-child', gatePath, '--launch-token-sha256', tokenSha256,
      '--', ...childFixture.argv], {
      detached: true,
      env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: environmentToken || token },
      stdio: 'ignore',
    });
  const startTime = testProcessStartTime(carrier.pid);
  const observedCarrierArgv = fs.readFileSync(`/proc/${carrier.pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  assert.deepEqual(observedCarrierArgv,
    ['/bin/sh', launcherPath, '--gated-child', gatePath, '--launch-token-sha256', tokenSha256,
      '--', ...childFixture.argv],
    `carrier must preserve its canonical argv: ${JSON.stringify(observedCarrierArgv)}`);
  const carrierToken = fs.readFileSync(`/proc/${carrier.pid}/environ`).toString('utf8').split('\0')
    .find((entry) => entry.startsWith('OSI_DEPLOY_LAUNCH_TOKEN='));
  assert.equal(carrierToken, `OSI_DEPLOY_LAUNCH_TOKEN=${environmentToken || token}`);
  const carrierStatRaw = fs.readFileSync(`/proc/${carrier.pid}/stat`, 'utf8');
  const carrierStat = carrierStatRaw.slice(carrierStatRaw.lastIndexOf(')') + 1).trim().split(/\s+/);
  assert.equal(carrierStat[2], String(carrier.pid), 'carrier must lead its process group');
  assert.equal(carrierStat[3], String(carrier.pid), 'carrier must lead its session');
  const recordArgs = ['record-launch-start', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--launch-token-file', consumed.launchTokenPath, '--child-pid', String(carrier.pid),
    '--child-process-starttime', startTime, '--supervisor-pid', String(process.pid),
    '--supervisor-process-starttime', testProcessStartTime(process.pid), '--launch-gate-file', gatePath];
  return { ...childFixture, carrier, gateFd, gatePath, recordArgs, token, startTime };
}

function terminateCarrier(carrier) {
  try { process.kill(-carrier.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

test('cli launch protocol: direct target recording without supervisor and pre-exec gate identity is rejected', async () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const authority = startupAuthorityFixture(f);
  const childFixture = tokenBoundChildFixture(f, authority);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const token = JSON.parse(fs.readFileSync(consumed.launchTokenPath)).token;
  const child = spawn(process.execPath, [childFixture.childPath, 'arg-one'], {
    env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: token }, stdio: 'ignore',
  });
  try {
    const failed = runCliFail(['record-launch-start', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--launch-token-file', consumed.launchTokenPath, '--child-pid', String(child.pid),
      '--child-process-starttime', testProcessStartTime(child.pid)]);
    assert.equal(failed.parsed.code, 'missing-flag');
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('cli launch protocol: records the gated carrier and binds supervisor, carrier, target, token, PID and starttime', async () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const authority = startupAuthorityFixture(f);
  const childFixture = tokenBoundChildFixture(f, authority);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const gated = gatedCarrierFixture(f, authority, consumed, childFixture);
  try {
    const recorded = runCliOk(gated.recordArgs, { env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: gated.token } });
    assert.equal(recorded.resumed, false);
    const launch = lib.readState(f.state).parentDeployment.probePermit.launchAuthorization;
    assert.equal(launch.status, 'child-started');
    assert.equal(launch.childPid, gated.carrier.pid);
    assert.equal(launch.supervisorPid, process.pid);
    assert.match(launch.carrierArgvSha256, /^[0-9a-f]{64}$/);
    fs.writeSync(gated.gateFd, 'GO\n');
  } finally {
    fs.closeSync(gated.gateFd);
    terminateCarrier(gated.carrier);
  }
});

test('cli launch protocol: exact carrier and target argv without the exact raw token are rejected', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const authority = startupAuthorityFixture(f);
  const childFixture = tokenBoundChildFixture(f, authority);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const gated = gatedCarrierFixture(f, authority, consumed, childFixture, { environmentToken: 'b'.repeat(64) });
  try {
    const failed = runCliFail(gated.recordArgs, {
      env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: gated.token },
    });
    assert.equal(failed.parsed.code, 'launch-token-mismatch');
    assert.equal(lib.readState(f.state).parentDeployment.probePermit.launchAuthorization.status, 'authorized');
  } finally {
    fs.closeSync(gated.gateFd);
    terminateCarrier(gated.carrier);
  }
});

for (const phase of ['carrier', 'target']) {
  test(`cli launch protocol: retry after dead supervision terminates ${phase}, records abort, then reauthorizes same target`, async () => {
    const f = fixture();
    ensureRoot(f);
    const { identity } = armAndAdvanceToProbesRunning(f);
    const authority = startupAuthorityFixture(f);
    const childFixture = tokenBoundChildFixture(f, authority);
    const noncePath = issuePermitAndGetNonceContents(f, identity);
    const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--probe-nonce-file', noncePath, '--consume-probe-permit']);
    const gated = gatedCarrierFixture(f, authority, consumed, childFixture);
    try {
      runCliOk(gated.recordArgs, { env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: gated.token } });
      if (phase === 'target') {
        fs.writeSync(gated.gateFd, 'GO\n');
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const state = lib.readState(f.state);
      state.parentDeployment.probePermit.launchAuthorization.supervisorPid = 999999;
      state.parentDeployment.probePermit.launchAuthorization.supervisorProcessStartTime = '1';
      lib.writeState(f.state, state);
      const aborted = runCliFail(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
        '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
        '--probe-nonce-file', noncePath, '--consume-probe-permit']);
      assert.equal(aborted.parsed.code, 'launch-aborted');
      const abortState = lib.readState(f.state).parentDeployment.probePermit.launchAuthorization;
      assert.equal(abortState.status, 'launch-aborted');
      assert.equal(abortState.abortReceipt.processPhase, phase);
      assert.equal(abortState.abortReceipt.childPid, gated.carrier.pid);
      if (gated.carrier.exitCode === null && gated.carrier.signalCode === null) {
        await new Promise((resolve) => gated.carrier.once('exit', resolve));
      }
      assert.throws(() => process.kill(gated.carrier.pid, 0), /ESRCH/);
      const reauthorized = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
        '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
        '--probe-nonce-file', noncePath, '--consume-probe-permit']);
      assert.equal(reauthorized.resumed, true);
      const launch = lib.readState(f.state).parentDeployment.probePermit.launchAuthorization;
      assert.equal(launch.status, 'authorized');
      assert.equal(launch.attempt, 2);
      assert.equal(launch.previousAbortReceiptSha256, abortState.abortReceiptSha256);
      assert.equal(launch.argvSha256, abortState.argvSha256);
    } finally {
      fs.closeSync(gated.gateFd);
      terminateCarrier(gated.carrier);
    }
  });
}

test('cli launch protocol: live gated child records one start phase and concurrent wrapper replay is rejected', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const authority = startupAuthorityFixture(f);
  const childFixture = tokenBoundChildFixture(f, authority);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const gated = gatedCarrierFixture(f, authority, consumed, childFixture);
  try {
    const recorded = runCliOk(gated.recordArgs, {
      env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: gated.token },
    });
    assert.equal(recorded.resumed, false);
    assert.equal(lib.readState(f.state).parentDeployment.probePermit.launchAuthorization.status, 'child-started');
    assert.equal(fs.existsSync(consumed.launchTokenPath), false);
    const replay = runCliFail(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--probe-nonce-file', noncePath, '--consume-probe-permit'], { timeout: 5000 });
    assert.equal(replay.parsed.code, 'already-consumed');
  } finally {
    fs.closeSync(gated.gateFd);
    terminateCarrier(gated.carrier);
  }
});

test('cli launch protocol: wrapper retry revokes an exact token target spawned before its start receipt', async () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const authority = startupAuthorityFixture(f);
  const childFixture = tokenBoundChildFixture(f, authority);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const token = JSON.parse(fs.readFileSync(consumed.launchTokenPath)).token;
  const child = spawn(process.execPath, [childFixture.childPath, 'arg-one'], {
    env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: token }, stdio: 'ignore',
  });
  try {
    const retry = runCliFail(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--probe-nonce-file', noncePath, '--consume-probe-permit']);
    assert.equal(retry.parsed.code, 'launch-aborted');
    const launch = lib.readState(f.state).parentDeployment.probePermit.launchAuthorization;
    assert.equal(launch.status, 'launch-aborted');
    assert.equal(launch.childPid, child.pid);
    assert.equal(launch.abortReceipt.processPhase, 'target');
    await new Promise((resolve) => child.once('exit', resolve));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('cli launch protocol: retry discovers a durably bound token spawner and refuses a second carrier', async () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const authority = startupAuthorityFixture(f);
  const childFixture = tokenBoundChildFixture(f, authority);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const gated = gatedCarrierFixture(f, authority, consumed, childFixture);
  const token = JSON.parse(fs.readFileSync(consumed.launchTokenPath)).token;
  const spawner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: token }, stdio: 'ignore',
  });
  const spawnerIdentityPath = consumed.launchTokenPath.replace(/\.launch-token\.json$/, '.launch-spawner.json');
  const spawnerArgv = fs.readFileSync(`/proc/${spawner.pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  writeJsonFile(spawnerIdentityPath, {
    format: 1,
    pid: spawner.pid,
    processStartTime: testProcessStartTime(spawner.pid),
    argvSha256: lib.sha256Hex(Buffer.from(JSON.stringify(spawnerArgv))),
  });
  try {
    const replay = runCliFail(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--probe-nonce-file', noncePath, '--consume-probe-permit']);
    assert.equal(replay.parsed.code, 'launch-token-replayed');
    assert.equal(lib.readState(f.state).parentDeployment.probePermit.launchAuthorization.status, 'authorized');
  } finally {
    terminateCarrier(gated.carrier);
    if (spawner.exitCode === null && spawner.signalCode === null) {
      try { spawner.kill('SIGKILL'); } catch (_error) { /* already gone */ }
    }
    fs.closeSync(gated.gateFd);
  }
});

test('cli launch protocol: immediate retry discovers an unrecorded token spawner and records typed spawner abort', async () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const authority = startupAuthorityFixture(f);
  const childFixture = tokenBoundChildFixture(f, authority);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit']);
  const token = JSON.parse(fs.readFileSync(consumed.launchTokenPath)).token;
  const gatePath = consumed.launchTokenPath.replace(/\.launch-token\.json$/, '.launch-gate');
  const childIdentityPath = consumed.launchTokenPath.replace(/\.launch-token\.json$/, '.launch-child.json');
  const spawnerIdentityPath = consumed.launchTokenPath.replace(/\.launch-token\.json$/, '.launch-spawner.json');
  const spawnGatePath = consumed.launchTokenPath.replace(/\.launch-token\.json$/, '.launch-spawn-gate');
  const spawnerArgv = [
    '-', childIdentityPath, spawnerIdentityPath, spawnGatePath, '999999', '1',
    authority.marker.residents.guardedLauncher.path, gatePath, ...childFixture.argv,
  ];
  const spawner = spawn(process.execPath, spawnerArgv, {
    env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: token },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  spawner.stdin.end('setInterval(() => {}, 1000);\n');
  const stale = lib.readState(f.state);
  stale.parentDeployment.probePermit.launchAuthorization.supervisorPid = 999999;
  stale.parentDeployment.probePermit.launchAuthorization.supervisorProcessStartTime = '1';
  lib.writeState(f.state, stale);
  try {
    const retry = runCliFail(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--probe-nonce-file', noncePath, '--consume-probe-permit']);
    assert.equal(retry.parsed.code, 'launch-aborted');
    const launch = lib.readState(f.state).parentDeployment.probePermit.launchAuthorization;
    assert.equal(launch.status, 'launch-aborted');
    assert.equal(launch.abortReceipt.processPhase, 'spawner');
    assert.equal(launch.abortReceipt.childPid, spawner.pid);
    const expectedCarrierArgv = ['/bin/sh', authority.marker.residents.guardedLauncher.path,
      '--gated-child', gatePath, '--launch-token-sha256', lib.sha256Hex(token), '--', ...childFixture.argv];
    assert.equal(launch.abortReceipt.carrierArgvSha256,
      lib.sha256Hex(Buffer.from(JSON.stringify(expectedCarrierArgv))));
  } finally {
    if (spawner.exitCode === null && spawner.signalCode === null) spawner.kill('SIGKILL');
    if (spawner.exitCode === null && spawner.signalCode === null) {
      await new Promise((resolve) => spawner.once('exit', resolve));
    }
  }
});

test('crash-resume: child-start state and token-unlink boundaries resume only for the exact process instance', async () => {
  for (const crashAt of ['launch-start:after-state-before-token-unlink', 'launch-start:after-token-unlink']) {
    const f = fixture();
    ensureRoot(f);
    const { identity } = armAndAdvanceToProbesRunning(f);
    const authority = startupAuthorityFixture(f);
    const childFixture = tokenBoundChildFixture(f, authority);
    const noncePath = issuePermitAndGetNonceContents(f, identity);
    const consumed = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--probe-nonce-file', noncePath, '--consume-probe-permit']);
    const gated = gatedCarrierFixture(f, authority, consumed, childFixture);
    try {
      const crashed = runCli(gated.recordArgs, { env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: gated.token,
        OSI_DEPLOY_STATE_CRASH_AT: crashAt } });
      assert.equal(crashed.status, 137, crashAt);
      const resumed = runCliOk(gated.recordArgs, {
        env: { ...process.env, OSI_DEPLOY_LAUNCH_TOKEN: gated.token },
      });
      assert.equal(resumed.resumed, true, crashAt);
      assert.equal(lib.readState(f.state).parentDeployment.probePermit.launchAuthorization.childPid, gated.carrier.pid);
    } finally {
      fs.closeSync(gated.gateFd);
      terminateCarrier(gated.carrier);
    }
  }
});

test('cli startup-check: node-red post-receipt respawn passes without a nonce file', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-runtime-after-probe.json'), {});
  runCliOk([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--phase', 'runtime-verified', '--patch', emptyPatch,
  ]);
  runCliOk([
    'finish', '--state', f.state, '--receipts', f.receipts,
    '--operation-id', identity.deploymentId, '--expected-phase', 'runtime-verified', '--result', 'verified',
  ]);
  const out = runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
  ]);
  assert.equal(out.pass, true);
  assert.equal(out.mode, 'post-receipt-respawn');
});

// ---------------------------------------------------------------------------
// Crash-resume: issue-probe-permit and startup-check consuming form
// ---------------------------------------------------------------------------

test('crash-resume: issue-probe-permit killed after nonce fsync but before state write resumes by reusing the already-fsynced nonce', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = path.join(f.permits, `${identity.deploymentId}.1.nonce`);
  const crashed = runCli([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', noncePath,
  ], { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'nonce:after-parent-fsync' } });
  assert.equal(crashed.status, 137);
  assert.equal(fs.existsSync(noncePath), true, 'the nonce file itself is durably fsynced even though state was not updated');
  const status = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(status.parentDeployment.probePermit, undefined, 'state must not record a permit that was never CAS-committed');
  const nonceBefore = JSON.parse(fs.readFileSync(noncePath, 'utf8')).nonce;

  // Retrying the identical generation resumes deterministically: the
  // already-fsynced nonce is reused (not regenerated) and the state CAS
  // that didn't land the first time now completes.
  const resumed = runCliOk([
    'issue-probe-permit', '--state', f.state, '--operation-id', identity.deploymentId,
    '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red',
    '--identity', probeIdentityFile(f), '--nonce-out', noncePath,
  ]);
  assert.equal(resumed.generation, 1);
  const nonceAfter = JSON.parse(fs.readFileSync(noncePath, 'utf8')).nonce;
  assert.equal(nonceAfter, nonceBefore, 'resume must not regenerate a fresh nonce for the same generation');
  const statusAfter = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(statusAfter.parentDeployment.probePermit.status, 'issued');
  assert.equal(statusAfter.parentDeployment.probePermit.nonceSha256, lib.sha256Hex(nonceBefore));
});

test('crash-resume: every launch-token publication boundary converges on the same token and authorization', () => {
  for (const crashAt of ['launch-token:mid-write', 'launch-token:after-temp-fsync',
    'launch-token:after-link', 'launch-token:after-unlink', 'launch-token:after-parent-fsync']) {
    const f = fixture();
    ensureRoot(f);
    const { identity } = armAndAdvanceToProbesRunning(f);
    const noncePath = issuePermitAndGetNonceContents(f, identity);
    const args = ['startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
      '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
      '--probe-nonce-file', noncePath, '--consume-probe-permit'];
    const crashed = runCli(args, { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: crashAt } });
    assert.equal(crashed.status, 137, crashAt);
    const resumed = runCliOk(args);
    assert.match(resumed.launchTokenPath, /\.launch-token\.json$/);
    assert.equal(lib.readState(f.state).parentDeployment.probePermit.launchAuthorization.status, 'authorized');
  }
});

test('crash-resume: startup-check consuming killed after the state CAS resumes the same launch token', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const crashed = runCli([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ], { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'consume-permit:after-state-write-before-unlink' } });
  assert.equal(crashed.status, 137);
  assert.equal(fs.existsSync(noncePath), true, 'crash landed before unlink');
  const statusAfterCrash = runCliOk(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', identity.deploymentId]);
  assert.equal(statusAfterCrash.parentDeployment.probePermit.status, 'consumed', 'state CAS already committed');

  const retry = runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  assert.equal(retry.resumed, true);
  assert.equal(fs.existsSync(noncePath), false, 'retry finishes nonce cleanup without creating different authority');
});

test('cli startup-check: rejects mutated current candidate identity after permit issuance', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const authority = startupAuthorityFixture(f);
  fs.writeFileSync(authority.marker.candidate.path, 'mutated\n');
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath,
  ]);
  assert.equal(parsed.code, 'current-identity-mismatch');
});

test('cli startup-check: rejects a mutated resident control file', () => {
  const f = fixture();
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const authority = startupAuthorityFixture(f);
  fs.writeFileSync(authority.marker.residents.stateCli.path, 'mutated\n');
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath,
  ]);
  assert.ok(['resident-mismatch', 'current-control-mismatch'].includes(parsed.code));
});

test('crash-resume: startup-check consuming killed after unlink resumes the same durable launch authorization', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  const crashed = runCli([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ], { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'consume-permit:after-unlink' } });
  assert.equal(crashed.status, 137);
  assert.equal(fs.existsSync(noncePath), false, 'unlink already landed');

  const retry = runCliOk([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath, '--consume-probe-permit',
  ]);
  assert.equal(retry.resumed, true);
});

// ---------------------------------------------------------------------------
// Section 6: coverage hardening - permit expiry/wrong-path, broader flag
// negatives across verbs, and a CLI-level wrong-mode rejection.
// ---------------------------------------------------------------------------

test('cli startup-check: node-red preflight rejects an expired permit', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  const noncePath = issuePermitAndGetNonceContents(f, identity);
  // Directly age the recorded permit's expiresAt into the past (the CLI
  // itself has no --now override; this simulates real wall-clock expiry
  // without a sleep).
  const current = lib.readState(f.state);
  current.parentDeployment.probePermit.expiresAt = '2000-01-01T00:00:00.000Z';
  lib.writeState(f.state, current);
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', noncePath,
  ]);
  assert.equal(parsed.code, 'permit-expired');
});

test('cli startup-check: node-red preflight rejects a --probe-nonce-file that matches no recorded permit', () => {
  const f = fixture();
  ensureRoot(f);
  const { identity } = armAndAdvanceToProbesRunning(f);
  issuePermitAndGetNonceContents(f, identity);
  const wrongPath = path.join(f.permits, `${identity.deploymentId}.999.nonce`);
  writeJsonFile(wrongPath, { nonce: 'z'.repeat(64) });
  const { parsed } = runCliFail([
    'startup-check', '--root', f.dir, '--guard-marker', guardMarkerFile(f),
    '--state', f.state, '--receipts', f.receipts, '--service', 'node-red',
    '--probe-nonce-file', wrongPath,
  ]);
  assert.equal(parsed.code, 'permit-not-found');
});

test('cli status: rejects a state file with the wrong mode (wrong-mode)', () => {
  const f = fixture();
  armViaCli(f);
  fs.chmodSync(f.state, 0o644);
  const { parsed } = runCliFail(['status', '--state', f.state, '--receipts', f.receipts, '--deployment-id', 'whatever']);
  assert.equal(parsed.code, 'wrong-mode');
});

// Every in-scope verb gets at least one unknown-flag, one duplicate-flag,
// and one missing-required-flag negative, spawning the real CLI (the shared
// parseArgs() is exercised identically for every verb, but each verb's own
// required-flag list is what's under test here).
const FLAG_NEGATIVE_CASES = [
  { verb: 'arm', base: ['--state', 's', '--receipts', 'r', '--attempts', 'a', '--expected-attempt-sha256', 'a'.repeat(64), '--identity', 'i'] },
  { verb: 'advance', base: ['--state', 's', '--deployment-id', 'd', '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', 'p'] },
  { verb: 'status', base: ['--state', 's', '--receipts', 'r', '--deployment-id', 'd'] },
  { verb: 'finish', base: ['--state', 's', '--receipts', 'r', '--operation-id', 'o', '--expected-phase', 'runtime-verified', '--result', 'verified'] },
  { verb: 'complete', base: ['--state', 's', '--receipts', 'r', '--lock-dir', 'l', '--operation-id', 'o', '--expected-deployment-receipt-sha256', 'a'.repeat(64), '--acceptance', 'a'] },
  { verb: 'begin-recovery', base: ['--state', 's', '--receipts', 'r', '--operation-id', 'o', '--parent-deployment-id', 'p', '--parent-phase', 'completed', '--parent-receipts', 'pr', '--identity', 'i'] },
  { verb: 'recover', base: ['--state', 's', '--receipts', 'r', '--lock-dir', 'l', '--operation-id', 'o', '--expected-identity-sha256', 'a'.repeat(64)] },
  { verb: 'release-lock', base: ['--state', 's', '--lock-dir', 'l', '--operation-id', 'o', '--expected-final-receipt-sha256', 'a'.repeat(64)] },
  { verb: 'issue-probe-permit', base: ['--state', 's', '--operation-id', 'o', '--expected-phase', 'probes-running', '--purpose', 'deployment-probe', '--service', 'node-red', '--identity', 'i', '--nonce-out', '/tmp/x.1.nonce'] },
  { verb: 'startup-check', base: ['--root', '/tmp', '--guard-marker', 'g', '--state', 's', '--receipts', 'r', '--service', 'node-red'] },
  { verb: 'record-launch-start', base: ['--root', '/tmp', '--guard-marker', 'g', '--state', 's', '--receipts', 'r', '--service', 'node-red', '--launch-token-file', '/tmp/t', '--child-pid', '1', '--child-process-starttime', '1'] },
];

for (const { verb, base } of FLAG_NEGATIVE_CASES) {
  test(`cli ${verb}: unknown flag is rejected`, () => {
    const { parsed } = runCliFail([verb, ...base, '--totally-bogus-flag', 'x']);
    assert.equal(parsed.code, 'unknown-flag');
  });

  test(`cli ${verb}: duplicate flag is rejected`, () => {
    const { parsed } = runCliFail([verb, ...base, base[0], base[1]]);
    assert.equal(parsed.code, 'duplicate-flag');
  });

  test(`cli ${verb}: missing a required flag is rejected`, () => {
    const { parsed } = runCliFail([verb, ...base.slice(2)]);
    assert.equal(parsed.code, 'missing-flag');
  });
}

// ---------------------------------------------------------------------------
// Section 7: review fixes.
// 7a (CRITICAL): real two-process races + per-mutation lockfile.
// ---------------------------------------------------------------------------

function runCliAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      ...opts,
      env: {
        ...process.env,
        OSI_DEPLOY_ARTIFACT_MODE: 'test',
        OSI_DEPLOY_TEST_BOUNDARY: path.join(os.tmpdir(), `osi-deploy-startup-tests-${process.getuid()}`),
        ...(opts.env || {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function parseStderrCode(res) {
  try {
    return JSON.parse(res.stderr).code;
  } catch (_err) {
    return `(unparseable stderr: ${res.stderr.slice(0, 200)})`;
  }
}

const RACE_ITERATIONS = 15;

test('RACE: two concurrent first-arm processes - exactly one wins, loser gets a bounded error, state holds the winner only', async () => {
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const f = fixture();
    const idA = armIdentity({ deploymentId: `dep-race-a-${i}` });
    const idB = armIdentity({ deploymentId: `dep-race-b-${i}` });
    prepareArmClaim(f, idA);
    const pathA = writeJsonFile(path.join(f.dir, 'id-a.json'), idA);
    const pathB = writeJsonFile(path.join(f.dir, 'id-b.json'), idB);
    const argsFor = (identity, identityPath) => [
      'arm', '--state', f.state, '--receipts', f.receipts, '--attempts', f.attempts,
      '--expected-attempt-sha256', lib.canonicalHash(identity), '--identity', identityPath,
    ];
    const [a, b] = await Promise.all([
      runCliAsync(argsFor(idA, pathA), withBoot(GB1)),
      runCliAsync(argsFor(idB, pathB), withBoot(GB1)),
    ]);
    const results = [
      { name: idA.deploymentId, res: a },
      { name: idB.deploymentId, res: b },
    ];
    const winners = results.filter((r) => r.res.status === 0);
    const losers = results.filter((r) => r.res.status !== 0);
    assert.equal(
      winners.length,
      1,
      `iteration ${i}: expected exactly one winner, got ${winners.length}\n` +
        results.map((r) => `${r.name}: status=${r.res.status} out=${r.res.stdout} err=${r.res.stderr}`).join('\n')
    );
    const loserCode = parseStderrCode(losers[0].res);
    assert.ok(
      ['state-busy', 'state-already-exists', 'claim-missing', 'claim-mismatch'].includes(loserCode),
      `iteration ${i}: loser must fail with a bounded error, got ${loserCode}`
    );
    const finalState = lib.readState(f.state);
    assert.equal(
      finalState.parentDeployment.deploymentId,
      winners[0].name,
      `iteration ${i}: state must contain the winner only`
    );
    assert.equal(finalState.parentDeployment.phase, 'armed');
  }
});

test('RACE: two concurrent same-source-phase advance processes - exactly one applies the CAS', async () => {
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const f = fixture();
    const { identity } = armViaCli(f);
    const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
    const advanceArgs = [
      'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
      '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', emptyPatch,
    ];
    const [a, b] = await Promise.all([runCliAsync(advanceArgs), runCliAsync(advanceArgs)]);
    const oks = [a, b].filter((r) => r.status === 0);
    const losers = [a, b].filter((r) => r.status !== 0);
    assert.equal(
      oks.length,
      1,
      `iteration ${i}: expected exactly one successful CAS\n` +
        [a, b].map((r) => `status=${r.status} out=${r.stdout} err=${r.stderr}`).join('\n')
    );
    const loserCode = parseStderrCode(losers[0]);
    assert.ok(
      ['state-busy', 'cas-mismatch'].includes(loserCode),
      `iteration ${i}: loser must fail with a bounded error, got ${loserCode}`
    );
    const finalState = lib.readState(f.state);
    assert.equal(finalState.parentDeployment.phase, 'writers-stopped');
    assert.equal(finalState.parentDeployment.generation, 2, 'the CAS must have applied exactly once');
  }
});

function armedForMutationTests(f) {
  const { identity } = armViaCli(f);
  const patch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
  const advanceArgs = [
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', patch,
  ];
  return { identity, patch, advanceArgs };
}

function mutationLockFile(f) {
  return `${f.state}.mutating`;
}

function mutationContenders(f) {
  const dir = mutationLockFile(f);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^\d{16}\.json$/.test(name)).sort();
}

function testProcessStartTime(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = raw.lastIndexOf(') ');
  assert.notEqual(close, -1, 'test process stat must have a comm terminator');
  const fieldsFromState = raw.slice(close + 2).trim().split(/\s+/);
  return fieldsFromState[19];
}

function plantMutationContender(f, holder, ticket = 1) {
  const dir = mutationLockFile(f);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const selectedToken = cryptoTest.randomBytes(16).toString('hex');
  const contender = {
    ...holder,
    processStartTime: holder.processStartTime || (holder.pid === process.pid ? testProcessStartTime(holder.pid) : '1'),
    ticket,
    token: selectedToken,
  };
  const contenderPath = path.join(dir, `${String(ticket).padStart(16, '0')}.json`);
  fs.writeFileSync(contenderPath, `${JSON.stringify(contender)}\n`, { mode: 0o600 });
  fs.chmodSync(contenderPath, 0o600);
  return contenderPath;
}

test('mutation lock: a live same-boot holder is never stolen (state-busy, lockfile intact)', () => {
  const f = fixture();
  const { advanceArgs } = armedForMutationTests(f);
  const holder = { pid: process.pid, bootId: GB1, operationId: 'held-by-test' };
  const contenderPath = plantMutationContender(f, holder);
  const { parsed } = runCliFail(advanceArgs);
  assert.equal(parsed.code, 'state-busy');
  assert.equal(JSON.parse(fs.readFileSync(contenderPath, 'utf8')).operationId, holder.operationId,
    'foreign contender must not be touched');
  const state = lib.readState(f.state);
  assert.equal(state.parentDeployment.phase, 'armed', 'no mutation may have happened');
});

test('mutation lock: a dead-pid same-boot contender is safely reclaimed', () => {
  const f = fixture();
  const { advanceArgs } = armedForMutationTests(f);
  const stalePath = plantMutationContender(f, { pid: 999999, bootId: GB1, operationId: 'crashed' });
  const out = runCliOk(advanceArgs);
  assert.equal(out.phase, 'writers-stopped');
  assert.equal(fs.existsSync(stalePath), false, 'proven-dead stale contender is collected');
});

test('mutation lock: a different-boot contender is safely reclaimed', () => {
  const f = fixture();
  const { advanceArgs } = armedForMutationTests(f);
  const stalePath = plantMutationContender(f, { pid: process.pid, bootId: 'boot-from-before-reboot', operationId: 'pre-reboot' });
  const out = runCliOk(advanceArgs);
  assert.equal(out.phase, 'writers-stopped');
  assert.equal(fs.existsSync(stalePath), false, 'previous-boot contender is proven stale');
});

test('mutation lock: PID reuse does not let a stale ticket wedge the state', () => {
  const f = fixture();
  const { advanceArgs } = armedForMutationTests(f);
  const stalePath = plantMutationContender(f, {
    pid: process.pid,
    bootId: lib.getBootId(),
    processStartTime: `${BigInt(testProcessStartTime(process.pid)) + 1n}`,
    operationId: 'reused-pid',
  });
  const out = runCliOk(advanceArgs);
  assert.equal(out.phase, 'writers-stopped');
  assert.equal(fs.existsSync(stalePath), false, 'same PID with a different process birth is stale');
});

test('crash: advance killed before mutation-lock create - nothing changed, clean retry', () => {
  const f = fixture();
  const { advanceArgs } = armedForMutationTests(f);
  const crashed = runCli(advanceArgs, { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'mutation-lock:before-create' } });
  assert.equal(crashed.status, 137);
  assert.deepEqual(mutationContenders(f), []);
  assert.equal(lib.readState(f.state).parentDeployment.phase, 'armed');
  const retry = runCliOk(advanceArgs);
  assert.equal(retry.phase, 'writers-stopped');
});

test('crash: advance killed after mutation-lock create - stale lock left, retry reclaims and applies', () => {
  const f = fixture();
  const { advanceArgs } = armedForMutationTests(f);
  const crashed = runCli(advanceArgs, { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'mutation-lock:after-create' } });
  assert.equal(crashed.status, 137);
  assert.equal(mutationContenders(f).length, 1, 'crash after create leaves immutable contender evidence');
  assert.equal(lib.readState(f.state).parentDeployment.phase, 'armed', 'no state change yet');
  const retry = runCliOk(advanceArgs);
  assert.equal(retry.phase, 'writers-stopped');
  assert.equal(mutationContenders(f).length, 0, 'retry collects the crashed process contender');
});

test('crash: advance killed after tmp fsync before rename - CAS not applied, retry applies exactly once', () => {
  const f = fixture();
  const { advanceArgs } = armedForMutationTests(f);
  const crashed = runCli(advanceArgs, { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'state-write:after-tmp-fsync' } });
  assert.equal(crashed.status, 137);
  assert.equal(lib.readState(f.state).parentDeployment.phase, 'armed', 'rename never happened');
  assert.equal(mutationContenders(f).length, 1, 'contender remains for the dead process');
  const retry = runCliOk(advanceArgs);
  assert.equal(retry.phase, 'writers-stopped');
  assert.equal(lib.readState(f.state).parentDeployment.generation, 2, 'applied exactly once');
});

test('crash: advance killed after rename before lock unlink - CAS fully landed, no half-applied state, retry fails closed, lock not wedged', () => {
  const f = fixture();
  const { identity, patch, advanceArgs } = armedForMutationTests(f);
  const crashed = runCli(advanceArgs, { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'mutation-lock:before-unlink' } });
  assert.equal(crashed.status, 137);
  const state = lib.readState(f.state);
  assert.equal(state.parentDeployment.phase, 'writers-stopped', 'rename landed the full CAS');
  assert.equal(state.parentDeployment.generation, 2);
  assert.equal(mutationContenders(f).length, 1);
  // Retrying the same CAS fails closed (phase moved on), and the stale lock
  // is reclaimed rather than wedging every later mutation.
  const retry = runCliFail(advanceArgs);
  assert.equal(retry.parsed.code, 'cas-mismatch');
  assert.equal(mutationContenders(f).length, 0, 'retry collects the crashed contender before rechecking CAS');
  // And the *next legitimate* transition still works: not wedged.
  const next = runCliOk([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'writers-stopped', '--phase', 'protocol-initializing', '--patch', patch,
  ]);
  assert.equal(next.phase, 'protocol-initializing');
});

test('crash: advance killed after lock unlink - fully clean end state', () => {
  const f = fixture();
  const { identity, patch, advanceArgs } = armedForMutationTests(f);
  const crashed = runCli(advanceArgs, { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'mutation-lock:after-unlink' } });
  assert.equal(crashed.status, 137);
  assert.equal(lib.readState(f.state).parentDeployment.phase, 'writers-stopped');
  assert.deepEqual(mutationContenders(f), []);
  const next = runCliOk([
    'advance', '--state', f.state, '--deployment-id', identity.deploymentId,
    '--expected-phase', 'writers-stopped', '--phase', 'protocol-initializing', '--patch', patch,
  ]);
  assert.equal(next.phase, 'protocol-initializing');
});

test('first-arm exclusive creation: a pre-existing state file is a bounded already-exists rejection, not an overwrite', () => {
  const f = fixture();
  // Plant a state file that the arm's pre-read cannot see as armable
  // (simulates the race window: another writer created state between this
  // process's read and its write). We bypass the CLI by pre-creating state
  // and then deleting the mutation lock path guard: the direct-lib
  // exclusive writer must refuse.
  lib.writeState(f.state, baseEnvelope());
  assert.throws(
    () => lib.writeStateExclusive(f.state, baseEnvelope({ parentDeployment: { deploymentId: 'dep-other' } })),
    (err) => err.code === 'state-already-exists'
  );
  assert.equal(lib.readState(f.state).parentDeployment.deploymentId, 'dep-0001', 'original state intact');
});

// ---------------------------------------------------------------------------
// Section 7b (IMPORTANT 4): acquireLock crash window between mkdir and the
// owner-metadata write. An owner-less lock dir is an incomplete
// acquisition, never a permanent wedge.
// ---------------------------------------------------------------------------

test('attempt lock: an owner-less lock dir (crashed acquisition) is reclaimed instead of deadlocking every later acquire', () => {
  const { lockDir, statePath } = freshLockFixture();
  fs.mkdirSync(lockDir, 0o700); // dir exists, owner.json never written
  const res = lib.acquireLock({
    lockDir,
    statePath,
    deploymentId: 'dep-1',
    targetCommitSha: 'a',
    controllerGeneration: 1,
    bootId: 'boot-a',
  });
  assert.equal(res.acquired, true);
  assert.equal(res.reclaimed, true);
  assert.equal(lib.readLockOwner(lockDir).deploymentId, 'dep-1');
});

test('attempt lock: owner-less reclaim works for any contender deployment id (no owner = no identity to defend)', () => {
  const { lockDir, statePath } = freshLockFixture();
  fs.mkdirSync(lockDir, 0o700);
  const res = lib.acquireLock({
    lockDir,
    statePath,
    deploymentId: 'dep-completely-different',
    targetCommitSha: 'a',
    controllerGeneration: 1,
    bootId: 'boot-a',
  });
  assert.equal(res.acquired, true);
});

test('attempt lock: a second owner-less conflict within the same call is a bounded error, not a loop', () => {
  const { lockDir, statePath } = freshLockFixture();
  fs.mkdirSync(lockDir, 0o700);
  // Recreate another owner-less directory exactly when the bounded retry
  // attempts its mkdir (simulates a concurrent acquirer crashing there).
  const realMkdirSync = fs.mkdirSync;
  let lockMkdirCalls = 0;
  fs.mkdirSync = (target, opts) => {
    if (target === lockDir && ++lockMkdirCalls === 2) {
      realMkdirSync(lockDir, 0o700);
    }
    return realMkdirSync(target, opts);
  };
  try {
    assert.throws(
      () =>
        lib.acquireLock({
          lockDir,
          statePath,
          deploymentId: 'dep-1',
          targetCommitSha: 'a',
          controllerGeneration: 1,
          bootId: 'boot-a',
        }),
      (err) => err.code === 'lock-ownerless-unrecoverable'
    );
  } finally {
    fs.mkdirSync = realMkdirSync;
  }
});

test('crash: acquire-lock killed between mkdir and owner write - later acquire recovers instead of wedging', () => {
  const f = fixture();
  const acquireArgs = [
    'acquire-lock', '--state', f.state, '--lock-dir', f.lockDir,
    '--deployment-id', 'dep-cli-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ];
  const crashed = runCli(acquireArgs, { env: { ...process.env, OSI_DEPLOY_STATE_CRASH_AT: 'attempt-lock:after-mkdir' } });
  assert.equal(crashed.status, 137);
  assert.equal(fs.existsSync(f.lockDir), true, 'lock dir was created before the kill');
  assert.equal(fs.existsSync(path.join(f.lockDir, 'owner.json')), false, 'owner metadata was never written');

  const retry = runCliOk(acquireArgs);
  assert.equal(retry.acquired, true);
  assert.equal(lib.readLockOwner(f.lockDir).deploymentId, 'dep-cli-1');
});

test('attempt lock: a genuinely held lock (live owner) is never treated as owner-less or stolen', () => {
  const { lockDir, statePath } = freshLockFixture();
  lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-1', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' });
  const ownerBefore = lib.readLockOwner(lockDir);
  assert.throws(
    () => lib.acquireLock({ lockDir, statePath, deploymentId: 'dep-2', targetCommitSha: 'a', controllerGeneration: 1, bootId: 'boot-a' }),
    (err) => err.code === 'lock-contended'
  );
  assert.deepEqual(lib.readLockOwner(lockDir), ownerBefore, 'owner metadata must be untouched after a refused contender');
});

// ---------------------------------------------------------------------------
// Section 7c (IMPORTANT 2): receipt content is validated per kind at write
// time, and topology-activation receipts carry a mandatory authorityKind
// discriminator and only the rich guard-bootstrap authority shape is legal.
// ---------------------------------------------------------------------------

function validTopologyActivationContent(overrides = {}) {
  return {
    format: 1,
    receiptKind: 'topology-activation',
    authorityKind: 'guard-bootstrap',
    operationId: 'rec-1',
    deploymentId: 'dep-1',
    topologyOutcome: 'restored',
    guardGeneration: 9,
    guardGenerationSha256: 'a'.repeat(64),
    sixLinkTopologySha256: 'b'.repeat(64),
    guardAware94: { state: 'present', sha256: 'c'.repeat(64) },
    inhibitorSha256: 'd'.repeat(64),
    topologyRestorationProofPath: '/data/osi-deploy/backups/dep-1/topology-restoration-proof.json',
    topologyRestorationProofSha256: 'e'.repeat(64),
    compatibilityManifestSha256: 'f'.repeat(64),
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

test('receipts: topology-activation without authorityKind is rejected at write', () => {
  const dir = tmpDir();
  const content = validTopologyActivationContent();
  delete content.authorityKind;
  assert.throws(
    () => lib.writeReceipt(path.join(dir, 'receipts'), 'rec-1', 'topology-activation', content),
    (err) => err.code === 'missing-field'
  );
});

test('receipts: topology-activation with an unknown authorityKind value is rejected at write', () => {
  const dir = tmpDir();
  assert.throws(
    () =>
      lib.writeReceipt(
        path.join(dir, 'receipts'),
        'rec-1',
        'topology-activation',
        validTopologyActivationContent({ authorityKind: 'made-up-authority' })
      ),
    (err) => err.code === 'shape'
  );
});

test('receipts: topology-activation writes only the rich guard-bootstrap variant', () => {
  const dir = tmpDir();
  lib.writeReceipt(path.join(dir, 'receipts'), 'rec-1', 'topology-activation', validTopologyActivationContent());
});

test('receipts: every write is content-validated per kind - wrong-shaped deployment receipt is rejected', () => {
  const dir = tmpDir();
  assert.throws(
    () => lib.writeReceipt(path.join(dir, 'receipts'), 'op-1', 'deployment', { hello: 'world' }),
    (err) => err.code === 'missing-field' || err.code === 'unknown-field'
  );
});

test('receipts: kinds with no writer in this slice are rejected at write (no half-stubbed receipts)', () => {
  const dir = tmpDir();
  // 'abandonment' gained a writer (abandon-guard-bootstrap) in the guard
  // slice and is no longer in this list.
  for (const kind of ['rehearsal', 'staging-gc', 'factory-seed', 'factory-protocol-zero', 'database-lineage-invalidation']) {
    assert.throws(
      () => lib.writeReceipt(path.join(dir, 'receipts'), 'op-1', kind, { anything: true }),
      (err) => err.code === 'receipt-kind-not-writable',
      `kind '${kind}' must not be writable in this slice`
    );
  }
});

// Recovery receipt read-back rejection is covered by the rich-receipt\n// malformed/extra-field tests in the G4 recovery authority section.

// ---------------------------------------------------------------------------
// Section 7d (IMPORTANT 3): real wrong-owner branch coverage.
// process.getuid is a plain reassignable function property in Node, so a
// scoped monkey-patch makes assertOwnedByUs's uid comparison genuinely
// fail without root or a second real user account. Live cross-uid
// coverage (files actually owned by another uid) remains a
// Kaba100-rehearsal follow-up.
// ---------------------------------------------------------------------------

function withPatchedGetuid(fn) {
  const realGetuid = process.getuid;
  process.getuid = () => realGetuid.call(process) + 12345;
  try {
    return fn();
  } finally {
    process.getuid = realGetuid;
  }
}

test('wrong-owner: readState (assertRegularFileMode0600) rejects a state file owned by another uid', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'deployment-state.json');
  lib.writeState(statePath, baseEnvelope());
  withPatchedGetuid(() => {
    assert.throws(() => lib.readState(statePath), (err) => err.code === 'wrong-owner');
  });
  // Sanity: unpatched, the same file reads fine.
  assert.equal(lib.readState(statePath).parentDeployment.deploymentId, 'dep-0001');
});

test('wrong-owner: readLockOwner rejects owner metadata owned by another uid', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'osi-deploy.lock.d');
  fs.mkdirSync(lockDir, 0o700);
  lib.writeLockOwner(lockDir, {
    deploymentId: 'dep-1',
    pid: 12345,
    processStartTime: '1',
    bootId: 'boot-a',
    targetCommitSha: 'a',
    controllerGeneration: 1,
    acquiredAt: '2026-07-17T00:00:00.000Z',
  });
  withPatchedGetuid(() => {
    assert.throws(() => lib.readLockOwner(lockDir), (err) => err.code === 'wrong-owner');
  });
  assert.equal(lib.readLockOwner(lockDir).deploymentId, 'dep-1');
});

test('wrong-owner: readReceipt rejects a receipt owned by another uid', () => {
  const dir = tmpDir();
  const receiptsDir = path.join(dir, 'receipts');
  lib.writeReceipt(receiptsDir, 'op-1', 'deployment', validDeploymentReceiptContent());
  withPatchedGetuid(() => {
    assert.throws(() => lib.readReceipt(receiptsDir, 'op-1', 'deployment'), (err) => err.code === 'wrong-owner');
  });
});

test('wrong-owner: the CLI identity-file reader rejects a file owned by another uid', () => {
  // Direct unit test of the exported pure helper (spawning cannot patch
  // getuid inside the child; the CLI-spawn coverage of this helper's other
  // branches - symlink, relative path, missing - already exists above).
  const { readRootOnlyJsonFile } = require('./deployment-state-cli');
  const dir = tmpDir();
  const p = path.join(dir, 'identity.json');
  fs.writeFileSync(p, JSON.stringify({ some: 'identity' }), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  withPatchedGetuid(() => {
    assert.throws(() => readRootOnlyJsonFile(p, '--identity'), (err) => err.code === 'wrong-owner');
  });
  assert.deepEqual(readRootOnlyJsonFile(p, '--identity'), { some: 'identity' });
});

test('process authority: launch-process reads reject PID reuse or exec drift across the /proc snapshot', () => {
  const cli = require('./deployment-state-cli');
  const procStat = (startTime) => `42 (node red) ${[
    'S', '1', '2', '3', ...Array(15).fill('0'), startTime,
  ].join(' ')}`;
  const command = Buffer.from('/usr/bin/node-red\0--userDir\0/srv/node-red\0');
  const environment = Buffer.from('OSI_DEPLOY_LAUNCH_TOKEN=abc\0');
  let statReads = 0;
  const reusedPid = cli.readLaunchProcess(42, {
    readFileSync(file) {
      if (file.endsWith('/stat')) {
        statReads += 1;
        return procStat(statReads % 2 === 1 ? '111' : '222');
      }
      if (file.endsWith('/cmdline')) return command;
      if (file.endsWith('/environ')) return environment;
      throw new Error(`unexpected path ${file}`);
    },
  });
  assert.equal(reusedPid, null, 'a reused PID must not yield mixed process authority');

  let commandReads = 0;
  const execDrift = cli.readLaunchProcess(42, {
    readFileSync(file) {
      if (file.endsWith('/stat')) return procStat('333');
      if (file.endsWith('/cmdline')) {
        commandReads += 1;
        return commandReads % 2 === 1 ? command : Buffer.from('/usr/bin/unrelated\0');
      }
      if (file.endsWith('/environ')) return environment;
      throw new Error(`unexpected path ${file}`);
    },
  });
  assert.equal(execDrift, null, 'an exec during collection must not mix argv and environment authority');
});

// ---------------------------------------------------------------------------
// Section 7e (MINOR 5): the parent phase is pinned while a sub-operation
// is active - advance must reject on activeSubOperation !== null itself,
// not merely because no ADVANCE_TRANSITIONS edge happens to exist from the
// linkable phases today. This test handcrafts a state where an adjacency
// edge DOES exist (armed -> writers-stopped) alongside an active recovery,
// so a future ADVANCE_TRANSITIONS edit cannot silently reopen the hole.
// ---------------------------------------------------------------------------

test('cli advance: rejected with a bounded error while a recovery sub-operation is active (phase pinned)', () => {
  const f = fixture();
  const restoredPredecessor = managedTerminalPredecessor();
  const envelope = {
    format: 2,
    parentDeployment: baseParentDeployment({ deploymentId: 'dep-pinned' }),
    activeSubOperation: {
      kind: 'recovery',
      operationId: 'rec-pinned',
      parentDeploymentId: 'dep-pinned',
      parentDeploymentGeneration: 1,
      parentPhaseAtLink: 'completed',
      parentReceiptsSha256: 'b'.repeat(64),
      phase: 'recovery-started',
      restoredPredecessor,
      restoredPredecessorSha256: lib.restoredPredecessorSha256(restoredPredecessor),
      generation: 1,
      createdAt: '2026-07-17T00:00:00.000Z',
    },
  };
  lib.writeState(f.state, envelope);
  const emptyPatch = writeJsonFile(path.join(f.dir, 'patch-empty.json'), {});
  const { parsed } = runCliFail([
    'advance', '--state', f.state, '--deployment-id', 'dep-pinned',
    '--expected-phase', 'armed', '--phase', 'writers-stopped', '--patch', emptyPatch,
  ]);
  assert.equal(parsed.code, 'phase-pinned');
  // And the state is untouched.
  const after = lib.readState(f.state);
  assert.equal(after.parentDeployment.phase, 'armed');
  assert.equal(after.parentDeployment.generation, 1);
  assert.equal(after.activeSubOperation.operationId, 'rec-pinned');
});

// ===========================================================================
// GUARD-BOOTSTRAP SLICE (A0 sub-tranche 2, branch sdd/deployment-state-guard)
// Section G1: append-only chain codec + append primitive (direct lib tests).
//
// Plan region: docs/superpowers/plans/2026-07-15-refactor-repair-program.md
// Task A0 guard-bootstrap paragraph (~line 172) - closed first-epoch phase
// sequence, common identity fields, bootEpoch/bootId, phase-specific fact
// binding, O_EXCL+fdatasync append, strict zero-padded grammar,
// symlink/special rejection, corrupt/fork/gap detection.
// ===========================================================================

const GB1 = 'guard-boot-0001';

function guardRootFixture() {
  const dir = tmpDir();
  return { dir, root: path.join(dir, 'guard-bootstrap') };
}

function guardCommonIdentity(overrides = {}) {
  return {
    deploymentId: 'dep-g-1',
    controllerGeneration: 1,
    targetCommitSha: 'a'.repeat(40),
    artifactSha256: 'b'.repeat(64),
    controlManifestSha256: 'c'.repeat(64),
    detectedProfile: 'bcm2712',
    expectedProfile: 'bcm2712',
    profileMappingSha256: 'd'.repeat(64),
    ...overrides,
  };
}

function guardIntentFacts() {
  return review9GuardIntentFacts();
}

function guardEpochRoleStates(bootId, source = guardIntentFacts().priorRoleStates) {
  return Object.fromEntries(Object.entries(structuredClone(source)).map(([role, facts]) => [role, {
    ...facts,
    bootId,
  }]));
}

function review9GuardIntentFacts() {
  const roleFacts = {
    'osi-identityd': { running: true, ready: true, enabled: true, pid: 310, processStartTime: '1010', lifecycleGeneration: 3 },
    'node-red': { running: true, ready: true, enabled: true, pid: 311, processStartTime: '1011', lifecycleGeneration: 5 },
    'osi-bootstrap': { running: false, ready: false, enabled: true, pid: null, processStartTime: null, lifecycleGeneration: 2 },
    'osi-db-integrity': { running: false, ready: false, enabled: false, pid: null, processStartTime: null, lifecycleGeneration: 4 },
  };
  const roleLinks = {
    'osi-identityd': ['/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd'],
    'node-red': ['/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red'],
    'osi-bootstrap': ['/etc/rc.d/S99osi-bootstrap'],
    'osi-db-integrity': ['/etc/rc.d/S90osi-db-integrity'],
  };
  return {
    priorRoleStates: Object.fromEntries(Object.entries(roleFacts).map(([role, facts]) => [role, {
      ...facts,
      bootId: GB1,
      rcLinks: roleLinks[role].map((linkPath) => facts.enabled
        ? { path: linkPath, state: 'symlink', target: `../init.d/${role}` }
        : { path: linkPath, state: 'absent' }),
    }])),
  };
}

function guardStoppedRoleGenerations() {
  return { 'osi-identityd': 3, 'node-red': 5, 'osi-bootstrap': 2, 'osi-db-integrity': 4 };
}

const GUARD_SIX_LINKS = [
  '/etc/rc.d/S98osi-identityd',
  '/etc/rc.d/K98osi-identityd',
  '/etc/rc.d/S99node-red',
  '/etc/rc.d/K99node-red',
  '/etc/rc.d/S99osi-bootstrap',
  '/etc/rc.d/S90osi-db-integrity',
];
const GUARD_SIX_LINK_TARGETS = GUARD_SIX_LINKS.map((linkPath) => ({
  path: linkPath,
  target: `../init.d/${linkPath.replace(/^.*[SK]\d+/, '')}`,
}));

// Writes a real topology manifest file and returns facts bound to it.
function guardTopologyFacts(f, bootId, overrides = {}) {
  const manifestPath = path.join(f.dir, 'topology-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({ links: GUARD_SIX_LINKS }), { mode: 0o600 });
  }
  const manifestSha = lib.sha256Hex(fs.readFileSync(manifestPath));
  return {
    topologyManifestPath: manifestPath,
    topologyManifestSha256: manifestSha,
    bootId,
    stoppedRoleGenerations: guardStoppedRoleGenerations(),
    ...overrides,
  };
}

const GUARD_INHIBITOR_BYTES = Buffer.from('guard inhibitor\n');
const GUARD_HELPER_BYTES = Buffer.from('guard inhibitor helper\n');
const GUARD_94_BYTES = Buffer.from('guard-aware identity enable\n');
const GUARD_INHIBITOR = lib.sha256Hex(GUARD_INHIBITOR_BYTES);
const GUARD_HELPER = lib.sha256Hex(GUARD_HELPER_BYTES);
const GUARD_94 = lib.sha256Hex(GUARD_94_BYTES);
const GUARD_PROOF_GENERATION = 'e4'.repeat(32);
const GUARD_SIXLINK_SHA = lib.canonicalHash({ entries: GUARD_SIX_LINKS
  .map((logicalPath) => ({ path: logicalPath, type: 'absent' }))
  .sort((a, b) => a.path.localeCompare(b.path)) });
function guardClaimAuthorityFixture(f, { bootId = GB1, deploymentId = f.guardDeploymentId || 'dep-g-1' } = {}) {
  if (f.guardClaimAuthority && f.guardClaimAuthority.bootId === bootId
      && f.guardClaimAuthority.deploymentId === deploymentId) return f.guardClaimAuthority;
  fs.mkdirSync(f.root, { recursive: true, mode: 0o700 });
  fs.chmodSync(f.root, 0o700);
  f.receipts ||= path.join(f.dir, 'receipts');
  const candidatePath = path.join(f.dir, 'claim-candidate.json');
  const databasePath = path.join(f.dir, 'claim-farming.db');
  const lockDir = path.join(f.dir, 'osi-deploy.lock.d');
  const lockOwnerPath = path.join(lockDir, 'owner.json');
  if (f.guardClaimAuthority && fs.existsSync(lockOwnerPath)) {
    const currentOwner = JSON.parse(fs.readFileSync(lockOwnerPath, 'utf8'));
    if (currentOwner.deploymentId !== deploymentId || currentOwner.bootId !== bootId) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(candidatePath, '{"candidate":"guard-claim"}\n', { mode: 0o600 });
  fs.writeFileSync(databasePath, 'sqlite-guard-claim\n', { mode: 0o600 });
  if (!fs.existsSync(lockOwnerPath)) {
    lib.writeLockOwner(lockDir, {
      deploymentId,
      pid: process.ppid,
      processStartTime: testProcessStartTime(process.ppid),
      bootId,
      targetCommitSha: 'a'.repeat(40),
      controllerGeneration: 1,
      acquiredAt: '2026-07-19T00:00:00.000Z',
    });
  }
  const databaseStat = fs.statSync(databasePath);

  const liveControlPaths = [
    '/etc/init.d/node-red', '/etc/init.d/osi-bootstrap', '/etc/init.d/osi-db-integrity', '/etc/init.d/osi-identityd',
    '/usr/libexec/osi-gateway-identity.sh', '/usr/libexec/osi-identityd.sh',
    '/etc/init.d/osi-deployment-inhibit', '/usr/libexec/osi-deployment-inhibit.sh',
    '/etc/uci-defaults/94_osi_identityd_enable',
    '/usr/libexec/osi-current-role-state', '/usr/libexec/osi-record-role-start',
  ];
  guardTargetSafetyFixture(f);
  const liveControls = liveControlPaths.map((logicalPath) => {
    const actual = path.join(f.dir, `.${logicalPath}`);
    fs.mkdirSync(path.dirname(actual), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(actual)) fs.writeFileSync(actual, `control:${logicalPath}\n`, { mode: 0o755 });
    fs.chmodSync(actual, 0o755);
    return {
      path: logicalPath,
      sha256: lib.sha256Hex(fs.readFileSync(actual)),
      mode: fs.statSync(actual).mode & 0o777,
    };
  });
  const residents = {};
  for (const [role, logicalPath, mode] of [
    ['stateLibrary', '/usr/libexec/osi-deployment-state.js', 0o755],
    ['stateCli', '/usr/libexec/osi-deployment-state-cli.js', 0o755],
    ['guardedLauncher', '/usr/libexec/osi-node-red-guarded-launch.js', 0o755],
  ]) {
    const residentPath = path.join(f.dir, `.${logicalPath}`);
    residents[role] = { path: residentPath, sha256: lib.sha256Hex(fs.readFileSync(residentPath)), mode };
  }
  const mountInfoText = `36 25 8:1 / ${f.dir} rw,relatime - ext4 /dev/osi-test rw\n`;
  fs.writeFileSync(path.join(f.dir, 'mountinfo.test'), mountInfoText, { mode: 0o600 });
  const targetSafety = guardTargetSafetyFixture(f);
  const marker = {
    format: 1,
    deploymentId,
    rootPath: f.dir,
    statePath: path.join(f.dir, 'deployment-state.json'),
    receiptsPath: f.receipts,
    mountIdentitySha256: require('./deployment-state-cli').computeMountIdentity(
      f.dir, { mountInfoText, artifactMode: 'test' }
    ).sha256,
    candidate: { path: candidatePath, sha256: lib.sha256Hex(fs.readFileSync(candidatePath)) },
    database: {
      path: databasePath,
      identitySha256: lib.canonicalHash({ device: databaseStat.dev, inode: databaseStat.ino }),
    },
    lockOwner: { path: lockOwnerPath, sha256: lib.sha256Hex(fs.readFileSync(lockOwnerPath)) },
    residents,
    liveRootPath: f.dir,
    liveControls,
    targetSafety: {
      manifestPath: targetSafety.manifestPath,
      manifestSha256: targetSafety.manifestSha256,
      guardGenerationSha256: GUARD_PROOF_GENERATION,
    },
    sixLinkTopologySha256: GUARD_SIXLINK_SHA,
    uciIdentitySha256: lib.canonicalHash({ status: 'absent' }),
    nodeRedLaunch: {
      executable: '/usr/bin/node-red',
      argvSha256: lib.sha256Hex(Buffer.from(JSON.stringify(['/usr/bin/node-red', '--userDir', '/srv/node-red']))),
    },
  };
  const markerPath = writeJsonFile(path.join(f.dir, 'guard-installed.json'), marker);
  fs.chmodSync(markerPath, 0o600);
  f.startupAuthority = { marker, markerPath };
  const roleStatePath = writeJsonFile(path.join(f.dir, 'current-role-state.json'), {
    format: 1,
    bootId,
    roles: Object.fromEntries(Object.entries(guardStoppedRoleGenerations()).map(([role, generation]) => [
      role, { running: false, ready: false, pid: null, processStartTime: null, generation, bootId,
        rcLinks: review9GuardIntentFacts().priorRoleStates[role].rcLinks.map((link) => ({ path: link.path, state: 'absent' })) },
    ])),
  });
  fs.chmodSync(roleStatePath, 0o600);
  f.guardClaimAuthority = {
    deploymentId, bootId, marker, markerPath, markerSha256: lib.sha256Hex(fs.readFileSync(markerPath)),
    roleStatePath, lockDir,
  };
  return f.guardClaimAuthority;
}

function guardTargetSafetyFixture(f) {
  const deploymentId = f.guardDeploymentId || 'dep-g-1';
  if (f.guardTargetSafety && f.guardTargetSafety.deploymentId === deploymentId) return f.guardTargetSafety;
  const files = [
    ['/usr/libexec/osi-deployment-state.js', Buffer.from('resident state library\n')],
    ['/usr/libexec/osi-deployment-state-cli.js', Buffer.from('resident state cli\n')],
    ['/usr/libexec/osi-node-red-guarded-launch.js', TEST_GATED_LAUNCHER_BYTES],
    ['/usr/libexec/osi-current-role-state', Buffer.from('resident current role\n')],
    ['/usr/libexec/osi-record-role-start', Buffer.from('resident role recorder\n')],
    ['/etc/init.d/osi-deployment-inhibit', GUARD_INHIBITOR_BYTES],
    ['/usr/libexec/osi-deployment-inhibit.sh', GUARD_HELPER_BYTES],
    ['/etc/uci-defaults/94_osi_identityd_enable', GUARD_94_BYTES],
  ];
  for (const [logicalPath, bytes] of files) {
    const actual = path.join(f.dir, `.${logicalPath}`);
    fs.mkdirSync(path.dirname(actual), { recursive: true, mode: 0o700 });
    fs.writeFileSync(actual, bytes, { mode: 0o755 });
    fs.chmodSync(actual, 0o755);
  }
  const s01 = path.join(f.dir, 'etc/rc.d/S01osi-deployment-inhibit');
  fs.mkdirSync(path.dirname(s01), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(s01)) fs.symlinkSync('../init.d/osi-deployment-inhibit', s01);
  const manifestPath = path.join(f.dir, 'compatibility-set/target-safety-manifest.json');
  const manifest = {
    format: 1,
    kind: 'TRAIN_A_TARGET_SAFETY',
    deploymentId,
    manifestPath,
    guardGenerationSha256: GUARD_PROOF_GENERATION,
    entries: lib.collectTopologyPathSet(f.dir, lib.TARGET_SAFETY_PATHS),
  };
  writeJsonFile(manifestPath, manifest);
  f.guardTargetSafety = { deploymentId, manifestPath, manifestSha256: lib.sha256Hex(fs.readFileSync(manifestPath)) };
  return f.guardTargetSafety;
}

function guardFactsFor(phase, f, bootId, overrides = {}) {
  const safety = ['safety-installing', 'safety-installed', 'ready'].includes(phase)
    ? guardTargetSafetyFixture(f) : null;
  switch (phase) {
    case 'intent': return { ...guardIntentFacts(), ...overrides };
    case 'epoch-start': return {
      priorRoleStates: guardEpochRoleStates(bootId),
      ...overrides,
    };
    case 'roles-stopping': return {
      priorRoleStatesSha256: lib.canonicalHash(guardEpochRoleStates(bootId)),
      ...overrides,
    };
    case 'roles-stopped': return { stoppedRoleGenerations: guardStoppedRoleGenerations(), ...overrides };
    case 'topology-snapshotted': return guardTopologyFacts(f, bootId, overrides);
    case 'safety-installing': return {
      targetSafetyManifestSha256: safety.manifestSha256,
      intendedPaths: [...lib.TARGET_SAFETY_PATHS],
      ...overrides,
    };
    case 'safety-installed': return {
      targetSafetyManifestSha256: safety.manifestSha256,
      inhibitorSha256: GUARD_INHIBITOR,
      helperSha256: GUARD_HELPER,
      guardAware94Sha256: GUARD_94,
      s01Target: '../init.d/osi-deployment-inhibit',
      fsyncResult: 'ok',
      ...overrides,
    };
    case 'links-quarantined': return {
      sixLinkTopologySha256: GUARD_SIXLINK_SHA,
      removedLinks: structuredClone(GUARD_SIX_LINK_TARGETS),
      ...overrides,
    };
    case 'controls-installed': return {
      controlManifestSha256: 'c'.repeat(64),
      installedControlHashes: { '/etc/init.d/node-red': 'f0'.repeat(32), '/etc/init.d/osi-identityd': 'f1'.repeat(32) },
      ...overrides,
    };
    case 'ready': return {
      markerSha256: guardClaimAuthorityFixture(f, { bootId }).markerSha256,
      sixLinkTopologySha256: GUARD_SIXLINK_SHA,
      targetSafetyManifestSha256: safety.manifestSha256,
      ...overrides,
    };
    default:
      throw new Error(`guardFactsFor: no factory for phase ${phase}`);
  }
}

const GUARD_FIRST_EPOCH = [
  'intent', 'epoch-start', 'roles-stopping', 'roles-stopped', 'topology-snapshotted',
  'safety-installing', 'safety-installed', 'links-quarantined',
  'controls-installed', 'ready',
];

// Drives appendGuardEntry through the first-epoch sequence up to (and
// including) targetPhase, all in boot `bootId`.
function buildGuardChain(f, targetPhase, { bootId = GB1, deploymentId = 'dep-g-1' } = {}) {
  const upTo = GUARD_FIRST_EPOCH.indexOf(targetPhase);
  assert.ok(upTo >= 0, `buildGuardChain: unknown target phase ${targetPhase}`);
  let head = null;
  f.guardDeploymentId = deploymentId;
  for (let i = 0; i <= upTo; i++) {
    const phase = GUARD_FIRST_EPOCH[i];
    head = lib.appendGuardEntry(f.root, deploymentId, {
      ...guardCommonIdentity({ deploymentId }),
      bootEpoch: 1,
      bootId,
      phase,
      facts: guardFactsFor(phase, f, bootId),
      result: 'ok',
      createdAt: new Date().toISOString(),
    }, { expectedGeneration: i });
  }
  return head;
}

// Raw append that bypasses appendGuardEntry validation, for hand-building
// invalid chains. Maintains correct previousGenerationSha256 unless told not
// to, so a single deliberate defect is the only defect.
function rawGuardAppend(f, deploymentId, entry, { generation, breakPrevSha = false } = {}) {
  const chainDir = path.join(f.root, deploymentId);
  fs.mkdirSync(chainDir, { recursive: true, mode: 0o700 });
  const gen = generation;
  let prevSha = null;
  if (gen > 1) {
    const prevPath = path.join(chainDir, `${String(gen - 1).padStart(8, '0')}.json`);
    prevSha = lib.sha256Hex(fs.readFileSync(prevPath));
  }
  const full = { ...entry, generation: gen, previousGenerationSha256: breakPrevSha ? 'f'.repeat(64) : prevSha };
  const p = path.join(chainDir, `${String(gen).padStart(8, '0')}.json`);
  fs.writeFileSync(p, JSON.stringify(full, null, 2), { mode: 0o600 });
  return { path: p, entry: full };
}

test('G1 grammar: guardGenerationFileName is 8-digit zero-padded', () => {
  assert.equal(lib.guardGenerationFileName(1), '00000001.json');
  assert.equal(lib.guardGenerationFileName(42), '00000042.json');
  assert.equal(lib.guardGenerationFileName(99999999), '99999999.json');
  assert.throws(() => lib.guardGenerationFileName(0), /positive/);
  assert.throws(() => lib.guardGenerationFileName(100000000), /grammar|range/);
});

test('G1 grammar: parseGuardGenerationFileName enforces strict zero-padded grammar', () => {
  assert.equal(lib.parseGuardGenerationFileName('00000001.json'), 1);
  assert.equal(lib.parseGuardGenerationFileName('00000123.json'), 123);
  for (const bad of ['1.json', '0000001.json', '000000001.json', '00000001.JSON', '00000001.json.bak', 'x0000001.json', '00000001', '00000000.json']) {
    assert.equal(lib.parseGuardGenerationFileName(bad), null, `must reject '${bad}'`);
  }
});

test('G1 codec: accepts a well-formed generation-1 intent entry', () => {
  const entry = {
    format: 1,
    generation: 1,
    previousGenerationSha256: null,
    ...guardCommonIdentity(),
    bootEpoch: 1,
    bootId: GB1,
    phase: 'intent',
    facts: guardIntentFacts(),
    result: 'ok',
    createdAt: '2026-07-16T00:00:00.000Z',
  };
  assert.deepEqual(lib.validateGuardEntry(entry), entry);
});

test('G1 codec: rejects unknown top-level field', () => {
  const entry = {
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'intent', facts: guardIntentFacts(), result: 'ok',
    createdAt: '2026-07-16T00:00:00.000Z', extra: true,
  };
  assert.throws(() => lib.validateGuardEntry(entry), /unknown field/);
});

test('G1 codec: rejects missing common-identity field', () => {
  const entry = {
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'intent', facts: guardIntentFacts(), result: 'ok',
    createdAt: '2026-07-16T00:00:00.000Z',
  };
  delete entry.artifactSha256;
  assert.throws(() => lib.validateGuardEntry(entry), /missing required field/);
});

test('G1 codec: rejects unknown phase and unknown profile', () => {
  const base = {
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'intent', facts: guardIntentFacts(), result: 'ok',
    createdAt: '2026-07-16T00:00:00.000Z',
  };
  assert.throws(() => lib.validateGuardEntry({ ...base, phase: 'nope' }), /phase/);
  assert.throws(() => lib.validateGuardEntry({ ...base, detectedProfile: 'bcm9999' }), /Profile|profile/);
});

test('G1 codec: guard phase list matches the plan closed sequence', () => {
  assert.deepEqual(lib.GUARD_FIRST_EPOCH_PHASES, [
    'intent', 'epoch-start', 'roles-stopping', 'roles-stopped', 'topology-snapshotted',
    'safety-installing', 'safety-installed', 'links-quarantined',
    'controls-installed', 'ready', 'claimed',
  ]);
  for (const p of ['epoch-invalidated', 'ready-revalidated', 'abandoning', 'abandoned']) {
    assert.ok(lib.GUARD_PHASES.includes(p), `GUARD_PHASES must include ${p}`);
  }
});

test('G1 stop intent is durable before roles-stopped and binds the immutable prior role authority', () => {
  const f = guardRootFixture();
  const epoch = buildGuardChain(f, 'epoch-start');
  assert.throws(() => lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'roles-stopped', facts: guardFactsFor('roles-stopped', f, GB1),
    result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: epoch.generation, expectedHeadSha256: epoch.sha256 }), /transition|roles-stopping/);
  const intent = lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'roles-stopping', facts: guardFactsFor('roles-stopping', f, GB1),
    result: 'stop-intent-durable', createdAt: new Date().toISOString(),
  }, { expectedGeneration: epoch.generation, expectedHeadSha256: epoch.sha256 });
  assert.equal(intent.entry.facts.priorRoleStatesSha256,
    lib.canonicalHash(guardIntentFacts().priorRoleStates));
});

test('G1 intent codec captures immutable pre-stop process, lifecycle, boot, and rc-link authority', () => {
  const entry = {
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'intent', facts: review9GuardIntentFacts(), result: 'ok',
    createdAt: '2026-07-16T00:00:00.000Z',
  };
  assert.deepEqual(lib.validateGuardEntry(entry), entry);
});

test('G1 intent codec rejects incoherent process, boot, lifecycle, and exact rc-link authority', () => {
  const base = {
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'intent', facts: review9GuardIntentFacts(), result: 'ok',
    createdAt: '2026-07-16T00:00:00.000Z',
  };
  const mutations = [
    (entry) => { entry.facts.priorRoleStates['node-red'].running = false; },
    (entry) => { entry.facts.priorRoleStates['node-red'].bootId = 'wrong-boot'; },
    (entry) => { entry.facts.priorRoleStates['node-red'].lifecycleGeneration = 0; },
    (entry) => { entry.facts.priorRoleStates['node-red'].rcLinks[0].target = '../init.d/wrong-role'; },
    (entry) => { entry.facts.priorRoleStates['osi-db-integrity'].rcLinks[0] = {
      path: '/etc/rc.d/S90osi-db-integrity', state: 'symlink', target: '../init.d/osi-db-integrity',
    }; },
  ];
  for (const mutate of mutations) {
    const entry = structuredClone(base);
    mutate(entry);
    assert.throws(() => lib.validateGuardEntry(entry), /intent|role|running|boot|generation|rcLinks/i);
  }
});

test('G1 six-link codec requires the exact canonical link set and targets', () => {
  const entry = {
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'links-quarantined',
    facts: { sixLinkTopologySha256: GUARD_SIXLINK_SHA, removedLinks: GUARD_SIX_LINK_TARGETS },
    result: 'ok', createdAt: '2026-07-16T00:00:00.000Z',
  };
  assert.deepEqual(lib.validateGuardEntry(entry), entry);
  const arbitrary = structuredClone(entry);
  arbitrary.facts.removedLinks[0] = { path: '/etc/rc.d/S98arbitrary', target: '../init.d/arbitrary' };
  assert.throws(() => lib.validateGuardEntry(arbitrary), /canonical|six-link|target/i);
});

test('G1 codec: per-phase fact binding - unknown/missing fact fields rejected', () => {
  const mk = (phase, facts) => ({
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase, facts, result: 'ok', createdAt: '2026-07-16T00:00:00.000Z',
  });
  // intent facts must carry all four roles.
  const badIntent = guardIntentFacts();
  delete badIntent.priorRoleStates['node-red'];
  assert.throws(() => lib.validateGuardEntry(mk('intent', badIntent)), /missing|node-red/);
  // extra fact field is rejected.
  assert.throws(() => lib.validateGuardEntry(mk('intent', { ...guardIntentFacts(), extra: 1 })), /unknown field/);
  // links-quarantined requires exactly six canonical removed links.
  const f = guardRootFixture();
  const fiveLinks = { sixLinkTopologySha256: GUARD_SIXLINK_SHA, removedLinks: GUARD_SIX_LINK_TARGETS.slice(0, 5) };
  assert.throws(() => lib.validateGuardEntry(mk('links-quarantined', fiveLinks)), /six|6/);
  const dupLinks = { sixLinkTopologySha256: GUARD_SIXLINK_SHA, removedLinks: [...GUARD_SIX_LINK_TARGETS.slice(0, 5), GUARD_SIX_LINK_TARGETS[0]] };
  assert.throws(() => lib.validateGuardEntry(mk('links-quarantined', dupLinks)), /canonical|six-link|target/i);
  // safety-installed requires fsyncResult 'ok'.
  const badFsync = guardFactsFor('safety-installed', f, GB1, { fsyncResult: 'failed' });
  assert.throws(() => lib.validateGuardEntry(mk('safety-installed', badFsync)), /fsyncResult/);
  // abandoning is a closed two-variant union with cross-kind rejection.
  const okNoMut = {
    mutationOccurred: false, headPhaseAtAbandon: 'epoch-start', headGenerationAtAbandon: 2,
    unchangedRoleAuthoritySha256: 'd'.repeat(64),
  };
  assert.deepEqual(lib.validateGuardEntry(mk('abandoning', okNoMut)).facts, okNoMut);
  const okMut = {
    mutationOccurred: true,
    topologySnapshotSha256: 'a'.repeat(64),
    restoreTargetSha256: 'a'.repeat(64),
    topologyRestorationProofSha256: 'b'.repeat(64),
    compatibilityManifestSha256: 'c'.repeat(64),
    lastMutationGeneration: 5,
  };
  assert.deepEqual(lib.validateGuardEntry(mk('abandoning', okMut)).facts, okMut);
  assert.throws(
    () => lib.validateGuardEntry(mk('abandoning', { ...okNoMut, topologySnapshotSha256: 'a'.repeat(64) })),
    /unknown field/
  );
});

test('G1 codec: bounded result field', () => {
  const entry = {
    format: 1, generation: 1, previousGenerationSha256: null,
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'intent', facts: guardIntentFacts(), result: 'x'.repeat(300),
    createdAt: '2026-07-16T00:00:00.000Z',
  };
  assert.throws(() => lib.validateGuardEntry(entry), /result|bounded/);
});

test('G1 append: creates zero-padded mode-0600 generation files with byte-bound prev hashes', () => {
  const f = guardRootFixture();
  const head = buildGuardChain(f, 'roles-stopped');
  assert.equal(head.generation, 4);
  const chainDir = path.join(f.root, 'dep-g-1');
  const names = fs.readdirSync(chainDir).sort();
  assert.deepEqual(names, ['00000001.json', '00000002.json', '00000003.json', '00000004.json']);
  for (const n of names) {
    const stat = fs.lstatSync(path.join(chainDir, n));
    assert.equal(stat.mode & 0o777, 0o600, `${n} must be mode 0600`);
  }
  const chain = lib.readGuardChain(f.root, 'dep-g-1');
  assert.equal(chain.entries.length, 4);
  // Every entry's previousGenerationSha256 binds the previous file's raw bytes.
  for (let i = 1; i < 4; i++) {
    const prevRaw = fs.readFileSync(path.join(chainDir, names[i - 1]));
    assert.equal(chain.entries[i].entry.previousGenerationSha256, lib.sha256Hex(prevRaw));
  }
  assert.equal(chain.entries[0].entry.previousGenerationSha256, null);
  assert.equal(chain.head.entry.phase, 'roles-stopped');
});

test('G1 append durability: generation 1 persists both directory levels before link; later generations do not', () => {
  const f = guardRootFixture();
  const rootParent = path.dirname(f.root);
  const chainDir = path.join(f.root, 'dep-g-1');
  const generation1Path = path.join(chainDir, '00000001.json');
  const first = traceGuardFsEvents(() => lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(),
    bootEpoch: 1,
    bootId: GB1,
    phase: 'intent',
    facts: guardIntentFacts(),
    result: 'ok',
    createdAt: '2026-07-18T00:00:00.000Z',
  }, { expectedGeneration: 0 }));
  assertGeneration1DurabilityTrace(first.events, { root: f.root, chainDir, generationPath: generation1Path });

  const generation2Path = path.join(chainDir, '00000002.json');
  const second = traceGuardFsEvents(() => lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(),
    bootEpoch: 1,
    bootId: GB1,
    phase: 'epoch-start',
    facts: guardFactsFor('epoch-start', f, GB1),
    result: 'ok',
    createdAt: '2026-07-18T00:00:01.000Z',
  }, { expectedGeneration: 1, expectedHeadSha256: first.result.sha256 }));
  assert.equal(
    second.events.some((event) => event.kind === 'fsync' && event.path === rootParent),
    false,
    'later generations must not fsync the guard-root parent'
  );
  assert.equal(
    second.events.some((event) => event.kind === 'fsync' && event.path === f.root),
    false,
    'later generations must not fsync the guard root'
  );
  const generation2Link = second.events.findIndex((event) => event.kind === 'link' && event.path === generation2Path);
  const laterChainFsync = second.events.findIndex((event, index) => (
    index > generation2Link && event.kind === 'fsync' && event.path === chainDir
  ));
  assert.notEqual(generation2Link, -1, 'later generation must link its immutable entry');
  assert.notEqual(laterChainFsync, -1, 'later generation must fsync the chain directory after link');
  assert.ok(generation2Link < laterChainFsync, 'later link must retain the chain-directory fsync');
});

function assertExistingChainDirectoryRetry({ tempDebris = false } = {}) {
  const f = guardRootFixture();
  const chainDir = path.join(f.root, 'dep-g-1');
  fs.mkdirSync(chainDir, { recursive: true, mode: 0o700 });
  if (tempDebris) {
    fs.writeFileSync(
      path.join(chainDir, '.00000001.json.tmp-123-abcdef'),
      'interrupted append temp',
      { mode: 0o600 }
    );
  }
  assert.equal(lib.readGuardChain(f.root, 'dep-g-1'), null);

  const generationPath = path.join(chainDir, '00000001.json');
  const traced = traceGuardFsEvents(() => lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(),
    bootEpoch: 1,
    bootId: GB1,
    phase: 'intent',
    facts: guardIntentFacts(),
    result: 'ok',
    createdAt: '2026-07-18T00:00:00.000Z',
  }, { expectedGeneration: 0 }));
  assertGeneration1DurabilityTrace(traced.events, { root: f.root, chainDir, generationPath });

  const durableGenerations = fs.readdirSync(chainDir).filter((name) => /^\d{8}\.json$/.test(name));
  assert.deepEqual(durableGenerations, ['00000001.json']);
  const chain = lib.readGuardChain(f.root, 'dep-g-1');
  assert.equal(chain.entries.length, 1);
  assert.equal(chain.head.entry.phase, 'intent');
}

test('G1 append durability retry: an existing empty chain directory repeats both higher-level fsyncs', () => {
  assertExistingChainDirectoryRetry();
});

test('G1 append durability retry: an existing temp-debris-only chain repeats both higher-level fsyncs', () => {
  assertExistingChainDirectoryRetry({ tempDebris: true });
});

test('G1 append: expected-generation CAS mismatch fails bounded', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'roles-stopped', facts: guardFactsFor('roles-stopped', f, GB1),
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 1 }),
    /cas-mismatch/
  );
});

test('G1 append: expected head sha pin rejects a mismatched head', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'roles-stopped', facts: guardFactsFor('roles-stopped', f, GB1),
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 2, expectedHeadSha256: 'f'.repeat(64) }),
    /cas-mismatch|head/
  );
});

test('G1 append: a pre-existing next generation file is an exclusive-create conflict', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  const chainDir = path.join(f.root, 'dep-g-1');
  fs.writeFileSync(path.join(chainDir, '00000003.json'), 'squatter', { mode: 0o600 });
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'roles-stopped', facts: guardFactsFor('roles-stopped', f, GB1),
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 2 }),
    /guard-generation-conflict|corrupt/
  );
});

test('G1 append: phase transition adjacency is enforced (no phase skipping)', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'topology-snapshotted', facts: guardTopologyFacts(f, GB1),
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 2 }),
    /guard-phase-transition/
  );
});

test('G1 append: common identity must stay constant across the chain', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity({ targetCommitSha: 'b'.repeat(40) }), bootEpoch: 1, bootId: GB1,
      phase: 'roles-stopped', facts: guardFactsFor('roles-stopped', f, GB1),
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 2 }),
    /guard-identity-mismatch/
  );
});

test('G1 chain: generation 1 must be intent at bootEpoch 1', () => {
  const f = guardRootFixture();
  rawGuardAppend(f, 'dep-bad-first', {
    format: 1, ...guardCommonIdentity({ deploymentId: 'dep-bad-first' }),
    bootEpoch: 1, bootId: GB1, phase: 'epoch-start', facts: guardFactsFor('epoch-start', f, GB1),
    result: 'ok', createdAt: '2026-07-16T00:00:00.000Z',
  }, { generation: 1 });
  assert.throws(() => lib.readGuardChain(f.root, 'dep-bad-first'), /intent|first/);
});

test('G1 chain: gap detection', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'roles-stopped');
  fs.rmSync(path.join(f.root, 'dep-g-1', '00000002.json'));
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /guard-chain-gap/);
});

test('G1 chain: fork/tamper detection via previousGenerationSha256', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'roles-stopped');
  const gen1 = path.join(f.root, 'dep-g-1', '00000001.json');
  const tampered = JSON.parse(fs.readFileSync(gen1, 'utf8'));
  tampered.result = 'tampered';
  fs.writeFileSync(gen1, JSON.stringify(tampered, null, 2), { mode: 0o600 });
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /guard-chain-fork/);
});

test('G1 chain: corrupt JSON generation is rejected', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  fs.writeFileSync(path.join(f.root, 'dep-g-1', '00000002.json'), '{ not json', { mode: 0o600 });
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /guard-chain-corrupt/);
});

test('G1 chain: symlinked generation entry is rejected', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  const chainDir = path.join(f.root, 'dep-g-1');
  const real = path.join(f.dir, 'elsewhere.json');
  fs.copyFileSync(path.join(chainDir, '00000002.json'), real);
  fs.rmSync(path.join(chainDir, '00000002.json'));
  fs.symlinkSync(real, path.join(chainDir, '00000002.json'));
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /symlink/);
});

test('G1 chain: directory-as-generation and bad-grammar entries are rejected', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  const chainDir = path.join(f.root, 'dep-g-1');
  fs.mkdirSync(path.join(chainDir, '00000003.json'));
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /regular file|guard-grammar/);
  fs.rmdirSync(path.join(chainDir, '00000003.json'));
  fs.writeFileSync(path.join(chainDir, 'notes.txt'), 'x', { mode: 0o600 });
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /guard-grammar/);
});

test('G1 chain: special file (fifo) as generation entry is rejected', (t) => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  const chainDir = path.join(f.root, 'dep-g-1');
  const fifo = path.join(chainDir, '00000003.json');
  const res = require('node:child_process').spawnSync('mkfifo', [fifo]);
  if (res.status !== 0) {
    t.skip('mkfifo unavailable');
    return;
  }
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /regular file|guard-grammar/);
});

test('G1 chain: listGuardChainDirs rejects symlinked and non-directory children', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'epoch-start');
  // Symlinked child dir.
  const realDir = path.join(f.dir, 'real-chain-dir');
  fs.mkdirSync(realDir, { mode: 0o700 });
  fs.symlinkSync(realDir, path.join(f.root, 'dep-linked'));
  assert.throws(() => lib.listGuardChainDirs(f.root), /symlink/);
  fs.rmSync(path.join(f.root, 'dep-linked'));
  // Plain-file child.
  fs.writeFileSync(path.join(f.root, 'stray-file'), 'x', { mode: 0o600 });
  assert.throws(() => lib.listGuardChainDirs(f.root), /directory/);
});

test('G1 epoch: mid-epoch bootId change without epoch-invalidated fails chain verification', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'roles-stopping');
  // Hand-write a roles-stopped entry in a different boot without invalidation.
  rawGuardAppend(f, 'dep-g-1', {
    format: 1, ...guardCommonIdentity(),
    bootEpoch: 1, bootId: 'guard-boot-0002', phase: 'roles-stopped',
    facts: { stoppedRoleGenerations: guardStoppedRoleGenerations() },
    result: 'ok', createdAt: '2026-07-16T00:00:00.000Z',
  }, { generation: 4 });
  assert.throws(() => lib.readGuardChain(f.root, 'dep-g-1'), /guard-epoch|bootId/);
});

test('G1 epoch: epoch-invalidated then higher epoch-start verifies; stale-epoch reuse facts fail', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'topology-snapshotted');
  const B2 = 'guard-boot-0002';
  // Invalidate epoch 1 from the new boot.
  const inv = lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 1, bootId: B2,
    phase: 'epoch-invalidated',
    facts: { invalidatedEpoch: 1, previousBootId: GB1 },
    result: 'reboot-before-ready', createdAt: new Date().toISOString(),
  }, { expectedGeneration: 5 });
  assert.equal(inv.generation, 6);
  // Higher epoch-start in the new boot.
  const es = lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 2, bootId: B2,
    phase: 'epoch-start', facts: guardFactsFor('epoch-start', f, B2),
    result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: 6 });
  assert.equal(es.entry.bootEpoch, 2);
  // Fresh durable stop intent and roles-stopped, then a topology snapshot whose facts.bootId is the
  // PRIOR boot must fail (prior-boot stop/snapshot facts cannot advance).
  lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 2, bootId: B2,
    phase: 'roles-stopping', facts: {
      priorRoleStatesSha256: lib.canonicalHash(guardEpochRoleStates(B2)),
    },
    result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: 7 });
  lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 2, bootId: B2,
    phase: 'roles-stopped', facts: { stoppedRoleGenerations: guardStoppedRoleGenerations() },
    result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: 8 });
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 2, bootId: B2,
      phase: 'topology-snapshotted', facts: guardTopologyFacts(f, GB1),
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 9 }),
    /guard-fact-binding|bootId/
  );
});

test('G1 epoch authority: every epoch-start stores exact role, process, lifecycle, boot, and rc-link evidence', () => {
  const f = guardRootFixture();
  const intent = buildGuardChain(f, 'intent');
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'epoch-start', facts: {}, result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: intent.generation, expectedHeadSha256: intent.sha256 }),
    /epoch-start facts|missing.*priorRoleStates/i
  );

  const facts = guardFactsFor('epoch-start', f, GB1);
  const started = lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'epoch-start', facts, result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: intent.generation, expectedHeadSha256: intent.sha256 });
  assert.deepEqual(started.entry.facts.priorRoleStates, guardEpochRoleStates(GB1));
});

test('G1 epoch authority: roles-stopping binds the current epoch-start evidence, never generation-1 intent', () => {
  const f = guardRootFixture();
  const B2 = 'guard-boot-0002';
  let head = buildGuardChain(f, 'epoch-start');
  head = lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 1, bootId: B2,
    phase: 'epoch-invalidated', facts: { invalidatedEpoch: 1, previousBootId: GB1 },
    result: 'reboot-before-ready', createdAt: new Date().toISOString(),
  }, { expectedGeneration: head.generation, expectedHeadSha256: head.sha256 });
  const epochTwoStates = guardEpochRoleStates(B2);
  epochTwoStates['node-red'].pid += 1000;
  epochTwoStates['node-red'].processStartTime = '2011';
  head = lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 2, bootId: B2,
    phase: 'epoch-start', facts: { priorRoleStates: epochTwoStates },
    result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: head.generation, expectedHeadSha256: head.sha256 });

  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 2, bootId: B2,
      phase: 'roles-stopping',
      facts: { priorRoleStatesSha256: lib.canonicalHash(guardIntentFacts().priorRoleStates) },
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: head.generation, expectedHeadSha256: head.sha256 }),
    /roles-stopping.*current epoch|guard-fact-binding/i
  );
  const stopped = lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 2, bootId: B2,
    phase: 'roles-stopping', facts: { priorRoleStatesSha256: lib.canonicalHash(epochTwoStates) },
    result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: head.generation, expectedHeadSha256: head.sha256 });
  assert.equal(stopped.entry.facts.priorRoleStatesSha256, lib.canonicalHash(epochTwoStates));
});

test('G1 epoch: epoch-invalidated in the SAME boot as the head is rejected', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'roles-stopped');
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'epoch-invalidated', facts: { invalidatedEpoch: 1, previousBootId: GB1 },
      result: 'x', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 4 }),
    /guard-epoch|same boot/
  );
});

test('G1 binding: topology-snapshotted stoppedRoleGenerations must match same-epoch roles-stopped', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'roles-stopped');
  const wrongGens = guardTopologyFacts(f, GB1, {
    stoppedRoleGenerations: { ...guardStoppedRoleGenerations(), 'node-red': 999 },
  });
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'topology-snapshotted', facts: wrongGens,
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 4 }),
    /guard-fact-binding/
  );
});

test('G1 binding: safety-installed must bind the same target-safety manifest as safety-installing', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'safety-installing');
  const wrongTsm = guardFactsFor('safety-installed', f, GB1, { targetSafetyManifestSha256: 'ff'.repeat(32) });
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'safety-installed', facts: wrongTsm,
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 6 }),
    /guard-fact-binding/
  );
});

test('G1 binding: ready must bind the epoch six-link and target-safety hashes', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'controls-installed');
  const wrongSix = guardFactsFor('ready', f, GB1, { sixLinkTopologySha256: 'ff'.repeat(32) });
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'ready', facts: wrongSix,
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 9 }),
    /guard-fact-binding/
  );
});

test('G1 binding: controls-installed facts.controlManifestSha256 must match the common identity field', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'links-quarantined');
  const wrongCm = guardFactsFor('controls-installed', f, GB1, { controlManifestSha256: 'ff'.repeat(32) });
  assert.throws(
    () => lib.appendGuardEntry(f.root, 'dep-g-1', {
      ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
      phase: 'controls-installed', facts: wrongCm,
      result: 'ok', createdAt: new Date().toISOString(),
    }, { expectedGeneration: 8 }),
    /guard-fact-binding/
  );
});

test('G1 manifests: verifyGuardManifests checks every bound topology manifest', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'topology-snapshotted');
  const chain = lib.readGuardChain(f.root, 'dep-g-1');
  // Passes with the real manifest in place.
  lib.verifyGuardManifests(chain);
  // Mutated manifest bytes fail.
  const manifestPath = path.join(f.dir, 'topology-manifest.json');
  fs.writeFileSync(manifestPath, 'mutated', { mode: 0o600 });
  assert.throws(() => lib.verifyGuardManifests(chain), /manifest-mismatch/);
  // Missing manifest fails.
  fs.rmSync(manifestPath);
  assert.throws(() => lib.verifyGuardManifests(chain), /manifest-missing/);
});

// ===========================================================================
// Section G2: begin/advance/status-guard-bootstrap CLI verbs.
// Argv forms pinned verbatim from the plan CLI block (lines 180-182).
// ===========================================================================

function withBoot(bootId, extra = {}) {
  return { env: { ...process.env, OSI_DEPLOY_TEST_BOOT_ID: bootId, ...extra } };
}

function guardIdentityFile(f, overrides = {}) {
  const identity = { ...guardCommonIdentity(overrides), priorRoleStates: guardIntentFacts().priorRoleStates };
  if (overrides.priorRoleStates) identity.priorRoleStates = overrides.priorRoleStates;
  return { identity, path: writeJsonFile(path.join(f.dir, `guard-identity-${identity.deploymentId}.json`), identity) };
}

function cliBegin(f, { deploymentId = 'dep-g-1', bootId = GB1, identityOverrides = {} } = {}) {
  const { path: idPath } = guardIdentityFile(f, { deploymentId, ...identityOverrides });
  return runCliOk([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', deploymentId, '--identity', idPath,
  ], withBoot(bootId));
}

const cryptoTest = require('node:crypto');

function factsFileFor(f, phase, bootId, overrides = {}) {
  const facts = guardFactsFor(phase, f, bootId, overrides);
  return writeJsonFile(path.join(f.dir, `facts-${phase}-${cryptoTest.randomBytes(3).toString('hex')}.json`), facts);
}

function cliAdvance(f, {
  deploymentId = 'dep-g-1', bootId = GB1, expectedGeneration, expectedSha, expectedPhase, phase, factsPath,
  env = {},
}) {
  return runCli([
    'advance-guard-bootstrap', '--root', f.root, '--deployment-id', deploymentId,
    '--expected-generation', String(expectedGeneration),
    '--expected-generation-sha256', expectedSha,
    '--expected-phase', expectedPhase,
    '--phase', phase,
    '--facts', factsPath,
  ], withBoot(bootId, env));
}

function headOf(f, deploymentId = 'dep-g-1') {
  const chain = lib.readGuardChain(f.root, deploymentId);
  return chain.head;
}

test('G2 begin: creates generation-1 intent and reports the head', () => {
  const f = guardRootFixture();
  const out = cliBegin(f);
  assert.equal(out.ok, true);
  assert.equal(out.verb, 'begin-guard-bootstrap');
  assert.equal(out.resumed, false);
  assert.equal(out.generation, 1);
  assert.equal(out.phase, 'intent');
  assert.equal(out.bootEpoch, 1);
  const head = headOf(f);
  assert.equal(head.generation, 1);
  assert.equal(head.entry.phase, 'intent');
  assert.equal(head.sha256, out.headSha256);
  assert.equal(fs.lstatSync(head.path).mode & 0o777, 0o600);
});

test('G2 begin: identity deploymentId must match --deployment-id', () => {
  const f = guardRootFixture();
  const { path: idPath } = guardIdentityFile(f, { deploymentId: 'dep-other' });
  const { parsed } = runCliFail([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1', '--identity', idPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'guard-identity-mismatch');
});

test('G2 begin: identity file with unknown field is rejected', () => {
  const f = guardRootFixture();
  const identity = { ...guardCommonIdentity(), priorRoleStates: guardIntentFacts().priorRoleStates, extra: 1 };
  const idPath = writeJsonFile(path.join(f.dir, 'bad-id.json'), identity);
  const { parsed } = runCliFail([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1', '--identity', idPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'unknown-field');
});

test('G2 begin: same ID resumes only from its exact head', () => {
  const f = guardRootFixture();
  cliBegin(f);
  const out = cliBegin(f);
  assert.equal(out.resumed, true);
  assert.equal(out.generation, 1);
  assert.equal(out.phase, 'intent');
});

test('G2 begin: resume with a mismatched identity fails', () => {
  const f = guardRootFixture();
  cliBegin(f);
  const { path: idPath } = guardIdentityFile(f, { deploymentId: 'dep-g-1', targetCommitSha: 'b'.repeat(40) });
  const { parsed } = runCliFail([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1', '--identity', idPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'guard-identity-mismatch');
});

test('G2 begin: refuses a second nonterminal deployment ID', () => {
  const f = guardRootFixture();
  cliBegin(f);
  const { path: idPath } = guardIdentityFile(f, { deploymentId: 'dep-g-2' });
  const { parsed } = runCliFail([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-2', '--identity', idPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'guard-bootstrap-active');
});

test('G2 begin: a claimed prior chain is terminal - a new deployment may begin', () => {
  const f = guardRootFixture();
  buildGuardChain(f, 'ready');
  // Append claimed via the lib (adjacency-legal; the CLI reserves the phase
  // for claim-attempt, which is exercised in G3).
  lib.appendGuardEntry(f.root, 'dep-g-1', {
    ...guardCommonIdentity(), bootEpoch: 1, bootId: GB1,
    phase: 'claimed', facts: { claimSha256: 'a1'.repeat(32), claimPath: path.join(f.dir, 'claim.json') },
    result: 'ok', createdAt: new Date().toISOString(),
  }, { expectedGeneration: 10 });
  const out = cliBegin(f, { deploymentId: 'dep-g-2' });
  assert.equal(out.ok, true);
  assert.equal(out.generation, 1);
});

test('G2 begin: symlinked child under the root is rejected', () => {
  const f = guardRootFixture();
  cliBegin(f);
  const realDir = path.join(f.dir, 'elsewhere-dir');
  fs.mkdirSync(realDir, { mode: 0o700 });
  fs.symlinkSync(realDir, path.join(f.root, 'dep-sneaky'));
  const { path: idPath } = guardIdentityFile(f, { deploymentId: 'dep-g-3' });
  const { parsed } = runCliFail([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-3', '--identity', idPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'symlink-rejected');
});

test('G2 advance: happy path intent -> epoch-start', () => {
  const f = guardRootFixture();
  const begin = cliBegin(f);
  const res = cliAdvance(f, {
    expectedGeneration: 1, expectedSha: begin.headSha256,
    expectedPhase: 'intent', phase: 'epoch-start',
    factsPath: factsFileFor(f, 'epoch-start', GB1),
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.generation, 2);
  assert.equal(out.phase, 'epoch-start');
  assert.equal(headOf(f).entry.phase, 'epoch-start');
});

test('G2 advance: CAS mismatches fail bounded (generation, sha, phase)', () => {
  const f = guardRootFixture();
  const begin = cliBegin(f);
  const factsPath = factsFileFor(f, 'epoch-start', GB1);
  let res = cliAdvance(f, { expectedGeneration: 5, expectedSha: begin.headSha256, expectedPhase: 'intent', phase: 'epoch-start', factsPath });
  assert.equal(JSON.parse(res.stderr).code, 'cas-mismatch');
  res = cliAdvance(f, { expectedGeneration: 1, expectedSha: 'f'.repeat(64), expectedPhase: 'intent', phase: 'epoch-start', factsPath });
  assert.equal(JSON.parse(res.stderr).code, 'cas-mismatch');
  res = cliAdvance(f, { expectedGeneration: 1, expectedSha: begin.headSha256, expectedPhase: 'epoch-start', phase: 'roles-stopped', factsPath });
  assert.equal(JSON.parse(res.stderr).code, 'cas-mismatch');
});

test('G2 advance: verb-reserved phases are rejected', () => {
  const f = guardRootFixture();
  const begin = cliBegin(f);
  for (const reserved of ['intent', 'claimed', 'abandoning', 'abandoned']) {
    const res = cliAdvance(f, {
      expectedGeneration: 1, expectedSha: begin.headSha256,
      expectedPhase: 'intent', phase: reserved,
      factsPath: factsFileFor(f, 'epoch-start', GB1),
    });
    assert.notEqual(res.status, 0);
    assert.equal(JSON.parse(res.stderr).code, 'phase-reserved', `phase ${reserved}`);
  }
});

test('G2 advance: full first-epoch walk to ready via the CLI', () => {
  const f = guardRootFixture();
  let head = { generation: 1, sha256: cliBegin(f).headSha256, phase: 'intent' };
  const seq = GUARD_FIRST_EPOCH.slice(1); // epoch-start..ready
  let expectedPhase = 'intent';
  for (const phase of seq) {
    const res = cliAdvance(f, {
      expectedGeneration: head.generation, expectedSha: head.sha256,
      expectedPhase, phase,
      factsPath: factsFileFor(f, phase, GB1),
    });
    assert.equal(res.status, 0, `advance to ${phase}: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    head = { generation: out.generation, sha256: out.headSha256 };
    expectedPhase = phase;
  }
  const final = headOf(f);
  assert.equal(final.entry.phase, 'ready');
  assert.equal(final.generation, 10);
});

test('G2 reboot: from every pre-ready phase a normal advance fails and epoch invalidation + higher epoch-start recovers', () => {
  const B2 = 'guard-boot-0002';
  const NEXT_NORMAL = {
    intent: 'epoch-start',
    'epoch-start': 'roles-stopping',
    'roles-stopping': 'roles-stopped',
    'roles-stopped': 'topology-snapshotted',
    'topology-snapshotted': 'safety-installing',
    'safety-installing': 'safety-installed',
    'safety-installed': 'links-quarantined',
    'links-quarantined': 'controls-installed',
    'controls-installed': 'ready',
  };
  for (const phase of Object.keys(NEXT_NORMAL)) {
    const f = guardRootFixture();
    const head = buildGuardChain(f, phase, { bootId: GB1 });
    const next = NEXT_NORMAL[phase];
    // Normal advance from the new boot must fail: prior-boot head.
    let res = cliAdvance(f, {
      bootId: B2,
      expectedGeneration: head.generation, expectedSha: head.sha256,
      expectedPhase: phase, phase: next,
      factsPath: factsFileFor(f, next, B2),
    });
    assert.notEqual(res.status, 0, `phase ${phase}: normal advance must fail after reboot`);
    assert.equal(JSON.parse(res.stderr).code, 'reboot-required', `phase ${phase}`);
    // Epoch invalidation from the new boot succeeds.
    const invFacts = writeJsonFile(path.join(f.dir, 'facts-inv.json'), { invalidatedEpoch: 1, previousBootId: GB1 });
    res = cliAdvance(f, {
      bootId: B2,
      expectedGeneration: head.generation, expectedSha: head.sha256,
      expectedPhase: phase, phase: 'epoch-invalidated', factsPath: invFacts,
    });
    assert.equal(res.status, 0, `phase ${phase}: epoch-invalidated: ${res.stderr}`);
    const inv = JSON.parse(res.stdout);
    // Higher epoch-start in the invalidating boot.
    res = cliAdvance(f, {
      bootId: B2,
      expectedGeneration: inv.generation, expectedSha: inv.headSha256,
      expectedPhase: 'epoch-invalidated', phase: 'epoch-start',
      factsPath: factsFileFor(f, 'epoch-start', B2),
    });
    assert.equal(res.status, 0, `phase ${phase}: epoch-start after invalidation: ${res.stderr}`);
    assert.equal(JSON.parse(res.stdout).bootEpoch, 2, `phase ${phase}: epoch must be higher`);
  }
});

test('G2 reboot: epoch-invalidated in the same boot is rejected', () => {
  const f = guardRootFixture();
  const head = buildGuardChain(f, 'roles-stopped');
  const invFacts = writeJsonFile(path.join(f.dir, 'facts-inv.json'), { invalidatedEpoch: 1, previousBootId: GB1 });
  const res = cliAdvance(f, {
    expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'roles-stopped', phase: 'epoch-invalidated', factsPath: invFacts,
  });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'guard-epoch');
});

test('G2 reboot at ready: ready-revalidated requires a new boot and reverified facts', () => {
  const B2 = 'guard-boot-0002';
  const f = guardRootFixture();
  const head = buildGuardChain(f, 'ready');
  let revalFacts = {
    markerSha256: head.entry.facts.markerSha256,
    guardAware94Sha256: GUARD_94,
    inhibitorSha256: GUARD_INHIBITOR,
    controlManifestSha256: 'c'.repeat(64),
    sixLinksAbsent: true,
    volatileRestartFacts: { reconciled: true },
  };
  // Same-boot revalidation is illegal.
  let res = cliAdvance(f, {
    expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'ready', phase: 'ready-revalidated',
    factsPath: writeJsonFile(path.join(f.dir, 'facts-reval.json'), revalFacts),
  });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'guard-epoch');
  // The volatile owner is replaced on reboot, so revalidation binds the
  // freshly rewritten marker rather than the prior boot's marker bytes.
  const rebootAuthority = guardClaimAuthorityFixture(f, { bootId: B2 });
  revalFacts = { ...revalFacts, markerSha256: rebootAuthority.markerSha256 };
  // New-boot revalidation with freshly measured facts succeeds and stays in the epoch.
  res = cliAdvance(f, {
    bootId: B2,
    expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'ready', phase: 'ready-revalidated',
    factsPath: writeJsonFile(path.join(f.dir, 'facts-reval-ok.json'), revalFacts),
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.phase, 'ready-revalidated');
  assert.equal(out.bootEpoch, 1);
});

test('G2 prior-boot evidence: a fresh epoch cannot advance on the old epoch snapshot facts', () => {
  const B2 = 'guard-boot-0002';
  const f = guardRootFixture();
  const head = buildGuardChain(f, 'topology-snapshotted');
  // Invalidate + restart the epoch in boot 2, stop roles again.
  const invFacts = writeJsonFile(path.join(f.dir, 'inv.json'), { invalidatedEpoch: 1, previousBootId: GB1 });
  let out = JSON.parse(cliAdvance(f, { bootId: B2, expectedGeneration: head.generation, expectedSha: head.sha256, expectedPhase: 'topology-snapshotted', phase: 'epoch-invalidated', factsPath: invFacts }).stdout);
  out = JSON.parse(cliAdvance(f, { bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256, expectedPhase: 'epoch-invalidated', phase: 'epoch-start', factsPath: factsFileFor(f, 'epoch-start', B2) }).stdout);
  out = JSON.parse(cliAdvance(f, { bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256, expectedPhase: 'epoch-start', phase: 'roles-stopping', factsPath: factsFileFor(f, 'roles-stopping', B2) }).stdout);
  out = JSON.parse(cliAdvance(f, { bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256, expectedPhase: 'roles-stopping', phase: 'roles-stopped', factsPath: factsFileFor(f, 'roles-stopped', B2) }).stdout);
  // Snapshot bound to the PRIOR boot id must be rejected.
  const res = cliAdvance(f, {
    bootId: B2,
    expectedGeneration: out.generation, expectedSha: out.headSha256,
    expectedPhase: 'roles-stopped', phase: 'topology-snapshotted',
    factsPath: factsFileFor(f, 'topology-snapshotted', GB1),
  });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'guard-fact-binding');
});

test('G2 epoch-start: submitted role evidence must equal a fresh current helper sample', () => {
  const f = guardRootFixture();
  const begin = cliBegin(f);
  const roleStatePath = priorRoleStateFile(f, { bootId: GB1 });
  const stale = guardEpochRoleStates(GB1);
  stale['node-red'] = { ...stale['node-red'], pid: 9999 };
  const factsPath = writeJsonFile(path.join(f.dir, 'stale-epoch-start-facts.json'), {
    priorRoleStates: stale,
  });
  const result = cliAdvance(f, {
    expectedGeneration: begin.generation,
    expectedSha: begin.headSha256,
    expectedPhase: 'intent',
    phase: 'epoch-start',
    factsPath,
    env: { OSI_DEPLOY_TEST_ROLE_STATE: roleStatePath },
  });
  assert.equal(result.status !== 0, true);
  assert.equal(JSON.parse(result.stderr).code, 'guard-fact-binding');
  assert.equal(headOf(f).generation, 1);
});

test('G2 status: verifies the complete chain and referenced manifests', () => {
  const f = guardRootFixture();
  const head = buildGuardChain(f, 'topology-snapshotted');
  const out = runCliOk([
    'status-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1',
    '--expected-head-sha256', head.sha256,
  ], withBoot(GB1));
  assert.equal(out.ok, true);
  assert.equal(out.headGeneration, 5);
  assert.equal(out.phase, 'topology-snapshotted');
  assert.equal(out.headSha256, head.sha256);
  // Wrong expected head sha.
  const { parsed } = runCliFail([
    'status-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1',
    '--expected-head-sha256', 'f'.repeat(64),
  ], withBoot(GB1));
  assert.equal(parsed.code, 'cas-mismatch');
});

test('G2 status: mutated referenced manifest fails', () => {
  const f = guardRootFixture();
  const head = buildGuardChain(f, 'topology-snapshotted');
  fs.writeFileSync(path.join(f.dir, 'topology-manifest.json'), 'mutated', { mode: 0o600 });
  const { parsed } = runCliFail([
    'status-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1',
    '--expected-head-sha256', head.sha256,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'manifest-mismatch');
});

test('G2 status: tampered chain fails; missing chain fails bounded', () => {
  const f = guardRootFixture();
  const head = buildGuardChain(f, 'roles-stopped');
  const gen1 = path.join(f.root, 'dep-g-1', '00000001.json');
  const tampered = JSON.parse(fs.readFileSync(gen1, 'utf8'));
  tampered.result = 'tampered';
  fs.writeFileSync(gen1, JSON.stringify(tampered, null, 2), { mode: 0o600 });
  let { parsed } = runCliFail([
    'status-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1',
    '--expected-head-sha256', head.sha256,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'guard-chain-fork');
  ({ parsed } = runCliFail([
    'status-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-none',
    '--expected-head-sha256', 'a'.repeat(64),
  ], withBoot(GB1)));
  assert.equal(parsed.code, 'guard-chain-missing');
});

test('G2 crash: begin killed after first chain mkdir resumes and publishes generation 1 once', () => {
  const f = guardRootFixture();
  const { path: idPath } = guardIdentityFile(f, { deploymentId: 'dep-g-1' });
  const res = runCli([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1', '--identity', idPath,
  ], withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:intent:after-chain-dir-mkdir' }));
  assert.equal(res.status, 137);
  const chainDir = path.join(f.root, 'dep-g-1');
  assert.equal(fs.lstatSync(chainDir).isDirectory(), true);
  assert.equal(lib.readGuardChain(f.root, 'dep-g-1'), null, 'mkdir alone publishes no generation');

  const out = cliBegin(f);
  assert.equal(out.resumed, false);
  assert.equal(out.generation, 1);
  assert.equal(fs.readdirSync(chainDir).filter((name) => /^\d{8}\.json$/.test(name)).length, 1);
});

test('G2 crash: begin killed after tmp fdatasync - no generation exists, clean retry', () => {
  const f = guardRootFixture();
  const { path: idPath } = guardIdentityFile(f, { deploymentId: 'dep-g-1' });
  const res = runCli([
    'begin-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1', '--identity', idPath,
  ], withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:intent:after-tmp-fdatasync' }));
  assert.equal(res.status, 137);
  assert.equal(lib.readGuardChain(f.root, 'dep-g-1'), null, 'chain dir may exist but no generation is durable');
  const out = cliBegin(f);
  assert.equal(out.resumed, false);
  assert.equal(out.generation, 1);
});

test('G2 crash: advance killed after link - generation durable, retry is a cas-mismatch, chain intact', () => {
  const f = guardRootFixture();
  const begin = cliBegin(f);
  const factsPath = factsFileFor(f, 'epoch-start', GB1);
  const crashed = cliAdvance(f, {
    bootId: GB1,
    expectedGeneration: 1, expectedSha: begin.headSha256,
    expectedPhase: 'intent', phase: 'epoch-start', factsPath,
  });
  // note: cliAdvance has no crash env; craft manually
  assert.equal(crashed.status, 0);
  // Rebuild a fresh fixture for the real crash case.
  const f2 = guardRootFixture();
  const begin2 = cliBegin(f2);
  const facts2 = factsFileFor(f2, 'epoch-start', GB1);
  const res = runCli([
    'advance-guard-bootstrap', '--root', f2.root, '--deployment-id', 'dep-g-1',
    '--expected-generation', '1', '--expected-generation-sha256', begin2.headSha256,
    '--expected-phase', 'intent', '--phase', 'epoch-start', '--facts', facts2,
  ], withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:epoch-start:after-link' }));
  assert.equal(res.status, 137);
  const head = headOf(f2);
  assert.equal(head.generation, 2, 'the appended generation must be durable');
  assert.equal(head.entry.phase, 'epoch-start');
  // Retry with the same CAS fails bounded; the chain did not double-apply.
  const retry = runCli([
    'advance-guard-bootstrap', '--root', f2.root, '--deployment-id', 'dep-g-1',
    '--expected-generation', '1', '--expected-generation-sha256', begin2.headSha256,
    '--expected-phase', 'intent', '--phase', 'epoch-start', '--facts', facts2,
  ], withBoot(GB1));
  assert.notEqual(retry.status, 0);
  assert.equal(JSON.parse(retry.stderr).code, 'cas-mismatch');
  assert.equal(headOf(f2).generation, 2);
});

test('G2 crash: advance killed after dir fsync - fully durable, next CAS succeeds', () => {
  const f = guardRootFixture();
  const begin = cliBegin(f);
  const factsPath = factsFileFor(f, 'epoch-start', GB1);
  const res = runCli([
    'advance-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1',
    '--expected-generation', '1', '--expected-generation-sha256', begin.headSha256,
    '--expected-phase', 'intent', '--phase', 'epoch-start', '--facts', factsPath,
  ], withBoot(GB1, { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:epoch-start:after-dir-fsync' }));
  assert.equal(res.status, 137);
  const head = headOf(f);
  assert.equal(head.generation, 2);
  const next = cliAdvance(f, {
    expectedGeneration: 2, expectedSha: head.sha256,
    expectedPhase: 'epoch-start', phase: 'roles-stopping',
    factsPath: factsFileFor(f, 'roles-stopping', GB1),
  });
  assert.equal(next.status, 0, next.stderr);
});

test('G2 RACE: two concurrent begins with different IDs - exactly one chain wins', async () => {
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const f = guardRootFixture();
    const a = guardIdentityFile(f, { deploymentId: `dep-race-a-${i}` });
    const b = guardIdentityFile(f, { deploymentId: `dep-race-b-${i}` });
    const [ra, rb] = await Promise.all([
      runCliAsync(['begin-guard-bootstrap', '--root', f.root, '--deployment-id', `dep-race-a-${i}`, '--identity', a.path], withBoot(GB1)),
      runCliAsync(['begin-guard-bootstrap', '--root', f.root, '--deployment-id', `dep-race-b-${i}`, '--identity', b.path], withBoot(GB1)),
    ]);
    const winners = [ra, rb].filter((r) => r.status === 0);
    assert.equal(
      winners.length, 1,
      `iteration ${i}: expected exactly one winner\n` +
        [ra, rb].map((r) => `status=${r.status} out=${r.stdout} err=${r.stderr}`).join('\n')
    );
    const loser = [ra, rb].find((r) => r.status !== 0);
    const code = parseStderrCode(loser);
    assert.ok(['state-busy', 'guard-bootstrap-active'].includes(code), `iteration ${i}: bounded loser, got ${code}`);
    const dirs = lib.listGuardChainDirs(f.root);
    assert.equal(dirs.length, 1, `iteration ${i}: exactly one chain dir must exist, got ${dirs.join(',')}`);
  }
});

test('G2 RACE: two concurrent same-CAS advances - the chain advances exactly once', async () => {
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const f = guardRootFixture();
    const begin = cliBegin(f);
    const factsPath = factsFileFor(f, 'epoch-start', GB1);
    const args = [
      'advance-guard-bootstrap', '--root', f.root, '--deployment-id', 'dep-g-1',
      '--expected-generation', '1', '--expected-generation-sha256', begin.headSha256,
      '--expected-phase', 'intent', '--phase', 'epoch-start', '--facts', factsPath,
    ];
    const [ra, rb] = await Promise.all([runCliAsync(args, withBoot(GB1)), runCliAsync(args, withBoot(GB1))]);
    const winners = [ra, rb].filter((r) => r.status === 0);
    assert.equal(
      winners.length, 1,
      `iteration ${i}: expected exactly one successful CAS\n` +
        [ra, rb].map((r) => `status=${r.status} out=${r.stdout} err=${r.stderr}`).join('\n')
    );
    const loser = [ra, rb].find((r) => r.status !== 0);
    const code = parseStderrCode(loser);
    assert.ok(
      ['state-busy', 'cas-mismatch', 'guard-generation-conflict'].includes(code),
      `iteration ${i}: bounded loser, got ${code}`
    );
    const head = headOf(f);
    assert.equal(head.generation, 2, `iteration ${i}: exactly one append`);
    assert.equal(head.entry.phase, 'epoch-start');
  }
});

// ===========================================================================
// Section G3: claim-attempt + abandon-guard-bootstrap.
// Argv forms pinned verbatim from the plan CLI block (lines 183-184).
// ===========================================================================

const GUARD_ZERO64 = '0'.repeat(64);

function guardOpsFixture() {
  const f = guardRootFixture();
  f.attempts = path.join(f.dir, 'attempts');
  f.receipts = path.join(f.dir, 'receipts');
  f.staging = path.join(f.dir, 'staging');
  return f;
}

function cliClaim(f, { deploymentId = 'dep-g-1', bootId = GB1, gen, sha, marker = null, flags = {}, env = {} } = {}) {
  const authority = f.guardClaimAuthority && f.guardClaimAuthority.deploymentId === deploymentId
    ? f.guardClaimAuthority : guardClaimAuthorityFixture(f, { bootId, deploymentId });
  return runCli([
    'claim-attempt', '--attempts', f.attempts, '--guard-bootstrap-root', f.root,
    '--guard-marker', authority.markerPath,
    '--deployment-id', deploymentId,
    '--expected-guard-generation', String(gen),
    '--expected-guard-generation-sha256', sha,
    '--expected-marker-sha256', marker || authority.markerSha256,
    '--controller-generation', flags.controllerGeneration || '1',
    '--target-commit', flags.targetCommit || 'a'.repeat(40),
    '--control-manifest-sha256', flags.controlManifest || 'c'.repeat(64),
    '--artifact-sha256', flags.artifact || 'b'.repeat(64),
  ], withBoot(bootId, { OSI_DEPLOY_TEST_ROLE_STATE: authority.roleStatePath, ...env }));
}

function writeSyntheticTopologyRestorationProof(f, {
  deploymentId = 'dep-g-1', topologyManifestSha256, sixLinkTopologySha256 = null,
  suffix = deploymentId, restoredPredecessor = null,
} = {}) {
  const proofPath = path.join(f.dir, `topology-restoration-proof-${suffix}.json`);
  if (!fs.existsSync(proofPath)) {
    const targetSafety = guardTargetSafetyFixture(f);
    const liveIdentity = lib.liveTopologyIdentity(f.dir);
    const statePath = path.join(f.dir, 'deployment-state.json');
    const state = lib.readState(statePath);
    const selectedPredecessor = restoredPredecessor
      || (state && state.activeSubOperation && state.activeSubOperation.restoredPredecessor)
      || legacyCompatibilityPredecessor({
        compatibilityManifestSha256: '91'.repeat(32),
        topologySha256: liveIdentity.restoredTopologySha256,
        databaseIdentitySha256: '94'.repeat(32),
        flowStamp: '2026-07-18T00-00-00Z',
      });
    const previousUciIdentitySha256 = f.startupAuthority
      ? f.startupAuthority.marker.uciIdentitySha256 : liveIdentity.uciIdentitySha256;
    let uciReview;
    if (previousUciIdentitySha256 === liveIdentity.uciIdentitySha256) {
      uciReview = {
        previousUciIdentitySha256,
        healedUciIdentitySha256: liveIdentity.uciIdentitySha256,
        decision: 'unchanged', comparisonPath: null, comparisonSha256: null,
      };
    } else {
      const comparisonPath = path.join(path.dirname(targetSafety.manifestPath), 'uci-identity-comparison.json');
      writeJsonFile(comparisonPath, {
        format: 1, deploymentId,
        previousUciIdentitySha256,
        healedUciIdentitySha256: liveIdentity.uciIdentitySha256,
        decision: 'preserve-healed',
      });
      uciReview = {
        previousUciIdentitySha256,
        healedUciIdentitySha256: liveIdentity.uciIdentitySha256,
        decision: 'preserve-healed', comparisonPath,
        comparisonSha256: lib.sha256Hex(fs.readFileSync(comparisonPath)),
      };
    }
    fs.writeFileSync(proofPath, JSON.stringify({
      format: 1, kind: 'TRAIN_A_TOPOLOGY_RESTORATION_PROOF', deploymentId,
      compatibilityManifestSha256: selectedPredecessor.kind === 'legacy-compatibility'
        ? selectedPredecessor.compatibilityManifestSha256 : '91'.repeat(32),
      topologyManifestSha256,
      targetSafetyManifestPath: targetSafety.manifestPath,
      targetSafetyManifestSha256: targetSafety.manifestSha256,
      guardGenerationSha256: GUARD_PROOF_GENERATION,
      restoredTopologySha256: selectedPredecessor.kind === 'legacy-compatibility'
        ? selectedPredecessor.topologySha256 : liveIdentity.restoredTopologySha256,
      restoredMetadataSha256: liveIdentity.restoredMetadataSha256,
      uciIdentitySha256: liveIdentity.uciIdentitySha256,
      uciReview,
      sixLinkTopologySha256: sixLinkTopologySha256 || liveIdentity.sixLinkTopologySha256,
      liveRootPath: f.dir,
      restoredPredecessor: selectedPredecessor,
      restoredPredecessorSha256: lib.restoredPredecessorSha256(selectedPredecessor),
    }), { mode: 0o600 });
  }
  fs.chmodSync(proofPath, 0o600);
  return proofPath;
}

test('topology restoration proof schema binds live root and exact restored predecessor canonical hash', () => {
  const predecessor = managedTerminalPredecessor();
  const proof = {
    format: 1, kind: 'TRAIN_A_TOPOLOGY_RESTORATION_PROOF', deploymentId: 'dep-proof',
    liveRootPath: '/live-root', compatibilityManifestSha256: '1'.repeat(64),
    topologyManifestSha256: '2'.repeat(64),
    targetSafetyManifestPath: path.join(TEST_BOUNDARY, 'case-proof/compatibility-set/target-safety-manifest.json'),
    targetSafetyManifestSha256: '3'.repeat(64), guardGenerationSha256: '9'.repeat(64),
    restoredTopologySha256: '4'.repeat(64), restoredMetadataSha256: '5'.repeat(64),
    uciIdentitySha256: '6'.repeat(64),
    uciReview: {
      previousUciIdentitySha256: '6'.repeat(64), healedUciIdentitySha256: '6'.repeat(64),
      decision: 'unchanged', comparisonPath: null, comparisonSha256: null,
    },
    sixLinkTopologySha256: '7'.repeat(64),
    restoredPredecessor: predecessor, restoredPredecessorSha256: lib.restoredPredecessorSha256(predecessor),
  };
  assert.deepEqual(lib.validateTopologyRestorationProof(proof), proof);
  assert.throws(() => lib.validateTopologyRestorationProof({ ...proof,
    restoredPredecessor: { ...predecessor, terminalTupleSha256: '8'.repeat(64) } }), /predecessor|hash/i);
  assert.throws(() => lib.validateTopologyRestorationProof({ ...proof, liveRootPath: 'relative' }), /absolute|path/i);
  const preserveHealed = {
    ...proof,
    uciReview: {
      previousUciIdentitySha256: '8'.repeat(64), healedUciIdentitySha256: proof.uciIdentitySha256,
      decision: 'preserve-healed', comparisonPath: '/caller-selected/comparison.json',
      comparisonSha256: '9'.repeat(64),
    },
  };
  assert.throws(() => lib.validateTopologyRestorationProof(preserveHealed), /canonical|proof-mismatch/);
});

function cliAbandon(f, { deploymentId = 'dep-g-1', bootId = GB1, gen, sha, topologySha = GUARD_ZERO64, staging, env = {}, proofPath } = {}) {
  const args = [
    'abandon-guard-bootstrap', '--guard-bootstrap-root', f.root, '--attempts', f.attempts,
    '--receipts', f.receipts, '--deployment-id', deploymentId,
    '--expected-guard-generation', String(gen),
    '--expected-guard-generation-sha256', sha,
    '--expected-topology-manifest-sha256', topologySha,
    '--staging', staging || path.join(f.staging, deploymentId),
  ];
  const chain = lib.readGuardChain(f.root, deploymentId);
  const mutated = chain && chain.entries.some((entry) => lib.GUARD_MUTATION_PHASES.includes(entry.entry.phase));
  if (mutated) {
    const firstMutation = chain.entries.find((entry) => lib.GUARD_MUTATION_PHASES.includes(entry.entry.phase));
    const snapshot = chain.entries.find((entry) => entry.generation > firstMutation.generation
      && entry.entry.bootEpoch === firstMutation.entry.bootEpoch
      && entry.entry.phase === 'topology-snapshotted');
    if (snapshot) {
      const selectedProof = proofPath || writeSyntheticTopologyRestorationProof(f, {
        deploymentId, topologyManifestSha256: snapshot.entry.facts.topologyManifestSha256,
        suffix: `${deploymentId}-abandon`,
      });
      args.push('--topology-restoration-proof', selectedProof);
    }
  }
  const effectiveEnv = { ...env };
  if (!mutated && effectiveEnv.OSI_DEPLOY_TEST_ROLE_STATE === undefined) {
    effectiveEnv.OSI_DEPLOY_TEST_ROLE_STATE = priorRoleStateFile(f, { deploymentId, bootId });
  }
  return runCli(args, withBoot(bootId, effectiveEnv));
}

function priorRoleStateFile(f, {
  deploymentId = 'dep-g-1', bootId = GB1,
  priorRoleStates = guardEpochRoleStates(bootId), mutate,
} = {}) {
  const prior = priorRoleStates;
  const state = {
    format: 1, bootId,
    roles: Object.fromEntries(Object.entries(prior).map(([role, facts]) => [role, {
      running: facts.running, ready: facts.ready, pid: facts.pid,
      processStartTime: facts.processStartTime, generation: facts.lifecycleGeneration,
      bootId: facts.bootId, rcLinks: structuredClone(facts.rcLinks),
    }])),
  };
  if (mutate) mutate(state);
  const roleStatePath = writeJsonFile(path.join(f.dir, `prior-role-state-${deploymentId}-${cryptoTest.randomBytes(3).toString('hex')}.json`), state);
  fs.chmodSync(roleStatePath, 0o600);
  return roleStatePath;
}

function claimPathOf(f, deploymentId = 'dep-g-1') {
  return path.join(f.attempts, `${deploymentId}.claim.json`);
}

test('G3 claim: happy path creates the immutable claim and appends claimed with byte cross-match', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  const res = cliClaim(f, { gen: head.generation, sha: head.sha256 });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.phase, 'claimed');
  assert.equal(out.generation, 11);
  const claimStat = fs.lstatSync(claimPathOf(f));
  assert.equal(claimStat.mode & 0o777, 0o600);
  const claimRaw = fs.readFileSync(claimPathOf(f));
  const newHead = headOf(f);
  assert.equal(newHead.entry.phase, 'claimed');
  assert.equal(newHead.entry.facts.claimSha256, lib.sha256Hex(claimRaw), 'claimed facts must bind the claim file raw bytes');
  assert.equal(newHead.entry.facts.claimPath, claimPathOf(f));
  const claim = JSON.parse(claimRaw.toString('utf8'));
  assert.equal(claim.deploymentId, 'dep-g-1');
  assert.equal(claim.guardGeneration, head.generation);
  assert.equal(claim.guardGenerationSha256, head.sha256);
  assert.equal(claim.markerSha256, f.guardClaimAuthority.markerSha256);
  assert.equal(claim.guardBootstrapRoot, f.root, 'claim must locate the exact guard chain that issued it');
});

test('G3 claim: CAS/marker/identity/phase negatives are bounded', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  let res = cliClaim(f, { gen: head.generation + 1, sha: head.sha256 });
  assert.equal(JSON.parse(res.stderr).code, 'cas-mismatch');
  res = cliClaim(f, { gen: head.generation, sha: 'f'.repeat(64) });
  assert.equal(JSON.parse(res.stderr).code, 'cas-mismatch');
  res = cliClaim(f, { gen: head.generation, sha: head.sha256, marker: 'ff'.repeat(32) });
  assert.equal(JSON.parse(res.stderr).code, 'marker-mismatch');
  res = cliClaim(f, { gen: head.generation, sha: head.sha256, flags: { targetCommit: 'b'.repeat(40) } });
  assert.equal(JSON.parse(res.stderr).code, 'guard-identity-mismatch');
  const f2 = guardOpsFixture();
  const head2 = buildGuardChain(f2, 'roles-stopped');
  res = cliClaim(f2, { gen: head2.generation, sha: head2.sha256 });
  assert.equal(JSON.parse(res.stderr).code, 'guard-not-ready');
});

test('G3 claim: a prior-boot ready head cannot claim; revalidation re-enables it', () => {
  const B2 = 'guard-boot-0002';
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  let res = cliClaim(f, { bootId: B2, gen: head.generation, sha: head.sha256 });
  assert.notEqual(res.status, 0);
  assert.match(JSON.parse(res.stderr).code, /boot|reboot/);
  // Revalidate in the new boot, then claim binds the revalidated head.
  const rebootAuthority = guardClaimAuthorityFixture(f, { bootId: B2 });
  const revalFacts = writeJsonFile(path.join(f.dir, 'reval.json'), {
    markerSha256: rebootAuthority.markerSha256, guardAware94Sha256: GUARD_94, inhibitorSha256: GUARD_INHIBITOR,
    controlManifestSha256: 'c'.repeat(64), sixLinksAbsent: true, volatileRestartFacts: {},
  });
  const reval = JSON.parse(cliAdvance(f, {
    bootId: B2, expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'ready', phase: 'ready-revalidated', factsPath: revalFacts,
  }).stdout);
  res = cliClaim(f, { bootId: B2, gen: reval.generation, sha: reval.headSha256 });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).phase, 'claimed');
});

test('G3 claim: live marker, S01, six-link, role generation, UCI, and boot mutations fail closed', () => {
  const cases = [
    ['marker bytes', (f) => fs.appendFileSync(f.guardClaimAuthority.markerPath, '\n')],
    ['S01 target', (f) => {
      const s01 = path.join(f.dir, 'etc/rc.d/S01osi-deployment-inhibit');
      fs.unlinkSync(s01);
      fs.symlinkSync('../init.d/not-the-inhibitor', s01);
    }],
    ['six-link topology', (f) => {
      const link = path.join(f.dir, 'etc/rc.d/S99node-red');
      fs.symlinkSync('../init.d/node-red', link);
    }],
    ['role restart generation', (f) => {
      const state = JSON.parse(fs.readFileSync(f.guardClaimAuthority.roleStatePath, 'utf8'));
      state.roles['node-red'] = { running: true, generation: state.roles['node-red'].generation + 1 };
      fs.writeFileSync(f.guardClaimAuthority.roleStatePath, JSON.stringify(state), { mode: 0o600 });
    }],
    ['UCI identity', (f) => {
      const uci = path.join(f.dir, 'etc/config/osi-server');
      fs.mkdirSync(path.dirname(uci), { recursive: true, mode: 0o700 });
      fs.writeFileSync(uci, "config cloud 'cloud'\n\toption device_eui 'AABBCCDDEEFF0011'\n", { mode: 0o600 });
    }],
  ];
  for (const [label, mutate] of cases) {
    const f = guardOpsFixture();
    const head = buildGuardChain(f, 'ready');
    mutate(f);
    const result = cliClaim(f, { gen: head.generation, sha: head.sha256 });
    assert.notEqual(result.status, 0, `${label} must reject`);
    assert.equal(headOf(f).entry.phase, 'ready', `${label} must not publish a claim`);
  }
});

test('G3 claim crash: killed between claim write and claimed append - retry finishes only on byte cross-match', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  const crashed = cliClaim(f, { gen: head.generation, sha: head.sha256, env: { OSI_DEPLOY_STATE_CRASH_AT: 'claim:after-parent-fsync' } });
  assert.equal(crashed.status, 137);
  assert.ok(fs.existsSync(claimPathOf(f)), 'claim file must be durable');
  assert.equal(headOf(f).entry.phase, 'ready', 'claimed append must not have happened');
  const originalBytes = fs.readFileSync(claimPathOf(f));
  const retry = cliClaim(f, { gen: head.generation, sha: head.sha256 });
  assert.equal(retry.status, 0, retry.stderr);
  const newHead = headOf(f);
  assert.equal(newHead.entry.phase, 'claimed');
  assert.equal(newHead.entry.facts.claimSha256, lib.sha256Hex(originalBytes), 'claimed must bind the ORIGINAL claim bytes');
});

test('G3 claim crash: a tampered claim file is a conflict, never a resume', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  const crashed = cliClaim(f, { gen: head.generation, sha: head.sha256, env: { OSI_DEPLOY_STATE_CRASH_AT: 'claim:after-parent-fsync' } });
  assert.equal(crashed.status, 137);
  const claim = JSON.parse(fs.readFileSync(claimPathOf(f), 'utf8'));
  claim.artifactSha256 = 'f'.repeat(64);
  fs.writeFileSync(claimPathOf(f), JSON.stringify(claim, null, 2), { mode: 0o600 });
  const retry = cliClaim(f, { gen: head.generation, sha: head.sha256 });
  assert.notEqual(retry.status, 0);
  assert.equal(JSON.parse(retry.stderr).code, 'claim-mismatch');
  assert.equal(headOf(f).entry.phase, 'ready', 'chain must not advance on a mismatched claim');
});

test('G3 claim crash: killed after the claimed append - retry is an idempotent resume', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  const crashed = cliClaim(f, { gen: head.generation, sha: head.sha256, env: { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:claimed:after-dir-fsync' } });
  assert.equal(crashed.status, 137);
  assert.equal(headOf(f).entry.phase, 'claimed');
  const retry = cliClaim(f, { gen: head.generation, sha: head.sha256 });
  assert.equal(retry.status, 0, retry.stderr);
  const out = JSON.parse(retry.stdout);
  assert.equal(out.resumed, true);
  assert.equal(headOf(f).generation, 11, 'no double append');
});

test('G3 claim RACE: two concurrent claim-attempts - exactly one claim file, exactly one claimed append', async () => {
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const f = guardOpsFixture();
    const head = buildGuardChain(f, 'ready');
    const authority = f.guardClaimAuthority;
    const args = [
      'claim-attempt', '--attempts', f.attempts, '--guard-bootstrap-root', f.root,
      '--guard-marker', authority.markerPath,
      '--deployment-id', 'dep-g-1',
      '--expected-guard-generation', String(head.generation),
      '--expected-guard-generation-sha256', head.sha256,
      '--expected-marker-sha256', authority.markerSha256,
      '--controller-generation', '1',
      '--target-commit', 'a'.repeat(40),
      '--control-manifest-sha256', 'c'.repeat(64),
      '--artifact-sha256', 'b'.repeat(64),
    ];
    const roleEnv = {
      OSI_DEPLOY_TEST_ROLE_STATE: authority.roleStatePath,
      OSI_DEPLOY_STARTUP_TEST_MOUNTINFO: path.join(f.dir, 'mountinfo.test'),
    };
    const [ra, rb] = await Promise.all([
      runCliAsync(args, withBoot(GB1, roleEnv)), runCliAsync(args, withBoot(GB1, roleEnv)),
    ]);
    for (const r of [ra, rb]) {
      if (r.status !== 0) {
        const code = JSON.parse(r.stderr).code;
        assert.ok(['state-busy'].includes(code), `iteration ${i}: bounded loser, got ${code}`);
      }
    }
    assert.ok([ra, rb].some((r) => r.status === 0), `iteration ${i}: at least one must succeed`);
    const chain = lib.readGuardChain(f.root, 'dep-g-1');
    const claimedEntries = chain.entries.filter((e) => e.entry.phase === 'claimed');
    assert.equal(claimedEntries.length, 1, `iteration ${i}: exactly one claimed append`);
    assert.equal(claimedEntries[0].entry.facts.claimSha256, lib.sha256Hex(fs.readFileSync(claimPathOf(f))));
  }
});

test('G3 RACE: arm and abandon serialize on one authority - never armed and abandoned', async () => {
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const f = guardOpsFixture();
    const identity = armIdentity({ deploymentId: 'dep-g-1' });
    prepareArmClaim(f, identity);
    const claimedHead = headOf(f);
    const topologySha256 = lib.readGuardChain(f.root, 'dep-g-1').entries
      .find((entry) => entry.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256;
    const identityPath = writeJsonFile(path.join(f.dir, `arm-abandon-${i}.json`), identity);
    const proofPath = writeSyntheticTopologyRestorationProof(f, {
      deploymentId: 'dep-g-1', topologyManifestSha256: topologySha256,
      suffix: `arm-abandon-${i}`,
    });
    const armArgs = [
      'arm', '--state', path.join(f.dir, 'deployment-state.json'),
      '--receipts', f.receipts, '--attempts', f.attempts,
      '--expected-attempt-sha256', lib.canonicalHash(identity), '--identity', identityPath,
    ];
    const abandonArgs = [
      'abandon-guard-bootstrap', '--guard-bootstrap-root', f.root,
      '--attempts', f.attempts, '--receipts', f.receipts,
      '--deployment-id', 'dep-g-1',
      '--expected-guard-generation', String(claimedHead.generation),
      '--expected-guard-generation-sha256', claimedHead.sha256,
      '--expected-topology-manifest-sha256', topologySha256,
      '--staging', path.join(f.staging, 'dep-g-1'),
      '--topology-restoration-proof', proofPath,
    ];

    const [armed, abandoned] = await Promise.all([
      runCliAsync(armArgs, withBoot(GB1)),
      runCliAsync(abandonArgs, withBoot(GB1)),
    ]);
    for (const result of [armed, abandoned]) {
      if (result.status !== 0) {
        assert.ok(
          ['state-busy', 'armed-parent', 'claim-mismatch', 'cas-mismatch'].includes(parseStderrCode(result)),
          `iteration ${i}: bounded loser, got ${parseStderrCode(result)}`
        );
      }
    }
    const state = lib.readState(path.join(f.dir, 'deployment-state.json'));
    const chainPhase = headOf(f).entry.phase;
    assert.equal(
      Boolean(state && state.parentDeployment.phase === 'armed' && chainPhase === 'abandoned'),
      false,
      `iteration ${i}: contradictory authorities published (arm=${armed.status}, abandon=${abandoned.status})`
    );
  }
});

test('G3 abandon: pre-mutation abandon binds no-mutation proof and both receipts', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const res = cliAbandon(f, { gen: head.generation, sha: head.sha256, topologySha: GUARD_ZERO64 });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.phase, 'abandoned');
  assert.equal(out.mutationOccurred, false);
  const chain = lib.readGuardChain(f.root, 'dep-g-1');
  const abandoning = chain.entries.find((e) => e.entry.phase === 'abandoning');
  assert.deepEqual(abandoning.entry.facts, {
    mutationOccurred: false, headPhaseAtAbandon: 'epoch-start', headGenerationAtAbandon: head.generation,
    unchangedRoleAuthoritySha256: lib.canonicalHash(guardIntentFacts().priorRoleStates),
  });
  const ta = lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation');
  assert.equal(ta.content.authorityKind, 'guard-bootstrap');
  assert.equal(ta.content.topologyOutcome, 'unmutated');
  assert.equal(ta.content.sixLinkTopologySha256, GUARD_ZERO64);
  assert.equal(ta.content.inhibitorSha256, GUARD_ZERO64);
  assert.deepEqual(ta.content.guardAware94, { state: 'never-installed' });
  const ab = lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment');
  assert.equal(ab.content.mutationOccurred, false);
  assert.equal(ab.content.claimConsumed, false);
  assert.equal(ab.content.topologyActivationReceiptSha256, ta.sha256);
  const abandoned = chain.head;
  assert.equal(abandoned.entry.phase, 'abandoned');
  assert.deepEqual(abandoned.entry.facts, {
    topologyActivationReceiptSha256: ta.sha256,
    abandonmentReceiptSha256: ab.sha256,
  });
});

test('G3 abandon: untouched running-but-unready role authority is preserved exactly', () => {
  const f = guardOpsFixture();
  const priorRoleStates = structuredClone(guardIntentFacts().priorRoleStates);
  priorRoleStates['node-red'].ready = false;
  const head = cliBegin(f, { identityOverrides: { priorRoleStates } });
  const roleStatePath = priorRoleStateFile(f, { priorRoleStates });
  const result = cliAbandon(f, {
    gen: head.generation, sha: head.headSha256, topologySha: GUARD_ZERO64,
    env: { OSI_DEPLOY_TEST_ROLE_STATE: roleStatePath },
  });
  assert.equal(result.status, 0, result.stderr);
  const abandoning = lib.readGuardChain(f.root, 'dep-g-1').entries
    .find((entry) => entry.entry.phase === 'abandoning');
  assert.equal(abandoning.entry.facts.unchangedRoleAuthoritySha256,
    lib.canonicalHash(priorRoleStates));
});

test('G3 abandon: epoch-start requires fresh exact untouched role and rc-topology evidence', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const drifted = priorRoleStateFile(f, { mutate: (state) => {
    state.roles['node-red'].pid += 1;
  } });
  const failed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256, topologySha: GUARD_ZERO64,
    env: { OSI_DEPLOY_TEST_ROLE_STATE: drifted },
  });
  assert.equal(JSON.parse(failed.stderr).code, 'role-restoration-required');
  assert.equal(headOf(f).entry.phase, 'epoch-start');
  assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment'), null);
});

test('G3 abandon: crash after durable roles-stopping can never claim the deployment was unmutated', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'roles-stopping');
  const failed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256, topologySha: GUARD_ZERO64,
  });
  assert.equal(JSON.parse(failed.stderr).code, 'role-restoration-required');
  assert.equal(headOf(f).entry.phase, 'roles-stopping');
  assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation'), null);
});

test('G3 abandon: unresolved mutation authority survives epoch invalidation and a new epoch-start', () => {
  const f = guardOpsFixture();
  const B2 = 'guard-boot-0002';
  let head = buildGuardChain(f, 'safety-installing');
  const topologySha = lib.readGuardChain(f.root, 'dep-g-1').entries
    .find((entry) => entry.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256;
  let result = cliAdvance(f, {
    bootId: B2, expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'safety-installing', phase: 'epoch-invalidated',
    factsPath: writeJsonFile(path.join(f.dir, 'review11-epoch-invalidated.json'), {
      invalidatedEpoch: 1, previousBootId: GB1,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  let out = JSON.parse(result.stdout);
  result = cliAdvance(f, {
    bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
    expectedPhase: 'epoch-invalidated', phase: 'epoch-start',
    factsPath: factsFileFor(f, 'epoch-start', B2),
  });
  assert.equal(result.status, 0, result.stderr);
  out = JSON.parse(result.stdout);
  head = headOf(f);
  const withoutProof = runCli([
    'abandon-guard-bootstrap', '--guard-bootstrap-root', f.root,
    '--attempts', f.attempts, '--receipts', f.receipts, '--deployment-id', 'dep-g-1',
    '--expected-guard-generation', String(head.generation),
    '--expected-guard-generation-sha256', head.sha256,
    '--expected-topology-manifest-sha256', topologySha,
    '--staging', path.join(f.staging, 'dep-g-1'),
  ], withBoot(B2));
  assert.equal(JSON.parse(withoutProof.stderr).code, 'proof-missing');
  const restored = cliAbandon(f, {
    bootId: B2, gen: head.generation, sha: head.sha256, topologySha,
  });
  assert.equal(restored.status, 0, restored.stderr);
  const abandoning = lib.readGuardChain(f.root, 'dep-g-1').entries
    .find((entry) => entry.entry.phase === 'abandoning');
  assert.equal(abandoning.entry.facts.mutationOccurred, true);
  assert.ok(abandoning.entry.facts.lastMutationGeneration < head.generation,
    'the carried mutation evidence must name the prior epoch');
});

test('G3 abandon: reboot before mutation may abandon only from fresh exact new-epoch role evidence', () => {
  const f = guardOpsFixture();
  const B2 = 'guard-boot-0002';
  let head = buildGuardChain(f, 'epoch-start');
  let result = cliAdvance(f, {
    bootId: B2, expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'epoch-start', phase: 'epoch-invalidated',
    factsPath: writeJsonFile(path.join(f.dir, 'review12-no-mutation-invalidated.json'), {
      invalidatedEpoch: 1, previousBootId: GB1,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  let out = JSON.parse(result.stdout);

  const beforeFreshEpoch = cliAbandon(f, {
    bootId: B2, gen: out.generation, sha: out.headSha256, topologySha: GUARD_ZERO64,
    env: { OSI_DEPLOY_TEST_ROLE_STATE: priorRoleStateFile(f, { bootId: B2 }) },
  });
  assert.equal(JSON.parse(beforeFreshEpoch.stderr).code, 'role-restoration-required');

  result = cliAdvance(f, {
    bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
    expectedPhase: 'epoch-invalidated', phase: 'epoch-start',
    factsPath: factsFileFor(f, 'epoch-start', B2),
  });
  assert.equal(result.status, 0, result.stderr);
  out = JSON.parse(result.stdout);
  const abandoned = cliAbandon(f, {
    bootId: B2, gen: out.generation, sha: out.headSha256, topologySha: GUARD_ZERO64,
    env: { OSI_DEPLOY_TEST_ROLE_STATE: priorRoleStateFile(f, { bootId: B2 }) },
  });
  assert.equal(abandoned.status, 0, abandoned.stderr);
  const abandoning = lib.readGuardChain(f.root, 'dep-g-1').entries
    .find((entry) => entry.entry.phase === 'abandoning');
  assert.equal(abandoning.entry.facts.unchangedRoleAuthoritySha256,
    lib.canonicalHash(guardEpochRoleStates(B2)));
});

test('G3 abandon: later-epoch topology snapshots cannot rebind the first unresolved mutation authority', () => {
  const f = guardOpsFixture();
  const B2 = 'guard-boot-0002';
  let head = buildGuardChain(f, 'safety-installing');
  const firstSnapshot = lib.readGuardChain(f.root, 'dep-g-1').entries
    .find((entry) => entry.entry.phase === 'topology-snapshotted');
  let result = cliAdvance(f, {
    bootId: B2, expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'safety-installing', phase: 'epoch-invalidated',
    factsPath: writeJsonFile(path.join(f.dir, 'review12-snapshot-invalidated.json'), {
      invalidatedEpoch: 1, previousBootId: GB1,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  let out = JSON.parse(result.stdout);
  for (const phase of ['epoch-start', 'roles-stopping', 'roles-stopped']) {
    result = cliAdvance(f, {
      bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
      expectedPhase: out.phase, phase, factsPath: factsFileFor(f, phase, B2),
    });
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    out = JSON.parse(result.stdout);
  }
  const laterManifestPath = path.join(f.dir, 'topology-manifest-epoch-2.json');
  fs.writeFileSync(laterManifestPath, JSON.stringify({ links: [], epoch: 2 }), { mode: 0o600 });
  const laterSnapshotFacts = guardTopologyFacts(f, B2, {
    topologyManifestPath: laterManifestPath,
    topologyManifestSha256: lib.sha256Hex(fs.readFileSync(laterManifestPath)),
  });
  result = cliAdvance(f, {
    bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
    expectedPhase: 'roles-stopped', phase: 'topology-snapshotted',
    factsPath: writeJsonFile(path.join(f.dir, 'review12-later-snapshot.json'), laterSnapshotFacts),
  });
  assert.equal(result.status, 0, result.stderr);
  out = JSON.parse(result.stdout);

  const laterProof = writeSyntheticTopologyRestorationProof(f, {
    topologyManifestSha256: laterSnapshotFacts.topologyManifestSha256,
    suffix: 'review12-later-snapshot',
  });
  const rebound = cliAbandon(f, {
    bootId: B2, gen: out.generation, sha: out.headSha256,
    topologySha: laterSnapshotFacts.topologyManifestSha256, proofPath: laterProof,
  });
  assert.equal(JSON.parse(rebound.stderr).code, 'manifest-mismatch');

  const firstProof = writeSyntheticTopologyRestorationProof(f, {
    topologyManifestSha256: firstSnapshot.entry.facts.topologyManifestSha256,
    suffix: 'review12-first-snapshot',
  });
  const restored = cliAbandon(f, {
    bootId: B2, gen: out.generation, sha: out.headSha256,
    topologySha: firstSnapshot.entry.facts.topologyManifestSha256, proofPath: firstProof,
  });
  assert.equal(restored.status, 0, restored.stderr);
  const abandoning = lib.readGuardChain(f.root, 'dep-g-1').entries
    .find((entry) => entry.entry.phase === 'abandoning');
  assert.equal(abandoning.entry.facts.topologySnapshotSha256,
    firstSnapshot.entry.facts.topologyManifestSha256);
});

test('G3 abandon: a later epoch snapshot cannot replace a missing snapshot from the first mutation epoch', () => {
  const f = guardOpsFixture();
  const B2 = 'guard-boot-0002';
  let head = buildGuardChain(f, 'roles-stopping');
  let result = cliAdvance(f, {
    bootId: B2, expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'roles-stopping', phase: 'epoch-invalidated',
    factsPath: writeJsonFile(path.join(f.dir, 'review12-pre-snapshot-invalidated.json'), {
      invalidatedEpoch: 1, previousBootId: GB1,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  let out = JSON.parse(result.stdout);
  for (const phase of ['epoch-start', 'roles-stopping', 'roles-stopped', 'topology-snapshotted']) {
    result = cliAdvance(f, {
      bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
      expectedPhase: out.phase, phase, factsPath: factsFileFor(f, phase, B2),
    });
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    out = JSON.parse(result.stdout);
  }
  const failed = cliAbandon(f, {
    bootId: B2, gen: out.generation, sha: out.headSha256, topologySha: GUARD_ZERO64,
  });
  assert.equal(JSON.parse(failed.stderr).code, 'role-restoration-required');
  assert.equal(headOf(f).entry.phase, 'topology-snapshotted');
});

test('G3 abandon: roles-stopped cannot claim an unmutated terminal without restoring prior role readiness and topology', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'roles-stopped');
  const res = cliAbandon(f, { gen: head.generation, sha: head.sha256 });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'role-restoration-required');
  assert.equal(headOf(f).entry.phase, 'roles-stopped');
  assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment'), null);
});

test('G3 abandon: post-mutation abandon binds the topology snapshot/restore target and last mutation generation', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'controls-installed');
  const chainBefore = lib.readGuardChain(f.root, 'dep-g-1');
  const topoSha = chainBefore.entries.find((e) => e.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256;
  const res = cliAbandon(f, { gen: head.generation, sha: head.sha256, topologySha: topoSha });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.mutationOccurred, true);
  const chain = lib.readGuardChain(f.root, 'dep-g-1');
  const abandoning = chain.entries.find((e) => e.entry.phase === 'abandoning');
  assert.deepEqual(abandoning.entry.facts, {
    mutationOccurred: true,
    topologySnapshotSha256: topoSha,
    restoreTargetSha256: topoSha,
    lastMutationGeneration: head.generation, // controls-installed is the last mutation phase
    topologyRestorationProofSha256: lib.sha256Hex(fs.readFileSync(
      writeSyntheticTopologyRestorationProof(f, {
        deploymentId: 'dep-g-1', topologyManifestSha256: topoSha, suffix: 'dep-g-1-abandon',
      })
    )),
    compatibilityManifestSha256: '91'.repeat(32),
  });
  const ta = lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation');
  assert.equal(ta.content.topologyOutcome, 'restored');
  assert.equal(ta.content.sixLinkTopologySha256, GUARD_SIXLINK_SHA);
  assert.equal(ta.content.inhibitorSha256, GUARD_INHIBITOR);
  assert.deepEqual(ta.content.guardAware94, { state: 'present', sha256: GUARD_94 });
});

test('G3 abandon: wrong expected topology manifest sha fails bounded', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'controls-installed');
  const res = cliAbandon(f, { gen: head.generation, sha: head.sha256, topologySha: GUARD_ZERO64 });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'manifest-mismatch');
});

test('G3 abandon: from claimed only while no parent state is armed', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  const claim = cliClaim(f, { gen: head.generation, sha: head.sha256 });
  assert.equal(claim.status, 0);
  const claimedHead = headOf(f);
  const chainBefore = lib.readGuardChain(f.root, 'dep-g-1');
  const topoSha = chainBefore.entries.find((e) => e.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256;
  // Simulate an armed parent: the attempt tombstone for this deployment.
  lib.writeAttemptTombstone(f.attempts, 'dep-g-1', {
    deploymentId: 'dep-g-1', identitySha256: 'a'.repeat(64),
    targetCommitSha: 'a'.repeat(40), controllerGeneration: 1,
    claimSha256: lib.sha256Hex(fs.readFileSync(claimPathOf(f))),
    claimPath: claimPathOf(f),
    createdAt: '2026-07-18T00:00:00.000Z',
  });
  let res = cliAbandon(f, { gen: claimedHead.generation, sha: claimedHead.sha256, topologySha: topoSha });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'armed-parent');
  // Without the tombstone the abandon proceeds and the claim survives
  // (the receipt, not staging absence, consumes it).
  fs.rmSync(lib.attemptTombstonePath(f.attempts, 'dep-g-1'));
  res = cliAbandon(f, { gen: claimedHead.generation, sha: claimedHead.sha256, topologySha: topoSha });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(claimPathOf(f)), 'the claim file must NOT be deleted');
  const ab = lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment');
  assert.equal(ab.content.claimConsumed, true, 'the abandonment receipt consumes the claim');
  assert.equal(headOf(f).entry.phase, 'abandoned');
});

test('G3 abandon: staging path must end with the deployment id', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'roles-stopped');
  const res = cliAbandon(f, { gen: head.generation, sha: head.sha256, staging: path.join(f.staging, 'other-id') });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'shape');
});

test('G3 abandon crash: killed after the abandoning append - resume completes receipts and abandoned', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const crashed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256,
    env: { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:abandoning:after-dir-fsync' },
  });
  assert.equal(crashed.status, 137);
  const abandoningHead = headOf(f);
  assert.equal(abandoningHead.entry.phase, 'abandoning');
  assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation'), null, 'no receipt yet');
  // Resume: the caller passes the abandoning head it observed via status.
  const retry = cliAbandon(f, { gen: abandoningHead.generation, sha: abandoningHead.sha256 });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(headOf(f).entry.phase, 'abandoned');
  assert.ok(lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation'));
  assert.ok(lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment'));
});

test('G3 abandon crash: killed between the two receipts - resume completes without duplicating', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const crashed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256,
    env: { OSI_DEPLOY_STATE_CRASH_AT: 'receipt:topology-activation:after-parent-fsync' },
  });
  assert.equal(crashed.status, 137);
  const ta1 = lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation');
  assert.ok(ta1, 'topology-activation receipt must be durable');
  assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment'), null);
  const abandoningHead = headOf(f);
  const retry = cliAbandon(f, { gen: abandoningHead.generation, sha: abandoningHead.sha256 });
  assert.equal(retry.status, 0, retry.stderr);
  const ta2 = lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation');
  assert.equal(ta2.sha256, ta1.sha256, 'the receipt must be reused, not rewritten');
  assert.equal(headOf(f).entry.phase, 'abandoned');
});

test('G3 abandon crash: killed after the abandonment receipt - resume appends abandoned only', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const crashed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256,
    env: { OSI_DEPLOY_STATE_CRASH_AT: 'receipt:abandonment:after-parent-fsync' },
  });
  assert.equal(crashed.status, 137);
  assert.ok(lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment'));
  assert.equal(headOf(f).entry.phase, 'abandoning');
  const abandoningHead = headOf(f);
  const retry = cliAbandon(f, { gen: abandoningHead.generation, sha: abandoningHead.sha256 });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(headOf(f).entry.phase, 'abandoned');
});

test('G3 abandon: stale restoration proof cannot publish either receipt or the terminal append', () => {
  const boundaries = [
    ['guard-append:abandoning:after-dir-fsync', 'topology-activation'],
    ['receipt:topology-activation:after-parent-fsync', 'abandonment'],
    ['receipt:abandonment:after-parent-fsync', 'abandoned'],
  ];
  for (const [crashAt, blockedPublication] of boundaries) {
    const f = guardOpsFixture();
    const initial = buildGuardChain(f, 'controls-installed');
    const topologySha = lib.readGuardChain(f.root, 'dep-g-1').entries
      .find((entry) => entry.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256;
    const crashed = cliAbandon(f, {
      gen: initial.generation, sha: initial.sha256, topologySha,
      env: { OSI_DEPLOY_STATE_CRASH_AT: crashAt },
    });
    assert.equal(crashed.status, 137, crashAt);
    const staleLink = path.join(f.dir, 'etc/rc.d/S99node-red');
    fs.symlinkSync('../init.d/node-red', staleLink);
    const resumeHead = headOf(f);
    const resumed = cliAbandon(f, {
      gen: resumeHead.generation, sha: resumeHead.sha256, topologySha,
    });
    assert.notEqual(resumed.status, 0, `${blockedPublication} must reject stale proof`);
    assert.equal(JSON.parse(resumed.stderr).code, 'current-control-mismatch');
    if (blockedPublication === 'topology-activation') {
      assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation'), null);
    } else if (blockedPublication === 'abandonment') {
      assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'abandonment'), null);
    } else {
      assert.equal(headOf(f).entry.phase, 'abandoning');
    }
  }
});

test('G3 abandon crash: killed after the abandoned append - retry is an idempotent resume', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const crashed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256,
    env: { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:abandoned:after-dir-fsync' },
  });
  assert.equal(crashed.status, 137);
  const abandonedHead = headOf(f);
  assert.equal(abandonedHead.entry.phase, 'abandoned');
  const retry = cliAbandon(f, { gen: abandonedHead.generation, sha: abandonedHead.sha256 });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).resumed, true);
  assert.equal(headOf(f).generation, abandonedHead.generation, 'no double append');
});

test('G3 abandon: an abandoned chain is terminal - a new deployment may begin', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const res = cliAbandon(f, { gen: head.generation, sha: head.sha256 });
  assert.equal(res.status, 0, res.stderr);
  const out = cliBegin(f, { deploymentId: 'dep-g-2' });
  assert.equal(out.ok, true);
  assert.equal(out.generation, 1);
});

test('G3 receipts: abandonment is now writable with per-kind validation; junk content still rejected', () => {
  const dir = tmpDir();
  assert.throws(
    () => lib.writeReceipt(path.join(dir, 'receipts'), 'op-1', 'abandonment', { anything: true }),
    (err) => err.code === 'missing-field' || err.code === 'unknown-field'
  );
});

test('G3 receipts: guard-bootstrap topology-activation variant requires its richer bound fields', () => {
  const dir = tmpDir();
  const missingBoundField = validTopologyActivationContent({ operationId: 'rec-gb' });
  delete missingBoundField.guardGenerationSha256;
  assert.throws(
    () => lib.writeReceipt(
      path.join(dir, 'receipts'), 'rec-gb', 'topology-activation',
      missingBoundField
    ),
    (err) => err.code === 'unknown-field' || err.code === 'missing-field'
  );
  // A well-formed guard variant writes fine.
  lib.writeReceipt(path.join(dir, 'receipts'), 'rec-gb', 'topology-activation', {
    format: 1,
    receiptKind: 'topology-activation',
    authorityKind: 'guard-bootstrap',
    operationId: 'rec-gb',
    deploymentId: 'dep-gb',
    topologyOutcome: 'restored',
    guardGeneration: 4,
    guardGenerationSha256: 'a'.repeat(64),
    sixLinkTopologySha256: 'b'.repeat(64),
    guardAware94: { state: 'present', sha256: 'c'.repeat(64) },
    inhibitorSha256: 'd'.repeat(64),
    topologyRestorationProofPath: '/data/osi-deploy/backups/dep-gb/topology-restoration-proof.json',
    topologyRestorationProofSha256: 'e'.repeat(64),
    compatibilityManifestSha256: 'f'.repeat(64),
    createdAt: '2026-07-18T00:00:00.000Z',
  });
  // Outcome/sentinel coupling: unmutated requires sentinels + never-installed.
  assert.throws(
    () => lib.writeReceipt(path.join(dir, 'receipts'), 'rec-gb2', 'topology-activation', {
      format: 1,
      receiptKind: 'topology-activation',
      authorityKind: 'guard-bootstrap',
      operationId: 'rec-gb2',
      deploymentId: 'dep-gb',
      topologyOutcome: 'unmutated',
      guardGeneration: 4,
      guardGenerationSha256: 'a'.repeat(64),
      sixLinkTopologySha256: 'b'.repeat(64),
      guardAware94: { state: 'never-installed' },
      inhibitorSha256: GUARD_ZERO64,
      topologyRestorationProofPath: '',
      topologyRestorationProofSha256: GUARD_ZERO64,
      compatibilityManifestSha256: GUARD_ZERO64,
      createdAt: '2026-07-18T00:00:00.000Z',
    }),
    (err) => err.code === 'shape'
  );
});

test('G3 receipts: consumed guard-aware 94 identity has an exact codec shape but grants no authorization by itself', () => {
  const dir = tmpDir();
  const receipts = path.join(dir, 'receipts');
  const content = (operationId, guardAware94) => ({
    format: 1,
    receiptKind: 'topology-activation',
    authorityKind: 'guard-bootstrap',
    operationId,
    deploymentId: 'dep-gb',
    topologyOutcome: 'restored',
    guardGeneration: 4,
    guardGenerationSha256: 'a'.repeat(64),
    sixLinkTopologySha256: 'b'.repeat(64),
    guardAware94,
    inhibitorSha256: 'd'.repeat(64),
    topologyRestorationProofPath: '/data/osi-deploy/backups/dep-gb/topology-restoration-proof.json',
    topologyRestorationProofSha256: 'e'.repeat(64),
    compatibilityManifestSha256: 'f'.repeat(64),
    createdAt: '2026-07-18T00:00:00.000Z',
  });

  lib.writeReceipt(receipts, 'rec-consumed-valid', 'topology-activation', content(
    'rec-consumed-valid',
    { state: 'absent', consumptionReceiptSha256: 'c'.repeat(64) }
  ));
  assert.throws(
    () => lib.writeReceipt(receipts, 'rec-consumed-missing', 'topology-activation', content(
      'rec-consumed-missing',
      { state: 'absent' }
    )),
    (err) => err.code === 'missing-field'
  );
  assert.throws(
    () => lib.writeReceipt(receipts, 'rec-consumed-malformed', 'topology-activation', content(
      'rec-consumed-malformed',
      { state: 'absent', consumptionReceiptSha256: 'not-a-sha256' }
    )),
    (err) => err.code === 'shape'
  );
  assert.throws(
    () => lib.writeReceipt(receipts, 'rec-consumed-extra', 'topology-activation', content(
      'rec-consumed-extra',
      { state: 'absent', consumptionReceiptSha256: 'c'.repeat(64), extra: true }
    )),
    (err) => err.code === 'unknown-field'
  );
});

// ===========================================================================
// Section G4: authorize-topology-activation.
// Argv form pinned verbatim from the plan CLI block (line 185).
// ===========================================================================

function cliAuthorize(f, {
  operationId = 'dep-g-1', expectedPhase = 'abandoning',
  sixLink = GUARD_SIXLINK_SHA, inhibitor = GUARD_INHIBITOR,
  guard94 = { state: 'present', sha256: GUARD_94 },
  statePath, env = {}, proofPath,
} = {}) {
  const g94Path = writeJsonFile(path.join(f.dir, `g94-${cryptoTest.randomBytes(3).toString('hex')}.json`), guard94);
  fs.chmodSync(g94Path, 0o600);
  const chain = lib.readGuardChain(f.root, 'dep-g-1');
  const snapshot = [...chain.entries].reverse().find((entry) => entry.entry.phase === 'topology-snapshotted');
  const selectedProof = proofPath || writeSyntheticTopologyRestorationProof(f, {
    deploymentId: 'dep-g-1', topologyManifestSha256: snapshot
      ? snapshot.entry.facts.topologyManifestSha256 : GUARD_ZERO64,
    sixLinkTopologySha256: sixLink,
    suffix: expectedPhase === 'abandoning' ? 'dep-g-1-abandon' : operationId,
  });
  return runCli([
    'authorize-topology-activation',
    '--state', statePath || path.join(f.dir, 'deployment-state.json'),
    '--guard-bootstrap-root', f.root,
    '--receipts', f.receipts,
    '--operation-id', operationId,
    '--expected-phase', expectedPhase,
    '--expected-six-link-topology-sha256', sixLink,
    '--guard-aware-uci-default', g94Path,
    '--inhibitor-sha256', inhibitor,
    '--topology-restoration-proof', selectedProof,
  ], withBoot(GB1, env));
}

// Builds a mutated chain crash-stopped at `abandoning` (the exact state
// the deploy-side executor authorizes topology restoration in).
function abandoningFixture() {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'controls-installed');
  const chain = lib.readGuardChain(f.root, 'dep-g-1');
  const topoSha = chain.entries.find((e) => e.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256;
  const crashed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256, topologySha: topoSha,
    env: { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:abandoning:after-dir-fsync' },
  });
  assert.equal(crashed.status, 137);
  const abandoningHead = headOf(f);
  assert.equal(abandoningHead.entry.phase, 'abandoning');
  return { f, abandoningHead, topoSha };
}

test('G4 authorize: positive at abandoning writes the guard-bootstrap receipt and abandon resume reuses it', () => {
  const { f, abandoningHead } = abandoningFixture();
  const res = cliAuthorize(f, {});
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.verb, 'authorize-topology-activation');
  const ta = lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation');
  assert.equal(ta.content.authorityKind, 'guard-bootstrap');
  assert.equal(ta.content.topologyOutcome, 'restored');
  assert.equal(ta.content.guardGeneration, abandoningHead.generation);
  assert.equal(ta.content.guardGenerationSha256, abandoningHead.sha256);
  assert.equal(ta.content.sixLinkTopologySha256, GUARD_SIXLINK_SHA);
  assert.equal(ta.content.inhibitorSha256, GUARD_INHIBITOR);
  assert.deepEqual(ta.content.guardAware94, { state: 'present', sha256: GUARD_94 });
  assert.equal(out.topologyActivationReceiptSha256, ta.sha256);
  // The interrupted abandon now resumes and must REUSE this receipt.
  const retry = cliAbandon(f, { gen: abandoningHead.generation, sha: abandoningHead.sha256 });
  assert.equal(retry.status, 0, retry.stderr);
  const after = lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation');
  assert.equal(after.sha256, ta.sha256, 'abandon must reuse the authorized receipt');
  assert.equal(headOf(f).entry.phase, 'abandoned');
});

test('G4 authorize: abandoning consumes the first unresolved snapshot after a later epoch snapshot', () => {
  const f = guardOpsFixture();
  const B2 = 'guard-boot-0002';
  let head = buildGuardChain(f, 'controls-installed');
  const chainBeforeReboot = lib.readGuardChain(f.root, 'dep-g-1');
  const firstSnapshot = chainBeforeReboot.entries
    .find((entry) => entry.entry.phase === 'topology-snapshotted');
  let result = cliAdvance(f, {
    bootId: B2, expectedGeneration: head.generation, expectedSha: head.sha256,
    expectedPhase: 'controls-installed', phase: 'epoch-invalidated',
    factsPath: writeJsonFile(path.join(f.dir, 'review13-epoch-invalidated.json'), {
      invalidatedEpoch: 1, previousBootId: GB1,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  let out = JSON.parse(result.stdout);
  for (const phase of ['epoch-start', 'roles-stopping', 'roles-stopped']) {
    result = cliAdvance(f, {
      bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
      expectedPhase: out.phase, phase, factsPath: factsFileFor(f, phase, B2),
    });
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    out = JSON.parse(result.stdout);
  }
  const laterManifestPath = path.join(f.dir, 'topology-manifest-epoch-2-authorize.json');
  fs.writeFileSync(laterManifestPath, JSON.stringify({ links: [], epoch: 2 }), { mode: 0o600 });
  const laterSnapshotFacts = guardTopologyFacts(f, B2, {
    topologyManifestPath: laterManifestPath,
    topologyManifestSha256: lib.sha256Hex(fs.readFileSync(laterManifestPath)),
  });
  result = cliAdvance(f, {
    bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
    expectedPhase: 'roles-stopped', phase: 'topology-snapshotted',
    factsPath: writeJsonFile(path.join(f.dir, 'review13-later-snapshot.json'), laterSnapshotFacts),
  });
  assert.equal(result.status, 0, result.stderr);
  out = JSON.parse(result.stdout);
  for (const phase of ['safety-installing', 'safety-installed']) {
    result = cliAdvance(f, {
      bootId: B2, expectedGeneration: out.generation, expectedSha: out.headSha256,
      expectedPhase: out.phase, phase, factsPath: factsFileFor(f, phase, B2),
    });
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    out = JSON.parse(result.stdout);
  }

  const firstProof = writeSyntheticTopologyRestorationProof(f, {
    topologyManifestSha256: firstSnapshot.entry.facts.topologyManifestSha256,
    suffix: 'review13-first-snapshot-authorize',
  });
  const laterProof = writeSyntheticTopologyRestorationProof(f, {
    topologyManifestSha256: laterSnapshotFacts.topologyManifestSha256,
    suffix: 'review13-later-snapshot-authorize',
  });
  const abandoned = cliAbandon(f, {
    bootId: B2, gen: out.generation, sha: out.headSha256,
    topologySha: firstSnapshot.entry.facts.topologyManifestSha256, proofPath: firstProof,
    env: { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:abandoning:after-dir-fsync' },
  });
  assert.equal(abandoned.status, 137, abandoned.stderr);

  const wrongEpochProof = cliAuthorize(f, { proofPath: laterProof });
  assert.notEqual(wrongEpochProof.status, 0);
  assert.match(wrongEpochProof.stderr, /proof-mismatch/);
  const authorized = cliAuthorize(f, { proofPath: firstProof });
  assert.equal(authorized.status, 0, authorized.stderr);
  const receipt = lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation');
  assert.equal(receipt.content.topologyRestorationProofPath, firstProof);
  assert.notEqual(receipt.content.topologyRestorationProofPath, laterProof);
});

test('G4 authorize: second call is an idempotent resume with the same receipt hash', () => {
  const { f } = abandoningFixture();
  const first = JSON.parse(cliAuthorize(f, {}).stdout);
  const res = cliAuthorize(f, {});
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.resumed, true);
  assert.equal(out.topologyActivationReceiptSha256, first.topologyActivationReceiptSha256);
});

test('G4 authorize: guard-chain evidence alone cannot authorize without the immutable restoration proof', () => {
  const { f } = abandoningFixture();
  const guard94 = writeJsonFile(path.join(f.dir, 'guard94-chain-only.json'), {
    state: 'present', sha256: GUARD_94,
  });
  const result = runCliFail([
    'authorize-topology-activation', '--state', path.join(f.dir, 'deployment-state.json'),
    '--guard-bootstrap-root', f.root, '--receipts', f.receipts, '--operation-id', 'dep-g-1',
    '--expected-phase', 'abandoning', '--expected-six-link-topology-sha256', GUARD_SIXLINK_SHA,
    '--guard-aware-uci-default', guard94, '--inhibitor-sha256', GUARD_INHIBITOR,
  ], withBoot(GB1));
  assert.equal(result.parsed.code, 'missing-flag');
  assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation'), null);
});

test('G4 authorize: restoration proof drift after abandoning CAS is rejected', () => {
  const { f } = abandoningFixture();
  const proofPath = writeSyntheticTopologyRestorationProof(f, {
    deploymentId: 'dep-g-1',
    topologyManifestSha256: [...lib.readGuardChain(f.root, 'dep-g-1').entries].reverse()
      .find((entry) => entry.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256,
    suffix: 'dep-g-1-abandon',
  });
  const proof = JSON.parse(fs.readFileSync(proofPath));
  proof.restoredMetadataSha256 = 'ff'.repeat(32);
  fs.writeFileSync(proofPath, JSON.stringify(proof), { mode: 0o600 }); fs.chmodSync(proofPath, 0o600);
  const result = cliAuthorize(f, { proofPath });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).code, 'proof-mismatch');
  assert.equal(lib.readReceipt(f.receipts, 'dep-g-1', 'topology-activation'), null);
});

function writeGuardRecoveryState(f, {
  operationId = 'rec-guard-1', phase = 'recovery-started', withPreviousTerminal = false,
} = {}) {
  const statePath = path.join(f.dir, 'deployment-state.json');
  const restoredPredecessor = { kind: 'managed-terminal', deploymentId: 'dep-old', terminalTupleSha256: 'a'.repeat(64) };
  lib.writeState(statePath, {
    format: 2,
    parentDeployment: {
      deploymentId: 'dep-g-1',
      phase: 'verification-in-flight',
      leaseActive: true,
      generation: 4,
      attemptSha256: 'a'.repeat(64),
      targetCommitSha: 'a'.repeat(40),
      controllerGeneration: 1,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      databaseLineage: { status: 'not-applicable' },
      deploymentReceiptSha256: 'b'.repeat(64),
      ...(withPreviousTerminal ? { previousTerminal: {
        deploymentId: 'dep-old', generation: 3, phase: 'completed',
        // Keep the planted predecessor receipt identity consistent with the
        // fixture sub-operation's parentReceiptsSha256 so repeat recovery
        // exercises the valid immutable lineage rather than a malformed
        // hand-crafted state.
        receiptsSha256: 'c'.repeat(64), terminalTupleSha256: 'a'.repeat(64),
      } } : {}),
    },
    activeSubOperation: {
      kind: 'recovery',
      operationId,
      parentDeploymentId: 'dep-g-1',
      parentDeploymentGeneration: 4,
      parentPhaseAtLink: 'verification-in-flight',
      parentReceiptsSha256: 'c'.repeat(64),
      phase,
      restoredPredecessor,
      restoredPredecessorSha256: lib.restoredPredecessorSha256(restoredPredecessor),
      generation: 1,
      createdAt: '2026-07-18T00:00:00.000Z',
    },
  });
  return statePath;
}

test('G4 authorize: positive at recovery-topology-verifying against the claimed parent chain', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  const claim = cliClaim(f, { gen: head.generation, sha: head.sha256 });
  assert.equal(claim.status, 0, claim.stderr);
  // A linked recovery sub-operation in deployment state names this chain
  // as its parent.
  const statePath = writeGuardRecoveryState(f, { phase: 'recovery-topology-verifying' });
  const res = cliAuthorize(f, { operationId: 'rec-guard-1', expectedPhase: 'recovery-topology-verifying', statePath });
  assert.equal(res.status, 0, res.stderr);
  const ta = lib.readReceipt(f.receipts, 'rec-guard-1', 'topology-activation');
  assert.equal(ta.content.authorityKind, 'guard-bootstrap');
  assert.equal(ta.content.deploymentId, 'dep-g-1', 'receipt binds the parent chain');
  assert.equal(ta.content.operationId, 'rec-guard-1');
  const state = lib.readState(statePath);
  assert.equal(state.activeSubOperation.phase, 'recovery-topology-authorized');
  assert.equal(state.activeSubOperation.topologyActivationReceiptSha256, ta.sha256);
});

test('G4 authorize: restoration proof must bind every selected predecessor field exactly', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  assert.equal(cliClaim(f, { gen: head.generation, sha: head.sha256 }).status, 0);
  const statePath = writeGuardRecoveryState(f, { phase: 'recovery-topology-verifying' });
  const snapshot = [...lib.readGuardChain(f.root, 'dep-g-1').entries].reverse()
    .find((entry) => entry.entry.phase === 'topology-snapshotted');
  const proofPath = writeSyntheticTopologyRestorationProof(f, {
    deploymentId: 'dep-g-1', topologyManifestSha256: snapshot.entry.facts.topologyManifestSha256,
    suffix: 'wrong-predecessor',
  });
  const proof = JSON.parse(fs.readFileSync(proofPath));
  proof.restoredPredecessor.deploymentId = 'dep-caller-invented';
  proof.restoredPredecessorSha256 = lib.restoredPredecessorSha256(proof.restoredPredecessor);
  fs.writeFileSync(proofPath, JSON.stringify(proof), { mode: 0o600 });
  fs.chmodSync(proofPath, 0o600);

  const result = cliAuthorize(f, {
    operationId: 'rec-guard-1', expectedPhase: 'recovery-topology-verifying', statePath, proofPath,
  });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).code, 'predecessor-mismatch');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'topology-activation'), null);
  assert.equal(lib.readState(statePath).activeSubOperation.phase, 'recovery-topology-verifying');
});

test('G4 authorize: live six-link drift after proof publication fails before receipt or state CAS', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  assert.equal(cliClaim(f, { gen: head.generation, sha: head.sha256 }).status, 0);
  const statePath = writeGuardRecoveryState(f, { phase: 'recovery-topology-verifying' });
  const snapshot = [...lib.readGuardChain(f.root, 'dep-g-1').entries].reverse()
    .find((entry) => entry.entry.phase === 'topology-snapshotted');
  const proofPath = writeSyntheticTopologyRestorationProof(f, {
    deploymentId: 'dep-g-1', topologyManifestSha256: snapshot.entry.facts.topologyManifestSha256,
    suffix: 'stale-live-topology',
  });
  const linkPath = path.join(f.dir, 'etc/rc.d/S99node-red');
  fs.mkdirSync(path.dirname(linkPath), { recursive: true, mode: 0o700 });
  fs.symlinkSync('../init.d/node-red', linkPath);

  const result = cliAuthorize(f, {
    operationId: 'rec-guard-1', expectedPhase: 'recovery-topology-verifying', statePath, proofPath,
  });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).code, 'current-control-mismatch');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'topology-activation'), null);
  assert.equal(lib.readState(statePath).activeSubOperation.phase, 'recovery-topology-verifying');
});

test('G4 recovery authority: authorize rejects recovery-started until an explicit recovery phase CAS', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  assert.equal(cliClaim(f, { gen: head.generation, sha: head.sha256 }).status, 0);
  const statePath = writeGuardRecoveryState(f);
  const before = cliAuthorize(f, {
    operationId: 'rec-guard-1', expectedPhase: 'recovery-topology-verifying', statePath,
  });
  assert.notEqual(before.status, 0);
  assert.equal(JSON.parse(before.stderr).code, 'cas-mismatch');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'topology-activation'), null);

  const advanced = runCliOk([
    'advance-recovery', '--state', statePath, '--operation-id', 'rec-guard-1',
    '--expected-phase', 'recovery-started', '--phase', 'recovery-topology-verifying',
  ]);
  assert.equal(advanced.phase, 'recovery-topology-verifying');
  const wrongSkip = runCliFail([
    'advance-recovery', '--state', statePath, '--operation-id', 'rec-guard-1',
    '--expected-phase', 'recovery-started', '--phase', 'recovery-topology-authorized',
  ]);
  assert.ok(['cas-mismatch', 'illegal-transition'].includes(wrongSkip.parsed.code));
});

test('G4 recovery authority: recover cannot self-issue topology authority or finish before authorization', () => {
  const f = guardOpsFixture();
  f.lockDir = path.join(f.dir, 'osi-deploy.lock.d');
  f.permits = path.join(f.dir, 'permits');
  const head = buildGuardChain(f, 'ready');
  assert.equal(cliClaim(f, { gen: head.generation, sha: head.sha256 }).status, 0);
  const statePath = writeGuardRecoveryState(f);
  fs.rmSync(f.lockDir, { recursive: true, force: true });
  runCliOk([
    'acquire-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--deployment-id', 'rec-guard-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ], withBoot(GB1));
  const state = lib.readState(statePath);
  const failed = runCliFail([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', state.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  assert.equal(failed.parsed.code, 'cas-mismatch');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'recovery'), null);
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'topology-activation'), null);
});

test('G4 recovery authority: state mutation contention blocks authorization before receipt publication', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  assert.equal(cliClaim(f, { gen: head.generation, sha: head.sha256 }).status, 0);
  const statePath = writeGuardRecoveryState(f, { phase: 'recovery-topology-verifying' });
  plantMutationContender({ state: statePath }, {
    pid: process.pid, bootId: GB1, operationId: 'concurrent-writer',
  });
  const result = cliAuthorize(f, {
    operationId: 'rec-guard-1', expectedPhase: 'recovery-topology-verifying', statePath,
  });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).code, 'state-busy');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'topology-activation'), null);
});

function authorizedGuardRecoveryFixture({ enabledPredecessor = false } = {}) {
  const f = guardOpsFixture();
  f.lockDir = path.join(f.dir, 'osi-deploy.lock.d');
  f.permits = path.join(f.dir, 'permits');
  const head = buildGuardChain(f, 'ready');
  assert.equal(cliClaim(f, { gen: head.generation, sha: head.sha256 }).status, 0);
  const statePath = writeGuardRecoveryState(f, { withPreviousTerminal: true });
  f.state = statePath;
  // Internal fixture only: preserve coverage of downstream recovery codecs
  // without creating a public CLI bypass around Commit 1's deliberately
  // unsatisfiable recovery-health issuance/consumption boundary.
  const planted = lib.readState(statePath);
  planted.activeSubOperation.probePermit = testOnlyRecoveryPermit(f, planted);
  planted.activeSubOperation.generation += 1;
  planted.parentDeployment.generation += 1;
  lib.writeState(statePath, planted);
  runCliOk([
    'advance-recovery', '--state', statePath, '--operation-id', 'rec-guard-1',
    '--expected-phase', 'recovery-started', '--phase', 'recovery-topology-verifying',
  ]);
  let proofPath;
  let restoredSixLinkSha256 = GUARD_SIXLINK_SHA;
  if (enabledPredecessor) {
    for (const link of GUARD_SIX_LINK_TARGETS) {
      const actual = path.join(f.dir, `.${link.path}`);
      fs.mkdirSync(path.dirname(actual), { recursive: true, mode: 0o700 });
      fs.rmSync(actual, { force: true });
      fs.symlinkSync(link.target, actual);
    }
    fs.writeFileSync(path.join(f.dir, 'etc/init.d/node-red'), 'restored predecessor node-red\n', { mode: 0o755 });
    const uci = path.join(f.dir, 'etc/config/osi-server');
    fs.mkdirSync(path.dirname(uci), { recursive: true, mode: 0o700 });
    fs.writeFileSync(uci, "config cloud 'cloud'\n option device_eui 'AABBCCDDEEFF0011'\n", { mode: 0o600 });
    const snapshot = [...lib.readGuardChain(f.root, 'dep-g-1').entries].reverse()
      .find((entry) => entry.entry.phase === 'topology-snapshotted');
    const liveIdentity = lib.liveTopologyIdentity(f.dir);
    restoredSixLinkSha256 = liveIdentity.sixLinkTopologySha256;
    proofPath = writeSyntheticTopologyRestorationProof(f, {
      deploymentId: 'dep-g-1', topologyManifestSha256: snapshot.entry.facts.topologyManifestSha256,
      sixLinkTopologySha256: restoredSixLinkSha256, suffix: 'rec-guard-1-enabled-predecessor',
    });
  }
  const authorized = cliAuthorize(f, {
    operationId: 'rec-guard-1', expectedPhase: 'recovery-topology-verifying', statePath,
    sixLink: restoredSixLinkSha256, proofPath,
  });
  assert.equal(authorized.status, 0, authorized.stderr);
  fs.rmSync(f.lockDir, { recursive: true, force: true });
  runCliOk([
    'acquire-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--deployment-id', 'rec-guard-1', '--target-commit', 'a'.repeat(40), '--controller-generation', '1',
  ], withBoot(GB1));
  return { f, statePath, restoredSixLinkSha256, proofPath };
}

function recoveryEvidenceArgs(f, statePath) {
  const sub = lib.readState(statePath).activeSubOperation;
  const evidenceDir = path.join(f.dir, 'recovery-evidence');
  const health = writeJsonFile(path.join(evidenceDir, 'jailed-health.json'), {
    format: 1, operationId: sub.operationId, parentDeploymentId: sub.parentDeploymentId,
    result: 'healthy', jail: { network: 'denied', database: 'private-copy', credentials: 'private-copy', loopbackHealthOnly: true },
    probePermitSha256: sub.probePermit ? lib.canonicalHash(sub.probePermit) : 'e'.repeat(64),
    processStopped: true, createdAt: '2026-07-19T00:00:00.000Z',
  });
  const audit = writeJsonFile(path.join(evidenceDir, 'post-probe-audit.json'), {
    format: 1, operationId: sub.operationId, parentDeploymentId: sub.parentDeploymentId,
    result: 'clear', boundarySha256: 'a'.repeat(64), appliedCommandCount: 0, ackOutboxCount: 0,
    syncEventCount: 0, createdAt: '2026-07-19T00:00:01.000Z',
  });
  const zero = writeJsonFile(path.join(evidenceDir, 'zero-mutation.json'), {
    format: 1, operationId: sub.operationId, parentDeploymentId: sub.parentDeploymentId,
    result: 'unchanged', processAbsent: true,
    databaseBeforeSha256: 'b'.repeat(64), databaseAfterSha256: 'b'.repeat(64),
    runtimeBeforeSha256: 'c'.repeat(64), runtimeAfterSha256: 'c'.repeat(64),
    guiBeforeSha256: 'd'.repeat(64), guiAfterSha256: 'd'.repeat(64),
    createdAt: '2026-07-19T00:00:02.000Z',
  });
  return ['--jailed-health-result', health, '--post-probe-audit', audit, '--zero-mutation-proof', zero];
}

test('G4 recovery authority: recover requires explicit jailed-health, post-probe audit, and zero-mutation evidence', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const before = lib.readState(statePath);
  const failed = runCliFail([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
  ], withBoot(GB1));
  assert.equal(failed.parsed.code, 'missing-flag');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'recovery'), null);
  assert.equal(lib.readState(statePath).parentDeployment.phase, 'verification-in-flight');
});

test('G4 recovery authority: authorize then recover revalidates claimed evidence and terminal-CASes', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const before = lib.readState(statePath);
  const result = runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  assert.equal(result.phase, 'recovered');
  const after = lib.readState(statePath);
  assert.equal(after.parentDeployment.phase, 'recovered');
  assert.equal(after.activeSubOperation, null);
  assert.equal(after.parentDeployment.topologyActivationReceiptSha256,
    before.activeSubOperation.topologyActivationReceiptSha256);
  assert.equal(after.parentDeployment.recoveryOperationId, 'rec-guard-1');

  f.state = statePath;
  const marker = startupAuthorityFixture(f).markerPath;
  const released = runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--operation-id', 'rec-guard-1', '--expected-final-receipt-sha256', result.recoveryReceiptSha256], withBoot(GB1));
  assert.equal(released.released, true);
  const startup = runCliOk(['startup-check', '--root', f.dir, '--guard-marker', marker,
    '--state', statePath, '--receipts', f.receipts, '--service', 'osi-db-integrity'], withBoot('guard-boot-0002'));
  assert.equal(startup.mode, 'terminal-recovered');
});

test('G4 recovered terminal accepts the exact enabled predecessor topology and healed UCI, not ready quarantine', () => {
  const { f, statePath, restoredSixLinkSha256 } = authorizedGuardRecoveryFixture({ enabledPredecessor: true });
  assert.notEqual(restoredSixLinkSha256, GUARD_SIXLINK_SHA);
  const before = lib.readState(statePath);
  const recovered = runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--operation-id', 'rec-guard-1', '--expected-final-receipt-sha256', recovered.recoveryReceiptSha256], withBoot(GB1));
  const startup = runCliOk(['startup-check', '--root', f.dir,
    '--guard-marker', startupAuthorityFixture(f).markerPath,
    '--state', statePath, '--receipts', f.receipts, '--service', 'osi-db-integrity'], withBoot('guard-boot-0002'));
  assert.equal(startup.mode, 'terminal-recovered');
});

test('G4 recovered terminal completes a second recovery with a fresh handoff and release intent', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const firstActive = lib.readState(statePath).activeSubOperation;
  const firstRecovery = runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', firstActive.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--operation-id', 'rec-guard-1',
    '--expected-final-receipt-sha256', firstRecovery.recoveryReceiptSha256], withBoot(GB1));

  const firstTerminal = lib.readState(statePath).parentDeployment;
  const firstTerminalReceipts = {
    recoveryReceiptSha256: firstTerminal.recoveryReceiptSha256,
    topologyActivationReceiptSha256: firstTerminal.topologyActivationReceiptSha256,
    restoredPredecessor: firstTerminal.restoredPredecessor,
    restoredPredecessorSha256: firstTerminal.restoredPredecessorSha256,
  };
  const receiptsPath = writeJsonFile(path.join(f.dir, 'first-recovered-parent-receipts.json'),
    firstTerminalReceipts);
  const identityPath = writeJsonFile(path.join(f.dir, 'second-recovery-identity.json'),
    firstTerminal.restoredPredecessor);
  runCliOk([
    'begin-recovery', '--state', statePath, '--receipts', f.receipts,
    '--operation-id', 'rec-guard-2', '--parent-deployment-id', 'dep-g-1',
    '--parent-phase', 'recovered', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ], withBoot(GB1));

  const linked = lib.readState(statePath);
  assert.equal(linked.parentDeployment.previousTerminal.phase, 'recovered');
  assert.equal(linked.parentDeployment.lockOwnerHandoff, null);
  assert.equal(linked.parentDeployment.lockRelease, null);
  linked.activeSubOperation.probePermit = testOnlyRecoveryPermit(f, linked);
  linked.activeSubOperation.generation += 1;
  linked.parentDeployment.generation += 1;
  lib.writeState(statePath, linked);
  runCliOk([
    'advance-recovery', '--state', statePath, '--operation-id', 'rec-guard-2',
    '--expected-phase', 'recovery-started', '--phase', 'recovery-topology-verifying',
  ]);
  const authorized = cliAuthorize(f, {
    operationId: 'rec-guard-2', expectedPhase: 'recovery-topology-verifying', statePath,
  });
  assert.equal(authorized.status, 0, authorized.stderr);
  runCliOk([
    'acquire-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--deployment-id', 'rec-guard-2', '--target-commit', 'a'.repeat(40),
    '--controller-generation', '1',
  ], withBoot(GB1));
  const secondActive = lib.readState(statePath).activeSubOperation;
  const secondRecovery = runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-2',
    '--expected-identity-sha256', secondActive.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  const secondTerminal = lib.readState(statePath).parentDeployment;
  assert.equal(secondTerminal.phase, 'recovered');
  assert.equal(secondTerminal.recoveryOperationId, 'rec-guard-2');
  assert.equal(secondTerminal.lockOwnerHandoff.recoveryOperationId, 'rec-guard-2');
  assert.equal(secondTerminal.lockRelease.operationId, 'rec-guard-2');
  assert.equal(secondTerminal.lockRelease.status, 'intent');
  runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--operation-id', 'rec-guard-2',
    '--expected-final-receipt-sha256', secondRecovery.recoveryReceiptSha256], withBoot(GB1));
  assert.equal(lib.readState(statePath).parentDeployment.lockRelease.status, 'released');
  const startup = runCliOk(['startup-check', '--root', f.dir,
    '--guard-marker', startupAuthorityFixture(f).markerPath,
    '--state', statePath, '--receipts', f.receipts,
    '--service', 'osi-db-integrity'], withBoot('guard-boot-0002'));
  assert.equal(startup.mode, 'terminal-recovered');
});

test('G4 begin-recovery: recovered terminal requires both immutable phase-specific receipt files', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const active = lib.readState(statePath).activeSubOperation;
  runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', active.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  const terminal = lib.readState(statePath).parentDeployment;
  fs.rmSync(path.join(f.receipts, 'rec-guard-1.recovery.json'));
  const receiptsPath = writeJsonFile(path.join(f.dir, 'review12-missing-recovery-receipts.json'), {
    recoveryReceiptSha256: terminal.recoveryReceiptSha256,
    topologyActivationReceiptSha256: terminal.topologyActivationReceiptSha256,
    restoredPredecessor: terminal.restoredPredecessor,
    restoredPredecessorSha256: terminal.restoredPredecessorSha256,
  });
  const identityPath = writeJsonFile(path.join(f.dir, 'review12-missing-recovery-identity.json'),
    terminal.restoredPredecessor);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', statePath, '--receipts', f.receipts,
    '--operation-id', 'rec-guard-2', '--parent-deployment-id', 'dep-g-1',
    '--parent-phase', 'recovered', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ], withBoot(GB1));
  assert.match(parsed.code, /receipt/);
  assert.equal(lib.readState(statePath).activeSubOperation, null);
});

test('G4 begin-recovery: recovered receipt files must cross-link one operation, parent, and predecessor lineage', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const active = lib.readState(statePath).activeSubOperation;
  runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', active.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  const topologyPath = path.join(f.receipts, 'rec-guard-1.topology-activation.json');
  const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
  topology.operationId = 'rec-unrelated';
  fs.writeFileSync(topologyPath, JSON.stringify(topology), { mode: 0o600 });
  fs.chmodSync(topologyPath, 0o600);
  const topologySha256 = lib.sha256Hex(fs.readFileSync(topologyPath));
  const state = lib.readState(statePath);
  state.parentDeployment.topologyActivationReceiptSha256 = topologySha256;
  lib.writeState(statePath, state);
  const terminal = lib.readState(statePath).parentDeployment;
  const receiptsPath = writeJsonFile(path.join(f.dir, 'review12-broken-recovery-cross-link.json'), {
    recoveryReceiptSha256: terminal.recoveryReceiptSha256,
    topologyActivationReceiptSha256: topologySha256,
    restoredPredecessor: terminal.restoredPredecessor,
    restoredPredecessorSha256: terminal.restoredPredecessorSha256,
  });
  const identityPath = writeJsonFile(path.join(f.dir, 'review12-broken-recovery-identity.json'),
    terminal.restoredPredecessor);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', statePath, '--receipts', f.receipts,
    '--operation-id', 'rec-guard-2', '--parent-deployment-id', 'dep-g-1',
    '--parent-phase', 'recovered', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'receipt-mismatch');
  assert.equal(lib.readState(statePath).activeSubOperation, null);
});

test('G4 begin-recovery: recovered receipt cannot sever the immutable previous-terminal lineage', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const active = lib.readState(statePath).activeSubOperation;
  runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', active.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  const recoveryPath = path.join(f.receipts, 'rec-guard-1.recovery.json');
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  recovery.parentReceiptsSha256 = 'f'.repeat(64);
  fs.writeFileSync(recoveryPath, JSON.stringify(recovery), { mode: 0o600 });
  fs.chmodSync(recoveryPath, 0o600);
  const state = lib.readState(statePath);
  state.parentDeployment.recoveryReceiptSha256 = lib.sha256Hex(fs.readFileSync(recoveryPath));
  lib.writeState(statePath, state);
  const terminal = lib.readState(statePath).parentDeployment;
  const receiptsPath = writeJsonFile(path.join(f.dir, 'review12-broken-previous-terminal.json'), {
    recoveryReceiptSha256: terminal.recoveryReceiptSha256,
    topologyActivationReceiptSha256: terminal.topologyActivationReceiptSha256,
    restoredPredecessor: terminal.restoredPredecessor,
    restoredPredecessorSha256: terminal.restoredPredecessorSha256,
  });
  const identityPath = writeJsonFile(path.join(f.dir, 'review12-broken-previous-terminal-identity.json'),
    terminal.restoredPredecessor);
  const { parsed } = runCliFail([
    'begin-recovery', '--state', statePath, '--receipts', f.receipts,
    '--operation-id', 'rec-guard-2', '--parent-deployment-id', 'dep-g-1',
    '--parent-phase', 'recovered', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ], withBoot(GB1));
  assert.equal(parsed.code, 'receipt-mismatch');
  assert.equal(lib.readState(statePath).activeSubOperation, null);
});

test('G4 begin-recovery: a recovered parent without historical previousTerminal remains linkable', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const stateBefore = lib.readState(statePath);
  delete stateBefore.parentDeployment.previousTerminal;
  lib.writeState(statePath, stateBefore);
  runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', stateBefore.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  const terminal = lib.readState(statePath).parentDeployment;
  const receiptsPath = writeJsonFile(path.join(f.dir, 'review12-no-previous-terminal-receipts.json'), {
    recoveryReceiptSha256: terminal.recoveryReceiptSha256,
    topologyActivationReceiptSha256: terminal.topologyActivationReceiptSha256,
    restoredPredecessor: terminal.restoredPredecessor,
    restoredPredecessorSha256: terminal.restoredPredecessorSha256,
  });
  const identityPath = writeJsonFile(path.join(f.dir, 'review12-no-previous-terminal-identity.json'),
    terminal.restoredPredecessor);
  const linked = runCliOk([
    'begin-recovery', '--state', statePath, '--receipts', f.receipts,
    '--operation-id', 'rec-guard-2', '--parent-deployment-id', 'dep-g-1',
    '--parent-phase', 'recovered', '--parent-receipts', receiptsPath, '--identity', identityPath,
  ], withBoot(GB1));
  assert.equal(linked.verb, 'begin-recovery');
  assert.equal(lib.readState(statePath).activeSubOperation.operationId, 'rec-guard-2');
});

test('G4 recovery rejects stale or tampered reviewed healed-UCI preservation evidence', () => {
  const { f, statePath, proofPath } = authorizedGuardRecoveryFixture({ enabledPredecessor: true });
  const proof = JSON.parse(fs.readFileSync(proofPath));
  fs.appendFileSync(proof.uciReview.comparisonPath, ' ');
  const before = lib.readState(statePath);
  const failed = runCliFail([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  assert.equal(failed.parsed.code, 'proof-mismatch');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'recovery'), null);
});

test('G4 recovery authority: durable typed owner handoff and release intent resume after reboot without volatile owner', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const before = lib.readState(statePath);
  const args = ['recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath)];
  const crashed = runCli(args, withBoot(GB1, {
    OSI_DEPLOY_STATE_CRASH_AT: 'recover:after-owner-handoff-release-intent',
  }));
  assert.equal(crashed.status, 137);
  const intent = lib.readState(statePath).parentDeployment;
  assert.equal(intent.phase, 'verification-in-flight');
  assert.equal(intent.lockOwnerHandoff.kind, 'RECOVERY_LOCK_OWNER_HANDOFF');
  assert.equal(intent.lockOwnerHandoff.originalOwnerDeploymentId, 'dep-g-1');
  assert.equal(intent.lockOwnerHandoff.recoveryOwnerDeploymentId, 'rec-guard-1');
  assert.equal(intent.lockRelease.status, 'intent');
  fs.rmSync(f.lockDir, { recursive: true });
  const recovered = runCliOk(args, withBoot('guard-boot-0002'));
  assert.equal(recovered.phase, 'recovered');
  const released = runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--operation-id', 'rec-guard-1', '--expected-final-receipt-sha256', recovered.recoveryReceiptSha256],
  withBoot('guard-boot-0002'));
  assert.equal(released.lockRelease.status, 'released');
});

test('G4 recovery authority: full live topology drift after authorization blocks recovery terminal CAS', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const before = lib.readState(statePath);
  const runtimePath = path.join(f.dir, 'srv/node-red/settings.js');
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimePath, 'post-authorization drift\n', { mode: 0o600 });
  const failed = runCliFail([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  assert.equal(failed.parsed.code, 'current-control-mismatch');
  assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'recovery'), null);
  const after = lib.readState(statePath);
  assert.equal(after.parentDeployment.phase, 'verification-in-flight');
  assert.equal(after.activeSubOperation.phase, 'recovery-topology-authorized');
});

test('G4 recovery authority: post-proof target-safety removal, replacement, or manifest mutation blocks terminal CAS', () => {
  for (const mutation of ['remove-s01', 'replace-helper', 'mutate-manifest']) {
    const { f, statePath } = authorizedGuardRecoveryFixture();
    const before = lib.readState(statePath);
    const safety = f.guardTargetSafety;
    if (mutation === 'remove-s01') {
      fs.unlinkSync(path.join(f.dir, 'etc/rc.d/S01osi-deployment-inhibit'));
    } else if (mutation === 'replace-helper') {
      fs.writeFileSync(path.join(f.dir, 'usr/libexec/osi-deployment-inhibit.sh'), 'replacement\n', { mode: 0o755 });
    } else {
      fs.appendFileSync(safety.manifestPath, ' ');
    }
    const failed = runCliFail([
      'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
      '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
      '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
      ...recoveryEvidenceArgs(f, statePath),
    ], withBoot(GB1));
    assert.match(failed.parsed.code, /control|manifest|proof/, mutation);
    assert.equal(lib.readReceipt(f.receipts, 'rec-guard-1', 'recovery'), null, mutation);
    assert.equal(lib.readState(statePath).activeSubOperation.phase, 'recovery-topology-authorized', mutation);
  }
});

test('G4 recovered startup freshly remeasures live controls, the six application links, and UCI identity', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const before = lib.readState(statePath);
  runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  const authority = startupAuthorityFixture(f);
  const recovered = lib.readState(statePath).parentDeployment;
  runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--operation-id', recovered.recoveryOperationId,
    '--expected-final-receipt-sha256', recovered.recoveryReceiptSha256], withBoot(GB1));
  const args = ['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', statePath, '--receipts', f.receipts, '--service', 'osi-db-integrity'];
  assert.equal(runCliOk(args, withBoot('guard-boot-0002')).mode, 'terminal-recovered');

  const control = path.join(f.dir, `.${authority.marker.liveControls[0].path}`);
  const controlBytes = fs.readFileSync(control);
  fs.writeFileSync(control, 'changed-control\n', { mode: 0o755 });
  assert.equal(runCliFail(args, withBoot(GB1)).parsed.code, 'current-control-mismatch');
  fs.writeFileSync(control, controlBytes, { mode: 0o755 }); fs.chmodSync(control, 0o755);

  const link = path.join(f.dir, `.${GUARD_SIX_LINKS[0]}`);
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  fs.symlinkSync('../init.d/osi-identityd', link);
  assert.equal(runCliFail(args, withBoot(GB1)).parsed.code, 'current-control-mismatch');
  fs.rmSync(link);

  const uci = path.join(f.dir, 'etc/config/osi-server');
  fs.mkdirSync(path.dirname(uci), { recursive: true, mode: 0o700 });
  fs.writeFileSync(uci, "config cloud 'cloud'\n option device_eui 'ABCDEF0123456789'\n", { mode: 0o600 });
  assert.equal(runCliFail(args, withBoot(GB1)).parsed.code, 'current-control-mismatch');
});

test('G4 recovered startup rejects replacement of marker-bound S01 after terminal proof', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const before = lib.readState(statePath);
  runCliOk([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  const authority = startupAuthorityFixture(f);
  const recovered = lib.readState(statePath).parentDeployment;
  runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
    '--operation-id', recovered.recoveryOperationId,
    '--expected-final-receipt-sha256', recovered.recoveryReceiptSha256], withBoot(GB1));
  const s01 = path.join(f.dir, 'etc/rc.d/S01osi-deployment-inhibit');
  fs.unlinkSync(s01);
  fs.symlinkSync('../init.d/node-red', s01);
  const failed = runCliFail(['startup-check', '--root', f.dir, '--guard-marker', authority.markerPath,
    '--state', statePath, '--receipts', f.receipts, '--service', 'osi-db-integrity'], withBoot(GB1));
  assert.equal(failed.parsed.code, 'current-control-mismatch');
});

test('G4 recovered terminal rejects wrong recovery, parent, topology, and lock identities', () => {
  for (const mutation of ['recovery-operation', 'parent', 'topology-operation', 'lock-operation']) {
    const { f, statePath } = authorizedGuardRecoveryFixture();
    const before = lib.readState(statePath);
    const result = runCliOk(['recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
      '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
      '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
      ...recoveryEvidenceArgs(f, statePath)], withBoot(GB1));
    f.state = statePath;
    const marker = startupAuthorityFixture(f).markerPath;
    if (mutation !== 'lock-operation') {
      runCliOk(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
        '--operation-id', 'rec-guard-1', '--expected-final-receipt-sha256', result.recoveryReceiptSha256], withBoot(GB1));
    }
    if (mutation === 'recovery-operation') {
      const state = lib.readState(statePath); state.parentDeployment.recoveryOperationId = 'wrong-recovery';
      fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    } else if (mutation === 'parent') {
      const receipt = path.join(f.receipts, 'rec-guard-1.recovery.json');
      const value = JSON.parse(fs.readFileSync(receipt)); value.parentDeploymentId = 'wrong-parent';
      fs.writeFileSync(receipt, JSON.stringify(value), { mode: 0o600 });
    } else if (mutation === 'topology-operation') {
      const receipt = path.join(f.receipts, 'rec-guard-1.topology-activation.json');
      const value = JSON.parse(fs.readFileSync(receipt)); value.operationId = 'wrong-topology';
      fs.writeFileSync(receipt, JSON.stringify(value), { mode: 0o600 });
    }
    if (mutation === 'lock-operation') {
      const ownerPath = path.join(f.lockDir, 'owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerPath)); owner.deploymentId = 'wrong-lock';
      fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      const failed = runCliFail(['release-lock', '--state', statePath, '--lock-dir', f.lockDir,
        '--operation-id', 'rec-guard-1', '--expected-final-receipt-sha256', result.recoveryReceiptSha256], withBoot(GB1));
      assert.match(failed.parsed.code, /lock|operation/);
    } else {
      const failed = runCliFail(['startup-check', '--root', f.dir, '--guard-marker', marker,
        '--state', statePath, '--receipts', f.receipts, '--service', 'osi-db-integrity'], withBoot(GB1));
      assert.match(failed.parsed.code, /receipt|unknown|operation|shape|lock-release|missing-field/);
    }
  }
});

test('G4 recovery authority: malformed rich receipt fails closed on recover read', () => {
  const { f, statePath } = authorizedGuardRecoveryFixture();
  const before = lib.readState(statePath);
  const receiptPath = path.join(f.receipts, 'rec-guard-1.topology-activation.json');
  const malformed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  malformed.extra = 'smuggled';
  fs.writeFileSync(receiptPath, JSON.stringify(malformed), { mode: 0o600 });
  const result = runCliFail([
    'recover', '--state', statePath, '--receipts', f.receipts, '--lock-dir', f.lockDir,
    '--guard-bootstrap-root', f.root, '--operation-id', 'rec-guard-1',
    '--expected-identity-sha256', before.activeSubOperation.restoredPredecessorSha256,
    ...recoveryEvidenceArgs(f, statePath),
  ], withBoot(GB1));
  assert.equal(result.parsed.code, 'unknown-field');
  assert.equal(lib.readState(statePath).activeSubOperation.phase, 'recovery-topology-authorized');
});

test('G4 authorize: recovery rejects guard-aware 94 absence when consumption authority is unverifiable', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'ready');
  const claim = cliClaim(f, { gen: head.generation, sha: head.sha256 });
  assert.equal(claim.status, 0, claim.stderr);
  const statePath = writeGuardRecoveryState(f, { phase: 'recovery-topology-verifying' });
  const res = cliAuthorize(f, {
    operationId: 'rec-guard-1',
    expectedPhase: 'recovery-topology-verifying',
    statePath,
    guard94: { state: 'absent', consumptionReceiptSha256: 'a'.repeat(64) },
  });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'guard-94-consumption-unverifiable');
});

test('G4 authorize: recovery context negatives - no state, no recovery sub-op, mismatched operation id, unclaimed chain', () => {
  const f = guardOpsFixture();
  buildGuardChain(f, 'ready');
  // No state file at all.
  let res = cliAuthorize(f, { operationId: 'rec-x', expectedPhase: 'recovery-topology-verifying' });
  assert.equal(JSON.parse(res.stderr).code, 'state-missing');
  // State exists but no recovery sub-operation.
  const statePath = path.join(f.dir, 'deployment-state.json');
  lib.writeState(statePath, {
    format: 2,
    parentDeployment: {
      deploymentId: 'dep-g-1', phase: 'armed', leaseActive: true, generation: 1,
      attemptSha256: 'a'.repeat(64), targetCommitSha: 'a'.repeat(40), controllerGeneration: 1,
      createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
      databaseLineage: { status: 'not-applicable' },
    },
    activeSubOperation: null,
  });
  res = cliAuthorize(f, { operationId: 'rec-x', expectedPhase: 'recovery-topology-verifying', statePath });
  assert.equal(JSON.parse(res.stderr).code, 'no-active-recovery');

  // The active recovery exists but belongs to a different operation.
  writeGuardRecoveryState(f, { operationId: 'rec-linked' });
  res = cliAuthorize(f, { operationId: 'rec-x', expectedPhase: 'recovery-topology-verifying', statePath });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'operation-id-mismatch');

  // The operation now matches, but the parent chain has not been claimed.
  res = cliAuthorize(f, { operationId: 'rec-linked', expectedPhase: 'recovery-topology-verifying', statePath });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'cas-mismatch');
});

test('G4 authorize: every hash-mismatch negative is bounded', () => {
  const { f } = abandoningFixture();
  // A caller-selected six-link identity cannot replace the immutable proof.
  let res = cliAuthorize(f, { sixLink: 'ff'.repeat(32) });
  assert.equal(JSON.parse(res.stderr).code, 'proof-mismatch');
  // Inhibitor mismatch.
  res = cliAuthorize(f, { inhibitor: 'ff'.repeat(32) });
  assert.equal(JSON.parse(res.stderr).code, 'inhibitor-mismatch');
  // Guard-aware 94 present with the wrong hash.
  res = cliAuthorize(f, { guard94: { state: 'present', sha256: 'ff'.repeat(32) } });
  assert.equal(JSON.parse(res.stderr).code, 'guard-94-mismatch');
  // Absence at a nonterminal phase is never accepted.
  res = cliAuthorize(f, { guard94: { state: 'absent', consumptionReceiptSha256: 'a'.repeat(64) } });
  assert.equal(JSON.parse(res.stderr).code, 'guard-94-absence-rejected');
  // Malformed absence identity (missing consumption receipt).
  res = cliAuthorize(f, { guard94: { state: 'absent' } });
  const code = JSON.parse(res.stderr).code;
  assert.ok(['missing-field', 'shape', 'unknown-field'].includes(code), `got ${code}`);
  // Unknown state value.
  res = cliAuthorize(f, { guard94: { state: 'gone' } });
  assert.equal(JSON.parse(res.stderr).code, 'shape');
});

test('G4 authorize: wrong chain phase for the abandoning context fails bounded', () => {
  const f = guardOpsFixture();
  buildGuardChain(f, 'controls-installed');
  const res = cliAuthorize(f, {});
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'cas-mismatch');
});

test('G4 authorize: an epoch that never quarantined links has no topology to authorize', () => {
  const f = guardOpsFixture();
  const head = buildGuardChain(f, 'epoch-start');
  const crashed = cliAbandon(f, {
    gen: head.generation, sha: head.sha256,
    env: { OSI_DEPLOY_STATE_CRASH_AT: 'guard-append:abandoning:after-dir-fsync' },
  });
  assert.equal(crashed.status, 137);
  const res = cliAuthorize(f, {});
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'no-quarantined-topology');
});

test('G4 authorize: an armed parent for the same deployment blocks abandoning authorization', () => {
  const { f } = abandoningFixture();
  const statePath = path.join(f.dir, 'deployment-state.json');
  lib.writeState(statePath, {
    format: 2,
    parentDeployment: {
      deploymentId: 'dep-g-1', phase: 'armed', leaseActive: true, generation: 1,
      attemptSha256: 'a'.repeat(64), targetCommitSha: 'a'.repeat(40), controllerGeneration: 1,
      createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
      databaseLineage: { status: 'not-applicable' },
    },
    activeSubOperation: null,
  });
  const res = cliAuthorize(f, { statePath });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'armed-parent');
});

test('G4 authorize: a planted mismatched receipt is a conflict, never a resume', () => {
  const { f, abandoningHead } = abandoningFixture();
  // Plant a byte-plausible but wrong-generation receipt via raw fs (the
  // exclusive writer would refuse to overwrite it later).
  fs.mkdirSync(f.receipts, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.receipts, 'dep-g-1.topology-activation.json'), JSON.stringify({
    format: 1, receiptKind: 'topology-activation', authorityKind: 'guard-bootstrap',
    operationId: 'dep-g-1', deploymentId: 'dep-g-1', topologyOutcome: 'restored',
    guardGeneration: abandoningHead.generation + 7,
    guardGenerationSha256: 'f'.repeat(64),
    sixLinkTopologySha256: GUARD_SIXLINK_SHA,
    guardAware94: { state: 'present', sha256: GUARD_94 },
    inhibitorSha256: GUARD_INHIBITOR,
    topologyRestorationProofPath: writeSyntheticTopologyRestorationProof(f, {
      deploymentId: 'dep-g-1',
      topologyManifestSha256: [...lib.readGuardChain(f.root, 'dep-g-1').entries].reverse()
        .find((entry) => entry.entry.phase === 'topology-snapshotted').entry.facts.topologyManifestSha256,
    }),
    topologyRestorationProofSha256: 'e'.repeat(64),
    compatibilityManifestSha256: 'f'.repeat(64),
    createdAt: '2026-07-18T00:00:00.000Z',
  }, null, 2), { mode: 0o600 });
  const res = cliAuthorize(f, {});
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'receipt-mismatch');
});

test('G4 authorize: unknown expected-phase value is rejected', () => {
  const { f } = abandoningFixture();
  const res = cliAuthorize(f, { expectedPhase: 'ready' });
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'shape');
});

// argv negatives for all six guard verbs, matching the core pattern.
const GUARD_FLAG_NEGATIVE_CASES = [
  { verb: 'begin-guard-bootstrap', base: ['--root', '/tmp/gb', '--deployment-id', 'd', '--identity', '/tmp/i.json'] },
  { verb: 'advance-guard-bootstrap', base: ['--root', '/tmp/gb', '--deployment-id', 'd', '--expected-generation', '1', '--expected-generation-sha256', 'a'.repeat(64), '--expected-phase', 'intent', '--phase', 'epoch-start', '--facts', '/tmp/f.json'] },
  { verb: 'status-guard-bootstrap', base: ['--root', '/tmp/gb', '--deployment-id', 'd', '--expected-head-sha256', 'a'.repeat(64)] },
  { verb: 'claim-attempt', base: ['--attempts', '/tmp/at', '--guard-bootstrap-root', '/tmp/gb', '--guard-marker', '/tmp/guard-installed.json', '--deployment-id', 'd', '--expected-guard-generation', '9', '--expected-guard-generation-sha256', 'a'.repeat(64), '--expected-marker-sha256', 'b'.repeat(64), '--controller-generation', '1', '--target-commit', 'c'.repeat(40), '--control-manifest-sha256', 'c'.repeat(64), '--artifact-sha256', 'b'.repeat(64)] },
  { verb: 'abandon-guard-bootstrap', base: ['--guard-bootstrap-root', '/tmp/gb', '--attempts', '/tmp/at', '--receipts', '/tmp/rc', '--deployment-id', 'd', '--expected-guard-generation', '3', '--expected-guard-generation-sha256', 'a'.repeat(64), '--expected-topology-manifest-sha256', 'b'.repeat(64), '--staging', '/tmp/staging/d'] },
  { verb: 'authorize-topology-activation', base: ['--state', '/tmp/s.json', '--guard-bootstrap-root', '/tmp/gb', '--receipts', '/tmp/rc', '--operation-id', 'd', '--expected-phase', 'abandoning', '--expected-six-link-topology-sha256', 'a'.repeat(64), '--guard-aware-uci-default', '/tmp/g94.json', '--inhibitor-sha256', 'b'.repeat(64)] },
];

for (const { verb, base } of GUARD_FLAG_NEGATIVE_CASES) {
  test(`G4 cli ${verb}: unknown flag is rejected`, () => {
    const { parsed } = runCliFail([verb, ...base, '--totally-bogus-flag', 'x']);
    assert.equal(parsed.code, 'unknown-flag');
  });
  test(`G4 cli ${verb}: duplicate flag is rejected`, () => {
    const { parsed } = runCliFail([verb, ...base, base[0], base[1]]);
    assert.equal(parsed.code, 'duplicate-flag');
  });
  test(`G4 cli ${verb}: missing a required flag is rejected`, () => {
    const { parsed } = runCliFail([verb, ...base.slice(2)]);
    assert.equal(parsed.code, 'missing-flag');
  });
}

// ===========================================================================
// Section G5: immutable contender mutation-lock protocol.
// ===========================================================================

test('G5: a stale record plus a newly live third controller are never displaced', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'deployment-state.json');
  const f = { state: statePath };
  const stalePath = plantMutationContender(f, {
    pid: 999999, bootId: lib.getBootId(), operationId: 'crashed-old',
  }, 1);
  const livePath = plantMutationContender(f, {
    pid: process.pid, bootId: lib.getBootId(), operationId: 'controller-c',
  }, 2);
  const liveBytes = fs.readFileSync(livePath);

  assert.throws(
    () => lib.acquireMutationLock(statePath, 'controller-b'),
    (error) => error.code === 'state-busy'
  );
  assert.equal(fs.existsSync(stalePath), false, 'proven-stale evidence is safely collected');
  assert.deepEqual(fs.readFileSync(livePath), liveBytes, 'live third controller remains active and untouched');
});

test('G5: stale contender collection is bounded per acquisition', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'deployment-state.json');
  const f = { state: statePath };
  const total = 70;
  for (let ticket = 1; ticket <= total; ticket++) {
    plantMutationContender(f, {
      pid: 999999,
      bootId: lib.getBootId(),
      operationId: `stale-${ticket}`,
    }, ticket);
  }
  const lease = lib.acquireMutationLock(statePath, 'collector');
  lib.releaseMutationLock(statePath, lease);
  assert.equal(mutationContenders(f).length, total - 64, 'one acquisition collects at most 64 stale tickets');
});

test('G5: ownership-checked release refuses to unlink a changed contender', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'deployment-state.json');
  const lease = lib.acquireMutationLock(statePath, 'clean-op');
  fs.writeFileSync(lease.contenderPath, '{"foreign":true}\n', { mode: 0o600 });
  assert.throws(
    () => lib.releaseMutationLock(statePath, lease),
    (error) => error.code === 'lock-owner-mismatch'
  );
  assert.equal(fs.existsSync(lease.contenderPath), true, 'mismatched contender is never deleted');
});

test('G5: clean acquisition removes only its exact contender on release', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'deployment-state.json');
  const lease = lib.acquireMutationLock(statePath, 'clean-op');
  const holder = JSON.parse(fs.readFileSync(lease.contenderPath, 'utf8'));
  assert.equal(holder.operationId, 'clean-op');
  assert.equal(holder.pid, process.pid);
  lib.releaseMutationLock(statePath, lease);
  assert.equal(fs.existsSync(lease.contenderPath), false);
  assert.equal(fs.existsSync(lib.mutationLockPath(statePath)), true, 'stable contender directory is retained');
});

test('G5: module documents immutable contenders and hardlink publication', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'deployment-state.js'), 'utf8');
  assert.match(src, /immutable per-controller contenders/);
  assert.match(src, /hard\s?-?link|link\(2\)/i);
  assert.doesNotMatch(src, /renameSync\(lockPath/);
});
