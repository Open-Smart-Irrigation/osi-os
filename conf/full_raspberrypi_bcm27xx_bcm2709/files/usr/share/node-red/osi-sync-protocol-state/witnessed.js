'use strict';
// osi-sync-protocol-state/witnessed.js — runWitnessedOperation, the closed
// adapter registry, and the process-private one-use capability.
//
// Plan facts encoded here (verbatim-binding, 2026-07-15-sync-delivery-stop-
// loss.md line 335): "osi-command-ledger exposes only
// runWitnessedOperation(db, {adapterId,kind,principal,commandKeySha256,
// activitySha256}, args). A closed registry maps each adapterId to exactly
// one SQLite transaction, external-effect attempt, or ACK-transport
// mutation adapter. The wrapper canonicalizes the protected descriptor,
// appends the activity intent, then creates a process-private
// nonserializable one-use capability containing the operation ID, adapter
// ID, activity hash, and generation. Only the registered adapter can
// consume it, and it must consume it exactly once before its first
// mutation/effect. Wrong adapter/hash/operation, cached capability, double
// use, nested operation, caller callback substitution,
// append-only-without-adapter-completion, or adapter completion without
// consumption fails. Append-without-work leaves conservative activity
// evidence but returns failure and grants no second attempt from the same
// operation ID."
//
// This slice implements the machinery inside osi-sync-protocol-state,
// exposed for the FUTURE osi-command-ledger slice to consume (per the
// witnessed-operations brief); no shipped flow or ledger code calls it yet,
// and the module-level default runner in index.js carries an EMPTY closed
// registry so every call fails closed until that slice registers the real
// adapters.
//
// Failure-surface convention (documented design decision): failures that
// occur BEFORE the activity intent is appended (bad descriptor, unknown
// adapter, kind mismatch, callback substitution, capability-state gate,
// nested operation, operation-ID replay) THROW — nothing was recorded, the
// caller must treat the operation as never having started. Failures AFTER
// the durable append (adapter threw, adapter completed without consuming)
// RETURN { ok:false, failure, ... } — the conservative activity evidence
// stands and the plan requires "returns failure" rather than an exception
// that might look retryable. Either way the same operation ID gets no
// second attempt.
//
// Capability privacy: validity lives in a module-private WeakSet plus the
// process-private in-flight context below — never in the capability's own
// enumerable data. A structured copy, JSON round-trip, or cross-process
// reconstruction of the fields is therefore never consumable
// ("nonserializable"), and consumption outside the exact in-flight
// operation that minted the capability always fails.

const crypto = require('node:crypto');
const {
  codecError,
  canonicalJson,
  isSha256Hex,
  validateClosedObject,
} = require('./codecs');
const {
  resolveRoots,
  defaultOwnershipAdapter,
} = require('./paths');
const { acquireActivityRootLocks } = require('./locks');
const {
  ACTIVITY_KINDS,
  isAdapterId,
  localPrincipalSha256,
  cloudPrincipalSha256,
  appendActivityWithExternalHead,
  reconcileExternalActivityHead,
} = require('./activity-append');
const { verifyCapabilityChain } = require('./load');

function witnessedError(code, message, extra) {
  return codecError(code, message, extra);
}

// ---------------------------------------------------------------------------
// Closed adapter registry
// ---------------------------------------------------------------------------

// createAdapterRegistry(definitions): builds the closed registry mapping
// each adapterId to exactly one adapter { adapterId, kind, run }. The
// result is frozen: nothing can be registered, replaced, or removed after
// construction, so "closed" is structural, not conventional.
function createAdapterRegistry(definitions) {
  if (!Array.isArray(definitions)) {
    throw witnessedError('witnessed_registry_invalid', 'adapter registry definitions must be an array');
  }
  const byId = new Map();
  for (const def of definitions) {
    if (!def || typeof def !== 'object') {
      throw witnessedError('witnessed_registry_invalid', 'adapter definition must be an object');
    }
    if (!isAdapterId(def.adapterId)) {
      throw witnessedError('witnessed_registry_invalid_adapter_id', 'adapter definition requires a valid adapterId');
    }
    if (!ACTIVITY_KINDS.includes(def.kind)) {
      throw witnessedError(
        'witnessed_registry_invalid_kind',
        `adapter kind must be one of ${ACTIVITY_KINDS.join('|')} (SQLite transaction, external-effect attempt, or ACK-transport mutation)`,
        { adapterId: def.adapterId }
      );
    }
    if (typeof def.run !== 'function') {
      throw witnessedError('witnessed_registry_invalid_run', 'adapter definition requires a run function', { adapterId: def.adapterId });
    }
    if (byId.has(def.adapterId)) {
      throw witnessedError('witnessed_registry_duplicate_adapter', `adapterId "${def.adapterId}" is registered more than once`, {
        adapterId: def.adapterId,
      });
    }
    byId.set(def.adapterId, Object.freeze({ adapterId: def.adapterId, kind: def.kind, run: def.run }));
  }
  return Object.freeze({
    get(adapterId) {
      return byId.get(adapterId) || null;
    },
    ids() {
      return Array.from(byId.keys()).sort();
    },
  });
}

// ---------------------------------------------------------------------------
// Process-private one-use capability
// ---------------------------------------------------------------------------

// Module-private capability liveness set + the single in-flight operation
// context. Both are process-private by construction (never exported, never
// serialized); currentContext also implements the nested-operation guard.
const LIVE_CAPABILITIES = new WeakSet();
let currentContext = null;

function consumeCapability(candidate) {
  const ctx = currentContext;
  if (!ctx) {
    throw witnessedError('witnessed_no_operation_in_flight', 'no witnessed operation is in flight; the capability cannot be consumed');
  }
  if (candidate === ctx.capability) {
    if (ctx.consumed) {
      throw witnessedError('witnessed_capability_double_use', 'the one-use capability was already consumed');
    }
    if (!LIVE_CAPABILITIES.has(candidate)) {
      throw witnessedError('witnessed_capability_unrecognized', 'the capability is not a live process-private capability');
    }
    LIVE_CAPABILITIES.delete(candidate);
    ctx.consumed = true;
    return;
  }
  if (!LIVE_CAPABILITIES.has(candidate)) {
    // Copies, JSON round-trips, and already-consumed cached capabilities
    // all land here: identity, not field values, is what grants use.
    throw witnessedError('witnessed_capability_unrecognized', 'the capability is not a live process-private capability');
  }
  throw witnessedError('witnessed_capability_context_mismatch', 'the capability does not belong to the in-flight operation', {
    expectedOperationId: ctx.operationId,
  });
}

function mintCapability({ operationId, adapterId, activitySha256, generation }) {
  const capability = Object.freeze({
    operationId,
    adapterId,
    activitySha256,
    generation,
    consume() {
      consumeCapability(capability);
    },
  });
  LIVE_CAPABILITIES.add(capability);
  return capability;
}

// gateDbHandle: the enforcement of "it must consume it exactly once before
// its first mutation/effect" for whatever handle the wrapper passes
// through. Every method call (and property write) on the gated handle
// throws until the capability has been consumed; afterwards calls pass
// straight through to the real handle. The adapter never receives the raw
// handle, so it cannot mutate before consuming.
function gateDbHandle(db, ctx) {
  if (db === null || (typeof db !== 'object' && typeof db !== 'function')) return db;
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        return function gated(...fnArgs) {
          if (!ctx.consumed) {
            throw witnessedError('witnessed_mutation_before_consumption', 'the adapter must consume its one-use capability before its first mutation/effect');
          }
          return value.apply(target, fnArgs);
        };
      }
      return value;
    },
    set(target, prop, value) {
      if (!ctx.consumed) {
        throw witnessedError('witnessed_mutation_before_consumption', 'the adapter must consume its one-use capability before its first mutation/effect');
      }
      return Reflect.set(target, prop, value);
    },
  });
}

// ---------------------------------------------------------------------------
// Descriptor / args validation
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (...values) => (v) => values.includes(v);

const DESCRIPTOR_FIELDS = {
  adapterId: { check: isAdapterId },
  kind: { check: oneOf(...ACTIVITY_KINDS) },
  principal: { check: isPlainObject },
  commandKeySha256: { check: isSha256Hex },
  activitySha256: { check: isSha256Hex },
};

const LOCAL_PRINCIPAL_FIELDS = {
  principalKind: { check: oneOf('local') },
  actor: { check: (v) => typeof v === 'string' && v.length > 0 },
  producerId: { check: (v) => typeof v === 'string' && v.length > 0 },
};

const CLOUD_PRINCIPAL_FIELDS = {
  principalKind: { check: oneOf('cloud') },
  identitySha256: { check: isSha256Hex },
};

// resolvePrincipal: validates the closed principal shape and derives the
// stored hash. The local actor identifier is used ONLY as hash input and is
// never stored or returned (line 331: "without storing the actor").
function resolvePrincipal(principal) {
  if (!isPlainObject(principal)) {
    throw witnessedError('schema_not_object', 'descriptor principal must be a plain object');
  }
  if (principal.principalKind === 'local') {
    validateClosedObject(principal, LOCAL_PRINCIPAL_FIELDS, 'local principal');
    return { principalKind: 'local', principalSha256: localPrincipalSha256(principal.actor, principal.producerId) };
  }
  if (principal.principalKind === 'cloud') {
    validateClosedObject(principal, CLOUD_PRINCIPAL_FIELDS, 'cloud principal');
    return { principalKind: 'cloud', principalSha256: cloudPrincipalSha256(principal.identitySha256) };
  }
  throw witnessedError('schema_invalid_field', 'principal principalKind must be cloud|local', { field: 'principalKind' });
}

// deepRejectFunctions: "caller callback substitution fails" — the wrapper
// only ever executes the run function from the closed registry, and any
// function smuggled anywhere inside args (or the descriptor, which is
// additionally canonicalized) is rejected outright before any append.
function deepRejectFunctions(value, seen) {
  if (typeof value === 'function') {
    throw witnessedError('witnessed_args_function_rejected', 'adapter args must not contain functions (caller callback substitution)');
  }
  if (value === null || typeof value !== 'object') return;
  const visited = seen || new WeakSet();
  if (visited.has(value)) return;
  visited.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) deepRejectFunctions(entry, visited);
}

// ---------------------------------------------------------------------------
// The witnessed-operation runner
// ---------------------------------------------------------------------------

// createWitnessedOperationRunner(options): binds a closed registry plus
// root/lock context and returns { runWitnessedOperation(db, descriptor,
// args) } with the exact plan signature. options:
//   registry (required)         — a createAdapterRegistry result
//   opts / roots                — root resolution (production defaults)
//   ownershipAdapter, bootId, isProcessAlive — lock/verification context
//   now(), newOperationId()     — injectable time/ID sources (tests)
function createWitnessedOperationRunner(options) {
  const o = options || {};
  const registry = o.registry;
  if (!registry || typeof registry.get !== 'function') {
    throw witnessedError('witnessed_registry_invalid', 'createWitnessedOperationRunner requires a closed adapter registry');
  }
  const roots = o.roots || resolveRoots(o.opts || {});
  const ownershipAdapter = o.ownershipAdapter || defaultOwnershipAdapter;
  const now = o.now || (() => new Date().toISOString());
  const newOperationId = o.newOperationId || (() => crypto.randomUUID());

  function runWitnessedOperation(db, descriptor, args) {
    // Nested operation: exactly one witnessed operation may be in flight
    // per process. Checked before anything else so a nested call can never
    // append, lock, or mint.
    if (currentContext !== null) {
      throw witnessedError('witnessed_nested_operation', 'a witnessed operation is already in flight in this process');
    }

    // --- pre-append validation (throws; nothing recorded) -----------------
    validateClosedObject(descriptor, DESCRIPTOR_FIELDS, 'witnessed operation descriptor');
    // Canonicalize the protected descriptor: rejects undefined, functions,
    // and non-finite numbers anywhere inside it.
    canonicalJson(descriptor);
    const registered = registry.get(descriptor.adapterId);
    if (!registered) {
      throw witnessedError('witnessed_adapter_not_registered', `adapterId "${descriptor.adapterId}" is not in the closed registry`, {
        adapterId: descriptor.adapterId,
      });
    }
    if (registered.kind !== descriptor.kind) {
      throw witnessedError('witnessed_adapter_kind_mismatch', `descriptor kind "${descriptor.kind}" does not match the registered adapter kind "${registered.kind}"`, {
        adapterId: descriptor.adapterId,
      });
    }
    const principal = resolvePrincipal(descriptor.principal);
    deepRejectFunctions(args);

    // Capability-state gate (line 353): refuse to run while capability
    // state is missing, malformed, or database-restore-blocked. Read-only,
    // performed before the activity locks — the capability chain is
    // guarded by the four-root lock, not the activity subset, so ordering
    // relative to the activity locks does not change its consistency.
    const chain = verifyCapabilityChain(roots, { ownershipAdapter });
    if (!chain.present) {
      throw witnessedError('witnessed_capability_state_missing', 'capability state is missing; witnessed operations refuse to run');
    }
    const latestState = chain.generations[chain.generations.length - 1].generation.state;
    if (!latestState.databaseRestore || latestState.databaseRestore.status !== 'CLEAR') {
      throw witnessedError('witnessed_database_restore_blocked', 'capability state is database-restore-blocked; witnessed operations refuse to run', {
        databaseRestore: latestState.databaseRestore,
      });
    }

    const operationId = newOperationId();
    const createdAt = now();

    // --- the stable activity lock (line 353: locks both activity roots) ---
    const lock = acquireActivityRootLocks(
      roots,
      {
        operationId,
        sourceKind: 'witnessed-operation',
        sourceAuthority: null,
        headIdentities: {},
        typedReceiptSha256: null,
      },
      {
        bootId: o.bootId,
        isProcessAlive: o.isProcessAlive,
        ownershipAdapter,
        reconcile: {
          verifyChain: () => reconcileExternalActivityHead(roots, { ownershipAdapter, recoveryOnlyAdapter: o.recoveryOnlyAdapter }),
          findProposalForOperation: () => null,
        },
      }
    );

    let outcome;
    try {
      // --- durable intent append BEFORE the adapter runs ------------------
      const appended = appendActivityWithExternalHead({
        roots,
        ownershipAdapter,
        recoveryOnlyAdapter: o.recoveryOnlyAdapter,
        operationId,
        kind: descriptor.kind,
        createdAt,
        principalKind: principal.principalKind,
        principalSha256: principal.principalSha256,
        commandKeySha256: descriptor.commandKeySha256,
        adapterId: descriptor.adapterId,
        activitySha256: descriptor.activitySha256,
      });

      // --- one-use capability + gated adapter run -------------------------
      const capability = mintCapability({
        operationId,
        adapterId: descriptor.adapterId,
        activitySha256: descriptor.activitySha256,
        generation: appended.row.generation,
      });
      const ctx = { capability, consumed: false, operationId, adapterId: descriptor.adapterId };
      currentContext = ctx;
      let result;
      let adapterError = null;
      try {
        result = registered.run(gateDbHandle(db, ctx), args, capability);
      } catch (err) {
        adapterError = err;
      } finally {
        currentContext = null;
        // An unconsumed capability must never survive the operation.
        LIVE_CAPABILITIES.delete(capability);
      }

      const evidence = {
        operationId,
        generation: appended.row.generation,
        entrySha256: appended.row.entry_sha256,
      };
      if (adapterError) {
        // Append-without-work: conservative evidence stands, failure is
        // returned, and the UNIQUE operation_id grants no second attempt.
        outcome = Object.assign({ ok: false, failure: 'witnessed_adapter_failed', cause: adapterError }, evidence);
      } else if (!ctx.consumed) {
        outcome = Object.assign({ ok: false, failure: 'witnessed_completed_without_consumption' }, evidence);
      } else {
        outcome = Object.assign({ ok: true, result }, evidence);
      }
    } finally {
      currentContext = null;
      lock.release();
    }
    return outcome;
  }

  return Object.freeze({ runWitnessedOperation });
}

module.exports = {
  witnessedError,
  createAdapterRegistry,
  createWitnessedOperationRunner,
  // Test-only hook: routes an arbitrary candidate object through the
  // private consumption path so tests can prove copies/serialized clones
  // are never consumable. Not part of the documented module API.
  __consumeForTest: consumeCapability,
};
