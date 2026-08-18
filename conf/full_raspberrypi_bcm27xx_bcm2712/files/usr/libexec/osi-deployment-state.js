'use strict';

// Deployment-state codec + verbs for the ordinary Train A deploy lifecycle.
//
// Scope note (A0 commit-1 sub-tranche, see
// docs/superpowers/plans/2026-07-15-refactor-repair-program.md Task A0,
// "Make Train A recoverable after SIGKILL or power loss" through
// "Serialize every deploy attempt"): this module owns the ordinary
// deployment/recovery lifecycle only. Guard-bootstrap, image-baseline,
// staging-GC, and rehearsal sub-operations are out of scope for this slice
// and are rejected wherever this module would otherwise have to accept them.
//
// The plan's prose describes field *behavior* but does not hand down a
// literal JSON schema for parentDeployment/activeSubOperation the way it
// does for the envelope shape, phase enum, receipt-kind enum,
// restoredPredecessor union, and terminal-receipts identity shapes (which
// this module matches verbatim). Where the plan is silent on exact field
// names for supporting bookkeeping (e.g. a monotonic `generation` counter
// used for CAS), this module defines a closed, documented schema and the
// accompanying report calls out that choice explicitly.
//
// The mutation lock uses immutable per-controller contenders rather than a
// replaceable singleton lockfile. Each contender receives a monotonically
// increasing ticket, published atomically with link(2). After publication,
// a controller may enter only when no lower same-boot live ticket exists.
// Contenders racing for the same next ticket serialize at the final hard link, so exactly the
// lowest live ticket can enter. Stale/foreign records are never
// renamed or deleted, so a delayed reclaimer cannot displace a fresh holder.
// Release is ownership checked and removes only the caller's exact token.
// This depends on hard links: /data/osi-deploy MUST be on a filesystem that
// supports link(2) (ext4/f2fs/ubifs qualify).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 2;
// Test-boundary identity is fixed when the module is loaded. Tests may patch
// process.getuid() to exercise ownership rejection, but that must not also
// move the explicitly authorized test root out from under the operation.
const AUTHORITY_PROCESS_UID = process.getuid();

// Verbatim from the plan: "Ordinary deployment/terminal parent phases are
// `armed`, `writers-stopped`, `protocol-initializing`,
// `protocol-dispositioning`, `protocol-ready`,
// `protocol-reconciliation-required`, `resident-mutating`,
// `payload-mutating`, `probes-running`, `runtime-verified`,
// `verification-in-flight`, `completed`, and `recovered`".
const ORDINARY_PARENT_PHASES = Object.freeze([
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

// Verbatim: "factory-only `image-baseline-initializing` is the additional
// closed phase ... and is rejected by generic transitions."
const FACTORY_ONLY_PARENT_PHASE = 'image-baseline-initializing';
// Factory baseline state is a separate, closed envelope.  Generic lifecycle
// validation intentionally rejects these phases; ROM consumers use this
// validator when checking the state created by the image-baseline verbs.
const FACTORY_BASELINE_PARENT_PHASES = Object.freeze([
  'image-baseline-initializing',
]);
const FACTORY_BASELINE_PREFIXES = Object.freeze([
  'image-preactivation',
  'baseline-completing',
]);
const FACTORY_BASELINE_PARENT_FIELDS = Object.freeze([
  'deploymentId', 'phase', 'generation', 'imageBaselinePrefix', 'databaseLineage',
  'factoryProvenanceSha256',
  'factoryZeroAuthority',
  // The factory verbs may carry the ordinary identity/timestamp fields while
  // they share the format-2 envelope; keep the accepted set closed.
  'leaseActive', 'attemptSha256', 'targetCommitSha', 'controllerGeneration',
  'claimSha256', 'claimPath', 'createdAt', 'updatedAt',
]);

const TERMINAL_PARENT_PHASES = Object.freeze(['completed', 'recovered']);

// Verbatim closed receipt-kind enum from the plan.
const RECEIPT_KINDS = Object.freeze([
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

// Verbatim: activeSubOperation is "either null or one exact
// recovery|selection-rehearsal|staging-gc record". Only 'recovery' has an
// implemented begin/finish path in this slice; the other two are
// codec-valid (so a hand-built fixture round-trips) but no in-scope verb
// can create or advance them.
const SUB_OPERATION_KINDS = Object.freeze(['recovery', 'selection-rehearsal', 'staging-gc']);
const IMPLEMENTED_SUB_OPERATION_KINDS = Object.freeze(['recovery']);

// Verbatim closed purpose enum for issue-probe-permit. Only
// deployment-probe has satisfiable preconditions in this slice. Recovery
// health remains codec-valid but cannot be issued until a clean database
// restore or typed DATABASE_RESTORE_RECONCILED authority is represented.
const PROBE_PERMIT_PURPOSES = Object.freeze([
  'deployment-probe',
  'recovery-health',
  'integrity-recovery-health',
  'rehearsal-old-probe',
  'rehearsal-new-probe',
]);

// Verbatim closed databaseLineage union imported from the stop-loss codec.
// This slice validates shape/membership only ("codec-level validation of
// the closed union"); transition legality (factory-pending -> valid,
// valid -> invalidating -> invalidated) is out of scope here.
const DATABASE_LINEAGE_STATUSES = Object.freeze([
  'not-applicable',
  'factory-pending',
  'valid',
  'invalidating',
  'invalidated',
]);

// Verbatim closed restoredPredecessor union.
const RESTORED_PREDECESSOR_KINDS = Object.freeze(['managed-terminal', 'legacy-compatibility']);

const PROBE_PERMIT_SERVICES = Object.freeze(['node-red']);
const STARTUP_CHECK_SERVICES = Object.freeze([
  'node-red',
  'osi-identityd',
  'osi-bootstrap',
  'osi-db-integrity',
]);

// One shared inventory/measurement implementation is used by both the
// compatibility-set proof producer and the resident state CLI consumer.
// Keeping the paths and canonicalization here prevents a proof from being
// accepted with a weaker, drifted remeasurement algorithm.
const COMPATIBILITY_TOPOLOGY_PATHS = Object.freeze([
  '/srv/node-red', '/usr/lib/node-red/gui',
  '/etc/init.d/node-red', '/etc/init.d/osi-bootstrap', '/etc/init.d/osi-db-integrity', '/etc/init.d/osi-identityd',
  '/etc/uci-defaults/93_osi_deploy_guard_init', '/etc/uci-defaults/97_osi_db_seed',
  '/usr/share/osi-deploy/image-guard-manifest.json', '/usr/share/node-red/osi-db-integrity', '/etc/osi-bootstrap.done',
  '/etc/rc.d/S90osi-db-integrity', '/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd',
  '/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red', '/etc/rc.d/S99osi-bootstrap',
  '/usr/libexec/osi-identityd.sh', '/usr/libexec/osi-gateway-identity.sh',
  '/usr/libexec/osi-deployment-state.js', '/usr/libexec/osi-deployment-state-cli.js',
  '/usr/libexec/osi-node-red-guarded-launch.js', '/usr/libexec/osi-factory-database-seed.js',
  '/usr/libexec/osi-factory-database-seed-cli.js', '/usr/libexec/osi-audit-command-ack-state.js',
  '/usr/libexec/osi-sync-protocol-capability-cli.js',
  '/usr/libexec/osi-run-staged-npm-ci.sh', '/usr/libexec/osi-backup-pre-deploy.sh',
  '/usr/libexec/osi-restore-pre-deploy.sh', '/usr/libexec/osi-pre-deploy-database-helper.js',
  '/usr/libexec/osi-current-role-state', '/usr/libexec/osi-record-role-start',
  '/etc/init.d/osi-deployment-inhibit', '/etc/rc.d/S01osi-deployment-inhibit',
  '/usr/libexec/osi-deployment-inhibit.sh', '/etc/uci-defaults/94_osi_identityd_enable',
  '/data/osi-deploy/guard-installed.json',
]);
const TARGET_SAFETY_PATHS = Object.freeze([
  '/usr/libexec/osi-deployment-state.js', '/usr/libexec/osi-deployment-state-cli.js',
  '/usr/libexec/osi-node-red-guarded-launch.js',
  '/usr/libexec/osi-current-role-state', '/usr/libexec/osi-record-role-start',
  '/etc/init.d/osi-deployment-inhibit', '/etc/rc.d/S01osi-deployment-inhibit',
  '/usr/libexec/osi-deployment-inhibit.sh', '/etc/uci-defaults/94_osi_identityd_enable',
]);
const SIX_APPLICATION_LINKS = Object.freeze([
  '/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd',
  '/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red',
  '/etc/rc.d/S99osi-bootstrap', '/etc/rc.d/S90osi-db-integrity',
]);
const SIX_APPLICATION_LINK_TARGETS = Object.freeze([
  { path: '/etc/rc.d/S98osi-identityd', target: '../init.d/osi-identityd' },
  { path: '/etc/rc.d/K98osi-identityd', target: '../init.d/osi-identityd' },
  { path: '/etc/rc.d/S99node-red', target: '../init.d/node-red' },
  { path: '/etc/rc.d/K99node-red', target: '../init.d/node-red' },
  { path: '/etc/rc.d/S99osi-bootstrap', target: '../init.d/osi-bootstrap' },
  { path: '/etc/rc.d/S90osi-db-integrity', target: '../init.d/osi-db-integrity' },
].map((entry) => Object.freeze(entry)));

class DeploymentStateError extends Error {
  constructor(message, code) {
    const resolvedCode = code || 'invalid';
    super(`[${resolvedCode}] ${message}`);
    this.name = 'DeploymentStateError';
    this.code = resolvedCode;
  }
}

// ---------------------------------------------------------------------------
// Deterministic crash injection for crash-resume tests. Real SIGKILL-between-
// syscalls timing is not reliably reproducible from a test harness, so every
// write boundary this module cares about (temp-write+fsync, rename,
// parent-dir fsync, O_EXCL create, unlink+parent-fsync) calls maybeCrash()
// with a stable label. Tests set OSI_DEPLOY_STATE_CRASH_AT=<label> and spawn
// the CLI as a child process; when the label matches, this process exits
// immediately via process.exit(137) (SIGKILL-like: no further JS runs, no
// finally blocks beyond what already executed), simulating a kill exactly at
// that boundary. The full label list is documented in the report.
// ---------------------------------------------------------------------------
function maybeCrash(label) {
  const expectedBoundary = path.join('/tmp', `osi-deploy-startup-tests-${process.getuid()}`);
  const enabled = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
    && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
    && process.env.OSI_DEPLOY_TEST_BOUNDARY === expectedBoundary;
  if (enabled && process.env.OSI_DEPLOY_STATE_CRASH_AT === label) {
    process.exit(137);
  }
}

// ---------------------------------------------------------------------------
// Canonicalization + hashing
// ---------------------------------------------------------------------------

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalize(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function canonicalHash(value) {
  return sha256Hex(canonicalize(value));
}

// ---------------------------------------------------------------------------
// Generic shape assertions
// ---------------------------------------------------------------------------

function assertPlainObject(value, ctx) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeploymentStateError(`${ctx} must be a plain object`, 'shape');
  }
  return value;
}

function assertNoUnknownFields(obj, allowed, ctx) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new DeploymentStateError(`${ctx}: unknown field '${key}'`, 'unknown-field');
    }
  }
}

function assertExactFields(obj, exact, ctx) {
  assertNoUnknownFields(obj, exact, ctx);
  for (const key of exact) {
    if (!(key in obj)) {
      throw new DeploymentStateError(`${ctx}: missing required field '${key}'`, 'missing-field');
    }
  }
}

function assertString(value, ctx) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DeploymentStateError(`${ctx} must be a non-empty string`, 'shape');
  }
  return value;
}

const OPERATION_ID_MAX_BYTES = 128;

function validateOperationId(value, ctx = 'operation-id') {
  if (typeof value !== 'string'
      || value.length === 0
      || Buffer.byteLength(value, 'utf8') > OPERATION_ID_MAX_BYTES
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
      || value.includes('..')) {
    throw new DeploymentStateError(
      `${ctx} must be a bounded ASCII filename-safe operation-id without separators or '..'`,
      'unsafe-operation-id'
    );
  }
  return value;
}

function assertSha256Hex(value, ctx) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new DeploymentStateError(`${ctx} must be a lowercase sha256 hex digest`, 'shape');
  }
  return value;
}

function assertBoolean(value, ctx) {
  if (typeof value !== 'boolean') {
    throw new DeploymentStateError(`${ctx} must be a boolean`, 'shape');
  }
  return value;
}

function assertPositiveInt(value, ctx) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DeploymentStateError(`${ctx} must be a positive integer`, 'shape');
  }
  return value;
}

function assertOneOf(value, allowed, ctx) {
  if (!allowed.includes(value)) {
    throw new DeploymentStateError(`${ctx} must be one of: ${allowed.join('|')}`, 'shape');
  }
  return value;
}

function assertIsoTimestamp(value, ctx) {
  assertString(value, ctx);
  if (Number.isNaN(Date.parse(value))) {
    throw new DeploymentStateError(`${ctx} must be an ISO-8601 timestamp`, 'shape');
  }
  return value;
}

// ---------------------------------------------------------------------------
// restoredPredecessor closed union
// ---------------------------------------------------------------------------

const RESTORED_PREDECESSOR_FIELDS = {
  'managed-terminal': ['kind', 'deploymentId', 'terminalTupleSha256'],
  'legacy-compatibility': [
    'kind',
    'compatibilityManifestSha256',
    'topologySha256',
    'databaseIdentitySha256',
    'flowStamp',
  ],
};

function validateRestoredPredecessor(obj) {
  assertPlainObject(obj, 'restoredPredecessor');
  assertOneOf(obj.kind, RESTORED_PREDECESSOR_KINDS, 'restoredPredecessor.kind');
  const exact = RESTORED_PREDECESSOR_FIELDS[obj.kind];
  assertExactFields(obj, exact, 'restoredPredecessor');
  if (obj.kind === 'managed-terminal') {
    validateOperationId(obj.deploymentId, 'restoredPredecessor.deploymentId');
    assertSha256Hex(obj.terminalTupleSha256, 'restoredPredecessor.terminalTupleSha256');
  } else {
    assertSha256Hex(
      obj.compatibilityManifestSha256,
      'restoredPredecessor.compatibilityManifestSha256'
    );
    assertSha256Hex(obj.topologySha256, 'restoredPredecessor.topologySha256');
    assertSha256Hex(obj.databaseIdentitySha256, 'restoredPredecessor.databaseIdentitySha256');
    assertString(obj.flowStamp, 'restoredPredecessor.flowStamp');
  }
  return obj;
}

function restoredPredecessorSha256(obj) {
  validateRestoredPredecessor(obj);
  return canonicalHash(obj);
}

function terminalTupleSha256(phase, receipts) {
  if (!TERMINAL_PARENT_PHASES.includes(phase)) {
    throw new DeploymentStateError('terminal tuple phase must be completed|recovered', 'shape');
  }
  validateTerminalReceiptIdentity(phase, receipts);
  return canonicalHash({ phase, receipts });
}

// ---------------------------------------------------------------------------
// databaseLineage closed union (codec-level only; no transition legality)
// ---------------------------------------------------------------------------

function validateDatabaseLineage(obj) {
  assertPlainObject(obj, 'databaseLineage');
  assertOneOf(obj.status, DATABASE_LINEAGE_STATUSES, 'databaseLineage.status');
  const fields = {
    'not-applicable': ['status'],
    'factory-pending': ['status', 'baselineId'],
    valid: ['status', 'databaseLineageSha256', 'seedReceiptSha256'],
    invalidating: ['status', 'databaseLineageSha256', 'operationId', 'reasonCode'],
    invalidated: ['status', 'databaseLineageSha256', 'operationId', 'invalidationReceiptSha256'],
  };
  assertExactFields(obj, fields[obj.status], 'databaseLineage');
  if (obj.status === 'factory-pending') assertString(obj.baselineId, 'databaseLineage.baselineId');
  if (obj.status === 'valid') {
    assertSha256Hex(obj.databaseLineageSha256, 'databaseLineage.databaseLineageSha256');
    assertSha256Hex(obj.seedReceiptSha256, 'databaseLineage.seedReceiptSha256');
  }
  if (obj.status === 'invalidating') {
    assertSha256Hex(obj.databaseLineageSha256, 'databaseLineage.databaseLineageSha256');
    validateOperationId(obj.operationId, 'databaseLineage.operationId');
    assertString(obj.reasonCode, 'databaseLineage.reasonCode');
  }
  if (obj.status === 'invalidated') {
    assertSha256Hex(obj.databaseLineageSha256, 'databaseLineage.databaseLineageSha256');
    validateOperationId(obj.operationId, 'databaseLineage.operationId');
    assertSha256Hex(obj.invalidationReceiptSha256, 'databaseLineage.invalidationReceiptSha256');
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Terminal-receipts identity, phase-discriminated (verbatim exact field
// sets from the plan). Factory `completed` fields are validated for shape
// only; no verb in this slice produces or accepts a factory tuple.
// ---------------------------------------------------------------------------

const FACTORY_COMPLETED_FIELDS = [
  'completionKind',
  'deploymentReceiptSha256',
  'acceptanceReceiptSha256',
  'factorySeedReceiptSha256',
  'databaseLineageSha256',
  'factoryProtocolZeroReceiptSha256',
  'historicalV2DispositionReceiptSha256',
  'factoryCapabilityAnchorSha256',
  'factoryWitnessAnchorSha256',
  'factoryCommandActivityAnchorSha256',
];

function validateTerminalReceiptIdentity(phase, obj) {
  assertPlainObject(obj, 'terminalReceiptIdentity');
  if (phase === 'verification-in-flight') {
    assertExactFields(obj, ['deploymentReceiptSha256'], 'terminalReceiptIdentity');
    assertSha256Hex(obj.deploymentReceiptSha256, 'terminalReceiptIdentity.deploymentReceiptSha256');
    return obj;
  }
  if (phase === 'completed') {
    assertString(obj.completionKind, 'terminalReceiptIdentity.completionKind');
    if (obj.completionKind === 'deployment') {
      assertExactFields(
        obj,
        ['completionKind', 'deploymentReceiptSha256', 'acceptanceReceiptSha256'],
        'terminalReceiptIdentity'
      );
      assertSha256Hex(obj.deploymentReceiptSha256, 'terminalReceiptIdentity.deploymentReceiptSha256');
      assertSha256Hex(obj.acceptanceReceiptSha256, 'terminalReceiptIdentity.acceptanceReceiptSha256');
      return obj;
    }
    if (obj.completionKind === 'factory-baseline') {
      assertExactFields(obj, FACTORY_COMPLETED_FIELDS, 'terminalReceiptIdentity');
      for (const field of FACTORY_COMPLETED_FIELDS) {
        if (field === 'completionKind') continue;
        assertSha256Hex(obj[field], `terminalReceiptIdentity.${field}`);
      }
      return obj;
    }
    throw new DeploymentStateError(
      "terminalReceiptIdentity.completionKind must be 'deployment' or 'factory-baseline'",
      'shape'
    );
  }
  if (phase === 'recovered') {
    assertExactFields(
      obj,
      ['recoveryReceiptSha256', 'topologyActivationReceiptSha256', 'restoredPredecessor', 'restoredPredecessorSha256'],
      'terminalReceiptIdentity'
    );
    assertSha256Hex(obj.recoveryReceiptSha256, 'terminalReceiptIdentity.recoveryReceiptSha256');
    assertSha256Hex(
      obj.topologyActivationReceiptSha256,
      'terminalReceiptIdentity.topologyActivationReceiptSha256'
    );
    validateRestoredPredecessor(obj.restoredPredecessor);
    assertSha256Hex(obj.restoredPredecessorSha256, 'terminalReceiptIdentity.restoredPredecessorSha256');
    if (obj.restoredPredecessorSha256 !== restoredPredecessorSha256(obj.restoredPredecessor)) {
      throw new DeploymentStateError(
        'terminalReceiptIdentity.restoredPredecessorSha256 does not match restoredPredecessor',
        'hash-mismatch'
      );
    }
    return obj;
  }
  throw new DeploymentStateError(
    `terminalReceiptIdentity is only defined for verification-in-flight|completed|recovered, got '${phase}'`,
    'shape'
  );
}

// ---------------------------------------------------------------------------
// parentDeployment / activeSubOperation / envelope
//
// The plan gives the envelope shape, phase enum, receipt-kind enum,
// restoredPredecessor union, and terminal-receipts identity shapes
// verbatim. It does not hand down a literal field-by-field JSON schema for
// parentDeployment/activeSubOperation beyond "owns the deployment identity,
// phase, lease, hashes, stamps, receipt hashes, optional previous-terminal
// identity, and an optional deployment probe permit" (parentDeployment) and
// "its own one-use operation ID, parent-deployment and parent-receipt
// hashes, phase, bounded result, receipt hash, and an optional probe permit
// only for recovery or rehearsal" (activeSubOperation). The closed field
// lists below are this module's concretization of that prose; every field
// is one the prose calls for or that CAS/crash-resume needs to be race-free
// and resumable. This is called out in the execution report.
// ---------------------------------------------------------------------------

const PARENT_DEPLOYMENT_FIELDS = [
  'deploymentId',
  'phase',
  'leaseActive',
  'generation',
  'attemptSha256',
  'targetCommitSha',
  'controllerGeneration',
  'claimSha256',
  'claimPath',
  'createdAt',
  'updatedAt',
  'databaseLineage',
  'previousTerminal',
  'probePermit',
  'deploymentReceiptSha256',
  'acceptanceReceiptSha256',
  'completionKind',
  'recoveryReceiptSha256',
  'recoveryOperationId',
  'topologyActivationReceiptSha256',
  'restoredPredecessor',
  'restoredPredecessorSha256',
  'lockOwnerHandoff',
  'lockRelease',
];

function validateLockOwnerHandoff(obj, ctx = 'parentDeployment.lockOwnerHandoff') {
  assertPlainObject(obj, ctx);
  assertExactFields(obj, [
    'format', 'kind', 'parentDeploymentId', 'recoveryOperationId',
    'originalLockOwnerSha256', 'recoveryLockOwnerSha256',
    'originalOwnerDeploymentId', 'recoveryOwnerDeploymentId',
    'reason', 'parentGeneration', 'recoveryGeneration', 'createdAt',
  ], ctx);
  if (obj.format !== 1 || obj.kind !== 'RECOVERY_LOCK_OWNER_HANDOFF') {
    throw new DeploymentStateError(`${ctx} has an invalid typed handoff discriminator`, 'shape');
  }
  validateOperationId(obj.parentDeploymentId, `${ctx}.parentDeploymentId`);
  validateOperationId(obj.recoveryOperationId, `${ctx}.recoveryOperationId`);
  validateOperationId(obj.originalOwnerDeploymentId, `${ctx}.originalOwnerDeploymentId`);
  validateOperationId(obj.recoveryOwnerDeploymentId, `${ctx}.recoveryOwnerDeploymentId`);
  assertSha256Hex(obj.originalLockOwnerSha256, `${ctx}.originalLockOwnerSha256`);
  assertSha256Hex(obj.recoveryLockOwnerSha256, `${ctx}.recoveryLockOwnerSha256`);
  if (obj.reason !== 'stale-parent-lock-reclaimed-for-linked-recovery') {
    throw new DeploymentStateError(`${ctx}.reason is invalid`, 'shape');
  }
  assertPositiveInt(obj.parentGeneration, `${ctx}.parentGeneration`);
  assertPositiveInt(obj.recoveryGeneration, `${ctx}.recoveryGeneration`);
  assertIsoTimestamp(obj.createdAt, `${ctx}.createdAt`);
  if (obj.parentDeploymentId !== obj.originalOwnerDeploymentId
      || obj.recoveryOperationId !== obj.recoveryOwnerDeploymentId) {
    throw new DeploymentStateError(`${ctx} owner identities do not form the authorized parent-to-recovery chain`, 'cross-link-mismatch');
  }
  return obj;
}

function validateLockRelease(obj, ctx = 'parentDeployment.lockRelease') {
  assertPlainObject(obj, ctx);
  assertExactFields(obj, [
    'format', 'status', 'operationId', 'lockDir', 'lockOwnerSha256', 'lockBootId',
    'finalReceiptSha256', 'releaseStartedAt', 'releasedAt',
  ], ctx);
  if (obj.format !== 1) throw new DeploymentStateError(`${ctx}.format must be 1`, 'shape');
  assertOneOf(obj.status, ['intent', 'releasing', 'released'], `${ctx}.status`);
  validateOperationId(obj.operationId, `${ctx}.operationId`);
  assertAbsolutePathString(obj.lockDir, `${ctx}.lockDir`);
  validateAttemptLockPath(obj.lockDir);
  assertSha256Hex(obj.lockOwnerSha256, `${ctx}.lockOwnerSha256`);
  assertString(obj.lockBootId, `${ctx}.lockBootId`);
  assertSha256Hex(obj.finalReceiptSha256, `${ctx}.finalReceiptSha256`);
  assertIsoTimestamp(obj.releaseStartedAt, `${ctx}.releaseStartedAt`);
  if (obj.status === 'intent' || obj.status === 'releasing') {
    if (obj.releasedAt !== null) throw new DeploymentStateError(`${ctx}.releasedAt must be null while releasing`, 'shape');
  } else {
    assertIsoTimestamp(obj.releasedAt, `${ctx}.releasedAt`);
  }
  return obj;
}

function validateProbePermit(obj, ctx) {
  assertPlainObject(obj, ctx);
  assertExactFields(
    obj,
    [
      'purpose',
      'operationId',
      'deploymentId',
      'phaseAtIssuance',
      'holderGenerationAtIssuance',
      'service',
      'candidateSha256',
      'databaseIdentitySha256',
      'mountIdentitySha256',
      'lockOwnerSha256',
      'bootId',
      'noncePath',
      'nonceSha256',
      'generation',
      'status',
      'launchAuthorization',
      'issuedAt',
      'expiresAt',
    ],
    ctx
  );
  assertOneOf(obj.purpose, PROBE_PERMIT_PURPOSES, `${ctx}.purpose`);
  validateOperationId(obj.operationId, `${ctx}.operationId`);
  validateOperationId(obj.deploymentId, `${ctx}.deploymentId`);
  assertString(obj.phaseAtIssuance, `${ctx}.phaseAtIssuance`);
  assertPositiveInt(obj.holderGenerationAtIssuance, `${ctx}.holderGenerationAtIssuance`);
  assertOneOf(obj.service, PROBE_PERMIT_SERVICES, `${ctx}.service`);
  assertSha256Hex(obj.candidateSha256, `${ctx}.candidateSha256`);
  assertSha256Hex(obj.databaseIdentitySha256, `${ctx}.databaseIdentitySha256`);
  assertSha256Hex(obj.mountIdentitySha256, `${ctx}.mountIdentitySha256`);
  assertSha256Hex(obj.lockOwnerSha256, `${ctx}.lockOwnerSha256`);
  assertString(obj.bootId, `${ctx}.bootId`);
  assertString(obj.noncePath, `${ctx}.noncePath`);
  if (!path.isAbsolute(obj.noncePath)) {
    throw new DeploymentStateError(`${ctx}.noncePath must be absolute`, 'shape');
  }
  validatePermitNoncePath(obj.noncePath);
  assertSha256Hex(obj.nonceSha256, `${ctx}.nonceSha256`);
  assertPositiveInt(obj.generation, `${ctx}.generation`);
  assertOneOf(obj.status, ['issued', 'consumed'], `${ctx}.status`);
  if (obj.launchAuthorization === null) {
    if (obj.purpose === 'deployment-probe' && obj.status === 'consumed') {
      throw new DeploymentStateError(`${ctx}.consumed deployment permit requires launchAuthorization`, 'missing-field');
    }
  } else {
    const launch = obj.launchAuthorization;
    assertPlainObject(launch, `${ctx}.launchAuthorization`);
    assertExactFields(launch, [
      'format', 'status', 'tokenPath', 'tokenSha256', 'argvSha256', 'carrierArgvSha256',
      'authorizedAt', 'attempt', 'previousAbortReceiptSha256',
      'supervisorPid', 'supervisorProcessStartTime',
      'childPid', 'childProcessStartTime', 'startedAt',
      'abortReceipt', 'abortReceiptSha256',
    ], `${ctx}.launchAuthorization`);
    if (launch.format !== 2) throw new DeploymentStateError(`${ctx}.launchAuthorization.format must be 2`, 'shape');
    assertOneOf(launch.status, ['authorized', 'child-started', 'launch-aborted'], `${ctx}.launchAuthorization.status`);
    assertAbsolutePathString(launch.tokenPath, `${ctx}.launchAuthorization.tokenPath`);
    validatePermitNoncePath(launch.tokenPath);
    assertSha256Hex(launch.tokenSha256, `${ctx}.launchAuthorization.tokenSha256`);
    assertSha256Hex(launch.argvSha256, `${ctx}.launchAuthorization.argvSha256`);
    assertIsoTimestamp(launch.authorizedAt, `${ctx}.launchAuthorization.authorizedAt`);
    assertPositiveInt(launch.attempt, `${ctx}.launchAuthorization.attempt`);
    if (launch.previousAbortReceiptSha256 !== null) {
      assertSha256Hex(launch.previousAbortReceiptSha256, `${ctx}.launchAuthorization.previousAbortReceiptSha256`);
    }
    if ((launch.attempt === 1) !== (launch.previousAbortReceiptSha256 === null)) {
      throw new DeploymentStateError(
        `${ctx}.launchAuthorization attempt lineage requires attempt 1 with no prior abort, or retry with its prior abort hash`,
        'shape'
      );
    }
    if (launch.status === 'authorized') {
      assertPositiveInt(launch.supervisorPid, `${ctx}.launchAuthorization.supervisorPid`);
      assertString(launch.supervisorProcessStartTime, `${ctx}.launchAuthorization.supervisorProcessStartTime`);
      if (!/^\d+$/.test(launch.supervisorProcessStartTime)) {
        throw new DeploymentStateError(`${ctx}.launchAuthorization.supervisorProcessStartTime is invalid`, 'shape');
      }
      if (launch.carrierArgvSha256 !== null || launch.childPid !== null
          || launch.childProcessStartTime !== null || launch.startedAt !== null
          || launch.abortReceipt !== null || launch.abortReceiptSha256 !== null) {
        throw new DeploymentStateError(`${ctx}.authorized launch must not claim a child`, 'shape');
      }
    } else {
      assertSha256Hex(launch.carrierArgvSha256, `${ctx}.launchAuthorization.carrierArgvSha256`);
      if (launch.supervisorPid !== null) assertPositiveInt(launch.supervisorPid, `${ctx}.launchAuthorization.supervisorPid`);
      if (launch.supervisorProcessStartTime !== null) {
        assertString(launch.supervisorProcessStartTime, `${ctx}.launchAuthorization.supervisorProcessStartTime`);
        if (!/^\d+$/.test(launch.supervisorProcessStartTime)) {
          throw new DeploymentStateError(`${ctx}.launchAuthorization.supervisorProcessStartTime is invalid`, 'shape');
        }
      }
      if ((launch.supervisorPid === null) !== (launch.supervisorProcessStartTime === null)) {
        throw new DeploymentStateError(`${ctx}.launchAuthorization supervisor identity must be complete`, 'shape');
      }
      assertPositiveInt(launch.childPid, `${ctx}.launchAuthorization.childPid`);
      assertString(launch.childProcessStartTime, `${ctx}.launchAuthorization.childProcessStartTime`);
      if (!/^\d+$/.test(launch.childProcessStartTime)) {
        throw new DeploymentStateError(`${ctx}.launchAuthorization.childProcessStartTime is invalid`, 'shape');
      }
      if (launch.startedAt !== null) assertIsoTimestamp(launch.startedAt, `${ctx}.launchAuthorization.startedAt`);
      if (launch.status === 'child-started') {
        if (launch.supervisorPid === null || launch.startedAt === null
            || launch.abortReceipt !== null || launch.abortReceiptSha256 !== null) {
          throw new DeploymentStateError(`${ctx}.child-started launch requires live supervision and no abort`, 'shape');
        }
      } else {
        assertPlainObject(launch.abortReceipt, `${ctx}.launchAuthorization.abortReceipt`);
        assertExactFields(launch.abortReceipt, [
          'format', 'reason', 'processPhase', 'supervisorPid', 'supervisorProcessStartTime',
          'childPid', 'childProcessStartTime', 'carrierArgvSha256', 'targetArgvSha256', 'abortedAt',
        ], `${ctx}.launchAuthorization.abortReceipt`);
        if (launch.abortReceipt.format !== 1) {
          throw new DeploymentStateError(`${ctx}.launchAuthorization.abortReceipt.format must be 1`, 'shape');
        }
        assertOneOf(launch.abortReceipt.reason, ['supervisor-missing-during-retry'],
          `${ctx}.launchAuthorization.abortReceipt.reason`);
        assertOneOf(launch.abortReceipt.processPhase, ['carrier', 'target', 'spawner', 'transitioning', 'gone'],
          `${ctx}.launchAuthorization.abortReceipt.processPhase`);
        if (launch.abortReceipt.supervisorPid !== null) {
          assertPositiveInt(launch.abortReceipt.supervisorPid, `${ctx}.launchAuthorization.abortReceipt.supervisorPid`);
          assertString(launch.abortReceipt.supervisorProcessStartTime,
            `${ctx}.launchAuthorization.abortReceipt.supervisorProcessStartTime`);
        } else if (launch.abortReceipt.supervisorProcessStartTime !== null) {
          throw new DeploymentStateError(`${ctx}.launchAuthorization.abortReceipt supervisor identity is incomplete`, 'shape');
        }
        assertPositiveInt(launch.abortReceipt.childPid, `${ctx}.launchAuthorization.abortReceipt.childPid`);
        assertString(launch.abortReceipt.childProcessStartTime,
          `${ctx}.launchAuthorization.abortReceipt.childProcessStartTime`);
        assertSha256Hex(launch.abortReceipt.carrierArgvSha256,
          `${ctx}.launchAuthorization.abortReceipt.carrierArgvSha256`);
        assertSha256Hex(launch.abortReceipt.targetArgvSha256,
          `${ctx}.launchAuthorization.abortReceipt.targetArgvSha256`);
        assertIsoTimestamp(launch.abortReceipt.abortedAt, `${ctx}.launchAuthorization.abortReceipt.abortedAt`);
        assertSha256Hex(launch.abortReceiptSha256, `${ctx}.launchAuthorization.abortReceiptSha256`);
        if (canonicalHash(launch.abortReceipt) !== launch.abortReceiptSha256) {
          throw new DeploymentStateError(`${ctx}.launchAuthorization.abortReceiptSha256 does not match receipt`, 'shape');
        }
      }
    }
  }
  assertIsoTimestamp(obj.issuedAt, `${ctx}.issuedAt`);
  assertIsoTimestamp(obj.expiresAt, `${ctx}.expiresAt`);
  return obj;
}

function validatePreviousTerminal(obj, ctx) {
  assertPlainObject(obj, ctx);
  assertExactFields(obj, ['deploymentId', 'generation', 'phase', 'receiptsSha256', 'terminalTupleSha256'], ctx);
  validateOperationId(obj.deploymentId, `${ctx}.deploymentId`);
  assertPositiveInt(obj.generation, `${ctx}.generation`);
  assertOneOf(obj.phase, TERMINAL_PARENT_PHASES, `${ctx}.phase`);
  assertSha256Hex(obj.receiptsSha256, `${ctx}.receiptsSha256`);
  assertSha256Hex(obj.terminalTupleSha256, `${ctx}.terminalTupleSha256`);
  return obj;
}

function validateParentDeployment(obj) {
  assertPlainObject(obj, 'parentDeployment');
  assertNoUnknownFields(obj, PARENT_DEPLOYMENT_FIELDS, 'parentDeployment');
  for (const required of ['deploymentId', 'phase', 'leaseActive', 'generation', 'attemptSha256', 'targetCommitSha', 'controllerGeneration', 'createdAt', 'updatedAt', 'databaseLineage']) {
    if (!(required in obj)) {
      throw new DeploymentStateError(`parentDeployment: missing required field '${required}'`, 'missing-field');
    }
  }
  validateOperationId(obj.deploymentId, 'parentDeployment.deploymentId');
  if (obj.phase === FACTORY_ONLY_PARENT_PHASE) {
    throw new DeploymentStateError(
      `parentDeployment.phase: factory-only phase '${FACTORY_ONLY_PARENT_PHASE}' is rejected by generic transitions`,
      'factory-phase-rejected'
    );
  }
  assertOneOf(obj.phase, ORDINARY_PARENT_PHASES, 'parentDeployment.phase');
  assertBoolean(obj.leaseActive, 'parentDeployment.leaseActive');
  assertPositiveInt(obj.generation, 'parentDeployment.generation');
  assertSha256Hex(obj.attemptSha256, 'parentDeployment.attemptSha256');
  assertString(obj.targetCommitSha, 'parentDeployment.targetCommitSha');
  assertPositiveInt(obj.controllerGeneration, 'parentDeployment.controllerGeneration');
  if ('claimSha256' in obj) assertSha256Hex(obj.claimSha256, 'parentDeployment.claimSha256');
  if ('claimPath' in obj) assertAbsolutePathString(obj.claimPath, 'parentDeployment.claimPath');
  assertIsoTimestamp(obj.createdAt, 'parentDeployment.createdAt');
  assertIsoTimestamp(obj.updatedAt, 'parentDeployment.updatedAt');
  validateDatabaseLineage(obj.databaseLineage);

  if ('previousTerminal' in obj && obj.previousTerminal !== null) {
    validatePreviousTerminal(obj.previousTerminal, 'parentDeployment.previousTerminal');
  }
  if ('probePermit' in obj && obj.probePermit !== null) {
    validateProbePermit(obj.probePermit, 'parentDeployment.probePermit');
  }

  const optionalHashFields = [
    'deploymentReceiptSha256',
    'acceptanceReceiptSha256',
    'recoveryReceiptSha256',
    'topologyActivationReceiptSha256',
    'restoredPredecessorSha256',
  ];
  for (const field of optionalHashFields) {
    if (field in obj && obj[field] !== null) {
      assertSha256Hex(obj[field], `parentDeployment.${field}`);
    }
  }
  if ('restoredPredecessor' in obj && obj.restoredPredecessor !== null) {
    validateRestoredPredecessor(obj.restoredPredecessor);
  }
  if ('completionKind' in obj && obj.completionKind !== null) {
    assertOneOf(obj.completionKind, ['deployment', 'factory-baseline'], 'parentDeployment.completionKind');
  }
  if ('recoveryOperationId' in obj && obj.recoveryOperationId !== null) {
    validateOperationId(obj.recoveryOperationId, 'parentDeployment.recoveryOperationId');
  }
  if ('lockOwnerHandoff' in obj && obj.lockOwnerHandoff !== null) {
    validateLockOwnerHandoff(obj.lockOwnerHandoff);
    if (obj.lockOwnerHandoff.parentDeploymentId !== obj.deploymentId) {
      throw new DeploymentStateError('parentDeployment.lockOwnerHandoff does not bind this parent', 'cross-link-mismatch');
    }
  }
  if ('lockRelease' in obj && obj.lockRelease !== null) {
    if (!TERMINAL_PARENT_PHASES.includes(obj.phase) && obj.lockRelease.status !== 'intent') {
      throw new DeploymentStateError('nonterminal parentDeployment.lockRelease must be a preterminal intent', 'shape');
    }
    validateLockRelease(obj.lockRelease);
  }

  // Phase-discriminated terminal identity cross-check.
  if (obj.phase === 'verification-in-flight') {
    validateTerminalReceiptIdentity('verification-in-flight', {
      deploymentReceiptSha256: obj.deploymentReceiptSha256,
    });
  } else if (obj.phase === 'completed') {
    const identity = { completionKind: obj.completionKind };
    if (obj.completionKind === 'deployment') {
      identity.deploymentReceiptSha256 = obj.deploymentReceiptSha256;
      identity.acceptanceReceiptSha256 = obj.acceptanceReceiptSha256;
    } else if (obj.completionKind === 'factory-baseline') {
      throw new DeploymentStateError(
        'parentDeployment.phase completed with completionKind factory-baseline: factory CAS paths are out of scope in this slice',
        'factory-completion-rejected'
      );
    } else {
      throw new DeploymentStateError(
        "parentDeployment.phase 'completed' requires completionKind",
        'missing-field'
      );
    }
    validateTerminalReceiptIdentity('completed', identity);
  } else if (obj.phase === 'recovered') {
    if (!obj.recoveryOperationId) {
      throw new DeploymentStateError("parentDeployment.phase 'recovered' requires recoveryOperationId", 'missing-field');
    }
    if (!obj.leaseActive
        && (!obj.lockOwnerHandoff || obj.lockOwnerHandoff.recoveryOperationId !== obj.recoveryOperationId)) {
      throw new DeploymentStateError("parentDeployment.phase 'recovered' requires the exact recovery owner handoff", 'missing-field');
    }
    validateTerminalReceiptIdentity('recovered', {
      recoveryReceiptSha256: obj.recoveryReceiptSha256,
      topologyActivationReceiptSha256: obj.topologyActivationReceiptSha256,
      restoredPredecessor: obj.restoredPredecessor,
      restoredPredecessorSha256: obj.restoredPredecessorSha256,
    });
  }
  return obj;
}

const RECOVERY_SUB_OPERATION_FIELDS = [
  'kind',
  'operationId',
  'parentDeploymentId',
  'parentDeploymentGeneration',
  'parentPhaseAtLink',
  'parentReceiptsSha256',
  'phase',
  'restoredPredecessor',
  'restoredPredecessorSha256',
  'recoveryReceiptSha256',
  'topologyActivationReceiptSha256',
  'probePermit',
  'generation',
  'createdAt',
];

const RECOVERY_LINKABLE_PARENT_PHASES = Object.freeze([
  'verification-in-flight',
  'completed',
  'recovered',
]);

const RECOVERY_SUB_OPERATION_PHASES = Object.freeze([
  'recovery-started',
  'recovery-topology-verifying',
  'recovery-topology-authorized',
]);

function validateActiveSubOperation(obj, parentDeployment) {
  if (obj === null) {
    return obj;
  }
  assertPlainObject(obj, 'activeSubOperation');
  assertOneOf(obj.kind, SUB_OPERATION_KINDS, 'activeSubOperation.kind');
  if (obj.kind !== 'recovery') {
    // selection-rehearsal / staging-gc are codec-known but have no
    // implemented schema/verbs in this slice.
    throw new DeploymentStateError(
      `activeSubOperation.kind '${obj.kind}' is not implemented in this slice`,
      'sub-operation-not-implemented'
    );
  }
  assertNoUnknownFields(obj, RECOVERY_SUB_OPERATION_FIELDS, 'activeSubOperation');
  for (const required of ['kind', 'operationId', 'parentDeploymentId', 'parentDeploymentGeneration', 'parentPhaseAtLink', 'parentReceiptsSha256', 'phase', 'restoredPredecessor', 'restoredPredecessorSha256', 'generation', 'createdAt']) {
    if (!(required in obj)) {
      throw new DeploymentStateError(`activeSubOperation: missing required field '${required}'`, 'missing-field');
    }
  }
  validateOperationId(obj.operationId, 'activeSubOperation.operationId');
  validateOperationId(obj.parentDeploymentId, 'activeSubOperation.parentDeploymentId');
  assertPositiveInt(obj.parentDeploymentGeneration, 'activeSubOperation.parentDeploymentGeneration');
  assertOneOf(
    obj.parentPhaseAtLink,
    RECOVERY_LINKABLE_PARENT_PHASES,
    'activeSubOperation.parentPhaseAtLink'
  );
  assertSha256Hex(obj.parentReceiptsSha256, 'activeSubOperation.parentReceiptsSha256');
  assertOneOf(obj.phase, RECOVERY_SUB_OPERATION_PHASES, 'activeSubOperation.phase');
  validateRestoredPredecessor(obj.restoredPredecessor);
  assertSha256Hex(obj.restoredPredecessorSha256, 'activeSubOperation.restoredPredecessorSha256');
  if (obj.restoredPredecessorSha256 !== restoredPredecessorSha256(obj.restoredPredecessor)) {
    throw new DeploymentStateError(
      'activeSubOperation.restoredPredecessorSha256 does not match restoredPredecessor',
      'hash-mismatch'
    );
  }
  if ('recoveryReceiptSha256' in obj && obj.recoveryReceiptSha256 !== null) {
    assertSha256Hex(obj.recoveryReceiptSha256, 'activeSubOperation.recoveryReceiptSha256');
  }
  if ('topologyActivationReceiptSha256' in obj && obj.topologyActivationReceiptSha256 !== null) {
    assertSha256Hex(
      obj.topologyActivationReceiptSha256,
      'activeSubOperation.topologyActivationReceiptSha256'
    );
  }
  if ('probePermit' in obj && obj.probePermit !== null) {
    validateProbePermit(obj.probePermit, 'activeSubOperation.probePermit');
  }
  assertPositiveInt(obj.generation, 'activeSubOperation.generation');
  assertIsoTimestamp(obj.createdAt, 'activeSubOperation.createdAt');

  if (parentDeployment) {
    if (obj.parentDeploymentId !== parentDeployment.deploymentId) {
      throw new DeploymentStateError(
        'activeSubOperation.parentDeploymentId does not match parentDeployment.deploymentId',
        'cross-link-mismatch'
      );
    }
  }
  return obj;
}

function validateFactoryZeroAuthority(obj, ctx = 'parentDeployment.factoryZeroAuthority') {
  assertPlainObject(obj, ctx);
  assertExactFields(obj, [
    'factoryProvenanceSha256', 'factorySeedReceiptSha256', 'databaseLineageSha256',
    'databaseIdentitySha256', 'protocolRoots', 'bootId',
    'stoppedRoleEvidence', 'linkGenerationEvidence',
  ], ctx);
  for (const field of [
    'factoryProvenanceSha256', 'factorySeedReceiptSha256', 'databaseLineageSha256',
    'databaseIdentitySha256',
  ]) assertSha256Hex(obj[field], `${ctx}.${field}`);
  assertPlainObject(obj.protocolRoots, `${ctx}.protocolRoots`);
  assertExactFields(obj.protocolRoots, ['root', 'witnessRoot', 'activityWitnessRoot', 'activityHeadWitnessRoot'], `${ctx}.protocolRoots`);
  for (const [name, root] of Object.entries(obj.protocolRoots)) {
    assertAbsolutePathString(root, `${ctx}.protocolRoots.${name}`);
    if (root.includes('\0')) throw new DeploymentStateError(`${ctx}.protocolRoots.${name} must not contain NUL`, 'shape');
  }
  assertString(obj.bootId, `${ctx}.bootId`);
  for (const field of ['stoppedRoleEvidence', 'linkGenerationEvidence']) {
    const evidenceCtx = `${ctx}.${field}`;
    assertPlainObject(obj[field], evidenceCtx);
    assertExactFields(obj[field], ['path', 'sha256'], evidenceCtx);
    assertAbsolutePathString(obj[field].path, `${evidenceCtx}.path`);
    if (obj[field].path.includes('\0')) throw new DeploymentStateError(`${evidenceCtx}.path must not contain NUL`, 'shape');
    assertSha256Hex(obj[field].sha256, `${evidenceCtx}.sha256`);
  }
  return obj;
}

/**
 * Validate the ROM-owned factory baseline envelope without widening the
 * ordinary deployment state codec.  The parent identity and lineage hashes
 * are checked here and can be cross-bound to the immutable seed evidence by
 * callers through the optional expected* values.
 */
function validateFactoryBaselineEnvelope(envelope, options = {}) {
  assertPlainObject(envelope, 'factory baseline envelope');
  assertExactFields(envelope, ['format', 'parentDeployment', 'activeSubOperation'], 'factory baseline envelope');
  if (envelope.format !== FORMAT) throw new DeploymentStateError(`factory baseline envelope.format must be ${FORMAT}`, 'shape');
  if (envelope.activeSubOperation !== null) {
    throw new DeploymentStateError('factory baseline envelope.activeSubOperation must be null', 'shape');
  }

  const parent = envelope.parentDeployment;
  assertPlainObject(parent, 'factory baseline parentDeployment');
  assertNoUnknownFields(parent, FACTORY_BASELINE_PARENT_FIELDS, 'factory baseline parentDeployment');
  for (const required of ['deploymentId', 'phase', 'generation', 'imageBaselinePrefix', 'databaseLineage']) {
    if (!(required in parent)) throw new DeploymentStateError(`factory baseline parentDeployment: missing required field '${required}'`, 'missing-field');
  }
  validateOperationId(parent.deploymentId, 'factory baseline parentDeployment.deploymentId');
  assertOneOf(parent.phase, FACTORY_BASELINE_PARENT_PHASES, 'factory baseline parentDeployment.phase');
  assertPositiveInt(parent.generation, 'factory baseline parentDeployment.generation');
  assertOneOf(parent.imageBaselinePrefix, FACTORY_BASELINE_PREFIXES, 'factory baseline parentDeployment.imageBaselinePrefix');
  validateDatabaseLineage(parent.databaseLineage);
  if (parent.databaseLineage.status !== 'valid') {
    throw new DeploymentStateError('factory baseline parentDeployment.databaseLineage must be valid', 'shape');
  }

  if ('leaseActive' in parent) assertBoolean(parent.leaseActive, 'factory baseline parentDeployment.leaseActive');
  if ('factoryProvenanceSha256' in parent) assertSha256Hex(parent.factoryProvenanceSha256, 'factory baseline parentDeployment.factoryProvenanceSha256');
  if ('attemptSha256' in parent) assertSha256Hex(parent.attemptSha256, 'factory baseline parentDeployment.attemptSha256');
  if ('targetCommitSha' in parent) assertString(parent.targetCommitSha, 'factory baseline parentDeployment.targetCommitSha');
  if ('controllerGeneration' in parent) assertPositiveInt(parent.controllerGeneration, 'factory baseline parentDeployment.controllerGeneration');
  if ('claimSha256' in parent) assertSha256Hex(parent.claimSha256, 'factory baseline parentDeployment.claimSha256');
  if ('claimPath' in parent) assertAbsolutePathString(parent.claimPath, 'factory baseline parentDeployment.claimPath');
  if ('createdAt' in parent) assertIsoTimestamp(parent.createdAt, 'factory baseline parentDeployment.createdAt');
  if ('updatedAt' in parent) assertIsoTimestamp(parent.updatedAt, 'factory baseline parentDeployment.updatedAt');

  if ('factoryZeroAuthority' in parent) {
    validateFactoryZeroAuthority(parent.factoryZeroAuthority);
    const authority = parent.factoryZeroAuthority;
    const expectedHashes = {
      expectedFactoryProvenanceSha256: 'factoryProvenanceSha256',
      expectedSeedReceiptSha256: 'factorySeedReceiptSha256',
      expectedDatabaseLineageSha256: 'databaseLineageSha256',
    };
    for (const [option, field] of Object.entries(expectedHashes)) {
      if (options[option] !== undefined && authority[field] !== options[option]) {
        throw new DeploymentStateError(`factory baseline authority ${field} does not match immutable evidence`, 'hash-mismatch');
      }
    }
  }
  if (options.expectedDeploymentId !== undefined && parent.deploymentId !== options.expectedDeploymentId) {
    throw new DeploymentStateError('factory baseline deployment id does not match immutable seed receipt', 'cross-link-mismatch');
  }
  if (options.expectedDatabaseLineageSha256 !== undefined
      && parent.databaseLineage.databaseLineageSha256 !== options.expectedDatabaseLineageSha256) {
    throw new DeploymentStateError('factory baseline lineage does not match immutable lineage bytes', 'hash-mismatch');
  }
  if (options.expectedFactoryProvenanceSha256 !== undefined
      && parent.factoryProvenanceSha256 !== options.expectedFactoryProvenanceSha256) {
    throw new DeploymentStateError('factory baseline provenance does not match immutable ROM bytes', 'hash-mismatch');
  }
  if (options.expectedSeedReceiptSha256 !== undefined
      && parent.databaseLineage.seedReceiptSha256 !== options.expectedSeedReceiptSha256) {
    throw new DeploymentStateError('factory baseline seed receipt does not match immutable receipt bytes', 'hash-mismatch');
  }
  return envelope;
}

function validateEnvelope(envelope) {
  assertPlainObject(envelope, 'envelope');
  assertExactFields(envelope, ['format', 'parentDeployment', 'activeSubOperation'], 'envelope');
  if (envelope.format !== FORMAT) {
    throw new DeploymentStateError(`envelope.format must be ${FORMAT}`, 'shape');
  }
  validateParentDeployment(envelope.parentDeployment);
  validateActiveSubOperation(envelope.activeSubOperation, envelope.parentDeployment);
  if (TERMINAL_PARENT_PHASES.includes(envelope.parentDeployment.phase)) {
    const linkedRecovery = Boolean(
      envelope.activeSubOperation && envelope.activeSubOperation.kind === 'recovery'
    );
    if (envelope.parentDeployment.leaseActive !== linkedRecovery) {
      throw new DeploymentStateError(
        'a terminal parent reactivates its lease if and only if an exact linked recovery sub-operation is active',
        'cross-link-mismatch'
      );
    }
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// Root-only, symlink-rejecting, atomic + fsynced file IO
// ---------------------------------------------------------------------------

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// "Root-only" in production means uid 0. Under test (never running as real
// root) this asserts ownership by the invoking uid instead, which is the
// only uid that *could* own the path in that environment; the ownership
// check itself (reject any other owner) is what the tests exercise.
function assertOwnedByUs(stat, p) {
  if (stat.uid !== process.getuid()) {
    throw new DeploymentStateError(`refusing path with unexpected owner: ${p}`, 'wrong-owner');
  }
}

function assertRegularFileMode0600(p) {
  const stat = lstatOrNull(p);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    throw new DeploymentStateError(`refusing symlink: ${p}`, 'symlink-rejected');
  }
  if (!stat.isFile()) {
    throw new DeploymentStateError(`expected regular file: ${p}`, 'shape');
  }
  assertOwnedByUs(stat, p);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new DeploymentStateError(`refusing file with mode != 0600: ${p}`, 'wrong-mode');
  }
  return stat;
}

function assertNotSymlink(p) {
  const stat = lstatOrNull(p);
  if (stat && stat.isSymbolicLink()) {
    throw new DeploymentStateError(`refusing symlink: ${p}`, 'symlink-rejected');
  }
  return stat;
}

function fsyncFileDescriptor(fd) {
  fs.fsyncSync(fd);
}

function fsyncPath(p) {
  const fd = fs.openSync(p, 'r');
  try {
    fsyncFileDescriptor(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dirPath) {
  fsyncPath(dirPath);
}

function ensureDir0700(dirPath) {
  assertNotSymlink(dirPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700) {
    throw new DeploymentStateError(`authority directory must be owned mode 0700: ${dirPath}`, 'wrong-mode');
  }
}

function tmpNameFor(targetPath) {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
}

function immutableIntentPrefix(targetPath, body) {
  return `.${path.basename(targetPath)}.publishing-${sha256Hex(body)}-`;
}

function immutableIntentPath(targetPath, body) {
  return path.join(path.dirname(targetPath),
    `${immutableIntentPrefix(targetPath, body)}${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
}

function cleanDeadPublicationIntents(targetPath, body, mode) {
  const dir = path.dirname(targetPath);
  const prefix = immutableIntentPrefix(targetPath, body);
  let changed = false;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const match = /^(\d+)-[0-9a-f]{16}$/.exec(suffix);
    if (!match) throw new DeploymentStateError('immutable publication intent has invalid ownership grammar', 'exclusive-create-conflict');
    const ownerPid = Number(match[1]);
    if (pidAlive(ownerPid)) continue;
    const candidate = path.join(dir, name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== mode) {
      throw new DeploymentStateError(`immutable publication intent has unsafe shape: ${candidate}`, 'exclusive-create-conflict');
    }
    const partial = fs.readFileSync(candidate);
    if (partial.length > body.length || !body.subarray(0, partial.length).equals(partial)) {
      throw new DeploymentStateError(`immutable publication intent conflicts at ${candidate}`, 'exclusive-create-conflict');
    }
    fs.unlinkSync(candidate);
    changed = true;
  }
  if (changed) fsyncDir(dir);
}

function crashAt(prefix, boundary, legacyBoundary = null) {
  if (!prefix) return;
  maybeCrash(`${prefix}:${boundary}`);
  if (legacyBoundary) maybeCrash(`${prefix}:${legacyBoundary}`);
}

// Crash-safe, no-replace publication for every immutable JSON authority.
// The deterministic intent name lets the exact same publication recover a
// partial temp left by a killed writer without weakening final-path
// exclusivity. The final name is installed only with link(2).
function publishImmutableBytes(targetPath, bytes, {
  crashLabelPrefix,
  allowExactExisting = false,
  mode = 0o600,
} = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const dir = path.dirname(targetPath);
  ensureDir0700(dir);
  assertNotSymlink(targetPath);
  cleanDeadPublicationIntents(targetPath, body, mode);
  const intent = immutableIntentPath(targetPath, body);

  const existing = lstatOrNull(targetPath);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== process.getuid()
        || (existing.mode & 0o777) !== mode) {
      throw new DeploymentStateError(`immutable target has unsafe shape: ${targetPath}`, 'exclusive-create-conflict');
    }
    if (!allowExactExisting || !fs.readFileSync(targetPath).equals(body)) {
      throw new DeploymentStateError(`refusing to overwrite existing immutable file: ${targetPath}`, 'exclusive-create-conflict');
    }
    // A prior process may have died after link(2) or after removing its
    // intent but before the final directory sync. Exact bytes prove
    // identity, not durability, so a successful retry must repeat both
    // persistence barriers before reporting a resume.
    fsyncPath(targetPath);
    crashAt(crashLabelPrefix, 'after-existing-target-fsync');
    fsyncDir(dir);
    crashAt(crashLabelPrefix, 'after-existing-parent-fsync');
    return { path: targetPath, rawSha256: sha256Hex(body), resumed: true };
  }

  const fd = fs.openSync(intent, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    const split = Math.max(1, Math.floor(body.length / 2));
    fs.writeSync(fd, body.subarray(0, split));
    crashAt(crashLabelPrefix, 'mid-write');
    if (split < body.length) fs.writeSync(fd, body.subarray(split));
    fsyncFileDescriptor(fd);
  } finally {
    fs.closeSync(fd);
  }
  crashAt(crashLabelPrefix, 'after-temp-fsync', 'after-tmp-fsync');
  try {
    fs.linkSync(intent, targetPath);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!allowExactExisting || !fs.readFileSync(targetPath).equals(body)) {
      throw new DeploymentStateError(`refusing to overwrite existing immutable file: ${targetPath}`, 'exclusive-create-conflict');
    }
  }
  crashAt(crashLabelPrefix, 'after-link');
  fs.unlinkSync(intent);
  crashAt(crashLabelPrefix, 'after-unlink');
  fsyncDir(dir);
  crashAt(crashLabelPrefix, 'after-parent-fsync');
  return { path: targetPath, rawSha256: sha256Hex(body), resumed: false };
}

// Write-temp + fsync + atomic rename + parent fsync, exactly as the plan
// requires for every state mutation. crashLabelPrefix lets callers derive
// distinct maybeCrash() boundaries per call site (e.g. 'state-write',
// 'receipt-write', 'nonce-write').
function writeJsonAtomic(targetPath, data, { crashLabelPrefix } = {}) {
  const dir = path.dirname(targetPath);
  ensureDir0700(dir);
  assertNotSymlink(targetPath);
  const tmp = tmpNameFor(targetPath);
  const body = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, body);
    fsyncFileDescriptor(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (crashLabelPrefix) maybeCrash(`${crashLabelPrefix}:after-tmp-fsync`);
  fs.renameSync(tmp, targetPath);
  if (crashLabelPrefix) maybeCrash(`${crashLabelPrefix}:after-rename`);
  fsyncDir(dir);
  if (crashLabelPrefix) maybeCrash(`${crashLabelPrefix}:after-parent-fsync`);
}

// Exclusive (no-reuse) create: used for receipts, attempt tombstones, and
// nonce files. Returns { path, sha256 } on success; throws
// DeploymentStateError('...', 'exclusive-create-conflict') if it already
// exists.
function writeJsonExclusive(targetPath, data, { crashLabelPrefix, allowExactExisting = false } = {}) {
  const body = JSON.stringify(data, null, 2);
  const published = publishImmutableBytes(targetPath, body, { crashLabelPrefix, allowExactExisting });
  return { ...published, sha256: canonicalHash(data) };
}

function readJsonFile(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

// Reads and validates the state envelope. Returns null if the state file
// does not exist (legal: "no path requires the singular state file to be
// absent" applies to *terminal resume*, but a fresh gateway legitimately
// has no state file yet).
function readState(statePath) {
  const stat = assertRegularFileMode0600(statePath);
  if (!stat) return null;
  const parsed = readJsonFile(statePath);
  validateEnvelope(parsed);
  return parsed;
}

function writeState(statePath, envelope, { crashLabelPrefix } = {}) {
  validatePersistentMutationRoot(statePath);
  validateEnvelope(envelope);
  writeJsonAtomic(statePath, envelope, { crashLabelPrefix: crashLabelPrefix || 'state-write' });
}

// First-deployment state creation must be genuinely exclusive (plan: `arm`
// "O_EXCL-creates parentDeployment"). rename() cannot express exclusivity,
// so: write temp + fsync, then link(temp, statePath) - link(2) is atomic
// and fails EEXIST if the state file already exists - unlink temp, parent
// fsync. A concurrent creator loses with a bounded 'state-already-exists'.
function writeStateExclusive(statePath, envelope, { crashLabelPrefix } = {}) {
  validatePersistentMutationRoot(statePath);
  validateEnvelope(envelope);
  const body = JSON.stringify(envelope, null, 2);
  try {
    publishImmutableBytes(statePath, body, { crashLabelPrefix: crashLabelPrefix || 'state-write' });
  } catch (err) {
    if (err && err.code === 'exclusive-create-conflict') {
      throw new DeploymentStateError(`deployment state already exists: ${statePath}`, 'state-already-exists');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-mutation exclusive lockfile. Every state-mutating verb serializes
// through immutable tickets under <statePath>.mutating. Each mode-0600
// ticket binds boot ID, PID, and Linux process start time so PID reuse
// cannot preserve a dead writer's authority.
// The verb re-reads and re-validates its CAS precondition INSIDE the lock;
// a concurrent contender fails fast with bounded 'state-busy'. Proven
// stale tickets are collected at a bounded rate only after their inode and
// exact bytes are revalidated; live or unsafe tickets are never unlinked.
//
// The lockfile records process.pid (this verb invocation's own pid), not
// ppid: the lock is held only for the duration of one mutation inside one
// verb process, so "holder process exited" is exactly the right staleness
// signal - unlike the long-lived attempt lock, which tracks the
// controlling parent.
// ---------------------------------------------------------------------------

function mutationLockPath(statePath) {
  return `${statePath}.mutating`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

const heldMutationLeases = new Map();

const MUTATION_TICKET_NAME = /^(\d{16})\.json$/;
const MUTATION_TICKET_GC_LIMIT = 64;

function readProcessStartTime(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    throw new DeploymentStateError('mutation contender PID is invalid', 'state-busy');
  }
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw new DeploymentStateError(`cannot inspect mutation contender process ${pid}`, 'state-busy');
  }
  // comm is parenthesized and may itself contain spaces or parentheses;
  // field 3 starts after the final ") ". starttime is field 22, hence
  // index 19 in the remainder beginning at field 3.
  const commEnd = raw.lastIndexOf(') ');
  if (commEnd < 0) {
    throw new DeploymentStateError(`cannot parse mutation contender process ${pid}`, 'state-busy');
  }
  const fieldsFromState = raw.slice(commEnd + 2).trim().split(/\s+/);
  const startTime = fieldsFromState[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new DeploymentStateError(`cannot parse mutation contender process ${pid}`, 'state-busy');
  }
  return startTime;
}

function parseMutationTicket(raw, expectedTicket) {
  let ticket;
  try {
    ticket = JSON.parse(raw.toString('utf8'));
  } catch (_error) {
    throw new DeploymentStateError('mutation contender ticket is invalid', 'state-busy');
  }
  const fields = ['bootId', 'operationId', 'pid', 'processStartTime', 'ticket', 'token'];
  if (!ticket || Array.isArray(ticket) || typeof ticket !== 'object'
      || Object.keys(ticket).sort().join(',') !== fields.sort().join(',')
      || !Number.isInteger(ticket.pid) || ticket.pid < 1
      || typeof ticket.bootId !== 'string' || ticket.bootId.length === 0
      || typeof ticket.operationId !== 'string' || ticket.operationId.length === 0
      || typeof ticket.processStartTime !== 'string' || !/^\d+$/.test(ticket.processStartTime)
      || ticket.ticket !== expectedTicket
      || typeof ticket.token !== 'string' || !/^[0-9a-f]{32}$/.test(ticket.token)) {
    throw new DeploymentStateError('mutation contender ticket is invalid', 'state-busy');
  }
  return ticket;
}

function unlinkStaleMutationTicket(candidatePath, observedStat, observedRaw) {
  let currentStat;
  let currentRaw;
  try {
    currentStat = fs.lstatSync(candidatePath);
    currentRaw = fs.readFileSync(candidatePath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.uid !== process.getuid()
      || (currentStat.mode & 0o777) !== 0o600 || currentStat.nlink !== 1
      || currentStat.dev !== observedStat.dev || currentStat.ino !== observedStat.ino
      || !currentRaw.equals(observedRaw)) {
    throw new DeploymentStateError('mutation contender changed during stale collection', 'state-busy');
  }
  fs.unlinkSync(candidatePath);
  return true;
}

function mutationTicketName(ticket) {
  if (!Number.isSafeInteger(ticket) || ticket < 1 || ticket > 9999999999999999) {
    throw new DeploymentStateError('mutation ticket sequence is exhausted', 'state-busy');
  }
  return `${String(ticket).padStart(16, '0')}.json`;
}

function mutationTicketNumbers(lockPath) {
  const tickets = [];
  for (const name of fs.readdirSync(lockPath)) {
    const match = MUTATION_TICKET_NAME.exec(name);
    if (match) {
      const ticket = Number(match[1]);
      if (!Number.isSafeInteger(ticket) || ticket < 1) {
        throw new DeploymentStateError('mutation contender ticket is invalid', 'state-busy');
      }
      tickets.push(ticket);
      continue;
    }
    if (/^\.mutation-ticket-tmp-\d+-[0-9a-f]{16}$/.test(name)) continue;
    throw new DeploymentStateError('mutation contender directory contains an unknown entry', 'state-busy');
  }
  return tickets;
}

function publishMutationTicket(lockPath, operationId) {
  for (;;) {
    const existing = mutationTicketNumbers(lockPath);
    const ticket = (existing.length === 0 ? 0 : Math.max(...existing)) + 1;
    const token = crypto.randomBytes(16).toString('hex');
    const contenderPath = path.join(lockPath, mutationTicketName(ticket));
    const processStartTime = readProcessStartTime(process.pid);
    if (processStartTime === null) {
      throw new DeploymentStateError('cannot bind mutation ticket to this process', 'state-busy');
    }
    const content = { pid: process.pid, bootId: getBootId(), processStartTime, operationId, ticket, token };
    const raw = Buffer.from(`${JSON.stringify(content)}\n`);
    const tmp = path.join(lockPath, `.mutation-ticket-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeSync(fd, raw);
      fsyncFileDescriptor(fd);
    } finally {
      fs.closeSync(fd);
    }
    let linked = false;
    try {
      fs.linkSync(tmp, contenderPath);
      linked = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      fs.unlinkSync(tmp);
    }
    if (!linked) continue;
    fsyncDir(lockPath);
    return { lockPath, contenderPath, ticket, token, raw };
  }
}

function acquireMutationLock(statePath, operationId) {
  const lockPath = mutationLockPath(statePath);
  maybeCrash('mutation-lock:before-create');
  ensureDir0700(lockPath);
  const lease = publishMutationTicket(lockPath, operationId);
  heldMutationLeases.set(lockPath, lease);
  maybeCrash('mutation-lock:after-create');

  let conflict = false;
  let staleCollected = 0;
  const currentBootId = getBootId();
  for (const name of fs.readdirSync(lockPath)) {
    const match = MUTATION_TICKET_NAME.exec(name);
    if (!match || name === mutationTicketName(lease.ticket)) continue;
    const foreignTicket = Number(match[1]);
    if (foreignTicket >= lease.ticket) continue;
    const foreignPath = path.join(lockPath, name);
    let stat;
    let raw;
    let foreign;
    try {
      stat = fs.lstatSync(foreignPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        conflict = true;
        break;
      }
      raw = fs.readFileSync(foreignPath);
      foreign = parseMutationTicket(raw, foreignTicket);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      conflict = true;
      break;
    }

    if (foreign.bootId !== currentBootId) {
      if (staleCollected < MUTATION_TICKET_GC_LIMIT
          && unlinkStaleMutationTicket(foreignPath, stat, raw)) staleCollected += 1;
      continue;
    }
    let observedStartTime;
    try {
      observedStartTime = readProcessStartTime(foreign.pid);
    } catch (_error) {
      conflict = true;
      break;
    }
    if (observedStartTime === foreign.processStartTime) {
      conflict = true;
      break;
    }
    if (staleCollected < MUTATION_TICKET_GC_LIMIT
        && unlinkStaleMutationTicket(foreignPath, stat, raw)) staleCollected += 1;
  }
  if (staleCollected > 0) fsyncDir(lockPath);
  if (conflict) {
    releaseMutationLock(statePath, lease);
    throw new DeploymentStateError('another state mutation is in progress', 'state-busy');
  }
  return lease;
}

function releaseMutationLock(statePath, suppliedLease = null) {
  const lockPath = mutationLockPath(statePath);
  const lease = suppliedLease || heldMutationLeases.get(lockPath);
  if (!lease || lease.lockPath !== lockPath) {
    throw new DeploymentStateError('mutation lock release has no matching owned lease', 'lock-owner-mismatch');
  }
  maybeCrash('mutation-lock:before-unlink');
  let observed;
  try {
    observed = fs.readFileSync(lease.contenderPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new DeploymentStateError('owned mutation contender disappeared before release', 'lock-owner-mismatch');
    }
    throw error;
  }
  if (!observed.equals(lease.raw)) {
    throw new DeploymentStateError('mutation contender ownership changed before release', 'lock-owner-mismatch');
  }
  fs.unlinkSync(lease.contenderPath);
  fsyncDir(lockPath);
  heldMutationLeases.delete(lockPath);
  maybeCrash('mutation-lock:after-unlink');
}

function artifactTestBoundary() {
  return path.join('/tmp', `osi-deploy-startup-tests-${AUTHORITY_PROCESS_UID}`);
}

function artifactTestMode() {
  const boundary = artifactTestBoundary();
  return process.env.OSI_REPAIR_PROGRAM_MODE === '1'
    && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
    && process.env.OSI_DEPLOY_TEST_BOUNDARY === boundary;
}

// Pure logical-path classifier. Production authority has two deliberately
// separate roots: persistent records under /data, and the exact same-boot
// attempt mutex under /var/lock. No other /var/lock or /data path is valid.
function classifyDeploymentAuthorityPath(targetPath) {
  const resolved = path.resolve(targetPath);
  if (resolved === '/var/lock/osi-deploy.lock.d') {
    return 'attempt-lock';
  }
  if (resolved === '/data/osi-deploy' || resolved.startsWith('/data/osi-deploy/')) {
    return 'persistent';
  }
  throw new DeploymentStateError('path is outside the closed deployment authority roots', 'mount-authority');
}

function validateAttemptLockPath(lockDir) {
  const resolved = path.resolve(lockDir);
  if (artifactTestMode()) {
    const boundary = artifactTestBoundary();
    if (resolved === boundary || !resolved.startsWith(`${boundary}${path.sep}`)
        || path.basename(resolved) !== 'osi-deploy.lock.d') {
      throw new DeploymentStateError('attempt-lock test path must be the exact osi-deploy.lock.d under the fixed boundary', 'unsafe-test-adapter');
    }
  } else {
    const classification = classifyDeploymentAuthorityPath(resolved);
    if (classification !== 'attempt-lock') {
      throw new DeploymentStateError('attempt lock must use /var/lock/osi-deploy.lock.d', 'mount-authority');
    }
  }
  const stat = lstatOrNull(resolved);
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DeploymentStateError('attempt lock must be a real directory', 'symlink-rejected');
    }
    if (stat.uid !== process.getuid()) {
      throw new DeploymentStateError('attempt lock directory has the wrong owner', 'wrong-owner');
    }
    if ((stat.mode & 0o777) !== LOCK_DIR_MODE) {
      throw new DeploymentStateError('attempt lock must use mode 0700', 'wrong-mode');
    }
  }
  return { kind: 'attempt-lock', persistence: 'same-boot', root: resolved };
}

function decodeMountInfoPath(value) {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\');
}

function parseMountInfo(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || separator + 3 >= fields.length) {
      throw new DeploymentStateError('malformed mountinfo record', 'mount-alias');
    }
    return {
      id: fields[0], parentId: fields[1], majorMinor: fields[2],
      mountRoot: decodeMountInfoPath(fields[3]),
      point: decodeMountInfoPath(fields[4]),
      mountOptions: fields[5].split(','), optionalFields: fields.slice(6, separator),
      fsType: fields[separator + 1], source: decodeMountInfoPath(fields[separator + 2]),
      superOptions: fields.slice(separator + 3).join(' '),
    };
  });
}

function validatePersistentMountProfile(logicalRoot, mountInfoText, { simulatedRoot = null } = {}) {
  const root = path.resolve(logicalRoot);
  const mounts = parseMountInfo(mountInfoText);
  const coveringAll = (candidate, excluded = null) => mounts.filter((mount) => mount !== excluded
    && (candidate === mount.point || candidate.startsWith(`${mount.point === '/' ? '' : mount.point}/`)))
    .sort((a, b) => b.point.length - a.point.length);
  const selectedCandidates = coveringAll(root);
  if (selectedCandidates.length === 0) throw new DeploymentStateError('deployment root has no covering mount', 'mount-alias');
  if (selectedCandidates.length > 1 && selectedCandidates[0].point === selectedCandidates[1].point) {
    throw new DeploymentStateError('deployment root has ambiguous covering mounts', 'mount-alias');
  }
  const selected = selectedCandidates[0];
  const nested = mounts.find((mount) => mount.point.startsWith(`${root}/`));
  if (nested) throw new DeploymentStateError('deployment root has a nested shadow mount', 'mount-alias');
  const volatile = (mount) => !mount || ['tmpfs', 'ramfs'].includes(mount.fsType)
    || ['tmpfs', 'ramfs', 'none'].includes(mount.source);
  const bindLike = (mount) => mount.mountRoot !== '/'
    || mount.mountOptions.includes('bind') || mount.optionalFields.includes('bind');
  const blockBacked = (mount) => !volatile(mount) && mount.fsType !== 'overlay'
    && mount.source.startsWith('/dev/') && /^\d+:\d+$/.test(mount.majorMinor) && mount.majorMinor !== '0:0'
    && !bindLike(mount);
  // A full-filesystem bind mount is reported with mount root "/" and may
  // carry no explicit bind token. The duplicate superblock/root mapping is
  // the stable evidence that the same filesystem root is exposed through
  // another mount point.
  const hasDuplicateFilesystemRoot = (mount) => mounts.some((other) => other !== mount
    && other.point !== mount.point
    && other.majorMinor === mount.majorMinor
    && other.mountRoot === mount.mountRoot
    && other.fsType === mount.fsType);

  if (selected.fsType === 'overlay') {
    const expectedOverlayPoint = simulatedRoot || '/';
    if (selected.point !== expectedOverlayPoint || selected.mountRoot !== '/') {
      throw new DeploymentStateError('overlay authority is not the maintained root overlay', 'mount-alias');
    }
    if (hasDuplicateFilesystemRoot(selected)) {
      throw new DeploymentStateError('deployment root overlay has a duplicate filesystem-root mapping', 'mount-alias');
    }
    const match = /(?:^|,)upperdir=([^,\s]+)/.exec(selected.superOptions);
    if (!match || !path.isAbsolute(match[1])) {
      throw new DeploymentStateError('overlay deployment root has no persistent upperdir identity', 'volatile-root');
    }
    const backingCandidates = coveringAll(match[1], selected);
    if (backingCandidates.length === 0 || (backingCandidates[1]
        && backingCandidates[0].point === backingCandidates[1].point)
        || !blockBacked(backingCandidates[0])) {
      throw new DeploymentStateError('overlay upperdir is not backed by one unaliased persistent block mount', 'volatile-root');
    }
    if (hasDuplicateFilesystemRoot(backingCandidates[0])) {
      throw new DeploymentStateError('overlay upperdir backing has a duplicate filesystem-root mapping', 'mount-alias');
    }
    return { mode: 'persistent-overlay-upperdir', root, selected, backing: backingCandidates[0] };
  }

  const expectedDataMount = simulatedRoot || '/data';
  if (selected.point !== expectedDataMount || !blockBacked(selected)) {
    throw new DeploymentStateError('deployment root is not on a direct persistent /data block mount',
      volatile(selected) ? 'volatile-root' : 'mount-alias');
  }
  if (hasDuplicateFilesystemRoot(selected)) {
    throw new DeploymentStateError('deployment root has a duplicate filesystem-root mapping', 'mount-alias');
  }
  return { mode: 'persistent-direct', root, selected };
}

function validatePersistentMutationRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  const testBoundary = artifactTestBoundary();
  const testMode = artifactTestMode();
  const underTestBoundary = resolved === testBoundary || resolved.startsWith(`${testBoundary}${path.sep}`);
  if (!testMode && resolved !== '/data/osi-deploy' && !resolved.startsWith('/data/osi-deploy/')) {
    throw new DeploymentStateError('deployment mutations must be rooted under /data/osi-deploy', 'mount-authority');
  }
  if (testMode && !underTestBoundary) {
    throw new DeploymentStateError('deployment mutation test path is outside the fixed boundary', 'unsafe-test-adapter');
  }
  const stop = testMode ? testBoundary : '/data/osi-deploy';
  let cursor = path.parse(resolved).root;
  for (const part of resolved.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = lstatOrNull(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new DeploymentStateError(`deployment root component is a symlink: ${cursor}`, 'symlink-rejected');
    if (cursor !== resolved && !stat.isDirectory()) throw new DeploymentStateError(`deployment root component is not a directory: ${cursor}`, 'shape');
    const insideAuthority = cursor === stop || cursor.startsWith(`${stop}${path.sep}`);
    if ((insideAuthority && stat.isDirectory()
        && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700))
        || ((!testMode && cursor === '/data') && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
      throw new DeploymentStateError(`deployment root component has unsafe owner/mode: ${cursor}`, 'wrong-mode');
    }
  }
  const logicalRoot = testMode ? testBoundary : '/data/osi-deploy';
  let mountInfoPath = '/proc/self/mountinfo';
  if (testMode) {
    const adapterPath = process.env.OSI_DEPLOY_MUTATION_TEST_MOUNTINFO;
    if (!adapterPath) {
      throw new DeploymentStateError('mutation mount adapter is required in test mode', 'unsafe-test-adapter');
    }
    const expectedAdapter = path.join(testBoundary, 'mutation-mountinfo.test');
    if (path.resolve(adapterPath) !== expectedAdapter) {
      throw new DeploymentStateError('mutation mount adapter is outside its fixed test path', 'unsafe-test-adapter');
    }
    const adapterStat = fs.lstatSync(adapterPath);
    if (!adapterStat.isFile() || adapterStat.isSymbolicLink() || adapterStat.uid !== process.getuid()
        || (adapterStat.mode & 0o777) !== 0o600) {
      throw new DeploymentStateError('mutation mount adapter must be an owned mode-0600 regular file', 'unsafe-test-adapter');
    }
    mountInfoPath = adapterPath;
  }

  const mountInfo = fs.readFileSync(mountInfoPath, 'utf8');
  return validatePersistentMountProfile(logicalRoot, mountInfo, {
    simulatedRoot: testMode ? logicalRoot : null,
  });
}

function validatePersistentAuthorityDirectory(directoryPath, kind) {
  if (!['attempts', 'permits'].includes(kind)) {
    throw new DeploymentStateError('unknown persistent authority directory kind', 'shape');
  }
  assertString(directoryPath, `${kind} directory`);
  const resolved = path.resolve(directoryPath);
  if (resolved !== directoryPath) {
    throw new DeploymentStateError(`${kind} directory must be canonical and absolute`, 'mount-authority');
  }
  if (artifactTestMode()) {
    const boundary = artifactTestBoundary();
    if (!resolved.startsWith(`${boundary}${path.sep}`) || path.basename(resolved) !== kind) {
      throw new DeploymentStateError(`${kind} test directory is outside its explicit confined adapter`, 'unsafe-test-adapter');
    }
  } else if (resolved !== `/data/osi-deploy/${kind}`) {
    throw new DeploymentStateError(`${kind} directory must be /data/osi-deploy/${kind}`, 'mount-authority');
  }
  validatePersistentMutationRoot(resolved);
  return resolved;
}

function validatePermitNoncePath(noncePath) {
  assertString(noncePath, 'probe nonce path');
  if (!path.isAbsolute(noncePath) || path.resolve(noncePath) !== noncePath) {
    throw new DeploymentStateError('probe nonce path must be canonical and absolute', 'mount-authority');
  }
  validatePersistentAuthorityDirectory(path.dirname(noncePath), 'permits');
  return noncePath;
}

function withStateMutation(statePath, operationId, fn) {
  assertString(statePath, 'statePath');
  validatePersistentMutationRoot(statePath);
  ensureDir0700(path.dirname(statePath));
  const lease = acquireMutationLock(statePath, operationId);
  try {
    return fn();
  } finally {
    releaseMutationLock(statePath, lease);
  }
}

// ---------------------------------------------------------------------------
// Receipts: immutable, exclusive creation, closed kind enum,
// receipts/<operation-id>.<receipt-kind>.json
// ---------------------------------------------------------------------------

function receiptPath(receiptsDir, operationId, kind) {
  if (!RECEIPT_KINDS.includes(kind)) {
    throw new DeploymentStateError(`unknown-receipt-kind: ${kind}`, 'unknown-receipt-kind');
  }
  validateOperationId(operationId, 'operationId');
  return path.join(receiptsDir, `${operationId}.${kind}.json`);
}

// Mandatory discriminator on topology-activation receipts. Only the rich
// guard-bootstrap authorization shape exists; recovery may consume it but
// cannot self-issue a weaker topology receipt.
const TOPOLOGY_ACTIVATION_AUTHORITY_KINDS = Object.freeze([
  'guard-bootstrap',
]);

const TOPOLOGY_RESTORATION_PROOF_FIELDS = Object.freeze([
  'format', 'kind', 'deploymentId', 'liveRootPath', 'compatibilityManifestSha256',
  'topologyManifestSha256', 'targetSafetyManifestPath', 'targetSafetyManifestSha256',
  'guardGenerationSha256',
  'restoredTopologySha256', 'restoredMetadataSha256',
  'uciIdentitySha256', 'uciReview', 'sixLinkTopologySha256', 'restoredPredecessor',
  'restoredPredecessorSha256',
]);

function rootedTopologyPath(root, absolutePath) {
  if (!path.isAbsolute(root) || !path.isAbsolute(absolutePath)) {
    throw new DeploymentStateError('topology root and inventory path must be absolute', 'shape');
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, `.${absolutePath}`);
  if (base !== '/' && resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new DeploymentStateError('topology inventory path escapes live root', 'shape');
  }
  const rootStat = fs.lstatSync(base);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DeploymentStateError('topology live root must be a real directory', 'shape');
  }
  const rootReal = fs.realpathSync(base);
  let cursor = base;
  for (const part of path.relative(base, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = lstatOrNull(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new DeploymentStateError(`topology path has a symlink ancestor: ${cursor}`, 'symlink-rejected');
    }
    if (!stat.isDirectory()) {
      throw new DeploymentStateError(`topology path ancestor is not a directory: ${cursor}`, 'shape');
    }
    const real = fs.realpathSync(cursor);
    if (rootReal !== '/' && real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new DeploymentStateError(`topology realpath escapes live root: ${cursor}`, 'shape');
    }
  }
  return resolved;
}

function collectTopologyEntry(root, logicalPath, entries) {
  const live = rootedTopologyPath(root, logicalPath);
  const stat = lstatOrNull(live);
  if (!stat) {
    if (lstatOrNull(live)) {
      throw new DeploymentStateError(`topology path changed while collecting: ${logicalPath}`, 'topology-race');
    }
    entries.push({ path: logicalPath, type: 'absent' });
    return;
  }
  const sameStat = (after) => after && after.dev === stat.dev && after.ino === stat.ino
    && after.mode === stat.mode && after.uid === stat.uid && after.gid === stat.gid
    && after.size === stat.size && after.nlink === stat.nlink;
  const common = { path: logicalPath, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(live);
    const after = fs.lstatSync(live);
    if (!after.isSymbolicLink() || !sameStat(after) || fs.readlinkSync(live) !== target) {
      throw new DeploymentStateError(`topology symlink changed while collecting: ${logicalPath}`, 'topology-race');
    }
    entries.push({ ...common, type: 'symlink', target });
    return;
  }
  if (stat.isFile()) {
    const bytes = fs.readFileSync(live);
    const after = fs.lstatSync(live);
    const repeated = fs.readFileSync(live);
    const finalStat = fs.lstatSync(live);
    if (!after.isFile() || after.isSymbolicLink() || !sameStat(after) || !sameStat(finalStat)
        || bytes.length !== stat.size || !bytes.equals(repeated)) {
      throw new DeploymentStateError(`topology file changed while collecting: ${logicalPath}`, 'topology-race');
    }
    entries.push({ ...common, type: 'file', sizeBytes: bytes.length, sha256: sha256Hex(bytes) });
    return;
  }
  if (!stat.isDirectory()) {
    throw new DeploymentStateError(`unsupported special topology file: ${logicalPath}`, 'shape');
  }
  entries.push({ ...common, type: 'directory' });
  const names = fs.readdirSync(live).sort();
  for (const name of names) {
    collectTopologyEntry(root, path.posix.join(logicalPath, name), entries);
  }
  const after = fs.lstatSync(live);
  const repeatedNames = fs.readdirSync(live).sort();
  if (!after.isDirectory() || after.isSymbolicLink() || !sameStat(after)
      || canonicalize(repeatedNames) !== canonicalize(names)) {
    throw new DeploymentStateError(`topology directory changed while collecting: ${logicalPath}`, 'topology-race');
  }
}

function collectTopologyPathSet(root, paths) {
  const byPath = new Map();
  for (const logicalPath of paths) {
    const entries = [];
    collectTopologyEntry(root, logicalPath, entries);
    for (const entry of entries) byPath.set(entry.path, entry);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function topologyUciIdentitySha256(root) {
  const source = rootedTopologyPath(root, '/etc/config/osi-server');
  const stat = lstatOrNull(source);
  if (!stat) return canonicalHash({ status: 'absent' });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DeploymentStateError('UCI identity source must be a regular file', 'shape');
  }
  const allowed = new Set(['device_eui', 'gateway_device_eui', 'link_gateway_device_eui', 'server_url']);
  const before = stat;
  const raw = fs.readFileSync(source);
  const after = fs.lstatSync(source);
  const repeated = fs.readFileSync(source);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
      || after.mode !== before.mode || after.uid !== before.uid || after.gid !== before.gid
      || after.size !== before.size || !raw.equals(repeated)) {
    throw new DeploymentStateError('UCI identity source changed while collecting', 'topology-race');
  }
  const facts = [];
  for (const line of raw.toString('utf8').split('\n')) {
    const match = line.match(/^\s*option\s+([A-Za-z0-9_]+)\s+['"]([^'"]*)['"]\s*$/);
    if (match && allowed.has(match[1])) facts.push([match[1], match[2]]);
  }
  facts.sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
  return canonicalHash({ status: 'present', facts });
}

function liveTopologyIdentity(root) {
  const topology = collectTopologyPathSet(root, COMPATIBILITY_TOPOLOGY_PATHS);
  const metadata = topology.map((entry) => ({
    path: entry.path,
    type: entry.type,
    ...(entry.type === 'absent' ? {} : { mode: entry.mode, uid: entry.uid, gid: entry.gid }),
    ...(entry.type === 'symlink' ? { target: entry.target } : {}),
  }));
  return {
    restoredTopologySha256: canonicalHash({ entries: topology }),
    restoredMetadataSha256: canonicalHash({ entries: metadata }),
    uciIdentitySha256: topologyUciIdentitySha256(root),
    sixLinkTopologySha256: canonicalHash({ entries: collectTopologyPathSet(root, SIX_APPLICATION_LINKS) }),
  };
}

function validateTopologyRestorationProof(content) {
  assertPlainObject(content, 'topology restoration proof');
  assertExactFields(content, TOPOLOGY_RESTORATION_PROOF_FIELDS, 'topology restoration proof');
  if (content.format !== 1 || content.kind !== 'TRAIN_A_TOPOLOGY_RESTORATION_PROOF') {
    throw new DeploymentStateError('topology restoration proof format/kind mismatch', 'shape');
  }
  validateOperationId(content.deploymentId, 'topology restoration proof deploymentId');
  assertAbsolutePathString(content.liveRootPath, 'topology restoration proof liveRootPath');
  validateTargetSafetyManifestPath(content.targetSafetyManifestPath);
  for (const field of TOPOLOGY_RESTORATION_PROOF_FIELDS.filter((name) => name.endsWith('Sha256'))) {
    assertSha256Hex(content[field], `topology restoration proof ${field}`);
  }
  assertAbsolutePathString(content.liveRootPath, 'topology restoration proof liveRootPath');
  assertPlainObject(content.uciReview, 'topology restoration proof uciReview');
  assertExactFields(content.uciReview, [
    'previousUciIdentitySha256', 'healedUciIdentitySha256', 'decision',
    'comparisonPath', 'comparisonSha256',
  ], 'topology restoration proof uciReview');
  assertSha256Hex(content.uciReview.previousUciIdentitySha256,
    'topology restoration proof uciReview.previousUciIdentitySha256');
  assertSha256Hex(content.uciReview.healedUciIdentitySha256,
    'topology restoration proof uciReview.healedUciIdentitySha256');
  if (content.uciReview.healedUciIdentitySha256 !== content.uciIdentitySha256) {
    throw new DeploymentStateError('topology restoration proof healed UCI review differs from live identity', 'proof-mismatch');
  }
  if (content.uciReview.decision === 'unchanged') {
    if (content.uciReview.previousUciIdentitySha256 !== content.uciReview.healedUciIdentitySha256
        || content.uciReview.comparisonPath !== null || content.uciReview.comparisonSha256 !== null) {
      throw new DeploymentStateError('unchanged UCI review has inconsistent comparison authority', 'shape');
    }
  } else if (content.uciReview.decision === 'preserve-healed') {
    if (content.uciReview.previousUciIdentitySha256 === content.uciReview.healedUciIdentitySha256) {
      throw new DeploymentStateError('preserve-healed UCI review requires an identity change', 'shape');
    }
    assertAbsolutePathString(content.uciReview.comparisonPath,
      'topology restoration proof uciReview.comparisonPath');
    assertSha256Hex(content.uciReview.comparisonSha256,
      'topology restoration proof uciReview.comparisonSha256');
    const expectedComparisonPath = path.join(
      path.dirname(content.targetSafetyManifestPath), 'uci-identity-comparison.json'
    );
    if (content.uciReview.comparisonPath !== expectedComparisonPath) {
      throw new DeploymentStateError(
        'preserve-healed UCI review does not use the canonical compatibility-set comparison authority',
        'proof-mismatch'
      );
    }
  } else {
    throw new DeploymentStateError('topology restoration proof uciReview.decision is invalid', 'shape');
  }
  validateRestoredPredecessor(content.restoredPredecessor);
  if (content.restoredPredecessorSha256 !== restoredPredecessorSha256(content.restoredPredecessor)) {
    throw new DeploymentStateError('topology restoration proof predecessor hash mismatch', 'hash-mismatch');
  }
  return content;
}

function validateTargetSafetyManifestPath(manifestPath) {
  assertAbsolutePathString(manifestPath, 'target safety manifest path');
  const resolved = path.resolve(manifestPath);
  if (resolved !== manifestPath || path.basename(resolved) !== 'target-safety-manifest.json'
      || path.basename(path.dirname(resolved)) !== 'compatibility-set') {
    throw new DeploymentStateError('target safety manifest path is not the canonical compatibility-set locator', 'manifest-path');
  }
  const production = resolved.startsWith('/data/db/backups/');
  const startupTest = artifactTestMode()
    && (resolved === artifactTestBoundary() || resolved.startsWith(`${artifactTestBoundary()}${path.sep}`));
  const compatibilityBoundary = path.join('/tmp', `osi-compat-tests-${process.getuid()}`);
  const compatibilityTest = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
    && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
    && process.env.OSI_COMPAT_TEST_BOUNDARY === compatibilityBoundary
    && resolved.startsWith(`${compatibilityBoundary}${path.sep}`);
  if (!production && !startupTest && !compatibilityTest) {
    throw new DeploymentStateError('target safety manifest path is outside the closed controller roots', 'manifest-path');
  }
  return resolved;
}

function readAndVerifyTargetSafetyManifest({ manifestPath, expectedSha256, deploymentId,
  guardGenerationSha256, liveRootPath }) {
  const resolved = validateTargetSafetyManifestPath(manifestPath);
  const stat = assertRegularFileMode0600(resolved);
  if (!stat) throw new DeploymentStateError('target safety manifest is missing', 'manifest-missing');
  const raw = fs.readFileSync(resolved);
  const after = fs.lstatSync(resolved);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
      || after.mode !== stat.mode || after.uid !== stat.uid || after.gid !== stat.gid
      || after.size !== stat.size || sha256Hex(raw) !== expectedSha256) {
    throw new DeploymentStateError('target safety manifest bytes changed', 'manifest-mismatch');
  }
  let manifest;
  try { manifest = JSON.parse(raw); } catch (error) {
    throw new DeploymentStateError(`target safety manifest is invalid JSON: ${error.message}`, 'shape');
  }
  assertExactFields(manifest,
    ['format', 'kind', 'deploymentId', 'manifestPath', 'guardGenerationSha256', 'entries'],
    'target safety manifest');
  if (manifest.format !== 1 || manifest.kind !== 'TRAIN_A_TARGET_SAFETY'
      || manifest.deploymentId !== deploymentId || manifest.manifestPath !== resolved
      || manifest.guardGenerationSha256 !== guardGenerationSha256 || !Array.isArray(manifest.entries)) {
    throw new DeploymentStateError('target safety manifest binding mismatch', 'manifest-mismatch');
  }
  assertSha256Hex(manifest.guardGenerationSha256, 'target safety manifest guardGenerationSha256');
  const live = collectTopologyPathSet(liveRootPath, TARGET_SAFETY_PATHS);
  if (canonicalize(live) !== canonicalize(manifest.entries)) {
    throw new DeploymentStateError('installed target safety differs from its immutable manifest', 'current-control-mismatch');
  }
  const expectedRoots = [...TARGET_SAFETY_PATHS].sort();
  const actualRoots = manifest.entries.filter((entry) => TARGET_SAFETY_PATHS.includes(entry.path))
    .map((entry) => entry.path).sort();
  if (canonicalize(actualRoots) !== canonicalize(expectedRoots)) {
    throw new DeploymentStateError('target safety manifest does not cover the exact fixed inventory', 'manifest-mismatch');
  }
  return { path: resolved, raw, sha256: sha256Hex(raw), content: manifest };
}

function readTopologyRestorationProof(proofPath) {
  validatePersistentMutationRoot(proofPath);
  const stat = assertRegularFileMode0600(proofPath);
  if (!stat) throw new DeploymentStateError('topology restoration proof is missing', 'proof-missing');
  const raw = fs.readFileSync(proofPath);
  const content = validateTopologyRestorationProof(JSON.parse(raw));
  return { path: proofPath, content, sha256: sha256Hex(raw) };
}

// Per-kind content validation at write time. Only the kinds an in-scope
// verb actually writes have validators; writing any other (in-enum) kind
// is rejected outright rather than stubbed ("do not stub half-behavior").
const RECEIPT_CONTENT_VALIDATORS = {
  deployment(content) {
    assertExactFields(
      content,
      ['format', 'receiptKind', 'operationId', 'deploymentId', 'phaseAtIssuance', 'result', 'createdAt'],
      'deployment receipt'
    );
    if (content.format !== 1) throw new DeploymentStateError('deployment receipt format must be 1', 'shape');
    if (content.receiptKind !== 'deployment') throw new DeploymentStateError('deployment receipt receiptKind mismatch', 'shape');
    validateOperationId(content.operationId, 'deployment receipt operationId');
    validateOperationId(content.deploymentId, 'deployment receipt deploymentId');
    assertString(content.phaseAtIssuance, 'deployment receipt phaseAtIssuance');
    assertString(content.result, 'deployment receipt result');
    assertIsoTimestamp(content.createdAt, 'deployment receipt createdAt');
  },
  acceptance(content) {
    assertExactFields(
      content,
      ['format', 'receiptKind', 'operationId', 'deploymentId', 'deploymentReceiptSha256', 'result', 'evidenceSha256', 'createdAt'],
      'acceptance receipt'
    );
    if (content.format !== 1) throw new DeploymentStateError('acceptance receipt format must be 1', 'shape');
    if (content.receiptKind !== 'acceptance') throw new DeploymentStateError('acceptance receipt receiptKind mismatch', 'shape');
    validateOperationId(content.operationId, 'acceptance receipt operationId');
    validateOperationId(content.deploymentId, 'acceptance receipt deploymentId');
    assertSha256Hex(content.deploymentReceiptSha256, 'acceptance receipt deploymentReceiptSha256');
    assertString(content.result, 'acceptance receipt result');
    assertSha256Hex(content.evidenceSha256, 'acceptance receipt evidenceSha256');
    assertIsoTimestamp(content.createdAt, 'acceptance receipt createdAt');
  },
  recovery(content) {
    assertExactFields(
      content,
      ['format', 'receiptKind', 'operationId', 'parentDeploymentId', 'restoredPredecessorSha256', 'parentReceiptsSha256',
        'jailedHealthResultSha256', 'postProbeAuditSha256', 'zeroMutationProofSha256', 'createdAt'],
      'recovery receipt'
    );
    if (content.format !== 1) throw new DeploymentStateError('recovery receipt format must be 1', 'shape');
    if (content.receiptKind !== 'recovery') throw new DeploymentStateError('recovery receipt receiptKind mismatch', 'shape');
    validateOperationId(content.operationId, 'recovery receipt operationId');
    validateOperationId(content.parentDeploymentId, 'recovery receipt parentDeploymentId');
    assertSha256Hex(content.restoredPredecessorSha256, 'recovery receipt restoredPredecessorSha256');
    assertSha256Hex(content.parentReceiptsSha256, 'recovery receipt parentReceiptsSha256');
    assertSha256Hex(content.jailedHealthResultSha256, 'recovery receipt jailedHealthResultSha256');
    assertSha256Hex(content.postProbeAuditSha256, 'recovery receipt postProbeAuditSha256');
    assertSha256Hex(content.zeroMutationProofSha256, 'recovery receipt zeroMutationProofSha256');
    assertIsoTimestamp(content.createdAt, 'recovery receipt createdAt');
  },
  'topology-activation'(content) {
    if (content.format !== 1) throw new DeploymentStateError('topology-activation receipt format must be 1', 'shape');
    if (content.receiptKind !== 'topology-activation') throw new DeploymentStateError('topology-activation receipt receiptKind mismatch', 'shape');
    if (!('authorityKind' in content)) {
      throw new DeploymentStateError('topology-activation receipt: missing required field \'authorityKind\'', 'missing-field');
    }
    assertOneOf(content.authorityKind, TOPOLOGY_ACTIVATION_AUTHORITY_KINDS, 'topology-activation receipt authorityKind');
    // authorityKind 'guard-bootstrap': the richer bound-field variant this
    // slice's abandon/authorize verbs write. topologyOutcome couples the
    // hash fields: 'unmutated' (abandon before any application mutation)
    // requires the zero sentinels and never-installed guard-aware 94;
    // 'restored' requires real bound hashes and a present-or-consumed 94.
    assertExactFields(
      content,
      ['format', 'receiptKind', 'authorityKind', 'operationId', 'deploymentId', 'topologyOutcome',
        'guardGeneration', 'guardGenerationSha256', 'sixLinkTopologySha256', 'guardAware94', 'inhibitorSha256',
        'topologyRestorationProofPath', 'topologyRestorationProofSha256', 'compatibilityManifestSha256', 'createdAt'],
      'topology-activation receipt (guard-bootstrap)'
    );
    validateOperationId(content.operationId, 'topology-activation receipt operationId');
    validateOperationId(content.deploymentId, 'topology-activation receipt deploymentId');
    assertOneOf(content.topologyOutcome, ['unmutated', 'restored'], 'topology-activation receipt topologyOutcome');
    assertPositiveInt(content.guardGeneration, 'topology-activation receipt guardGeneration');
    assertSha256Hex(content.guardGenerationSha256, 'topology-activation receipt guardGenerationSha256');
    assertSha256Hex(content.sixLinkTopologySha256, 'topology-activation receipt sixLinkTopologySha256');
    assertSha256Hex(content.inhibitorSha256, 'topology-activation receipt inhibitorSha256');
    if (typeof content.topologyRestorationProofPath !== 'string') {
      throw new DeploymentStateError('topology-activation receipt topologyRestorationProofPath must be a string', 'shape');
    }
    if (content.topologyRestorationProofPath !== '' && !path.isAbsolute(content.topologyRestorationProofPath)) {
      throw new DeploymentStateError('topology-activation receipt topologyRestorationProofPath must be absolute or empty', 'shape');
    }
    assertSha256Hex(content.topologyRestorationProofSha256, 'topology-activation receipt topologyRestorationProofSha256');
    assertSha256Hex(content.compatibilityManifestSha256, 'topology-activation receipt compatibilityManifestSha256');
    assertPlainObject(content.guardAware94, 'topology-activation receipt guardAware94');
    const g94 = content.guardAware94;
    if (g94.state === 'present') {
      assertExactFields(g94, ['state', 'sha256'], 'guardAware94');
      assertSha256Hex(g94.sha256, 'guardAware94.sha256');
    } else if (g94.state === 'absent') {
      // Plan line 200: absence is legal only as
      // {state:'absent',consumptionReceiptSha256:<sha>}.
      assertExactFields(g94, ['state', 'consumptionReceiptSha256'], 'guardAware94');
      assertSha256Hex(g94.consumptionReceiptSha256, 'guardAware94.consumptionReceiptSha256');
    } else if (g94.state === 'never-installed') {
      assertExactFields(g94, ['state'], 'guardAware94');
    } else {
      throw new DeploymentStateError("guardAware94.state must be 'present'|'absent'|'never-installed'", 'shape');
    }
    if (content.topologyOutcome === 'unmutated') {
      if (content.sixLinkTopologySha256 !== GUARD_ABSENT_SHA256
        || content.inhibitorSha256 !== GUARD_ABSENT_SHA256
        || content.topologyRestorationProofSha256 !== GUARD_ABSENT_SHA256
        || content.compatibilityManifestSha256 !== GUARD_ABSENT_SHA256
        || content.topologyRestorationProofPath !== ''
        || g94.state !== 'never-installed') {
        throw new DeploymentStateError(
          "topologyOutcome 'unmutated' requires zero-sentinel six-link/inhibitor hashes and a never-installed guardAware94",
          'shape'
        );
      }
    } else {
      if (content.sixLinkTopologySha256 === GUARD_ABSENT_SHA256
        || content.inhibitorSha256 === GUARD_ABSENT_SHA256
        || content.topologyRestorationProofSha256 === GUARD_ABSENT_SHA256
        || content.compatibilityManifestSha256 === GUARD_ABSENT_SHA256
        || content.topologyRestorationProofPath === ''
        || g94.state === 'never-installed') {
        throw new DeploymentStateError(
          "topologyOutcome 'restored' requires real bound six-link/inhibitor hashes and a present or consumed guardAware94",
          'shape'
        );
      }
    }
    assertIsoTimestamp(content.createdAt, 'topology-activation receipt createdAt');
  },
  abandonment(content) {
    assertExactFields(
      content,
      ['format', 'receiptKind', 'operationId', 'deploymentId', 'abandoningGeneration', 'abandoningGenerationSha256',
        'topologyActivationReceiptSha256', 'mutationOccurred', 'claimConsumed', 'stagingPath', 'createdAt'],
      'abandonment receipt'
    );
    if (content.format !== 1) throw new DeploymentStateError('abandonment receipt format must be 1', 'shape');
    if (content.receiptKind !== 'abandonment') throw new DeploymentStateError('abandonment receipt receiptKind mismatch', 'shape');
    validateOperationId(content.operationId, 'abandonment receipt operationId');
    validateOperationId(content.deploymentId, 'abandonment receipt deploymentId');
    assertPositiveInt(content.abandoningGeneration, 'abandonment receipt abandoningGeneration');
    assertSha256Hex(content.abandoningGenerationSha256, 'abandonment receipt abandoningGenerationSha256');
    assertSha256Hex(content.topologyActivationReceiptSha256, 'abandonment receipt topologyActivationReceiptSha256');
    assertBoolean(content.mutationOccurred, 'abandonment receipt mutationOccurred');
    assertBoolean(content.claimConsumed, 'abandonment receipt claimConsumed');
    assertString(content.stagingPath, 'abandonment receipt stagingPath');
    if (!path.isAbsolute(content.stagingPath)) {
      throw new DeploymentStateError('abandonment receipt stagingPath must be absolute', 'shape');
    }
    assertIsoTimestamp(content.createdAt, 'abandonment receipt createdAt');
  },
};

function writeReceipt(receiptsDir, operationId, kind, content, { crashLabelPrefix } = {}) {
  const p = receiptPath(receiptsDir, operationId, kind);
  const validator = RECEIPT_CONTENT_VALIDATORS[kind];
  if (!validator) {
    throw new DeploymentStateError(
      `receipt kind '${kind}' has no writer in this slice`,
      'receipt-kind-not-writable'
    );
  }
  assertPlainObject(content, `${kind} receipt`);
  validator(content);
  return writeJsonExclusive(p, content, { crashLabelPrefix: crashLabelPrefix || `receipt:${kind}` });
}

function readReceipt(receiptsDir, operationId, kind) {
  const p = receiptPath(receiptsDir, operationId, kind);
  const stat = assertRegularFileMode0600(p);
  if (!stat) return null;
  const content = readJsonFile(p);
  assertPlainObject(content, `${kind} receipt`);
  const validator = RECEIPT_CONTENT_VALIDATORS[kind];
  if (!validator) {
    throw new DeploymentStateError(`receipt kind '${kind}' has no reader in this slice`, 'receipt-kind-not-readable');
  }
  validator(content);
  return { path: p, content, sha256: canonicalHash(content) };
}

// ---------------------------------------------------------------------------
// Permanent attempt tombstones (one-use, O_EXCL, never deleted)
// ---------------------------------------------------------------------------

function attemptTombstonePath(attemptsDir, deploymentId) {
  validateOperationId(deploymentId, 'deploymentId');
  return path.join(validatePersistentAuthorityDirectory(attemptsDir, 'attempts'), `${deploymentId}.attempt.json`);
}

const ATTEMPT_TOMBSTONE_FIELDS = Object.freeze([
  'deploymentId',
  'identitySha256',
  'targetCommitSha',
  'controllerGeneration',
  'claimSha256',
  'claimPath',
  'createdAt',
]);

function validateAttemptTombstone(content) {
  assertPlainObject(content, 'attempt tombstone');
  assertExactFields(content, ATTEMPT_TOMBSTONE_FIELDS, 'attempt tombstone');
  validateOperationId(content.deploymentId, 'attempt tombstone deploymentId');
  assertSha256Hex(content.identitySha256, 'attempt tombstone identitySha256');
  assertString(content.targetCommitSha, 'attempt tombstone targetCommitSha');
  assertPositiveInt(content.controllerGeneration, 'attempt tombstone controllerGeneration');
  assertSha256Hex(content.claimSha256, 'attempt tombstone claimSha256');
  assertAbsolutePathString(content.claimPath, 'attempt tombstone claimPath');
  assertIsoTimestamp(content.createdAt, 'attempt tombstone createdAt');
  return content;
}

function writeAttemptTombstone(attemptsDir, deploymentId, content, { crashLabelPrefix } = {}) {
  const p = attemptTombstonePath(attemptsDir, deploymentId);
  validatePersistentMutationRoot(p);
  validateAttemptTombstone(content);
  if (content.deploymentId !== deploymentId) {
    throw new DeploymentStateError('attempt tombstone deployment id does not match its path', 'operation-id-mismatch');
  }
  const existing = readAttemptTombstone(attemptsDir, deploymentId);
  if (existing) {
    for (const field of ATTEMPT_TOMBSTONE_FIELDS.filter((name) => name !== 'createdAt')) {
      if (existing[field] !== content[field]) {
        throw new DeploymentStateError('existing attempt tombstone belongs to different identity', 'attempt-tombstone-conflict');
      }
    }
    return writeJsonExclusive(p, existing, {
      crashLabelPrefix: crashLabelPrefix || 'attempt-tombstone',
      allowExactExisting: true,
    });
  }
  return writeJsonExclusive(p, content, {
    crashLabelPrefix: crashLabelPrefix || 'attempt-tombstone',
  });
}

function readAttemptTombstone(attemptsDir, deploymentId) {
  const p = attemptTombstonePath(attemptsDir, deploymentId);
  const stat = assertRegularFileMode0600(p);
  if (!stat) return null;
  return validateAttemptTombstone(readJsonFile(p));
}

// ---------------------------------------------------------------------------
// Lock protocol ("Serialize every deploy attempt"):
// /var/lock/osi-deploy.lock.d is a directory-based mutex (mkdir is atomic
// and EEXIST-on-conflict). Root-only owner metadata lives at
// <lock-dir>/owner.json. leaseActive in deployment state is authoritative
// across /var/lock loss (e.g. reboot): a live lease for a *different*
// deployment blocks lock acquisition even when the physical lock dir is
// gone.
// ---------------------------------------------------------------------------

const LOCK_DIR_MODE = 0o700;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readBootId(bootIdPath = '/proc/sys/kernel/random/boot_id') {
  let value;
  try {
    value = fs.readFileSync(bootIdPath, 'utf8').trim();
  } catch (error) {
    throw new DeploymentStateError(`kernel boot ID is unavailable: ${error.message}`, 'boot-id-unavailable');
  }
  if (!BOOT_ID_PATTERN.test(value)) {
    throw new DeploymentStateError('kernel boot ID is empty or not UUID-shaped', 'boot-id-invalid');
  }
  return value.toLowerCase();
}

function getBootId() {
  // Test-only injection point: real production code always reads the
  // kernel boot id; tests simulate reboot by overriding it (there is no
  // other reliable, fast way to make "a reboot happened" observable to a
  // Node process in a unit test).
  const expectedBoundary = path.join('/tmp', `osi-deploy-startup-tests-${process.getuid()}`);
  const testOverrideAllowed = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
    && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
    && process.env.OSI_DEPLOY_TEST_BOUNDARY === expectedBoundary;
  if (testOverrideAllowed && process.env.OSI_DEPLOY_TEST_BOOT_ID) {
    return process.env.OSI_DEPLOY_TEST_BOOT_ID;
  }
  return readBootId();
}

function lockOwnerPath(lockDir) {
  return path.join(lockDir, 'owner.json');
}

const LOCK_OWNER_FIELDS = [
  'deploymentId',
  'pid',
  'processStartTime',
  'bootId',
  'targetCommitSha',
  'controllerGeneration',
  'acquiredAt',
];

function validateLockOwner(obj) {
  assertPlainObject(obj, 'lockOwner');
  assertExactFields(obj, LOCK_OWNER_FIELDS, 'lockOwner');
  validateOperationId(obj.deploymentId, 'lockOwner.deploymentId');
  assertPositiveInt(obj.pid, 'lockOwner.pid');
  assertString(obj.processStartTime, 'lockOwner.processStartTime');
  if (!/^\d+$/.test(obj.processStartTime)) {
    throw new DeploymentStateError('lockOwner.processStartTime must be a /proc starttime', 'shape');
  }
  assertString(obj.bootId, 'lockOwner.bootId');
  assertString(obj.targetCommitSha, 'lockOwner.targetCommitSha');
  assertPositiveInt(obj.controllerGeneration, 'lockOwner.controllerGeneration');
  assertIsoTimestamp(obj.acquiredAt, 'lockOwner.acquiredAt');
  return obj;
}

function readLockOwner(lockDir) {
  const p = lockOwnerPath(lockDir);
  validateAttemptLockPath(lockDir);
  const stat = assertRegularFileMode0600(p);
  if (!stat) return null;
  const owner = readJsonFile(p);
  validateLockOwner(owner);
  return owner;
}

function writeLockOwner(lockDir, owner, { crashLabelPrefix } = {}) {
  validateAttemptLockPath(lockDir);
  validateLockOwner(owner);
  const p = lockOwnerPath(lockDir);
  return writeJsonExclusive(p, owner, { crashLabelPrefix: crashLabelPrefix || 'lock-owner' });
}

// "Live" liveness is checked against the *controlling* process (e.g.
// deploy.sh), not any single verb invocation's own transient node process:
// per the plan's pinned CLI forms, every verb is its own
// `node .../osi-deployment-state-cli.js <verb> ...` process that exits as
// soon as that verb finishes, so a pid recorded as `process.pid` at
// acquire-lock time would already be dead by the time a later verb in the
// same attempt (e.g. `recover`) checked it. acquireLock() below records
// `process.ppid` -- the parent that spawned this CLI invocation, which is
// the actual long-lived owner of the attempt.
function isOwnerLive(owner, currentBootId) {
  if (!owner) return false;
  if (owner.bootId !== currentBootId) return false;
  try {
    return readProcessStartTime(owner.pid) === owner.processStartTime;
  } catch (_err) {
    return false;
  }
}

// Reads deployment state if present; returns null for a genuinely fresh
// gateway (no state file yet, nothing to be authoritative about).
function readStateOrNull(statePath) {
  return readState(statePath);
}

function quarantineAttemptLockDirectory(lockDir, before, expectedOwnerRaw, label = 'stale') {
  let quarantine;
  do {
    quarantine = `${lockDir}.${label}-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  } while (lstatOrNull(quarantine));
  fs.renameSync(lockDir, quarantine);
  fsyncDir(path.dirname(lockDir));
  const displaced = fs.lstatSync(quarantine);
  let displacedOwnerRaw = null;
  try { displacedOwnerRaw = fs.readFileSync(lockOwnerPath(quarantine)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sameDirectory = displaced.dev === before.dev && displaced.ino === before.ino;
  const sameOwner = expectedOwnerRaw === null
    ? displacedOwnerRaw === null
    : displacedOwnerRaw !== null && displacedOwnerRaw.equals(expectedOwnerRaw);
  if (!sameDirectory || !sameOwner) {
    if (!lstatOrNull(lockDir)) fs.renameSync(quarantine, lockDir);
    fsyncDir(path.dirname(lockDir));
    throw new DeploymentStateError('attempt lock changed during stale reclaim', 'lock-reclaim-race');
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  fsyncDir(path.dirname(lockDir));
}

function reclaimAttemptLockDirectory(lockDir, expectedOwnerRaw) {
  const before = fs.lstatSync(lockDir);
  quarantineAttemptLockDirectory(lockDir, before, expectedOwnerRaw, 'stale');
}

function acquireLock({
  lockDir,
  statePath,
  deploymentId,
  targetCommitSha,
  controllerGeneration,
  bootId,
  now,
  crashLabelPrefix,
  _ownerlessRetry,
}) {
  assertString(lockDir, 'lockDir');
  assertString(statePath, 'statePath');
  validatePersistentMutationRoot(statePath);
  validateAttemptLockPath(lockDir);
  validateOperationId(deploymentId, 'deploymentId');
  assertString(targetCommitSha, 'targetCommitSha');
  assertPositiveInt(controllerGeneration, 'controllerGeneration');
  const effectiveBootId = bootId || getBootId();
  const acquiredAt = now || new Date().toISOString();
  const ownerProcessStartTime = readProcessStartTime(process.ppid);
  if (ownerProcessStartTime === null) {
    throw new DeploymentStateError('cannot bind attempt lock to the controlling process', 'lock-owner-unavailable');
  }

  const state = readStateOrNull(statePath);
  if (state && state.parentDeployment.leaseActive && state.parentDeployment.deploymentId !== deploymentId) {
    const contenderIsLinkedRecovery =
      state.activeSubOperation &&
      state.activeSubOperation.kind === 'recovery' &&
      state.activeSubOperation.parentDeploymentId === state.parentDeployment.deploymentId &&
      state.activeSubOperation.operationId === deploymentId;
    if (!contenderIsLinkedRecovery) {
      throw new DeploymentStateError(
        `deployment state lease is active for a different deployment: ${state.parentDeployment.deploymentId}`,
        'lease-active-different-deployment'
      );
    }
  }
  if (state && state.parentDeployment.deploymentId === deploymentId) {
    const parent = state.parentDeployment;
    if (parent.targetCommitSha !== targetCommitSha || parent.controllerGeneration !== controllerGeneration) {
      throw new DeploymentStateError(
        'same-operation attempt lock identity does not match persistent deployment state',
        'lock-state-identity-mismatch'
      );
    }
    if (!parent.claimPath || !parent.claimSha256) {
      throw new DeploymentStateError(
        'same-operation persistent deployment state has no complete claim authority',
        'lock-claim-mismatch'
      );
    }
    assertRegularFileMode0600(parent.claimPath);
    const claimRaw = fs.readFileSync(parent.claimPath);
    if (sha256Hex(claimRaw) !== parent.claimSha256) {
      throw new DeploymentStateError(
        'same-operation persistent deployment claim bytes do not match state',
        'lock-claim-mismatch'
      );
    }
  }

  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  assertNotSymlink(lockDir);

  const newOwner = {
    deploymentId,
    pid: process.ppid,
    processStartTime: ownerProcessStartTime,
    bootId: effectiveBootId,
    targetCommitSha,
    controllerGeneration,
    acquiredAt,
  };

  let created = false;
  try {
    fs.mkdirSync(lockDir, LOCK_DIR_MODE);
    created = true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  if (created) {
    // Crash boundary: the dir exists but the owner metadata does not. An
    // owner-less dir is an incomplete acquisition (see below), never a
    // held lock, so a kill here must not wedge later acquisitions.
    maybeCrash('attempt-lock:after-mkdir');
    writeLockOwner(lockDir, newOwner, { crashLabelPrefix });
    // reclaimed:true when this create is the retry after removing an
    // owner-less husk - the caller observed a reclaim, not a fresh dir.
    return { acquired: true, reclaimed: Boolean(_ownerlessRetry) };
  }

  const existingOwner = readLockOwner(lockDir);

  if (existingOwner === null) {
    // No owner file: a previous acquirer was killed between mkdir and the
    // owner write. Nothing ever held this lock, so there is no identity
    // to defend - remove the husk and retry once. A second owner-less
    // conflict within the same call means another crasher keeps
    // recreating the dir; fail bounded rather than loop.
    if (_ownerlessRetry) {
      throw new DeploymentStateError(
        'lock dir remains owner-less after one reclaim attempt',
        'lock-ownerless-unrecoverable'
      );
    }
    reclaimAttemptLockDirectory(lockDir, null);
    return acquireLock({
      lockDir,
      statePath,
      deploymentId,
      targetCommitSha,
      controllerGeneration,
      bootId,
      now,
      crashLabelPrefix,
      _ownerlessRetry: true,
    });
  }

  if (existingOwner.deploymentId === deploymentId
      && (existingOwner.targetCommitSha !== targetCommitSha
        || existingOwner.controllerGeneration !== controllerGeneration
        || existingOwner.bootId !== effectiveBootId)) {
    throw new DeploymentStateError('same-operation attempt lock identity changed', 'lock-identity-mismatch');
  }

  const live = isOwnerLive(existingOwner, effectiveBootId);

  if (live) {
    if (
      existingOwner &&
      existingOwner.deploymentId === deploymentId &&
      existingOwner.pid === process.ppid &&
      existingOwner.processStartTime === ownerProcessStartTime
    ) {
      return { acquired: true, reclaimed: false, alreadyOwned: true };
    }
    throw new DeploymentStateError('lock is held by a live contender', 'lock-contended');
  }

  // Stale: reclaim only for the same operation, or an explicitly linked
  // recovery/rehearsal sub-operation whose persistent lease identity
  // matches (state.activeSubOperation links the stale owner's deployment
  // to this contender's operation id).
  const sameOperation = existingOwner && existingOwner.deploymentId === deploymentId;
  const linkedRecovery =
    !sameOperation &&
    existingOwner &&
    state &&
    state.activeSubOperation &&
    state.activeSubOperation.kind === 'recovery' &&
    state.activeSubOperation.parentDeploymentId === existingOwner.deploymentId &&
    state.activeSubOperation.operationId === deploymentId;

  if (!sameOperation && !linkedRecovery) {
    throw new DeploymentStateError(
      `stale lock is owned by a different, unlinked deployment: ${existingOwner ? existingOwner.deploymentId : '(unreadable)'}`,
      'lock-reclaim-refused'
    );
  }

  const expectedOwnerRaw = fs.readFileSync(lockOwnerPath(lockDir));
  reclaimAttemptLockDirectory(lockDir, expectedOwnerRaw);
  try {
    fs.mkdirSync(lockDir, LOCK_DIR_MODE);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new DeploymentStateError('another owner replaced the attempt lock during reclaim', 'lock-reclaim-race');
    }
    throw error;
  }
  // Same crash boundary as the fresh-create path: a kill here leaves an
  // owner-less dir, which the rule above reclaims on the next call.
  maybeCrash('attempt-lock:after-mkdir');
  writeLockOwner(lockDir, newOwner, { crashLabelPrefix });
  return { acquired: true, reclaimed: true };
}

function createLockReleaseIntent({ lockDir, operationId, finalReceiptSha256, existing = null }) {
  validateAttemptLockPath(lockDir);
  validateOperationId(operationId, 'operationId');
  assertSha256Hex(finalReceiptSha256, 'finalReceiptSha256');
  if (existing) {
    validateLockRelease(existing);
    if (existing.status !== 'intent' || existing.operationId !== operationId
        || existing.lockDir !== lockDir || existing.finalReceiptSha256 !== finalReceiptSha256) {
      throw new DeploymentStateError('recorded preterminal release intent differs from this terminal CAS', 'lock-release-mismatch');
    }
    const lockStat = lstatOrNull(lockDir);
    if (lockStat) {
      const ownerRaw = fs.readFileSync(lockOwnerPath(lockDir));
      const owner = validateLockOwner(JSON.parse(ownerRaw));
      if (owner.deploymentId !== operationId || sha256Hex(ownerRaw) !== existing.lockOwnerSha256
          || owner.bootId !== existing.lockBootId) {
        throw new DeploymentStateError('volatile owner differs from durable preterminal release intent', 'lock-release-mismatch');
      }
    }
    return existing;
  }
  const ownerRaw = fs.readFileSync(lockOwnerPath(lockDir));
  const owner = validateLockOwner(JSON.parse(ownerRaw));
  if (owner.deploymentId !== operationId) {
    throw new DeploymentStateError('lock owner does not match terminal operation-id', 'lock-owner-mismatch');
  }
  const currentStartTime = readProcessStartTime(process.ppid);
  if (owner.pid !== process.ppid || currentStartTime === null || owner.processStartTime !== currentStartTime) {
    throw new DeploymentStateError('terminal intent requires the exact controlling lock owner process', 'lock-owner-mismatch');
  }
  return {
    format: 1,
    status: 'intent',
    operationId,
    lockDir,
    lockOwnerSha256: sha256Hex(ownerRaw),
    lockBootId: owner.bootId,
    finalReceiptSha256,
    releaseStartedAt: new Date().toISOString(),
    releasedAt: null,
  };
}

function releaseLock({ lockDir, statePath, operationId, expectedFinalReceiptSha256 }) {
  assertString(lockDir, 'lockDir');
  assertString(statePath, 'statePath');
  validatePersistentMutationRoot(statePath);
  validateAttemptLockPath(lockDir);
  validateOperationId(operationId, 'operationId');
  assertSha256Hex(expectedFinalReceiptSha256, 'expectedFinalReceiptSha256');

  return withStateMutation(statePath, operationId, () => {
    let state = readState(statePath);
    if (!state) throw new DeploymentStateError('no deployment state to release against', 'state-missing');
    let parent = state.parentDeployment;
    let actual;
    if (parent.phase === 'completed') {
      if (parent.deploymentId !== operationId) {
        throw new DeploymentStateError('parentDeployment.deploymentId does not match operation-id', 'operation-id-mismatch');
      }
      actual = parent.acceptanceReceiptSha256;
    } else if (parent.phase === 'recovered') {
      if (parent.recoveryOperationId !== operationId) {
        throw new DeploymentStateError('parentDeployment.recoveryOperationId does not match operation-id', 'operation-id-mismatch');
      }
      actual = parent.recoveryReceiptSha256;
    } else {
      throw new DeploymentStateError(
        `release-lock requires a terminal phase (completed|recovered), got '${parent.phase}'`,
        'not-terminal'
      );
    }
    if (actual !== expectedFinalReceiptSha256) {
      throw new DeploymentStateError('final receipt hash does not match the recorded terminal receipt', 'receipt-mismatch');
    }

    let release = parent.lockRelease || null;
    if (!release) {
      throw new DeploymentStateError('terminal state lacks a durable preterminal release intent', 'lock-release-missing');
    }
    validateLockRelease(release);
    if (release.operationId !== operationId || release.lockDir !== lockDir
        || release.finalReceiptSha256 !== expectedFinalReceiptSha256) {
      throw new DeploymentStateError('recorded lock release authority differs from this invocation', 'lock-release-mismatch');
    }
    if (release.status === 'released') {
      if (lstatOrNull(lockDir) !== null) {
        throw new DeploymentStateError('released lock authority conflicts with a present volatile lock', 'lock-release-mismatch');
      }
      return { released: true, resumed: true, lockRelease: release };
    }

    let lockStat = lstatOrNull(lockDir);
    let ownerRaw = null;
    if (lockStat) {
      ownerRaw = fs.readFileSync(lockOwnerPath(lockDir));
      const owner = validateLockOwner(JSON.parse(ownerRaw));
      if (owner.deploymentId !== operationId) {
        throw new DeploymentStateError('lock owner does not match operation-id', 'lock-owner-mismatch');
      }
      const ownerSha256 = sha256Hex(ownerRaw);
      if (release.lockOwnerSha256 !== ownerSha256 || release.lockBootId !== owner.bootId) {
        throw new DeploymentStateError('volatile lock differs from the recorded releasing authority', 'lock-release-mismatch');
      }
      if (release.status === 'intent') {
        const now = new Date().toISOString();
        release = { ...release, status: 'releasing' };
        parent = { ...parent, lockRelease: release, generation: parent.generation + 1, updatedAt: now };
        validateParentDeployment(parent);
        writeState(statePath, { ...state, parentDeployment: parent });
        maybeCrash('release-lock:after-releasing-state');
      }
      quarantineAttemptLockDirectory(lockDir, lockStat, ownerRaw, 'release');
      maybeCrash('release-lock:after-lock-removal');
    }

    state = readState(statePath);
    parent = state.parentDeployment;
    release = parent.lockRelease;
    if (!release || !['intent', 'releasing'].includes(release.status)) {
      throw new DeploymentStateError('durable releasing authority disappeared before finalization', 'lock-release-mismatch');
    }
    const releasedAt = new Date().toISOString();
    const released = { ...release, status: 'released', releasedAt };
    parent = { ...parent, lockRelease: released, generation: parent.generation + 1, updatedAt: releasedAt };
    validateParentDeployment(parent);
    writeState(statePath, { ...state, parentDeployment: parent });
    maybeCrash('release-lock:after-released-state');
    return { released: true, resumed: false, lockRelease: released };
  });
}

// ---------------------------------------------------------------------------
// Guard-bootstrap append-only chain (A0 sub-tranche 2, plan Task A0
// guard-bootstrap paragraph, ~line 172).
//
// Layout: <root>/<deployment-id>/<NNNNNNNN>.json - strict 8-digit
// zero-padded generation files, root-only mode 0600, append-only. Each
// entry carries the common identity, bootEpoch/bootId, one phase,
// phase-specific facts, createdAt, and a bounded result. Every append
// exclusively creates the next generation (temp + fdatasync + link(2), so
// a torn generation can never be observed - link supplies the exclusivity
// O_EXCL would, with crash-atomic content) and fsyncs the directory.
//
// Where the plan prose is behavioral rather than literal-JSON (the exact
// facts field names per phase, the profile field names, the 8-digit width,
// result boundedness), the schemas below are this module's concretization,
// flagged for downstream reconciliation in the execution report.
// ---------------------------------------------------------------------------

const GUARD_ENTRY_FORMAT = 1;
// Canonical "no such artifact" sentinel for hash slots that have no real
// subject yet (e.g. abandoning before any topology snapshot exists). A
// deliberate, recognizable non-hash: sha256 output is never all zeros.
const GUARD_ABSENT_SHA256 = '0'.repeat(64);
const GUARD_GENERATION_DIGITS = 8;
const GUARD_MAX_GENERATION = 10 ** GUARD_GENERATION_DIGITS - 1;
const GUARD_RESULT_MAX_LENGTH = 256;

// Verbatim first-epoch sequence from the plan.
const GUARD_FIRST_EPOCH_PHASES = Object.freeze([
  'intent',
  'epoch-start',
  'roles-stopping',
  'roles-stopped',
  'topology-snapshotted',
  'safety-installing',
  'safety-installed',
  'links-quarantined',
  'controls-installed',
  'ready',
  'claimed',
]);

const GUARD_PHASES = Object.freeze([
  ...GUARD_FIRST_EPOCH_PHASES,
  'epoch-invalidated',
  'ready-revalidated',
  'abandoning',
  'abandoned',
]);

// Phases from which a reboot invalidates the epoch (reboot-before-ready).
const GUARD_PRE_READY_PHASES = Object.freeze([
  'intent',
  'epoch-start',
  'roles-stopping',
  'roles-stopped',
  'topology-snapshotted',
  'safety-installing',
  'safety-installed',
  'links-quarantined',
  'controls-installed',
]);

// Phases that mutate application state ("safety-installing binds ... before
// mutation" - mutation begins at safety-installing).
const GUARD_MUTATION_PHASES = Object.freeze([
  'roles-stopping',
  'safety-installing',
  'safety-installed',
  'links-quarantined',
  'controls-installed',
]);

// Terminal phases for begin's second-nonterminal-ID refusal. 'claimed' is
// terminal here by necessity: after `arm`, recovery is the only authority
// over a claimed chain and no later verb ever appends to it, so treating
// claimed as in-flight would deadlock every subsequent deployment's begin.
// The claim itself stays one-use via arm's own state-file exclusivity and
// the immutable claim file. Documented in the execution report.
const GUARD_TERMINAL_PHASES = Object.freeze(['claimed', 'abandoned']);

const GUARD_PROFILES = Object.freeze(['bcm2712', 'bcm2709']);

const GUARD_ROLES = Object.freeze(['osi-identityd', 'node-red', 'osi-bootstrap', 'osi-db-integrity']);
const GUARD_ROLE_LINKS = Object.freeze({
  'osi-identityd': Object.freeze(['/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd']),
  'node-red': Object.freeze(['/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red']),
  'osi-bootstrap': Object.freeze(['/etc/rc.d/S99osi-bootstrap']),
  'osi-db-integrity': Object.freeze(['/etc/rc.d/S90osi-db-integrity']),
});

// Append adjacency. claimed/abandoning/abandoned are verb-guarded on top of
// this (claim-attempt and abandon-guard-bootstrap are the only writers).
const GUARD_PHASE_TRANSITIONS = Object.freeze({
  intent: ['epoch-start', 'epoch-invalidated', 'abandoning'],
  'epoch-start': ['roles-stopping', 'epoch-invalidated', 'abandoning'],
  'roles-stopping': ['roles-stopped', 'epoch-invalidated', 'abandoning'],
  'roles-stopped': ['topology-snapshotted', 'epoch-invalidated', 'abandoning'],
  'topology-snapshotted': ['safety-installing', 'epoch-invalidated', 'abandoning'],
  'safety-installing': ['safety-installed', 'epoch-invalidated', 'abandoning'],
  'safety-installed': ['links-quarantined', 'epoch-invalidated', 'abandoning'],
  'links-quarantined': ['controls-installed', 'epoch-invalidated', 'abandoning'],
  'controls-installed': ['ready', 'epoch-invalidated', 'abandoning'],
  ready: ['claimed', 'ready-revalidated', 'abandoning'],
  'ready-revalidated': ['claimed', 'ready-revalidated', 'abandoning'],
  claimed: ['abandoning'],
  'epoch-invalidated': ['epoch-start', 'abandoning'],
  abandoning: ['abandoned'],
  abandoned: [],
});

const GUARD_COMMON_IDENTITY_FIELDS = Object.freeze([
  'deploymentId',
  'controllerGeneration',
  'targetCommitSha',
  'artifactSha256',
  'controlManifestSha256',
  'detectedProfile',
  'expectedProfile',
  'profileMappingSha256',
]);

const GUARD_ENTRY_FIELDS = Object.freeze([
  'format',
  'generation',
  'previousGenerationSha256',
  ...GUARD_COMMON_IDENTITY_FIELDS,
  'bootEpoch',
  'bootId',
  'phase',
  'facts',
  'result',
  'createdAt',
]);

function assertBoundedString(value, ctx, max) {
  assertString(value, ctx);
  if (value.length > max) {
    throw new DeploymentStateError(`${ctx} exceeds bounded length ${max}`, 'shape');
  }
  return value;
}

function assertAbsolutePathString(value, ctx) {
  assertString(value, ctx);
  if (!path.isAbsolute(value)) {
    throw new DeploymentStateError(`${ctx} must be an absolute path`, 'shape');
  }
  return value;
}

function validateStoppedRoleGenerations(obj, ctx) {
  assertPlainObject(obj, ctx);
  assertExactFields(obj, GUARD_ROLES, ctx);
  for (const role of GUARD_ROLES) {
    assertPositiveInt(obj[role], `${ctx}.${role}`);
  }
  return obj;
}

function validateGuardRoleStates(roleStates, entry, ctx) {
  assertPlainObject(roleStates, ctx);
  assertExactFields(roleStates, GUARD_ROLES, ctx);
  for (const role of GUARD_ROLES) {
    const roleCtx = `${ctx}.${role}`;
    const s = roleStates[role];
    assertPlainObject(s, roleCtx);
    assertExactFields(s, [
      'running', 'ready', 'enabled', 'pid', 'processStartTime', 'lifecycleGeneration', 'bootId', 'rcLinks',
    ], roleCtx);
    assertBoolean(s.running, `${roleCtx}.running`);
    assertBoolean(s.ready, `${roleCtx}.ready`);
    if (s.ready && !s.running) {
      throw new DeploymentStateError(`${roleCtx} cannot be ready while stopped`, 'shape');
    }
    assertBoolean(s.enabled, `${roleCtx}.enabled`);
    if (s.running) {
      assertPositiveInt(s.pid, `${roleCtx}.pid`);
      assertString(s.processStartTime, `${roleCtx}.processStartTime`);
      if (!/^\d+$/.test(s.processStartTime)) {
        throw new DeploymentStateError(`${roleCtx}.processStartTime must be a /proc starttime`, 'shape');
      }
    } else if (s.pid !== null || s.processStartTime !== null) {
      throw new DeploymentStateError(`${roleCtx} must not claim a process while stopped`, 'shape');
    }
    assertPositiveInt(s.lifecycleGeneration, `${roleCtx}.lifecycleGeneration`);
    assertString(s.bootId, `${roleCtx}.bootId`);
    if (s.bootId !== entry.bootId) {
      throw new DeploymentStateError(`${roleCtx}.bootId must equal the entry boot`, 'guard-fact-binding');
    }
    if (!Array.isArray(s.rcLinks) || s.rcLinks.length !== GUARD_ROLE_LINKS[role].length) {
      throw new DeploymentStateError(`${roleCtx}.rcLinks must record every canonical link`, 'shape');
    }
    let allEnabled = true;
    s.rcLinks.forEach((rcLink, index) => {
      const linkCtx = `${roleCtx}.rcLinks[${index}]`;
      assertPlainObject(rcLink, linkCtx);
      const expectedPath = GUARD_ROLE_LINKS[role][index];
      if (rcLink.state === 'symlink') {
        assertExactFields(rcLink, ['path', 'state', 'target'], linkCtx);
        if (rcLink.path !== expectedPath || rcLink.target !== `../init.d/${role}`) {
          throw new DeploymentStateError(`${roleCtx}.rcLinks has an unexpected target`, 'shape');
        }
      } else {
        allEnabled = false;
        assertExactFields(rcLink, ['path', 'state'], linkCtx);
        if (rcLink.path !== expectedPath || rcLink.state !== 'absent') {
          throw new DeploymentStateError(`${roleCtx}.rcLinks must record exact absence`, 'shape');
        }
      }
    });
    if (s.enabled !== allEnabled) {
      throw new DeploymentStateError(`${roleCtx}.enabled disagrees with exact rcLinks`, 'shape');
    }
  }
  return roleStates;
}

const GUARD_FACTS_VALIDATORS = {
  intent(facts, entry) {
    assertExactFields(facts, ['priorRoleStates'], 'intent facts');
    validateGuardRoleStates(facts.priorRoleStates, entry, 'intent facts.priorRoleStates');
  },
  'epoch-start'(facts, entry) {
    assertExactFields(facts, ['priorRoleStates'], 'epoch-start facts');
    validateGuardRoleStates(facts.priorRoleStates, entry, 'epoch-start facts.priorRoleStates');
  },
  'roles-stopping'(facts) {
    assertExactFields(facts, ['priorRoleStatesSha256'], 'roles-stopping facts');
    assertSha256Hex(facts.priorRoleStatesSha256, 'roles-stopping facts.priorRoleStatesSha256');
  },
  'roles-stopped'(facts) {
    assertExactFields(facts, ['stoppedRoleGenerations'], 'roles-stopped facts');
    validateStoppedRoleGenerations(facts.stoppedRoleGenerations, 'roles-stopped facts.stoppedRoleGenerations');
  },
  'topology-snapshotted'(facts) {
    assertExactFields(
      facts,
      ['topologyManifestPath', 'topologyManifestSha256', 'bootId', 'stoppedRoleGenerations'],
      'topology-snapshotted facts'
    );
    assertAbsolutePathString(facts.topologyManifestPath, 'topology-snapshotted facts.topologyManifestPath');
    assertSha256Hex(facts.topologyManifestSha256, 'topology-snapshotted facts.topologyManifestSha256');
    assertString(facts.bootId, 'topology-snapshotted facts.bootId');
    validateStoppedRoleGenerations(facts.stoppedRoleGenerations, 'topology-snapshotted facts.stoppedRoleGenerations');
  },
  'safety-installing'(facts) {
    assertExactFields(facts, ['targetSafetyManifestSha256', 'intendedPaths'], 'safety-installing facts');
    assertSha256Hex(facts.targetSafetyManifestSha256, 'safety-installing facts.targetSafetyManifestSha256');
    if (!Array.isArray(facts.intendedPaths) || facts.intendedPaths.length === 0) {
      throw new DeploymentStateError('safety-installing facts.intendedPaths must be a non-empty array', 'shape');
    }
    for (const p of facts.intendedPaths) {
      assertAbsolutePathString(p, 'safety-installing facts.intendedPaths[]');
    }
    if (canonicalize(facts.intendedPaths) !== canonicalize(TARGET_SAFETY_PATHS)) {
      throw new DeploymentStateError('safety-installing facts.intendedPaths must be the exact permanent safety inventory', 'shape');
    }
  },
  'safety-installed'(facts) {
    assertExactFields(
      facts,
      ['targetSafetyManifestSha256', 'inhibitorSha256', 'helperSha256', 'guardAware94Sha256', 's01Target', 'fsyncResult'],
      'safety-installed facts'
    );
    assertSha256Hex(facts.targetSafetyManifestSha256, 'safety-installed facts.targetSafetyManifestSha256');
    assertSha256Hex(facts.inhibitorSha256, 'safety-installed facts.inhibitorSha256');
    assertSha256Hex(facts.helperSha256, 'safety-installed facts.helperSha256');
    assertSha256Hex(facts.guardAware94Sha256, 'safety-installed facts.guardAware94Sha256');
    if (facts.s01Target !== '../init.d/osi-deployment-inhibit') {
      throw new DeploymentStateError('safety-installed facts.s01Target must be the exact inhibitor init link target', 'shape');
    }
    if (facts.fsyncResult !== 'ok') {
      throw new DeploymentStateError("safety-installed facts.fsyncResult must be 'ok'", 'shape');
    }
  },
  'links-quarantined'(facts) {
    assertExactFields(facts, ['sixLinkTopologySha256', 'removedLinks'], 'links-quarantined facts');
    assertSha256Hex(facts.sixLinkTopologySha256, 'links-quarantined facts.sixLinkTopologySha256');
    if (!Array.isArray(facts.removedLinks) || facts.removedLinks.length !== 6) {
      throw new DeploymentStateError('links-quarantined facts.removedLinks must list exactly six links', 'shape');
    }
    for (let index = 0; index < SIX_APPLICATION_LINK_TARGETS.length; index += 1) {
      const actual = facts.removedLinks[index];
      const expected = SIX_APPLICATION_LINK_TARGETS[index];
      assertPlainObject(actual, `links-quarantined facts.removedLinks[${index}]`);
      assertExactFields(actual, ['path', 'target'], `links-quarantined facts.removedLinks[${index}]`);
      if (actual.path !== expected.path || actual.target !== expected.target) {
        throw new DeploymentStateError(
          'links-quarantined facts.removedLinks must contain the exact canonical six-link paths and targets',
          'shape'
        );
      }
    }
  },
  'controls-installed'(facts) {
    assertExactFields(facts, ['controlManifestSha256', 'installedControlHashes'], 'controls-installed facts');
    assertSha256Hex(facts.controlManifestSha256, 'controls-installed facts.controlManifestSha256');
    assertPlainObject(facts.installedControlHashes, 'controls-installed facts.installedControlHashes');
    const keys = Object.keys(facts.installedControlHashes);
    if (keys.length === 0) {
      throw new DeploymentStateError('controls-installed facts.installedControlHashes must be non-empty', 'shape');
    }
    for (const key of keys) {
      assertAbsolutePathString(key, 'controls-installed facts.installedControlHashes key');
      assertSha256Hex(facts.installedControlHashes[key], `controls-installed facts.installedControlHashes['${key}']`);
    }
  },
  ready(facts) {
    assertExactFields(facts, ['markerSha256', 'sixLinkTopologySha256', 'targetSafetyManifestSha256'], 'ready facts');
    assertSha256Hex(facts.markerSha256, 'ready facts.markerSha256');
    assertSha256Hex(facts.sixLinkTopologySha256, 'ready facts.sixLinkTopologySha256');
    assertSha256Hex(facts.targetSafetyManifestSha256, 'ready facts.targetSafetyManifestSha256');
  },
  'ready-revalidated'(facts) {
    assertExactFields(
      facts,
      ['markerSha256', 'guardAware94Sha256', 'inhibitorSha256', 'controlManifestSha256', 'sixLinksAbsent', 'volatileRestartFacts'],
      'ready-revalidated facts'
    );
    assertSha256Hex(facts.markerSha256, 'ready-revalidated facts.markerSha256');
    assertSha256Hex(facts.guardAware94Sha256, 'ready-revalidated facts.guardAware94Sha256');
    assertSha256Hex(facts.inhibitorSha256, 'ready-revalidated facts.inhibitorSha256');
    assertSha256Hex(facts.controlManifestSha256, 'ready-revalidated facts.controlManifestSha256');
    if (facts.sixLinksAbsent !== true) {
      throw new DeploymentStateError('ready-revalidated facts.sixLinksAbsent must be true', 'shape');
    }
    assertPlainObject(facts.volatileRestartFacts, 'ready-revalidated facts.volatileRestartFacts');
  },
  claimed(facts) {
    assertExactFields(facts, ['claimSha256', 'claimPath'], 'claimed facts');
    assertSha256Hex(facts.claimSha256, 'claimed facts.claimSha256');
    assertAbsolutePathString(facts.claimPath, 'claimed facts.claimPath');
  },
  'epoch-invalidated'(facts) {
    assertExactFields(facts, ['invalidatedEpoch', 'previousBootId'], 'epoch-invalidated facts');
    assertPositiveInt(facts.invalidatedEpoch, 'epoch-invalidated facts.invalidatedEpoch');
    assertString(facts.previousBootId, 'epoch-invalidated facts.previousBootId');
  },
  abandoning(facts) {
    assertPlainObject(facts, 'abandoning facts');
    assertBoolean(facts.mutationOccurred, 'abandoning facts.mutationOccurred');
    if (facts.mutationOccurred === false) {
      assertExactFields(facts, [
        'mutationOccurred', 'headPhaseAtAbandon', 'headGenerationAtAbandon', 'unchangedRoleAuthoritySha256',
      ], 'abandoning facts');
      assertOneOf(facts.headPhaseAtAbandon, GUARD_PHASES, 'abandoning facts.headPhaseAtAbandon');
      assertPositiveInt(facts.headGenerationAtAbandon, 'abandoning facts.headGenerationAtAbandon');
      assertSha256Hex(facts.unchangedRoleAuthoritySha256, 'abandoning facts.unchangedRoleAuthoritySha256');
    } else {
      assertExactFields(
        facts,
        ['mutationOccurred', 'topologySnapshotSha256', 'restoreTargetSha256', 'lastMutationGeneration',
          'topologyRestorationProofSha256', 'compatibilityManifestSha256'],
        'abandoning facts'
      );
      assertSha256Hex(facts.topologySnapshotSha256, 'abandoning facts.topologySnapshotSha256');
      assertSha256Hex(facts.restoreTargetSha256, 'abandoning facts.restoreTargetSha256');
      assertPositiveInt(facts.lastMutationGeneration, 'abandoning facts.lastMutationGeneration');
      assertSha256Hex(facts.topologyRestorationProofSha256, 'abandoning facts.topologyRestorationProofSha256');
      assertSha256Hex(facts.compatibilityManifestSha256, 'abandoning facts.compatibilityManifestSha256');
    }
  },
  abandoned(facts) {
    assertExactFields(facts, ['topologyActivationReceiptSha256', 'abandonmentReceiptSha256'], 'abandoned facts');
    assertSha256Hex(facts.topologyActivationReceiptSha256, 'abandoned facts.topologyActivationReceiptSha256');
    assertSha256Hex(facts.abandonmentReceiptSha256, 'abandoned facts.abandonmentReceiptSha256');
  },
};

function validateGuardEntry(entry) {
  assertPlainObject(entry, 'guardEntry');
  assertNoUnknownFields(entry, GUARD_ENTRY_FIELDS, 'guardEntry');
  for (const required of GUARD_ENTRY_FIELDS) {
    if (!(required in entry)) {
      throw new DeploymentStateError(`guardEntry: missing required field '${required}'`, 'missing-field');
    }
  }
  if (entry.format !== GUARD_ENTRY_FORMAT) {
    throw new DeploymentStateError(`guardEntry.format must be ${GUARD_ENTRY_FORMAT}`, 'shape');
  }
  assertPositiveInt(entry.generation, 'guardEntry.generation');
  if (entry.generation > GUARD_MAX_GENERATION) {
    throw new DeploymentStateError('guardEntry.generation exceeds the zero-padded grammar range', 'shape');
  }
  if (entry.previousGenerationSha256 !== null) {
    assertSha256Hex(entry.previousGenerationSha256, 'guardEntry.previousGenerationSha256');
  }
  validateOperationId(entry.deploymentId, 'guardEntry.deploymentId');
  assertPositiveInt(entry.controllerGeneration, 'guardEntry.controllerGeneration');
  assertString(entry.targetCommitSha, 'guardEntry.targetCommitSha');
  assertSha256Hex(entry.artifactSha256, 'guardEntry.artifactSha256');
  assertSha256Hex(entry.controlManifestSha256, 'guardEntry.controlManifestSha256');
  assertOneOf(entry.detectedProfile, GUARD_PROFILES, 'guardEntry.detectedProfile');
  assertOneOf(entry.expectedProfile, GUARD_PROFILES, 'guardEntry.expectedProfile');
  assertSha256Hex(entry.profileMappingSha256, 'guardEntry.profileMappingSha256');
  assertPositiveInt(entry.bootEpoch, 'guardEntry.bootEpoch');
  assertString(entry.bootId, 'guardEntry.bootId');
  assertOneOf(entry.phase, GUARD_PHASES, 'guardEntry.phase');
  assertPlainObject(entry.facts, 'guardEntry.facts');
  GUARD_FACTS_VALIDATORS[entry.phase](entry.facts, entry);
  assertBoundedString(entry.result, 'guardEntry.result (bounded)', GUARD_RESULT_MAX_LENGTH);
  assertIsoTimestamp(entry.createdAt, 'guardEntry.createdAt');
  return entry;
}

function guardGenerationFileName(generation) {
  assertPositiveInt(generation, 'guard generation');
  if (generation > GUARD_MAX_GENERATION) {
    throw new DeploymentStateError('guard generation exceeds the zero-padded grammar range', 'shape');
  }
  return `${String(generation).padStart(GUARD_GENERATION_DIGITS, '0')}.json`;
}

function parseGuardGenerationFileName(name) {
  const m = /^(\d{8})\.json$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function guardChainDir(root, deploymentId) {
  assertString(root, 'guard root');
  validateOperationId(deploymentId, 'deploymentId');
  if (deploymentId.includes('/') || deploymentId === '.' || deploymentId === '..') {
    throw new DeploymentStateError('deploymentId must not contain path separators', 'shape');
  }
  return path.join(root, deploymentId);
}

// begin's structural scan: every direct child of the held root must be an
// lstat-real directory (never a symlink); anything else fails.
function listGuardChainDirs(root) {
  const rootStat = lstatOrNull(root);
  if (!rootStat) return [];
  if (rootStat.isSymbolicLink()) {
    throw new DeploymentStateError(`guard root must not be a symlink: ${root}`, 'symlink-rejected');
  }
  if (!rootStat.isDirectory()) {
    throw new DeploymentStateError(`guard root must be a directory: ${root}`, 'shape');
  }
  assertOwnedByUs(rootStat, root);
  const out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const childPath = path.join(root, name);
    const stat = fs.lstatSync(childPath);
    if (stat.isSymbolicLink()) {
      throw new DeploymentStateError(`guard root child must not be a symlink: ${childPath}`, 'symlink-rejected');
    }
    if (!stat.isDirectory()) {
      throw new DeploymentStateError(`guard root child must be a real directory: ${childPath}`, 'shape');
    }
    assertOwnedByUs(stat, childPath);
    out.push(name);
  }
  return out;
}

// Reads and fully verifies one chain: strict grammar, symlink/special
// rejection, gap/fork/corrupt detection, per-entry codec validation, phase
// adjacency, epoch rules, cross-entry fact binding, and common-identity
// constancy. Returns { entries: [{generation, path, raw, sha256, entry}],
// head } or null when the chain directory does not exist.
function readGuardChain(root, deploymentId) {
  const dir = guardChainDir(root, deploymentId);
  const dirStat = lstatOrNull(dir);
  if (!dirStat) return null;
  if (dirStat.isSymbolicLink()) {
    throw new DeploymentStateError(`guard chain dir must not be a symlink: ${dir}`, 'symlink-rejected');
  }
  if (!dirStat.isDirectory()) {
    throw new DeploymentStateError(`guard chain dir must be a directory: ${dir}`, 'shape');
  }
  assertOwnedByUs(dirStat, dir);

  const generations = new Map();
  for (const name of fs.readdirSync(dir)) {
    // Crash debris tolerance: a kill between the append's temp-create and
    // its post-link unlink leaves an orphaned temp file. Without this
    // exemption a single crash would wedge the chain forever under the
    // strict grammar (found by the G2 crash tests). Only the exact temp
    // grammar this module's own tmpNameFor() produces is skipped, and only
    // when it is a regular non-symlink file; anything else still fails.
    if (/^\.\d{8}\.json\.tmp-\d+-[0-9a-f]+$/.test(name)) {
      const debrisStat = fs.lstatSync(path.join(dir, name));
      if (debrisStat.isFile() && !debrisStat.isSymbolicLink()) {
        continue;
      }
      throw new DeploymentStateError(
        `guard chain temp-debris name is not a regular file: ${path.join(dir, name)}`,
        'guard-grammar'
      );
    }
    const gen = parseGuardGenerationFileName(name);
    if (gen === null) {
      throw new DeploymentStateError(
        `guard chain entry has invalid zero-padded grammar: ${path.join(dir, name)}`,
        'guard-grammar'
      );
    }
    const p = path.join(dir, name);
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
      throw new DeploymentStateError(`guard generation must not be a symlink: ${p}`, 'symlink-rejected');
    }
    if (!stat.isFile()) {
      throw new DeploymentStateError(`guard generation must be a regular file: ${p}`, 'shape');
    }
    assertOwnedByUs(stat, p);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new DeploymentStateError(`guard generation must be mode 0600: ${p}`, 'wrong-mode');
    }
    generations.set(gen, p);
  }
  if (generations.size === 0) {
    // A chain dir with no durable generation is crash debris, not a chain:
    // appendGuardEntry mkdirs the chain dir before its temp write, so a
    // kill anywhere before link(2) leaves exactly this shape. Treat it as
    // "no chain exists" so begin's retry can create generation 1.
    return null;
  }
  const maxGen = Math.max(...generations.keys());
  const entries = [];
  for (let gen = 1; gen <= maxGen; gen++) {
    const p = generations.get(gen);
    if (!p) {
      throw new DeploymentStateError(`guard chain has a generation gap at ${gen} in ${dir}`, 'guard-chain-gap');
    }
    const raw = fs.readFileSync(p);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (_err) {
      throw new DeploymentStateError(`guard generation is corrupt (invalid JSON): ${p}`, 'guard-chain-corrupt');
    }
    let entry;
    try {
      entry = validateGuardEntry(parsed);
    } catch (err) {
      throw new DeploymentStateError(
        `guard generation ${gen} failed validation: ${err.message}`,
        'guard-chain-corrupt'
      );
    }
    entries.push({ generation: gen, path: p, raw, sha256: sha256Hex(raw), entry });
  }
  verifyGuardEntries(entries, deploymentId);
  return { entries, head: entries[entries.length - 1], dir };
}

// Finds the entries of the epoch containing index `i` (the contiguous run
// from the most recent epoch-start at-or-before i; the initial `intent`
// belongs to epoch 1's run).
function guardEpochEntriesAt(entries, i) {
  let start = 0;
  for (let j = i; j >= 0; j--) {
    if (entries[j].entry.phase === 'epoch-start') {
      start = j;
      break;
    }
  }
  return entries.slice(start, i + 1);
}

function guardFindInEpoch(epochEntries, phase) {
  for (let j = epochEntries.length - 1; j >= 0; j--) {
    if (epochEntries[j].entry.phase === phase) return epochEntries[j];
  }
  return null;
}

function verifyGuardEntries(entries, deploymentId) {
  const first = entries[0].entry;
  if (entries[0].generation !== 1 || first.generation !== 1) {
    throw new DeploymentStateError('guard chain must start at generation 1', 'guard-chain-gap');
  }
  if (first.phase !== 'intent') {
    throw new DeploymentStateError("guard chain generation 1 must be phase 'intent' (the first epoch starts with intent)", 'guard-phase-transition');
  }
  if (first.bootEpoch !== 1) {
    throw new DeploymentStateError('guard chain generation 1 must be bootEpoch 1', 'guard-epoch');
  }
  if (first.previousGenerationSha256 !== null) {
    throw new DeploymentStateError('guard chain generation 1 must have previousGenerationSha256 null', 'guard-chain-fork');
  }
  if (deploymentId !== undefined && first.deploymentId !== deploymentId) {
    throw new DeploymentStateError('guard chain deploymentId does not match its directory', 'guard-identity-mismatch');
  }

  for (let i = 1; i < entries.length; i++) {
    const rec = entries[i];
    const prev = entries[i - 1];
    const entry = rec.entry;
    if (entry.generation !== rec.generation) {
      throw new DeploymentStateError(`guard generation field/filename mismatch at ${rec.path}`, 'guard-chain-corrupt');
    }
    if (entry.previousGenerationSha256 !== prev.sha256) {
      throw new DeploymentStateError(
        `guard chain fork/tamper detected at generation ${rec.generation}: previousGenerationSha256 does not bind the previous generation's bytes`,
        'guard-chain-fork'
      );
    }
    for (const field of GUARD_COMMON_IDENTITY_FIELDS) {
      if (entry[field] !== first[field]) {
        throw new DeploymentStateError(
          `guard chain common identity field '${field}' changed at generation ${rec.generation}`,
          'guard-identity-mismatch'
        );
      }
    }
    const allowed = GUARD_PHASE_TRANSITIONS[prev.entry.phase] || [];
    if (!allowed.includes(entry.phase)) {
      throw new DeploymentStateError(
        `guard chain phase transition '${prev.entry.phase}' -> '${entry.phase}' is not allowed at generation ${rec.generation}`,
        'guard-phase-transition'
      );
    }

    // Epoch/boot rules.
    if (entry.phase === 'epoch-invalidated') {
      if (entry.bootEpoch !== prev.entry.bootEpoch) {
        throw new DeploymentStateError('epoch-invalidated must carry the invalidated (previous) bootEpoch', 'guard-epoch');
      }
      if (entry.bootId === prev.entry.bootId) {
        throw new DeploymentStateError('epoch-invalidated requires a boot change (same boot as head is illegal)', 'guard-epoch');
      }
      if (entry.facts.invalidatedEpoch !== prev.entry.bootEpoch) {
        throw new DeploymentStateError('epoch-invalidated facts.invalidatedEpoch must equal the invalidated epoch', 'guard-fact-binding');
      }
      if (entry.facts.previousBootId !== prev.entry.bootId) {
        throw new DeploymentStateError('epoch-invalidated facts.previousBootId must equal the invalidated boot id', 'guard-fact-binding');
      }
    } else if (entry.phase === 'epoch-start') {
      if (prev.entry.phase === 'intent') {
        if (entry.bootEpoch !== prev.entry.bootEpoch || entry.bootId !== prev.entry.bootId) {
          throw new DeploymentStateError('first epoch-start must share intent\'s bootEpoch/bootId', 'guard-epoch');
        }
      } else {
        // prev is epoch-invalidated
        if (entry.bootEpoch !== prev.entry.bootEpoch + 1) {
          throw new DeploymentStateError('epoch-start after invalidation must use the next higher bootEpoch', 'guard-epoch');
        }
        if (entry.bootId !== prev.entry.bootId) {
          throw new DeploymentStateError('epoch-start after invalidation must be appended in the invalidating boot', 'guard-epoch');
        }
      }
    } else if (entry.phase === 'ready-revalidated') {
      if (entry.bootEpoch !== prev.entry.bootEpoch) {
        throw new DeploymentStateError('ready-revalidated must stay in the same epoch', 'guard-epoch');
      }
      if (entry.bootId === prev.entry.bootId) {
        throw new DeploymentStateError('ready-revalidated requires a boot change (reboot-at-ready)', 'guard-epoch');
      }
    } else if (entry.phase === 'abandoning' || entry.phase === 'abandoned') {
      if (entry.bootEpoch !== prev.entry.bootEpoch) {
        throw new DeploymentStateError(`${entry.phase} must stay in the head's epoch`, 'guard-epoch');
      }
      // bootId unconstrained: abandonment may resume in a later boot.
    } else {
      // Same-epoch normal advance: same epoch, same boot. A bootId change
      // without epoch-invalidated is an invalid chain (a reboot mid-epoch
      // MUST invalidate).
      if (entry.bootEpoch !== prev.entry.bootEpoch) {
        throw new DeploymentStateError(`phase '${entry.phase}' must not change bootEpoch`, 'guard-epoch');
      }
      if (entry.bootId !== prev.entry.bootId) {
        throw new DeploymentStateError(
          `phase '${entry.phase}' appended under a different bootId without epoch invalidation`,
          'guard-epoch'
        );
      }
    }

    // Cross-entry fact binding within the epoch.
    const epochEntries = guardEpochEntriesAt(entries, i);
    if (entry.phase === 'roles-stopping') {
      const epochStart = guardFindInEpoch(epochEntries, 'epoch-start');
      if (!epochStart
          || entry.facts.priorRoleStatesSha256 !== canonicalHash(epochStart.entry.facts.priorRoleStates)) {
        throw new DeploymentStateError('roles-stopping must bind the current epoch-start role authority before any stop side effect', 'guard-fact-binding');
      }
    } else if (entry.phase === 'roles-stopped') {
      const stopping = guardFindInEpoch(epochEntries, 'roles-stopping');
      if (!stopping) {
        throw new DeploymentStateError('roles-stopped requires a durable same-epoch roles-stopping intent', 'guard-fact-binding');
      }
    } else if (entry.phase === 'topology-snapshotted') {
      if (entry.facts.bootId !== entry.bootId) {
        throw new DeploymentStateError('topology-snapshotted facts.bootId must equal the entry bootId (prior-boot snapshot facts cannot advance)', 'guard-fact-binding');
      }
      const rolesStopped = guardFindInEpoch(epochEntries, 'roles-stopped');
      if (!rolesStopped) {
        throw new DeploymentStateError('topology-snapshotted requires a same-epoch roles-stopped entry', 'guard-fact-binding');
      }
      if (canonicalize(entry.facts.stoppedRoleGenerations) !== canonicalize(rolesStopped.entry.facts.stoppedRoleGenerations)) {
        throw new DeploymentStateError('topology-snapshotted facts.stoppedRoleGenerations must match the same-epoch roles-stopped facts', 'guard-fact-binding');
      }
    } else if (entry.phase === 'safety-installed') {
      const installing = guardFindInEpoch(epochEntries, 'safety-installing');
      if (!installing || entry.facts.targetSafetyManifestSha256 !== installing.entry.facts.targetSafetyManifestSha256) {
        throw new DeploymentStateError('safety-installed must bind the same-epoch safety-installing target-safety manifest', 'guard-fact-binding');
      }
    } else if (entry.phase === 'controls-installed') {
      if (entry.facts.controlManifestSha256 !== entry.controlManifestSha256) {
        throw new DeploymentStateError('controls-installed facts.controlManifestSha256 must equal the chain controlManifestSha256', 'guard-fact-binding');
      }
    } else if (entry.phase === 'ready') {
      const quarantined = guardFindInEpoch(epochEntries, 'links-quarantined');
      if (!quarantined || entry.facts.sixLinkTopologySha256 !== quarantined.entry.facts.sixLinkTopologySha256) {
        throw new DeploymentStateError('ready must bind the same-epoch six-link topology hash', 'guard-fact-binding');
      }
      const installing = guardFindInEpoch(epochEntries, 'safety-installing');
      if (!installing || entry.facts.targetSafetyManifestSha256 !== installing.entry.facts.targetSafetyManifestSha256) {
        throw new DeploymentStateError('ready must bind the same-epoch target-safety manifest hash', 'guard-fact-binding');
      }
    } else if (entry.phase === 'ready-revalidated') {
      const ready = guardFindInEpoch(epochEntries, 'ready');
      if (!ready) {
        throw new DeploymentStateError('ready-revalidated requires a same-epoch ready generation', 'guard-fact-binding');
      }
      const installed = guardFindInEpoch(epochEntries, 'safety-installed');
      if (!installed
        || entry.facts.guardAware94Sha256 !== installed.entry.facts.guardAware94Sha256
        || entry.facts.inhibitorSha256 !== installed.entry.facts.inhibitorSha256) {
        throw new DeploymentStateError('ready-revalidated must bind the same-epoch installed guard-aware 94/inhibitor hashes', 'guard-fact-binding');
      }
      if (entry.facts.controlManifestSha256 !== entry.controlManifestSha256) {
        throw new DeploymentStateError('ready-revalidated facts.controlManifestSha256 must equal the chain controlManifestSha256', 'guard-fact-binding');
      }
    }
  }
  return entries;
}

// Appends the next generation with a CAS on the current head. entryDraft
// omits generation/previousGenerationSha256/format - this function binds
// them to the verified head. expectedGeneration 0 creates generation 1 of a
// new chain. Exclusive creation: temp + fdatasync + link(2) + dir fsync;
// link EEXIST is a bounded conflict.
function appendGuardEntry(root, deploymentId, entryDraft, { expectedGeneration, expectedHeadSha256 } = {}) {
  validatePersistentMutationRoot(root);
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new DeploymentStateError('expectedGeneration must be a non-negative integer', 'shape');
  }
  const dir = guardChainDir(root, deploymentId);
  const chain = readGuardChain(root, deploymentId);
  if (chain === null) {
    if (expectedGeneration !== 0) {
      throw new DeploymentStateError('no guard chain exists; expectedGeneration must be 0 for a first append', 'cas-mismatch');
    }
  } else if (chain.head.generation !== expectedGeneration) {
    throw new DeploymentStateError(
      `guard chain head is at generation ${chain.head.generation}, expected ${expectedGeneration}`,
      'cas-mismatch'
    );
  } else if (expectedHeadSha256 !== undefined && chain.head.sha256 !== expectedHeadSha256) {
    throw new DeploymentStateError('guard chain head sha does not match the expected head sha', 'cas-mismatch');
  }

  const nextGeneration = expectedGeneration + 1;
  const entry = {
    format: GUARD_ENTRY_FORMAT,
    generation: nextGeneration,
    previousGenerationSha256: chain ? chain.head.sha256 : null,
    ...entryDraft,
  };
  // Full-chain validation of the candidate (codec + adjacency + epoch +
  // fact binding + identity constancy), before anything touches disk.
  const raw = Buffer.from(JSON.stringify(entry, null, 2));
  const candidate = {
    generation: nextGeneration,
    path: path.join(dir, guardGenerationFileName(nextGeneration)),
    raw,
    sha256: sha256Hex(raw),
    entry: validateGuardEntry(entry),
  };
  verifyGuardEntries([...(chain ? chain.entries : []), candidate], deploymentId);

  const crashPrefix = `guard-append:${entry.phase}`;
  ensureDir0700(root);
  const chainDirWasAbsent = lstatOrNull(dir) === null;
  ensureDir0700(dir);
  if (chainDirWasAbsent) {
    maybeCrash(`${crashPrefix}:after-chain-dir-mkdir`);
  }
  // Generation 1 is not eligible for publication until both new directory
  // entries are durable: first the guard root in its parent, then the chain
  // directory in the guard root. A retry from the crash seam above sees an
  // empty chain and repeats both fsyncs before publication.
  if (chain === null) {
    fsyncDir(path.dirname(root));
    fsyncDir(root);
  }
  const tmp = tmpNameFor(candidate.path);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, raw);
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  maybeCrash(`${crashPrefix}:after-tmp-fdatasync`);
  let linked = false;
  try {
    fs.linkSync(tmp, candidate.path);
    linked = true;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      try { fs.unlinkSync(tmp); } catch (_e) { /* best effort */ }
      throw err;
    }
  }
  if (!linked) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* best effort */ }
    throw new DeploymentStateError(
      `guard generation ${nextGeneration} already exists (concurrent append)`,
      'guard-generation-conflict'
    );
  }
  maybeCrash(`${crashPrefix}:after-link`);
  fs.unlinkSync(tmp);
  fsyncDir(dir);
  maybeCrash(`${crashPrefix}:after-dir-fsync`);
  return candidate;
}

// Verifies every topology manifest referenced by the chain: each
// topology-snapshotted entry's bound path must exist as a regular
// non-symlink file whose raw bytes hash to the bound sha.
function verifyGuardManifests(chain) {
  for (const rec of chain.entries) {
    if (rec.entry.phase !== 'topology-snapshotted') continue;
    const p = rec.entry.facts.topologyManifestPath;
    const stat = lstatOrNull(p);
    if (!stat) {
      throw new DeploymentStateError(`referenced topology manifest is missing: ${p}`, 'manifest-missing');
    }
    if (stat.isSymbolicLink()) {
      throw new DeploymentStateError(`referenced topology manifest must not be a symlink: ${p}`, 'symlink-rejected');
    }
    if (!stat.isFile()) {
      throw new DeploymentStateError(`referenced topology manifest must be a regular file: ${p}`, 'shape');
    }
    const actual = sha256Hex(fs.readFileSync(p));
    if (actual !== rec.entry.facts.topologyManifestSha256) {
      throw new DeploymentStateError(
        `referenced topology manifest does not match its bound hash (generation ${rec.generation}): ${p}`,
        'manifest-mismatch'
      );
    }
  }
  return true;
}

module.exports = {
  FORMAT,
  ORDINARY_PARENT_PHASES,
  FACTORY_ONLY_PARENT_PHASE,
  FACTORY_BASELINE_PARENT_PHASES,
  FACTORY_BASELINE_PREFIXES,
  FACTORY_BASELINE_PARENT_FIELDS,
  TERMINAL_PARENT_PHASES,
  RECEIPT_KINDS,
  SUB_OPERATION_KINDS,
  IMPLEMENTED_SUB_OPERATION_KINDS,
  PROBE_PERMIT_PURPOSES,
  DATABASE_LINEAGE_STATUSES,
  RESTORED_PREDECESSOR_KINDS,
  PROBE_PERMIT_SERVICES,
  STARTUP_CHECK_SERVICES,
  COMPATIBILITY_TOPOLOGY_PATHS,
  TARGET_SAFETY_PATHS,
  SIX_APPLICATION_LINKS,
  DeploymentStateError,
  maybeCrash,
  canonicalize,
  sha256Hex,
  canonicalHash,
  assertPlainObject,
  assertNoUnknownFields,
  assertExactFields,
  assertString,
  validateOperationId,
  assertSha256Hex,
  assertBoolean,
  assertPositiveInt,
  assertOneOf,
  assertIsoTimestamp,
  validateRestoredPredecessor,
  restoredPredecessorSha256,
  terminalTupleSha256,
  validateDatabaseLineage,
  validateTerminalReceiptIdentity,
  validateProbePermit,
  validateLockOwnerHandoff,
  validatePreviousTerminal,
  validateParentDeployment,
  validateActiveSubOperation,
  validateFactoryZeroAuthority,
  validateFactoryBaselineEnvelope,
  validateEnvelope,
  RECOVERY_LINKABLE_PARENT_PHASES,
  RECOVERY_SUB_OPERATION_PHASES,
  lstatOrNull,
  assertOwnedByUs,
  assertRegularFileMode0600,
  assertNotSymlink,
  fsyncFileDescriptor,
  fsyncPath,
  fsyncDir,
  ensureDir0700,
  publishImmutableBytes,
  writeJsonAtomic,
  writeJsonExclusive,
  readJsonFile,
  readState,
  writeState,
  writeStateExclusive,
  mutationLockPath,
  acquireMutationLock,
  releaseMutationLock,
  withStateMutation,
  classifyDeploymentAuthorityPath,
  validateAttemptLockPath,
  parseMountInfo,
  validatePersistentMountProfile,
  validatePersistentMutationRoot,
  validatePersistentAuthorityDirectory,
  validatePermitNoncePath,
  receiptPath,
  TOPOLOGY_ACTIVATION_AUTHORITY_KINDS,
  rootedTopologyPath,
  collectTopologyPathSet,
  topologyUciIdentitySha256,
  liveTopologyIdentity,
  validateTargetSafetyManifestPath,
  readAndVerifyTargetSafetyManifest,
  validateTopologyRestorationProof,
  readTopologyRestorationProof,
  writeReceipt,
  readReceipt,
  attemptTombstonePath,
  validateAttemptTombstone,
  writeAttemptTombstone,
  readAttemptTombstone,
  readBootId,
  getBootId,
  lockOwnerPath,
  validateLockOwner,
  readLockOwner,
  writeLockOwner,
  isOwnerLive,
  acquireLock,
  createLockReleaseIntent,
  releaseLock,
  // Guard-bootstrap chain
  GUARD_ENTRY_FORMAT,
  GUARD_ABSENT_SHA256,
  GUARD_FIRST_EPOCH_PHASES,
  GUARD_PHASES,
  GUARD_PRE_READY_PHASES,
  GUARD_MUTATION_PHASES,
  GUARD_TERMINAL_PHASES,
  GUARD_PROFILES,
  GUARD_ROLES,
  GUARD_PHASE_TRANSITIONS,
  GUARD_COMMON_IDENTITY_FIELDS,
  validateGuardEntry,
  guardGenerationFileName,
  parseGuardGenerationFileName,
  guardChainDir,
  listGuardChainDirs,
  readGuardChain,
  verifyGuardEntries,
  appendGuardEntry,
  verifyGuardManifests,
};
