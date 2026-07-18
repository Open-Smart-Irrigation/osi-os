'use strict';
// osi-sync-protocol-state/index.js — public sync protocol state surface.
//
// Source of truth: docs/superpowers/plans/2026-07-15-sync-delivery-stop-loss.md,
// Task 3 Step 0, the region from "Persist negotiation through
// osi-sync-protocol-state" through "...the plan states this limit rather
// than claiming tamper resistance". See the brief at
// /tmp/.../scratchpad/briefs/protocol-state-core-brief.md for exact scope.
//
// The module owns four-root initialization/load verification, the closed
// generation/witness codecs, normalized identity helpers, witnessed command
// activity, and the deployment-only capability transition verbs. Runtime
// consumers receive no raw capability append primitive.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const codecs = require('./codecs');
const paths = require('./paths');
const activityDb = require('./activity-db');
const activityAppend = require('./activity-append');
const locks = require('./locks');
const initModule = require('./init');
const loadModule = require('./load');
const witnessed = require('./witnessed');
const deploymentStateGate = require('./deployment-state-gate');

// initialize(options): the deployment-only four-root initialization entry
// point. Deployment-state gating (exact `protocol-initializing` phase) is
// the CLI layer's job (it owns --deployment-state/--expected-* flags); this
// function accepts an already-read/validated deployment state object via
// options.deploymentState purely as a provenance echo, and focuses on the
// mechanical resume-or-create decision:
//   - all four roots absent -> initializeFourRoots (fresh GENESIS)
//   - GENESIS-adjacent resumable gap -> complete it deterministically
//   - already fully initialized -> idempotent success, no writes
//   - anything else -> throws (partial/corrupt root set)
// loadProtocolStateTolerant: like loadProtocolState, but treats
// "capability root started, activity root not yet started" (and its
// mirror) as an expected, verifiable mid-flight state of this module's OWN
// write ordering (capability fully precedes activity in
// createFourRootsUnlocked) rather than a hard corruption. Everything else
// still throws.
function loadProtocolStateTolerant(opts, ownershipAdapter, repair) {
  try {
    return loadModule.loadProtocolState(Object.assign({}, opts, { ownershipAdapter, repair }));
  } catch (err) {
    if (err.code === 'protocol_state_partial_root_set') {
      return { initialized: false, midFlight: true };
    }
    throw err;
  }
}

// existingGenesisOperationId: cheap, lock-safe peek at whatever operationId
// a partial root set already carries, used only to decide whether a stale
// lock's named operation matches the caller's requested operationId. Never
// throws; returns null on anything unreadable (the real gate is
// verifyChain, which runs first and is allowed to throw).
function existingGenesisOperationId(roots) {
  const genPath = path.join(roots.generationsDir, '0000000000000000.json');
  try {
    if (fs.existsSync(genPath)) {
      const parsed = JSON.parse(fs.readFileSync(genPath, 'utf8'));
      if (parsed && parsed.operationId) return parsed.operationId;
    }
  } catch (_err) {
    /* unreadable: fall through */
  }
  return null;
}

function findProposalForOperation(opts, roots, ownershipAdapter, operationId) {
  const loaded = loadProtocolStateTolerant(opts, ownershipAdapter, false);
  if (loaded.midFlight) {
    const existingOpId = existingGenesisOperationId(roots);
    return existingOpId === operationId ? { operationId: existingOpId } : null;
  }
  if (!loaded.initialized) return null;
  if (loaded.capability && loaded.capability.resumable && loaded.capability.generations && loaded.capability.generations.length > 0) {
    const top = loaded.capability.generations[loaded.capability.generations.length - 1];
    if (top.generation.operationId === operationId) return top;
  }
  if (loaded.activity && loaded.activity.resumable && loaded.activity.genesisRow && loaded.activity.genesisRow.operation_id === operationId) {
    return loaded.activity.genesisRow;
  }
  return null;
}

function initialize(options) {
  const opts = options || {};
  const roots = paths.resolveRoots(opts);
  const ownershipAdapter = opts.ownershipAdapter || paths.defaultOwnershipAdapter;
  const operationId = opts.operationId || crypto.randomUUID();

  // One lock spans both the repair-or-create decision and whichever branch
  // it takes, so a resumable-gap repair is never performed lock-free.
  // A stale lock (prior boot, or same-boot with a now-dead PID) is
  // reconciled per line 353: verify the chain first, then permit only
  // deterministic completion of the recorded proposal, or a fresh
  // operation when no proposal names the stale operation.
  paths.ensureFourRootDirsForLocking(roots, ownershipAdapter);
  const lock = locks.acquireFourRootLocks(
    roots,
    { operationId, sourceKind: 'initialize', sourceAuthority: opts.sourceKind || 'deployment', headIdentities: {}, typedReceiptSha256: null },
    {
      bootId: opts.bootId,
      ownershipAdapter,
      isProcessAlive: opts.isProcessAlive,
      reconcile: {
        verifyChain: () => loadProtocolStateTolerant(opts, ownershipAdapter, false),
        findProposalForOperation: (staleOperationId) => findProposalForOperation(opts, roots, ownershipAdapter, staleOperationId),
      },
    }
  );
  try {
    const loaded = loadProtocolStateTolerant(opts, ownershipAdapter, true);
    if (loaded.midFlight || !loaded.initialized) {
      const created = initModule.createFourRootsUnlocked(Object.assign({}, opts, { operationId, resume: Boolean(loaded.midFlight) }));
      return {
        created: true,
        resumed: Boolean(loaded.midFlight),
        capabilityHead: created.capabilityHead,
        activityHead: created.activityHead,
        operationId: created.operationId,
      };
    }
    return {
      created: false,
      // loadProtocolStateTolerant already performed the repair (if any)
      // before returning here, so loaded.capability/activity.resumable is
      // only still truthy for a non-GENESIS validate-and-block gap;
      // loaded.repaired reports whether THIS call actually completed a
      // GENESIS-adjacent or activity one-ahead resume.
      resumed: Boolean(loaded.repaired),
      capabilityHead: loaded.capability.head,
      activityHead: loaded.activity.externalHead,
    };
  } finally {
    lock.release();
  }
}

// Default (fail-closed) witnessed-operation runner for the bare
// runWitnessedOperation module surface: production roots, EMPTY closed
// registry. Lazily constructed so merely loading the module never touches
// /data; the registry check inside runWitnessedOperation fires before any
// root access, so with no registered adapters no filesystem path is ever
// reached through this surface.
let _defaultWitnessedRunner = null;
function defaultWitnessedRunner() {
  if (!_defaultWitnessedRunner) {
    _defaultWitnessedRunner = witnessed.createWitnessedOperationRunner({
      registry: witnessed.createAdapterRegistry([]),
    });
  }
  return _defaultWitnessedRunner;
}

// status(options): read-only. Never writes to any root.
function status(options) {
  const opts = options || {};
  const ownershipAdapter = opts.ownershipAdapter || paths.defaultOwnershipAdapter;
  const loaded = loadProtocolStateTolerant(opts, ownershipAdapter, false);
  if (loaded.midFlight) {
    return { initialized: false, midFlight: true };
  }
  if (!loaded.initialized) {
    return { initialized: false };
  }
  return {
    initialized: true,
    resumePending: loaded.resumePending,
    capabilityGeneration: loaded.capability.head ? loaded.capability.head.generation : (loaded.capability.maxGeneration || 0),
    capabilityHeadSha256: loaded.capability.head ? loaded.capability.head.generationSha256 : null,
    activeIdentitySha256:
      loaded.capability.generations && loaded.capability.generations.length > 0
        ? loaded.capability.generations[loaded.capability.generations.length - 1].generation.state.activeIdentitySha256
        : null,
    mode:
      loaded.capability.generations && loaded.capability.generations.length > 0
        ? loaded.capability.generations[loaded.capability.generations.length - 1].generation.state.mode
        : null,
    activityGeneration: loaded.activity.headRow ? loaded.activity.headRow.generation : null,
  };
}

module.exports = {
  // codecs
  canonicalJson: codecs.canonicalJson,
  sha256Hex: codecs.sha256Hex,
  canonicalSha256: codecs.canonicalSha256,
  ALL_KINDS: codecs.ALL_KINDS,
  NON_GENESIS_KINDS: codecs.NON_GENESIS_KINDS,
  buildGenesisGeneration: codecs.buildGenesisGeneration,
  validateGenesisGeneration: codecs.validateGenesisGeneration,
  buildGenesisWitness: codecs.buildGenesisWitness,
  validateGenesisWitness: codecs.validateGenesisWitness,
  buildCapabilityHead: codecs.buildCapabilityHead,
  validateCapabilityHead: codecs.validateCapabilityHead,
  validateWitness: codecs.validateWitness,
  validateGeneration: codecs.validateGeneration,
  normalizedServerBase: codecs.normalizedServerBase,
  identitySha256: codecs.identitySha256,

  // paths
  resolveRoots: paths.resolveRoots,
  defaultOwnershipAdapter: paths.defaultOwnershipAdapter,

  // activity db
  recoverHotJournalIfPresent: activityDb.recoverHotJournalIfPresent,
  defaultRecoveryOnlyAdapter: activityDb.defaultRecoveryOnlyAdapter,
  // Factory anchor codec (plan line 333) — consumed by the future
  // initialize-factory-zero verb; pinned in this slice so the formula is
  // inherited, not re-derived.
  computeFactoryCommandActivityAnchorSha256: activityDb.computeFactoryCommandActivityAnchorSha256,

  // locks
  acquireFourRootLocks: locks.acquireFourRootLocks,
  defaultBootId: locks.defaultBootId,
  defaultIsProcessAlive: locks.defaultIsProcessAlive,

  // init / load
  initializeFourRoots: initModule.initializeFourRoots,
  INIT_STEPS: initModule.STEPS,
  loadProtocolState: loadModule.loadProtocolState,
  verifyCapabilityChain: loadModule.verifyCapabilityChain,
  verifyActivityRoots: loadModule.verifyActivityRoots,

  // deployment-state gate
  readDeploymentStateFile: deploymentStateGate.readDeploymentStateFile,
  requireDeploymentPhase: deploymentStateGate.requireDeploymentPhase,
  requireRecoveryPhase: deploymentStateGate.requireRecoveryPhase,
  requireFactoryBaselinePhase: deploymentStateGate.requireFactoryBaselinePhase,

  // witnessed operations (plan line 335) — machinery for the future
  // osi-command-ledger slice. The bare runWitnessedOperation surface below
  // carries an EMPTY closed registry, so every call fails closed
  // (witnessed_adapter_not_registered) until that slice constructs a
  // runner with the real production adapters via
  // createWitnessedOperationRunner.
  ACTIVITY_KINDS: activityAppend.ACTIVITY_KINDS,
  localPrincipalSha256: activityAppend.localPrincipalSha256,
  cloudPrincipalSha256: activityAppend.cloudPrincipalSha256,
  createAdapterRegistry: witnessed.createAdapterRegistry,
  createWitnessedOperationRunner: witnessed.createWitnessedOperationRunner,
  runWitnessedOperation(db, descriptor, args) {
    return defaultWitnessedRunner().runWitnessedOperation(db, descriptor, args);
  },

  // Runtime-visible read/initialization surface. Deployment-only capability
  // mutations live in capability-transitions.js and are imported directly by
  // the root-owned CLI; they are deliberately absent here and from osi-lib.
  initialize,
  status,

  // Internals exposed only for scripts/sync-protocol-capability-cli.js
  // (path-flag symlink guarding). Not part of the documented module API;
  // do not add flows.json/osi-lib consumers of this surface.
  __internal: {
    assertNoSymlinkComponents: paths.assertNoSymlinkComponents,
  },
};
