#!/usr/bin/env node
'use strict';

// Thin argv-parsing CLI over scripts/lib/deployment-state.js. Per the plan
// ("the pre-94 image initializer invokes it and never reimplements
// envelopes, CAS, receipt, or fsync logic"), this file owns argv parsing,
// per-verb orchestration of lib primitives, and bounded JSON stdout/stderr
// output only. Envelope/CAS/receipt/fsync logic lives in the library.
//
// Scope (A0 commit-1 sub-tranche): ordinary deployment lifecycle only.
// Guard-bootstrap, image-baseline, and staging-GC verbs are named and
// explicitly rejected below rather than silently falling through to
// "unknown verb", so operators get a clear "not in this slice" signal.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const sourceLibPath = path.join(__dirname, 'lib', 'deployment-state.js');
const residentLibPath = path.join(__dirname, 'osi-deployment-state.js');
const lib = require(fs.existsSync(sourceLibPath) ? sourceLibPath : residentLibPath);

const { DeploymentStateError } = lib;

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveInt(value, ctx) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new DeploymentStateError(`${ctx} must be a positive integer, got '${value}'`, 'shape');
  }
  return n;
}

function readRootOnlyJsonFile(p, ctx) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) {
    throw new DeploymentStateError(`${ctx} must be an absolute path`, 'shape');
  }
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new DeploymentStateError(`${ctx}: file not found: ${p}`, 'not-found');
    }
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new DeploymentStateError(`${ctx}: refusing symlink: ${p}`, 'symlink-rejected');
  }
  if (!stat.isFile()) {
    throw new DeploymentStateError(`${ctx}: expected a regular file: ${p}`, 'shape');
  }
  if (stat.uid !== process.getuid()) {
    throw new DeploymentStateError(`${ctx}: refusing file with unexpected owner: ${p}`, 'wrong-owner');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new DeploymentStateError(`${ctx}: expected exact mode 0600: ${p}`, 'wrong-mode');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new DeploymentStateError(`${ctx}: invalid JSON in ${p}: ${err.message}`, 'shape');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

function parseArgs(argv, spec) {
  const required = spec.required || [];
  const optional = spec.optional || [];
  const boolFlags = spec.flags || [];
  const known = new Set([...required, ...optional, ...boolFlags]);
  const out = {};
  const seen = new Set();
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      throw new DeploymentStateError(`unexpected positional argument: ${tok}`, 'unknown-flag');
    }
    const name = tok.slice(2);
    if (!known.has(name)) {
      throw new DeploymentStateError(`unknown flag: --${name}`, 'unknown-flag');
    }
    if (seen.has(name)) {
      throw new DeploymentStateError(`duplicate flag: --${name}`, 'duplicate-flag');
    }
    seen.add(name);
    if (boolFlags.includes(name)) {
      out[name] = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new DeploymentStateError(`missing value for --${name}`, 'missing-value');
    }
    out[name] = value;
    i += 2;
  }
  for (const req of required) {
    if (!(req in out)) {
      throw new DeploymentStateError(`missing required flag: --${req}`, 'missing-flag');
    }
  }
  for (const idFlag of ['operation-id', 'deployment-id', 'parent-deployment-id']) {
    if (idFlag in out) lib.validateOperationId(out[idFlag], `--${idFlag}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ordinary phase adjacency for generic `advance` (runtime-verified onward
// is reached only via the dedicated `finish`/`complete`/`begin-recovery`
// verbs, which additionally write the receipts the plan requires at those
// boundaries).
// ---------------------------------------------------------------------------

const ADVANCE_TRANSITIONS = {
  armed: ['writers-stopped'],
  'writers-stopped': ['protocol-initializing'],
  'protocol-initializing': ['protocol-dispositioning', 'protocol-ready'],
  'protocol-dispositioning': ['protocol-ready', 'protocol-reconciliation-required'],
  'protocol-reconciliation-required': ['protocol-dispositioning'],
  'protocol-ready': ['resident-mutating'],
  'resident-mutating': ['payload-mutating'],
  'payload-mutating': ['probes-running'],
  'probes-running': ['runtime-verified'],
};

const ADVANCE_PATCHABLE_FIELDS = ['databaseLineage'];

// ---------------------------------------------------------------------------
// Verbs (this checkpoint): acquire-lock, arm, advance, status, finish,
// complete, release-lock.
// ---------------------------------------------------------------------------

function verbAcquireLock(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'lock-dir', 'deployment-id', 'target-commit', 'controller-generation'],
  });
  const result = lib.acquireLock({
    lockDir: args['lock-dir'],
    statePath: args.state,
    deploymentId: args['deployment-id'],
    targetCommitSha: args['target-commit'],
    controllerGeneration: parsePositiveInt(args['controller-generation'], '--controller-generation'),
  });
  return { ok: true, verb: 'acquire-lock', deploymentId: args['deployment-id'], ...result };
}

const ARM_IDENTITY_FIELDS = ['deploymentId', 'targetCommitSha', 'controllerGeneration'];

function verbArm(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'receipts', 'attempts', 'expected-attempt-sha256', 'identity'],
    optional: ['expected-previous-generation', 'expected-previous-terminal-phase', 'expected-previous-terminal-receipts'],
  });

  const identity = readRootOnlyJsonFile(args.identity, '--identity');
  lib.assertExactFields(identity, ARM_IDENTITY_FIELDS, 'identity');
  lib.assertString(identity.deploymentId, 'identity.deploymentId');
  lib.assertString(identity.targetCommitSha, 'identity.targetCommitSha');
  lib.assertPositiveInt(identity.controllerGeneration, 'identity.controllerGeneration');

  const identitySha256 = lib.canonicalHash(identity);
  if (identitySha256 !== args['expected-attempt-sha256']) {
    throw new DeploymentStateError(
      '--expected-attempt-sha256 does not match the canonical hash of --identity',
      'attempt-sha-mismatch'
    );
  }
  const previousFlags = ['expected-previous-generation', 'expected-previous-terminal-phase', 'expected-previous-terminal-receipts'];
  const anyPreviousFlag = previousFlags.some((f) => f in args);

  // Arm and abandon both publish authority for the same one-use attempt.
  // Serialize them on the tombstone address before taking their private
  // state/guard-chain locks, and re-read the claim inside that shared tenure.
  // This closes the check-absent/write-tombstone vs check-absent/append-
  // abandoning window that otherwise permits both terminal authorities.
  const attemptAuthorityPath = lib.attemptTombstonePath(args.attempts, identity.deploymentId);
  return lib.withStateMutation(attemptAuthorityPath, identity.deploymentId, () => {
    const claimAuthority = readArmClaimAuthority(args.attempts, identity);
    return lib.withStateMutation(args.state, identity.deploymentId, () => {
      const current = lib.readState(args.state);

      if (current === null) {
        if (anyPreviousFlag) {
          throw new DeploymentStateError(
            'first arm (no existing state) must not pass --expected-previous-* flags',
            'unexpected-previous-args'
          );
        }
        lib.writeAttemptTombstone(args.attempts, identity.deploymentId, {
          deploymentId: identity.deploymentId,
          identitySha256,
          targetCommitSha: identity.targetCommitSha,
          controllerGeneration: identity.controllerGeneration,
          claimSha256: claimAuthority.sha256,
          claimPath: claimAuthority.path,
          createdAt: nowIso(),
        });
        const now = nowIso();
        const envelope = {
          format: 2,
          parentDeployment: {
            deploymentId: identity.deploymentId,
            phase: 'armed',
            leaseActive: true,
            generation: 1,
            attemptSha256: identitySha256,
            targetCommitSha: identity.targetCommitSha,
            controllerGeneration: identity.controllerGeneration,
            claimSha256: claimAuthority.sha256,
            claimPath: claimAuthority.path,
            createdAt: now,
            updatedAt: now,
            databaseLineage: { status: 'not-applicable' },
          },
          activeSubOperation: null,
        };
        lib.maybeCrash('arm:before-state-publication');
        lib.writeStateExclusive(args.state, envelope);
        return { ok: true, verb: 'arm', deploymentId: identity.deploymentId, phase: 'armed', generation: 1 };
      }

      return armFromTerminal(args, identity, identitySha256, claimAuthority, previousFlags, current);
    });
  });
}

function armFromTerminal(args, identity, identitySha256, claimAuthority, previousFlags, current) {
  for (const req of previousFlags) {
    if (!(req in args)) {
      throw new DeploymentStateError(`re-arm requires --${req}`, 'missing-flag');
    }
  }

  const parent = current.parentDeployment;
  if (parent.leaseActive) {
    throw new DeploymentStateError('cannot arm: an active lease already exists', 'lease-active');
  }
  if (!lib.TERMINAL_PARENT_PHASES.includes(parent.phase)) {
    throw new DeploymentStateError(
      `cannot arm: current parent phase '${parent.phase}' is not a lease-free terminal phase`,
      'not-terminal'
    );
  }
  const expectedGeneration = parsePositiveInt(args['expected-previous-generation'], '--expected-previous-generation');
  if (parent.generation !== expectedGeneration) {
    throw new DeploymentStateError('--expected-previous-generation does not match current state', 'cas-mismatch');
  }
  if (parent.phase !== args['expected-previous-terminal-phase']) {
    throw new DeploymentStateError('--expected-previous-terminal-phase does not match current state', 'cas-mismatch');
  }
  if (!lib.TERMINAL_PARENT_PHASES.includes(args['expected-previous-terminal-phase'])) {
    throw new DeploymentStateError('--expected-previous-terminal-phase must be completed|recovered', 'shape');
  }

  const previousReceipts = readRootOnlyJsonFile(
    args['expected-previous-terminal-receipts'],
    '--expected-previous-terminal-receipts'
  );
  lib.validateTerminalReceiptIdentity(parent.phase, previousReceipts);
  if (parent.phase === 'completed') {
    if (
      previousReceipts.completionKind !== parent.completionKind ||
      previousReceipts.deploymentReceiptSha256 !== parent.deploymentReceiptSha256 ||
      previousReceipts.acceptanceReceiptSha256 !== parent.acceptanceReceiptSha256
    ) {
      throw new DeploymentStateError('--expected-previous-terminal-receipts does not match recorded parent receipts', 'cas-mismatch');
    }
  } else {
    if (
      previousReceipts.recoveryReceiptSha256 !== parent.recoveryReceiptSha256 ||
      previousReceipts.topologyActivationReceiptSha256 !== parent.topologyActivationReceiptSha256 ||
      previousReceipts.restoredPredecessorSha256 !== parent.restoredPredecessorSha256
    ) {
      throw new DeploymentStateError('--expected-previous-terminal-receipts does not match recorded parent receipts', 'cas-mismatch');
    }
  }

  if (identity.deploymentId === parent.deploymentId) {
    throw new DeploymentStateError('re-arm must use a fresh deployment id, not the previous terminal id', 'deployment-id-reuse');
  }

  lib.writeAttemptTombstone(args.attempts, identity.deploymentId, {
    deploymentId: identity.deploymentId,
    identitySha256,
    targetCommitSha: identity.targetCommitSha,
    controllerGeneration: identity.controllerGeneration,
    claimSha256: claimAuthority.sha256,
    claimPath: claimAuthority.path,
    createdAt: nowIso(),
  });

  const now = nowIso();
  const nextEnvelope = {
    format: 2,
    parentDeployment: {
      deploymentId: identity.deploymentId,
      phase: 'armed',
      leaseActive: true,
      generation: 1,
      attemptSha256: identitySha256,
      targetCommitSha: identity.targetCommitSha,
      controllerGeneration: identity.controllerGeneration,
      claimSha256: claimAuthority.sha256,
      claimPath: claimAuthority.path,
      createdAt: now,
      updatedAt: now,
      databaseLineage: parent.databaseLineage,
      previousTerminal: {
        deploymentId: parent.deploymentId,
        generation: parent.generation,
        phase: parent.phase,
        receiptsSha256: lib.canonicalHash(previousReceipts),
        terminalTupleSha256: lib.terminalTupleSha256(parent.phase, previousReceipts),
      },
    },
    activeSubOperation: null,
  };
  lib.writeState(args.state, nextEnvelope);
  return {
    ok: true,
    verb: 'arm',
    deploymentId: identity.deploymentId,
    phase: 'armed',
    generation: 1,
    reArmedFromDeploymentId: parent.deploymentId,
  };
}

function verbAdvance(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'deployment-id', 'expected-phase', 'phase', 'patch'],
  });

  if (args.phase === lib.FACTORY_ONLY_PARENT_PHASE || args['expected-phase'] === lib.FACTORY_ONLY_PARENT_PHASE) {
    throw new DeploymentStateError(
      `factory-only phase '${lib.FACTORY_ONLY_PARENT_PHASE}' is rejected by generic advance`,
      'factory-phase-rejected'
    );
  }
  if (!lib.ORDINARY_PARENT_PHASES.includes(args.phase)) {
    throw new DeploymentStateError(`unknown target phase: ${args.phase}`, 'shape');
  }

  return lib.withStateMutation(args.state, args['deployment-id'], () => advanceLocked(args));
}

function advanceLocked(args) {
  const current = lib.readState(args.state);
  if (!current) {
    throw new DeploymentStateError('no deployment state to advance', 'state-missing');
  }
  // Plan: "The parent phase is pinned while a recovery sub-operation
  // acts." Enforced on activeSubOperation itself - not merely via the
  // adjacency table - so a future ADVANCE_TRANSITIONS edit cannot
  // silently reopen generic phase movement during a sub-operation.
  if (current.activeSubOperation !== null) {
    throw new DeploymentStateError(
      `parent phase is pinned while a '${current.activeSubOperation.kind}' sub-operation is active`,
      'phase-pinned'
    );
  }
  const parent = current.parentDeployment;
  if (parent.deploymentId !== args['deployment-id']) {
    throw new DeploymentStateError('--deployment-id does not match current state', 'deployment-id-mismatch');
  }
  if (parent.phase !== args['expected-phase']) {
    throw new DeploymentStateError(`--expected-phase mismatch: current phase is '${parent.phase}'`, 'cas-mismatch');
  }
  if (!parent.leaseActive) {
    throw new DeploymentStateError('cannot advance without an active lease', 'lease-not-active');
  }

  const allowedNext = ADVANCE_TRANSITIONS[parent.phase] || [];
  if (!allowedNext.includes(args.phase)) {
    throw new DeploymentStateError(
      `phase-skip rejected: '${parent.phase}' -> '${args.phase}' is not an adjacent ordinary transition`,
      'phase-skip-rejected'
    );
  }

  const patch = readRootOnlyJsonFile(args.patch, '--patch');
  lib.assertPlainObject(patch, 'patch');
  lib.assertNoUnknownFields(patch, ADVANCE_PATCHABLE_FIELDS, 'patch');

  const now = nowIso();
  const nextParent = {
    ...parent,
    ...patch,
    phase: args.phase,
    generation: parent.generation + 1,
    updatedAt: now,
  };
  lib.validateParentDeployment(nextParent);
  lib.writeState(args.state, { ...current, parentDeployment: nextParent });
  return { ok: true, verb: 'advance', phase: args.phase, generation: nextParent.generation };
}

function verbStatus(argv) {
  const args = parseArgs(argv, { required: ['state', 'receipts', 'deployment-id'] });
  const current = lib.readState(args.state);
  if (!current) {
    return { ok: true, verb: 'status', exists: false };
  }
  if (current.parentDeployment.deploymentId !== args['deployment-id']) {
    throw new DeploymentStateError('--deployment-id does not match current state', 'deployment-id-mismatch');
  }
  return {
    ok: true,
    verb: 'status',
    exists: true,
    parentDeployment: current.parentDeployment,
    activeSubOperation: current.activeSubOperation,
  };
}

function verbFinish(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'receipts', 'operation-id', 'expected-phase', 'result'],
  });
  if (args['expected-phase'] !== 'runtime-verified') {
    throw new DeploymentStateError("finish requires --expected-phase runtime-verified", 'shape');
  }
  if (args.result !== 'verified') {
    throw new DeploymentStateError('finish requires --result verified', 'shape');
  }

  return lib.withStateMutation(args.state, args['operation-id'], () => finishLocked(args));
}

function finishLocked(args) {
  const current = lib.readState(args.state);
  if (!current) {
    throw new DeploymentStateError('no deployment state', 'state-missing');
  }
  const parent = current.parentDeployment;
  if (parent.deploymentId !== args['operation-id']) {
    throw new DeploymentStateError('--operation-id does not match current state', 'operation-id-mismatch');
  }
  if (!parent.leaseActive) {
    throw new DeploymentStateError('cannot finish without an active lease', 'lease-not-active');
  }
  if (parent.phase !== 'runtime-verified') {
    throw new DeploymentStateError(`cannot finish: current phase is '${parent.phase}'`, 'cas-mismatch');
  }

  let receipt = lib.readReceipt(args.receipts, args['operation-id'], 'deployment');
  if (!receipt) {
    receipt = lib.writeReceipt(args.receipts, args['operation-id'], 'deployment', {
      format: 1,
      receiptKind: 'deployment',
      operationId: args['operation-id'],
      deploymentId: parent.deploymentId,
      phaseAtIssuance: 'runtime-verified',
      result: 'verified',
      createdAt: nowIso(),
    });
  } else {
    // A receipt already exists at this path. This is only a legitimate
    // crash-resume (killed after the receipt's exclusive-create fsync but
    // before the state CAS landed) when its business fields match what
    // this call would have written; createdAt is allowed to differ since
    // it is wall-clock and not part of the CAS identity. Anything else
    // (a pre-existing, unrelated, or tampered receipt under the same
    // operation-id+kind) is a genuine conflict, not a resume.
    const expectedFields = {
      receiptKind: 'deployment',
      operationId: args['operation-id'],
      deploymentId: parent.deploymentId,
      phaseAtIssuance: 'runtime-verified',
      result: 'verified',
    };
    const mismatch = Object.entries(expectedFields).some(
      ([key, value]) => receipt.content[key] !== value
    );
    if (mismatch) {
      throw new DeploymentStateError(
        'an existing deployment receipt for this operation-id does not match this finish call (not a valid resume)',
        'receipt-mismatch'
      );
    }
  }

  const now = nowIso();
  const nextParent = {
    ...parent,
    phase: 'verification-in-flight',
    leaseActive: true,
    generation: parent.generation + 1,
    updatedAt: now,
    deploymentReceiptSha256: receipt.sha256,
  };
  lib.validateParentDeployment(nextParent);
  lib.writeState(args.state, { ...current, parentDeployment: nextParent });
  return { ok: true, verb: 'finish', phase: 'verification-in-flight', deploymentReceiptSha256: receipt.sha256 };
}

const ACCEPTANCE_FIELDS = ['result', 'evidenceSha256'];

function verbComplete(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'receipts', 'lock-dir', 'operation-id', 'expected-deployment-receipt-sha256', 'acceptance'],
  });

  return lib.withStateMutation(args.state, args['operation-id'], () => completeLocked(args));
}

function completeLocked(args) {
  let current = lib.readState(args.state);
  if (!current) {
    throw new DeploymentStateError('no deployment state', 'state-missing');
  }
  let parent = current.parentDeployment;
  if (parent.deploymentId !== args['operation-id']) {
    throw new DeploymentStateError('--operation-id does not match current state', 'operation-id-mismatch');
  }
  if (!parent.leaseActive) {
    throw new DeploymentStateError('cannot complete without an active lease', 'lease-not-active');
  }
  if (current.activeSubOperation !== null) {
    throw new DeploymentStateError('cannot complete while a sub-operation is active', 'suboperation-active');
  }
  if (parent.phase !== 'verification-in-flight') {
    throw new DeploymentStateError(`cannot complete: current phase is '${parent.phase}'`, 'cas-mismatch');
  }
  if (parent.deploymentReceiptSha256 !== args['expected-deployment-receipt-sha256']) {
    throw new DeploymentStateError('--expected-deployment-receipt-sha256 does not match recorded state', 'cas-mismatch');
  }

  const acceptance = readRootOnlyJsonFile(args.acceptance, '--acceptance');
  lib.assertExactFields(acceptance, ACCEPTANCE_FIELDS, 'acceptance');
  if (acceptance.result !== 'accepted') {
    throw new DeploymentStateError("acceptance.result must be 'accepted'", 'shape');
  }
  lib.assertSha256Hex(acceptance.evidenceSha256, 'acceptance.evidenceSha256');

  let receipt = lib.readReceipt(args.receipts, args['operation-id'], 'acceptance');
  if (receipt) {
    const expectedFields = {
      receiptKind: 'acceptance',
      operationId: args['operation-id'],
      deploymentId: parent.deploymentId,
      deploymentReceiptSha256: parent.deploymentReceiptSha256,
      result: 'accepted',
      evidenceSha256: acceptance.evidenceSha256,
    };
    const mismatch = Object.entries(expectedFields).some(
      ([key, value]) => receipt.content[key] !== value
    );
    if (mismatch) {
      throw new DeploymentStateError(
        'an existing acceptance receipt for this operation-id does not match this complete call (not a valid resume)',
        'receipt-mismatch'
      );
    }
  }
  if (!receipt) {
    receipt = lib.writeReceipt(args.receipts, args['operation-id'], 'acceptance', {
      format: 1,
      receiptKind: 'acceptance',
      operationId: args['operation-id'],
      deploymentId: parent.deploymentId,
      deploymentReceiptSha256: parent.deploymentReceiptSha256,
      result: 'accepted',
      evidenceSha256: acceptance.evidenceSha256,
      createdAt: nowIso(),
    });
  }

  const releaseIntent = lib.createLockReleaseIntent({
    lockDir: args['lock-dir'],
    operationId: args['operation-id'],
    finalReceiptSha256: receipt.sha256,
    existing: parent.lockRelease || null,
  });
  if (!parent.lockRelease) {
    const intentAt = nowIso();
    parent = { ...parent, lockRelease: releaseIntent, generation: parent.generation + 1, updatedAt: intentAt };
    lib.validateParentDeployment(parent);
    lib.writeState(args.state, { ...current, parentDeployment: parent });
    lib.maybeCrash('complete:after-release-intent');
    current = lib.readState(args.state);
    parent = current.parentDeployment;
  }

  const now = nowIso();
  const nextParent = {
    ...parent,
    phase: 'completed',
    leaseActive: false,
    generation: parent.generation + 1,
    updatedAt: now,
    completionKind: 'deployment',
    acceptanceReceiptSha256: receipt.sha256,
  };
  lib.validateParentDeployment(nextParent);
  lib.writeState(args.state, { ...current, parentDeployment: nextParent });
  return { ok: true, verb: 'complete', phase: 'completed', acceptanceReceiptSha256: receipt.sha256 };
}

// ---------------------------------------------------------------------------
// begin-recovery / recover
//
// Scope note: `authorize-topology-activation` (the guard-bootstrap-linked
// verb that produces a rich, six-link-topology-verified
// Recovery cannot issue its own topology authority. It progresses through
// an explicit verifying phase, consumes the rich guard-bootstrap receipt,
// binds that receipt hash into state, and revalidates the claimed chain
// under the state-then-guard mutation-lock order before terminal CAS.
// ---------------------------------------------------------------------------

function verbBeginRecovery(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'receipts', 'operation-id', 'parent-deployment-id', 'parent-phase', 'parent-receipts', 'identity'],
  });

  if (!lib.RECOVERY_LINKABLE_PARENT_PHASES.includes(args['parent-phase'])) {
    throw new DeploymentStateError(
      `--parent-phase must be one of: ${lib.RECOVERY_LINKABLE_PARENT_PHASES.join('|')}`,
      'shape'
    );
  }

  return lib.withStateMutation(args.state, args['operation-id'], () => beginRecoveryLocked(args));
}

function verifiedParentReceiptIdentity(parent, receiptsDir) {
  if (parent.phase === 'verification-in-flight') {
    const deployment = requireReceipt(
      receiptsDir, parent.deploymentId, 'deployment', parent.deploymentReceiptSha256, 'deployment'
    );
    if (deployment.content.operationId !== parent.deploymentId
        || deployment.content.deploymentId !== parent.deploymentId
        || deployment.content.phaseAtIssuance !== 'runtime-verified') {
      throw new DeploymentStateError('deployment receipt does not cross-bind the verification-in-flight parent', 'receipt-mismatch');
    }
    return { deploymentReceiptSha256: deployment.sha256 };
  }

  if (parent.phase === 'completed') {
    const deployment = requireReceipt(
      receiptsDir, parent.deploymentId, 'deployment', parent.deploymentReceiptSha256, 'deployment'
    );
    const acceptance = requireReceipt(
      receiptsDir, parent.deploymentId, 'acceptance', parent.acceptanceReceiptSha256, 'acceptance'
    );
    if (parent.completionKind !== 'deployment'
        || deployment.content.operationId !== parent.deploymentId
        || deployment.content.deploymentId !== parent.deploymentId
        || acceptance.content.operationId !== parent.deploymentId
        || acceptance.content.deploymentId !== parent.deploymentId
        || acceptance.content.deploymentReceiptSha256 !== deployment.sha256) {
      throw new DeploymentStateError('completed terminal receipt files do not cross-bind', 'receipt-mismatch');
    }
    return {
      completionKind: parent.completionKind,
      deploymentReceiptSha256: deployment.sha256,
      acceptanceReceiptSha256: acceptance.sha256,
    };
  }

  const operationId = parent.recoveryOperationId;
  const recovery = requireReceipt(
    receiptsDir, operationId, 'recovery', parent.recoveryReceiptSha256, 'recovery'
  );
  const topology = requireReceipt(
    receiptsDir, operationId, 'topology-activation', parent.topologyActivationReceiptSha256, 'topology-activation'
  );
  if (recovery.content.operationId !== operationId
      || recovery.content.parentDeploymentId !== parent.deploymentId
      || (parent.previousTerminal
        && recovery.content.parentReceiptsSha256 !== parent.previousTerminal.receiptsSha256)
      || topology.content.operationId !== operationId
      || topology.content.deploymentId !== parent.deploymentId
      || topology.content.authorityKind !== 'guard-bootstrap'
      || topology.content.topologyOutcome !== 'restored') {
    throw new DeploymentStateError('recovered terminal receipt files do not cross-bind one operation and parent', 'receipt-mismatch');
  }
  const proof = lib.readTopologyRestorationProof(topology.content.topologyRestorationProofPath);
  if (proof.sha256 !== topology.content.topologyRestorationProofSha256
      || proof.content.deploymentId !== parent.deploymentId
      || proof.content.compatibilityManifestSha256 !== topology.content.compatibilityManifestSha256
      || proof.content.sixLinkTopologySha256 !== topology.content.sixLinkTopologySha256
      || recovery.content.restoredPredecessorSha256 !== proof.content.restoredPredecessorSha256
      || parent.restoredPredecessorSha256 !== proof.content.restoredPredecessorSha256
      || lib.canonicalize(parent.restoredPredecessor) !== lib.canonicalize(proof.content.restoredPredecessor)) {
    throw new DeploymentStateError('recovered terminal receipts do not bind the immutable restoration proof', 'receipt-mismatch');
  }
  return {
    recoveryReceiptSha256: recovery.sha256,
    topologyActivationReceiptSha256: topology.sha256,
    restoredPredecessor: proof.content.restoredPredecessor,
    restoredPredecessorSha256: proof.content.restoredPredecessorSha256,
  };
}

function beginRecoveryLocked(args) {
  const current = lib.readState(args.state);
  if (!current) {
    throw new DeploymentStateError('no deployment state', 'state-missing');
  }
  const parent = current.parentDeployment;
  if (parent.deploymentId !== args['parent-deployment-id']) {
    throw new DeploymentStateError('--parent-deployment-id does not match current state', 'operation-id-mismatch');
  }
  if (parent.phase !== args['parent-phase']) {
    throw new DeploymentStateError(`--parent-phase mismatch: current phase is '${parent.phase}'`, 'cas-mismatch');
  }
  if (current.activeSubOperation !== null) {
    throw new DeploymentStateError(
      'a sub-operation is already active for this deployment; only one may exist at a time',
      'sub-operation-conflict'
    );
  }

  const claimedParentReceipts = readRootOnlyJsonFile(args['parent-receipts'], '--parent-receipts');
  lib.validateTerminalReceiptIdentity(parent.phase, claimedParentReceipts);
  const parentReceipts = verifiedParentReceiptIdentity(parent, args.receipts);
  lib.validateTerminalReceiptIdentity(parent.phase, parentReceipts);
  if (lib.canonicalize(claimedParentReceipts) !== lib.canonicalize(parentReceipts)) {
    throw new DeploymentStateError('--parent-receipts does not match verified immutable receipt evidence', 'cas-mismatch');
  }

  const restoredPredecessor = readRootOnlyJsonFile(args.identity, '--identity');
  lib.validateRestoredPredecessor(restoredPredecessor);
  const previousTerminal = parent.previousTerminal || null;
  if (restoredPredecessor.kind === 'managed-terminal') {
    const managedAuthority = parent.phase === 'recovered'
      ? parentReceipts.restoredPredecessor
      : previousTerminal && {
        kind: 'managed-terminal',
        deploymentId: previousTerminal.deploymentId,
        terminalTupleSha256: previousTerminal.terminalTupleSha256,
      };
    if (!managedAuthority
        || lib.canonicalize(restoredPredecessor) !== lib.canonicalize(managedAuthority)) {
      throw new DeploymentStateError(
        'managed restored predecessor does not resolve to the verified recovery lineage',
        'predecessor-unverified'
      );
    }
  } else if (parent.phase === 'recovered') {
    if (lib.canonicalize(restoredPredecessor) !== lib.canonicalize(parentReceipts.restoredPredecessor)) {
      throw new DeploymentStateError(
        'legacy restored predecessor does not resolve to the verified recovery lineage',
        'predecessor-unverified'
      );
    }
  } else if (previousTerminal) {
    throw new DeploymentStateError(
      'a managed previous terminal is recorded; legacy compatibility cannot replace that authority',
      'predecessor-unverified'
    );
  }
  const restoredPredecessorSha256 = lib.restoredPredecessorSha256(restoredPredecessor);

  const now = nowIso();
  const linkedFromTerminal = lib.TERMINAL_PARENT_PHASES.includes(parent.phase);
  const historicalTerminal = linkedFromTerminal ? {
    deploymentId: parent.deploymentId,
    generation: parent.generation,
    phase: parent.phase,
    receiptsSha256: lib.canonicalHash(parentReceipts),
    terminalTupleSha256: lib.terminalTupleSha256(parent.phase, parentReceipts),
  } : parent.previousTerminal;
  const nextParent = {
    ...parent,
    leaseActive: true,
    generation: parent.generation + 1,
    updatedAt: now,
    ...(linkedFromTerminal ? {
      previousTerminal: historicalTerminal,
      lockOwnerHandoff: null,
      lockRelease: null,
    } : {}),
  };
  const activeSubOperation = {
    kind: 'recovery',
    operationId: args['operation-id'],
    parentDeploymentId: parent.deploymentId,
    parentDeploymentGeneration: nextParent.generation,
    parentPhaseAtLink: args['parent-phase'],
    parentReceiptsSha256: lib.canonicalHash(parentReceipts),
    phase: 'recovery-started',
    restoredPredecessor,
    restoredPredecessorSha256,
    generation: 1,
    createdAt: now,
  };
  lib.validateParentDeployment(nextParent);
  lib.validateActiveSubOperation(activeSubOperation, nextParent);
  lib.writeState(args.state, { format: 2, parentDeployment: nextParent, activeSubOperation });
  return {
    ok: true,
    verb: 'begin-recovery',
    operationId: args['operation-id'],
    restoredPredecessorSha256,
  };
}

function verbRecover(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'receipts', 'lock-dir', 'guard-bootstrap-root', 'operation-id', 'expected-identity-sha256',
      'jailed-health-result', 'post-probe-audit', 'zero-mutation-proof'],
  });
  return lib.withStateMutation(args.state, args['operation-id'], () => (
    lib.withStateMutation(args['guard-bootstrap-root'], args['operation-id'], () => recoverLocked(args))
  ));
}

function readRecoveryEvidence(args, sub) {
  const healthFile = readStrictAuthorityFile(args['jailed-health-result'], '--jailed-health-result', { mode: 0o600 });
  const auditFile = readStrictAuthorityFile(args['post-probe-audit'], '--post-probe-audit', { mode: 0o600 });
  const zeroFile = readStrictAuthorityFile(args['zero-mutation-proof'], '--zero-mutation-proof', { mode: 0o600 });
  let health; let audit; let zero;
  try {
    health = JSON.parse(healthFile.raw);
    audit = JSON.parse(auditFile.raw);
    zero = JSON.parse(zeroFile.raw);
  } catch (error) {
    throw new DeploymentStateError(`recovery evidence is invalid JSON: ${error.message}`, 'evidence-invalid');
  }
  if (!sub.probePermit || sub.probePermit.purpose !== 'recovery-health' || sub.probePermit.status !== 'consumed') {
    throw new DeploymentStateError('recovery requires a consumed recovery-health probe permit', 'recovery-health-not-consumed');
  }
  lib.assertExactFields(health, ['format', 'operationId', 'parentDeploymentId', 'result', 'jail',
    'probePermitSha256', 'processStopped', 'createdAt'], 'jailed-health-result');
  lib.assertExactFields(health.jail, ['network', 'database', 'credentials', 'loopbackHealthOnly'], 'jailed-health-result.jail');
  if (health.format !== 1 || health.operationId !== sub.operationId || health.parentDeploymentId !== sub.parentDeploymentId
      || health.result !== 'healthy' || health.jail.network !== 'denied' || health.jail.database !== 'private-copy'
      || health.jail.credentials !== 'private-copy' || health.jail.loopbackHealthOnly !== true
      || health.processStopped !== true || health.probePermitSha256 !== lib.canonicalHash(sub.probePermit)) {
    throw new DeploymentStateError('jailed health evidence does not bind the consumed recovery probe', 'evidence-mismatch');
  }
  lib.assertExactFields(audit, ['format', 'operationId', 'parentDeploymentId', 'result', 'boundarySha256',
    'appliedCommandCount', 'ackOutboxCount', 'syncEventCount', 'createdAt'], 'post-probe-audit');
  if (audit.format !== 1 || audit.operationId !== sub.operationId || audit.parentDeploymentId !== sub.parentDeploymentId
      || audit.result !== 'clear' || audit.appliedCommandCount !== 0 || audit.ackOutboxCount !== 0 || audit.syncEventCount !== 0) {
    throw new DeploymentStateError('post-probe command ACK/outbox audit is not CLEAR', 'evidence-mismatch');
  }
  lib.assertSha256Hex(audit.boundarySha256, 'post-probe-audit.boundarySha256');
  lib.assertExactFields(zero, ['format', 'operationId', 'parentDeploymentId', 'result', 'processAbsent',
    'databaseBeforeSha256', 'databaseAfterSha256', 'runtimeBeforeSha256', 'runtimeAfterSha256',
    'guiBeforeSha256', 'guiAfterSha256', 'createdAt'], 'zero-mutation-proof');
  for (const field of ['databaseBeforeSha256', 'databaseAfterSha256', 'runtimeBeforeSha256', 'runtimeAfterSha256',
    'guiBeforeSha256', 'guiAfterSha256']) lib.assertSha256Hex(zero[field], `zero-mutation-proof.${field}`);
  if (zero.format !== 1 || zero.operationId !== sub.operationId || zero.parentDeploymentId !== sub.parentDeploymentId
      || zero.result !== 'unchanged' || zero.processAbsent !== true
      || zero.databaseBeforeSha256 !== zero.databaseAfterSha256
      || zero.runtimeBeforeSha256 !== zero.runtimeAfterSha256
      || zero.guiBeforeSha256 !== zero.guiAfterSha256) {
    throw new DeploymentStateError('zero-mutation proof does not prove exact live-state equality', 'evidence-mismatch');
  }
  return {
    jailedHealthResultSha256: lib.sha256Hex(healthFile.raw),
    postProbeAuditSha256: lib.sha256Hex(auditFile.raw),
    zeroMutationProofSha256: lib.sha256Hex(zeroFile.raw),
  };
}

function verbAdvanceRecovery(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'operation-id', 'expected-phase', 'phase'],
  });
  const allowed = {
    'recovery-started': 'recovery-topology-verifying',
  };
  return lib.withStateMutation(args.state, args['operation-id'], () => {
    const current = lib.readState(args.state);
    const sub = current && current.activeSubOperation;
    if (!sub || sub.kind !== 'recovery') {
      throw new DeploymentStateError('no active recovery sub-operation', 'no-active-recovery');
    }
    if (sub.operationId !== args['operation-id']) {
      throw new DeploymentStateError('--operation-id does not match the active recovery sub-operation', 'operation-id-mismatch');
    }
    if (sub.phase !== args['expected-phase']) {
      throw new DeploymentStateError(`recovery phase CAS mismatch: current phase is '${sub.phase}'`, 'cas-mismatch');
    }
    if (allowed[sub.phase] !== args.phase) {
      throw new DeploymentStateError(`illegal recovery phase transition ${sub.phase} -> ${args.phase}`, 'illegal-transition');
    }
    const nextSub = { ...sub, phase: args.phase, generation: sub.generation + 1 };
    lib.writeState(args.state, { ...current, activeSubOperation: nextSub });
    return { ok: true, verb: 'advance-recovery', operationId: sub.operationId, phase: nextSub.phase };
  });
}

function recoverLocked(args) {
  let current = lib.readState(args.state);
  if (!current) {
    throw new DeploymentStateError('no deployment state', 'state-missing');
  }
  let sub = current.activeSubOperation;
  if (!sub || sub.kind !== 'recovery') {
    throw new DeploymentStateError('no active recovery sub-operation', 'no-active-recovery');
  }
  if (sub.operationId !== args['operation-id']) {
    throw new DeploymentStateError('--operation-id does not match the active recovery sub-operation', 'operation-id-mismatch');
  }
  if (sub.phase !== 'recovery-topology-authorized') {
    throw new DeploymentStateError(
      `recover requires state phase 'recovery-topology-authorized', got '${sub.phase}'`,
      'cas-mismatch'
    );
  }
  if (sub.restoredPredecessorSha256 !== args['expected-identity-sha256']) {
    throw new DeploymentStateError('--expected-identity-sha256 does not match the linked restoredPredecessor', 'cas-mismatch');
  }

  let owner = lib.readLockOwner(args['lock-dir']);
  const existingHandoff = current.parentDeployment.lockOwnerHandoff || null;
  if (!existingHandoff) {
    if (!owner) throw new DeploymentStateError('no lock is held for this recovery operation', 'lock-missing');
    if (owner.deploymentId !== args['operation-id']) {
      throw new DeploymentStateError('lock is not held by this recovery operation-id', 'lock-owner-mismatch');
    }
    if (!lib.isOwnerLive(owner, lib.getBootId())) {
      throw new DeploymentStateError('lock owner is not live', 'lock-not-live');
    }
  }
  const recoveryEvidence = readRecoveryEvidence(args, sub);

  const topologyReceipt = lib.readReceipt(args.receipts, args['operation-id'], 'topology-activation');
  if (!topologyReceipt) {
    throw new DeploymentStateError('authorized topology-activation receipt is missing', 'receipt-missing');
  }
  if (sub.topologyActivationReceiptSha256 !== topologyReceipt.sha256) {
    throw new DeploymentStateError('recovery state topology receipt binding does not match immutable receipt bytes', 'receipt-mismatch');
  }
  const topology = topologyReceipt.content;
  if (topology.authorityKind !== 'guard-bootstrap'
      || topology.operationId !== sub.operationId
      || topology.deploymentId !== sub.parentDeploymentId
      || topology.topologyOutcome !== 'restored') {
    throw new DeploymentStateError('topology receipt does not carry exact guard-bootstrap recovery authority', 'receipt-mismatch');
  }
  const restorationProof = lib.readTopologyRestorationProof(topology.topologyRestorationProofPath);
  if (restorationProof.sha256 !== topology.topologyRestorationProofSha256
      || restorationProof.content.deploymentId !== sub.parentDeploymentId
      || restorationProof.content.compatibilityManifestSha256 !== topology.compatibilityManifestSha256
      || restorationProof.content.sixLinkTopologySha256 !== topology.sixLinkTopologySha256) {
    throw new DeploymentStateError('topology receipt does not bind the immutable restoration proof', 'proof-mismatch');
  }
  assertRestorationProofPredecessor(restorationProof, sub.restoredPredecessor);
  assertCurrentRestorationProofAuthority(restorationProof);
  const chain = requireGuardChain(args['guard-bootstrap-root'], sub.parentDeploymentId);
  if (chain.head.entry.phase !== 'claimed'
      || chain.head.generation !== topology.guardGeneration
      || chain.head.sha256 !== topology.guardGenerationSha256) {
    throw new DeploymentStateError('claimed guard chain changed after topology authorization', 'cas-mismatch');
  }
  const quarantined = [...chain.entries].reverse().find((entry) => entry.entry.phase === 'links-quarantined');
  const installed = [...chain.entries].reverse().find((entry) => entry.entry.phase === 'safety-installed');
  if (!quarantined || !installed
      || installed.entry.facts.inhibitorSha256 !== topology.inhibitorSha256
      || topology.guardAware94.state !== 'present'
      || installed.entry.facts.guardAware94Sha256 !== topology.guardAware94.sha256) {
    throw new DeploymentStateError('topology receipt evidence no longer matches the claimed guard chain', 'receipt-mismatch');
  }
  assertCurrentTargetSafetyAuthority(restorationProof, installed.entry.facts);

  let recoveryReceipt = lib.readReceipt(args.receipts, args['operation-id'], 'recovery');
  const expectedRecoveryFields = {
    receiptKind: 'recovery',
    operationId: args['operation-id'],
    parentDeploymentId: sub.parentDeploymentId,
    restoredPredecessorSha256: sub.restoredPredecessorSha256,
    parentReceiptsSha256: sub.parentReceiptsSha256,
    ...recoveryEvidence,
  };
  if (recoveryReceipt) {
    const mismatch = Object.entries(expectedRecoveryFields).some(([k, v]) => recoveryReceipt.content[k] !== v);
    if (mismatch) {
      throw new DeploymentStateError('an existing recovery receipt does not match this recover call (not a valid resume)', 'receipt-mismatch');
    }
  } else {
    recoveryReceipt = lib.writeReceipt(args.receipts, args['operation-id'], 'recovery', {
      format: 1,
      ...expectedRecoveryFields,
      createdAt: nowIso(),
    });
  }

  const parentBeforeIntent = current.parentDeployment;
  const markerPath = path.join(path.dirname(args['guard-bootstrap-root']), 'guard-installed.json');
  const markerAuthority = readGuardMarker(markerPath, {
    root: path.dirname(args['guard-bootstrap-root']), state: args.state, receipts: args.receipts,
  }, { requireLiveLockOwner: false, validateQuarantineAuthority: false });
  if (markerAuthority.marker.deploymentId !== sub.parentDeploymentId
      || markerAuthority.marker.lockOwner.path !== path.join(args['lock-dir'], 'owner.json')) {
    throw new DeploymentStateError('guard marker original lock owner does not bind the recovery lock path', 'lock-owner-mismatch');
  }
  const ownerRaw = owner ? fs.readFileSync(lib.lockOwnerPath(args['lock-dir'])) : null;
  const ownerSha256 = ownerRaw ? lib.sha256Hex(ownerRaw) : existingHandoff && existingHandoff.recoveryLockOwnerSha256;
  const handoff = existingHandoff || {
    format: 1,
    kind: 'RECOVERY_LOCK_OWNER_HANDOFF',
    parentDeploymentId: sub.parentDeploymentId,
    recoveryOperationId: sub.operationId,
    originalLockOwnerSha256: markerAuthority.marker.lockOwner.sha256,
    recoveryLockOwnerSha256: ownerSha256,
    originalOwnerDeploymentId: sub.parentDeploymentId,
    recoveryOwnerDeploymentId: sub.operationId,
    reason: 'stale-parent-lock-reclaimed-for-linked-recovery',
    parentGeneration: parentBeforeIntent.generation,
    recoveryGeneration: sub.generation,
    createdAt: nowIso(),
  };
  lib.validateLockOwnerHandoff(handoff);
  if (handoff.parentDeploymentId !== sub.parentDeploymentId
      || handoff.recoveryOperationId !== sub.operationId
      || handoff.originalLockOwnerSha256 !== markerAuthority.marker.lockOwner.sha256
      || (ownerRaw && handoff.recoveryLockOwnerSha256 !== lib.sha256Hex(ownerRaw))) {
    throw new DeploymentStateError('durable recovery owner handoff differs from the exact authorized owner chain', 'lock-owner-mismatch');
  }
  const releaseIntent = lib.createLockReleaseIntent({
    lockDir: args['lock-dir'], operationId: sub.operationId,
    finalReceiptSha256: recoveryReceipt.sha256, existing: parentBeforeIntent.lockRelease || null,
  });
  if (!parentBeforeIntent.lockOwnerHandoff || !parentBeforeIntent.lockRelease) {
    const intentAt = nowIso();
    const intentParent = {
      ...parentBeforeIntent,
      lockOwnerHandoff: handoff,
      lockRelease: releaseIntent,
      generation: parentBeforeIntent.generation + 1,
      updatedAt: intentAt,
    };
    lib.validateParentDeployment(intentParent);
    lib.writeState(args.state, { ...current, parentDeployment: intentParent });
    lib.maybeCrash('recover:after-owner-handoff-release-intent');
    current = lib.readState(args.state);
    sub = current.activeSubOperation;
  }

  const now = nowIso();
  const parent = current.parentDeployment;
  const nextParent = {
    ...parent,
    phase: 'recovered',
    leaseActive: false,
    generation: parent.generation + 1,
    updatedAt: now,
    recoveryReceiptSha256: recoveryReceipt.sha256,
    recoveryOperationId: sub.operationId,
    topologyActivationReceiptSha256: topologyReceipt.sha256,
    restoredPredecessor: sub.restoredPredecessor,
    restoredPredecessorSha256: sub.restoredPredecessorSha256,
  };
  // Last authority read inside both the state and guard locks: no proof-era
  // safety path may be removed or replaced between evidence checks and CAS.
  assertCurrentTargetSafetyAuthority(restorationProof, installed.entry.facts);
  lib.validateParentDeployment(nextParent);
  lib.writeState(args.state, { format: 2, parentDeployment: nextParent, activeSubOperation: null });
  return {
    ok: true,
    verb: 'recover',
    phase: 'recovered',
    recoveryReceiptSha256: recoveryReceipt.sha256,
    topologyActivationReceiptSha256: topologyReceipt.sha256,
  };
}

function verbReleaseLock(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'lock-dir', 'operation-id', 'expected-final-receipt-sha256'],
  });
  const result = lib.releaseLock({
    lockDir: args['lock-dir'],
    statePath: args.state,
    operationId: args['operation-id'],
    expectedFinalReceiptSha256: args['expected-final-receipt-sha256'],
  });
  return { ok: true, verb: 'release-lock', ...result };
}

// ---------------------------------------------------------------------------
// issue-probe-permit / startup-check
//
// Only 'deployment-probe' (against parentDeployment, phase probes-running)
// has a satisfiable context in this slice. Recovery health requires exact
// clean-restore or DATABASE_RESTORE_RECONCILED authority that this state
// model does not yet represent. All other codec-valid purposes therefore
// fail closed with purpose-not-satisfiable.
//
// The plan does not pin a literal expiry duration ("short expiry"); this
// module uses a concrete 5-minute value, documented in the report.
// ---------------------------------------------------------------------------

const PROBE_PERMIT_EXPIRY_MS = 5 * 60 * 1000;
const PROBE_IDENTITY_FIELDS = ['candidateSha256', 'databaseIdentitySha256', 'mountIdentitySha256', 'lockOwnerSha256'];

function parseNonceOutGeneration(nonceOutPath, operationId) {
  const base = path.basename(nonceOutPath);
  const m = base.match(/^(.+)\.(\d+)\.nonce$/);
  if (!m || m[1] !== operationId) {
    throw new DeploymentStateError(
      `--nonce-out must match <operation-id>.<generation>.nonce for operation-id '${operationId}', got '${base}'`,
      'shape'
    );
  }
  const generation = Number(m[2]);
  if (!Number.isInteger(generation) || generation <= 0) {
    throw new DeploymentStateError('--nonce-out generation must be a positive integer', 'shape');
  }
  return generation;
}

function readStrictNonceFile(noncePath, ctx) {
  lib.validatePermitNoncePath(noncePath);
  let stat;
  try { stat = fs.lstatSync(noncePath); } catch (error) {
    if (error.code === 'ENOENT') throw new DeploymentStateError(`${ctx} does not exist`, 'nonce-missing');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DeploymentStateError(`${ctx} must be a regular non-symlink file`, 'symlink-rejected');
  }
  if (stat.uid !== process.getuid()) throw new DeploymentStateError(`${ctx} has an unexpected owner`, 'wrong-owner');
  if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
    throw new DeploymentStateError(`${ctx} must be mode 0600 with one link`, 'wrong-mode');
  }
  const raw = fs.readFileSync(noncePath);
  const after = fs.lstatSync(noncePath);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
      || after.mode !== stat.mode || after.uid !== stat.uid || after.gid !== stat.gid
      || after.size !== stat.size || after.nlink !== stat.nlink) {
    throw new DeploymentStateError(`${ctx} changed while being read`, 'nonce-mismatch');
  }
  let content;
  try { content = JSON.parse(raw); } catch (error) {
    throw new DeploymentStateError(`${ctx} is invalid JSON`, 'nonce-mismatch');
  }
  lib.assertExactFields(content, ['nonce'], ctx);
  if (typeof content.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(content.nonce)) {
    throw new DeploymentStateError(`${ctx} nonce has an invalid shape`, 'nonce-mismatch');
  }
  return { stat, raw, content };
}

function launchTokenPathForNonce(noncePath) {
  if (!noncePath.endsWith('.nonce')) throw new DeploymentStateError('probe nonce path must end in .nonce', 'shape');
  const tokenPath = `${noncePath.slice(0, -'.nonce'.length)}.launch-token.json`;
  lib.validatePermitNoncePath(tokenPath);
  return tokenPath;
}

function readStrictLaunchToken(tokenPath, permit, ctx = 'launch-token') {
  const token = readStrictAuthorityFile(tokenPath, ctx, { mode: 0o600 });
  let content;
  try { content = JSON.parse(token.raw); } catch (_error) {
    throw new DeploymentStateError(`${ctx} is invalid JSON`, 'launch-token-mismatch');
  }
  lib.assertExactFields(content, ['format', 'operationId', 'permitGeneration', 'token'], ctx);
  if (content.format !== 1 || content.operationId !== permit.operationId
      || content.permitGeneration !== permit.generation
      || typeof content.token !== 'string' || !/^[0-9a-f]{64}$/.test(content.token)
      || lib.sha256Hex(content.token) !== permit.launchAuthorization.tokenSha256) {
    throw new DeploymentStateError(`${ctx} does not bind the recorded launch authorization`, 'launch-token-mismatch');
  }
  return { ...token, content };
}

function procStartTime(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    const fields = close < 0 ? [] : raw.slice(close + 1).trim().split(/\s+/);
    return fields.length >= 20 && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch (_error) { return null; }
}

function parseLaunchProcStat(rawStat, expectedPid) {
  const open = rawStat.indexOf('(');
  const close = rawStat.lastIndexOf(')');
  const parsedPid = Number(open > 0 ? rawStat.slice(0, open).trim() : NaN);
  const fields = close < 0 ? [] : rawStat.slice(close + 1).trim().split(/\s+/);
  if (parsedPid !== expectedPid || fields.length < 20 || !/^\d+$/.test(fields[19])) return null;
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  if (![parentPid, processGroupId, sessionId].every(Number.isInteger)) return null;
  return {
    state: fields[0], parentPid, processGroupId, sessionId, processStartTime: fields[19],
  };
}

function readLaunchProcess(pid, { readFileSync = fs.readFileSync, maxAttempts = 2 } = {}) {
  const readBytes = (file) => {
    const value = readFileSync(file);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  };
  const sameProcess = (left, right) => left && right
    && left.parentPid === right.parentPid
    && left.processGroupId === right.processGroupId
    && left.sessionId === right.sessionId
    && left.processStartTime === right.processStartTime;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const first = parseLaunchProcStat(String(readFileSync(`/proc/${pid}/stat`, 'utf8')), pid);
      const argvFirst = readBytes(`/proc/${pid}/cmdline`);
      let environFirst = null;
      try { environFirst = readBytes(`/proc/${pid}/environ`); } catch (_error) { /* permission-denied is stable only if repeated */ }
      const middle = parseLaunchProcStat(String(readFileSync(`/proc/${pid}/stat`, 'utf8')), pid);
      const argvSecond = readBytes(`/proc/${pid}/cmdline`);
      let environSecond = null;
      try { environSecond = readBytes(`/proc/${pid}/environ`); } catch (_error) { /* see above */ }
      const last = parseLaunchProcStat(String(readFileSync(`/proc/${pid}/stat`, 'utf8')), pid);
      const environmentStable = (environFirst === null && environSecond === null)
        || (environFirst !== null && environSecond !== null && environFirst.equals(environSecond));
      if (!sameProcess(first, middle) || !sameProcess(middle, last)
          || !argvFirst.equals(argvSecond) || !environmentStable) {
        continue;
      }
      const argv = argvSecond.toString('utf8').split('\0').filter(Boolean);
      const environ = environSecond === null ? [] : environSecond.toString('utf8').split('\0');
      return {
        pid,
        state: last.state,
        parentPid: last.parentPid,
        processGroupId: last.processGroupId,
        sessionId: last.sessionId,
        processStartTime: last.processStartTime,
        environ,
        argv,
        argvSha256: lib.sha256Hex(Buffer.from(JSON.stringify(argv))),
      };
    } catch (_error) {
      // A disappearing/replaced proc entry is not process authority. Retry
      // once to tolerate a transient read boundary, then fail closed.
    }
  }
  return null;
}

function launchTokenFromEnvironment(processFacts) {
  const entry = processFacts.environ.find((value) => value.startsWith('OSI_DEPLOY_LAUNCH_TOKEN='));
  return entry ? entry.slice('OSI_DEPLOY_LAUNCH_TOKEN='.length) : null;
}

function launchGatePathForToken(tokenPath) {
  if (!tokenPath.endsWith('.launch-token.json')) {
    throw new DeploymentStateError('launch-token path has no canonical gate peer', 'launch-token-mismatch');
  }
  const gatePath = `${tokenPath.slice(0, -'.launch-token.json'.length)}.launch-gate`;
  lib.validatePermitNoncePath(gatePath);
  return gatePath;
}

function launchSpawnerIdentityPathForToken(tokenPath) {
  if (!tokenPath.endsWith('.launch-token.json')) {
    throw new DeploymentStateError('launch-token path has no canonical spawner peer', 'launch-token-mismatch');
  }
  const identityPath = `${tokenPath.slice(0, -'.launch-token.json'.length)}.launch-spawner.json`;
  lib.validatePermitNoncePath(identityPath);
  return identityPath;
}

function launchSpawnerPeerPathsForToken(tokenPath) {
  if (!tokenPath.endsWith('.launch-token.json')) {
    throw new DeploymentStateError('launch-token path has no canonical spawner peers', 'launch-token-mismatch');
  }
  const stem = tokenPath.slice(0, -'.launch-token.json'.length);
  const peers = {
    childIdentityPath: `${stem}.launch-child.json`,
    spawnerIdentityPath: `${stem}.launch-spawner.json`,
    spawnGatePath: `${stem}.launch-spawn-gate`,
  };
  for (const peer of Object.values(peers)) lib.validatePermitNoncePath(peer);
  return peers;
}

function classifyLaunchProcess(processFacts, tokenSha256, marker, gatePath, carrierArgvSha256 = null) {
  if (!processFacts || processFacts.state === 'Z') return null;
  const token = launchTokenFromEnvironment(processFacts);
  const environmentMatches = Boolean(token && lib.sha256Hex(token) === tokenSha256);
  if (processFacts.argvSha256 === marker.nodeRedLaunch.argvSha256) {
    return environmentMatches ? 'target' : null;
  }
  const launcher = marker.residents.guardedLauncher.path;
  const prefix = ['/bin/sh', launcher, '--gated-child', gatePath,
    '--launch-token-sha256', tokenSha256, '--'];
  const carrierShape = processFacts.argv.length > prefix.length
    && prefix.every((value, index) => processFacts.argv[index] === value)
    && processFacts.argv[prefix.length] === marker.nodeRedLaunch.executable
    && lib.sha256Hex(Buffer.from(JSON.stringify(processFacts.argv.slice(prefix.length))))
      === marker.nodeRedLaunch.argvSha256;
  if (!carrierShape) {
    if (carrierArgvSha256 && processFacts.argvSha256 === carrierArgvSha256) return 'carrier';
    return null;
  }
  return environmentMatches ? 'carrier' : null;
}

function classifyUnrecordedLaunchSpawner(processFacts, tokenSha256, marker, gatePath, tokenPath) {
  if (!processFacts || processFacts.state === 'Z') return null;
  const token = launchTokenFromEnvironment(processFacts);
  if (!token || lib.sha256Hex(token) !== tokenSha256) return null;
  const peers = launchSpawnerPeerPathsForToken(tokenPath);
  const argv = processFacts.argv;
  const launcher = marker.residents.guardedLauncher.path;
  const shape = argv.length > 9
    && argv[0] === '/usr/bin/node'
    && argv[1] === '-'
    && argv[2] === peers.childIdentityPath
    && argv[3] === peers.spawnerIdentityPath
    && argv[4] === peers.spawnGatePath
    && /^\d+$/.test(argv[5])
    && /^\d+$/.test(argv[6])
    && argv[7] === launcher
    && argv[8] === gatePath
    && argv[9] === marker.nodeRedLaunch.executable
    && lib.sha256Hex(Buffer.from(JSON.stringify(argv.slice(9)))) === marker.nodeRedLaunch.argvSha256;
  return shape ? 'spawner' : null;
}

function carrierArgvSha256ForSpawner(processFacts, marker, gatePath, tokenSha256) {
  if (!processFacts || processFacts.argv.length <= 9
      || processFacts.argv[0] !== '/usr/bin/node' || processFacts.argv[1] !== '-') {
    throw new DeploymentStateError('spawner process has no exact target argv for carrier binding', 'launch-abort-identity-missing');
  }
  const targetArgv = processFacts.argv.slice(9);
  if (targetArgv[0] !== marker.nodeRedLaunch.executable
      || lib.sha256Hex(Buffer.from(JSON.stringify(targetArgv))) !== marker.nodeRedLaunch.argvSha256) {
    throw new DeploymentStateError('spawner process target argv differs from the guard marker', 'launch-token-mismatch');
  }
  const carrierArgv = ['/bin/sh', marker.residents.guardedLauncher.path, '--gated-child', gatePath,
    '--launch-token-sha256', tokenSha256, '--', ...targetArgv];
  return lib.sha256Hex(Buffer.from(JSON.stringify(carrierArgv)));
}

function findAuthorizedLaunchChildren(tokenSha256, marker, gatePath, carrierArgvSha256 = null,
  launchTokenPath = null) {
  const matches = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const facts = readLaunchProcess(pid);
    const phase = classifyLaunchProcess(facts, tokenSha256, marker, gatePath, carrierArgvSha256);
    if (phase) matches.push({ ...facts, phase });
    if (launchTokenPath && !phase) {
      const spawnerPhase = classifyUnrecordedLaunchSpawner(facts, tokenSha256, marker, gatePath, launchTokenPath);
      if (spawnerPhase) matches.push({ ...facts, phase: spawnerPhase });
    }
  }
  if (launchTokenPath) {
    const spawnerIdentityPath = launchSpawnerIdentityPathForToken(launchTokenPath);
    let spawner;
    try {
      const authority = readStrictAuthorityFile(spawnerIdentityPath, 'launch spawner identity', { mode: 0o600 });
      let content;
      try { content = JSON.parse(authority.raw); } catch (_error) { throw new DeploymentStateError('launch spawner identity is invalid JSON', 'launch-token-mismatch'); }
      lib.assertExactFields(content, ['argvSha256', 'format', 'pid', 'processStartTime'], 'launch spawner identity');
      if (content.format !== 1 || !Number.isInteger(content.pid) || content.pid <= 0
          || typeof content.processStartTime !== 'string' || !/^\d+$/.test(content.processStartTime)
          || typeof content.argvSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(content.argvSha256)) {
        throw new DeploymentStateError('launch spawner identity has an invalid shape', 'launch-token-mismatch');
      }
      const facts = readLaunchProcess(content.pid);
      const token = facts && launchTokenFromEnvironment(facts);
      if (facts && facts.state !== 'Z' && facts.processStartTime === content.processStartTime
          && facts.argvSha256 === content.argvSha256 && token && lib.sha256Hex(token) === tokenSha256) {
        spawner = { ...facts, phase: 'spawner' };
      }
    } catch (error) {
      if (!(error instanceof DeploymentStateError && error.code === 'not-found')) throw error;
    }
    if (spawner && !matches.some((match) => match.pid === spawner.pid)) matches.push(spawner);
  }
  if (matches.length > 1) throw new DeploymentStateError('multiple processes claim one launch token', 'launch-token-replayed');
  return matches[0] || null;
}

function processInstanceRunning(pid, processStartTime) {
  const facts = readLaunchProcess(pid);
  return Boolean(facts && facts.state !== 'Z' && facts.processStartTime === processStartTime);
}

function terminateLaunchProcess(processFacts) {
  if (!processFacts || !processInstanceRunning(processFacts.pid, processFacts.processStartTime)) return;
  const privateGroup = processFacts.processGroupId === processFacts.pid && processFacts.sessionId === processFacts.pid;
  const target = privateGroup ? -processFacts.pid : processFacts.pid;
  try { process.kill(target, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 20 && processInstanceRunning(processFacts.pid, processFacts.processStartTime); i += 1) sleep(25);
  if (processInstanceRunning(processFacts.pid, processFacts.processStartTime)) {
    try { process.kill(target, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let i = 0; i < 20 && processInstanceRunning(processFacts.pid, processFacts.processStartTime); i += 1) sleep(25);
  if (processInstanceRunning(processFacts.pid, processFacts.processStartTime)) {
    throw new DeploymentStateError('revoked launch process did not terminate', 'launch-termination-failed');
  }
}

function finishLaunchTokenCleanup(tokenPath) {
  try { fs.unlinkSync(tokenPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  lib.fsyncDir(path.dirname(tokenPath));
}

function finishLaunchSpawnerCleanup(tokenPath) {
  const identityPath = launchSpawnerIdentityPathForToken(tokenPath);
  try { fs.unlinkSync(identityPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  lib.fsyncDir(path.dirname(identityPath));
}

function publishLaunchToken(tokenPath, permit) {
  try {
    lib.writeJsonExclusive(tokenPath, {
      format: 1, operationId: permit.operationId, permitGeneration: permit.generation,
      token: crypto.randomBytes(32).toString('hex'),
    }, { crashLabelPrefix: 'launch-token' });
  } catch (error) {
    if (error.code !== 'exclusive-create-conflict') throw error;
  }
  const tokenRaw = readStrictAuthorityFile(tokenPath, 'launch-token', { mode: 0o600 });
  let launchToken;
  try { launchToken = JSON.parse(tokenRaw.raw); } catch (_error) {
    throw new DeploymentStateError('launch-token is invalid JSON', 'launch-token-mismatch');
  }
  lib.assertExactFields(launchToken, ['format', 'operationId', 'permitGeneration', 'token'], 'launch-token');
  if (launchToken.format !== 1 || launchToken.operationId !== permit.operationId
      || launchToken.permitGeneration !== permit.generation
      || typeof launchToken.token !== 'string' || !/^[0-9a-f]{64}$/.test(launchToken.token)) {
    throw new DeploymentStateError('launch-token does not bind this permit generation', 'launch-token-mismatch');
  }
  return launchToken;
}

function authorizedLaunch({ tokenPath, token, marker, now, attempt, previousAbortReceiptSha256,
  supervisorPid, supervisorProcessStartTime }) {
  return {
    format: 2,
    status: 'authorized',
    tokenPath,
    tokenSha256: lib.sha256Hex(token),
    argvSha256: marker.nodeRedLaunch.argvSha256,
    carrierArgvSha256: null,
    authorizedAt: now,
    attempt,
    previousAbortReceiptSha256,
    supervisorPid,
    supervisorProcessStartTime,
    childPid: null,
    childProcessStartTime: null,
    startedAt: null,
    abortReceipt: null,
    abortReceiptSha256: null,
  };
}

function recordLaunchAbort({ args, current, parent, sub, permit, launch, marker, processFacts, processPhase }) {
  const abortedAt = nowIso();
  const childPid = processFacts ? processFacts.pid : launch.childPid;
  const childProcessStartTime = processFacts ? processFacts.processStartTime : launch.childProcessStartTime;
  const carrierArgvSha256 = launch.carrierArgvSha256 || (processPhase === 'spawner'
    ? carrierArgvSha256ForSpawner(processFacts, marker, launchGatePathForToken(launch.tokenPath), launch.tokenSha256)
    : processFacts && processFacts.argvSha256);
  if (!childPid || !childProcessStartTime || !carrierArgvSha256) {
    throw new DeploymentStateError('cannot bind launch abort to an exact process identity', 'launch-abort-identity-missing');
  }
  const abortReceipt = {
    format: 1,
    reason: 'supervisor-missing-during-retry',
    processPhase,
    supervisorPid: launch.supervisorPid,
    supervisorProcessStartTime: launch.supervisorProcessStartTime,
    childPid,
    childProcessStartTime,
    carrierArgvSha256,
    targetArgvSha256: marker.nodeRedLaunch.argvSha256,
    abortedAt,
  };
  const abortReceiptSha256 = lib.canonicalHash(abortReceipt);
  const abortedLaunch = {
    ...launch,
    status: 'launch-aborted',
    carrierArgvSha256,
    childPid,
    childProcessStartTime,
    abortReceipt,
    abortReceiptSha256,
  };
  const abortedPermit = { ...permit, launchAuthorization: abortedLaunch };
  const abortedParent = {
    ...parent,
    generation: parent.generation + 1,
    updatedAt: abortedAt,
    probePermit: abortedPermit,
  };
  lib.validateParentDeployment(abortedParent);
  lib.writeState(args.state, { format: 2, parentDeployment: abortedParent, activeSubOperation: sub },
    { crashLabelPrefix: 'launch-abort:state' });
  lib.maybeCrash('launch-abort:after-state-before-termination');
  return { abortReceiptSha256, abortedLaunch };
}

function reauthorizeAbortedLaunch(args, marker, parent, sub, permit) {
  const launch = permit.launchAuthorization;
  const gatePath = launchGatePathForToken(launch.tokenPath);
  const discovered = findAuthorizedLaunchChildren(launch.tokenSha256, marker, gatePath,
    launch.carrierArgvSha256, launch.tokenPath);
  if (discovered) {
    if (launch.childPid && discovered.pid === launch.childPid
        && launch.childProcessStartTime && discovered.processStartTime !== launch.childProcessStartTime) {
      throw new DeploymentStateError('aborted launch PID now has an unbound identity', 'current-identity-mismatch');
    }
    terminateLaunchProcess(discovered);
  }
  finishLaunchTokenCleanup(launch.tokenPath);
  finishLaunchSpawnerCleanup(launch.tokenPath);
  const token = publishLaunchToken(launch.tokenPath, permit);
  const now = nowIso();
  const nextLaunch = authorizedLaunch({
    tokenPath: launch.tokenPath,
    token: token.token,
    marker,
    now,
    attempt: launch.attempt + 1,
    previousAbortReceiptSha256: launch.abortReceiptSha256,
    supervisorPid: args['supervisor-pid'],
    supervisorProcessStartTime: args['supervisor-process-starttime'],
  });
  const nextPermit = { ...permit, launchAuthorization: nextLaunch };
  const nextParent = {
    ...parent,
    generation: parent.generation + 1,
    updatedAt: now,
    probePermit: nextPermit,
  };
  lib.validateParentDeployment(nextParent);
  lib.writeState(args.state, { format: 2, parentDeployment: nextParent, activeSubOperation: sub },
    { crashLabelPrefix: 'launch-reauthorize:state' });
  return { ok: true, verb: 'startup-check', service: 'node-red', pass: true, consumed: true,
    resumed: true, reauthorized: true, launchTokenPath: launch.tokenPath };
}

function verbIssueProbePermit(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'operation-id', 'expected-phase', 'purpose', 'service', 'identity', 'nonce-out'],
  });

  if (!lib.PROBE_PERMIT_PURPOSES.includes(args.purpose)) {
    throw new DeploymentStateError(`unknown purpose: ${args.purpose}`, 'shape');
  }
  if (args.service !== 'node-red') {
    throw new DeploymentStateError(
      "issue-probe-permit requires --service node-red (osi-identityd/osi-bootstrap/osi-db-integrity have no probe-permit path)",
      'shape'
    );
  }
  if (!path.isAbsolute(args['nonce-out'])) {
    throw new DeploymentStateError('--nonce-out must be an absolute path', 'shape');
  }
  lib.validatePermitNoncePath(args['nonce-out']);

  const identity = readRootOnlyJsonFile(args.identity, '--identity');
  lib.assertExactFields(identity, PROBE_IDENTITY_FIELDS, 'identity');
  for (const field of PROBE_IDENTITY_FIELDS) {
    lib.assertSha256Hex(identity[field], `identity.${field}`);
  }

  return lib.withStateMutation(args.state, args['operation-id'], () => issueProbePermitLocked(args, identity));
}

function issueProbePermitLocked(args, identity) {
  const current = lib.readState(args.state);
  if (!current) {
    throw new DeploymentStateError('no deployment state', 'state-missing');
  }
  const parent = current.parentDeployment;

  let target;
  if (args.purpose === 'deployment-probe') {
    if (parent.deploymentId !== args['operation-id']) {
      throw new DeploymentStateError('--operation-id does not match current state', 'operation-id-mismatch');
    }
    if (parent.phase !== 'probes-running') {
      throw new DeploymentStateError(
        `deployment-probe permits may only be issued at phase 'probes-running', current phase is '${parent.phase}'`,
        'cas-mismatch'
      );
    }
    if (args['expected-phase'] !== parent.phase) {
      throw new DeploymentStateError('--expected-phase mismatch', 'cas-mismatch');
    }
    target = 'parent';
  } else if (args.purpose === 'recovery-health') {
    throw new DeploymentStateError(
      'recovery-health requires clean database-restore or DATABASE_RESTORE_RECONCILED authority not represented in this slice',
      'purpose-not-satisfiable'
    );
  } else {
    throw new DeploymentStateError(
      `purpose '${args.purpose}' has no satisfiable context in this slice (no rehearsal/integrity-recovery sub-operation exists)`,
      'purpose-not-satisfiable'
    );
  }

  const targetObject = target === 'parent' ? parent : current.activeSubOperation;
  const existingPermit = targetObject.probePermit || null;
  const nowMs = Date.now();
  if (existingPermit && existingPermit.status === 'issued' && Date.parse(existingPermit.expiresAt) > nowMs) {
    throw new DeploymentStateError('a live probe permit is already issued for this operation', 'permit-already-issued');
  }

  const expectedGeneration = existingPermit ? existingPermit.generation + 1 : 1;
  const actualGeneration = parseNonceOutGeneration(args['nonce-out'], args['operation-id']);
  if (actualGeneration !== expectedGeneration) {
    throw new DeploymentStateError(
      `--nonce-out generation must be ${expectedGeneration} (monotonic per operation-id)`,
      'generation-mismatch'
    );
  }

  // Crash-resume: if a nonce file already exists at exactly the expected
  // generation's path, and we got this far, state has no live permit
  // referencing it (checked above) -- the only way that combination can
  // happen is a prior invocation that fsynced the nonce file and then
  // crashed before the state CAS below landed. Reuse that already-fsynced
  // nonce deterministically instead of failing closed and orphaning the
  // generation; a genuinely different, unrelated conflicting file cannot
  // occur because generation numbers only advance past state that already
  // recorded a permit.
  let nonceSha256;
  try {
    const written = lib.writeJsonExclusive(args['nonce-out'], { nonce: crypto.randomBytes(32).toString('hex') }, { crashLabelPrefix: 'nonce' });
    nonceSha256 = lib.sha256Hex(lib.readJsonFile(written.path).nonce);
  } catch (err) {
    if (err.code !== 'exclusive-create-conflict') throw err;
    const existing = readStrictNonceFile(args['nonce-out'], '--nonce-out (resume)').content;
    if (typeof existing.nonce !== 'string' || existing.nonce.length === 0) {
      throw new DeploymentStateError('orphaned nonce file is malformed and cannot be resumed', 'nonce-resume-malformed');
    }
    nonceSha256 = lib.sha256Hex(existing.nonce);
  }

  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + PROBE_PERMIT_EXPIRY_MS).toISOString();
  const permit = {
    purpose: args.purpose,
    operationId: args['operation-id'],
    deploymentId: parent.deploymentId,
    phaseAtIssuance: args['expected-phase'],
    holderGenerationAtIssuance: targetObject.generation + 1,
    service: 'node-red',
    candidateSha256: identity.candidateSha256,
    databaseIdentitySha256: identity.databaseIdentitySha256,
    mountIdentitySha256: identity.mountIdentitySha256,
    lockOwnerSha256: identity.lockOwnerSha256,
    bootId: lib.getBootId(),
    noncePath: args['nonce-out'],
    nonceSha256,
    generation: actualGeneration,
    status: 'issued',
    launchAuthorization: null,
    issuedAt,
    expiresAt,
  };
  lib.validateProbePermit(permit, 'probePermit');

  const nextParent = { ...parent, generation: parent.generation + 1, updatedAt: issuedAt };
  let nextSub = current.activeSubOperation;
  if (target === 'parent') {
    nextParent.probePermit = permit;
  } else {
    nextSub = { ...current.activeSubOperation, probePermit: permit };
  }
  lib.validateParentDeployment(nextParent);
  if (nextSub) lib.validateActiveSubOperation(nextSub, nextParent);
  lib.writeState(args.state, { format: 2, parentDeployment: nextParent, activeSubOperation: nextSub });

  // Only the path is returned, never the raw nonce (no secrets in output).
  return { ok: true, verb: 'issue-probe-permit', noncePath: args['nonce-out'], generation: actualGeneration, expiresAt };
}

function assertNoSymlinkAncestors(rootPath) {
  const absolute = path.resolve(rootPath);
  const pieces = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const piece of pieces) {
    current = path.join(current, piece);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new DeploymentStateError(`startup root ancestor is a symlink: ${current}`, 'symlink-rejected');
    if (!stat.isDirectory()) throw new DeploymentStateError(`startup root ancestor is not a directory: ${current}`, 'shape');
  }
  if (fs.realpathSync(absolute) !== absolute) throw new DeploymentStateError('startup root resolves through an alias', 'mount-alias');
}

function startupTestBoundary(rootPath, options) {
  const boundary = path.join('/tmp', `osi-deploy-startup-tests-${process.getuid()}`);
  const resolved = path.resolve(rootPath);
  const requested = options.mountInfoText !== undefined || process.env.OSI_DEPLOY_STARTUP_TEST_MOUNTINFO;
  if (!requested) return null;
  const artifactMode = options.artifactMode || process.env.OSI_DEPLOY_ARTIFACT_MODE;
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || artifactMode !== 'test' ||
      (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) ||
      ['/data', '/srv', '/etc', '/usr/lib', '/'].some((protectedRoot) => resolved === protectedRoot || resolved.startsWith(`${protectedRoot}/`))) {
    throw new DeploymentStateError('startup mount test adapter is outside the fixed non-live test boundary', 'unsafe-test-adapter');
  }
  if (options.mountInfoText !== undefined) return { text: options.mountInfoText, expectedMountPoint: resolved };
  const adapterPath = process.env.OSI_DEPLOY_STARTUP_TEST_MOUNTINFO;
  if (path.dirname(adapterPath) !== resolved) throw new DeploymentStateError('startup mount test adapter must be inside the tested root', 'unsafe-test-adapter');
  const stat = fs.lstatSync(adapterPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new DeploymentStateError('startup mount test adapter is unsafe', 'unsafe-test-adapter');
  return { text: fs.readFileSync(adapterPath, 'utf8'), expectedMountPoint: resolved };
}

function computeMountIdentity(rootPath, options = {}) {
  assertNoSymlinkAncestors(rootPath);
  const rootRealpath = fs.realpathSync(rootPath);
  const testBoundary = startupTestBoundary(rootPath, options);
  const production = rootRealpath === '/data' || rootRealpath.startsWith('/data/');
  if (!production && !testBoundary) throw new DeploymentStateError('startup authority must be under the mounted /data filesystem', 'mount-authority');
  const mountInfoText = testBoundary ? testBoundary.text : fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const profile = lib.validatePersistentMountProfile(rootRealpath, mountInfoText, {
    simulatedRoot: testBoundary ? testBoundary.expectedMountPoint : null,
  });
  // mountinfo's mount ID, parent ID, and propagation group IDs are kernel-
  // generated for each mount namespace and remount. They are useful while
  // parsing one snapshot but cannot be persisted as reboot-stable identity.
  // Keep only the durable filesystem/location facts and canonicalize option
  // ordering before hashing the guard authority.
  const stableMountFacts = (mount) => ({
    majorMinor: mount.majorMinor,
    mountRoot: mount.mountRoot,
    point: mount.point,
    mountOptions: [...mount.mountOptions].sort(),
    fsType: mount.fsType,
    source: mount.source,
    superOptions: mount.superOptions.split(',').sort(),
  });
  const facts = {
    rootRealpath,
    mode: profile.mode,
    selected: stableMountFacts(profile.selected),
    ...(profile.backing ? { backing: stableMountFacts(profile.backing) } : {}),
  };
  return { facts, sha256: lib.canonicalHash(facts) };
}

function readStrictAuthorityFile(p, ctx, { mode = null } = {}) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) {
    throw new DeploymentStateError(`${ctx}.path must be absolute`, 'shape');
  }
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch (_err) {
    throw new DeploymentStateError(`${ctx} is missing: ${p}`, 'not-found');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DeploymentStateError(`${ctx} must be a regular non-symlink file: ${p}`, 'symlink-rejected');
  }
  if (stat.uid !== process.getuid()) {
    throw new DeploymentStateError(`${ctx} has an unexpected owner: ${p}`, 'wrong-owner');
  }
  if (mode !== null && (stat.mode & 0o777) !== mode) {
    throw new DeploymentStateError(`${ctx} has mode ${(stat.mode & 0o777).toString(8)}, expected ${mode.toString(8)}`, 'wrong-mode');
  }
  return { stat, raw: fs.readFileSync(p) };
}

const LIVE_CONTROL_PATHS = Object.freeze([
  '/etc/init.d/node-red', '/etc/init.d/osi-bootstrap', '/etc/init.d/osi-db-integrity', '/etc/init.d/osi-identityd',
  '/usr/libexec/osi-gateway-identity.sh', '/usr/libexec/osi-identityd.sh',
  '/etc/init.d/osi-deployment-inhibit', '/usr/libexec/osi-deployment-inhibit.sh',
  '/etc/uci-defaults/94_osi_identityd_enable',
  '/usr/libexec/osi-current-role-state', '/usr/libexec/osi-record-role-start',
]);
const SIX_APPLICATION_LINKS = Object.freeze([
  '/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd',
  '/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red',
  '/etc/rc.d/S99osi-bootstrap', '/etc/rc.d/S90osi-db-integrity',
]);

function validateLiveRoot(liveRootPath) {
  if (!path.isAbsolute(liveRootPath)) throw new DeploymentStateError('guard-marker.liveRootPath must be absolute', 'shape');
  const resolved = path.resolve(liveRootPath);
  const boundary = path.join('/tmp', `osi-deploy-startup-tests-${process.getuid()}`);
  const testRoot = process.env.OSI_REPAIR_PROGRAM_MODE === '1' && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
    && (resolved === boundary || resolved.startsWith(`${boundary}${path.sep}`));
  if (resolved !== '/' && !testRoot) {
    throw new DeploymentStateError('guard-marker.liveRootPath must be the production root filesystem', 'marker-binding-mismatch');
  }
  assertNoSymlinkAncestors(resolved);
  return resolved;
}

function livePath(liveRootPath, absolutePath) {
  if (!path.isAbsolute(absolutePath)) throw new DeploymentStateError('live authority path must be absolute', 'shape');
  const resolved = path.resolve(liveRootPath, `.${absolutePath}`);
  if (liveRootPath !== '/' && resolved !== liveRootPath && !resolved.startsWith(`${liveRootPath}${path.sep}`)) {
    throw new DeploymentStateError('live authority path escapes liveRootPath', 'marker-binding-mismatch');
  }
  let cursor = liveRootPath;
  for (const part of path.relative(liveRootPath, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw new DeploymentStateError(`live authority has a symlink ancestor: ${cursor}`, 'symlink-rejected');
    if (!stat.isDirectory()) throw new DeploymentStateError(`live authority ancestor is not a directory: ${cursor}`, 'shape');
  }
  return resolved;
}

function currentSixLinkTopologySha256(liveRootPath) {
  return lib.canonicalHash({ entries: lib.collectTopologyPathSet(liveRootPath, SIX_APPLICATION_LINKS) });
}

function currentUciIdentitySha256(liveRootPath) {
  return lib.topologyUciIdentitySha256(liveRootPath);
}

function assertCurrentRestorationProofAuthority(proof) {
  const content = proof.content;
  const liveRootPath = validateLiveRoot(content.liveRootPath);
  const review = content.uciReview;
  if (review.decision === 'preserve-healed') {
    const comparison = readStrictAuthorityFile(review.comparisonPath,
      'topology restoration proof UCI comparison', { mode: 0o600 });
    if (lib.sha256Hex(comparison.raw) !== review.comparisonSha256) {
      throw new DeploymentStateError('reviewed healed UCI comparison bytes changed', 'proof-mismatch');
    }
    let value;
    try { value = JSON.parse(comparison.raw.toString('utf8')); } catch (_error) {
      throw new DeploymentStateError('reviewed healed UCI comparison is invalid JSON', 'proof-mismatch');
    }
    lib.assertExactFields(value, [
      'format', 'deploymentId', 'previousUciIdentitySha256', 'healedUciIdentitySha256', 'decision',
    ], 'reviewed healed UCI comparison');
    if (value.format !== 1 || value.deploymentId !== content.deploymentId
        || value.previousUciIdentitySha256 !== review.previousUciIdentitySha256
        || value.healedUciIdentitySha256 !== review.healedUciIdentitySha256
        || value.decision !== 'preserve-healed') {
      throw new DeploymentStateError('reviewed healed UCI comparison does not bind the restoration proof', 'proof-mismatch');
    }
  }
  const current = lib.liveTopologyIdentity(liveRootPath);
  const mismatches = [
    ['restoredTopologySha256', current.restoredTopologySha256],
    ['restoredMetadataSha256', current.restoredMetadataSha256],
    ['sixLinkTopologySha256', current.sixLinkTopologySha256],
    ['uciIdentitySha256', current.uciIdentitySha256],
  ].filter(([field, measured]) => measured !== content[field]).map(([field]) => field);
  if (mismatches.length > 0) {
    throw new DeploymentStateError(
      `current live authority differs from the immutable restoration proof: ${mismatches.join(',')}`,
      'current-control-mismatch'
    );
  }
  return liveRootPath;
}

function assertCurrentTargetSafetyAuthority(proof, installedFacts = null) {
  const content = proof.content;
  const liveRootPath = validateLiveRoot(content.liveRootPath);
  const manifest = lib.readAndVerifyTargetSafetyManifest({
    manifestPath: content.targetSafetyManifestPath,
    expectedSha256: content.targetSafetyManifestSha256,
    deploymentId: content.deploymentId,
    guardGenerationSha256: content.guardGenerationSha256,
    liveRootPath,
  });
  if (installedFacts) {
    if (installedFacts.targetSafetyManifestSha256 !== manifest.sha256) {
      throw new DeploymentStateError('installed safety generation binds a different target-safety manifest', 'manifest-mismatch');
    }
    const entries = new Map(manifest.content.entries.map((entry) => [entry.path, entry]));
    const inhibitor = entries.get('/etc/init.d/osi-deployment-inhibit');
    const helper = entries.get('/usr/libexec/osi-deployment-inhibit.sh');
    const guard94 = entries.get('/etc/uci-defaults/94_osi_identityd_enable');
    const s01 = entries.get('/etc/rc.d/S01osi-deployment-inhibit');
    if (!inhibitor || inhibitor.type !== 'file' || inhibitor.sha256 !== installedFacts.inhibitorSha256
        || !helper || helper.type !== 'file' || helper.sha256 !== installedFacts.helperSha256
        || !guard94 || guard94.type !== 'file' || guard94.sha256 !== installedFacts.guardAware94Sha256
        || !s01 || s01.type !== 'symlink' || s01.target !== installedFacts.s01Target) {
      throw new DeploymentStateError('permanent safety hashes or S01 target differ from the installed guard generation', 'current-control-mismatch');
    }
  }
  return manifest;
}

function assertRestorationProofPredecessor(proof, expectedPredecessor) {
  const content = proof.content;
  const expectedSha256 = lib.restoredPredecessorSha256(expectedPredecessor);
  if (content.restoredPredecessorSha256 !== expectedSha256
      || lib.canonicalize(content.restoredPredecessor) !== lib.canonicalize(expectedPredecessor)) {
    throw new DeploymentStateError(
      'topology restoration proof does not bind the selected restored predecessor',
      'predecessor-mismatch'
    );
  }
  if (expectedPredecessor.kind === 'legacy-compatibility'
      && (expectedPredecessor.compatibilityManifestSha256 !== content.compatibilityManifestSha256
        || expectedPredecessor.topologySha256 !== content.restoredTopologySha256)) {
    throw new DeploymentStateError(
      'legacy predecessor manifest or topology differs from the restoration proof',
      'predecessor-mismatch'
    );
  }
  return expectedSha256;
}

function readGuardMarker(guardMarkerPath, args, {
  requireLiveLockOwner = true,
  validateQuarantineAuthority = true,
} = {}) {
  const markerFile = readStrictAuthorityFile(guardMarkerPath, '--guard-marker', { mode: 0o600 });
  let marker;
  try {
    marker = JSON.parse(markerFile.raw.toString('utf8'));
  } catch (err) {
    throw new DeploymentStateError(`--guard-marker contains invalid JSON: ${err.message}`, 'shape');
  }
  lib.assertExactFields(marker, [
    'format', 'deploymentId', 'rootPath', 'statePath', 'receiptsPath', 'mountIdentitySha256',
    'candidate', 'database', 'lockOwner', 'residents', 'nodeRedLaunch', 'liveRootPath',
    'liveControls', 'targetSafety', 'sixLinkTopologySha256', 'uciIdentitySha256',
  ], 'guard-marker');
  if (marker.format !== 1) throw new DeploymentStateError('guard-marker.format must be 1', 'shape');
  lib.assertString(marker.deploymentId, 'guard-marker.deploymentId');
  for (const [field, actual] of [['rootPath', args.root], ['statePath', args.state], ['receiptsPath', args.receipts]]) {
    if (actual !== undefined && marker[field] !== actual) {
      throw new DeploymentStateError(`guard-marker.${field} does not bind this invocation`, 'marker-binding-mismatch');
    }
  }
  if (args.root !== undefined && fs.realpathSync(marker.rootPath) !== fs.realpathSync(args.root)) {
    throw new DeploymentStateError('guard-marker root resolves somewhere else', 'marker-binding-mismatch');
  }
  lib.assertSha256Hex(marker.mountIdentitySha256, 'guard-marker.mountIdentitySha256');
  lib.assertExactFields(marker.nodeRedLaunch, ['executable', 'argvSha256'], 'guard-marker.nodeRedLaunch');
  if (!path.isAbsolute(marker.nodeRedLaunch.executable)) throw new DeploymentStateError('guard-marker.nodeRedLaunch.executable must be absolute', 'shape');
  lib.assertSha256Hex(marker.nodeRedLaunch.argvSha256, 'guard-marker.nodeRedLaunch.argvSha256');
  const mountIdentity = computeMountIdentity(marker.rootPath);
  if (mountIdentity.sha256 !== marker.mountIdentitySha256) {
    throw new DeploymentStateError('current mount identity differs from guard marker', 'mount-identity-mismatch');
  }

  const liveRootPath = validateLiveRoot(marker.liveRootPath);
  lib.assertExactFields(marker.targetSafety,
    ['manifestPath', 'manifestSha256', 'guardGenerationSha256'], 'guard-marker.targetSafety');
  lib.assertSha256Hex(marker.targetSafety.manifestSha256, 'guard-marker.targetSafety.manifestSha256');
  lib.assertSha256Hex(marker.targetSafety.guardGenerationSha256, 'guard-marker.targetSafety.guardGenerationSha256');
  lib.readAndVerifyTargetSafetyManifest({
    manifestPath: marker.targetSafety.manifestPath,
    expectedSha256: marker.targetSafety.manifestSha256,
    deploymentId: marker.deploymentId,
    guardGenerationSha256: marker.targetSafety.guardGenerationSha256,
    liveRootPath,
  });
  lib.assertSha256Hex(marker.sixLinkTopologySha256, 'guard-marker.sixLinkTopologySha256');
  lib.assertSha256Hex(marker.uciIdentitySha256, 'guard-marker.uciIdentitySha256');
  if (!Array.isArray(marker.liveControls) || marker.liveControls.length !== LIVE_CONTROL_PATHS.length
      || marker.liveControls.some((entry, index) => !entry || entry.path !== LIVE_CONTROL_PATHS[index])) {
    throw new DeploymentStateError('guard-marker.liveControls does not cover the exact fixed control inventory', 'marker-binding-mismatch');
  }
  for (const [index, control] of marker.liveControls.entries()) {
    lib.assertExactFields(control, ['path', 'sha256', 'mode'], `guard-marker.liveControls[${index}]`);
    lib.assertSha256Hex(control.sha256, `guard-marker.liveControls[${index}].sha256`);
    lib.assertPositiveInt(control.mode, `guard-marker.liveControls[${index}].mode`);
    if (validateQuarantineAuthority) {
      const current = readStrictAuthorityFile(livePath(liveRootPath, control.path), `guard-marker.liveControls[${index}]`, { mode: control.mode });
      if (lib.sha256Hex(current.raw) !== control.sha256) {
        throw new DeploymentStateError(`live control mismatch: ${control.path}`, 'current-control-mismatch');
      }
    }
  }
  if (validateQuarantineAuthority
      && (currentSixLinkTopologySha256(liveRootPath) !== marker.sixLinkTopologySha256
        || currentUciIdentitySha256(liveRootPath) !== marker.uciIdentitySha256)) {
    throw new DeploymentStateError('current six-link or UCI identity authority differs from guard marker', 'current-control-mismatch');
  }

  lib.assertExactFields(marker.candidate, ['path', 'sha256'], 'guard-marker.candidate');
  lib.assertSha256Hex(marker.candidate.sha256, 'guard-marker.candidate.sha256');
  lib.assertExactFields(marker.database, ['path', 'identitySha256'], 'guard-marker.database');
  lib.assertSha256Hex(marker.database.identitySha256, 'guard-marker.database.identitySha256');
  lib.assertExactFields(marker.lockOwner, ['path', 'sha256'], 'guard-marker.lockOwner');
  lib.assertSha256Hex(marker.lockOwner.sha256, 'guard-marker.lockOwner.sha256');
  if (path.basename(marker.lockOwner.path) !== 'owner.json') {
    throw new DeploymentStateError('guard-marker.lockOwner.path must name the exact volatile owner.json', 'marker-binding-mismatch');
  }
  lib.validateAttemptLockPath(path.dirname(marker.lockOwner.path));
  const candidate = readStrictAuthorityFile(marker.candidate.path, 'guard-marker.candidate', { mode: 0o600 });
  const database = readStrictAuthorityFile(marker.database.path, 'guard-marker.database', { mode: 0o600 });
  if (lib.sha256Hex(candidate.raw) !== marker.candidate.sha256
      || lib.canonicalHash({ device: database.stat.dev, inode: database.stat.ino }) !== marker.database.identitySha256) {
    throw new DeploymentStateError('current candidate/database identity differs from guard marker', 'current-identity-mismatch');
  }
  let verifiedLockOwner = null;
  if (requireLiveLockOwner) {
    const lockOwner = readStrictAuthorityFile(marker.lockOwner.path, 'guard-marker.lockOwner', { mode: 0o600 });
    if (lib.sha256Hex(lockOwner.raw) !== marker.lockOwner.sha256) {
      throw new DeploymentStateError('current lock-owner identity differs from guard marker', 'current-identity-mismatch');
    }
    try { verifiedLockOwner = lib.validateLockOwner(JSON.parse(lockOwner.raw.toString('utf8'))); } catch (error) {
      if (error instanceof DeploymentStateError) throw error;
      throw new DeploymentStateError('guard-marker.lockOwner is invalid JSON', 'shape');
    }
    if (verifiedLockOwner.bootId !== lib.getBootId()) {
      throw new DeploymentStateError('active guard marker lock owner is not from the current boot', 'boot-mismatch');
    }
  }

  lib.assertExactFields(marker.residents, ['stateLibrary', 'stateCli', 'guardedLauncher'], 'guard-marker.residents');
  for (const role of ['stateLibrary', 'stateCli', 'guardedLauncher']) {
    const resident = marker.residents[role];
    lib.assertExactFields(resident, ['path', 'sha256', 'mode'], `guard-marker.residents.${role}`);
    lib.assertSha256Hex(resident.sha256, `guard-marker.residents.${role}.sha256`);
    lib.assertPositiveInt(resident.mode, `guard-marker.residents.${role}.mode`);
    const live = readStrictAuthorityFile(resident.path, `guard-marker.residents.${role}`, { mode: resident.mode });
    if (lib.sha256Hex(live.raw) !== resident.sha256) {
      throw new DeploymentStateError(`resident control mismatch: ${role}`, 'resident-mismatch');
    }
  }
  return { marker, sha256: lib.sha256Hex(markerFile.raw), lockOwner: verifiedLockOwner };
}

function currentRoleAuthority(liveRootPath) {
  let raw;
  const adapterPath = process.env.OSI_DEPLOY_TEST_ROLE_STATE;
  if (adapterPath !== undefined) {
    const boundary = path.join('/tmp', `osi-deploy-startup-tests-${process.getuid()}`);
    const resolved = path.resolve(adapterPath);
    if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test'
        || (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`))) {
      throw new DeploymentStateError('role-state adapter is outside the fixed test boundary', 'unsafe-test-adapter');
    }
    raw = readStrictAuthorityFile(resolved, 'current role-state adapter', { mode: 0o600 }).raw;
  } else {
    if (liveRootPath !== '/') {
      throw new DeploymentStateError('non-production live roots require the fixed role-state test adapter', 'unsafe-test-adapter');
    }
    const result = childProcess.spawnSync('/usr/libexec/osi-current-role-state', ['--json'], {
      encoding: null,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw new DeploymentStateError('current role-state helper failed', 'current-role-state-failed');
    }
    raw = result.stdout;
  }
  let state;
  try { state = JSON.parse(raw.toString('utf8')); } catch (_error) {
    throw new DeploymentStateError('current role-state authority is invalid JSON', 'shape');
  }
  lib.assertExactFields(state, ['format', 'bootId', 'roles'], 'current role-state');
  if (state.format !== 1) throw new DeploymentStateError('current role-state.format must be 1', 'shape');
  lib.assertString(state.bootId, 'current role-state.bootId');
  lib.assertExactFields(state.roles, lib.GUARD_ROLES, 'current role-state.roles');
  const expectedLinks = {
    'osi-identityd': ['/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd'],
    'node-red': ['/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red'],
    'osi-bootstrap': ['/etc/rc.d/S99osi-bootstrap'],
    'osi-db-integrity': ['/etc/rc.d/S90osi-db-integrity'],
  };
  for (const role of lib.GUARD_ROLES) {
    const facts = state.roles[role];
    lib.assertExactFields(facts,
      ['running', 'ready', 'pid', 'processStartTime', 'generation', 'bootId', 'rcLinks'],
      `current role-state.roles.${role}`);
    if (typeof facts.running !== 'boolean' || typeof facts.ready !== 'boolean'
        || (facts.ready && !facts.running)) {
      throw new DeploymentStateError(`current role '${role}' readiness is invalid`, 'current-role-state-mismatch');
    }
    if (facts.running) {
      lib.assertPositiveInt(facts.pid, `current role-state.roles.${role}.pid`);
      lib.assertString(facts.processStartTime, `current role-state.roles.${role}.processStartTime`);
      if (!/^\d+$/.test(facts.processStartTime)) {
        throw new DeploymentStateError(`current role '${role}' process starttime is invalid`, 'current-role-state-mismatch');
      }
    } else if (facts.pid !== null || facts.processStartTime !== null) {
      throw new DeploymentStateError(`current role '${role}' stopped state claims a process`, 'current-role-state-mismatch');
    }
    lib.assertPositiveInt(facts.generation, `current role-state.roles.${role}.generation`);
    if (facts.bootId !== state.bootId) throw new DeploymentStateError(`current role '${role}' boot differs`, 'current-role-state-mismatch');
    if (!Array.isArray(facts.rcLinks) || facts.rcLinks.length !== expectedLinks[role].length) {
      throw new DeploymentStateError(`current role '${role}' lacks exact rc link evidence`, 'current-role-state-mismatch');
    }
    facts.rcLinks.forEach((link, index) => {
      if (link && link.state === 'symlink') {
        lib.assertExactFields(link, ['path', 'state', 'target'], `current role-state.roles.${role}.rcLinks[${index}]`);
        if (link.path !== expectedLinks[role][index] || link.target !== `../init.d/${role}`) {
          throw new DeploymentStateError(`current role '${role}' rc link target is invalid`, 'current-role-state-mismatch');
        }
      } else {
        lib.assertExactFields(link, ['path', 'state'], `current role-state.roles.${role}.rcLinks[${index}]`);
        if (link.path !== expectedLinks[role][index] || link.state !== 'absent') {
          throw new DeploymentStateError(`current role '${role}' rc link state is invalid`, 'current-role-state-mismatch');
        }
      }
    });
  }
  return state;
}

// The guard chain records the deployment-state role tuple (which includes
// `enabled` and uses `lifecycleGeneration`) while the resident role-state
// helper exposes the same authority with the shorter `generation` field.
// Keep this conversion in one place so epoch-start sampling and abandonment
// compare the exact same canonical tuple.
function guardRoleStatesFromAuthority(state) {
  return Object.fromEntries(Object.entries(state.roles).map(([role, facts]) => [role, {
    running: facts.running,
    ready: facts.ready,
    enabled: facts.rcLinks.every((link) => link.state === 'symlink'),
    pid: facts.pid,
    processStartTime: facts.processStartTime,
    lifecycleGeneration: facts.generation,
    bootId: facts.bootId,
    rcLinks: facts.rcLinks,
  }]));
}

function currentStoppedRoleAuthority(liveRootPath) {
  const state = currentRoleAuthority(liveRootPath);
  for (const [role, facts] of Object.entries(state.roles)) {
    if (facts.running !== false || facts.ready !== false || facts.pid !== null || facts.processStartTime !== null) {
      throw new DeploymentStateError(`current role '${role}' is running`, 'role-not-stopped');
    }
    if (facts.rcLinks.some((link) => link.state !== 'absent')) {
      throw new DeploymentStateError(`current role '${role}' rc link is not quarantined`, 'current-role-state-mismatch');
    }
  }
  return state;
}

function guardLiveRoot(guardBootstrapRoot) {
  const artifactTest = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
    && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test';
  return validateLiveRoot(artifactTest ? path.dirname(guardBootstrapRoot) : '/');
}

function assertPriorRoleAuthorityUnchanged(chain, guardBootstrapRoot) {
  const epochStart = [...chain.entries].reverse()
    .find((record) => record.entry.phase === 'epoch-start');
  const authority = epochStart ? epochStart.entry : chain.entries[0].entry;
  const current = currentRoleAuthority(guardLiveRoot(guardBootstrapRoot));
  const observed = guardRoleStatesFromAuthority(current);
  if (current.bootId !== authority.bootId
      || lib.canonicalize(observed) !== lib.canonicalize(authority.facts.priorRoleStates)) {
    throw new DeploymentStateError(
      'pre-mutation abandonment requires fresh exact proof that role and rc topology authority is untouched',
      'role-restoration-required'
    );
  }
  return lib.canonicalHash(observed);
}

function unresolvedGuardMutationAuthority(chain) {
  const mutationEntries = chain.entries
    .filter((record) => lib.GUARD_MUTATION_PHASES.includes(record.entry.phase));
  if (mutationEntries.length === 0) {
    return { mutationEntries, snapshot: null };
  }
  const firstMutation = mutationEntries[0];
  const snapshot = chain.entries.find((record) => (
    record.generation > firstMutation.generation
      && record.entry.bootEpoch === firstMutation.entry.bootEpoch
      && record.entry.phase === 'topology-snapshotted'
  )) || null;
  return { mutationEntries, snapshot };
}

function requireReceipt(receiptsDir, operationId, kind, expectedSha, ctx) {
  const receipt = lib.readReceipt(receiptsDir, operationId, kind);
  if (!receipt || receipt.sha256 !== expectedSha) {
    throw new DeploymentStateError(`${ctx} receipt is missing or does not match state`, 'receipt-mismatch');
  }
  return receipt;
}

function findReceiptBySha(receiptsDir, kind, expectedSha, ctx) {
  let names;
  try {
    names = fs.readdirSync(receiptsDir);
  } catch (_err) {
    throw new DeploymentStateError(`${ctx} receipt directory is missing`, 'receipt-missing');
  }
  const suffix = `.${kind}.json`;
  for (const name of names.sort()) {
    if (!name.endsWith(suffix)) continue;
    const operationId = name.slice(0, -suffix.length);
    const receipt = lib.readReceipt(receiptsDir, operationId, kind);
    if (receipt && receipt.sha256 === expectedSha) return receipt;
  }
  throw new DeploymentStateError(`${ctx} receipt is missing or does not match state`, 'receipt-mismatch');
}

function verifyTerminalAuthority(parent, receiptsDir, marker) {
  if (parent.phase === 'completed') {
    const deployment = requireReceipt(receiptsDir, parent.deploymentId, 'deployment', parent.deploymentReceiptSha256, 'deployment');
    const acceptance = requireReceipt(receiptsDir, parent.deploymentId, 'acceptance', parent.acceptanceReceiptSha256, 'acceptance');
    if (deployment.content.operationId !== parent.deploymentId ||
        acceptance.content.operationId !== parent.deploymentId ||
        deployment.content.deploymentId !== parent.deploymentId ||
        acceptance.content.deploymentId !== parent.deploymentId ||
        acceptance.content.deploymentReceiptSha256 !== deployment.sha256) {
      throw new DeploymentStateError('completed terminal receipt facts do not cross-bind', 'receipt-mismatch');
    }
    return 'terminal-completed';
  }
  if (parent.phase === 'recovered') {
    const recovery = requireReceipt(receiptsDir, parent.recoveryOperationId, 'recovery', parent.recoveryReceiptSha256, 'recovery');
    const topology = requireReceipt(receiptsDir, parent.recoveryOperationId, 'topology-activation', parent.topologyActivationReceiptSha256, 'topology-activation');
    const proof = lib.readTopologyRestorationProof(topology.content.topologyRestorationProofPath);
    assertRestorationProofPredecessor(proof, parent.restoredPredecessor);
    if (path.resolve(proof.content.liveRootPath) !== path.resolve(marker.liveRootPath)) {
      throw new DeploymentStateError('recovery proof live root differs from startup guard authority', 'proof-mismatch');
    }
    assertCurrentRestorationProofAuthority(proof);
    if (proof.content.targetSafetyManifestPath !== marker.targetSafety.manifestPath
        || proof.content.targetSafetyManifestSha256 !== marker.targetSafety.manifestSha256
        || proof.content.guardGenerationSha256 !== marker.targetSafety.guardGenerationSha256) {
      throw new DeploymentStateError('recovery proof target safety differs from startup guard marker', 'proof-mismatch');
    }
    assertCurrentTargetSafetyAuthority(proof);
    if (proof.sha256 !== topology.content.topologyRestorationProofSha256
        || proof.content.deploymentId !== parent.deploymentId
        || proof.content.compatibilityManifestSha256 !== topology.content.compatibilityManifestSha256
        || proof.content.sixLinkTopologySha256 !== topology.content.sixLinkTopologySha256
        || recovery.content.operationId !== parent.recoveryOperationId
        || recovery.content.parentDeploymentId !== parent.deploymentId
        || (parent.previousTerminal
          && recovery.content.parentReceiptsSha256 !== parent.previousTerminal.receiptsSha256)
        || recovery.content.restoredPredecessorSha256 !== parent.restoredPredecessorSha256
        || proof.content.restoredPredecessorSha256 !== parent.restoredPredecessorSha256
        || topology.content.operationId !== parent.recoveryOperationId
        || topology.content.deploymentId !== parent.deploymentId
        || topology.content.topologyOutcome !== 'restored') {
      throw new DeploymentStateError('recovered terminal receipt facts do not cross-bind', 'receipt-mismatch');
    }
    return 'terminal-recovered';
  }
  throw new DeploymentStateError(`phase '${parent.phase}' is not terminal startup authority`, 'phase-not-authorized');
}

function verifyTerminalReleaseAuthority(parent, marker) {
  const release = parent.lockRelease;
  if (!release || release.status !== 'released') {
    throw new DeploymentStateError('terminal startup requires durable released lock authority', 'lock-release-missing');
  }
  const expectedOperationId = parent.phase === 'completed' ? parent.deploymentId : parent.recoveryOperationId;
  const expectedFinalReceiptSha256 = parent.phase === 'completed'
    ? parent.acceptanceReceiptSha256 : parent.recoveryReceiptSha256;
  let ownerChainMatches = release.lockOwnerSha256 === marker.lockOwner.sha256;
  if (parent.phase === 'recovered') {
    const handoff = parent.lockOwnerHandoff;
    ownerChainMatches = Boolean(handoff)
      && handoff.kind === 'RECOVERY_LOCK_OWNER_HANDOFF'
      && handoff.parentDeploymentId === parent.deploymentId
      && handoff.recoveryOperationId === parent.recoveryOperationId
      && handoff.originalOwnerDeploymentId === parent.deploymentId
      && handoff.recoveryOwnerDeploymentId === parent.recoveryOperationId
      && handoff.originalLockOwnerSha256 === marker.lockOwner.sha256
      && handoff.recoveryLockOwnerSha256 === release.lockOwnerSha256;
  }
  if (release.operationId !== expectedOperationId
      || release.finalReceiptSha256 !== expectedFinalReceiptSha256
      || !ownerChainMatches
      || marker.lockOwner.path !== path.join(release.lockDir, 'owner.json')) {
    throw new DeploymentStateError('terminal lock release authority does not cross-bind marker and receipts', 'lock-release-mismatch');
  }
  if (lib.lstatOrNull(release.lockDir) !== null) {
    throw new DeploymentStateError('terminal released lock authority conflicts with a present volatile lock', 'lock-release-mismatch');
  }
}

function verifyPermitCurrentFacts(permit, marker) {
  const expected = {
    candidateSha256: marker.candidate.sha256,
    databaseIdentitySha256: marker.database.identitySha256,
    mountIdentitySha256: marker.mountIdentitySha256,
    lockOwnerSha256: marker.lockOwner.sha256,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (permit[field] !== value) {
      throw new DeploymentStateError(`probe permit ${field} differs from current guard authority`, 'current-identity-mismatch');
    }
  }
  if (permit.bootId !== lib.getBootId()) {
    throw new DeploymentStateError('probe permit was not issued in the current boot', 'boot-mismatch');
  }
}

function verbStartupCheck(argv) {
  const args = parseArgs(argv, {
    required: ['root', 'guard-marker', 'state', 'receipts', 'service'],
    optional: ['probe-nonce-file', 'supervisor-pid', 'supervisor-process-starttime'],
    flags: ['consume-probe-permit'],
  });

  if (!lib.STARTUP_CHECK_SERVICES.includes(args.service)) {
    throw new DeploymentStateError(`unknown service: ${args.service}`, 'shape');
  }
  if ('consume-probe-permit' in args && !('probe-nonce-file' in args)) {
    throw new DeploymentStateError('--consume-probe-permit requires --probe-nonce-file', 'shape');
  }
  const hasSupervisorPid = 'supervisor-pid' in args;
  const hasSupervisorStart = 'supervisor-process-starttime' in args;
  if ('consume-probe-permit' in args) {
    if (!hasSupervisorPid || !hasSupervisorStart) {
      throw new DeploymentStateError('consuming startup-check requires exact supervisor PID and starttime', 'missing-flag');
    }
    args['supervisor-pid'] = parsePositiveInt(args['supervisor-pid'], '--supervisor-pid');
    if (!/^\d+$/.test(args['supervisor-process-starttime'])
        || args['supervisor-pid'] !== process.ppid
        || procStartTime(args['supervisor-pid']) !== args['supervisor-process-starttime']) {
      throw new DeploymentStateError('startup-check caller is not the exact supervising wrapper', 'supervisor-identity-mismatch');
    }
  } else if (hasSupervisorPid || hasSupervisorStart) {
    throw new DeploymentStateError('non-consuming startup-check does not accept supervisor identity', 'shape');
  }
  if (!path.isAbsolute(args.root)) {
    throw new DeploymentStateError('--root must be an absolute path', 'shape');
  }
  let rootStat;
  try {
    rootStat = fs.lstatSync(args.root);
  } catch (err) {
    throw new DeploymentStateError(`--root does not exist: ${args.root}`, 'not-found');
  }
  if (rootStat.isSymbolicLink()) {
    throw new DeploymentStateError('--root must not be a symlink', 'symlink-rejected');
  }
  if (!rootStat.isDirectory()) {
    throw new DeploymentStateError('--root must be a directory', 'shape');
  }
  if (rootStat.uid !== process.getuid()) {
    throw new DeploymentStateError('--root has an unexpected owner', 'wrong-owner');
  }
  if ((rootStat.mode & 0o777) !== 0o700) {
    throw new DeploymentStateError('--root must be mode 0700', 'wrong-mode');
  }

  const current = lib.readState(args.state);
  const terminal = current && ['completed', 'recovered'].includes(current.parentDeployment.phase);
  const recoveredTerminal = current && current.parentDeployment.phase === 'recovered';
  const { marker } = readGuardMarker(args['guard-marker'], args, {
    requireLiveLockOwner: !terminal,
    validateQuarantineAuthority: !recoveredTerminal,
  });

  // Only the consuming form mutates state; it takes the per-mutation
  // exclusive lockfile so two concurrent consumers cannot both authorize
  // a launch. The non-consuming preflight is read-only and lock-free.
  if ('consume-probe-permit' in args) {
    return lib.withStateMutation(args.state, 'startup-check:consume', () => startupCheckLocked(args, marker, terminal));
  }
  return startupCheckLocked(args, marker, terminal);
}

function startupCheckLocked(args, marker, markerReadAsTerminal) {
  const current = lib.readState(args.state);
  if (!current) {
    throw new DeploymentStateError('no deployment state', 'state-missing');
  }

  const parent = current.parentDeployment;
  const sub = current.activeSubOperation;
  if (markerReadAsTerminal !== ['completed', 'recovered'].includes(parent.phase)) {
    throw new DeploymentStateError('deployment state changed while startup authority was being read', 'cas-mismatch');
  }
  if (marker.deploymentId !== parent.deploymentId) {
    throw new DeploymentStateError('guard marker deployment does not match current state', 'marker-binding-mismatch');
  }
  if (parent.phase === 'completed' || parent.phase === 'recovered') {
    if (parent.leaseActive) {
      throw new DeploymentStateError('terminal startup requires an inactive parent lease', 'terminal-lease-active');
    }
    if (sub !== null) {
      throw new DeploymentStateError('terminal startup requires no active sub-operation', 'terminal-suboperation-active');
    }
    verifyTerminalReleaseAuthority(parent, marker);
  }

  if (args.service !== 'node-red') {
    if ('probe-nonce-file' in args) {
      throw new DeploymentStateError(`service '${args.service}' has no probe-permit path`, 'shape');
    }
    const mode = verifyTerminalAuthority(parent, args.receipts, marker);
    return { ok: true, verb: 'startup-check', service: args.service, pass: true, consumed: false, mode };
  }

  if (parent.phase === 'completed' || parent.phase === 'recovered') {
    if ('probe-nonce-file' in args) throw new DeploymentStateError('terminal startup does not accept a probe nonce', 'shape');
    const mode = verifyTerminalAuthority(parent, args.receipts, marker);
    return { ok: true, verb: 'startup-check', service: 'node-red', pass: true, consumed: false, mode };
  }

  if (parent.phase === 'verification-in-flight' && sub === null) {
    if ('probe-nonce-file' in args) {
      const recordedLocator = parent.probePermit ? parent.probePermit.noncePath : null;
      if (!recordedLocator || args['probe-nonce-file'] !== recordedLocator) {
        throw new DeploymentStateError(
          'probe-nonce-file does not match the recorded consumed locator for post-receipt respawn',
          'nonce-mismatch'
        );
      }
      lib.validatePermitNoncePath(args['probe-nonce-file']);
      let exists = true;
      try {
        fs.lstatSync(args['probe-nonce-file']);
      } catch (_err) {
        exists = false;
      }
      if (exists) {
        throw new DeploymentStateError('a present/recreated nonce file fails post-receipt respawn', 'nonce-not-absent');
      }
    }
    if (!parent.deploymentReceiptSha256) {
      throw new DeploymentStateError('no deployment receipt recorded; cannot authorize respawn', 'receipt-missing');
    }
    const receipt = lib.readReceipt(args.receipts, parent.deploymentId, 'deployment');
    if (!receipt || receipt.sha256 !== parent.deploymentReceiptSha256) {
      throw new DeploymentStateError('deployment receipt on disk does not match recorded state', 'receipt-mismatch');
    }
    if (!parent.probePermit || parent.probePermit.status !== 'consumed') {
      throw new DeploymentStateError('post-receipt respawn requires a consumed probe permit', 'permit-not-consumed');
    }
    verifyPermitCurrentFacts(parent.probePermit, marker);
    return { ok: true, verb: 'startup-check', service: 'node-red', pass: true, consumed: false, mode: 'post-receipt-respawn' };
  }

  if (!('probe-nonce-file' in args)) {
    throw new DeploymentStateError('node-red startup-check at a pre-receipt phase requires --probe-nonce-file', 'missing-flag');
  }
  if (!path.isAbsolute(args['probe-nonce-file'])) {
    throw new DeploymentStateError('--probe-nonce-file must be absolute', 'shape');
  }
  lib.validatePermitNoncePath(args['probe-nonce-file']);

  let permitHolder = null;
  let permit = null;
  if (parent.probePermit && parent.probePermit.noncePath === args['probe-nonce-file']) {
    permitHolder = 'parent';
    permit = parent.probePermit;
  } else if (sub && sub.probePermit && sub.probePermit.noncePath === args['probe-nonce-file']) {
    permitHolder = 'subOperation';
    permit = sub.probePermit;
  }
  if (!permit) {
    throw new DeploymentStateError('no permit is recorded for --probe-nonce-file', 'permit-not-found');
  }
  if ((permitHolder === 'parent' && parent.phase !== 'probes-running') ||
      (permitHolder === 'subOperation' && (!sub || sub.kind !== 'recovery'))) {
    throw new DeploymentStateError('probe permit is not valid for the current role phase', 'phase-not-authorized');
  }
  if (permit.purpose !== 'deployment-probe' || permitHolder !== 'parent') {
    throw new DeploymentStateError(
      'the recorded probe permit purpose has no satisfiable startup authority in this slice',
      'purpose-not-satisfiable'
    );
  }
  const permitHolderState = permitHolder === 'parent' ? parent : sub;
  if (permit.status === 'consumed') {
    if (!('consume-probe-permit' in args)) {
      throw new DeploymentStateError('probe permit generation is already launch-authorized', 'already-consumed');
    }
    if (!permit.launchAuthorization) throw new DeploymentStateError('consumed permit has no launch authority', 'permit-not-consumed');
    verifyPermitCurrentFacts(permit, marker);
    const launch = permit.launchAuthorization;
    if (launch.status === 'launch-aborted') {
      return reauthorizeAbortedLaunch(args, marker, parent, sub, permit);
    }
    const gatePath = launchGatePathForToken(launch.tokenPath);
    if (launch.status === 'child-started') {
      if (processInstanceRunning(launch.supervisorPid, launch.supervisorProcessStartTime)) {
        throw new DeploymentStateError('probe permit already has a live supervising wrapper', 'already-consumed');
      }
      const facts = readLaunchProcess(launch.childPid);
      let phase = 'gone';
      let boundFacts = null;
      if (facts && facts.state !== 'Z' && facts.processStartTime === launch.childProcessStartTime) {
        phase = classifyLaunchProcess(facts, launch.tokenSha256, marker, gatePath, launch.carrierArgvSha256);
        if (!phase) {
          throw new DeploymentStateError('recorded child process no longer has its bound launch identity', 'current-identity-mismatch');
        }
        boundFacts = facts;
      }
      recordLaunchAbort({ args, current, parent, sub, permit, launch, marker,
        processFacts: boundFacts, processPhase: phase });
      if (boundFacts) terminateLaunchProcess(boundFacts);
      finishLaunchTokenCleanup(launch.tokenPath);
      throw new DeploymentStateError('previous launch lost its exact supervisor and was revoked', 'launch-aborted');
    }
    if (launch.status !== 'authorized') {
      throw new DeploymentStateError('unknown launch authorization status', 'shape');
    }
    const authorizedSupervisorLive = processInstanceRunning(
      launch.supervisorPid, launch.supervisorProcessStartTime
    );
    const sameSupervisor = launch.supervisorPid === args['supervisor-pid']
      && launch.supervisorProcessStartTime === args['supervisor-process-starttime'];
    if (authorizedSupervisorLive && !sameSupervisor) {
      throw new DeploymentStateError('launch authorization is owned by another live supervisor', 'already-consumed');
    }
    const token = readStrictLaunchToken(launch.tokenPath, permit);
    const discovered = findAuthorizedLaunchChildren(launch.tokenSha256, marker, gatePath,
      launch.carrierArgvSha256, launch.tokenPath);
    if (discovered) {
      recordLaunchAbort({ args, current, parent, sub, permit, launch, marker,
        processFacts: discovered, processPhase: discovered.phase });
      terminateLaunchProcess(discovered);
      finishLaunchTokenCleanup(launch.tokenPath);
      finishLaunchSpawnerCleanup(launch.tokenPath);
      throw new DeploymentStateError('unrecorded authorized child was revoked before retry', 'launch-aborted');
    }
    if (!authorizedSupervisorLive) {
      const now = nowIso();
      const reboundLaunch = {
        ...launch,
        supervisorPid: args['supervisor-pid'],
        supervisorProcessStartTime: args['supervisor-process-starttime'],
        authorizedAt: now,
      };
      const reboundPermit = { ...permit, launchAuthorization: reboundLaunch };
      const reboundParent = {
        ...parent,
        generation: parent.generation + 1,
        updatedAt: now,
        probePermit: reboundPermit,
      };
      lib.validateParentDeployment(reboundParent);
      lib.writeState(args.state, {
        format: 2, parentDeployment: reboundParent, activeSubOperation: sub,
      }, { crashLabelPrefix: 'launch-supervisor-rebind:state' });
    }
    try {
      const nonce = readStrictNonceFile(args['probe-nonce-file'], 'probe-nonce-file');
      if (lib.sha256Hex(nonce.content.nonce) !== permit.nonceSha256) {
        throw new DeploymentStateError('probe-nonce-file content does not match the recorded permit', 'nonce-mismatch');
      }
      fs.unlinkSync(args['probe-nonce-file']);
      lib.fsyncDir(path.dirname(args['probe-nonce-file']));
    } catch (error) {
      if (!(error instanceof DeploymentStateError && error.code === 'nonce-missing')) throw error;
    }
    return { ok: true, verb: 'startup-check', service: 'node-red', pass: true, consumed: true,
      resumed: true, launchTokenPath: permit.launchAuthorization.tokenPath };
  }
  if (permit.phaseAtIssuance !== permitHolderState.phase ||
      permit.holderGenerationAtIssuance !== permitHolderState.generation) {
    throw new DeploymentStateError(
      'probe permit does not match the current holder phase and generation',
      'permit-state-mismatch'
    );
  }
  verifyPermitCurrentFacts(permit, marker);
  if (Date.parse(permit.expiresAt) <= Date.now()) {
    throw new DeploymentStateError('probe permit has expired', 'permit-expired');
  }

  if (!('consume-probe-permit' in args)) {
    const nonce = readStrictNonceFile(args['probe-nonce-file'], 'probe-nonce-file');
    if (permit.status !== 'issued') {
      throw new DeploymentStateError('permit is not in issued state', 'permit-not-issued');
    }
    const content = nonce.content;
    if (lib.sha256Hex(content.nonce) !== permit.nonceSha256) {
      throw new DeploymentStateError('probe-nonce-file content does not match the recorded permit', 'nonce-mismatch');
    }
    return { ok: true, verb: 'startup-check', service: 'node-red', pass: true, consumed: false, mode: 'preflight' };
  }

  // Consuming form: only the resident wrapper invokes this.
  if (permit.status !== 'issued') {
    throw new DeploymentStateError('permit is not in issued state', 'permit-not-issued');
  }
  const nonce = readStrictNonceFile(args['probe-nonce-file'], 'probe-nonce-file');
  const content = nonce.content;
  if (lib.sha256Hex(content.nonce) !== permit.nonceSha256) {
    throw new DeploymentStateError('probe-nonce-file content does not match the recorded permit', 'nonce-mismatch');
  }

  const launchTokenPath = launchTokenPathForNonce(args['probe-nonce-file']);
  const launchToken = publishLaunchToken(launchTokenPath, permit);
  const now = nowIso();
  const consumedPermit = { ...permit, status: 'consumed', launchAuthorization: authorizedLaunch({
    tokenPath: launchTokenPath,
    token: launchToken.token,
    marker,
    now,
    attempt: 1,
    previousAbortReceiptSha256: null,
    supervisorPid: args['supervisor-pid'],
    supervisorProcessStartTime: args['supervisor-process-starttime'],
  }) };
  lib.validateProbePermit(consumedPermit, 'probePermit');

  let nextParent;
  let nextSub;
  if (permitHolder === 'parent') {
    nextParent = { ...parent, generation: parent.generation + 1, updatedAt: now, probePermit: consumedPermit };
    nextSub = sub;
  } else {
    nextParent = { ...parent, generation: parent.generation + 1, updatedAt: now };
    nextSub = { ...sub, probePermit: consumedPermit };
  }
  lib.validateParentDeployment(nextParent);
  if (nextSub) lib.validateActiveSubOperation(nextSub, nextParent);
  lib.writeState(args.state, { format: 2, parentDeployment: nextParent, activeSubOperation: nextSub }, { crashLabelPrefix: 'consume-permit:state' });

  lib.maybeCrash('consume-permit:after-state-write-before-unlink');
  fs.unlinkSync(args['probe-nonce-file']);
  lib.maybeCrash('consume-permit:after-unlink');
  lib.fsyncDir(path.dirname(args['probe-nonce-file']));
  lib.maybeCrash('consume-permit:after-unlink-parent-fsync');

  let stillExists = true;
  try {
    fs.lstatSync(args['probe-nonce-file']);
  } catch (_err) {
    stillExists = false;
  }
  if (stillExists) {
    throw new DeploymentStateError('nonce file still exists after unlink (fail closed)', 'nonce-not-absent');
  }

  return { ok: true, verb: 'startup-check', service: 'node-red', pass: true, consumed: true,
    resumed: false, launchTokenPath };
}

function verbRecordLaunchStart(argv) {
  const args = parseArgs(argv, {
    required: ['root', 'guard-marker', 'state', 'receipts', 'service', 'launch-token-file',
      'child-pid', 'child-process-starttime', 'supervisor-pid', 'supervisor-process-starttime',
      'launch-gate-file'],
  });
  if (args.service !== 'node-red') throw new DeploymentStateError('record-launch-start is node-red only', 'shape');
  const childPid = parsePositiveInt(args['child-pid'], '--child-pid');
  const supervisorPid = parsePositiveInt(args['supervisor-pid'], '--supervisor-pid');
  if (!/^\d+$/.test(args['child-process-starttime'])) {
    throw new DeploymentStateError('--child-process-starttime must be a /proc starttime', 'shape');
  }
  if (!/^\d+$/.test(args['supervisor-process-starttime'])) {
    throw new DeploymentStateError('--supervisor-process-starttime must be a /proc starttime', 'shape');
  }
  if (supervisorPid !== process.ppid || procStartTime(supervisorPid) !== args['supervisor-process-starttime']) {
    throw new DeploymentStateError('recording CLI is not a child of the exact supervising wrapper', 'supervisor-identity-mismatch');
  }
  return lib.withStateMutation(args.state, 'record-launch-start', () => {
    const current = lib.readState(args.state);
    if (!current) throw new DeploymentStateError('no deployment state', 'state-missing');
    const parent = current.parentDeployment;
    const permit = parent.probePermit;
    if (!permit || permit.status !== 'consumed' || !permit.launchAuthorization) {
      throw new DeploymentStateError('no consumed launch authorization is recorded', 'permit-not-consumed');
    }
    const launch = permit.launchAuthorization;
    if (launch.tokenPath !== args['launch-token-file']) {
      throw new DeploymentStateError('launch-token-file differs from recorded authorization', 'launch-token-mismatch');
    }
    const expectedGatePath = launchGatePathForToken(launch.tokenPath);
    if (args['launch-gate-file'] !== expectedGatePath) {
      throw new DeploymentStateError('launch-gate-file differs from the canonical token peer', 'launch-token-mismatch');
    }
    let gateStat;
    try { gateStat = fs.lstatSync(expectedGatePath); } catch (_error) {
      throw new DeploymentStateError('launch gate is missing', 'launch-gate-missing');
    }
    if (!gateStat.isFIFO() || gateStat.isSymbolicLink() || gateStat.uid !== process.getuid()
        || (gateStat.mode & 0o777) !== 0o600 || gateStat.nlink !== 1) {
      throw new DeploymentStateError('launch gate must be an owned mode-0600 FIFO with one link', 'launch-gate-mismatch');
    }
    const { marker } = readGuardMarker(args['guard-marker'], args, { requireLiveLockOwner: true });
    if (launch.argvSha256 !== marker.nodeRedLaunch.argvSha256) {
      throw new DeploymentStateError('launch argv authority changed after permit consumption', 'current-identity-mismatch');
    }
    if (launch.supervisorPid !== supervisorPid
        || launch.supervisorProcessStartTime !== args['supervisor-process-starttime']) {
      throw new DeploymentStateError('recording wrapper differs from the durable launch supervisor', 'supervisor-identity-mismatch');
    }
    if (launch.status === 'child-started') {
      const facts = readLaunchProcess(childPid);
      if (launch.childPid !== childPid || launch.childProcessStartTime !== args['child-process-starttime']
          || launch.supervisorPid !== supervisorPid
          || launch.supervisorProcessStartTime !== args['supervisor-process-starttime']
          || !facts || facts.processStartTime !== launch.childProcessStartTime
          || classifyLaunchProcess(facts, launch.tokenSha256, marker, expectedGatePath,
            launch.carrierArgvSha256) !== 'carrier') {
        throw new DeploymentStateError('child-start receipt belongs to a different process instance', 'launch-token-replayed');
      }
      finishLaunchTokenCleanup(launch.tokenPath);
      return { ok: true, verb: 'record-launch-start', resumed: true, childPid };
    }
    if (launch.status !== 'authorized') {
      throw new DeploymentStateError('launch authorization was already revoked', 'launch-aborted');
    }
    const token = readStrictLaunchToken(launch.tokenPath, permit);
    const facts = readLaunchProcess(childPid);
    const carrierPhase = classifyLaunchProcess(facts, launch.tokenSha256, marker, expectedGatePath);
    if (process.env.OSI_DEPLOY_LAUNCH_TOKEN !== token.content.token || !facts
        || facts.processStartTime !== args['child-process-starttime']
        || facts.processGroupId !== childPid || facts.sessionId !== childPid
        || carrierPhase !== 'carrier') {
      throw new DeploymentStateError('child process does not carry the exact gated carrier, token, and target argv', 'launch-token-mismatch');
    }
    const startedAt = nowIso();
    const startedPermit = { ...permit, launchAuthorization: { ...launch, status: 'child-started',
      carrierArgvSha256: facts.argvSha256,
      supervisorPid,
      supervisorProcessStartTime: args['supervisor-process-starttime'],
      childPid, childProcessStartTime: args['child-process-starttime'], startedAt } };
    const nextParent = { ...parent, probePermit: startedPermit, generation: parent.generation + 1, updatedAt: startedAt };
    lib.validateParentDeployment(nextParent);
    lib.writeState(args.state, { ...current, parentDeployment: nextParent }, { crashLabelPrefix: 'launch-start:state' });
    lib.maybeCrash('launch-start:after-state-before-token-unlink');
    finishLaunchTokenCleanup(launch.tokenPath);
    lib.maybeCrash('launch-start:after-token-unlink');
    return { ok: true, verb: 'record-launch-start', resumed: false, childPid };
  });
}

// ---------------------------------------------------------------------------
// Guard-bootstrap chain verbs (A0 sub-tranche 2). Argv forms are pinned
// verbatim from the plan CLI block. Chain semantics live in the library;
// this layer owns argv parsing, root-lock serialization, boot-rule
// enforcement for the current invocation, and bounded JSON output.
//
// Concretizations (documented in the execution report):
// - "advance requires expected generation, head SHA, phase, boot epoch and
//   boot ID": the argv block carries no --expected-boot-* flags, so the
//   epoch/bootId expectation is pinned transitively by
//   --expected-generation-sha256 (the head bytes embed both), plus the
//   current-boot rules below ('reboot-required' for a prior-boot head).
// - Every chain mutation serializes through the shared mutation lockfile
//   at `${root}.mutating` (sibling of the root, never inside it, so the
//   root's children stay directories-only).
// - The generic advance verb refuses phases owned by dedicated verbs:
//   intent (begin), claimed (claim-attempt), abandoning/abandoned
//   (abandon-guard-bootstrap).
// ---------------------------------------------------------------------------

const GUARD_IDENTITY_FIELDS = [...lib.GUARD_COMMON_IDENTITY_FIELDS, 'priorRoleStates'];
const GUARD_ADVANCE_RESERVED_PHASES = ['intent', 'claimed', 'abandoning', 'abandoned'];

function readGuardIdentityFile(p) {
  const identity = readRootOnlyJsonFile(p, '--identity');
  lib.assertPlainObject(identity, 'identity');
  lib.assertExactFields(identity, GUARD_IDENTITY_FIELDS, 'identity');
  return identity;
}

function guardHeadSummary(verb, head, extra = {}) {
  return {
    ok: true,
    verb,
    deploymentId: head.entry.deploymentId,
    generation: head.generation,
    headSha256: head.sha256,
    phase: head.entry.phase,
    bootEpoch: head.entry.bootEpoch,
    bootId: head.entry.bootId,
    ...extra,
  };
}

function requireGuardChain(root, deploymentId) {
  const chain = lib.readGuardChain(root, deploymentId);
  if (chain === null) {
    throw new DeploymentStateError(`no guard-bootstrap chain exists for '${deploymentId}'`, 'guard-chain-missing');
  }
  return chain;
}

function verbBeginGuardBootstrap(argv) {
  const args = parseArgs(argv, { required: ['root', 'deployment-id', 'identity'] });
  if (!path.isAbsolute(args.root)) {
    throw new DeploymentStateError('--root must be an absolute path', 'shape');
  }
  const identity = readGuardIdentityFile(args.identity);
  if (identity.deploymentId !== args['deployment-id']) {
    throw new DeploymentStateError('--identity deploymentId does not match --deployment-id', 'guard-identity-mismatch');
  }

  return lib.withStateMutation(args.root, args['deployment-id'], () => {
    // Structural scan: every direct child must be an lstat-real directory;
    // every other chain must be terminal (claimed|abandoned).
    for (const childId of lib.listGuardChainDirs(args.root)) {
      if (childId === args['deployment-id']) continue;
      const other = requireGuardChain(args.root, childId);
      if (!lib.GUARD_TERMINAL_PHASES.includes(other.head.entry.phase)) {
        throw new DeploymentStateError(
          `another guard-bootstrap is active for '${childId}' (phase '${other.head.entry.phase}')`,
          'guard-bootstrap-active'
        );
      }
    }

    const existing = lib.readGuardChain(args.root, args['deployment-id']);
    if (existing !== null) {
      // Same ID resumes only from its exact head, and only under the same
      // recorded identity.
      for (const field of lib.GUARD_COMMON_IDENTITY_FIELDS) {
        if (existing.head.entry[field] !== identity[field]) {
          throw new DeploymentStateError(
            `--identity field '${field}' does not match the existing chain`,
            'guard-identity-mismatch'
          );
        }
      }
      return guardHeadSummary('begin-guard-bootstrap', existing.head, { resumed: true });
    }

    const head = lib.appendGuardEntry(args.root, args['deployment-id'], {
      deploymentId: identity.deploymentId,
      controllerGeneration: identity.controllerGeneration,
      targetCommitSha: identity.targetCommitSha,
      artifactSha256: identity.artifactSha256,
      controlManifestSha256: identity.controlManifestSha256,
      detectedProfile: identity.detectedProfile,
      expectedProfile: identity.expectedProfile,
      profileMappingSha256: identity.profileMappingSha256,
      bootEpoch: 1,
      bootId: lib.getBootId(),
      phase: 'intent',
      facts: { priorRoleStates: identity.priorRoleStates },
      result: 'ok',
      createdAt: nowIso(),
    }, { expectedGeneration: 0 });
    return guardHeadSummary('begin-guard-bootstrap', head, { resumed: false });
  });
}

function verbAdvanceGuardBootstrap(argv) {
  const args = parseArgs(argv, {
    required: ['root', 'deployment-id', 'expected-generation', 'expected-generation-sha256', 'expected-phase', 'phase', 'facts'],
  });
  if (!path.isAbsolute(args.root)) {
    throw new DeploymentStateError('--root must be an absolute path', 'shape');
  }
  if (!lib.GUARD_PHASES.includes(args.phase)) {
    throw new DeploymentStateError(`unknown guard phase: ${args.phase}`, 'shape');
  }
  if (GUARD_ADVANCE_RESERVED_PHASES.includes(args.phase)) {
    throw new DeploymentStateError(
      `phase '${args.phase}' is reserved for its dedicated verb and cannot be appended by generic advance`,
      'phase-reserved'
    );
  }
  const expectedGeneration = parsePositiveInt(args['expected-generation'], '--expected-generation');
  lib.assertSha256Hex(args['expected-generation-sha256'], '--expected-generation-sha256');
  const facts = readRootOnlyJsonFile(args.facts, '--facts');

  return lib.withStateMutation(args.root, args['deployment-id'], () => {
    const chain = requireGuardChain(args.root, args['deployment-id']);
    const head = chain.head;
    if (head.generation !== expectedGeneration || head.sha256 !== args['expected-generation-sha256']) {
      throw new DeploymentStateError('guard chain head does not match --expected-generation/--expected-generation-sha256', 'cas-mismatch');
    }
    if (head.entry.phase !== args['expected-phase']) {
      throw new DeploymentStateError(`--expected-phase mismatch: head phase is '${head.entry.phase}'`, 'cas-mismatch');
    }

    const currentBootId = lib.getBootId();
    let bootEpoch;
    let result = 'ok';
    if (args.phase === 'epoch-invalidated') {
      if (currentBootId === head.entry.bootId) {
        throw new DeploymentStateError('epoch invalidation requires a boot change (head is in the current boot)', 'guard-epoch');
      }
      bootEpoch = head.entry.bootEpoch;
      result = 'reboot-before-ready';
    } else if (args.phase === 'epoch-start' && head.entry.phase === 'epoch-invalidated') {
      if (currentBootId !== head.entry.bootId) {
        throw new DeploymentStateError('epoch-start must be appended in the boot that invalidated the epoch', 'reboot-required');
      }
      bootEpoch = head.entry.bootEpoch + 1;
    } else if (args.phase === 'ready-revalidated') {
      if (currentBootId === head.entry.bootId) {
        throw new DeploymentStateError('ready revalidation requires a boot change (reboot-at-ready)', 'guard-epoch');
      }
      bootEpoch = head.entry.bootEpoch;
      result = 'ready-revalidated';
    } else {
      // Normal same-epoch advance: a prior-boot head can never advance.
      if (currentBootId !== head.entry.bootId) {
        throw new DeploymentStateError(
          'guard chain head belongs to a previous boot; epoch invalidation (or ready revalidation) is required before any advance',
          'reboot-required'
        );
      }
      bootEpoch = head.entry.bootEpoch;
    }

    // An epoch-start is a fresh authority sample, not a caller assertion.
    // On the production root (and whenever the fixed test adapter is
    // supplied) read the resident role helper while holding the guard lock,
    // then require the submitted facts to be byte-equivalent to that sample.
    // This prevents a rebooted controller from reusing generation-1 PID,
    // start-time, readiness, or rc-link evidence for a new stop intent.
    const shouldSampleEpochStart = args.phase === 'epoch-start'
      && (guardLiveRoot(args.root) === '/' || process.env.OSI_DEPLOY_TEST_ROLE_STATE !== undefined);
    if (shouldSampleEpochStart) {
      const sampled = currentRoleAuthority(guardLiveRoot(args.root));
      if (sampled.bootId !== currentBootId
          || lib.canonicalize(facts.priorRoleStates) !== lib.canonicalize(guardRoleStatesFromAuthority(sampled))) {
        throw new DeploymentStateError(
          'epoch-start facts must be a fresh exact current role and rc-link authority sample',
          'guard-fact-binding'
        );
      }
    }

    const appended = lib.appendGuardEntry(args.root, args['deployment-id'], {
      deploymentId: head.entry.deploymentId,
      controllerGeneration: head.entry.controllerGeneration,
      targetCommitSha: head.entry.targetCommitSha,
      artifactSha256: head.entry.artifactSha256,
      controlManifestSha256: head.entry.controlManifestSha256,
      detectedProfile: head.entry.detectedProfile,
      expectedProfile: head.entry.expectedProfile,
      profileMappingSha256: head.entry.profileMappingSha256,
      bootEpoch,
      bootId: currentBootId,
      phase: args.phase,
      facts,
      result,
      createdAt: nowIso(),
    }, { expectedGeneration, expectedHeadSha256: args['expected-generation-sha256'] });
    return guardHeadSummary('advance-guard-bootstrap', appended);
  });
}

function verbStatusGuardBootstrap(argv) {
  const args = parseArgs(argv, { required: ['root', 'deployment-id', 'expected-head-sha256'] });
  if (!path.isAbsolute(args.root)) {
    throw new DeploymentStateError('--root must be an absolute path', 'shape');
  }
  lib.assertSha256Hex(args['expected-head-sha256'], '--expected-head-sha256');
  // Read-only: full chain verification + referenced manifests, no lock.
  const chain = requireGuardChain(args.root, args['deployment-id']);
  lib.verifyGuardManifests(chain);
  if (chain.head.sha256 !== args['expected-head-sha256']) {
    throw new DeploymentStateError('guard chain head does not match --expected-head-sha256', 'cas-mismatch');
  }
  return {
    ok: true,
    verb: 'status-guard-bootstrap',
    deploymentId: chain.head.entry.deploymentId,
    headGeneration: chain.head.generation,
    headSha256: chain.head.sha256,
    phase: chain.head.entry.phase,
    bootEpoch: chain.head.entry.bootEpoch,
    bootId: chain.head.entry.bootId,
    generationCount: chain.entries.length,
    terminal: lib.GUARD_TERMINAL_PHASES.includes(chain.head.entry.phase),
  };
}

// ---------------------------------------------------------------------------
// claim-attempt / abandon-guard-bootstrap.
//
// claim-attempt: only the exact latest ready/ready-revalidated head (same
// boot) may create the immutable claim under attempts/, then append
// `claimed` binding the claim file's raw bytes. A crash between the two
// writes may only finish `claimed` when the on-disk claim's business bytes
// cross-match what this call would have written.
//
// abandon-guard-bootstrap: legal from any nonterminal epoch phase, or from
// `claimed` only while no parent state is armed (concretized as: no attempt
// tombstone exists for this deployment id - `arm` is what writes the
// tombstone, and this verb's argv carries --attempts but no --state).
// Appends `abandoning` (facts derived from the chain: either no-mutation
// proof or the exact topology snapshot/restore target + last mutation
// generation), writes/fsyncs the topology-activation (guard-bootstrap
// authority) and abandonment receipts, then appends `abandoned`. Crash at
// any boundary resumes deterministically; the abandonment receipt, not
// staging absence, consumes the claim (the claim file is never deleted).
// ---------------------------------------------------------------------------

function guardClaimPath(attemptsDir, deploymentId) {
  lib.validateOperationId(deploymentId, 'deploymentId');
  return path.join(lib.validatePersistentAuthorityDirectory(attemptsDir, 'attempts'), `${deploymentId}.claim.json`);
}

const CLAIM_BUSINESS_FIELDS = [
  'format', 'deploymentId', 'guardGeneration', 'guardGenerationSha256', 'markerSha256',
  'controllerGeneration', 'targetCommitSha', 'controlManifestSha256', 'artifactSha256',
  'bootEpoch', 'bootId', 'guardBootstrapRoot',
];

function readArmClaimAuthority(attemptsDir, identity) {
  const claimPath = guardClaimPath(attemptsDir, identity.deploymentId);
  if (!lib.assertRegularFileMode0600(claimPath)) {
    throw new DeploymentStateError('arm requires the immutable prior claim-attempt file', 'claim-missing');
  }
  const raw = fs.readFileSync(claimPath);
  let claim;
  try { claim = JSON.parse(raw); } catch (_error) {
    throw new DeploymentStateError('arm claim is invalid JSON', 'claim-mismatch');
  }
  lib.assertExactFields(claim, [...CLAIM_BUSINESS_FIELDS, 'createdAt'], 'arm claim');
  if (claim.format !== 1
      || claim.deploymentId !== identity.deploymentId
      || claim.targetCommitSha !== identity.targetCommitSha
      || claim.controllerGeneration !== identity.controllerGeneration
      || !path.isAbsolute(claim.guardBootstrapRoot)
      || claim.bootId !== lib.getBootId()) {
    throw new DeploymentStateError('arm claim identity does not match this attempt/current boot', 'claim-mismatch');
  }
  const chain = requireGuardChain(claim.guardBootstrapRoot, identity.deploymentId);
  const head = chain.head;
  const preClaim = chain.entries[chain.entries.length - 2];
  const sha256 = lib.sha256Hex(raw);
  if (head.entry.phase !== 'claimed'
      || head.entry.facts.claimPath !== claimPath
      || head.entry.facts.claimSha256 !== sha256
      || !preClaim
      || preClaim.generation !== claim.guardGeneration
      || preClaim.sha256 !== claim.guardGenerationSha256) {
    throw new DeploymentStateError('arm claim bytes are not the exact claimed guard-chain authority', 'claim-mismatch');
  }
  return { path: claimPath, sha256, content: claim };
}

function verbClaimAttempt(argv) {
  const args = parseArgs(argv, {
    required: ['attempts', 'guard-bootstrap-root', 'guard-marker', 'deployment-id', 'expected-guard-generation',
      'expected-guard-generation-sha256', 'expected-marker-sha256', 'controller-generation',
      'target-commit', 'control-manifest-sha256', 'artifact-sha256'],
  });
  const root = args['guard-bootstrap-root'];
  if (!path.isAbsolute(root) || !path.isAbsolute(args.attempts)) {
    throw new DeploymentStateError('--guard-bootstrap-root and --attempts must be absolute paths', 'shape');
  }
  const expectedGeneration = parsePositiveInt(args['expected-guard-generation'], '--expected-guard-generation');
  lib.assertSha256Hex(args['expected-guard-generation-sha256'], '--expected-guard-generation-sha256');
  lib.assertSha256Hex(args['expected-marker-sha256'], '--expected-marker-sha256');
  lib.assertSha256Hex(args['control-manifest-sha256'], '--control-manifest-sha256');
  lib.assertSha256Hex(args['artifact-sha256'], '--artifact-sha256');
  const controllerGeneration = parsePositiveInt(args['controller-generation'], '--controller-generation');
  const artifactTest = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
    && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test';
  const markerRoot = artifactTest ? path.dirname(root) : '/data/osi-deploy';
  const canonicalMarkerPath = path.join(markerRoot, 'guard-installed.json');
  if (path.resolve(args['guard-marker']) !== canonicalMarkerPath) {
    throw new DeploymentStateError('--guard-marker must be the exact persistent guard-installed.json', 'marker-binding-mismatch');
  }

  const claimPath = guardClaimPath(args.attempts, args['deployment-id']);
  return lib.withStateMutation(claimPath, args['deployment-id'], () => (
    lib.withStateMutation(root, args['deployment-id'], () => {
    const chain = requireGuardChain(root, args['deployment-id']);
    const head = chain.head;
    if (!['ready', 'ready-revalidated', 'claimed'].includes(head.entry.phase)) {
      throw new DeploymentStateError(
        `claim requires the head to be ready|ready-revalidated, got '${head.entry.phase}'`,
        'guard-not-ready'
      );
    }
    const authorityHead = head.entry.phase === 'claimed'
      ? chain.entries[chain.entries.length - 2]
      : head;
    if (!authorityHead) {
      throw new DeploymentStateError('claimed guard chain has no ready predecessor', 'guard-chain-corrupt');
    }
    const markerAuthority = readGuardMarker(args['guard-marker'], {});
    const marker = markerAuthority.marker;
    if (path.resolve(marker.rootPath) !== markerRoot || fs.realpathSync(marker.rootPath) !== fs.realpathSync(markerRoot)) {
      throw new DeploymentStateError('live guard marker root does not bind the guard-bootstrap authority root', 'marker-binding-mismatch');
    }
    if (markerAuthority.sha256 !== args['expected-marker-sha256']
        || markerAuthority.sha256 !== authorityHead.entry.facts.markerSha256) {
      throw new DeploymentStateError('live guard marker bytes do not match the ready generation', 'marker-mismatch');
    }
    if (marker.deploymentId !== args['deployment-id']) {
      throw new DeploymentStateError('live guard marker deployment identity differs from the claim', 'guard-identity-mismatch');
    }
    if (!markerAuthority.lockOwner
        || markerAuthority.lockOwner.deploymentId !== args['deployment-id']
        || markerAuthority.lockOwner.targetCommitSha !== authorityHead.entry.targetCommitSha
        || markerAuthority.lockOwner.controllerGeneration !== authorityHead.entry.controllerGeneration) {
      throw new DeploymentStateError('live guard lock owner identity differs from the ready generation', 'guard-identity-mismatch');
    }
    if (authorityHead.entry.bootId !== lib.getBootId()) {
      throw new DeploymentStateError('ready head belongs to a previous boot; ready must be revalidated before claim', 'reboot-required');
    }

    let epochStart = 0;
    const authorityIndex = chain.entries.indexOf(authorityHead);
    for (let index = authorityIndex; index >= 0; index -= 1) {
      if (chain.entries[index].entry.phase === 'epoch-start') { epochStart = index; break; }
    }
    const epochEntries = chain.entries.slice(epochStart, authorityIndex + 1);
    const latestEpochEntry = (phase) => [...epochEntries].reverse().find((record) => record.entry.phase === phase) || null;
    const rolesStopped = latestEpochEntry('roles-stopped');
    const safetyInstalled = latestEpochEntry('safety-installed');
    const quarantined = latestEpochEntry('links-quarantined');
    const ready = latestEpochEntry('ready');
    if (!rolesStopped || !safetyInstalled || !quarantined || !ready
        || marker.targetSafety.manifestSha256 !== ready.entry.facts.targetSafetyManifestSha256
        || marker.targetSafety.manifestSha256 !== safetyInstalled.entry.facts.targetSafetyManifestSha256
        || marker.sixLinkTopologySha256 !== ready.entry.facts.sixLinkTopologySha256
        || marker.sixLinkTopologySha256 !== quarantined.entry.facts.sixLinkTopologySha256) {
      throw new DeploymentStateError('live guard marker does not cross-bind the ready epoch authorities', 'guard-fact-binding');
    }
    const roleState = currentStoppedRoleAuthority(marker.liveRootPath);
    if (roleState.bootId !== lib.getBootId()
        || roleState.bootId !== authorityHead.entry.bootId
        || lib.canonicalize(Object.fromEntries(Object.entries(roleState.roles).map(([role, facts]) => [role, facts.generation])))
          !== lib.canonicalize(rolesStopped.entry.facts.stoppedRoleGenerations)) {
      throw new DeploymentStateError('current stopped role generations or boot differ from the ready epoch', 'current-role-state-mismatch');
    }

    // Idempotent resume: a crash after the claimed append leaves head at
    // claimed; the retry (same CAS args, which name the pre-claim head)
    // succeeds only when every byte cross-matches.
    if (head.entry.phase === 'claimed') {
      const preClaim = chain.entries[chain.entries.length - 2];
      if (!preClaim
        || preClaim.generation !== expectedGeneration
        || preClaim.sha256 !== args['expected-guard-generation-sha256']) {
        throw new DeploymentStateError('guard chain is already claimed under a different head', 'cas-mismatch');
      }
      const claimStat = lib.assertRegularFileMode0600(claimPath);
      if (!claimStat) {
        throw new DeploymentStateError('chain is claimed but the claim file is missing', 'claim-mismatch');
      }
      const rawBytes = fs.readFileSync(claimPath);
      if (lib.sha256Hex(rawBytes) !== head.entry.facts.claimSha256) {
        throw new DeploymentStateError('claim file bytes do not cross-match the claimed generation', 'claim-mismatch');
      }
      return {
        ok: true, verb: 'claim-attempt', deploymentId: args['deployment-id'],
        phase: 'claimed', generation: head.generation, headSha256: head.sha256,
        claimPath, claimSha256: head.entry.facts.claimSha256, resumed: true,
      };
    }

    if (head.entry.phase !== 'ready' && head.entry.phase !== 'ready-revalidated') {
      throw new DeploymentStateError(
        `claim requires the head to be ready|ready-revalidated, got '${head.entry.phase}'`,
        'guard-not-ready'
      );
    }
    if (head.generation !== expectedGeneration || head.sha256 !== args['expected-guard-generation-sha256']) {
      throw new DeploymentStateError('guard chain head does not match the expected generation/sha', 'cas-mismatch');
    }
    if (head.entry.facts.markerSha256 !== args['expected-marker-sha256']) {
      throw new DeploymentStateError('--expected-marker-sha256 does not match the ready marker hash', 'marker-mismatch');
    }
    if (head.entry.controllerGeneration !== controllerGeneration
      || head.entry.targetCommitSha !== args['target-commit']
      || head.entry.controlManifestSha256 !== args['control-manifest-sha256']
      || head.entry.artifactSha256 !== args['artifact-sha256']) {
      throw new DeploymentStateError('claim identity flags do not match the chain common identity', 'guard-identity-mismatch');
    }
    const claimContent = {
      format: 1,
      deploymentId: args['deployment-id'],
      guardGeneration: head.generation,
      guardGenerationSha256: head.sha256,
      markerSha256: args['expected-marker-sha256'],
      controllerGeneration,
      targetCommitSha: args['target-commit'],
      controlManifestSha256: args['control-manifest-sha256'],
      artifactSha256: args['artifact-sha256'],
      bootEpoch: head.entry.bootEpoch,
      bootId: head.entry.bootId,
      guardBootstrapRoot: root,
      createdAt: nowIso(),
    };
    try {
      lib.writeJsonExclusive(claimPath, claimContent, { crashLabelPrefix: 'claim' });
    } catch (err) {
      if (err.code !== 'exclusive-create-conflict') throw err;
      // Crash-resume: only finish when the existing claim's business
      // fields cross-match what this call would have written.
      lib.assertRegularFileMode0600(claimPath);
      const existing = lib.readJsonFile(claimPath);
      const mismatch = CLAIM_BUSINESS_FIELDS.some((k) => existing[k] !== claimContent[k]);
      if (mismatch) {
        throw new DeploymentStateError('an existing claim for this deployment does not cross-match this attempt', 'claim-mismatch');
      }
    }
    const rawBytes = fs.readFileSync(claimPath);
    const claimSha256 = lib.sha256Hex(rawBytes);

    const appended = lib.appendGuardEntry(root, args['deployment-id'], {
      deploymentId: head.entry.deploymentId,
      controllerGeneration: head.entry.controllerGeneration,
      targetCommitSha: head.entry.targetCommitSha,
      artifactSha256: head.entry.artifactSha256,
      controlManifestSha256: head.entry.controlManifestSha256,
      detectedProfile: head.entry.detectedProfile,
      expectedProfile: head.entry.expectedProfile,
      profileMappingSha256: head.entry.profileMappingSha256,
      bootEpoch: head.entry.bootEpoch,
      bootId: head.entry.bootId,
      phase: 'claimed',
      facts: { claimSha256, claimPath },
      result: 'ok',
      createdAt: nowIso(),
    }, { expectedGeneration: head.generation, expectedHeadSha256: head.sha256 });

    return {
      ok: true, verb: 'claim-attempt', deploymentId: args['deployment-id'],
      phase: 'claimed', generation: appended.generation, headSha256: appended.sha256,
      claimPath, claimSha256, resumed: false,
    };
    })
  ));
}

function verbAbandonGuardBootstrap(argv) {
  const args = parseArgs(argv, {
    required: ['guard-bootstrap-root', 'attempts', 'receipts', 'deployment-id',
      'expected-guard-generation', 'expected-guard-generation-sha256',
      'expected-topology-manifest-sha256', 'staging'],
    optional: ['topology-restoration-proof'],
  });
  const root = args['guard-bootstrap-root'];
  for (const [flag, value] of [['--guard-bootstrap-root', root], ['--attempts', args.attempts], ['--receipts', args.receipts], ['--staging', args.staging]]) {
    if (!path.isAbsolute(value)) {
      throw new DeploymentStateError(`${flag} must be an absolute path`, 'shape');
    }
  }
  if (path.basename(args.staging) !== args['deployment-id']) {
    throw new DeploymentStateError('--staging must be the per-deployment staging directory (…/staging/<deployment-id>)', 'shape');
  }
  const expectedGeneration = parsePositiveInt(args['expected-guard-generation'], '--expected-guard-generation');
  lib.assertSha256Hex(args['expected-guard-generation-sha256'], '--expected-guard-generation-sha256');
  lib.assertSha256Hex(args['expected-topology-manifest-sha256'], '--expected-topology-manifest-sha256');
  const deploymentId = args['deployment-id'];

  const attemptAuthorityPath = lib.attemptTombstonePath(args.attempts, deploymentId);
  return lib.withStateMutation(attemptAuthorityPath, deploymentId, () => (
    lib.withStateMutation(root, deploymentId, () => {
    let chain = requireGuardChain(root, deploymentId);
    let head = chain.head;
    if (head.generation !== expectedGeneration || head.sha256 !== args['expected-guard-generation-sha256']) {
      throw new DeploymentStateError('guard chain head does not match the expected generation/sha', 'cas-mismatch');
    }

    let resumedTerminal = false;
    if (head.entry.phase === 'abandoned') {
      resumedTerminal = true;
    } else if (head.entry.phase !== 'abandoning') {
      // Fresh abandon. Legal from any nonterminal epoch phase, or from
      // claimed only while no parent state is armed.
      if (head.entry.phase === 'claimed') {
        if (lib.readAttemptTombstone(args.attempts, deploymentId) !== null) {
          throw new DeploymentStateError(
            'cannot abandon a claimed guard bootstrap once the parent deployment is armed (recovery is the only authority)',
            'armed-parent'
          );
        }
      }
      // A stop intent is the first durable mutation obligation. It remains
      // unresolved across epoch invalidation/restart. Its first epoch's
      // topology snapshot is the only restoration target: a later snapshot
      // may describe an already-mutated live tree and cannot rebind it.
      const { mutationEntries, snapshot } = unresolvedGuardMutationAuthority(chain);
      const expectedTopo = snapshot ? snapshot.entry.facts.topologyManifestSha256 : lib.GUARD_ABSENT_SHA256;
      if (args['expected-topology-manifest-sha256'] !== expectedTopo) {
        throw new DeploymentStateError('--expected-topology-manifest-sha256 does not match the unresolved topology restoration authority', 'manifest-mismatch');
      }

      let abandoningFacts;
      if (mutationEntries.length === 0) {
        const unchangedRoleAuthoritySha256 = assertPriorRoleAuthorityUnchanged(chain, root);
        abandoningFacts = {
          mutationOccurred: false,
          headPhaseAtAbandon: head.entry.phase,
          headGenerationAtAbandon: head.generation,
          unchangedRoleAuthoritySha256,
        };
      } else {
        if (!snapshot) {
          throw new DeploymentStateError(
            'a durable stop intent exists without a topology snapshot; exact prior role restoration is required before abandonment',
            'role-restoration-required'
          );
        }
        if (!args['topology-restoration-proof']) {
          throw new DeploymentStateError('mutated topology abandonment requires --topology-restoration-proof', 'proof-missing');
        }
        const proof = lib.readTopologyRestorationProof(args['topology-restoration-proof']);
        if (proof.content.deploymentId !== deploymentId
            || proof.content.topologyManifestSha256 !== snapshot.entry.facts.topologyManifestSha256) {
          throw new DeploymentStateError('topology restoration proof does not cross-bind the abandoning chain', 'proof-mismatch');
        }
        abandoningFacts = {
          mutationOccurred: true,
          topologySnapshotSha256: snapshot.entry.facts.topologyManifestSha256,
          restoreTargetSha256: snapshot.entry.facts.topologyManifestSha256,
          lastMutationGeneration: mutationEntries[mutationEntries.length - 1].generation,
          topologyRestorationProofSha256: proof.sha256,
          compatibilityManifestSha256: proof.content.compatibilityManifestSha256,
        };
      }

      lib.appendGuardEntry(root, deploymentId, {
        deploymentId: head.entry.deploymentId,
        controllerGeneration: head.entry.controllerGeneration,
        targetCommitSha: head.entry.targetCommitSha,
        artifactSha256: head.entry.artifactSha256,
        controlManifestSha256: head.entry.controlManifestSha256,
        detectedProfile: head.entry.detectedProfile,
        expectedProfile: head.entry.expectedProfile,
        profileMappingSha256: head.entry.profileMappingSha256,
        bootEpoch: head.entry.bootEpoch,
        bootId: lib.getBootId(),
        phase: 'abandoning',
        facts: abandoningFacts,
        result: 'ok',
        createdAt: nowIso(),
      }, { expectedGeneration: head.generation, expectedHeadSha256: head.sha256 });
      chain = requireGuardChain(root, deploymentId);
      head = chain.head;
    }

    // From here on the head is `abandoning` (fresh or crash-resumed) or
    // `abandoned` (resumedTerminal). All receipt content derives from the
    // chain, so a resume rebuilds byte-identical business fields.
    const abandoningRec = chain.entries.filter((e) => e.entry.phase === 'abandoning').pop();
    if (!abandoningRec) {
      throw new DeploymentStateError('no abandoning generation exists to complete', 'guard-chain-corrupt');
    }
    const mutationOccurred = abandoningRec.entry.facts.mutationOccurred;

    // Full immutable history through the abandoning entry is the lookup
    // scope. Restricting this to the latest epoch would erase a prior
    // epoch's unresolved stop/mutation obligation after reboot.
    const abandoningIndex = chain.entries.indexOf(abandoningRec);
    const epochSlice = chain.entries.slice(0, abandoningIndex + 1);
    const findInSlice = (phase) => {
      for (let j = epochSlice.length - 1; j >= 0; j--) {
        if (epochSlice[j].entry.phase === phase) return epochSlice[j];
      }
      return null;
    };
    const installed = findInSlice('safety-installed');
    let restorationProof = null;
    if (mutationOccurred) {
      if (!args['topology-restoration-proof']) {
        throw new DeploymentStateError('mutated topology abandonment requires --topology-restoration-proof', 'proof-missing');
      }
      restorationProof = lib.readTopologyRestorationProof(args['topology-restoration-proof']);
      if (restorationProof.content.deploymentId !== deploymentId
          || restorationProof.content.topologyManifestSha256 !== abandoningRec.entry.facts.restoreTargetSha256
          || restorationProof.sha256 !== abandoningRec.entry.facts.topologyRestorationProofSha256
          || restorationProof.content.compatibilityManifestSha256 !== abandoningRec.entry.facts.compatibilityManifestSha256) {
        throw new DeploymentStateError('topology restoration proof does not cross-bind the abandoning chain', 'proof-mismatch');
      }
    }

    const assertFreshAbandonAuthority = () => {
      if (!mutationOccurred) {
        const currentSha256 = assertPriorRoleAuthorityUnchanged(chain, root);
        if (currentSha256 !== abandoningRec.entry.facts.unchangedRoleAuthoritySha256) {
          throw new DeploymentStateError('fresh untouched role authority changed after abandoning CAS', 'role-restoration-required');
        }
        return null;
      }
      const currentProof = lib.readTopologyRestorationProof(args['topology-restoration-proof']);
      if (currentProof.content.deploymentId !== deploymentId
          || currentProof.content.topologyManifestSha256 !== abandoningRec.entry.facts.restoreTargetSha256
          || currentProof.sha256 !== abandoningRec.entry.facts.topologyRestorationProofSha256
          || currentProof.content.compatibilityManifestSha256 !== abandoningRec.entry.facts.compatibilityManifestSha256) {
        throw new DeploymentStateError('fresh topology restoration proof does not cross-bind the abandoning chain', 'proof-mismatch');
      }
      assertCurrentRestorationProofAuthority(currentProof);
      return assertCurrentTargetSafetyAuthority(currentProof, installed ? installed.entry.facts : null);
    };

    // `safety-installing` is published before the first permanent-safety
    // write. A crash can therefore leave real installed bytes without a
    // later `safety-installed` generation. The immutable restoration proof
    // and its live-verified target-safety manifest are the authority in that
    // window; never substitute the topology snapshot hash for an inhibitor
    // identity or claim that guard-aware 94 was never installed.
    const verifiedSafety = assertFreshAbandonAuthority();
    const verifiedSafetyEntries = verifiedSafety
      ? new Map(verifiedSafety.content.entries.map((entry) => [entry.path, entry])) : null;
    const verifiedInhibitor = verifiedSafetyEntries
      ? verifiedSafetyEntries.get('/etc/init.d/osi-deployment-inhibit') : null;
    const verifiedGuard94 = verifiedSafetyEntries
      ? verifiedSafetyEntries.get('/etc/uci-defaults/94_osi_identityd_enable') : null;
    if (mutationOccurred
        && (!verifiedInhibitor || verifiedInhibitor.type !== 'file'
          || !verifiedGuard94 || verifiedGuard94.type !== 'file')) {
      throw new DeploymentStateError(
        'restored permanent-safety manifest lacks the inhibitor or guard-aware 94 file',
        'manifest-mismatch'
      );
    }

    const topologyReceiptContent = {
      format: 1,
      receiptKind: 'topology-activation',
      authorityKind: 'guard-bootstrap',
      operationId: deploymentId,
      deploymentId,
      topologyOutcome: mutationOccurred ? 'restored' : 'unmutated',
      guardGeneration: abandoningRec.generation,
      guardGenerationSha256: abandoningRec.sha256,
      sixLinkTopologySha256: mutationOccurred
        ? restorationProof.content.sixLinkTopologySha256 : lib.GUARD_ABSENT_SHA256,
      guardAware94: mutationOccurred
        ? { state: 'present', sha256: verifiedGuard94.sha256 }
        : { state: 'never-installed' },
      inhibitorSha256: mutationOccurred ? verifiedInhibitor.sha256 : lib.GUARD_ABSENT_SHA256,
      topologyRestorationProofPath: restorationProof ? restorationProof.path : '',
      topologyRestorationProofSha256: restorationProof ? restorationProof.sha256 : lib.GUARD_ABSENT_SHA256,
      compatibilityManifestSha256: restorationProof
        ? restorationProof.content.compatibilityManifestSha256 : lib.GUARD_ABSENT_SHA256,
      createdAt: nowIso(),
    };
    let topologyReceipt = lib.readReceipt(args.receipts, deploymentId, 'topology-activation');
    if (topologyReceipt) {
      const mismatch = Object.keys(topologyReceiptContent)
        .filter((k) => k !== 'createdAt' && k !== 'guardAware94')
        .some((k) => topologyReceipt.content[k] !== topologyReceiptContent[k])
        || lib.canonicalize(topologyReceipt.content.guardAware94) !== lib.canonicalize(topologyReceiptContent.guardAware94);
      if (mismatch) {
        throw new DeploymentStateError('an existing topology-activation receipt does not match this abandon (not a valid resume)', 'receipt-mismatch');
      }
    } else {
      topologyReceipt = lib.writeReceipt(args.receipts, deploymentId, 'topology-activation', topologyReceiptContent);
      topologyReceipt = lib.readReceipt(args.receipts, deploymentId, 'topology-activation');
    }

    const claimConsumed = lib.lstatOrNull(guardClaimPath(args.attempts, deploymentId)) !== null;
    const abandonmentContent = {
      format: 1,
      receiptKind: 'abandonment',
      operationId: deploymentId,
      deploymentId,
      abandoningGeneration: abandoningRec.generation,
      abandoningGenerationSha256: abandoningRec.sha256,
      topologyActivationReceiptSha256: topologyReceipt.sha256,
      mutationOccurred,
      claimConsumed,
      stagingPath: args.staging,
      createdAt: nowIso(),
    };
    assertFreshAbandonAuthority();
    let abandonmentReceipt = lib.readReceipt(args.receipts, deploymentId, 'abandonment');
    if (abandonmentReceipt) {
      const mismatch = Object.keys(abandonmentContent)
        .filter((k) => k !== 'createdAt')
        .some((k) => abandonmentReceipt.content[k] !== abandonmentContent[k]);
      if (mismatch) {
        throw new DeploymentStateError('an existing abandonment receipt does not match this abandon (not a valid resume)', 'receipt-mismatch');
      }
    } else {
      abandonmentReceipt = lib.writeReceipt(args.receipts, deploymentId, 'abandonment', abandonmentContent);
      abandonmentReceipt = lib.readReceipt(args.receipts, deploymentId, 'abandonment');
    }

    if (resumedTerminal) {
      // Head already abandoned: bind-check its facts against the receipts.
      if (head.entry.facts.topologyActivationReceiptSha256 !== topologyReceipt.sha256
        || head.entry.facts.abandonmentReceiptSha256 !== abandonmentReceipt.sha256) {
        throw new DeploymentStateError('abandoned facts do not bind the on-disk receipts', 'receipt-mismatch');
      }
      return {
        ok: true, verb: 'abandon-guard-bootstrap', deploymentId,
        phase: 'abandoned', generation: head.generation, headSha256: head.sha256,
        topologyActivationReceiptSha256: topologyReceipt.sha256,
        abandonmentReceiptSha256: abandonmentReceipt.sha256,
        mutationOccurred, resumed: true,
      };
    }

    assertFreshAbandonAuthority();
    const appended = lib.appendGuardEntry(root, deploymentId, {
      deploymentId: head.entry.deploymentId,
      controllerGeneration: head.entry.controllerGeneration,
      targetCommitSha: head.entry.targetCommitSha,
      artifactSha256: head.entry.artifactSha256,
      controlManifestSha256: head.entry.controlManifestSha256,
      detectedProfile: head.entry.detectedProfile,
      expectedProfile: head.entry.expectedProfile,
      profileMappingSha256: head.entry.profileMappingSha256,
      bootEpoch: abandoningRec.entry.bootEpoch,
      bootId: lib.getBootId(),
      phase: 'abandoned',
      facts: {
        topologyActivationReceiptSha256: topologyReceipt.sha256,
        abandonmentReceiptSha256: abandonmentReceipt.sha256,
      },
      result: 'ok',
      createdAt: nowIso(),
    }, { expectedGeneration: chain.head.generation, expectedHeadSha256: chain.head.sha256 });

    return {
      ok: true, verb: 'abandon-guard-bootstrap', deploymentId,
      phase: 'abandoned', generation: appended.generation, headSha256: appended.sha256,
      topologyActivationReceiptSha256: topologyReceipt.sha256,
      abandonmentReceiptSha256: abandonmentReceipt.sha256,
      mutationOccurred, resumed: false,
    };
    })
  ));
}

// ---------------------------------------------------------------------------
// authorize-topology-activation.
//
// Verifies the expected six-link topology SHA, the guard-aware-94
// hash-or-absence identity, and the inhibitor SHA against the chain, then
// writes the topology-activation receipt with authorityKind
// 'guard-bootstrap' (the discriminator the core slice reserved).
//
// Concretizations (documented in the execution report):
// - --expected-phase names the authorization CONTEXT: 'abandoning' targets
//   the chain of --operation-id itself (head must be `abandoning`);
//   'recovery-topology-verifying' targets the claimed chain of the parent
//   deployment named by the state file's active recovery sub-operation
//   (whose operationId must equal --operation-id). `advance-recovery`
//   performs the explicit started -> topology-verifying CAS; successful
//   authorization advances it to topology-authorized.
// - The guard-aware identity file is plan line 200's exact closed shape:
//   {state:'present',sha256:<hash>} or
//   {state:'absent',consumptionReceiptSha256:<sha>}. This slice rejects
//   absence in both authorization contexts. The absent shape is reserved
//   for deploy integration after it adds typed, generation-bound
//   consumption-receipt authority and verifies the receipt against the
//   same terminal generation.
// - An existing receipt is a valid resume only when every business field
//   cross-matches; authorize and abandon build receipt content from the
//   same chain facts, so either may write first and the other reuses it.
// ---------------------------------------------------------------------------

const AUTHORIZE_EXPECTED_PHASES = ['recovery-topology-verifying', 'abandoning'];

function verbAuthorizeTopologyActivation(argv) {
  const args = parseArgs(argv, {
    required: ['state', 'guard-bootstrap-root', 'receipts', 'operation-id', 'expected-phase',
      'expected-six-link-topology-sha256', 'guard-aware-uci-default', 'inhibitor-sha256',
      'topology-restoration-proof'],
  });
  const root = args['guard-bootstrap-root'];
  if (!path.isAbsolute(root) || !path.isAbsolute(args.receipts) || !path.isAbsolute(args.state)) {
    throw new DeploymentStateError('--state, --guard-bootstrap-root and --receipts must be absolute paths', 'shape');
  }
  if (!AUTHORIZE_EXPECTED_PHASES.includes(args['expected-phase'])) {
    throw new DeploymentStateError(
      `--expected-phase must be one of: ${AUTHORIZE_EXPECTED_PHASES.join('|')}`,
      'shape'
    );
  }
  lib.assertSha256Hex(args['expected-six-link-topology-sha256'], '--expected-six-link-topology-sha256');
  lib.assertSha256Hex(args['inhibitor-sha256'], '--inhibitor-sha256');

  // Guard-aware 94 hash-or-absence identity (plan line 200 closed shapes).
  const guard94 = readRootOnlyJsonFile(args['guard-aware-uci-default'], '--guard-aware-uci-default');
  lib.assertPlainObject(guard94, 'guard-aware-uci-default');
  if (guard94.state === 'present') {
    lib.assertExactFields(guard94, ['state', 'sha256'], 'guard-aware-uci-default');
    lib.assertSha256Hex(guard94.sha256, 'guard-aware-uci-default.sha256');
  } else if (guard94.state === 'absent') {
    lib.assertExactFields(guard94, ['state', 'consumptionReceiptSha256'], 'guard-aware-uci-default');
    lib.assertSha256Hex(guard94.consumptionReceiptSha256, 'guard-aware-uci-default.consumptionReceiptSha256');
  } else {
    throw new DeploymentStateError("guard-aware-uci-default.state must be 'present' or 'absent'", 'shape');
  }

  let recoveryState = null;
  const authorizeUnderGuardLock = () => lib.withStateMutation(root, args['operation-id'], () => {
    // Resolve the chain this authorization verifies against.
    let chainDeploymentId;
    if (args['expected-phase'] === 'abandoning') {
      chainDeploymentId = args['operation-id'];
      const state = lib.readState(args.state);
      if (state && state.parentDeployment.deploymentId === chainDeploymentId) {
        throw new DeploymentStateError(
          'a parent deployment state exists for this deployment; after arm, recovery is the only authority',
          'armed-parent'
        );
      }
    } else {
      const state = lib.readState(args.state);
      if (!state) {
        throw new DeploymentStateError('no deployment state', 'state-missing');
      }
      const sub = state.activeSubOperation;
      if (!sub || sub.kind !== 'recovery') {
        throw new DeploymentStateError('no active recovery sub-operation', 'no-active-recovery');
      }
      if (sub.operationId !== args['operation-id']) {
        throw new DeploymentStateError('--operation-id does not match the active recovery sub-operation', 'operation-id-mismatch');
      }
      if (!['recovery-topology-verifying', 'recovery-topology-authorized'].includes(sub.phase)) {
        throw new DeploymentStateError(
          `recovery topology authorization requires state phase 'recovery-topology-verifying', got '${sub.phase}'`,
          'cas-mismatch'
        );
      }
      recoveryState = state;
      chainDeploymentId = sub.parentDeploymentId;
    }

    const chain = requireGuardChain(root, chainDeploymentId);
    const head = chain.head;
    if (args['expected-phase'] === 'abandoning') {
      if (head.entry.phase !== 'abandoning') {
        throw new DeploymentStateError(
          `abandoning authorization requires the chain head to be 'abandoning', got '${head.entry.phase}'`,
          'cas-mismatch'
        );
      }
    } else if (head.entry.phase !== 'claimed') {
      throw new DeploymentStateError(
        `recovery authorization requires the parent chain head to be 'claimed', got '${head.entry.phase}'`,
        'cas-mismatch'
      );
    }

    // Recovery authorization uses the latest claimed epoch. Pre-arm
    // abandonment is different: abandon-guard-bootstrap records the first
    // unresolved mutation's snapshot/proof authority, which must remain the
    // source of truth after a reboot creates a later epoch. Never reselect a
    // later topology snapshot for that context.
    let quarantined;
    let installed;
    let snapshot;
    if (args['expected-phase'] === 'abandoning') {
      const abandoning = [...chain.entries].reverse()
        .find((record) => record.entry.phase === 'abandoning');
      const unresolved = unresolvedGuardMutationAuthority(chain);
      const authorityBootEpoch = unresolved.snapshot
        ? unresolved.snapshot.entry.bootEpoch
        : abandoning && abandoning.entry.bootEpoch;
      const hasQuarantinedTopology = Boolean(abandoning && chain.entries.some((record) => (
        record.entry.bootEpoch === authorityBootEpoch
        && record.generation <= abandoning.generation
        && record.entry.phase === 'links-quarantined'
      )));
      if (!hasQuarantinedTopology) {
        throw new DeploymentStateError('this epoch never quarantined the application links; there is no topology to authorize', 'no-quarantined-topology');
      }
      if (!abandoning || abandoning.entry.facts.mutationOccurred !== true) {
        throw new DeploymentStateError(
          'abandoning authorization requires the mutation-bearing abandoning authority',
          'guard-fact-binding'
        );
      }
      const recorded = abandoning.entry.facts;
      if (!unresolved.snapshot
          || recorded.topologySnapshotSha256 !== unresolved.snapshot.entry.facts.topologyManifestSha256
          || recorded.restoreTargetSha256 !== unresolved.snapshot.entry.facts.topologyManifestSha256
          || recorded.lastMutationGeneration !== unresolved.mutationEntries[unresolved.mutationEntries.length - 1].generation) {
        throw new DeploymentStateError(
          'abandoning authority does not bind the first unresolved mutation snapshot',
          'guard-fact-binding'
        );
      }
      snapshot = unresolved.snapshot;
      const firstEpochEntries = chain.entries.filter((record) => (
        record.entry.bootEpoch === snapshot.entry.bootEpoch
        && record.generation <= abandoning.generation
      ));
      quarantined = [...firstEpochEntries].reverse()
        .find((record) => record.entry.phase === 'links-quarantined') || null;
      installed = [...firstEpochEntries].reverse()
        .find((record) => record.entry.phase === 'safety-installed') || null;
    } else {
      // Epoch slice at the head, for bound-fact lookup.
      let epochStart = 0;
      for (let j = chain.entries.length - 1; j >= 0; j--) {
        if (chain.entries[j].entry.phase === 'epoch-start') { epochStart = j; break; }
      }
      const epochSlice = chain.entries.slice(epochStart);
      const findInSlice = (phase) => {
        for (let j = epochSlice.length - 1; j >= 0; j -= 1) {
          if (epochSlice[j].entry.phase === phase) return epochSlice[j];
        }
        return null;
      };
      quarantined = findInSlice('links-quarantined');
      installed = findInSlice('safety-installed');
      snapshot = findInSlice('topology-snapshotted');
    }

    if (!quarantined) {
      throw new DeploymentStateError('this epoch never quarantined the application links; there is no topology to authorize', 'no-quarantined-topology');
    }
    if (!installed) {
      throw new DeploymentStateError('this epoch has no installed target safety to verify against', 'no-installed-safety');
    }
    if (installed.entry.facts.inhibitorSha256 !== args['inhibitor-sha256']) {
      throw new DeploymentStateError('--inhibitor-sha256 does not match the chain-bound inhibitor hash', 'inhibitor-mismatch');
    }
    if (guard94.state === 'present') {
      if (guard94.sha256 !== installed.entry.facts.guardAware94Sha256) {
        throw new DeploymentStateError('guard-aware 94 hash does not match the chain-bound installed hash', 'guard-94-mismatch');
      }
    } else {
      // The absent shape is reserved for the future deploy integration,
      // which must resolve a typed consumption receipt and prove that it
      // belongs to the same terminal generation. This slice's receipt
      // address requires operation-id + kind, while guardAware94 supplies
      // only a SHA and the closed receipt enum has no consumption kind.
      if (args['expected-phase'] === 'abandoning') {
        throw new DeploymentStateError(
          'a nonterminal target-safety identity must be exactly present; unexplained absence is never accepted',
          'guard-94-absence-rejected'
        );
      }
      throw new DeploymentStateError(
        'guard-aware 94 absence cannot be authorized because this slice cannot resolve and type-check its consumption receipt',
        'guard-94-consumption-unverifiable'
      );
    }

    if (!snapshot) {
      throw new DeploymentStateError('the authority epoch has no immutable topology snapshot', 'proof-missing');
    }
    const restorationProof = lib.readTopologyRestorationProof(args['topology-restoration-proof']);
    if (restorationProof.content.deploymentId !== chainDeploymentId
        || restorationProof.content.topologyManifestSha256 !== snapshot.entry.facts.topologyManifestSha256
        || restorationProof.content.sixLinkTopologySha256 !== args['expected-six-link-topology-sha256']) {
      throw new DeploymentStateError('topology restoration proof does not cross-bind the claimed guard chain', 'proof-mismatch');
    }
    if (args['expected-phase'] === 'abandoning'
        && (restorationProof.sha256 !== head.entry.facts.topologyRestorationProofSha256
          || restorationProof.content.compatibilityManifestSha256 !== head.entry.facts.compatibilityManifestSha256)) {
      throw new DeploymentStateError('topology restoration proof changed after the abandoning CAS', 'proof-mismatch');
    }
    // The abandoning generation binds the immutable proof bytes. Verify that
    // authority before consuming the proof as the baseline for a fresh live
    // topology measurement; otherwise one mutation can ambiguously report a
    // derived live mismatch instead of the failed proof CAS.
    assertCurrentRestorationProofAuthority(restorationProof);
    assertCurrentTargetSafetyAuthority(restorationProof, installed.entry.facts);
    if (recoveryState) {
      assertRestorationProofPredecessor(
        restorationProof,
        recoveryState.activeSubOperation.restoredPredecessor
      );
    } else {
      if (restorationProof.content.restoredPredecessor.kind !== 'legacy-compatibility') {
        throw new DeploymentStateError(
          'pre-arm abandonment has no managed terminal authority; its predecessor must be legacy compatibility',
          'predecessor-unverified'
        );
      }
      assertRestorationProofPredecessor(restorationProof, restorationProof.content.restoredPredecessor);
    }

    const content = {
      format: 1,
      receiptKind: 'topology-activation',
      authorityKind: 'guard-bootstrap',
      operationId: args['operation-id'],
      deploymentId: chainDeploymentId,
      topologyOutcome: 'restored',
      guardGeneration: head.generation,
      guardGenerationSha256: head.sha256,
      sixLinkTopologySha256: restorationProof.content.sixLinkTopologySha256,
      guardAware94: guard94,
      inhibitorSha256: installed.entry.facts.inhibitorSha256,
      topologyRestorationProofPath: restorationProof.path,
      topologyRestorationProofSha256: restorationProof.sha256,
      compatibilityManifestSha256: restorationProof.content.compatibilityManifestSha256,
      createdAt: nowIso(),
    };
    let receipt = lib.readReceipt(args.receipts, args['operation-id'], 'topology-activation');
    let resumed = false;
    if (receipt) {
      const mismatch = Object.keys(content)
        .filter((k) => k !== 'createdAt' && k !== 'guardAware94')
        .some((k) => receipt.content[k] !== content[k])
        || lib.canonicalize(receipt.content.guardAware94) !== lib.canonicalize(content.guardAware94);
      if (mismatch) {
        throw new DeploymentStateError('an existing topology-activation receipt does not match this authorization (not a valid resume)', 'receipt-mismatch');
      }
      resumed = true;
    } else {
      lib.writeReceipt(args.receipts, args['operation-id'], 'topology-activation', content);
      receipt = lib.readReceipt(args.receipts, args['operation-id'], 'topology-activation');
    }

    if (recoveryState) {
      const sub = recoveryState.activeSubOperation;
      if (sub.phase === 'recovery-topology-authorized') {
        if (sub.topologyActivationReceiptSha256 !== receipt.sha256) {
          throw new DeploymentStateError('authorized recovery state is bound to a different topology receipt', 'receipt-mismatch');
        }
      } else {
        const nextSub = {
          ...sub,
          phase: 'recovery-topology-authorized',
          topologyActivationReceiptSha256: receipt.sha256,
          generation: sub.generation + 1,
        };
        lib.writeState(args.state, { ...recoveryState, activeSubOperation: nextSub });
      }
    }

    return {
      ok: true,
      verb: 'authorize-topology-activation',
      operationId: args['operation-id'],
      deploymentId: chainDeploymentId,
      expectedPhase: args['expected-phase'],
      topologyActivationReceiptSha256: receipt.sha256,
      resumed,
    };
  });
  if (args['expected-phase'] === 'recovery-topology-verifying') {
    return lib.withStateMutation(args.state, args['operation-id'], authorizeUnderGuardLock);
  }
  return authorizeUnderGuardLock();
}

// ---------------------------------------------------------------------------
// Out-of-scope verbs (explicit reject, not silently unknown)
// ---------------------------------------------------------------------------

const FORBIDDEN_VERBS = new Set([
  'initialize-image-baseline',
  'complete-image-baseline',
  'collect-staging',
  'retry-staging-gc',
]);

const VERBS = {
  'acquire-lock': verbAcquireLock,
  arm: verbArm,
  advance: verbAdvance,
  status: verbStatus,
  'startup-check': verbStartupCheck,
  'record-launch-start': verbRecordLaunchStart,
  'issue-probe-permit': verbIssueProbePermit,
  finish: verbFinish,
  complete: verbComplete,
  'begin-recovery': verbBeginRecovery,
  'advance-recovery': verbAdvanceRecovery,
  recover: verbRecover,
  'release-lock': verbReleaseLock,
  'begin-guard-bootstrap': verbBeginGuardBootstrap,
  'advance-guard-bootstrap': verbAdvanceGuardBootstrap,
  'status-guard-bootstrap': verbStatusGuardBootstrap,
  'claim-attempt': verbClaimAttempt,
  'abandon-guard-bootstrap': verbAbandonGuardBootstrap,
  'authorize-topology-activation': verbAuthorizeTopologyActivation,
};

function main(argv) {
  const [verb, ...rest] = argv;
  if (!verb) {
    throw new DeploymentStateError('missing verb', 'missing-verb');
  }
  if (FORBIDDEN_VERBS.has(verb)) {
    throw new DeploymentStateError(
      `verb '${verb}' is not implemented in this slice (ordinary deployment lifecycle only)`,
      'verb-out-of-scope'
    );
  }
  if (!(verb in VERBS) || VERBS[verb] === null) {
    throw new DeploymentStateError(`unknown verb: ${verb}`, 'unknown-verb');
  }
  return VERBS[verb](rest);
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    const code = err && err.code ? err.code : 'internal-error';
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message, code })}\n`);
    process.exit(1);
  }
}

module.exports = {
  main,
  VERBS,
  FORBIDDEN_VERBS,
  ADVANCE_TRANSITIONS,
  readRootOnlyJsonFile,
  readLaunchProcess,
  parseArgs,
  computeMountIdentity,
};
