'use strict';
// osi-sync-protocol-state/deployment-state-gate.js — the minimal
// deployment-state read/validation this slice's `initialize` CLI verb
// needs to enforce "exact parent phase protocol-initializing" (plan line
// 329: "The deployment coordinator runs initialize with writers stopped,
// exact parent phase protocol-initializing, and a fsynced operation before
// the first Node-RED start.").
//
// SCOPE NOTE (execution report flags this as a resolved plan-text
// ambiguity, not a design choice made freely): `scripts/lib/deployment-
// state.js` is the plan's real, shared deployment-lease/phase/receipt
// library (2026-07-15-sync-delivery-stop-loss.md line 280 and
// 2026-07-15-refactor-boundary-hardening.md line 86-87), but it does not
// exist yet in this worktree/branch — it belongs to a different task's
// slice. The authoritative plan region for THIS brief (lines 322-353) also
// never gives a literal field-by-field JSON envelope for
// `/data/osi-deploy/deployment-state.json` the way it does for the
// capability generation/witness/head schemas; it only shows the CLI's
// `--expected-deployment-id/--expected-phase/--expected-parent-generation`
// flags (line 379-390) that a caller compares the file against. Per this
// slice's brief: "implement the read/validation against an injectable
// deployment-state.json... do NOT import the deployment-state library,
// parse the documented envelope shape." The envelope below
// (`{format, deploymentId, phase, parentGeneration}`) is this file's own
// minimal, closed reading of that CLI contract — sufficient to gate
// `initialize`, and nothing more. A later slice that lands the real
// `scripts/lib/deployment-state.js` owns reconciling/replacing this
// reader; it must not be assumed frozen.

const fs = require('node:fs');
const { codecError, validateClosedObject } = require('./codecs');
const { assertNoSymlinkComponents } = require('./paths');

function gateError(code, message, extra) {
  return codecError(code, message, extra);
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

const DEPLOYMENT_STATE_FIELDS = {
  format: { check: (v) => v === 1 },
  deploymentId: { check: isNonEmptyString },
  phase: { check: isNonEmptyString },
  parentGeneration: { check: isNonNegInt },
};

function readDeploymentStateFile(deploymentStatePath) {
  assertNoSymlinkComponents(deploymentStatePath);
  let raw;
  try {
    raw = fs.readFileSync(deploymentStatePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw gateError('deployment_state_missing', `deployment-state file does not exist: ${deploymentStatePath}`, { path: deploymentStatePath });
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    throw gateError('deployment_state_malformed', `deployment-state file is not valid JSON: ${deploymentStatePath}`, { path: deploymentStatePath });
  }
  return validateClosedObject(parsed, DEPLOYMENT_STATE_FIELDS, 'deployment-state envelope');
}

// requireDeploymentPhase: reads+validates the envelope and requires it to
// exactly match the expected deployment ID / phase / parent generation.
function requireDeploymentPhase(deploymentStatePath, { expectedDeploymentId, expectedPhase, expectedParentGeneration }) {
  const state = readDeploymentStateFile(deploymentStatePath);
  if (state.deploymentId !== expectedDeploymentId) {
    throw gateError('deployment_state_wrong_deployment_id', 'deployment-state deploymentId does not match --expected-deployment-id', {
      actual: state.deploymentId,
      expected: expectedDeploymentId,
    });
  }
  if (state.phase !== expectedPhase) {
    throw gateError('deployment_state_wrong_phase', `deployment-state phase "${state.phase}" !== required "${expectedPhase}"`, {
      actual: state.phase,
      expected: expectedPhase,
    });
  }
  if (state.parentGeneration !== expectedParentGeneration) {
    throw gateError('deployment_state_wrong_parent_generation', 'deployment-state parentGeneration does not match --expected-parent-generation', {
      actual: state.parentGeneration,
      expected: expectedParentGeneration,
    });
  }
  return state;
}

module.exports = {
  gateError,
  DEPLOYMENT_STATE_FIELDS,
  readDeploymentStateFile,
  requireDeploymentPhase,
};
