'use strict';
// osi-sync-protocol-state/activity-append.js — the durable command-activity
// append discipline, principal hashing, checkpoint/prune machinery, and
// bounded verification helpers (plan lines 335-341).
//
// Plan facts encoded here (verbatim-binding, 2026-07-15-sync-delivery-stop-
// loss.md lines 337, 339, 341):
//   - Each logical entry is exactly {generation,previousGeneration,
//     previousSha256,operationId,kind:'COMMAND_LIFECYCLE_MUTATION'|
//     'EXTERNAL_EFFECT_ATTEMPT'|'ACK_TRANSPORT_MUTATION',createdAt,
//     principalKind:'cloud'|'local',principalSha256,commandKeySha256,
//     adapterId,activitySha256,entrySha256}; it contains no token, raw
//     payload, credential, actor identifier, device secret, or result
//     detail.
//   - "The helper takes BEGIN IMMEDIATE, revalidates the singleton head and
//     fixed schema, inserts the next safe-integer generation, updates the
//     singleton head and rolling segment accumulator, commits under
//     synchronous=FULL, closes, and rereads the committed row/head before
//     returning."
//   - principal_kind grammar (line 331): "cloud hashes the protected
//     capability identity, local hashes canonical
//     local:<authenticated-actor-uuid|system>:<producer-id> without storing
//     the actor, and system is initialization only." The append path
//     therefore accepts ONLY cloud|local; GENESIS/system exist solely in
//     activity-db.js's initialization codec.
//
// Documented inference (flagged in the execution report): the plan gives
// the local principal hash-input grammar literally
// (local:<actor-uuid|system>:<producer-id>) but for cloud says only "cloud
// hashes the protected capability identity". The cloud form below uses the
// symmetric canonical string `cloud:<identity-sha256>` so the two grammars
// cannot collide on any input; a future slice that binds the real
// protected capability identity must keep or consciously revise this
// exact input string.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  codecError,
  canonicalJson,
  sha256Hex,
  isSha256Hex,
  isOperationId,
  isIsoTimestamp,
  validateClosedObject,
} = require('./codecs');
const {
  verifyFixedSchema,
  entrySha256For,
  checkpointCumulativeSha256,
  buildGenesisCheckpoint,
  recoverHotJournalIfPresent,
  openReadOnly,
} = require('./activity-db');
const {
  resolveRoots,
  ensureModeDirRecursive,
  atomicReplaceFile,
  writeExclusiveFile,
  writeExclusiveOrVerify,
  generationFilename,
  listRegularEntries,
  fsyncFile,
  fsyncDir,
  FILE_MODE,
  defaultOwnershipAdapter,
} = require('./paths');
const { acquireActivityRootLocks } = require('./locks');

function appendError(code, message, extra) {
  return codecError(code, message, extra);
}

// --- bounds/ceilings (plan line 341, verbatim) ------------------------------
// "Every 4096 committed activities" / "at most 8193 rows and 32 MiB" /
// "the hard ceiling is 100000 receipts, representing 409600000 activities".
const CHECKPOINT_INTERVAL = 4096;
const MAX_RETAINED_ROWS = 8193;
const MAX_ACTIVITY_DB_BYTES = 32 * 1024 * 1024;
// "the hard ceiling is 100000 receipts, representing 409600000 activities"
// — 100000 * 4096 = 409,600,000 exactly, i.e. the highest permitted
// checkpoint INDEX is 100000 (the genesis receipt 0 represents
// initialization, not a 4096-activity segment, and is not counted).
// Creating receipt 100001 fails closed; a separately reviewed archive
// format, not silent rollover, is required beyond it.
const MAX_CHECKPOINT_RECEIPTS = 100000;
// "bounded incremental_vacuum": explicit page budget per checkpoint so
// vacuum work can never grow with lifetime history.
const INCREMENTAL_VACUUM_PAGE_BUDGET = 4096;
const FULL_AUDIT_WATCHDOG_MS = 120000;

const ACTIVITY_KINDS = ['COMMAND_LIFECYCLE_MUTATION', 'EXTERNAL_EFFECT_ATTEMPT', 'ACK_TRANSPORT_MUTATION'];
const ACTIVITY_PRINCIPAL_KINDS = ['cloud', 'local'];

// --- principal hashing ------------------------------------------------------

const UUID_ACTOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

// local hashes canonical `local:<authenticated-actor-uuid|system>:<producer-id>`
// WITHOUT storing the actor: only the resulting hash ever reaches the ledger.
function localPrincipalSha256(actor, producerId) {
  if (actor !== 'system' && !(typeof actor === 'string' && UUID_ACTOR.test(actor))) {
    throw appendError('principal_invalid_actor', 'local principal actor must be "system" or an authenticated actor UUID');
  }
  if (typeof producerId !== 'string' || !PRODUCER_ID.test(producerId)) {
    throw appendError('principal_invalid_producer', 'local principal producerId must match the producer-id grammar');
  }
  return sha256Hex(`local:${actor}:${producerId}`);
}

// cloud hashes the protected capability identity (see the inference note in
// the file header for the exact input string).
function cloudPrincipalSha256(identitySha256) {
  if (!isSha256Hex(identitySha256)) {
    throw appendError('principal_invalid_identity', 'cloud principal requires the protected capability identity sha256');
  }
  return sha256Hex(`cloud:${identitySha256}`);
}

// --- entry codec ------------------------------------------------------------

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const oneOf = (...values) => (v) => values.includes(v);
const isAdapterId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);

// The exact closed logical-entry schema (12 fields, line 337). Every field
// is required and non-null on the append path: the null command/adapter
// fields of the GENESIS row exist only at initialization (activity-db.js).
const ACTIVITY_ENTRY_FIELDS = {
  generation: { check: isPositiveInt },
  previousGeneration: { check: isNonNegInt },
  previousSha256: { check: isSha256Hex },
  operationId: { check: isOperationId },
  kind: { check: oneOf(...ACTIVITY_KINDS) },
  createdAt: { check: isIsoTimestamp },
  principalKind: { check: oneOf(...ACTIVITY_PRINCIPAL_KINDS) },
  principalSha256: { check: isSha256Hex },
  commandKeySha256: { check: isSha256Hex },
  adapterId: { check: isAdapterId },
  activitySha256: { check: isSha256Hex },
  entrySha256: { check: isSha256Hex },
};

function validateActivityEntry(entry) {
  validateClosedObject(entry, ACTIVITY_ENTRY_FIELDS, 'activity entry');
  if (entry.generation !== entry.previousGeneration + 1) {
    throw appendError('schema_invalid_field', 'activity entry generation must equal previousGeneration + 1', { field: 'generation' });
  }
  if (entry.entrySha256 !== entrySha256For(entry)) {
    throw appendError('schema_invalid_field', 'activity entry entrySha256 does not match its canonical bytes', { field: 'entrySha256' });
  }
  return entry;
}

function buildActivityEntry(fields) {
  const f = fields || {};
  const entry = {
    generation: f.generation,
    previousGeneration: f.previousGeneration,
    previousSha256: f.previousSha256,
    operationId: f.operationId,
    kind: f.kind,
    createdAt: f.createdAt,
    principalKind: f.principalKind,
    principalSha256: f.principalSha256,
    commandKeySha256: f.commandKeySha256,
    adapterId: f.adapterId,
    activitySha256: f.activitySha256,
  };
  entry.entrySha256 = entrySha256For(entry);
  return validateActivityEntry(entry);
}

// --- singleton-head revalidation (shared by append and verification) --------

// revalidateHead(db): the "revalidates the singleton head" step. Confirms:
//   - the singleton row exists,
//   - head.generation is the actual MAX(generation) of activity_chain,
//   - the row at head.generation exists and its entry_sha256 matches the head,
//   - that row's stored entry hash matches its own canonical bytes.
function revalidateHead(db) {
  const head = db.prepare('SELECT * FROM activity_head WHERE id = 1').get();
  if (!head) {
    throw appendError('activity_append_head_invalid', 'activity_head singleton row is missing');
  }
  const max = db.prepare('SELECT MAX(generation) AS m FROM activity_chain').get();
  if (max.m === null || max.m !== head.generation) {
    throw appendError('activity_append_head_invalid', 'activity_head generation does not match the chain maximum', {
      headGeneration: head.generation,
      chainMax: max.m,
    });
  }
  const headEntry = db.prepare('SELECT * FROM activity_chain WHERE generation = ?').get(head.generation);
  if (!headEntry || headEntry.entry_sha256 !== head.entry_sha256) {
    throw appendError('activity_append_head_invalid', 'activity_head entry_sha256 does not match the committed head row');
  }
  const recomputed = entrySha256For({
    generation: headEntry.generation,
    previousGeneration: headEntry.previous_generation,
    previousSha256: headEntry.previous_sha256,
    operationId: headEntry.operation_id,
    kind: headEntry.kind,
    createdAt: headEntry.created_at,
    principalKind: headEntry.principal_kind,
    principalSha256: headEntry.principal_sha256,
    commandKeySha256: headEntry.command_key_sha256,
    adapterId: headEntry.adapter_id,
    activitySha256: headEntry.activity_sha256,
  });
  if (recomputed !== headEntry.entry_sha256) {
    throw appendError('activity_append_head_invalid', 'activity head row entry_sha256 does not match its canonical bytes');
  }
  return { head, headEntry };
}

// --- the durable append -----------------------------------------------------

// appendCommandActivity(args): one committed command-activity row, exactly
// per line 337: BEGIN IMMEDIATE, revalidate singleton head + fixed schema,
// insert next safe-integer generation, update the singleton head and
// rolling segment accumulator, COMMIT under synchronous=FULL, close, reread
// the committed row/head before returning.
//
// Returns { row, headRow } — both REREAD from a fresh read-only connection
// after the writing connection has closed.
//
// args.crashAfter (test-only): named crash boundaries for CP5's crash
// matrix, same pattern as init.js STEPS. 'append_mid_transaction' exits
// while the write transaction is open (leaves a hot journal);
// 'append_db_commit' exits after COMMIT but before the writing connection
// closes/rereads.
function appendCommandActivity(args) {
  const a = args || {};
  const dbPath = a.dbPath;
  if (typeof dbPath !== 'string' || !dbPath) {
    throw appendError('activity_append_invalid_db_path', 'appendCommandActivity requires dbPath');
  }
  // Validate descriptor-level fields BEFORE opening the database, so a
  // malformed request never even takes the write lock.
  if (!isOperationId(a.operationId)) throw appendError('activity_append_invalid_operation_id', 'invalid operationId');
  if (!ACTIVITY_KINDS.includes(a.kind)) throw appendError('schema_invalid_field', 'invalid activity kind', { field: 'kind' });
  if (!ACTIVITY_PRINCIPAL_KINDS.includes(a.principalKind)) throw appendError('schema_invalid_field', 'invalid principalKind', { field: 'principalKind' });
  if (!isSha256Hex(a.principalSha256)) throw appendError('schema_invalid_field', 'invalid principalSha256', { field: 'principalSha256' });
  if (!isSha256Hex(a.commandKeySha256)) throw appendError('schema_invalid_field', 'invalid commandKeySha256', { field: 'commandKeySha256' });
  if (!isAdapterId(a.adapterId)) throw appendError('schema_invalid_field', 'invalid adapterId', { field: 'adapterId' });
  if (!isSha256Hex(a.activitySha256)) throw appendError('schema_invalid_field', 'invalid activitySha256', { field: 'activitySha256' });
  const createdAt = a.createdAt || new Date().toISOString();
  if (!isIsoTimestamp(createdAt)) throw appendError('schema_invalid_field', 'invalid createdAt', { field: 'createdAt' });

  const db = new DatabaseSync(dbPath);
  let entry;
  let pendingCheckpoint = null;
  try {
    // synchronous is per-connection; enforce FULL at open on every module
    // connection (see the pragma note in activity-db.js).
    db.exec('PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      verifyFixedSchema(db);
      const { head } = revalidateHead(db);
      const nextGeneration = head.generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        throw appendError('activity_append_generation_overflow', 'next activity generation is not a safe integer');
      }
      entry = buildActivityEntry({
        generation: nextGeneration,
        previousGeneration: head.generation,
        previousSha256: head.entry_sha256,
        operationId: a.operationId,
        kind: a.kind,
        createdAt,
        principalKind: a.principalKind,
        principalSha256: a.principalSha256,
        commandKeySha256: a.commandKeySha256,
        adapterId: a.adapterId,
        activitySha256: a.activitySha256,
      });
      try {
        db.prepare(
          `INSERT INTO activity_chain
             (generation, previous_generation, previous_sha256, operation_id, kind, created_at,
              principal_kind, principal_sha256, command_key_sha256, adapter_id, activity_sha256, entry_sha256)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          entry.generation,
          entry.previousGeneration,
          entry.previousSha256,
          entry.operationId,
          entry.kind,
          entry.createdAt,
          entry.principalKind,
          entry.principalSha256,
          entry.commandKeySha256,
          entry.adapterId,
          entry.activitySha256,
          entry.entrySha256
        );
      } catch (err) {
        if (/UNIQUE/i.test(String(err.message))) {
          // operation_id is UNIQUE in the retained window: the same
          // operation ID gets no second attempt (line 335).
          throw appendError('activity_append_operation_replayed', `operationId ${a.operationId} was already appended`, {
            operationId: a.operationId,
          });
        }
        throw err;
      }
      const newAccumulator = checkpointCumulativeSha256(head.segment_accumulator_sha256, entry.entrySha256);
      if (entry.generation % CHECKPOINT_INTERVAL === 0) {
        // Checkpoint boundary (plan line 341): the next receipt's content is
        // fully deterministic from committed state, so its binding hash is
        // committed in the SAME transaction as the boundary row — the
        // post-commit file/head/prune sequence can then always be resumed
        // deterministically after any crash.
        const newIndex = head.checkpoint_generation + 1;
        if (entry.generation / CHECKPOINT_INTERVAL !== newIndex) {
          throw appendError('activity_append_head_invalid', 'head checkpoint index is inconsistent with the boundary generation', {
            boundaryGeneration: entry.generation,
            headCheckpointGeneration: head.checkpoint_generation,
          });
        }
        if (newIndex > MAX_CHECKPOINT_RECEIPTS) {
          throw appendError(
            'activity_checkpoint_ceiling_reached',
            `the ${MAX_CHECKPOINT_RECEIPTS}-checkpoint-receipt hard ceiling was reached; a separately reviewed archive format is required, not silent rollover`,
            { checkpointGeneration: newIndex }
          );
        }
        pendingCheckpoint = {
          format: 1,
          checkpointGeneration: newIndex,
          entrySha256: entry.entrySha256,
          previousCheckpointSha256: head.checkpoint_sha256,
          cumulativeSha256: newAccumulator,
          createdAt: entry.createdAt,
        };
        db.prepare(
          `UPDATE activity_head
              SET generation = ?, entry_sha256 = ?, checkpoint_generation = ?, checkpoint_sha256 = ?,
                  segment_count = 1, segment_accumulator_sha256 = ?
            WHERE id = 1`
        ).run(entry.generation, entry.entrySha256, newIndex, sha256Hex(canonicalJson(pendingCheckpoint)), newAccumulator);
      } else {
        db.prepare(
          `UPDATE activity_head
              SET generation = ?, entry_sha256 = ?, segment_count = segment_count + 1, segment_accumulator_sha256 = ?
            WHERE id = 1`
        ).run(entry.generation, entry.entrySha256, newAccumulator);
      }
      if (a.crashAfter === 'append_mid_transaction') {
        // Hard-crash with the write transaction open: leaves a hot journal.
        process.exit(137);
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (_ignored) {
        /* transaction may not have started */
      }
      throw err;
    }
  } finally {
    if (a.crashAfter === 'append_db_commit') {
      // Hard-crash after COMMIT, before close/reread.
      process.exit(137);
    }
    try {
      db.close();
    } catch (_ignored) {
      /* already closed */
    }
  }

  // Reread the committed row/head on a fresh read-only connection before
  // returning (line 337).
  const ro = openReadOnly(dbPath);
  try {
    const row = ro.prepare('SELECT * FROM activity_chain WHERE generation = ?').get(entry.generation);
    const headRow = ro.prepare('SELECT * FROM activity_head WHERE id = 1').get();
    if (!row || row.entry_sha256 !== entry.entrySha256 || !headRow || headRow.generation !== entry.generation) {
      throw appendError('activity_append_reread_mismatch', 'committed activity row/head reread does not match the appended entry');
    }
    return { row, headRow, pendingCheckpoint };
  } finally {
    ro.close();
  }
}

// --- external activity-head witness (plan line 339) -------------------------

// buildExternalActivityHead(headRow): the deterministic external head.json
// content for a committed DB head row. Exactly
// {format:1,generation,entrySha256,checkpointGeneration,checkpointSha256}
// (same literal shape init.js publishes at genesis).
function buildExternalActivityHead(headRow) {
  return {
    format: 1,
    generation: headRow.generation,
    entrySha256: headRow.entry_sha256,
    checkpointGeneration: headRow.checkpoint_generation,
    checkpointSha256: headRow.checkpoint_sha256,
  };
}

function publishExternalActivityHead(roots, headRow, ownershipAdapter) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const headObj = buildExternalActivityHead(headRow);
  atomicReplaceFile(roots.activityHeadPath, Buffer.from(canonicalJson(headObj), 'utf8'), adapter);
  return headObj;
}

function readExternalHeadFile(activityHeadPath) {
  let raw;
  try {
    raw = fs.readFileSync(activityHeadPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    throw appendError('activity_external_head_malformed', 'external activity head.json is not valid JSON');
  }
  if (
    !parsed ||
    parsed.format !== 1 ||
    !isNonNegInt(parsed.generation) ||
    !isSha256Hex(parsed.entrySha256) ||
    !isNonNegInt(parsed.checkpointGeneration) ||
    !isSha256Hex(parsed.checkpointSha256)
  ) {
    throw appendError('activity_external_head_malformed', 'external activity head.json does not match the exact head schema');
  }
  return parsed;
}

// ensureCheckpointReceiptForHead: before publishing an external head that
// binds checkpoint K, make sure the receipt file for K exists. Missing
// receipts are rebuilt DETERMINISTICALLY:
//   - K=0 from the genesis row (a crash between activity-database creation
//     and receipt write);
//   - K>0 from the retained boundary row + the on-disk receipt K-1 (a
//     crash between the boundary commit and the receipt write). The
//     rebuilt receipt's canonical hash must equal the head row's committed
//     checkpoint_sha256 — the boundary transaction committed that binding
//     hash precisely so this rebuild can be verified, never guessed.
// A K>0 rebuild is only possible while the head still sits exactly on the
// boundary generation (the accumulator has not rolled past); any other
// missing-receipt state blocks.
function ensureCheckpointReceiptForHead(roots, db, headRow, adapter) {
  const receiptPath = path.join(roots.checkpointsDir, generationFilename(headRow.checkpoint_generation));
  if (fs.existsSync(receiptPath)) return;
  if (headRow.checkpoint_generation === 0) {
    const genesisRow = db.prepare('SELECT * FROM activity_chain WHERE generation = 0').get();
    if (!genesisRow) {
      throw appendError('activity_repair_checkpoint_missing', 'cannot rebuild checkpoint 0: genesis row is not retained');
    }
    ensureModeDirRecursive(roots.checkpointsDir, adapter, { enforceFrom: roots.activityHeadWitnessRoot });
    const checkpoint = buildGenesisCheckpoint({ entrySha256: genesisRow.entry_sha256, createdAt: genesisRow.created_at });
    writeExclusiveFile(receiptPath, Buffer.from(canonicalJson(checkpoint), 'utf8'), adapter);
    return;
  }
  const kIdx = headRow.checkpoint_generation;
  const boundaryGeneration = kIdx * CHECKPOINT_INTERVAL;
  if (headRow.generation !== boundaryGeneration) {
    throw appendError('activity_repair_checkpoint_missing', 'cannot rebuild the missing checkpoint receipt: the head has moved past the boundary', {
      checkpointGeneration: kIdx,
      headGeneration: headRow.generation,
    });
  }
  const boundaryRow = db.prepare('SELECT * FROM activity_chain WHERE generation = ?').get(boundaryGeneration);
  if (!boundaryRow) {
    throw appendError('activity_repair_checkpoint_missing', 'cannot rebuild the missing checkpoint receipt: the boundary row is not retained', {
      checkpointGeneration: kIdx,
    });
  }
  const prevReceiptPath = path.join(roots.checkpointsDir, generationFilename(kIdx - 1));
  let prevRaw;
  try {
    prevRaw = fs.readFileSync(prevReceiptPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw appendError('activity_checkpoint_chain_broken', 'cannot rebuild the missing checkpoint receipt: its predecessor receipt is also missing', {
        checkpointGeneration: kIdx,
      });
    }
    throw err;
  }
  const rebuilt = {
    format: 1,
    checkpointGeneration: kIdx,
    entrySha256: boundaryRow.entry_sha256,
    previousCheckpointSha256: sha256Hex(canonicalJson(JSON.parse(prevRaw))),
    cumulativeSha256: headRow.segment_accumulator_sha256,
    createdAt: boundaryRow.created_at,
  };
  if (sha256Hex(canonicalJson(rebuilt)) !== headRow.checkpoint_sha256) {
    throw appendError('activity_checkpoint_rebuild_mismatch', 'the deterministically rebuilt checkpoint receipt does not match the committed head binding hash', {
      checkpointGeneration: kIdx,
    });
  }
  ensureModeDirRecursive(roots.checkpointsDir, adapter, { enforceFrom: roots.activityHeadWitnessRoot });
  writeExclusiveOrVerify(receiptPath, Buffer.from(canonicalJson(rebuilt), 'utf8'), adapter, 'activity_checkpoint_resume_mismatch');
  fsyncFile(receiptPath);
  fsyncDir(roots.checkpointsDir);
}

// pruneAndVacuum: "then deletes rows older than the previous checkpoint and
// runs bounded incremental_vacuum" — for latest checkpoint index K, rows
// with generation < (K-1)*4096 are deleted (the previous checkpoint's own
// boundary row is retained). Idempotent, so crash recovery simply re-runs
// it. Never touches checkpoint receipts.
function pruneAndVacuum(dbPath, checkpointIndex, crashAfter) {
  const cutoff = (checkpointIndex - 1) * CHECKPOINT_INTERVAL;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (cutoff > 0) {
        db.prepare('DELETE FROM activity_chain WHERE generation < ?').run(cutoff);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (crashAfter === 'prune_done') {
      process.exit(137);
    }
    db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGE_BUDGET});`);
    if (crashAfter === 'incremental_vacuum_done') {
      process.exit(137);
    }
  } finally {
    try {
      db.close();
    } catch (_ignored) {
      /* already closed */
    }
  }
  const size = fs.statSync(dbPath).size;
  if (size > MAX_ACTIVITY_DB_BYTES) {
    throw appendError('activity_db_size_exceeded', `activity database exceeds the ${MAX_ACTIVITY_DB_BYTES}-byte bound after prune/vacuum`, { size });
  }
}

// completeCheckpointSequence: the exact post-commit order of plan line 341 —
// O_EXCL-write/fsync the receipt, update/fsync the external head to bind
// it, then prune + bounded incremental_vacuum. Every step is deterministic
// and idempotent, so any crash inside it is completed by
// reconcileExternalActivityHead on the next operation.
function completeCheckpointSequence(roots, { receipt, headRow, ownershipAdapter, crashAfter }) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const receiptPath = path.join(roots.checkpointsDir, generationFilename(receipt.checkpointGeneration));
  writeExclusiveOrVerify(receiptPath, Buffer.from(canonicalJson(receipt), 'utf8'), adapter, 'activity_checkpoint_resume_mismatch');
  fsyncFile(receiptPath);
  fsyncDir(roots.checkpointsDir);
  if (crashAfter === 'checkpoint_receipt_written') {
    process.exit(137);
  }
  publishExternalActivityHead(roots, headRow, adapter);
  if (crashAfter === 'checkpoint_head_published') {
    process.exit(137);
  }
  pruneAndVacuum(roots.activityDbPath, receipt.checkpointGeneration, crashAfter);
}

// reconcileExternalActivityHead(roots): the line-339 rule, run under the
// stable activity lock before any command work (runExclusiveActivityAppend
// holds it; loadProtocolState's repair path and direct maintenance callers
// are single-actor by construction). The database may be exactly one
// generation ahead of external head.json after a crash: recompute that one
// row, verify its predecessor equals the external head, and publish only
// that deterministic next head. Any larger gap, external head ahead, hash
// mismatch, or database rollback below the external generation blocks.
function reconcileExternalActivityHead(roots, options) {
  const opts = options || {};
  const adapter = opts.ownershipAdapter || defaultOwnershipAdapter;
  recoverHotJournalIfPresent({ dbPath: roots.activityDbPath, ownershipAdapter: adapter, recoveryOnlyAdapter: opts.recoveryOnlyAdapter });
  const db = openReadOnly(roots.activityDbPath);
  let maintenance = null;
  let result;
  try {
    result = reconcileWithOpenDb(roots, db, adapter);
    // Crash-recovery completion for the prune step (plan line 341 order:
    // receipt, head, THEN prune/vacuum): if rows older than the previous
    // checkpoint boundary are still retained, the prune was interrupted —
    // finish it now, before any command work. O(1) detection (MIN over the
    // integer primary key), only ever runs real work after a crash.
    const head = db.prepare('SELECT checkpoint_generation FROM activity_head WHERE id = 1').get();
    if (head && head.checkpoint_generation > 0) {
      const cutoff = (head.checkpoint_generation - 1) * CHECKPOINT_INTERVAL;
      const min = db.prepare('SELECT MIN(generation) AS lo FROM activity_chain').get();
      if (min && min.lo !== null && min.lo < cutoff) {
        maintenance = { checkpointIndex: head.checkpoint_generation };
      }
    }
  } finally {
    db.close();
  }
  if (maintenance) {
    pruneAndVacuum(roots.activityDbPath, maintenance.checkpointIndex, null);
    result = Object.assign({}, result, { prunedPendingWindow: true });
  }
  return result;
}

function reconcileWithOpenDb(roots, db, adapter) {
  {
    const { head } = revalidateHead(db);
    const externalHead = readExternalHeadFile(roots.activityHeadPath);

    if (externalHead === null) {
      if (head.generation !== 0) {
        throw appendError('activity_external_head_missing', 'activity database has committed generations but the external head witness is missing');
      }
      ensureCheckpointReceiptForHead(roots, db, head, adapter);
      return { reconciled: true, published: publishExternalActivityHead(roots, head, adapter) };
    }

    if (externalHead.generation > head.generation) {
      throw appendError('activity_database_rollback', 'activity database generation is behind the external head witness', {
        dbGeneration: head.generation,
        externalHeadGeneration: externalHead.generation,
      });
    }
    if (head.generation - externalHead.generation > 1) {
      throw appendError('activity_head_gap_too_large', 'activity database is more than one generation ahead of the external head witness', {
        dbGeneration: head.generation,
        externalHeadGeneration: externalHead.generation,
      });
    }
    if (head.generation === externalHead.generation) {
      if (externalHead.entrySha256 !== head.entry_sha256) {
        throw appendError('activity_external_head_hash_mismatch', 'external head entrySha256 does not match the committed database row');
      }
      return { reconciled: false };
    }

    // Exactly one ahead. "Recomputes that one row": the pending row IS the
    // database head row, and revalidateHead above already reread it and
    // recomputed its canonical entry hash (a corrupted pending row throws
    // activity_append_head_invalid there before reaching this point).
    const pending = db.prepare('SELECT * FROM activity_chain WHERE generation = ?').get(head.generation);
    // "...verify its predecessor equals the external head..."
    if (pending.previous_sha256 !== externalHead.entrySha256 || pending.previous_generation !== externalHead.generation) {
      throw appendError('activity_external_head_predecessor_mismatch', 'the one-ahead pending row does not chain from the published external head', {
        pendingGeneration: pending.generation,
        externalHeadGeneration: externalHead.generation,
      });
    }
    // ...and publish only that deterministic next head.
    ensureCheckpointReceiptForHead(roots, db, head, adapter);
    return { reconciled: true, published: publishExternalActivityHead(roots, head, adapter) };
  }
}

// --- the locked witnessed append --------------------------------------------

// appendActivityWithExternalHead(args): reconcile (one-ahead recovery) +
// append + external head publication. The caller MUST already hold the
// stable activity lock (runExclusiveActivityAppend below, or the witnessed
// operation runner). crashAfter boundaries: append_mid_transaction,
// append_db_commit (inside appendCommandActivity), external_head_published.
function appendActivityWithExternalHead(args) {
  const a = args || {};
  const roots = a.roots || resolveRoots(a.opts || {});
  const adapter = a.ownershipAdapter || defaultOwnershipAdapter;
  reconcileExternalActivityHead(roots, { ownershipAdapter: adapter, recoveryOnlyAdapter: a.recoveryOnlyAdapter });
  const res = appendCommandActivity(Object.assign({}, a, { dbPath: roots.activityDbPath }));
  if (res.pendingCheckpoint) {
    // Boundary append: receipt first, then the external head binds it,
    // then prune + bounded vacuum (plan line 341's exact order).
    completeCheckpointSequence(roots, {
      receipt: res.pendingCheckpoint,
      headRow: res.headRow,
      ownershipAdapter: adapter,
      crashAfter: a.crashAfter,
    });
  } else {
    publishExternalActivityHead(roots, res.headRow, adapter);
  }
  if (a.crashAfter === 'external_head_published') {
    process.exit(137);
  }
  return res;
}

// --- maintenance full audit (plan line 341) --------------------------------

// fullAuditActivityChain: "A maintenance/full-audit verb streams the
// checkpoint chain with a 120-second wall watchdog before deployment
// evidence, while normal polling stays bounded." This is the ONLY code
// path allowed to enumerate the checkpoint directory; every runtime path
// reads receipts by computed filename. Verifies contiguous numbering from
// 0, every previous-checkpoint link hash, receipt file modes/ownership,
// and that the latest receipt is the one bound by both the external head
// and the database head row. Per-receipt cumulative hashes bind pruned
// segment rows and are therefore verifiable only for receipts whose
// segment is still retained — that binding is checked at write/rebuild
// time and by the bounded runtime verifier for the current segment.
function fullAuditActivityChain(roots, options) {
  const opts = options || {};
  const adapter = opts.ownershipAdapter || defaultOwnershipAdapter;
  const watchdogMs = Number.isFinite(opts.watchdogMs) ? opts.watchdogMs : FULL_AUDIT_WATCHDOG_MS;
  const startedAt = Date.now();
  const checkWatchdog = () => {
    if (Date.now() - startedAt > watchdogMs) {
      throw appendError('activity_audit_watchdog_exceeded', `full activity audit exceeded its ${watchdogMs} ms wall watchdog`);
    }
  };
  const entries = listRegularEntries(roots.checkpointsDir, /^\d{16}\.json$/);
  if (entries.length === 0) {
    throw appendError('activity_audit_no_receipts', 'full activity audit found no checkpoint receipts');
  }
  let previousSha = null;
  let latest = null;
  let latestSha = null;
  for (let i = 0; i < entries.length; i += 1) {
    checkWatchdog();
    const entry = entries[i];
    const index = Number.parseInt(entry.name.slice(0, 16), 10);
    if (index !== i) {
      throw appendError('activity_checkpoint_gap', 'checkpoint receipt numbering has a gap or does not start at 0', { index, position: i });
    }
    if ((entry.stat.mode & 0o777) !== FILE_MODE) {
      throw appendError('chain_entry_wrong_mode', `checkpoint receipt ${entry.name} is not mode 0600`, { path: entry.path });
    }
    if (!adapter.verifyOwner(entry.stat)) {
      throw appendError('chain_entry_wrong_owner', `checkpoint receipt ${entry.name} is not owned by the service identity`, { path: entry.path });
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
    } catch (_err) {
      throw appendError('activity_checkpoint_malformed', `checkpoint receipt ${entry.name} is not valid JSON`, { path: entry.path });
    }
    if (
      !parsed || parsed.format !== 1 || parsed.checkpointGeneration !== index ||
      !isSha256Hex(parsed.entrySha256) || !isSha256Hex(parsed.cumulativeSha256) || !isIsoTimestamp(parsed.createdAt)
    ) {
      throw appendError('activity_checkpoint_malformed', `checkpoint receipt ${entry.name} does not match the exact receipt schema`, { path: entry.path });
    }
    if (index === 0) {
      if (parsed.previousCheckpointSha256 !== null) {
        throw appendError('activity_checkpoint_fork', 'checkpoint 0 must have null previousCheckpointSha256');
      }
    } else if (parsed.previousCheckpointSha256 !== previousSha) {
      throw appendError('activity_checkpoint_fork', `checkpoint ${entry.name} previousCheckpointSha256 does not match its actual predecessor`, {
        index,
      });
    }
    latest = parsed;
    latestSha = sha256Hex(canonicalJson(parsed));
    previousSha = latestSha;
  }
  checkWatchdog();
  // The latest receipt must be the one both heads bind.
  const externalHead = readExternalHeadFile(roots.activityHeadPath);
  if (!externalHead || externalHead.checkpointGeneration !== latest.checkpointGeneration || externalHead.checkpointSha256 !== latestSha) {
    throw appendError('activity_audit_head_mismatch', 'the external head does not bind the latest checkpoint receipt', {
      latestCheckpointGeneration: latest.checkpointGeneration,
    });
  }
  const db = openReadOnly(roots.activityDbPath);
  try {
    const head = db.prepare('SELECT * FROM activity_head WHERE id = 1').get();
    if (!head || head.checkpoint_generation !== latest.checkpointGeneration || head.checkpoint_sha256 !== latestSha) {
      throw appendError('activity_audit_head_mismatch', 'the database head row does not bind the latest checkpoint receipt', {
        latestCheckpointGeneration: latest.checkpointGeneration,
      });
    }
  } finally {
    db.close();
  }
  return { ok: true, receiptCount: entries.length, latestCheckpointGeneration: latest.checkpointGeneration, elapsedMs: Date.now() - startedAt };
}

// runExclusiveActivityAppend(args): self-locking wrapper — acquires the
// stable activity lock (both activity roots, fixed order), reconciles,
// appends, publishes the external head, releases. Stale locks are
// reconciled per line 353: the chain is verified (which itself completes
// the only deterministic proposal an activity append can leave behind, the
// one-ahead external-head publication) before the stale lock is removed;
// an activity append has no other resumable proposal shape because the
// SQLite transaction is atomic.
function runExclusiveActivityAppend(args) {
  const a = args || {};
  const roots = a.roots || resolveRoots(a.opts || {});
  const adapter = a.ownershipAdapter || defaultOwnershipAdapter;
  const lock = acquireActivityRootLocks(
    roots,
    {
      operationId: a.operationId,
      sourceKind: 'witnessed-append',
      sourceAuthority: null,
      headIdentities: {},
      typedReceiptSha256: null,
    },
    {
      bootId: a.bootId,
      isProcessAlive: a.isProcessAlive,
      ownershipAdapter: adapter,
      reconcile: {
        verifyChain: () => reconcileExternalActivityHead(roots, { ownershipAdapter: adapter, recoveryOnlyAdapter: a.recoveryOnlyAdapter }),
        findProposalForOperation: () => null,
      },
    }
  );
  try {
    return appendActivityWithExternalHead(Object.assign({}, a, { roots, ownershipAdapter: adapter }));
  } finally {
    lock.release();
  }
}

module.exports = {
  appendError,
  CHECKPOINT_INTERVAL,
  MAX_RETAINED_ROWS,
  MAX_ACTIVITY_DB_BYTES,
  MAX_CHECKPOINT_RECEIPTS,
  INCREMENTAL_VACUUM_PAGE_BUDGET,
  FULL_AUDIT_WATCHDOG_MS,
  ACTIVITY_KINDS,
  ACTIVITY_PRINCIPAL_KINDS,
  isAdapterId,
  localPrincipalSha256,
  cloudPrincipalSha256,
  buildActivityEntry,
  validateActivityEntry,
  revalidateHead,
  appendCommandActivity,
  buildExternalActivityHead,
  publishExternalActivityHead,
  readExternalHeadFile,
  ensureCheckpointReceiptForHead,
  pruneAndVacuum,
  completeCheckpointSequence,
  reconcileExternalActivityHead,
  appendActivityWithExternalHead,
  runExclusiveActivityAppend,
  fullAuditActivityChain,
};
