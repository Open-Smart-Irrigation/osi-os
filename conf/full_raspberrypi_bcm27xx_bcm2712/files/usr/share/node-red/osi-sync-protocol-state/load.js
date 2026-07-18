'use strict';
// osi-sync-protocol-state/load.js — load verification for all four roots.
//
// Plan facts encoded here (line 351, plus the capability-crash rules of
// line 353): "Every load independently enumerates lstat-regular capability
// generations and witnesses and verifies both complete file chains...
// checks fixed schema/pragmas, runs quick_check, verifies the independent
// external head/checkpoint plus only the bounded retained segment,
// requires one same-number capability witness for every capability
// generation with exact hashes/operation IDs, verifies every reset,
// historical-v2-disposition, or database-restore receipt against its
// typed generation, and requires each head to identify its highest
// committed hash. Replacing a head with an older valid pointer, deleting a
// tail and restoring its older head, rolling back any one root, inserting
// a fork/gap, removing a referenced typed receipt/generation/witness,
// corrupting or replacing the activity database, or replaying an operation
// blocks polling."
//
// GENESIS initialization and activity one-ahead states have generic repair
// here. Purpose-specific transition writers retain authority for validating
// any non-GENESIS proposal before completing it.

const fs = require('node:fs');
const path = require('node:path');
const {
  codecError,
  canonicalJson,
  sha256Hex,
  canonicalSha256,
  validateGeneration,
  validateWitness,
  validateCapabilityHead,
} = require('./codecs');
const {
  resolveRoots,
  listRegularEntries,
  assertNoSymlinkComponents,
  atomicReplaceFile,
  writeExclusiveFile,
  generationFilename,
  defaultOwnershipAdapter,
  FILE_MODE,
} = require('./paths');
const {
  recoverHotJournalIfPresent,
  openReadOnly,
  verifyFixedSchema,
  quickCheck,
  readGenesisRow,
  checkpointCumulativeSha256,
} = require('./activity-db');
const {
  CHECKPOINT_INTERVAL,
  MAX_RETAINED_ROWS,
  MAX_ACTIVITY_DB_BYTES,
  MAX_CHECKPOINT_RECEIPTS,
  revalidateHead,
  readExternalHeadFile,
} = require('./activity-append');

function loadError(code, message, extra) {
  return codecError(code, message, extra);
}

const CHAIN_ENTRY_PATTERN = /^\d{16}\.json$/;

function generationNumberFromFilename(name) {
  return Number.parseInt(name.slice(0, 16), 10);
}

function assertModeAndOwner(entry, ownershipAdapter, label) {
  if ((entry.stat.mode & 0o777) !== FILE_MODE) {
    throw loadError('chain_entry_wrong_mode', `${label} ${entry.name} is not mode 0600`, { path: entry.path });
  }
  if (!ownershipAdapter.verifyOwner(entry.stat)) {
    throw loadError('chain_entry_wrong_owner', `${label} ${entry.name} is not owned by the service identity`, { path: entry.path });
  }
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (_err) {
    throw loadError('chain_entry_malformed_json', `not valid JSON: ${filePath}`, { path: filePath });
  }
}

function readTypedReceipt(filePath, adapter, label) {
  assertNoSymlinkComponents(filePath);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw loadError('typed_receipt_missing', `${label} is missing`, { path: filePath });
    }
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw loadError('typed_receipt_wrong_type', `${label} is not a regular nonsymlink file`, { path: filePath });
  }
  assertModeAndOwner({ name: path.basename(filePath), path: filePath, stat }, adapter, label);
  return readJsonFile(filePath);
}

function verifyTypedReceipts(roots, generations, adapter) {
  for (const entry of generations) {
    const generation = entry.generation;
    if (generation.kind === 'GENESIS' || generation.kind === 'NEGOTIATED') continue;
    let receiptPath;
    let expectedSha256 = null;
    if (generation.kind === 'HISTORICAL_V2_DISPOSITION') {
      receiptPath = path.join(roots.v2DispositionReceiptsDir, `${generation.operationId}.json`);
      expectedSha256 = generation.state.historicalV2DispositionReceiptSha256;
    } else if (generation.kind === 'RESET_AUTHORIZATION') {
      receiptPath = path.join(roots.resetReceiptsDir, `${generation.state.authorizationId}.json`);
      expectedSha256 = generation.state.resetReceiptSha256;
    } else if (generation.kind === 'DATABASE_RESTORE_INVALIDATION') {
      receiptPath = path.join(roots.databaseRestoreReceiptsDir, `${generation.state.databaseRestore.restoreEpoch}.invalidation.json`);
      expectedSha256 = generation.state.invalidationReceiptSha256;
    } else if (generation.kind === 'DATABASE_RESTORE_RECONCILED') {
      receiptPath = path.join(roots.databaseRestoreReceiptsDir, `${generation.state.databaseRestore.restoreEpoch}.reconciled.json`);
      expectedSha256 = generation.state.reconciledReceiptSha256;
    } else if (generation.kind === 'DATABASE_INTEGRITY_INVALIDATION') {
      receiptPath = path.join(roots.databaseIntegrityReceiptsDir, `${generation.state.databaseRestore.restoreEpoch}.invalidation.json`);
      expectedSha256 = generation.state.invalidationReceiptSha256;
    } else if (generation.kind === 'DATABASE_INTEGRITY_RECONCILED') {
      receiptPath = path.join(roots.databaseIntegrityReceiptsDir, `${generation.state.databaseRestore.restoreEpoch}.reconciled.json`);
      expectedSha256 = generation.state.reconciledReceiptSha256;
    }
    const receipt = readTypedReceipt(receiptPath, adapter, `${generation.kind} typed receipt`);
    if (receipt.operationId !== generation.operationId) {
      throw loadError('typed_receipt_operation_mismatch', `${generation.kind} typed receipt operationId does not match its generation`, {
        path: receiptPath,
      });
    }
    if (expectedSha256 !== null && canonicalSha256(receipt) !== expectedSha256) {
      throw loadError('typed_receipt_hash_mismatch', `${generation.kind} typed receipt hash does not match its generation`, {
        path: receiptPath,
      });
    }
    if (generation.kind === 'RESET_AUTHORIZATION') {
      const state = generation.state;
      if (
        receipt.authorizationId !== state.authorizationId ||
        receipt.confirmationSha256 !== state.confirmationSha256 ||
        receipt.fromIdentitySha256 !== state.fromIdentitySha256 ||
        receipt.toIdentitySha256 !== state.toIdentitySha256 ||
        receipt.resetEpoch !== state.resetEpoch ||
        receipt.resetAuthorizedAt !== state.resetAuthorizedAt ||
        receipt.resetReasonSha256 !== state.resetReasonSha256
      ) {
        throw loadError('typed_receipt_state_mismatch', 'RESET_AUTHORIZATION receipt does not bind the generation state', {
          path: receiptPath,
        });
      }
    }
  }
}

// verifyCapabilityChain: enumerates+validates the full generation/witness
// chain from 0 upward. Returns a rich result describing head status and,
// when applicable, a GENESIS-adjacent resumable gap.
function verifyCapabilityChain(roots, { ownershipAdapter } = {}) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const generationEntries = listRegularEntries(roots.generationsDir, CHAIN_ENTRY_PATTERN);
  const witnessEntries = listRegularEntries(roots.witnessRoot, CHAIN_ENTRY_PATTERN);

  if (generationEntries.length === 0 && witnessEntries.length === 0 && !fs.existsSync(roots.capabilityHeadPath)) {
    return { present: false };
  }

  // Gap / grammar check on generation numbers: must be exactly 0..N-1.
  const genNumbers = generationEntries.map((e) => generationNumberFromFilename(e.name));
  for (let i = 0; i < genNumbers.length; i += 1) {
    if (genNumbers[i] !== i) {
      throw loadError('capability_generation_gap', 'capability generation numbering has a gap or does not start at 0', { genNumbers });
    }
  }
  if (genNumbers.length === 0) {
    throw loadError('capability_generations_missing', 'capability witness/head present but no generation files exist');
  }

  const generations = [];
  const operationIdsSeen = new Set();
  let previousHash = null;
  for (const entry of generationEntries) {
    assertModeAndOwner(entry, adapter, 'capability generation');
    const parsed = readJsonFile(entry.path);
    const generation = validateGeneration(parsed);
    if (generation.generation === 0) {
      if (generation.previousGeneration !== null || generation.previousSha256 !== null) {
        throw loadError('capability_generation_fork', 'GENESIS must have null previous fields');
      }
    } else {
      if (generation.previousGeneration !== generation.generation - 1) {
        throw loadError('capability_generation_gap', `generation ${generation.generation} has an inconsistent previousGeneration`);
      }
      if (generation.previousSha256 !== previousHash) {
        throw loadError('capability_generation_fork', `generation ${generation.generation} previousSha256 does not match the actual hash of its predecessor`, {
          generation: generation.generation,
        });
      }
    }
    if (operationIdsSeen.has(generation.operationId)) {
      throw loadError('capability_generation_replay', `operationId ${generation.operationId} is reused across generations`, {
        operationId: generation.operationId,
      });
    }
    operationIdsSeen.add(generation.operationId);
    const generationSha256 = canonicalSha256(generation);
    generations.push({ generation, generationSha256, path: entry.path });
    previousHash = generationSha256;
  }

  // Witness chain: same-number witness required for every generation
  // except possibly the single highest one (GENESIS-adjacent resume case,
  // handled below).
  const witnessByGeneration = new Map();
  let previousWitnessHash = null;
  const witnessNumbers = witnessEntries.map((e) => generationNumberFromFilename(e.name));
  for (let i = 0; i < witnessNumbers.length; i += 1) {
    if (witnessNumbers[i] !== i) {
      throw loadError('capability_witness_gap', 'capability witness numbering has a gap or does not start at 0', { witnessNumbers });
    }
  }
  for (const entry of witnessEntries) {
    assertModeAndOwner(entry, adapter, 'capability witness');
    const parsed = readJsonFile(entry.path);
    const witness = validateWitness(parsed);
    const witnessGenNumber = generationNumberFromFilename(entry.name);
    const matchingGeneration = generations[witnessGenNumber];
    if (!matchingGeneration) {
      throw loadError('capability_witness_orphan', `witness ${entry.name} has no matching generation file`);
    }
    if (witness.generation !== witnessGenNumber || witness.generationSha256 !== matchingGeneration.generationSha256) {
      throw loadError('capability_witness_hash_mismatch', `witness ${entry.name} does not match its generation's exact hash`);
    }
    if (witness.operationId !== matchingGeneration.generation.operationId) {
      throw loadError('capability_witness_operation_id_mismatch', `witness ${entry.name} operationId does not match its generation`);
    }
    if (witnessGenNumber === 0) {
      if (witness.previousWitnessSha256 !== null) {
        throw loadError('capability_witness_fork', 'GENESIS witness must have null previousWitnessSha256');
      }
    } else if (witness.previousWitnessSha256 !== previousWitnessHash) {
      throw loadError('capability_witness_fork', `witness ${entry.name} previousWitnessSha256 does not match the actual predecessor witness hash`);
    }
    const witnessSha256 = canonicalSha256(witness);
    witnessByGeneration.set(witnessGenNumber, { witness, witnessSha256, path: entry.path });
    previousWitnessHash = witnessSha256;
  }

  const maxGeneration = generations.length - 1;
  const maxWitness = witnessByGeneration.size - 1; // -1 if none; contiguous from 0 enforced above
  const proposalKind = generations[maxGeneration].generation.kind;
  const purposeResumableKind = proposalKind !== 'GENESIS' && proposalKind !== 'NEGOTIATED';

  // Bidirectional generation/witness set equality (review IMPORTANT 1):
  // every generation must have exactly one same-number witness AND every
  // witness exactly one same-number generation, and the head must identify
  // the max of the UNION of both sets. Uniqueness and contiguity are
  // enforced by the numbering checks above; a witness with no same-number
  // generation (orphan witness — the surviving evidence of a
  // generation-root-only rollback, plan line 351 "deleting a tail and
  // restoring its older head") was already rejected inside the witness
  // loop via capability_witness_orphan. Here we enforce the other
  // direction: a generation with no same-number witness (orphan generation
  // above the witness chain — the surviving evidence of a
  // witness-root-only rollback) blocks, with exactly one exception: the
  // GENESIS-adjacent WITNESS_CREATION resume state (generation 0 written,
  // witness and head not yet created — a crash between the genesis write
  // and its witness write during initialization).
  //
  // Deliberately NOT detected: a CONSISTENT rollback of the generation
  // root, the witness root, AND the head together is byte-for-byte
  // indistinguishable from a chain that legitimately never advanced, and
  // plan line 352 places it outside the software-only threat model ("A
  // privileged actor that consistently rolls back all independent roots is
  // outside the software-only threat model and requires a hardware
  // monotonic counter or external witness"). See the pinning test in
  // index.test.js.
  const singleMissingTopWitness = maxWitness === maxGeneration - 1;
  if (maxWitness < maxGeneration) {
    if (maxGeneration === 0 && maxWitness === -1 && !fs.existsSync(roots.capabilityHeadPath)) {
      return {
        present: true,
        generations,
        witnessByGeneration,
        head: null,
        maxGeneration,
        resumable: { kind: 'WITNESS_CREATION', targetGeneration: 0 },
      };
    }
    if (!singleMissingTopWitness || !purposeResumableKind) {
      throw loadError('capability_witness_missing', 'more than one capability generation lacks a same-number witness', {
        maxGeneration,
        maxWitness,
      });
    }
  }
  // maxWitness > maxGeneration is impossible here: every witness was
  // required to match a same-number generation inside the loop above
  // (capability_witness_orphan otherwise), so from this point the two sets
  // are equal and chainMax is the max of their union.
  const chainMax = maxGeneration;

  const head = readJsonFile(roots.capabilityHeadPath);
  let headRecord = null;
  if (head !== null) {
    headRecord = validateCapabilityHead(head);
    const matching = generations[headRecord.generation];
    if (!matching || matching.generationSha256 !== headRecord.generationSha256) {
      throw loadError('capability_head_hash_mismatch', 'capability head.json does not match any on-disk generation hash');
    }
    const witnessRecord = witnessByGeneration.get(headRecord.generation);
    if (!witnessRecord || witnessRecord.witnessSha256 !== headRecord.witnessSha256) {
      throw loadError('capability_head_witness_mismatch', 'capability head.json witnessSha256 does not match the on-disk witness');
    }
    if (headRecord.generation < chainMax) {
      // The head must identify the highest committed pair (the max of the
      // generation/witness union). Only the GENESIS-adjacent
      // single-unheaded-proposal resume is implemented in this slice
      // (brief: "Single-valid-unheaded-proposal resume rules implemented
      // for GENESIS-adjacent states"); every other stale-head state — even
      // a fully witnessed one — is indistinguishable from an attacker
      // replacing head.json with an older-but-still-valid pointer and
      // blocks rather than resumes.
      if (headRecord.generation !== chainMax - 1 || !purposeResumableKind) {
        throw loadError('capability_head_rollback', 'capability head.json does not identify the highest committed generation/witness pair', {
          headGeneration: headRecord.generation,
          chainMax,
        });
      }
      // Resumable: exactly one validated proposal is ahead of the current
      // head. Its purpose-specific verb must revalidate source authority
      // before creating a missing receipt/witness or publishing the head.
      return {
        present: true,
        generations,
        witnessByGeneration,
        head: headRecord,
        maxGeneration,
        resumable: {
          kind: witnessByGeneration.has(chainMax) ? 'HEAD_PUBLICATION' : 'WITNESS_CREATION',
          targetGeneration: chainMax,
        },
      };
    }
  } else if (chainMax === 0) {
    // Generation 0 + witness 0 exist, head absent: resumable head
    // publication (GENESIS-adjacent case explicitly named in the brief).
    // (The generation-without-witness variant returned WITNESS_CREATION
    // above, before the head was even considered.)
    return {
      present: true,
      generations,
      witnessByGeneration,
      head: null,
      maxGeneration,
      resumable: { kind: 'HEAD_PUBLICATION', targetGeneration: 0 },
    };
  } else {
    throw loadError('capability_head_missing', 'capability head.json is missing but more than one generation/witness pair exists');
  }

  verifyTypedReceipts(roots, generations, adapter);
  return { present: true, generations, witnessByGeneration, head: headRecord, maxGeneration, resumable: null };
}

// repairCapabilityChain: completes exactly the two GENESIS-adjacent resume
// points identified above. Never touches non-GENESIS generations (brief:
// "disposition/reset/restore resume branches validate-and-block").
function repairCapabilityChain(roots, chainResult, { ownershipAdapter } = {}) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  if (!chainResult.resumable) return chainResult;
  if (chainResult.resumable.targetGeneration !== 0) {
    throw loadError('capability_resume_out_of_scope', 'resume for a non-GENESIS generation is validate-and-block only in this slice', {
      resumable: chainResult.resumable,
    });
  }
  if (chainResult.resumable.kind === 'HEAD_PUBLICATION') {
    const top = chainResult.generations[chainResult.resumable.targetGeneration];
    const witnessRecord = chainResult.witnessByGeneration.get(chainResult.resumable.targetGeneration);
    const { buildCapabilityHead } = require('./codecs');
    const headObj = buildCapabilityHead({
      generation: top.generation.generation,
      generationSha256: top.generationSha256,
      witnessSha256: witnessRecord.witnessSha256,
    });
    atomicReplaceFile(roots.capabilityHeadPath, Buffer.from(canonicalJson(headObj), 'utf8'), adapter);
    return verifyCapabilityChain(roots, { ownershipAdapter: adapter });
  }
  if (chainResult.resumable.kind === 'WITNESS_CREATION') {
    const top = chainResult.generations[chainResult.resumable.targetGeneration];
    const { buildGenesisWitness } = require('./codecs');
    const witnessObj = buildGenesisWitness({
      generationSha256: top.generationSha256,
      operationId: top.generation.operationId,
    });
    writeExclusiveFile(
      path.join(roots.witnessRoot, '0000000000000000.json'),
      Buffer.from(canonicalJson(witnessObj), 'utf8'),
      adapter
    );
    return verifyCapabilityChain(roots, { ownershipAdapter: adapter });
  }
  throw loadError('capability_resume_unknown_kind', 'unknown resumable kind', { resumable: chainResult.resumable });
}

// readCheckpointReceiptByIndex: reads ONE receipt by computed filename —
// never by directory enumeration (plan line 341: runtime verification
// "never scans lifetime history"; capacity rule: "no checkpoint-directory
// enumeration on runtime paths").
function readCheckpointReceiptByIndex(roots, index, adapter, { optional } = {}) {
  const receiptPath = path.join(roots.checkpointsDir, generationFilename(index));
  let stat;
  try {
    stat = fs.lstatSync(receiptPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (optional) return null;
      throw loadError('activity_checkpoint_chain_broken', `checkpoint receipt ${index} is missing`, { index });
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw loadError('chain_entry_not_regular_file', `checkpoint receipt is not a regular file: ${receiptPath}`, { path: receiptPath });
  }
  assertModeAndOwner({ name: path.basename(receiptPath), path: receiptPath, stat }, adapter, 'activity checkpoint');
  const parsed = readJsonFile(receiptPath);
  if (!parsed || parsed.format !== 1 || parsed.checkpointGeneration !== index) {
    throw loadError('activity_checkpoint_malformed', `checkpoint receipt ${index} is malformed`, { path: receiptPath });
  }
  return { checkpoint: parsed, checkpointSha256: sha256Hex(canonicalJson(parsed)), path: receiptPath };
}

// verifyActivityRoots: hot-journal recovery, fixed schema/pragmas, SQLite
// integrity, external head, LATEST checkpoint receipt + its previous
// checkpoint link, and at most the current 4096-row segment (plan line
// 341). It never scans lifetime history and never enumerates the
// checkpoint directory: receipts are read by computed filename only, and
// only the current segment's rows are hashed. Options: ownershipAdapter,
// recoveryOnlyAdapter, maxDbBytes (injectable size bound for tests;
// production default MAX_ACTIVITY_DB_BYTES).
function verifyActivityRoots(roots, { ownershipAdapter, recoveryOnlyAdapter, maxDbBytes } = {}) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const dbExists = fs.existsSync(roots.activityDbPath);
  const externalHeadExists = fs.existsSync(roots.activityHeadPath);
  // Presence probe without enumeration: receipts are never pruned, so an
  // initialized root always has receipt 0 at its fixed filename.
  const checkpointsExist = fs.existsSync(path.join(roots.checkpointsDir, generationFilename(0)));

  if (!dbExists && !externalHeadExists && !checkpointsExist) {
    return { present: false };
  }
  if (!dbExists) {
    throw loadError('activity_db_missing', 'activity external head/checkpoint present but activity.sqlite is missing');
  }

  assertNoSymlinkComponents(roots.activityDbPath);
  const dbStat = fs.lstatSync(roots.activityDbPath);
  if (!dbStat.isFile()) {
    throw loadError('activity_db_wrong_type', 'activity.sqlite is not a regular file');
  }
  // Review IMPORTANT 3b: the activity database file itself gets the same
  // mode-0600 + service-ownership check the capability chain files get
  // (plan line 329/351: "capability/activity files are mode 0600").
  if ((dbStat.mode & 0o777) !== FILE_MODE) {
    throw loadError('activity_db_wrong_mode', 'activity.sqlite is not mode 0600', {
      path: roots.activityDbPath,
      mode: (dbStat.mode & 0o777).toString(8),
    });
  }
  if (!adapter.verifyOwner(dbStat)) {
    throw loadError('activity_db_wrong_owner', 'activity.sqlite is not owned by the service identity', {
      path: roots.activityDbPath,
    });
  }
  const sizeBound = Number.isFinite(maxDbBytes) ? maxDbBytes : MAX_ACTIVITY_DB_BYTES;
  if (dbStat.size > sizeBound) {
    throw loadError('activity_db_size_exceeded', `activity.sqlite exceeds the ${sizeBound}-byte retention bound`, { size: dbStat.size });
  }

  const recovery = recoverHotJournalIfPresent({ dbPath: roots.activityDbPath, ownershipAdapter: adapter, recoveryOnlyAdapter });

  const db = openReadOnly(roots.activityDbPath);
  let genesisRow = null;
  let headRow;
  let stats;
  let segmentRows;
  try {
    verifyFixedSchema(db);
    if (!quickCheck(db)) {
      throw loadError('activity_db_quick_check_failed', 'activity database failed PRAGMA quick_check');
    }
    // Singleton head revalidation (head matches chain max, head row's
    // canonical hash matches) — shared with the append discipline.
    headRow = revalidateHead(db).head;
    stats = db.prepare('SELECT COUNT(*) AS n, MIN(generation) AS lo, MAX(generation) AS hi FROM activity_chain').get();
    // Genesis-row deep verification only while generation 0 is retained;
    // at scale the genesis row is pruned and the checkpoint chain carries
    // its evidence (the immutable factory anchor binds it separately).
    if (stats.lo === 0) {
      genesisRow = readGenesisRow(db);
    }

    // Retained-window bounds (plan line 341: "at most 8193 rows and 32 MiB").
    if (stats.n > MAX_RETAINED_ROWS) {
      throw loadError('activity_retained_rows_exceeded', `activity database retains ${stats.n} rows > ${MAX_RETAINED_ROWS}`, { rows: stats.n });
    }
    const kDb = headRow.checkpoint_generation;
    if (!Number.isSafeInteger(kDb) || kDb < 0) {
      throw loadError('activity_head_row_invalid', 'activity_head checkpoint_generation is not a non-negative safe integer');
    }
    if (kDb > MAX_CHECKPOINT_RECEIPTS) {
      throw loadError('activity_checkpoint_ceiling_exceeded', `activity head references checkpoint ${kDb} beyond the ${MAX_CHECKPOINT_RECEIPTS}-receipt hard ceiling`);
    }
    if (headRow.generation >= (kDb + 1) * CHECKPOINT_INTERVAL) {
      throw loadError('activity_checkpoint_gap', 'the activity head has run past a 4096 boundary without a checkpoint');
    }
    const pruneFloor = Math.max(0, (kDb - 2) * CHECKPOINT_INTERVAL);
    if (stats.lo !== null && stats.lo < pruneFloor) {
      throw loadError('activity_retained_window_violation', 'activity database retains rows older than the prune window permits', {
        lo: stats.lo,
        pruneFloor,
      });
    }

    // External head (line 339): the database may be exactly one generation
    // ahead after a crash; anything else blocks.
    const externalHead = readExternalHeadFile(roots.activityHeadPath);
    if (externalHead === null) {
      if (headRow.generation === 0 && genesisRow) {
        return {
          present: true,
          recovery,
          genesisRow,
          headRow,
          externalHead: null,
          latestCheckpoint: null,
          previousCheckpoint: null,
          rowStats: stats,
          resumable: { kind: 'EXTERNAL_HEAD_PUBLICATION', targetGeneration: 0 },
        };
      }
      throw loadError('activity_external_head_missing', 'activity database has committed generations but the external head witness is missing');
    }

    if (externalHead.generation > headRow.generation) {
      throw loadError('activity_database_rollback', 'activity database generation is behind the external head witness', {
        dbGeneration: headRow.generation,
        externalHeadGeneration: externalHead.generation,
      });
    }
    if (headRow.generation - externalHead.generation > 1) {
      throw loadError('activity_head_gap_too_large', 'activity database is more than one generation ahead of the external head witness', {
        dbGeneration: headRow.generation,
        externalHeadGeneration: externalHead.generation,
      });
    }
    if (externalHead.entrySha256 !== headRow.entry_sha256 && headRow.generation === externalHead.generation) {
      throw loadError('activity_external_head_hash_mismatch', 'external head entrySha256 does not match the committed database row');
    }

    const kExt = externalHead.checkpointGeneration;
    if (kDb < kExt) {
      throw loadError('activity_database_rollback', 'activity database checkpoint binding is behind the external head witness', {
        dbCheckpointGeneration: kDb,
        externalCheckpointGeneration: kExt,
      });
    }
    if (kDb > kExt + 1) {
      throw loadError('activity_head_gap_too_large', 'activity database checkpoint binding is more than one checkpoint ahead of the external head witness', {
        dbCheckpointGeneration: kDb,
        externalCheckpointGeneration: kExt,
      });
    }

    // Latest PUBLISHED checkpoint receipt + previous checkpoint link. Read
    // by computed filename; a boundary crash may additionally leave the
    // database bound to receipt kExt+1 (rebuilt during reconcile), which
    // is part of the resumable state, not a verification target here.
    const latestCheckpoint = readCheckpointReceiptByIndex(roots, kExt, adapter, {});
    if (latestCheckpoint.checkpointSha256 !== externalHead.checkpointSha256) {
      throw loadError('activity_external_head_checkpoint_mismatch', 'external head checkpointSha256 does not match the on-disk checkpoint receipt');
    }
    if (kDb === kExt && latestCheckpoint.checkpointSha256 !== headRow.checkpoint_sha256) {
      throw loadError('activity_external_head_checkpoint_mismatch', 'database head checkpoint binding does not match the on-disk checkpoint receipt');
    }
    let previousCheckpoint = null;
    if (kExt === 0) {
      if (latestCheckpoint.checkpoint.previousCheckpointSha256 !== null) {
        throw loadError('activity_checkpoint_fork', 'checkpoint 0 must have null previousCheckpointSha256');
      }
      // Genesis receipt: its cumulative hash is recomputable while the
      // genesis row is retained (it always is at kExt === 0).
      if (genesisRow) {
        const expectedCumulative = checkpointCumulativeSha256(null, genesisRow.entry_sha256);
        if (latestCheckpoint.checkpoint.cumulativeSha256 !== expectedCumulative || latestCheckpoint.checkpoint.entrySha256 !== genesisRow.entry_sha256) {
          throw loadError('activity_checkpoint_hash_mismatch', 'checkpoint 0 does not match the committed genesis row');
        }
      }
    } else {
      previousCheckpoint = readCheckpointReceiptByIndex(roots, kExt - 1, adapter, {});
      if (latestCheckpoint.checkpoint.previousCheckpointSha256 !== previousCheckpoint.checkpointSha256) {
        throw loadError('activity_checkpoint_fork', `checkpoint ${kExt} previousCheckpointSha256 does not match its actual predecessor`);
      }
    }
    // Orphan newer receipt probe (single computed-filename existence check,
    // not enumeration): a receipt newer than everything the database head
    // binds means the published head was replaced with an older valid
    // pointer ("external-head-only rollback").
    if (fs.existsSync(path.join(roots.checkpointsDir, generationFilename(kDb + 1)))) {
      throw loadError('activity_external_head_rollback', 'a newer checkpoint exists on disk than the one referenced by the external head');
    }

    // Current-segment verification (at most 4096+1 rows): anchored at the
    // latest PUBLISHED receipt's boundary row, chained forward to the head,
    // with every canonical row hash recomputed and the rolling segment
    // accumulator + segment count cross-checked against the head row.
    const segmentStart = kExt * CHECKPOINT_INTERVAL;
    segmentRows = db.prepare('SELECT * FROM activity_chain WHERE generation >= ? ORDER BY generation').all(segmentStart);
    if (segmentRows.length === 0 || segmentRows[0].generation !== segmentStart) {
      throw loadError('activity_checkpoint_boundary_row_mismatch', 'the latest checkpoint boundary row is not retained', { segmentStart });
    }
    if (segmentRows[0].entry_sha256 !== latestCheckpoint.checkpoint.entrySha256) {
      throw loadError('activity_checkpoint_boundary_row_mismatch', 'the checkpoint boundary row does not match the receipt entrySha256', {
        segmentStart,
      });
    }
    let accumulator = latestCheckpoint.checkpoint.cumulativeSha256;
    for (let i = 0; i < segmentRows.length; i += 1) {
      const row = segmentRows[i];
      if (i > 0) {
        const prev = segmentRows[i - 1];
        if (row.generation !== prev.generation + 1 || row.previous_generation !== prev.generation || row.previous_sha256 !== prev.entry_sha256) {
          throw loadError('activity_segment_chain_broken', `activity segment chain link broken at generation ${row.generation}`);
        }
      }
      // Recompute every segment row's canonical hash (the boundary row's
      // stored hash is additionally pinned by the receipt's entrySha256).
      const recomputed = sha256Hex(
        canonicalJson({
          generation: row.generation,
          previousGeneration: row.previous_generation,
          previousSha256: row.previous_sha256,
          operationId: row.operation_id,
          kind: row.kind,
          createdAt: row.created_at,
          principalKind: row.principal_kind,
          principalSha256: row.principal_sha256,
          commandKeySha256: row.command_key_sha256,
          adapterId: row.adapter_id,
          activitySha256: row.activity_sha256,
        })
      );
      if (recomputed !== row.entry_sha256) {
        throw loadError('activity_segment_chain_broken', `activity segment row ${row.generation} does not match its canonical bytes`);
      }
      if (i > 0) {
        accumulator = checkpointCumulativeSha256(accumulator, row.entry_sha256);
      }
    }
    if (segmentRows[segmentRows.length - 1].generation !== headRow.generation) {
      throw loadError('activity_segment_chain_broken', 'the activity segment does not end at the head generation');
    }
    if (accumulator !== headRow.segment_accumulator_sha256) {
      throw loadError('activity_segment_accumulator_mismatch', 'the rolling segment accumulator does not match the verified segment rows');
    }
    const expectedSegmentCount = headRow.generation - kDb * CHECKPOINT_INTERVAL + 1;
    if (headRow.segment_count !== expectedSegmentCount) {
      throw loadError('activity_segment_count_mismatch', `activity head segment_count ${headRow.segment_count} !== expected ${expectedSegmentCount}`);
    }

    const resumable =
      headRow.generation === externalHead.generation + 1
        ? { kind: 'EXTERNAL_HEAD_PUBLICATION', targetGeneration: headRow.generation }
        : null;

    return {
      present: true,
      recovery,
      genesisRow,
      headRow,
      externalHead,
      latestCheckpoint,
      previousCheckpoint,
      rowStats: stats,
      resumable,
    };
  } finally {
    db.close();
  }
}

function repairActivityRoots(roots, activityResult, { ownershipAdapter } = {}) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  if (!activityResult.resumable || activityResult.resumable.kind !== 'EXTERNAL_HEAD_PUBLICATION') return activityResult;
  // The full line-339 rule (recompute the one pending row, verify its
  // predecessor equals the published external head, publish only the
  // deterministic next head, rebuilding a deterministically-rebuildable
  // missing checkpoint receipt first) lives in the shared reconcile helper
  // also used by the witnessed append path; delegate rather than duplicate.
  // Lazy require: activity-append itself requires this module's siblings
  // (activity-db/paths/locks) but not load.js, so there is no cycle; the
  // lazy form just keeps the top-of-file import list an honest statement
  // of load-time dependencies.
  const { reconcileExternalActivityHead } = require('./activity-append');
  reconcileExternalActivityHead(roots, { ownershipAdapter: adapter });
  return verifyActivityRoots(roots, { ownershipAdapter: adapter });
}

// loadProtocolState(options): the top-level entry point. `options.repair`
// (default false) controls whether GENESIS-adjacent/activity-one-ahead
// resumable gaps are actually completed on disk, or merely reported.
function loadProtocolState(options) {
  const opts = options || {};
  const roots = resolveRoots(opts);
  const ownershipAdapter = opts.ownershipAdapter || defaultOwnershipAdapter;
  const repair = opts.repair === true;

  let capability = verifyCapabilityChain(roots, { ownershipAdapter });
  let activity = verifyActivityRoots(roots, { ownershipAdapter, recoveryOnlyAdapter: opts.recoveryOnlyAdapter });
  let repaired = false;

  if (repair) {
    if (capability.present && capability.resumable) {
      capability = repairCapabilityChain(roots, capability, { ownershipAdapter });
      repaired = true;
    }
    if (activity.present && activity.resumable) {
      activity = repairActivityRoots(roots, activity, { ownershipAdapter });
      repaired = true;
    }
  }

  const capabilityPresent = capability.present === true;
  const activityPresent = activity.present === true;

  if (capabilityPresent !== activityPresent) {
    throw loadError('protocol_state_partial_root_set', 'capability and activity roots disagree on whether the protocol has been initialized', {
      capabilityPresent,
      activityPresent,
    });
  }

  if (!capabilityPresent) {
    return { initialized: false, capability, activity };
  }

  return {
    initialized: true,
    resumePending: Boolean((capability.resumable && !repair) || (activity.resumable && !repair)),
    repaired,
    capability,
    activity,
  };
}

module.exports = {
  loadError,
  CHAIN_ENTRY_PATTERN,
  verifyCapabilityChain,
  repairCapabilityChain,
  verifyActivityRoots,
  repairActivityRoots,
  loadProtocolState,
};
