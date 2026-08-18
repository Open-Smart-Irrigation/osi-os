'use strict';
// osi-sync-protocol-state/locks.js — the four-root lock protocol.
//
// Plan facts encoded here (line 353): "Every capability change takes one
// process-local lock plus stable exclusive locks for the four physical
// roots in fixed activity-head-witness, activity-database,
// capability-witness, then capability-root order, containing PID, boot ID,
// all head identities, operation ID, source kind/authority, and typed
// receipt hash when required. A witnessed operation locks both activity
// roots and refuses to run while capability state is missing, malformed,
// or database-restore-blocked. A live same-boot owner blocks; stale-lock
// reconciliation first verifies the affected capability chain or bounded
// activity checkpoint/segment and permits only deterministic completion of
// the recorded proposal or a new operation when no proposal names the
// stale operation."
//
// Documented ambiguity: the plan does not give a literal JSON field-name
// list for the lock file itself (unlike GENESIS/head/witness, which are
// byte-exact). The shape below is the most literal reading of the prose
// ("containing PID, boot ID, all head identities, operation ID, source
// kind/authority, and typed receipt hash when required"); flagged in the
// execution report.

const fs = require('node:fs');
const path = require('node:path');
const { codecError, canonicalJson, isOperationId } = require('./codecs');
const { fourRootsInLockOrder, writeExclusiveFile, LOCK_FILENAME } = require('./paths');

function lockError(code, message, extra) {
  return codecError(code, message, extra);
}

function defaultBootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch (_err) {
    throw lockError('boot_id_unavailable', 'could not read /proc/sys/kernel/random/boot_id; supply options.bootId explicitly');
  }
}

function defaultIsProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by another user: still "alive"
  }
}

function buildLockPayload({ pid, bootId, operationId, sourceKind, sourceAuthority, headIdentities, typedReceiptSha256, now }) {
  if (!isOperationId(operationId)) throw lockError('lock_invalid_operation_id', 'lock requires a valid operationId');
  if (typeof sourceKind !== 'string' || !sourceKind) throw lockError('lock_invalid_source_kind', 'lock requires a non-empty sourceKind');
  return {
    format: 1,
    pid,
    bootId,
    operationId,
    sourceKind,
    sourceAuthority: sourceAuthority == null ? null : sourceAuthority,
    headIdentities: headIdentities || {},
    typedReceiptSha256: typedReceiptSha256 == null ? null : typedReceiptSha256,
    createdAt: now,
  };
}

function readLockFile(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (_err) {
    throw lockError('lock_malformed', `lock file is not valid JSON: ${lockPath}`, { path: lockPath });
  }
}

// classifyExistingLock: decides whether an existing lock file represents a
// live same-boot owner (blocks outright) or a stale lock (reconciliation
// candidate).
function classifyExistingLock(existing, { bootId, isProcessAlive }) {
  const sameBoot = existing.bootId === bootId;
  const alive = sameBoot && isProcessAlive(existing.pid);
  return { sameBoot, live: alive };
}

// acquireOneLock: O_EXCL-creates the lock file. On contention, classifies
// the existing lock and throws either lock_live_same_boot_owner (retryable
// only by the true owner) or lock_stale (retryable via
// reconcileStaleLock/removeStaleLock below).
function acquireOneLock(lockPath, ownerInfo, ctx) {
  const payload = buildLockPayload({
    pid: process.pid,
    bootId: ctx.bootId,
    operationId: ownerInfo.operationId,
    sourceKind: ownerInfo.sourceKind,
    sourceAuthority: ownerInfo.sourceAuthority,
    headIdentities: ownerInfo.headIdentities,
    typedReceiptSha256: ownerInfo.typedReceiptSha256,
    now: ctx.now(),
  });
  const buffer = Buffer.from(canonicalJson(payload), 'utf8');
  try {
    writeExclusiveFile(lockPath, buffer, ctx.ownershipAdapter);
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const existing = readLockFile(lockPath);
  if (!existing) {
    // Disappeared between our EEXIST and this read (race with a concurrent
    // release); safe to retry once by the caller.
    throw lockError('lock_contended_retry', `lock file vanished during contention handling: ${lockPath}`, { path: lockPath });
  }
  const { live } = classifyExistingLock(existing, ctx);
  if (live) {
    throw lockError(
      'lock_live_same_boot_owner',
      `root is locked by a live same-boot owner (pid=${existing.pid}, operationId=${existing.operationId}): ${lockPath}`,
      { path: lockPath, existing }
    );
  }
  throw lockError(
    'lock_stale',
    `stale lock present; reconcile before retrying: ${lockPath}`,
    { path: lockPath, existing }
  );
}

function releaseOneLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// reconcileStaleLock: implements "stale-lock reconciliation first verifies
// the affected capability chain or bounded activity checkpoint/segment and
// permits only deterministic completion of the recorded proposal or a new
// operation when no proposal names the stale operation."
//
// `verifyChain()` is an injected callback (backed by load-verification
// code in later checkpoints) that must succeed (not throw) before any
// stale-lock removal is permitted. `findProposalForOperation(operationId)`
// is an injected callback that returns a truthy "proposal" descriptor when
// the chain still has an unheaded proposal naming that operation ID, or a
// falsy value when it does not.
function reconcileStaleLock(lockPath, existing, requestingOperationId, { verifyChain, findProposalForOperation }) {
  if (typeof verifyChain === 'function') {
    verifyChain(); // throws on failure; we never remove a lock over an unverifiable root
  }
  if (typeof findProposalForOperation === 'function') {
    const proposal = findProposalForOperation(existing.operationId);
    if (proposal && requestingOperationId !== existing.operationId) {
      throw lockError(
        'lock_stale_proposal_pending',
        `stale lock names an unheaded proposal (operationId=${existing.operationId}); it must be resumed before a new operation may proceed`,
        { path: lockPath, existing, proposal }
      );
    }
  }
  releaseOneLock(lockPath);
}

// acquireLocksInOrder: shared machinery — acquires a lock in each listed
// directory, in exactly the given order, automatically reconciling one
// generation of staleness per root when `reconcile` options are supplied.
// Returns a handle with .release().
function acquireLocksInOrder(lockDirs, ownerInfo, options) {
  const opts = options || {};
  const ctx = {
    bootId: opts.bootId || defaultBootId(),
    now: opts.now || (() => new Date().toISOString()),
    isProcessAlive: opts.isProcessAlive || defaultIsProcessAlive,
    ownershipAdapter: opts.ownershipAdapter,
  };
  const acquiredPaths = [];
  try {
    for (const dir of lockDirs) {
      const lockPath = path.join(dir, LOCK_FILENAME);
      try {
        acquireOneLock(lockPath, ownerInfo, ctx);
      } catch (err) {
        if (err.code === 'lock_stale' && opts.reconcile) {
          reconcileStaleLock(lockPath, err.existing, ownerInfo.operationId, opts.reconcile);
          acquireOneLock(lockPath, ownerInfo, ctx);
        } else {
          throw err;
        }
      }
      acquiredPaths.push(lockPath);
    }
  } catch (err) {
    for (const lockPath of acquiredPaths.slice().reverse()) releaseOneLock(lockPath);
    throw err;
  }
  let released = false;
  return {
    lockPaths: acquiredPaths.slice(),
    release() {
      if (released) return;
      released = true;
      for (const lockPath of acquiredPaths.slice().reverse()) releaseOneLock(lockPath);
    },
  };
}

// acquireFourRootLocks: all four root locks in the fixed plan order.
function acquireFourRootLocks(roots, ownerInfo, options) {
  return acquireLocksInOrder(fourRootsInLockOrder(roots).map((r) => r.dir), ownerInfo, options);
}

// acquireActivityRootLocks: the stable activity lock (plan line 353: "A
// witnessed operation locks both activity roots"). Locks exactly the two
// activity roots, in the same relative order they hold within the fixed
// four-root order (activity-head-witness, then activity-database), so a
// witnessed operation and a four-root capability operation can never
// deadlock by acquiring the shared subset in opposite orders.
function acquireActivityRootLocks(roots, ownerInfo, options) {
  return acquireLocksInOrder([roots.activityHeadWitnessRoot, roots.activityWitnessRoot], ownerInfo, options);
}

module.exports = {
  lockError,
  LOCK_FILENAME,
  defaultBootId,
  defaultIsProcessAlive,
  buildLockPayload,
  readLockFile,
  classifyExistingLock,
  acquireOneLock,
  releaseOneLock,
  reconcileStaleLock,
  acquireLocksInOrder,
  acquireFourRootLocks,
  acquireActivityRootLocks,
};
