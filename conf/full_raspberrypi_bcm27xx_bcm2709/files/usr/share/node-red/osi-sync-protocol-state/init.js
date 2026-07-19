'use strict';
// osi-sync-protocol-state/init.js — the four-root initialization primitive.
//
// Plan facts encoded here (lines 329, 333, 351):
//   - "exclusively create /data/osi-sync/protocol-capabilities/generations/,
//     /reset-receipts/, /v2-disposition-receipts/, /database-restore-
//     receipts/, genesis generations/0000000000000000.json, the
//     independent monotonic capability witness root .../protocol-
//     capability-witnesses/, .../command-activity-witnesses/activity.sqlite,
//     and the independent current-head/checkpoint root .../command-
//     activity-head-witnesses/; they fsync each before publishing heads."
//   - "No path overwrites an existing chain or witness... A crash after the
//     immutable deployment/factory intent but before the first root entry
//     may resume only that exact operation from all-absent roots; once any
//     root/genesis entry exists, missing its peer or returning to absence
//     is corruption and blocks both v3 and v2 command polling."
//
// Authority note: this file implements only the mechanical "create four
// fresh roots from nothing" primitive. It does not itself decide WHICH
// caller/authority (deployment `initialize`, factory-zero,
// integrity-recovery) may invoke it — that gating lives in the CLI layer
// (deployment-state-gate.js + sync-protocol-capability-cli.js) per this
// slice's scope. "Runtime code cannot initialize" is enforced structurally:
// this module is never registered in osi-lib and flows.json never requires
// it (both explicitly out of scope / forbidden for this slice).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildGenesisGeneration,
  buildGenesisWitness,
  buildCapabilityHead,
  canonicalSha256,
  canonicalJson,
  sha256Hex,
} = require('./codecs');
const {
  resolveRoots,
  ensureModeDirRecursive,
  ensureFourRootDirsForLocking,
  writeExclusiveFile,
  writeExclusiveOrVerify,
  atomicReplaceFile,
  defaultOwnershipAdapter,
} = require('./paths');
const { createActivityDatabase, createOrResumeActivityDatabase, buildGenesisCheckpoint } = require('./activity-db');
const { acquireFourRootLocks } = require('./locks');

function initError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// Named crash-injection boundaries, in the exact order this function
// executes them. Tests spawn a child process and pass one of these via
// options.crashAfter to prove each fsync/rename boundary is independently
// crash-safe and independently resumable-or-blocking.
const STEPS = [
  'capability_dirs_created',
  'capability_genesis_written',
  'witness_root_created',
  'capability_witness_written',
  'capability_head_published',
  'activity_root_created',
  'activity_database_created',
  'activity_head_witness_root_created',
  'activity_checkpoint_written',
  'activity_head_published',
];

function maybeCrash(step, crashAfter) {
  if (crashAfter === step) {
    // Simulates a hard crash: no further cleanup, no further writes. Real
    // process exit so a parent test can inspect on-disk state afterward.
    process.exit(137);
  }
}

// probeAnyRootEntry: cheap existence probe used to enforce "any partial
// root set blocks" / "resumes only from all-absent". Does not attempt to
// validate content — that is load.js's job.
function probeAnyRootEntry(roots) {
  const candidates = [
    roots.capabilityHeadPath,
    path.join(roots.generationsDir, '0000000000000000.json'),
    path.join(roots.witnessRoot, '0000000000000000.json'),
    roots.activityDbPath,
    path.join(roots.checkpointsDir, '0000000000000000.json'),
    roots.activityHeadPath,
  ];
  return candidates.filter((p) => fs.existsSync(p));
}

// collectExistingOperationIds: inspects whichever candidate files already
// exist and returns the set of distinct operationIds they carry. Used by
// the resumable path to prove a partial root set belongs to the SAME
// logical operation the caller is retrying, not a different one barging in
// on incomplete work.
function collectExistingOperationIds(roots) {
  const ids = new Set();
  const genPath = path.join(roots.generationsDir, '0000000000000000.json');
  if (fs.existsSync(genPath)) {
    const parsed = JSON.parse(fs.readFileSync(genPath, 'utf8'));
    if (parsed && parsed.operationId) ids.add(parsed.operationId);
  }
  if (fs.existsSync(roots.activityDbPath)) {
    const { openReadOnly, readGenesisRow } = require('./activity-db');
    const db = openReadOnly(roots.activityDbPath);
    try {
      const row = readGenesisRow(db);
      ids.add(row.operation_id);
    } catch (_err) {
      /* unreadable/corrupt: surfaced by the normal write-or-verify path below */
    } finally {
      db.close();
    }
  }
  return ids;
}

// createFourRootsUnlocked(options): the mechanical create-from-nothing
// sequence with NO locking of its own — the caller must already hold the
// four-root lock (or be a single-threaded test that doesn't care).
//
// options.resume (default false):
//   - false (the brief's literal "any partial root set blocks" primitive):
//     throws partial_or_existing_root_set if ANY relevant file already
//     exists anywhere across the four roots. Used directly by
//     initializeFourRoots() and by tests that exercise that exact rule.
//   - true: a legitimate crash-recovery retry of the SAME operationId.
//     Every step becomes "create if absent, else verify the existing
//     bytes/row are exactly what this same operation would have produced"
//     instead of blind O_EXCL-or-die. A byte/row mismatch is corruption
//     (a different operation's data occupying the same slot), not a
//     resume, and still throws. Used by index.js#initialize().
function createFourRootsUnlocked(options) {
  const opts = options || {};
  const roots = resolveRoots(opts);
  const ownershipAdapter = opts.ownershipAdapter || defaultOwnershipAdapter;
  const operationId = opts.operationId || crypto.randomUUID();
  const createdAt = opts.createdAt || new Date().toISOString();
  const sourceKind = opts.sourceKind || 'deployment';
  const crashAfter = opts.crashAfter || null;
  const resume = opts.resume === true;

  const existing = probeAnyRootEntry(roots);
  if (existing.length > 0) {
    if (!resume) {
      throw initError(
        'partial_or_existing_root_set',
        'refusing to initialize: at least one root already has an entry; a fresh initialize only proceeds from all-absent roots',
        { existing }
      );
    }
    const existingOpIds = collectExistingOperationIds(roots);
    if (existingOpIds.size > 1) {
      throw initError('partial_root_set_conflicting_operation', 'existing partial root entries disagree on operationId', {
        existingOperationIds: Array.from(existingOpIds),
      });
    }
    if (existingOpIds.size === 1 && !existingOpIds.has(operationId)) {
      throw initError(
        'partial_root_set_operation_mismatch',
        'a different operationId already has a partial root set on disk; resume with that exact operationId or reconcile explicitly',
        { existingOperationId: Array.from(existingOpIds)[0], requestedOperationId: operationId }
      );
    }
  }

  const writeStep = (filePath, buffer, mismatchCode) =>
    resume ? writeExclusiveOrVerify(filePath, buffer, ownershipAdapter, mismatchCode) : writeExclusiveFile(filePath, buffer, ownershipAdapter);

  {
    // --- capability root -----------------------------------------------
    // enforceFrom pins the module-owned subtree: any PRE-EXISTING
    // component at/below it must already be mode 0700 + service-owned
    // (review IMPORTANT 3a — a pre-created wrong-mode root fails closed).
    ensureModeDirRecursive(roots.generationsDir, ownershipAdapter, { enforceFrom: roots.root });
    ensureModeDirRecursive(roots.resetReceiptsDir, ownershipAdapter, { enforceFrom: roots.root });
    ensureModeDirRecursive(roots.v2DispositionReceiptsDir, ownershipAdapter, { enforceFrom: roots.root });
    ensureModeDirRecursive(roots.databaseRestoreReceiptsDir, ownershipAdapter, { enforceFrom: roots.root });
    maybeCrash('capability_dirs_created', crashAfter);

    const genesisGeneration = buildGenesisGeneration({ operationId, createdAt });
    const generationSha256 = canonicalSha256(genesisGeneration);
    writeStep(
      path.join(roots.generationsDir, '0000000000000000.json'),
      Buffer.from(canonicalJson(genesisGeneration), 'utf8'),
      'capability_generation_resume_mismatch'
    );
    maybeCrash('capability_genesis_written', crashAfter);

    ensureModeDirRecursive(roots.witnessRoot, ownershipAdapter, { enforceFrom: roots.witnessRoot });
    maybeCrash('witness_root_created', crashAfter);

    const genesisWitness = buildGenesisWitness({ generationSha256, operationId });
    const witnessSha256 = canonicalSha256(genesisWitness);
    writeStep(
      path.join(roots.witnessRoot, '0000000000000000.json'),
      Buffer.from(canonicalJson(genesisWitness), 'utf8'),
      'capability_witness_resume_mismatch'
    );
    maybeCrash('capability_witness_written', crashAfter);

    const capabilityHead = buildCapabilityHead({ generation: 0, generationSha256, witnessSha256 });
    atomicReplaceFile(roots.capabilityHeadPath, Buffer.from(canonicalJson(capabilityHead), 'utf8'), ownershipAdapter);
    maybeCrash('capability_head_published', crashAfter);

    // --- activity database ----------------------------------------------
    ensureModeDirRecursive(roots.activityWitnessRoot, ownershipAdapter, { enforceFrom: roots.activityWitnessRoot });
    maybeCrash('activity_root_created', crashAfter);

    const activityCreate = resume ? createOrResumeActivityDatabase : createActivityDatabase;
    const { genesisRow, checkpoint } = activityCreate({
      finalPath: roots.activityDbPath,
      operationId,
      createdAt,
      sourceKind,
      ownershipAdapter,
    });
    maybeCrash('activity_database_created', crashAfter);

    // --- activity head witness -------------------------------------------
    ensureModeDirRecursive(roots.checkpointsDir, ownershipAdapter, { enforceFrom: roots.activityHeadWitnessRoot });
    maybeCrash('activity_head_witness_root_created', crashAfter);

    writeStep(
      path.join(roots.checkpointsDir, '0000000000000000.json'),
      Buffer.from(canonicalJson(checkpoint), 'utf8'),
      'activity_checkpoint_resume_mismatch'
    );
    maybeCrash('activity_checkpoint_written', crashAfter);

    const checkpointSha256 = sha256Hex(canonicalJson(checkpoint));
    const activityHead = {
      format: 1,
      generation: genesisRow.generation,
      entrySha256: genesisRow.entrySha256,
      checkpointGeneration: checkpoint.checkpointGeneration,
      checkpointSha256,
    };
    atomicReplaceFile(roots.activityHeadPath, Buffer.from(canonicalJson(activityHead), 'utf8'), ownershipAdapter);
    maybeCrash('activity_head_published', crashAfter);

    return {
      roots,
      operationId,
      createdAt,
      capabilityHead,
      capabilityGeneration: genesisGeneration,
      capabilityWitness: genesisWitness,
      activityGenesisRow: genesisRow,
      activityCheckpoint: checkpoint,
      activityHead,
    };
  }
}

// initializeFourRoots(options): the standalone, self-locking entry point —
// ensures the four lock-bearing directories exist, acquires the four-root
// lock in the fixed order, runs createFourRootsUnlocked, then releases.
// Throws initError('partial_or_existing_root_set') if ANY relevant file
// already exists anywhere across the four roots.
function initializeFourRoots(options) {
  const opts = options || {};
  const roots = resolveRoots(opts);
  const ownershipAdapter = opts.ownershipAdapter || defaultOwnershipAdapter;
  const operationId = opts.operationId || crypto.randomUUID();
  const createdAt = opts.createdAt || new Date().toISOString();
  const sourceKind = opts.sourceKind || 'deployment';

  ensureFourRootDirsForLocking(roots, ownershipAdapter);
  const lock = acquireFourRootLocks(
    roots,
    { operationId, sourceKind: 'initialize', sourceAuthority: sourceKind, headIdentities: {}, typedReceiptSha256: null },
    { bootId: opts.bootId, now: () => createdAt, ownershipAdapter, isProcessAlive: opts.isProcessAlive }
  );
  try {
    return createFourRootsUnlocked(Object.assign({}, opts, { operationId, createdAt, sourceKind }));
  } finally {
    lock.release();
  }
}

module.exports = {
  initError,
  STEPS,
  probeAnyRootEntry,
  createFourRootsUnlocked,
  initializeFourRoots,
};
