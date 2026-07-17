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
// Scope for this slice (per brief): the resume machinery is fully
// implemented for GENESIS-adjacent states (the only kind this slice's CLI
// ever creates) and for the activity root's documented one-ahead crash
// tolerance. Every other kind's resume branch (disposition/reset/restore)
// validates its shape and then blocks — it does not attempt to complete
// the resume, because the verbs that would legitimately finish it are
// NOT_IMPLEMENTED_IN_THIS_SLICE.

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
  defaultOwnershipAdapter,
  FILE_MODE,
} = require('./paths');
const {
  recoverHotJournalIfPresent,
  openReadOnly,
  verifyFixedSchema,
  quickCheck,
  readGenesisRow,
  readHeadRow,
  checkpointCumulativeSha256,
  buildGenesisCheckpoint,
} = require('./activity-db');

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
    throw loadError('capability_witness_missing', 'a capability generation has no same-number witness (orphan generation above the witness chain)', {
      maxGeneration,
      maxWitness,
    });
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
      if (headRecord.generation !== 0 || chainMax !== 1 || !witnessByGeneration.has(chainMax)) {
        throw loadError('capability_head_rollback', 'capability head.json does not identify the highest committed generation/witness pair', {
          headGeneration: headRecord.generation,
          chainMax,
        });
      }
      // resumable: witnessed proposal one step ahead of head.
      return {
        present: true,
        generations,
        witnessByGeneration,
        head: headRecord,
        maxGeneration,
        resumable: { kind: 'HEAD_PUBLICATION', targetGeneration: chainMax },
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

// verifyActivityRoots: hot-journal recovery, schema/pragma/quick_check,
// genesis+head row verification, and external head/checkpoint
// verification bounded to the retained (genesis-only, in this slice)
// segment.
function verifyActivityRoots(roots, { ownershipAdapter, recoveryOnlyAdapter } = {}) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const dbExists = fs.existsSync(roots.activityDbPath);
  const externalHeadExists = fs.existsSync(roots.activityHeadPath);
  const checkpointsExist = fs.existsSync(roots.checkpointsDir) && listRegularEntries(roots.checkpointsDir, /^\d{16}\.json$/).length > 0;

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

  const recovery = recoverHotJournalIfPresent({ dbPath: roots.activityDbPath, ownershipAdapter: adapter, recoveryOnlyAdapter });

  const db = openReadOnly(roots.activityDbPath);
  let genesisRow;
  let headRow;
  try {
    verifyFixedSchema(db);
    if (!quickCheck(db)) {
      throw loadError('activity_db_quick_check_failed', 'activity database failed PRAGMA quick_check');
    }
    genesisRow = readGenesisRow(db);
    headRow = readHeadRow(db);
  } finally {
    db.close();
  }

  // Bounded retained-segment checkpoint verification. This slice only ever
  // has checkpoint 0; the walk below is written to generalize (a later
  // slice's every-4096th checkpoint still chains the same way).
  const checkpointEntries = listRegularEntries(roots.checkpointsDir, /^\d{16}\.json$/);
  const checkpointNumbers = checkpointEntries.map((e) => generationNumberFromFilename(e.name));
  for (let i = 0; i < checkpointNumbers.length; i += 1) {
    if (checkpointNumbers[i] !== i) {
      throw loadError('activity_checkpoint_gap', 'activity checkpoint numbering has a gap or does not start at 0');
    }
  }
  let previousCumulative = null;
  let previousCheckpointHash = null;
  const checkpoints = [];
  for (const entry of checkpointEntries) {
    assertModeAndOwner(entry, adapter, 'activity checkpoint');
    const parsed = readJsonFile(entry.path);
    if (!parsed || parsed.format !== 1 || parsed.checkpointGeneration !== generationNumberFromFilename(entry.name)) {
      throw loadError('activity_checkpoint_malformed', `checkpoint ${entry.name} is malformed`);
    }
    if (parsed.checkpointGeneration === 0) {
      if (parsed.previousCheckpointSha256 !== null) {
        throw loadError('activity_checkpoint_fork', 'checkpoint 0 must have null previousCheckpointSha256');
      }
    } else if (parsed.previousCheckpointSha256 !== previousCheckpointHash) {
      throw loadError('activity_checkpoint_fork', `checkpoint ${entry.name} previousCheckpointSha256 does not match its actual predecessor`);
    }
    const expectedCumulative = checkpointCumulativeSha256(previousCumulative, parsed.entrySha256);
    if (expectedCumulative !== parsed.cumulativeSha256) {
      throw loadError('activity_checkpoint_hash_mismatch', `checkpoint ${entry.name} cumulativeSha256 does not match its chain`);
    }
    const checkpointSha256 = sha256Hex(canonicalJson(parsed));
    checkpoints.push({ checkpoint: parsed, checkpointSha256, path: entry.path });
    previousCumulative = expectedCumulative;
    previousCheckpointHash = checkpointSha256;
  }

  // Activity-database-vs-external-head reconciliation (line 339): the
  // database may be exactly one generation ahead of the external head
  // after a crash; anything else blocks.
  const externalHead = readJsonFile(roots.activityHeadPath);
  if (externalHead === null) {
    if (headRow.generation === 0 && genesisRow) {
      return {
        present: true,
        recovery,
        genesisRow,
        headRow,
        checkpoints,
        externalHead: null,
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
  const matchingCheckpoint = checkpoints.find((c) => c.checkpoint.checkpointGeneration === externalHead.checkpointGeneration);
  if (!matchingCheckpoint || matchingCheckpoint.checkpointSha256 !== externalHead.checkpointSha256) {
    throw loadError('activity_external_head_checkpoint_mismatch', 'external head checkpointSha256 does not match any on-disk checkpoint');
  }
  // Reject an orphan checkpoint newer than what the external head claims —
  // an "external-head-only rollback" (a newer checkpoint exists but the
  // published head was replaced with an older valid pointer).
  const maxCheckpointGeneration = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].checkpoint.checkpointGeneration : -1;
  if (maxCheckpointGeneration > externalHead.checkpointGeneration) {
    throw loadError('activity_external_head_rollback', 'a newer checkpoint exists on disk than the one referenced by the external head');
  }

  if (headRow.generation === externalHead.generation + 1) {
    return {
      present: true,
      recovery,
      genesisRow,
      headRow,
      checkpoints,
      externalHead,
      resumable: { kind: 'EXTERNAL_HEAD_PUBLICATION', targetGeneration: headRow.generation },
    };
  }

  return { present: true, recovery, genesisRow, headRow, checkpoints, externalHead, resumable: null };
}

function repairActivityRoots(roots, activityResult, { ownershipAdapter } = {}) {
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  if (!activityResult.resumable || activityResult.resumable.kind !== 'EXTERNAL_HEAD_PUBLICATION') return activityResult;
  const targetGeneration = activityResult.resumable.targetGeneration;
  if (targetGeneration === 0 && activityResult.checkpoints.length === 0) {
    const { ensureModeDirRecursive } = require('./paths');
    ensureModeDirRecursive(roots.checkpointsDir, adapter);
    const checkpoint = buildGenesisCheckpoint({ entrySha256: activityResult.genesisRow.entry_sha256, createdAt: activityResult.genesisRow.created_at });
    writeExclusiveFile(
      path.join(roots.checkpointsDir, '0000000000000000.json'),
      Buffer.from(canonicalJson(checkpoint), 'utf8'),
      adapter
    );
  }
  const checkpointEntries = listRegularEntries(roots.checkpointsDir, /^\d{16}\.json$/);
  const matching = checkpointEntries.find((e) => generationNumberFromFilename(e.name) === activityResult.headRow.checkpoint_generation);
  if (!matching) {
    throw loadError('activity_repair_checkpoint_missing', 'cannot republish external head: no on-disk checkpoint matches the database head row');
  }
  const checkpointObj = readJsonFile(matching.path);
  const checkpointSha256 = sha256Hex(canonicalJson(checkpointObj));
  const activityHead = {
    format: 1,
    generation: activityResult.headRow.generation,
    entrySha256: activityResult.headRow.entry_sha256,
    checkpointGeneration: activityResult.headRow.checkpoint_generation,
    checkpointSha256,
  };
  atomicReplaceFile(roots.activityHeadPath, Buffer.from(canonicalJson(activityHead), 'utf8'), adapter);
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
