'use strict';
// osi-sync-protocol-state/deployment-state-gate.js — the minimal
// deployment-state read/validation this slice's `initialize` CLI verb
// needs to enforce "exact parent phase protocol-initializing" (stop-loss
// plan line 329: "The deployment coordinator runs initialize with writers
// stopped, exact parent phase protocol-initializing, and a fsynced
// operation before the first Node-RED start.").
//
// Envelope shape: the REAL deployment-state envelope, specified at
// 2026-07-15-refactor-repair-program.md line 160 and implemented by the
// sibling deployment-state slice, is exactly
//   `{format:2, parentDeployment, activeSubOperation}`
// with the deployment identity, phase, and generation nested under
// `parentDeployment`, and `activeSubOperation` either null or exactly one
// recovery|selection-rehearsal|staging-gc record. This gate validates that
// real shape strictly at the TOP level (exactly those three keys, format
// exactly 2, unknown top-level fields rejected) and validates the specific
// `parentDeployment` fields it gates on (deploymentId, phase, generation)
// while TOLERATING the sibling library's other parentDeployment fields
// (lease, hashes, stamps, receipt hashes, probe permit, databaseLineage,
// previous-terminal identity, ...) — that full closed field set is owned
// by `scripts/lib/deployment-state.js`, and re-declaring it here would
// make this gate reject every legitimate envelope the moment the sibling
// library evolves a field. For `initialize`, `activeSubOperation` must be
// exactly null: protocol initialization may never run while a recovery,
// rehearsal, or staging-GC sub-operation is in flight.
//
// This remains a standalone strict reader by design: it does NOT import
// the deployment-state library (that wiring is integration work for the
// slice that registers this helper on the shipping surfaces). An earlier
// revision of this file parsed an invented flat `{format:1, deploymentId,
// phase, parentGeneration}` shape; that was wrong and was replaced with
// the real format-2 envelope during the review fix wave.

const fs = require('node:fs');
const { codecError, validateClosedObject } = require('./codecs');
const { assertNoSymlinkComponents } = require('./paths');

function gateError(code, message, extra) {
  return codecError(code, message, extra);
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Top level is closed: exactly these three keys, no more, no fewer.
const DEPLOYMENT_STATE_TOP_FIELDS = {
  format: { check: (v) => v === 2 },
  parentDeployment: { check: isPlainObject },
  activeSubOperation: { check: (v) => v === null || isPlainObject(v) },
};

// The parentDeployment fields this gate actually checks. Other fields are
// deliberately tolerated (see header note); these three must be present
// and well-formed or the envelope is unusable for gating.
function validateParentDeploymentGatedFields(parentDeployment) {
  if (!isNonEmptyString(parentDeployment.deploymentId)) {
    throw gateError('deployment_state_parent_invalid', 'parentDeployment.deploymentId must be a non-empty string', { field: 'deploymentId' });
  }
  if (!isNonEmptyString(parentDeployment.phase)) {
    throw gateError('deployment_state_parent_invalid', 'parentDeployment.phase must be a non-empty string', { field: 'phase' });
  }
  if (!isNonNegInt(parentDeployment.generation)) {
    throw gateError('deployment_state_parent_invalid', 'parentDeployment.generation must be a non-negative safe integer', { field: 'generation' });
  }
  return parentDeployment;
}

function readDeploymentStateFile(deploymentStatePath) {
  assertNoSymlinkComponents(deploymentStatePath);
  let stat;
  try {
    stat = fs.lstatSync(deploymentStatePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw gateError('deployment_state_missing', `deployment-state file does not exist: ${deploymentStatePath}`, { path: deploymentStatePath });
    }
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw gateError('deployment_state_unsafe_file', 'deployment-state must be a regular nonsymlink mode-0600 file', {
      path: deploymentStatePath,
    });
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw gateError('deployment_state_wrong_owner', 'deployment-state is not owned by the invoking service identity', {
      path: deploymentStatePath,
    });
  }
  let raw;
  try {
    raw = fs.readFileSync(deploymentStatePath, 'utf8');
  } catch (err) {
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    throw gateError('deployment_state_malformed', `deployment-state file is not valid JSON: ${deploymentStatePath}`, { path: deploymentStatePath });
  }
  validateClosedObject(parsed, DEPLOYMENT_STATE_TOP_FIELDS, 'deployment-state envelope');
  validateParentDeploymentGatedFields(parsed.parentDeployment);
  return parsed;
}

// requireDeploymentPhase: reads+validates the envelope and requires the
// parent deployment to exactly match the expected deployment ID / phase /
// generation, with no sub-operation in flight.
function requireDeploymentPhase(deploymentStatePath, { expectedDeploymentId, expectedPhase, expectedParentGeneration }) {
  const state = readDeploymentStateFile(deploymentStatePath);
  const parent = state.parentDeployment;
  if (parent.deploymentId !== expectedDeploymentId) {
    throw gateError('deployment_state_wrong_deployment_id', 'parentDeployment.deploymentId does not match --expected-deployment-id', {
      actual: parent.deploymentId,
      expected: expectedDeploymentId,
    });
  }
  if (parent.phase !== expectedPhase) {
    throw gateError('deployment_state_wrong_phase', `parentDeployment.phase "${parent.phase}" !== required "${expectedPhase}"`, {
      actual: parent.phase,
      expected: expectedPhase,
    });
  }
  if (parent.generation !== expectedParentGeneration) {
    throw gateError('deployment_state_wrong_parent_generation', 'parentDeployment.generation does not match --expected-parent-generation', {
      actual: parent.generation,
      expected: expectedParentGeneration,
    });
  }
  if (state.activeSubOperation !== null) {
    throw gateError('deployment_state_active_sub_operation', 'protocol initialization requires activeSubOperation to be null; a sub-operation is in flight', {
      activeSubOperationKind: state.activeSubOperation && state.activeSubOperation.kind,
    });
  }
  return state;
}

// Recovery protocol verbs run while the parent deployment is pinned. Their
// authority is the exact recovery sub-operation, not a caller-provided
// Boolean. The sibling deployment-state codec owns the full closed recovery
// union; this gate checks only the fields consumed here and rejects any
// mismatch before protocol roots are opened.
function requireRecoveryPhase(deploymentStatePath, {
  expectedDeploymentId,
  expectedParentGeneration,
  recoveryOperationId,
  expectedRecoveryPhase,
  requestId,
}) {
  const state = readDeploymentStateFile(deploymentStatePath);
  const parent = state.parentDeployment;
  const recovery = state.activeSubOperation;
  if (parent.deploymentId !== expectedDeploymentId) {
    throw gateError('deployment_state_wrong_deployment_id', 'parentDeployment.deploymentId does not match the expected deployment', {
      actual: parent.deploymentId,
      expected: expectedDeploymentId,
    });
  }
  if (parent.generation !== expectedParentGeneration) {
    throw gateError('deployment_state_wrong_parent_generation', 'parentDeployment.generation does not match the expected parent generation', {
      actual: parent.generation,
      expected: expectedParentGeneration,
    });
  }
  if (!recovery || recovery.kind !== 'recovery') {
    throw gateError('deployment_state_recovery_missing', 'the required recovery sub-operation is not active');
  }
  if (recovery.operationId !== recoveryOperationId) {
    throw gateError('deployment_state_wrong_recovery_operation', 'active recovery operation does not match', {
      actual: recovery.operationId,
      expected: recoveryOperationId,
    });
  }
  if (recovery.phase !== expectedRecoveryPhase) {
    throw gateError('deployment_state_wrong_recovery_phase', `active recovery phase "${recovery.phase}" !== required "${expectedRecoveryPhase}"`, {
      actual: recovery.phase,
      expected: expectedRecoveryPhase,
    });
  }
  if (requestId != null && recovery.requestId !== requestId) {
    throw gateError('deployment_state_wrong_recovery_request', 'active recovery request does not match', {
      actual: recovery.requestId,
      expected: requestId,
    });
  }
  return state;
}

function requireFactoryBaselinePhase(deploymentStatePath, {
  expectedBaselineId,
  expectedPhase,
  expectedBaselinePrefix,
  expectedParentGeneration,
  operationId,
}) {
  const state = readDeploymentStateFile(deploymentStatePath);
  const parent = state.parentDeployment;
  if (parent.phase !== expectedPhase) {
    throw gateError('deployment_state_wrong_phase', `parentDeployment.phase "${parent.phase}" !== required "${expectedPhase}"`);
  }
  if (parent.generation !== expectedParentGeneration) {
    throw gateError('deployment_state_wrong_parent_generation', 'parentDeployment.generation does not match --expected-parent-generation');
  }
  if (parent.deploymentId !== expectedBaselineId && parent.baselineId !== expectedBaselineId) {
    throw gateError('deployment_state_wrong_baseline_id', 'factory baseline identity does not match --expected-baseline-id');
  }
  const prefix = parent.baselinePrefix || parent.operationPrefix || parent.prefix;
  if (prefix !== expectedBaselinePrefix) {
    throw gateError('deployment_state_wrong_baseline_prefix', 'factory baseline prefix does not match --expected-baseline-prefix');
  }
  if (parent.operationId != null && parent.operationId !== operationId) {
    throw gateError('deployment_state_wrong_factory_operation', 'factory baseline operation does not match --operation-id');
  }
  if (state.activeSubOperation !== null) {
    throw gateError('deployment_state_active_sub_operation', 'factory baseline initialization forbids an active sub-operation');
  }
  return state;
}

module.exports = {
  gateError,
  DEPLOYMENT_STATE_TOP_FIELDS,
  readDeploymentStateFile,
  requireDeploymentPhase,
  requireRecoveryPhase,
  requireFactoryBaselinePhase,
};
