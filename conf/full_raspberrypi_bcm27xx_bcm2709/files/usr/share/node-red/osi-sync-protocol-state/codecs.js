'use strict';
// osi-sync-protocol-state/codecs.js — pure canonicalization, hashing, and
// closed-schema codecs for the sync protocol capability chain.
//
// Scope (2026-07-15-sync-delivery-stop-loss.md, Task 3 Step 0, the region
// from "Persist negotiation through osi-sync-protocol-state" through
// "...the plan states this limit rather than claiming tamper resistance"):
//   - Capability generation kind is a closed union of 8 kinds. Writers and
//     the load verifier share these exact field rules; cross-kind and unknown
//     fields are rejected before a generation can become authority.
//   - Byte-exact literal schemas (GENESIS generation, capability head,
//     genesis witness) are copied verbatim from the plan text; do not
//     paraphrase.
//
// Documented ambiguity (flagged again in the execution report): the plan
// names the semantic facts bound by HISTORICAL_V2_DISPOSITION,
// RESET_AUTHORIZATION, and the four DATABASE_* kinds' extra state fields,
// but does not give literal camelCase field names for every one of those
// facts the way it does for GENESIS/NEGOTIATED. Field names below are the
// most literal reading of the plan's descriptive language and are shared by
// the transition writers below.

const crypto = require('node:crypto');

function codecError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

// Deterministic, whitespace-free JSON serialization with recursively
// sorted object keys. Every generation/witness/head/lock/checkpoint hash in
// this module is computed over these exact bytes. `undefined` is never
// permitted (throws) so a caller cannot silently drop a field from the
// hashed representation.
function canonicalJson(value) {
  return canonicalize(value);
}

function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw codecError('canonical_json_invalid_number', 'canonical JSON forbids non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'undefined') {
    throw codecError('canonical_json_undefined', 'canonical JSON forbids undefined');
  }
  if (Array.isArray(value)) {
    return '[' + value.map((entry) => canonicalize(entry)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((key) => {
        if (value[key] === undefined) {
          throw codecError('canonical_json_undefined', `canonical JSON forbids undefined at key "${key}"`);
        }
        return JSON.stringify(key) + ':' + canonicalize(value[key]);
      })
      .join(',');
    return '{' + body + '}';
  }
  throw codecError('canonical_json_unsupported', `canonical JSON cannot encode type ${t}`);
}

function sha256Hex(bytesOrString) {
  const buf = Buffer.isBuffer(bytesOrString) ? bytesOrString : Buffer.from(String(bytesOrString), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalSha256(value) {
  return sha256Hex(canonicalJson(value));
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID_V4_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isSha256Hex(value) {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isOperationId(value) {
  return typeof value === 'string' && (UUID_V4_LIKE.test(value) || /^[A-Za-z0-9_.:-]{8,128}$/.test(value));
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_8601.test(value) && Number.isFinite(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Closed-object schema helper: rejects unknown keys, validates each field
// with a per-key predicate, and treats a missing required key as invalid.
// ---------------------------------------------------------------------------

function validateClosedObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codecError('schema_not_object', `${label} must be a plain object`);
  }
  const allowedKeys = Object.keys(fields);
  const actualKeys = Object.keys(value);
  for (const key of actualKeys) {
    if (!allowedKeys.includes(key)) {
      throw codecError('schema_unknown_field', `${label} has unknown field "${key}"`, { field: key });
    }
  }
  for (const key of allowedKeys) {
    const spec = fields[key];
    const present = Object.prototype.hasOwnProperty.call(value, key);
    if (!present) {
      if (spec.optional) continue;
      throw codecError('schema_missing_field', `${label} is missing required field "${key}"`, { field: key });
    }
    if (!spec.check(value[key], value)) {
      throw codecError('schema_invalid_field', `${label} has an invalid value for field "${key}"`, { field: key });
    }
  }
  return value;
}

const isNull = (v) => v === null;
const isString = (v) => typeof v === 'string' && v.length > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const nullOr = (check) => (v) => v === null || check(v);
const oneOf = (...values) => (v) => values.includes(v);

// ---------------------------------------------------------------------------
// GENESIS — byte-exact per plan lines ~329 & 351.
// ---------------------------------------------------------------------------

const GENESIS_STATE_FIELDS = {
  activeIdentitySha256: { check: isNull },
  mode: { check: oneOf('UNNEGOTIATED') },
  historicalV2Disposition: { check: oneOf('UNASSESSED') },
  historicalV2DispositionReceiptSha256: { check: isNull },
  databaseRestore: {
    check: (v) =>
      v && typeof v === 'object' && !Array.isArray(v) &&
      Object.keys(v).sort().join(',') === 'restoreEpoch,status' &&
      v.status === 'CLEAR' && v.restoreEpoch === 0,
  },
};

function validateGenesisState(state) {
  return validateClosedObject(state, GENESIS_STATE_FIELDS, 'GENESIS state');
}

const GENESIS_FIELDS = {
  format: { check: (v) => v === 1 },
  generation: { check: (v) => v === 0 },
  previousGeneration: { check: isNull },
  previousSha256: { check: isNull },
  operationId: { check: isOperationId },
  kind: { check: oneOf('GENESIS') },
  createdAt: { check: isIsoTimestamp },
  state: { check: () => true },
};

function buildGenesisGeneration({ operationId, createdAt }) {
  if (!isOperationId(operationId)) throw codecError('genesis_invalid_operation_id', 'genesis requires a valid operationId');
  if (!isIsoTimestamp(createdAt)) throw codecError('genesis_invalid_created_at', 'genesis requires a valid createdAt');
  const generation = {
    format: 1,
    generation: 0,
    previousGeneration: null,
    previousSha256: null,
    operationId,
    kind: 'GENESIS',
    createdAt,
    state: {
      activeIdentitySha256: null,
      mode: 'UNNEGOTIATED',
      historicalV2Disposition: 'UNASSESSED',
      historicalV2DispositionReceiptSha256: null,
      databaseRestore: { status: 'CLEAR', restoreEpoch: 0 },
    },
  };
  validateGenesisGeneration(generation);
  return generation;
}

function validateGenesisGeneration(generation) {
  validateClosedObject(generation, GENESIS_FIELDS, 'GENESIS generation');
  validateGenesisState(generation.state);
  return generation;
}

const GENESIS_WITNESS_FIELDS = {
  format: { check: (v) => v === 1 },
  generation: { check: (v) => v === 0 },
  generationSha256: { check: isSha256Hex },
  previousWitnessSha256: { check: isNull },
  operationId: { check: isOperationId },
};

function buildGenesisWitness({ generationSha256, operationId }) {
  const witness = {
    format: 1,
    generation: 0,
    generationSha256,
    previousWitnessSha256: null,
    operationId,
  };
  validateGenesisWitness(witness);
  return witness;
}

function validateGenesisWitness(witness) {
  validateClosedObject(witness, GENESIS_WITNESS_FIELDS, 'GENESIS witness');
  return witness;
}

const CAPABILITY_HEAD_FIELDS = {
  format: { check: (v) => v === 1 },
  generation: { check: isNonNegInt },
  generationSha256: { check: isSha256Hex },
  witnessSha256: { check: isSha256Hex },
};

function buildCapabilityHead({ generation, generationSha256, witnessSha256 }) {
  const head = { format: 1, generation, generationSha256, witnessSha256 };
  validateCapabilityHead(head);
  return head;
}

function validateCapabilityHead(head) {
  validateClosedObject(head, CAPABILITY_HEAD_FIELDS, 'capability head.json');
  return head;
}

// ---------------------------------------------------------------------------
// Generic witness codec (applies to every non-GENESIS generation too).
// "Its witness has only format, generation, generationSha256,
// previousWitnessSha256, and the same operationId." (line 343)
// ---------------------------------------------------------------------------

const WITNESS_FIELDS = {
  format: { check: (v) => v === 1 },
  generation: { check: isNonNegInt },
  generationSha256: { check: isSha256Hex },
  previousWitnessSha256: { check: nullOr(isSha256Hex) },
  operationId: { check: isOperationId },
};

function validateWitness(witness) {
  if (witness && witness.generation === 0) return validateGenesisWitness(witness);
  validateClosedObject(witness, WITNESS_FIELDS, 'capability witness');
  if (witness.previousWitnessSha256 === null) {
    throw codecError('schema_invalid_field', 'non-GENESIS witness requires previousWitnessSha256', { field: 'previousWitnessSha256' });
  }
  return witness;
}

// ---------------------------------------------------------------------------
// Full closed kind union for non-GENESIS generations (line 343-345).
// ---------------------------------------------------------------------------

const NON_GENESIS_KINDS = [
  'HISTORICAL_V2_DISPOSITION',
  'NEGOTIATED',
  'RESET_AUTHORIZATION',
  'DATABASE_RESTORE_INVALIDATION',
  'DATABASE_RESTORE_RECONCILED',
  'DATABASE_INTEGRITY_INVALIDATION',
  'DATABASE_INTEGRITY_RECONCILED',
];

const ALL_KINDS = ['GENESIS', ...NON_GENESIS_KINDS];

const DATABASE_RESTORE_FIELDS = {
  status: { check: oneOf('CLEAR', 'RECONCILIATION_REQUIRED') },
  restoreEpoch: { check: isNonNegInt },
};

function validateDatabaseRestore(value, label) {
  return validateClosedObject(value, DATABASE_RESTORE_FIELDS, label || 'databaseRestore');
}

// Base fields present in every non-GENESIS state (mirrors GENESIS's own
// four ambient fields plus the preserved databaseRestore object — line 343:
// "Every generation except the four database invalidation/reconciliation
// kinds preserves the exact prior databaseRestore object.").
function baseStateFields(overrides) {
  return Object.assign(
    {
      activeIdentitySha256: { check: nullOr(isSha256Hex) },
      mode: { check: oneOf('UNNEGOTIATED', 'LEGACY_V2', 'V3_PINNED', 'RESET_AUTHORIZED') },
      historicalV2Disposition: { check: oneOf('UNASSESSED', 'CLEAR', 'RECONCILIATION_REQUIRED') },
      historicalV2DispositionReceiptSha256: { check: nullOr(isSha256Hex) },
      databaseRestore: { check: (v) => { validateDatabaseRestore(v); return true; } },
    },
    overrides || {}
  );
}

// --- HISTORICAL_V2_DISPOSITION ---------------------------------------------
// "A disposition generation retains exactly activeIdentitySha256:null and
// mode:'UNNEGOTIATED', then carries a closed sourceKind... Zero additionally
// carries a closed sourceAuthorityKind... forbids backup or linked-identity
// fields [for factory-baseline]." (line 343-344)

const DISPOSITION_SOURCE_KINDS = ['zero', 'rebind', 'quarantine', 'restore-invalidation'];
const DISPOSITION_ZERO_AUTHORITY_KINDS = ['deployment-backup', 'factory-baseline'];

function dispositionStateFields(state) {
  const sourceKind = state && state.sourceKind;
  const fields = baseStateFields({
    activeIdentitySha256: { check: isNull },
    mode: { check: oneOf('UNNEGOTIATED') },
    historicalV2Disposition: { check: oneOf('CLEAR', 'RECONCILIATION_REQUIRED') },
    historicalV2DispositionReceiptSha256: { check: isSha256Hex },
    sourceKind: { check: oneOf(...DISPOSITION_SOURCE_KINDS) },
  });
  if (sourceKind === 'zero') {
    fields.sourceAuthorityKind = { check: oneOf(...DISPOSITION_ZERO_AUTHORITY_KINDS) };
    const authority = state.sourceAuthorityKind;
    if (authority === 'deployment-backup') {
      Object.assign(fields, {
        dispositionReceiptSha256: { check: isSha256Hex },
        auditSha256: { check: isSha256Hex },
        databaseSha256: { check: isSha256Hex },
        backupSha256: { check: isSha256Hex },
        identitySha256: { check: nullOr(isSha256Hex) },
      });
    } else if (authority === 'factory-baseline') {
      Object.assign(fields, {
        romProvenanceSha256: { check: isSha256Hex },
        imageManifestSha256: { check: isSha256Hex },
        factorySeedIdentitySha256: { check: isSha256Hex },
        liveDatabaseIdentitySha256: { check: isSha256Hex },
        factoryZeroAuditSha256: { check: isSha256Hex },
        factoryZeroSourceReceiptSha256: { check: isSha256Hex },
        imageBaselineOperationId: { check: isOperationId },
        imageBaselineGeneration: { check: isNonNegInt },
        allRootAbsenceIntentSha256: { check: isSha256Hex },
      });
    }
  } else if (sourceKind === 'rebind' || sourceKind === 'quarantine') {
    Object.assign(fields, {
      dispositionReceiptSha256: { check: isSha256Hex },
      auditSha256: { check: isSha256Hex },
      databaseSha256: { check: isSha256Hex },
      backupSha256: { check: isSha256Hex },
      identitySha256: { check: nullOr(isSha256Hex) },
    });
  } else if (sourceKind === 'restore-invalidation') {
    Object.assign(fields, {
      recoveryOperationId: { check: isOperationId },
      // Plan line 351 binds the proposal to "the unchanged linked recovery
      // operation/`disposition-restoring` phase" — the phase is part of
      // the bound source facts, not just the operation ID (review MINOR 2).
      recoveryPhase: { check: oneOf('disposition-restoring') },
      restorePreparationResultSha256: { check: isSha256Hex },
      restoreReceiptSha256: { check: isSha256Hex },
      restoredDatabaseAuditSha256: { check: isSha256Hex },
      priorClearGeneration: { check: isPositiveInt },
      priorClearGenerationSha256: { check: isSha256Hex },
      identitySha256: { check: isSha256Hex },
    });
  }
  return fields;
}

function validateDispositionState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw codecError('schema_not_object', 'HISTORICAL_V2_DISPOSITION state must be a plain object');
  }
  if (!DISPOSITION_SOURCE_KINDS.includes(state.sourceKind)) {
    throw codecError('schema_invalid_field', 'HISTORICAL_V2_DISPOSITION state has an invalid sourceKind', { field: 'sourceKind' });
  }
  const sourceKind = state.sourceKind;
  const requiredClear = sourceKind === 'zero' || sourceKind === 'rebind';
  const expectedDisposition = requiredClear ? 'CLEAR' : 'RECONCILIATION_REQUIRED';
  if (state.historicalV2Disposition !== expectedDisposition) {
    throw codecError('schema_invalid_field', `sourceKind "${sourceKind}" requires historicalV2Disposition "${expectedDisposition}"`, { field: 'historicalV2Disposition' });
  }
  return validateClosedObject(state, dispositionStateFields(state), 'HISTORICAL_V2_DISPOSITION state');
}

// --- NEGOTIATED --------------------------------------------------------
// "The later negotiation state carries identitySha256, normalizedServerBase,
// gatewayDeviceEui, nullable capabilityProofSha256, and retained CLEAR
// receipt hash." (line 343) — the "retained CLEAR receipt hash" is the base
// historicalV2DispositionReceiptSha256 field carried forward unchanged.

function negotiatedStateFields() {
  return baseStateFields({
    activeIdentitySha256: { check: isSha256Hex },
    mode: { check: oneOf('LEGACY_V2', 'V3_PINNED') },
    historicalV2Disposition: { check: oneOf('CLEAR') },
    historicalV2DispositionReceiptSha256: { check: isSha256Hex },
    identitySha256: { check: isSha256Hex },
    normalizedServerBase: { check: isString },
    gatewayDeviceEui: { check: (v) => typeof v === 'string' && /^[0-9A-F]{16}$/.test(v) },
    capabilityProofSha256: { check: nullOr(isSha256Hex) },
  });
}

function validateNegotiatedState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.activeIdentitySha256 !== state.identitySha256) {
    throw codecError('schema_invalid_field', 'NEGOTIATED state activeIdentitySha256 must equal identitySha256', { field: 'activeIdentitySha256' });
  }
  return validateClosedObject(state, negotiatedStateFields(), 'NEGOTIATED state');
}

// --- RESET_AUTHORIZATION ------------------------------------------------
// "A reset state uses RESET_AUTHORIZED plus target active identity/mode,
// authorizationId, confirmationSha256, fromIdentitySha256, toIdentitySha256,
// resetEpoch, resetAuthorizedAt, and resetReasonSha256." (line 343)

function resetStateFields() {
  return baseStateFields({
    activeIdentitySha256: { check: isSha256Hex },
    mode: { check: oneOf('RESET_AUTHORIZED') },
    authorizationId: { check: isOperationId },
    confirmationSha256: { check: isSha256Hex },
    fromIdentitySha256: { check: nullOr(isSha256Hex) },
    toIdentitySha256: { check: isSha256Hex },
    resetEpoch: { check: isNonNegInt },
    resetAuthorizedAt: { check: isIsoTimestamp },
    resetReasonSha256: { check: isSha256Hex },
    resetReceiptSha256: { check: isSha256Hex },
  });
}

function validateResetState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.activeIdentitySha256 !== state.toIdentitySha256) {
    throw codecError('schema_invalid_field', 'RESET_AUTHORIZATION state activeIdentitySha256 must equal toIdentitySha256', { field: 'activeIdentitySha256' });
  }
  return validateClosedObject(state, resetStateFields(), 'RESET_AUTHORIZATION state');
}

// --- DATABASE_RESTORE_INVALIDATION / _RECONCILED ------------------------
// "DATABASE_RESTORE_INVALIDATION preserves the active identity, negotiation
// mode, historical disposition, and reset epoch, increments
// databaseRestore.restoreEpoch, and sets databaseRestore.status:
// 'RECONCILIATION_REQUIRED'. Its typed receipt binds..." (line 345)

function databaseRestoreInvalidationFields() {
  return baseStateFields({
    databaseRestore: {
      check: (v) => {
        validateDatabaseRestore(v);
        return v.status === 'RECONCILIATION_REQUIRED';
      },
    },
    invalidationReceiptSha256: { check: isSha256Hex },
    recoveryOperationId: { check: isOperationId },
  });
}

function validateDatabaseRestoreInvalidationState(state) {
  return validateClosedObject(state, databaseRestoreInvalidationFields(), 'DATABASE_RESTORE_INVALIDATION state');
}

function databaseRestoreReconciledFields() {
  return baseStateFields({
    databaseRestore: {
      check: (v) => {
        validateDatabaseRestore(v);
        return v.status === 'CLEAR';
      },
    },
    reconciledReceiptSha256: { check: isSha256Hex },
    recoveryOperationId: { check: isOperationId },
  });
}

function validateDatabaseRestoreReconciledState(state) {
  return validateClosedObject(state, databaseRestoreReconciledFields(), 'DATABASE_RESTORE_RECONCILED state');
}

// --- DATABASE_INTEGRITY_INVALIDATION / _RECONCILED ----------------------
// "DATABASE_INTEGRITY_INVALIDATION is a distinct explicit-authority path for
// a latched missing/corrupt current database: it preserves identity/mode,
// advances the restore epoch, binds the latch observation, trusted backup,
// forensic destination, activity roots, and manual-loss acknowledgement..."
// (line 345)

function databaseIntegrityInvalidationFields() {
  return baseStateFields({
    databaseRestore: {
      check: (v) => {
        validateDatabaseRestore(v);
        return v.status === 'RECONCILIATION_REQUIRED';
      },
    },
    invalidationReceiptSha256: { check: isSha256Hex },
    authoritySha256: { check: isSha256Hex },
    observedEvidenceSha256: { check: isSha256Hex },
    backupManifestSha256: { check: isSha256Hex },
    forensicDestination: { check: (v) => typeof v === 'string' && v.startsWith('/') },
    activityGeneration: { check: isNonNegInt },
    activityEntrySha256: { check: isSha256Hex },
    activityExternalHeadSha256: { check: isSha256Hex },
    possibleDataLossAcknowledgementSha256: { check: isSha256Hex },
    recoveryOperationId: { check: isOperationId },
  });
}

function validateDatabaseIntegrityInvalidationState(state) {
  return validateClosedObject(state, databaseIntegrityInvalidationFields(), 'DATABASE_INTEGRITY_INVALIDATION state');
}

function databaseIntegrityReconciledFields() {
  return baseStateFields({
    databaseRestore: {
      check: (v) => {
        validateDatabaseRestore(v);
        return v.status === 'CLEAR';
      },
    },
    reconciledReceiptSha256: { check: isSha256Hex },
    reconciliationAuthoritySha256: { check: isSha256Hex },
    historicalRevalidationReceiptSha256: { check: isSha256Hex },
    postReconcileCommandAuditSha256: { check: isSha256Hex },
    postReconcileFarmingAuditSha256: { check: isSha256Hex },
    forensicInventorySha256: { check: isSha256Hex },
    recoveryOperationId: { check: isOperationId },
  });
}

function validateDatabaseIntegrityReconciledState(state) {
  return validateClosedObject(state, databaseIntegrityReconciledFields(), 'DATABASE_INTEGRITY_RECONCILED state');
}

const NON_GENESIS_STATE_VALIDATORS = {
  HISTORICAL_V2_DISPOSITION: validateDispositionState,
  NEGOTIATED: validateNegotiatedState,
  RESET_AUTHORIZATION: validateResetState,
  DATABASE_RESTORE_INVALIDATION: validateDatabaseRestoreInvalidationState,
  DATABASE_RESTORE_RECONCILED: validateDatabaseRestoreReconciledState,
  DATABASE_INTEGRITY_INVALIDATION: validateDatabaseIntegrityInvalidationState,
  DATABASE_INTEGRITY_RECONCILED: validateDatabaseIntegrityReconciledState,
};

const GENERATION_ENVELOPE_FIELDS = {
  format: { check: (v) => v === 1 },
  generation: { check: isPositiveInt },
  previousGeneration: { check: isNonNegInt },
  previousSha256: { check: isSha256Hex },
  operationId: { check: isOperationId },
  kind: { check: oneOf(...NON_GENESIS_KINDS) },
  createdAt: { check: isIsoTimestamp },
  state: { check: () => true },
};

// validateGeneration(generation): dispatches on `kind`. Generation 0 must be
// exactly GENESIS; every other generation must be one of the seven
// non-GENESIS kinds with `generation === previousGeneration + 1`.
function validateGeneration(generation) {
  if (!generation || typeof generation !== 'object' || Array.isArray(generation)) {
    throw codecError('schema_not_object', 'generation must be a plain object');
  }
  if (generation.kind === 'GENESIS' || generation.generation === 0) {
    return validateGenesisGeneration(generation);
  }
  if (!ALL_KINDS.includes(generation.kind)) {
    throw codecError('schema_invalid_field', `unknown generation kind "${generation.kind}"`, { field: 'kind' });
  }
  validateClosedObject(generation, GENERATION_ENVELOPE_FIELDS, `${generation.kind} generation`);
  if (generation.generation !== generation.previousGeneration + 1) {
    throw codecError('schema_invalid_field', 'generation must equal previousGeneration + 1', { field: 'generation' });
  }
  const validator = NON_GENESIS_STATE_VALIDATORS[generation.kind];
  validator(generation.state);
  return generation;
}

// ---------------------------------------------------------------------------
// normalizedServerBase / identitySha256 (line 347)
// ---------------------------------------------------------------------------

function normalizedServerBase(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    throw codecError('server_base_invalid', 'server base URL must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    throw codecError('server_base_invalid', 'server base is not a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw codecError('server_base_requires_https', 'server base must use https:');
  }
  if (parsed.username || parsed.password) {
    throw codecError('server_base_forbids_userinfo', 'server base must not carry userinfo');
  }
  if (parsed.search) {
    throw codecError('server_base_forbids_query', 'server base must not carry a query string');
  }
  if (parsed.hash) {
    throw codecError('server_base_forbids_fragment', 'server base must not carry a fragment');
  }
  const hostname = parsed.hostname.toLowerCase();
  const portSuffix = parsed.port === '' ? '' : `:${parsed.port}`;
  let pathname = parsed.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return `https://${hostname}${portSuffix}${pathname}`;
}

function identitySha256({ peerNode, serverBase, cloudUserId, gatewayDeviceEui }) {
  if (typeof peerNode !== 'string' || !peerNode) {
    throw codecError('identity_invalid_peer_node', 'identitySha256 requires a non-empty peerNode');
  }
  if (typeof serverBase !== 'string' || !serverBase) {
    throw codecError('identity_invalid_server_base', 'identitySha256 requires a non-empty serverBase');
  }
  if (typeof cloudUserId !== 'string' || !cloudUserId) {
    throw codecError('identity_invalid_cloud_user_id', 'identitySha256 requires a non-empty cloudUserId');
  }
  if (typeof gatewayDeviceEui !== 'string' || !/^[0-9A-Fa-f]{16}$/.test(gatewayDeviceEui)) {
    throw codecError('identity_invalid_gateway_eui', 'identitySha256 requires a 16-hex-digit gatewayDeviceEui');
  }
  return canonicalSha256({
    peerNode,
    serverBase,
    cloudUserId,
    gatewayDeviceEui: gatewayDeviceEui.toUpperCase(),
  });
}

module.exports = {
  codecError,
  canonicalJson,
  sha256Hex,
  canonicalSha256,
  isSha256Hex,
  isOperationId,
  isIsoTimestamp,
  validateClosedObject,
  ALL_KINDS,
  NON_GENESIS_KINDS,
  buildGenesisGeneration,
  validateGenesisGeneration,
  buildGenesisWitness,
  validateGenesisWitness,
  buildCapabilityHead,
  validateCapabilityHead,
  validateWitness,
  validateGeneration,
  validateDispositionState,
  validateNegotiatedState,
  validateResetState,
  validateDatabaseRestoreInvalidationState,
  validateDatabaseRestoreReconciledState,
  validateDatabaseIntegrityInvalidationState,
  validateDatabaseIntegrityReconciledState,
  normalizedServerBase,
  identitySha256,
};
