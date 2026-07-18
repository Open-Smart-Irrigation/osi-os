'use strict';

// Durable capability-chain transitions used exclusively by the deployment
// CLI verbs. Runtime/flow consumers do not receive this module or a raw
// append primitive.

const fs = require('node:fs');
const path = require('node:path');

const codecs = require('./codecs');
const paths = require('./paths');
const locks = require('./locks');
const load = require('./load');
const activityDb = require('./activity-db');

const MAX_CAPABILITY_GENERATION = 4095;

function transitionError(code, message, extra) {
  return codecs.codecError(code, message, extra);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw transitionError('transition_invalid_object', `${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw transitionError('transition_invalid_fields', `${label} must contain exactly: ${expected.join(',')}`);
  }
}

function assertSha(value, label) {
  if (!codecs.isSha256Hex(value)) {
    throw transitionError('transition_invalid_sha256', `${label} must be a lowercase sha256 digest`);
  }
}

function assertOperationId(value, label) {
  if (!codecs.isOperationId(value)) {
    throw transitionError('transition_invalid_operation_id', `${label} must be a valid operation ID`);
  }
}

function publishImmutableJson(filePath, value, ownershipAdapter) {
  paths.assertNoSymlinkComponents(filePath);
  const parent = path.dirname(filePath);
  paths.ensureModeDirRecursive(parent, ownershipAdapter, { enforceFrom: parent });
  let document = value;
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== paths.FILE_MODE) {
      throw transitionError('immutable_output_invalid', `immutable output has unsafe type or mode: ${filePath}`);
    }
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Object.prototype.hasOwnProperty.call(value, 'createdAt') && Object.prototype.hasOwnProperty.call(existing, 'createdAt')) {
      document = { ...value, createdAt: existing.createdAt };
    }
    if (codecs.canonicalJson(existing) !== codecs.canonicalJson(document)) {
      throw transitionError('immutable_output_mismatch', `immutable output does not match the same-operation resume: ${filePath}`);
    }
    return existing;
  }
  paths.writeExclusiveFile(filePath, Buffer.from(codecs.canonicalJson(document)), ownershipAdapter);
  paths.fsyncDir(parent);
  return document;
}

function ambientState(state) {
  return {
    activeIdentitySha256: state.activeIdentitySha256,
    mode: state.mode,
    historicalV2Disposition: state.historicalV2Disposition,
    historicalV2DispositionReceiptSha256: state.historicalV2DispositionReceiptSha256,
    databaseRestore: { ...state.databaseRestore },
  };
}

function assertExpectedHeads(loaded, options) {
  const capabilityHead = loaded.capability.head;
  const activityHead = loaded.activity.externalHead;
  if (capabilityHead.generationSha256 !== options.expectedHeadSha256) {
    throw transitionError('capability_head_changed', 'capability generation head changed before transition');
  }
  if (capabilityHead.witnessSha256 !== options.expectedWitnessSha256) {
    throw transitionError('capability_witness_changed', 'capability witness head changed before transition');
  }
  if (options.expectedActivityGeneration != null && activityHead.generation !== options.expectedActivityGeneration) {
    throw transitionError('activity_generation_changed', 'command-activity generation changed before transition');
  }
  if (
    options.expectedActivityHeadSha256 != null &&
    codecs.canonicalSha256(activityHead) !== options.expectedActivityHeadSha256
  ) {
    throw transitionError('activity_head_changed', 'command-activity external head changed before transition');
  }
}

function pendingTransition(loaded, operationId, kind) {
  const resumable = loaded && loaded.capability && loaded.capability.resumable;
  if (!resumable) return null;
  const proposal = loaded.capability.generations[resumable.targetGeneration];
  if (!proposal || proposal.generation.operationId !== operationId || proposal.generation.kind !== kind) {
    throw transitionError('pending_transition_conflict', 'a different capability proposal is already pending');
  }
  return proposal;
}

function transitionPredecessor(loaded, operationId, kind) {
  const pending = pendingTransition(loaded, operationId, kind);
  if (pending) return loaded.capability.generations[loaded.capability.head.generation];
  const latest = loaded.capability.generations.at(-1);
  if (latest.generation.operationId === operationId && latest.generation.kind === kind) {
    return loaded.capability.generations[latest.generation.previousGeneration];
  }
  return latest;
}

function transitionCreatedAt(loaded, operationId, kind, requestedCreatedAt) {
  const pending = pendingTransition(loaded, operationId, kind);
  if (pending) return pending.generation.createdAt;
  const latest = loaded.capability.generations.at(-1);
  if (latest.generation.operationId === operationId && latest.generation.kind === kind) {
    return latest.generation.createdAt;
  }
  return requestedCreatedAt || new Date().toISOString();
}

function transitionReceiptSha256(state, kind) {
  if (kind === 'HISTORICAL_V2_DISPOSITION') return state.historicalV2DispositionReceiptSha256;
  if (kind === 'RESET_AUTHORIZATION') return state.resetReceiptSha256;
  if (kind === 'DATABASE_RESTORE_INVALIDATION' || kind === 'DATABASE_INTEGRITY_INVALIDATION') {
    return state.invalidationReceiptSha256;
  }
  if (kind === 'DATABASE_RESTORE_RECONCILED' || kind === 'DATABASE_INTEGRITY_RECONCILED') {
    return state.reconciledReceiptSha256;
  }
  return null;
}

function maybeInjectCrash(options, boundary) {
  if (options.hardCrashAfter === boundary) {
    process.exit(137);
  }
  if (options.crashAfter === boundary) {
    throw transitionError('injected_transition_crash', `injected transition crash after ${boundary}`);
  }
}

function appendTransition(options, { kind, state, receipt, receiptPath }) {
  const opts = options || {};
  assertOperationId(opts.operationId, 'operationId');
  const roots = paths.resolveRoots(opts);
  const ownershipAdapter = opts.ownershipAdapter || paths.defaultOwnershipAdapter;
  paths.ensureFourRootDirsForLocking(roots, ownershipAdapter);
  const lock = locks.acquireFourRootLocks(
    roots,
    {
      operationId: opts.operationId,
      sourceKind: kind,
      sourceAuthority: opts.sourceAuthority || 'deployment-cli',
      headIdentities: {
        capabilityHeadSha256: opts.expectedHeadSha256,
        capabilityWitnessSha256: opts.expectedWitnessSha256,
        activityHeadSha256: opts.expectedActivityHeadSha256 || null,
      },
      typedReceiptSha256: codecs.canonicalSha256(receipt),
    },
    {
      bootId: opts.bootId,
      ownershipAdapter,
      isProcessAlive: opts.isProcessAlive,
      reconcile: {
        verifyChain: () => load.loadProtocolState({ ...opts, ownershipAdapter, repair: false }),
        findProposalForOperation: (staleOperationId) => {
          const verified = load.loadProtocolState({ ...opts, ownershipAdapter, repair: false });
          const resumable = verified.capability && verified.capability.resumable;
          if (!resumable) return null;
          const proposal = verified.capability.generations[resumable.targetGeneration];
          return proposal && proposal.generation.operationId === staleOperationId ? proposal : null;
        },
      },
    }
  );
  try {
    let loaded = load.loadProtocolState({ ...opts, ownershipAdapter, repair: false });
    if (!loaded.capability.resumable && loaded.activity.resumable) {
      loaded = load.loadProtocolState({ ...opts, ownershipAdapter, repair: true });
    }
    if (!loaded.initialized || loaded.resumePending) {
      const proposal = loaded.initialized ? pendingTransition(loaded, opts.operationId, kind) : null;
      if (!proposal || loaded.activity.resumable) {
        throw transitionError('protocol_state_not_ready', 'capability transition requires complete roots or its exact single pending proposal');
      }
      const predecessor = loaded.capability.generations[loaded.capability.head.generation];
      const previousWitness = loaded.capability.witnessByGeneration.get(predecessor.generation.generation);
      const generation = {
        format: 1,
        generation: proposal.generation.generation,
        previousGeneration: predecessor.generation.generation,
        previousSha256: predecessor.generationSha256,
        operationId: opts.operationId,
        kind,
        createdAt: proposal.generation.createdAt,
        state,
      };
      if (codecs.canonicalJson(generation) !== codecs.canonicalJson(proposal.generation)) {
        throw transitionError('pending_transition_mismatch', 'pending generation does not match the unchanged transition authority');
      }
      const receiptSha256 = codecs.canonicalSha256(receipt);
      const expectedReceiptSha256 = transitionReceiptSha256(state, kind);
      if (expectedReceiptSha256 !== null && receiptSha256 !== expectedReceiptSha256) {
        throw transitionError('pending_transition_receipt_mismatch', 'pending generation does not bind the reconstructed typed receipt');
      }
      paths.writeExclusiveOrVerify(
        receiptPath,
        Buffer.from(codecs.canonicalJson(receipt)),
        ownershipAdapter,
        'pending_transition_receipt_mismatch'
      );
      paths.fsyncDir(path.dirname(receiptPath));
      const witness = {
        format: 1,
        generation: proposal.generation.generation,
        generationSha256: proposal.generationSha256,
        previousWitnessSha256: previousWitness.witnessSha256,
        operationId: opts.operationId,
      };
      const witnessPath = path.join(roots.witnessRoot, paths.generationFilename(proposal.generation.generation));
      paths.writeExclusiveOrVerify(
        witnessPath,
        Buffer.from(codecs.canonicalJson(witness)),
        ownershipAdapter,
        'pending_transition_witness_mismatch'
      );
      paths.fsyncDir(roots.witnessRoot);
      const witnessSha256 = codecs.canonicalSha256(witness);
      const head = codecs.buildCapabilityHead({
        generation: proposal.generation.generation,
        generationSha256: proposal.generationSha256,
        witnessSha256,
      });
      paths.atomicReplaceFile(roots.capabilityHeadPath, Buffer.from(codecs.canonicalJson(head)), ownershipAdapter);
      load.loadProtocolState({ ...opts, ownershipAdapter, repair: false });
      return {
        generation: proposal.generation.generation,
        generationSha256: proposal.generationSha256,
        witnessSha256,
        receiptSha256,
        state,
        resumed: true,
      };
    }
    const predecessor = loaded.capability.generations.at(-1);
    if (predecessor.generation.operationId === opts.operationId) {
      if (predecessor.generation.kind !== kind) {
        throw transitionError('operation_id_kind_conflict', 'operationId already committed under a different transition kind');
      }
      const committedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (
        codecs.canonicalJson(predecessor.generation.state) !== codecs.canonicalJson(state) ||
        codecs.canonicalJson(committedReceipt) !== codecs.canonicalJson(receipt)
      ) {
        throw transitionError('committed_transition_mismatch', 'committed transition does not match the unchanged retry authority');
      }
      return {
        generation: predecessor.generation.generation,
        generationSha256: predecessor.generationSha256,
        witnessSha256: loaded.capability.head.witnessSha256,
        receiptSha256: codecs.canonicalSha256(committedReceipt),
        state: predecessor.generation.state,
        resumed: true,
      };
    }
    assertExpectedHeads(loaded, opts);
    const previousWitness = loaded.capability.witnessByGeneration.get(predecessor.generation.generation);
    const generationNumber = predecessor.generation.generation + 1;
    if (generationNumber > MAX_CAPABILITY_GENERATION) {
      throw transitionError('capability_generation_ceiling', 'capability generation ceiling reached');
    }
    const generation = {
      format: 1,
      generation: generationNumber,
      previousGeneration: predecessor.generation.generation,
      previousSha256: predecessor.generationSha256,
      operationId: opts.operationId,
      kind,
      createdAt: opts.createdAt || new Date().toISOString(),
      state,
    };
    codecs.validateGeneration(generation);
    const generationSha256 = codecs.canonicalSha256(generation);
    const witness = {
      format: 1,
      generation: generationNumber,
      generationSha256,
      previousWitnessSha256: previousWitness.witnessSha256,
      operationId: opts.operationId,
    };
    codecs.validateWitness(witness);
    const witnessSha256 = codecs.canonicalSha256(witness);
    const head = codecs.buildCapabilityHead({ generation: generationNumber, generationSha256, witnessSha256 });

    const generationPath = path.join(roots.generationsDir, paths.generationFilename(generationNumber));
    const witnessPath = path.join(roots.witnessRoot, paths.generationFilename(generationNumber));
    paths.writeExclusiveFile(generationPath, Buffer.from(codecs.canonicalJson(generation)), ownershipAdapter);
    paths.fsyncDir(roots.generationsDir);
    maybeInjectCrash(opts, 'transition_generation');
    paths.writeExclusiveFile(receiptPath, Buffer.from(codecs.canonicalJson(receipt)), ownershipAdapter);
    paths.fsyncDir(path.dirname(receiptPath));
    maybeInjectCrash(opts, 'transition_receipt');
    paths.writeExclusiveFile(witnessPath, Buffer.from(codecs.canonicalJson(witness)), ownershipAdapter);
    paths.fsyncDir(roots.witnessRoot);
    maybeInjectCrash(opts, 'transition_witness');
    paths.atomicReplaceFile(roots.capabilityHeadPath, Buffer.from(codecs.canonicalJson(head)), ownershipAdapter);
    maybeInjectCrash(opts, 'transition_head');

    const verified = load.loadProtocolState({ ...opts, ownershipAdapter, repair: false });
    if (verified.capability.head.generation !== generationNumber) {
      throw transitionError('capability_transition_verification_failed', 'committed transition did not become the verified head');
    }
    return {
      generation: generationNumber,
      generationSha256,
      witnessSha256,
      receiptSha256: codecs.canonicalSha256(receipt),
      state,
    };
  } finally {
    lock.release();
  }
}

function recordHistoricalV2Disposition(options) {
  const opts = options || {};
  const source = opts.source;
  const common = [
    'sourceKind',
    'dispositionReceiptSha256',
    'auditSha256',
    'databaseSha256',
    'backupSha256',
    'identitySha256',
    'historicalV2Disposition',
  ];
  const keys = source && source.sourceKind === 'zero' ? [...common, 'sourceAuthorityKind'] : common;
  assertExactKeys(source, keys, 'historical-v2 disposition source');
  if (!['zero', 'rebind', 'quarantine'].includes(source.sourceKind)) {
    throw transitionError('disposition_source_kind_invalid', 'record-v2-disposition accepts zero, rebind, or quarantine only');
  }
  if (source.sourceKind === 'zero' && source.sourceAuthorityKind !== 'deployment-backup') {
    throw transitionError('disposition_authority_invalid', 'deployment record-v2-disposition zero requires deployment-backup authority');
  }
  const requiredDisposition = source.sourceKind === 'quarantine' ? 'RECONCILIATION_REQUIRED' : 'CLEAR';
  if (source.historicalV2Disposition !== requiredDisposition) {
    throw transitionError('disposition_result_invalid', `${source.sourceKind} requires ${requiredDisposition}`);
  }
  for (const field of ['dispositionReceiptSha256', 'auditSha256', 'databaseSha256', 'backupSha256']) {
    assertSha(source[field], field);
  }
  if (source.identitySha256 !== null) assertSha(source.identitySha256, 'identitySha256');

  const roots = paths.resolveRoots(opts);
  const loaded = load.loadProtocolState(opts);
  if (!loaded.initialized) throw transitionError('protocol_state_uninitialized', 'record-v2-disposition requires initialized roots');
  const committed = loaded.capability.generations.at(-1);
  if (!loaded.resumePending && committed.generation.operationId === opts.operationId) {
    const committedState = committed.generation.state;
    if (
      committed.generation.kind !== 'HISTORICAL_V2_DISPOSITION' ||
      committedState.sourceKind !== source.sourceKind ||
      committedState.historicalV2Disposition !== source.historicalV2Disposition ||
      committedState.dispositionReceiptSha256 !== source.dispositionReceiptSha256 ||
      committedState.auditSha256 !== source.auditSha256 ||
      committedState.databaseSha256 !== source.databaseSha256 ||
      committedState.backupSha256 !== source.backupSha256 ||
      committedState.identitySha256 !== source.identitySha256
    ) {
      throw transitionError('committed_transition_mismatch', 'committed disposition does not match retry authority');
    }
    return {
      generation: committed.generation.generation,
      generationSha256: committed.generationSha256,
      witnessSha256: loaded.capability.head.witnessSha256,
      receiptSha256: committedState.historicalV2DispositionReceiptSha256,
      state: committedState,
      resumed: true,
    };
  }
  assertExpectedHeads(loaded, opts);
  const priorState = transitionPredecessor(loaded, opts.operationId, 'HISTORICAL_V2_DISPOSITION').generation.state;
  const createdAt = transitionCreatedAt(loaded, opts.operationId, 'HISTORICAL_V2_DISPOSITION', opts.createdAt);
  if (priorState.activeIdentitySha256 !== null || priorState.mode !== 'UNNEGOTIATED') {
    throw transitionError('disposition_after_negotiation', 'historical disposition cannot run after negotiation');
  }
  const receipt = {
    format: 1,
    receiptKind: 'historical-v2-disposition',
    operationId: opts.operationId,
    sourceKind: source.sourceKind,
    sourceAuthorityKind: source.sourceKind === 'zero' ? source.sourceAuthorityKind : null,
    sourceDispositionReceiptSha256: source.dispositionReceiptSha256,
    auditSha256: source.auditSha256,
    databaseSha256: source.databaseSha256,
    backupSha256: source.backupSha256,
    identitySha256: source.identitySha256,
    predecessorGeneration: loaded.capability.head.generation,
    predecessorHeadSha256: loaded.capability.head.generationSha256,
    predecessorWitnessSha256: loaded.capability.head.witnessSha256,
    historicalV2Disposition: source.historicalV2Disposition,
    createdAt,
  };
  const receiptSha256 = codecs.canonicalSha256(receipt);
  const state = {
    activeIdentitySha256: null,
    mode: 'UNNEGOTIATED',
    historicalV2Disposition: source.historicalV2Disposition,
    historicalV2DispositionReceiptSha256: receiptSha256,
    databaseRestore: { ...priorState.databaseRestore },
    sourceKind: source.sourceKind,
    ...(source.sourceKind === 'zero' ? { sourceAuthorityKind: source.sourceAuthorityKind } : {}),
    dispositionReceiptSha256: source.dispositionReceiptSha256,
    auditSha256: source.auditSha256,
    databaseSha256: source.databaseSha256,
    backupSha256: source.backupSha256,
    identitySha256: source.identitySha256,
  };
  return appendTransition({ ...opts, createdAt }, {
    kind: 'HISTORICAL_V2_DISPOSITION',
    state,
    receipt,
    receiptPath: path.join(roots.v2DispositionReceiptsDir, `${opts.operationId}.json`),
  });
}

function resumeDispositionProposal(loaded, opts, roots, ownershipAdapter, { dryRun = false } = {}) {
  const resumable = loaded.capability.resumable;
  if (!resumable || loaded.activity.resumable) return null;
  const proposal = loaded.capability.generations[resumable.targetGeneration];
  const oldHead = loaded.capability.head;
  const state = proposal && proposal.generation.state;
  if (
    !proposal || !oldHead || proposal.generation.generation !== oldHead.generation + 1 ||
    proposal.generation.kind !== 'HISTORICAL_V2_DISPOSITION' ||
    state.historicalV2Disposition !== 'CLEAR' ||
    !['zero', 'rebind'].includes(state.sourceKind)
  ) {
    return { rejected: true, reason: 'MALFORMED_PROPOSAL' };
  }
  if (
    state.auditSha256 !== opts.auditSha256 ||
    state.backupSha256 !== opts.backupSha256 ||
    state.identitySha256 !== opts.identitySha256 ||
    (opts.databaseSha256 != null && state.databaseSha256 !== opts.databaseSha256) ||
    (opts.sourceDispositionReceiptSha256 != null && state.dispositionReceiptSha256 !== opts.sourceDispositionReceiptSha256)
  ) {
    return { rejected: true, reason: 'MISMATCHED_PROPOSAL' };
  }
  const receipt = {
    format: 1,
    receiptKind: 'historical-v2-disposition',
    operationId: proposal.generation.operationId,
    sourceKind: state.sourceKind,
    sourceAuthorityKind: state.sourceKind === 'zero' ? state.sourceAuthorityKind : null,
    sourceDispositionReceiptSha256: state.dispositionReceiptSha256,
    auditSha256: state.auditSha256,
    databaseSha256: state.databaseSha256,
    backupSha256: state.backupSha256,
    identitySha256: state.identitySha256,
    predecessorGeneration: oldHead.generation,
    predecessorHeadSha256: oldHead.generationSha256,
    predecessorWitnessSha256: oldHead.witnessSha256,
    historicalV2Disposition: 'CLEAR',
    createdAt: proposal.generation.createdAt,
  };
  if (codecs.canonicalSha256(receipt) !== state.historicalV2DispositionReceiptSha256) {
    return { rejected: true, reason: 'MISMATCHED_PROPOSAL' };
  }
  if (dryRun) {
    return {
      validated: true,
      completionOperationId: proposal.generation.operationId,
      observedDispositionReceiptSha256: state.historicalV2DispositionReceiptSha256,
    };
  }
  const receiptPath = path.join(roots.v2DispositionReceiptsDir, `${proposal.generation.operationId}.json`);
  paths.writeExclusiveOrVerify(
    receiptPath,
    Buffer.from(codecs.canonicalJson(receipt)),
    ownershipAdapter,
    'disposition_resume_receipt_mismatch'
  );
  paths.fsyncDir(roots.v2DispositionReceiptsDir);
  const previousWitness = loaded.capability.witnessByGeneration.get(oldHead.generation);
  const witness = {
    format: 1,
    generation: proposal.generation.generation,
    generationSha256: proposal.generationSha256,
    previousWitnessSha256: previousWitness.witnessSha256,
    operationId: proposal.generation.operationId,
  };
  codecs.validateWitness(witness);
  const witnessPath = path.join(roots.witnessRoot, paths.generationFilename(proposal.generation.generation));
  paths.writeExclusiveOrVerify(
    witnessPath,
    Buffer.from(codecs.canonicalJson(witness)),
    ownershipAdapter,
    'disposition_resume_witness_mismatch'
  );
  paths.fsyncDir(roots.witnessRoot);
  const head = codecs.buildCapabilityHead({
    generation: proposal.generation.generation,
    generationSha256: proposal.generationSha256,
    witnessSha256: codecs.canonicalSha256(witness),
  });
  paths.atomicReplaceFile(roots.capabilityHeadPath, Buffer.from(codecs.canonicalJson(head)), ownershipAdapter);
  return {
    loaded: load.loadProtocolState({ ...opts, ownershipAdapter, repair: false }),
    completionOperationId: proposal.generation.operationId,
  };
}

function prepareDispositionRestore(options) {
  const opts = options || {};
  assertOperationId(opts.recoveryOperationId, 'recoveryOperationId');
  for (const field of [
    'auditSha256',
    'backupManifestSha256',
    'backupSha256',
    'identitySha256',
    'expectedHeadSha256',
    'expectedWitnessSha256',
  ]) {
    assertSha(opts[field], field);
  }
  const roots = paths.resolveRoots(opts);
  const ownershipAdapter = opts.ownershipAdapter || paths.defaultOwnershipAdapter;
  paths.ensureFourRootDirsForLocking(roots, ownershipAdapter);
  const lock = locks.acquireFourRootLocks(
    roots,
    {
      operationId: opts.recoveryOperationId,
      sourceKind: 'prepare-disposition-restore',
      sourceAuthority: 'linked-recovery',
      headIdentities: {
        capabilityHeadSha256: opts.expectedHeadSha256,
        capabilityWitnessSha256: opts.expectedWitnessSha256,
        activityHeadSha256: opts.expectedActivityHeadSha256 || null,
      },
      typedReceiptSha256: null,
    },
    { bootId: opts.bootId, ownershipAdapter, isProcessAlive: opts.isProcessAlive }
  );
  try {
    let loaded = load.loadProtocolState({ ...opts, ownershipAdapter, repair: false });
    if (!loaded.initialized) {
      throw transitionError('protocol_state_not_ready', 'disposition restore preparation requires complete protocol roots');
    }
    if (fs.existsSync(opts.resultOut)) {
      const intent = publishImmutableJson(
        opts.prepareIntentOut,
        JSON.parse(fs.readFileSync(opts.prepareIntentOut, 'utf8')),
        ownershipAdapter
      );
      const existing = publishImmutableJson(
        opts.resultOut,
        JSON.parse(fs.readFileSync(opts.resultOut, 'utf8')),
        ownershipAdapter
      );
      const top = loaded.capability.generations.at(-1).generation;
      if (
        intent.kind !== 'DISPOSITION_RESTORE_PREPARATION_INTENT' ||
        intent.deploymentId !== opts.deploymentId || intent.parentGeneration !== opts.parentGeneration ||
        intent.recoveryOperationId !== opts.recoveryOperationId || intent.auditSha256 !== opts.auditSha256 ||
        intent.backupManifestSha256 !== opts.backupManifestSha256 || intent.backupSha256 !== opts.backupSha256 ||
        intent.identitySha256 !== opts.identitySha256 || intent.capabilityHeadSha256 !== opts.expectedHeadSha256 ||
        intent.capabilityWitnessSha256 !== opts.expectedWitnessSha256 ||
        existing.kind !== 'DISPOSITION_RESTORE_PREPARATION_RESULT' ||
        existing.deploymentId !== opts.deploymentId || existing.parentGeneration !== opts.parentGeneration ||
        existing.recoveryOperationId !== opts.recoveryOperationId ||
        existing.intentSha256 !== codecs.canonicalSha256(intent) || existing.result !== intent.observedBranch ||
        existing.auditSha256 !== opts.auditSha256 || existing.backupManifestSha256 !== opts.backupManifestSha256 ||
        existing.backupSha256 !== opts.backupSha256 || existing.identitySha256 !== opts.identitySha256 ||
        existing.preCapabilityHeadSha256 !== opts.expectedHeadSha256 ||
        existing.postCapabilityHeadSha256 !== loaded.capability.head.generationSha256 ||
        existing.capabilityWitnessSha256 !== loaded.capability.head.witnessSha256 ||
        existing.activityGeneration !== loaded.activity.externalHead.generation ||
        existing.activityExternalHeadSha256 !== codecs.canonicalSha256(loaded.activity.externalHead) ||
        (existing.result === 'UNHEADED_CLEAR_COMPLETED' && (
          top.operationId !== existing.completionOperationId ||
          top.kind !== 'HISTORICAL_V2_DISPOSITION' || top.state.historicalV2Disposition !== 'CLEAR'
        ))
      ) {
        throw transitionError('disposition_restore_resume_mismatch', 'existing disposition preparation result does not match retry authority and live heads');
      }
      return existing;
    }
    if (fs.existsSync(opts.prepareIntentOut) && !loaded.resumePending) {
      const intent = publishImmutableJson(
        opts.prepareIntentOut,
        JSON.parse(fs.readFileSync(opts.prepareIntentOut, 'utf8')),
        ownershipAdapter
      );
      const top = loaded.capability.generations.at(-1).generation;
      if (
        intent.kind === 'DISPOSITION_RESTORE_PREPARATION_INTENT' &&
        intent.observedBranch === 'UNHEADED_CLEAR_COMPLETED' &&
        intent.deploymentId === opts.deploymentId && intent.parentGeneration === opts.parentGeneration &&
        intent.recoveryOperationId === opts.recoveryOperationId && intent.auditSha256 === opts.auditSha256 &&
        intent.backupManifestSha256 === opts.backupManifestSha256 && intent.backupSha256 === opts.backupSha256 &&
        intent.identitySha256 === opts.identitySha256 && intent.capabilityHeadSha256 === opts.expectedHeadSha256 &&
        intent.capabilityWitnessSha256 === opts.expectedWitnessSha256 &&
        intent.activityGeneration === loaded.activity.externalHead.generation &&
        intent.activityExternalHeadSha256 === codecs.canonicalSha256(loaded.activity.externalHead) &&
        top.kind === 'HISTORICAL_V2_DISPOSITION' && top.state.historicalV2Disposition === 'CLEAR' &&
        top.state.historicalV2DispositionReceiptSha256 === intent.observedDispositionReceiptSha256
      ) {
        return publishImmutableJson(
          opts.resultOut,
          {
            format: 1,
            kind: 'DISPOSITION_RESTORE_PREPARATION_RESULT',
            deploymentId: opts.deploymentId,
            parentGeneration: opts.parentGeneration,
            recoveryOperationId: opts.recoveryOperationId,
            intentSha256: codecs.canonicalSha256(intent),
            result: 'UNHEADED_CLEAR_COMPLETED',
            reason: null,
            auditSha256: opts.auditSha256,
            backupManifestSha256: opts.backupManifestSha256,
            backupSha256: opts.backupSha256,
            identitySha256: opts.identitySha256,
            observedDispositionReceiptSha256: intent.observedDispositionReceiptSha256,
            preCapabilityHeadSha256: intent.capabilityHeadSha256,
            postCapabilityHeadSha256: loaded.capability.head.generationSha256,
            capabilityWitnessSha256: loaded.capability.head.witnessSha256,
            activityGeneration: loaded.activity.externalHead.generation,
            activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
            completionOperationId: top.operationId,
            createdAt: intent.createdAt,
          },
          ownershipAdapter
        );
      }
    }
    assertExpectedHeads(loaded, opts);
    const preCapabilityHead = { ...loaded.capability.head };
    let completionOperationId = null;
    let branch;
    let reason = null;
    let observedDispositionReceiptSha256;
    if (loaded.resumePending) {
      const classified = resumeDispositionProposal(loaded, opts, roots, ownershipAdapter, { dryRun: true });
      if (!classified || classified.rejected) {
        branch = 'REJECTED';
        reason = classified && classified.reason ? classified.reason : 'MALFORMED_PROPOSAL';
        observedDispositionReceiptSha256 = null;
      } else {
        branch = 'UNHEADED_CLEAR_COMPLETED';
        completionOperationId = classified.completionOperationId;
        observedDispositionReceiptSha256 = classified.observedDispositionReceiptSha256;
      }
    } else {
      const top = loaded.capability.generations.at(-1).generation;
      observedDispositionReceiptSha256 = top.state.historicalV2DispositionReceiptSha256;
      if (top.kind === 'NEGOTIATED') {
        branch = 'REJECTED';
        reason = 'DEPENDENT_NEGOTIATED';
      } else if (top.state.historicalV2Disposition === 'CLEAR') {
        branch = 'COMMITTED_CLEAR';
      } else {
        branch = 'NO_CLEAR';
      }
    }
    const intent = publishImmutableJson(
      opts.prepareIntentOut,
      {
        format: 1,
        kind: 'DISPOSITION_RESTORE_PREPARATION_INTENT',
        deploymentId: opts.deploymentId,
        parentGeneration: opts.parentGeneration,
        recoveryOperationId: opts.recoveryOperationId,
        auditSha256: opts.auditSha256,
        backupManifestSha256: opts.backupManifestSha256,
        backupSha256: opts.backupSha256,
        identitySha256: opts.identitySha256,
        capabilityGeneration: preCapabilityHead.generation,
        capabilityHeadSha256: preCapabilityHead.generationSha256,
        capabilityWitnessSha256: preCapabilityHead.witnessSha256,
        activityGeneration: loaded.activity.externalHead.generation,
        activityEntrySha256: loaded.activity.externalHead.entrySha256,
        activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
        observedDispositionReceiptSha256,
        observedBranch: branch,
        createdAt: opts.createdAt || new Date().toISOString(),
      },
      ownershipAdapter
    );
    if (branch === 'UNHEADED_CLEAR_COMPLETED') {
      const resumed = resumeDispositionProposal(loaded, opts, roots, ownershipAdapter);
      if (!resumed || resumed.rejected) {
        throw transitionError('disposition_proposal_changed', 'validated disposition proposal changed before completion');
      }
      loaded = resumed.loaded;
    }
    const resultDocument = {
      format: 1,
      kind: 'DISPOSITION_RESTORE_PREPARATION_RESULT',
      deploymentId: opts.deploymentId,
      parentGeneration: opts.parentGeneration,
      recoveryOperationId: opts.recoveryOperationId,
      intentSha256: codecs.canonicalSha256(intent),
      result: branch,
      reason,
      auditSha256: opts.auditSha256,
      backupManifestSha256: opts.backupManifestSha256,
      backupSha256: opts.backupSha256,
      identitySha256: opts.identitySha256,
      observedDispositionReceiptSha256,
      preCapabilityHeadSha256: preCapabilityHead.generationSha256,
      postCapabilityHeadSha256: loaded.capability.head.generationSha256,
      capabilityWitnessSha256: loaded.capability.head.witnessSha256,
      activityGeneration: loaded.activity.externalHead.generation,
      activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
      completionOperationId,
      createdAt: opts.createdAt || new Date().toISOString(),
    };
    const result = publishImmutableJson(opts.resultOut, resultDocument, ownershipAdapter);
    return result;
  } finally {
    lock.release();
  }
}

function invalidateHistoricalV2Disposition(options) {
  const opts = options || {};
  assertOperationId(opts.operationId, 'operationId');
  assertOperationId(opts.recoveryOperationId, 'recoveryOperationId');
  for (const field of [
    'restoreReceiptSha256',
    'restoredDatabaseAuditSha256',
    'identitySha256',
    'expectedHeadSha256',
    'expectedWitnessSha256',
  ]) {
    assertSha(opts[field], field);
  }
  const preparation = opts.restorePreparationResult;
  if (
    !preparation ||
    preparation.kind !== 'DISPOSITION_RESTORE_PREPARATION_RESULT' ||
    !['COMMITTED_CLEAR', 'UNHEADED_CLEAR_COMPLETED'].includes(preparation.result) ||
    preparation.recoveryOperationId !== opts.recoveryOperationId
  ) {
    throw transitionError(
      'disposition_restore_preparation_invalid',
      'invalidation requires the same-recovery COMMITTED_CLEAR or UNHEADED_CLEAR_COMPLETED preparation result'
    );
  }
  const loaded = load.loadProtocolState(opts);
  if (!loaded.initialized) {
    throw transitionError('protocol_state_not_ready', 'disposition invalidation requires complete protocol roots');
  }
  const committed = loaded.capability.generations.at(-1);
  if (!loaded.resumePending && committed.generation.operationId === opts.operationId) {
    const committedState = committed.generation.state;
    if (
      committed.generation.kind !== 'HISTORICAL_V2_DISPOSITION' ||
      committedState.sourceKind !== 'restore-invalidation' ||
      committedState.recoveryOperationId !== opts.recoveryOperationId ||
      committedState.restorePreparationResultSha256 !== codecs.canonicalSha256(preparation) ||
      committedState.restoreReceiptSha256 !== opts.restoreReceiptSha256 ||
      committedState.restoredDatabaseAuditSha256 !== opts.restoredDatabaseAuditSha256 ||
      committedState.identitySha256 !== opts.identitySha256
    ) throw transitionError('committed_transition_mismatch', 'committed disposition invalidation does not match retry authority');
    return {
      generation: committed.generation.generation,
      generationSha256: committed.generationSha256,
      witnessSha256: loaded.capability.head.witnessSha256,
      receiptSha256: committedState.historicalV2DispositionReceiptSha256,
      state: committedState,
      resumed: true,
    };
  }
  assertExpectedHeads(loaded, opts);
  const prior = transitionPredecessor(loaded, opts.operationId, 'HISTORICAL_V2_DISPOSITION');
  if (prior.generation.state.historicalV2Disposition !== 'CLEAR') {
    throw transitionError('disposition_clear_required', 'disposition invalidation requires a committed prior CLEAR');
  }
  const createdAt = transitionCreatedAt(loaded, opts.operationId, 'HISTORICAL_V2_DISPOSITION', opts.createdAt);
  const receipt = {
    format: 1,
    receiptKind: 'historical-v2-disposition',
    operationId: opts.operationId,
    sourceKind: 'restore-invalidation',
    sourceAuthorityKind: null,
    recoveryOperationId: opts.recoveryOperationId,
    recoveryPhase: 'disposition-restoring',
    restorePreparationResultSha256: codecs.canonicalSha256(preparation),
    restoreReceiptSha256: opts.restoreReceiptSha256,
    restoredDatabaseAuditSha256: opts.restoredDatabaseAuditSha256,
    priorClearGeneration: prior.generation.generation,
    priorClearGenerationSha256: prior.generationSha256,
    identitySha256: opts.identitySha256,
    predecessorHeadSha256: loaded.capability.head.generationSha256,
    predecessorWitnessSha256: loaded.capability.head.witnessSha256,
    historicalV2Disposition: 'RECONCILIATION_REQUIRED',
    createdAt,
  };
  const receiptSha256 = codecs.canonicalSha256(receipt);
  const state = {
    activeIdentitySha256: null,
    mode: 'UNNEGOTIATED',
    historicalV2Disposition: 'RECONCILIATION_REQUIRED',
    historicalV2DispositionReceiptSha256: receiptSha256,
    databaseRestore: { ...prior.generation.state.databaseRestore },
    sourceKind: 'restore-invalidation',
    recoveryOperationId: opts.recoveryOperationId,
    recoveryPhase: 'disposition-restoring',
    restorePreparationResultSha256: codecs.canonicalSha256(preparation),
    restoreReceiptSha256: opts.restoreReceiptSha256,
    restoredDatabaseAuditSha256: opts.restoredDatabaseAuditSha256,
    priorClearGeneration: prior.generation.generation,
    priorClearGenerationSha256: prior.generationSha256,
    identitySha256: opts.identitySha256,
  };
  const roots = paths.resolveRoots(opts);
  return appendTransition({ ...opts, createdAt }, {
    kind: 'HISTORICAL_V2_DISPOSITION',
    state,
    receipt,
    receiptPath: path.join(roots.v2DispositionReceiptsDir, `${opts.operationId}.json`),
  });
}

const WHOLE_DATABASE_AUDIT_KEYS = [
  'format', 'databasePath', 'databaseIdentitySha256', 'schemaVersion', 'userVersion',
  'schemaSha256', 'tableInventorySha256', 'tables', 'fullLogicalSha256', 'quickCheck',
  'firstReadSha256', 'secondReadSha256', 'createdAt',
];

function validateWholeDatabaseAudit(report, label) {
  assertExactKeys(report, WHOLE_DATABASE_AUDIT_KEYS, label);
  if (report.format !== 1 || report.databasePath !== '/data/db/farming.db' || report.quickCheck !== 'ok') {
    throw transitionError('farming_audit_invalid', `${label} has invalid fixed fields`);
  }
  if (!Number.isSafeInteger(report.schemaVersion) || !Number.isSafeInteger(report.userVersion)) {
    throw transitionError('farming_audit_invalid', `${label} versions must be safe integers`);
  }
  for (const field of [
    'databaseIdentitySha256', 'schemaSha256', 'tableInventorySha256', 'fullLogicalSha256',
    'firstReadSha256', 'secondReadSha256',
  ]) assertSha(report[field], `${label}.${field}`);
  if (report.firstReadSha256 !== report.secondReadSha256) {
    throw transitionError('farming_audit_unstable', `${label} repeated reads disagree`);
  }
  if (!Array.isArray(report.tables)) throw transitionError('farming_audit_invalid', `${label}.tables must be an array`);
  let previous = null;
  for (const table of report.tables) {
    assertExactKeys(table, ['name', 'rowCount', 'rowSetSha256'], `${label}.tables[]`);
    if (typeof table.name !== 'string' || !table.name || table.name <= (previous || '')) {
      throw transitionError('farming_audit_invalid', `${label}.tables must be sorted and unique`);
    }
    if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0) {
      throw transitionError('farming_audit_invalid', `${label}.tables[].rowCount must be nonnegative`);
    }
    assertSha(table.rowSetSha256, `${label}.tables[].rowSetSha256`);
    previous = table.name;
  }
  return report;
}

function changedTableNames(before, after) {
  const a = new Map(before.tables.map((entry) => [entry.name, `${entry.rowCount}:${entry.rowSetSha256}`]));
  const b = new Map(after.tables.map((entry) => [entry.name, `${entry.rowCount}:${entry.rowSetSha256}`]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((name) => a.get(name) !== b.get(name)).sort();
}

function prepareDatabaseRestore(options) {
  const opts = options || {};
  assertOperationId(opts.recoveryOperationId, 'recoveryOperationId');
  validateWholeDatabaseAudit(opts.backupFarmingAudit, 'backup farming audit');
  validateWholeDatabaseAudit(opts.currentFarmingAudit, 'current farming audit');
  const loaded = load.loadProtocolState(opts);
  if (!loaded.initialized || loaded.resumePending) {
    if (!loaded.initialized || !pendingTransition(loaded, opts.recoveryOperationId, 'DATABASE_RESTORE_INVALIDATION')) {
      throw transitionError('protocol_state_not_ready', 'database restore preparation requires complete roots or its exact pending invalidation');
    }
  }
  const committed = loaded.capability.generations.at(-1);
  const sameCommittedTransition =
    !loaded.resumePending && committed.generation.operationId === opts.recoveryOperationId &&
    committed.generation.kind === 'DATABASE_RESTORE_INVALIDATION';
  if (!sameCommittedTransition) assertExpectedHeads(loaded, opts);
  const predecessor = transitionPredecessor(loaded, opts.recoveryOperationId, 'DATABASE_RESTORE_INVALIDATION');
  const priorState = predecessor.generation.state;
  const transitionTime = transitionCreatedAt(loaded, opts.recoveryOperationId, 'DATABASE_RESTORE_INVALIDATION', opts.createdAt);
  const createdAt = fs.existsSync(opts.prepareIntentOut)
    ? JSON.parse(fs.readFileSync(opts.prepareIntentOut, 'utf8')).createdAt
    : transitionTime;
  const backupCommandAuditSha256 = codecs.canonicalSha256(opts.backupCommandAudit);
  const backupFarmingAuditSha256 = codecs.canonicalSha256(opts.backupFarmingAudit);
  const currentCommandAuditSha256 = codecs.canonicalSha256(opts.currentCommandAudit);
  const currentFarmingAuditSha256 = codecs.canonicalSha256(opts.currentFarmingAudit);
  const backupManifestSha256 = codecs.canonicalSha256(opts.backupManifest);
  const restoreBaselineSha256 = codecs.canonicalSha256(opts.restoreBaseline);
  const reverseMergeAdapterInventorySha256 = codecs.canonicalSha256(opts.reverseMergeAdapterInventory);
  if (
    opts.restoreBaseline.backupCommandAuditSha256 !== backupCommandAuditSha256 ||
    opts.restoreBaseline.backupFarmingAuditSha256 !== backupFarmingAuditSha256
  ) {
    throw transitionError('restore_baseline_backup_mismatch', 'restore baseline does not bind the supplied backup audits');
  }
  const wholeEqual = backupFarmingAuditSha256 === currentFarmingAuditSha256;
  const commandEqual = backupCommandAuditSha256 === currentCommandAuditSha256;
  let result;
  let reason = null;
  let changedCommandTables = [];
  let changedNonCommandTables = [];
  if (wholeEqual && commandEqual) {
    result = 'NO_POST_BACKUP_DATABASE_DELTA';
  } else if (
    opts.restoreBaseline.baselineCommandAuditSha256 === currentCommandAuditSha256 &&
    opts.restoreBaseline.baselineFarmingAuditSha256 === currentFarmingAuditSha256
  ) {
    result = 'EXPECTED_DEPLOYMENT_MUTATION_ONLY';
  } else {
    const changed = changedTableNames(opts.backupFarmingAudit, opts.currentFarmingAudit);
    const owned = new Set(
      Array.isArray(opts.currentCommandAudit.commandOwnedTables) ? opts.currentCommandAudit.commandOwnedTables : []
    );
    changedCommandTables = changed.filter((name) => owned.has(name));
    changedNonCommandTables = changed.filter((name) => !owned.has(name));
    if (changedNonCommandTables.length > 0 || opts.backupFarmingAudit.schemaSha256 !== opts.currentFarmingAudit.schemaSha256) {
      result = 'REJECTED';
      reason = 'NON_COMMAND_DATABASE_DELTA';
    } else if (changedCommandTables.length === 0) {
      result = 'REJECTED';
      reason = 'MALFORMED_EVIDENCE';
    } else {
      result = 'RECONCILIATION_REQUIRED';
    }
  }

  const currentEvidence = {
    format: 1,
    evidenceKind: 'READABLE',
    databaseIdentitySha256: opts.currentFarmingAudit.databaseIdentitySha256,
    commandAuditSha256: currentCommandAuditSha256,
    farmingAuditSha256: currentFarmingAuditSha256,
    createdAt,
  };
  const intent = publishImmutableJson(
    opts.prepareIntentOut,
    {
      format: 1,
      kind: 'DATABASE_RESTORE_PREPARATION_INTENT',
      deploymentId: opts.deploymentId,
      parentGeneration: opts.parentGeneration,
      recoveryOperationId: opts.recoveryOperationId,
      restoreEpochCandidate: priorState.databaseRestore.restoreEpoch + 1,
      backupManifestSha256,
      backupDatabaseSha256: opts.backupManifest.databaseSha256,
      backupCommandAuditSha256,
      backupFarmingAuditSha256,
      restoreBaselineSha256,
      expectedMutationDeltaSha256: opts.restoreBaseline.expectedMutationDeltaSha256,
      reverseMergeAdapterInventorySha256,
      currentEvidenceSha256: codecs.canonicalSha256(currentEvidence),
      capabilityGeneration: predecessor.generation.generation,
      capabilityHeadSha256: predecessor.generationSha256,
      capabilityWitnessSha256: loaded.capability.witnessByGeneration.get(predecessor.generation.generation).witnessSha256,
      activityGeneration: loaded.activity.externalHead.generation,
      activityEntrySha256: loaded.activity.externalHead.entrySha256,
      activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
      writerGeneration: opts.restoreBaseline.writerGeneration,
      databaseLineageInvalidationReceiptSha256: opts.databaseLineageInvalidationReceiptSha256,
      createdAt,
    },
    opts.ownershipAdapter || paths.defaultOwnershipAdapter
  );

  const common = {
    format: 1,
    kind: 'DATABASE_RESTORE_PREPARATION_RESULT',
    deploymentId: opts.deploymentId,
    parentGeneration: opts.parentGeneration,
    recoveryOperationId: opts.recoveryOperationId,
    intentSha256: codecs.canonicalSha256(intent),
    backupManifestSha256,
    restoreBaselineSha256,
    expectedMutationDeltaSha256: opts.restoreBaseline.expectedMutationDeltaSha256,
    currentEvidenceSha256: codecs.canonicalSha256(currentEvidence),
    createdAt,
  };
  if (result === 'NO_POST_BACKUP_DATABASE_DELTA' || result === 'EXPECTED_DEPLOYMENT_MUTATION_ONLY') {
    const branch = {
      ...common,
      result,
      backupCommandAuditSha256,
      baselineCommandAuditSha256: opts.restoreBaseline.baselineCommandAuditSha256,
      currentCommandAuditSha256,
      backupFarmingAuditSha256,
      baselineFarmingAuditSha256: opts.restoreBaseline.baselineFarmingAuditSha256,
      currentFarmingAuditSha256,
      activityGeneration: loaded.activity.externalHead.generation,
      activityEntrySha256: loaded.activity.externalHead.entrySha256,
      activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
      capabilityGeneration: predecessor.generation.generation,
      capabilityHeadSha256: predecessor.generationSha256,
      capabilityWitnessSha256: loaded.capability.witnessByGeneration.get(predecessor.generation.generation).witnessSha256,
      writerGeneration: opts.restoreBaseline.writerGeneration,
      ...(result === 'EXPECTED_DEPLOYMENT_MUTATION_ONLY'
        ? {
            mutationOperationId: opts.restoreBaseline.mutationOperationId,
            mutationKind: opts.restoreBaseline.mutationKind,
            orderedUnitManifestSha256: opts.restoreBaseline.orderedUnitManifestSha256,
            runnerReceiptSha256: opts.restoreBaseline.runnerReceiptSha256,
          }
        : {}),
    };
    branch.proofSha256 = codecs.canonicalSha256(branch);
    return publishImmutableJson(opts.resultOut, branch, opts.ownershipAdapter || paths.defaultOwnershipAdapter);
  }
  if (result === 'REJECTED') {
    return publishImmutableJson(
      opts.resultOut,
      {
        ...common,
        result,
        reason,
        changedNonCommandTables,
        evidenceSha256: codecs.canonicalSha256({ currentEvidence, changedNonCommandTables }),
      },
      opts.ownershipAdapter || paths.defaultOwnershipAdapter
    );
  }

  // The snapshot producer is deliberately injectable for deterministic
  // tests. Production wiring must supply the SQLite online-backup adapter;
  // a raw filesystem copy is never used here.
  if (typeof opts.snapshotAdapter !== 'function') {
    throw transitionError('snapshot_adapter_missing', 'RECONCILIATION_REQUIRED needs the reviewed SQLite online-backup adapter');
  }
  const snapshotManifest = opts.snapshotAdapter({
    snapshotPath: opts.currentSnapshot,
    recoveryOperationId: opts.recoveryOperationId,
    restoreEpoch: priorState.databaseRestore.restoreEpoch + 1,
    currentCommandAudit: opts.currentCommandAudit,
    currentFarmingAudit: opts.currentFarmingAudit,
    reverseMergeAdapterInventorySha256,
    createdAt,
  });
  const restoreEpoch = priorState.databaseRestore.restoreEpoch + 1;
  const receipt = {
    format: 1,
    receiptKind: 'database-restore-invalidation',
    operationId: opts.recoveryOperationId,
    deploymentId: opts.deploymentId,
    parentGeneration: opts.parentGeneration,
    recoveryOperationId: opts.recoveryOperationId,
    restoreEpoch,
    predecessorGeneration: predecessor.generation.generation,
    predecessorHeadSha256: predecessor.generationSha256,
    predecessorWitnessSha256: loaded.capability.witnessByGeneration.get(predecessor.generation.generation).witnessSha256,
    activityGeneration: loaded.activity.externalHead.generation,
    activityEntrySha256: loaded.activity.externalHead.entrySha256,
    activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
    backupManifestSha256,
    restoreBaselineSha256,
    expectedMutationDeltaSha256: opts.restoreBaseline.expectedMutationDeltaSha256,
    backupCommandAuditSha256,
    backupFarmingAuditSha256,
    baselineCommandAuditSha256: opts.restoreBaseline.baselineCommandAuditSha256,
    baselineFarmingAuditSha256: opts.restoreBaseline.baselineFarmingAuditSha256,
    currentCommandAuditSha256,
    currentFarmingAuditSha256,
    reverseMergeAdapterInventorySha256,
    snapshotManifestSha256: codecs.canonicalSha256(snapshotManifest),
    databaseLineageInvalidationReceiptSha256: opts.databaseLineageInvalidationReceiptSha256,
    preparationIntentSha256: codecs.canonicalSha256(intent),
    createdAt,
  };
  const transition = appendTransition(
    {
      ...opts,
      operationId: opts.recoveryOperationId,
      expectedActivityGeneration: loaded.activity.externalHead.generation,
      expectedActivityHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
      createdAt,
    },
    {
      kind: 'DATABASE_RESTORE_INVALIDATION',
      state: {
        ...ambientState(priorState),
        databaseRestore: { status: 'RECONCILIATION_REQUIRED', restoreEpoch },
        invalidationReceiptSha256: codecs.canonicalSha256(receipt),
        recoveryOperationId: opts.recoveryOperationId,
      },
      receipt,
      receiptPath: path.join(paths.resolveRoots(opts).databaseRestoreReceiptsDir, `${restoreEpoch}.invalidation.json`),
    }
  );
  return publishImmutableJson(
    opts.resultOut,
    {
      ...common,
      result: 'RECONCILIATION_REQUIRED',
      restoreEpoch,
      baselineCommandAuditSha256: opts.restoreBaseline.baselineCommandAuditSha256,
      baselineFarmingAuditSha256: opts.restoreBaseline.baselineFarmingAuditSha256,
      currentCommandAuditSha256,
      currentFarmingAuditSha256,
      changedCommandTables,
      reverseMergeAdapterInventorySha256,
      snapshotManifestSha256: codecs.canonicalSha256(snapshotManifest),
      invalidationReceiptSha256: transition.receiptSha256,
      invalidationGeneration: transition.generation,
      invalidationHeadSha256: transition.generationSha256,
      invalidationWitnessSha256: transition.witnessSha256,
    },
    opts.ownershipAdapter || paths.defaultOwnershipAdapter
  );
}

function completeDatabaseRestoreReconciliation(options) {
  const opts = options || {};
  assertOperationId(opts.recoveryOperationId, 'recoveryOperationId');
  const operationId = opts.operationId || `${opts.recoveryOperationId}:database-restore-reconciled`;
  assertOperationId(operationId, 'operationId');
  const prepared = opts.prepareResult;
  if (
    !prepared || prepared.kind !== 'DATABASE_RESTORE_PREPARATION_RESULT' ||
    prepared.result !== 'RECONCILIATION_REQUIRED' || prepared.recoveryOperationId !== opts.recoveryOperationId
  ) {
    throw transitionError('database_restore_prepare_result_invalid', 'completion requires the same recovery RECONCILIATION_REQUIRED result');
  }
  const merge = opts.mergeReceipt;
  if (
    !merge || merge.receiptKind !== 'database-restore-merge' || merge.result !== 'MERGED' ||
    merge.recoveryOperationId !== opts.recoveryOperationId || merge.restoreEpoch !== prepared.restoreEpoch ||
    merge.externalEffectCalls !== 0 || merge.ackTransportCalls !== 0 ||
    merge.prepareResultSha256 !== codecs.canonicalSha256(prepared)
  ) {
    throw transitionError('database_restore_merge_receipt_invalid', 'merge receipt does not prove a zero-effect merge for the prepared epoch');
  }
  const post = opts.postMergeAuditReport;
  if (!post || post.format !== 1 || !post.commandAudit || !post.farmingAudit) {
    throw transitionError('database_restore_post_merge_audit_invalid', 'post-merge report must carry command and farming audits');
  }
  validateWholeDatabaseAudit(post.farmingAudit, 'post-merge farming audit');
  const postCommandAuditSha256 = codecs.canonicalSha256(post.commandAudit);
  const postFarmingAuditSha256 = codecs.canonicalSha256(post.farmingAudit);
  if (
    merge.afterCommandAuditSha256 !== postCommandAuditSha256 ||
    merge.afterFarmingAuditSha256 !== postFarmingAuditSha256 ||
    merge.expectedPostMergeFarmingAuditSha256 !== postFarmingAuditSha256
  ) {
    throw transitionError('database_restore_post_merge_audit_mismatch', 'post-merge audits do not match the reviewed merge receipt');
  }
  const loaded = load.loadProtocolState(opts);
  if (!loaded.initialized) throw transitionError('protocol_state_not_ready', 'reconciliation requires complete protocol roots');
  const committed = loaded.capability.generations.at(-1);
  const sameCommittedTransition = !loaded.resumePending &&
    committed.generation.operationId === operationId &&
    committed.generation.kind === 'DATABASE_RESTORE_RECONCILED';
  if (!sameCommittedTransition) assertExpectedHeads(loaded, opts);
  const prior = transitionPredecessor(loaded, operationId, 'DATABASE_RESTORE_RECONCILED');
  const priorState = prior.generation.state;
  if (
    priorState.databaseRestore.status !== 'RECONCILIATION_REQUIRED' ||
    priorState.databaseRestore.restoreEpoch !== prepared.restoreEpoch ||
    prior.generation.generation !== prepared.invalidationGeneration ||
    prior.generationSha256 !== prepared.invalidationHeadSha256 ||
    loaded.capability.witnessByGeneration.get(prior.generation.generation).witnessSha256 !== prepared.invalidationWitnessSha256
  ) {
    throw transitionError('database_restore_epoch_mismatch', 'live capability head is not the exact prepared invalidation epoch');
  }
  if (
    loaded.activity.externalHead.generation !== opts.expectedActivityGeneration ||
    codecs.canonicalSha256(loaded.activity.externalHead) !== opts.expectedActivityHeadSha256
  ) {
    throw transitionError('activity_head_changed', 'activity roots changed during restore reconciliation');
  }
  const createdAt = transitionCreatedAt(loaded, operationId, 'DATABASE_RESTORE_RECONCILED', opts.createdAt);
  const receipt = {
    format: 1,
    receiptKind: 'database-restore-reconciled',
    operationId,
    deploymentId: opts.deploymentId,
    parentGeneration: opts.parentGeneration,
    recoveryOperationId: opts.recoveryOperationId,
    restoreEpoch: prepared.restoreEpoch,
    invalidationGeneration: prepared.invalidationGeneration,
    invalidationReceiptSha256: prepared.invalidationReceiptSha256,
    restoreBaselineSha256: prepared.restoreBaselineSha256,
    expectedMutationDeltaSha256: prepared.expectedMutationDeltaSha256,
    mergeReceiptSha256: codecs.canonicalSha256(merge),
    postMergeCommandAuditSha256: postCommandAuditSha256,
    postMergeFarmingAuditSha256: postFarmingAuditSha256,
    expectedPostMergeFarmingAuditSha256: merge.expectedPostMergeFarmingAuditSha256,
    activityGeneration: loaded.activity.externalHead.generation,
    activityEntrySha256: loaded.activity.externalHead.entrySha256,
    activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
    predecessorHeadSha256: prior.generationSha256,
    createdAt,
  };
  const roots = paths.resolveRoots(opts);
  return appendTransition(
    { ...opts, operationId, createdAt },
    {
      kind: 'DATABASE_RESTORE_RECONCILED',
      state: {
        ...ambientState(priorState),
        databaseRestore: { status: 'CLEAR', restoreEpoch: prepared.restoreEpoch },
        reconciledReceiptSha256: codecs.canonicalSha256(receipt),
        recoveryOperationId: opts.recoveryOperationId,
      },
      receipt,
      receiptPath: path.join(roots.databaseRestoreReceiptsDir, `${prepared.restoreEpoch}.reconciled.json`),
    }
  );
}

function validateIntegrityObservation(observed) {
  assertExactKeys(observed, [
    'format', 'kind', 'requestId', 'recoveryRequestSha256', 'databasePath',
    'observedDatabaseIdentitySha256', 'quickCheckResult', 'sqliteMembers', 'bootIdSha256', 'createdAt',
  ], 'database-integrity observation');
  if (
    observed.format !== 1 || observed.kind !== 'DATABASE_INTEGRITY_OBSERVATION' ||
    observed.databasePath !== '/data/db/farming.db' ||
    !['missing', 'failed', 'timeout', 'unreadable'].includes(observed.quickCheckResult) ||
    !Array.isArray(observed.sqliteMembers) || observed.sqliteMembers.length !== 4
  ) throw transitionError('integrity_observation_invalid', 'database-integrity observation has invalid fixed fields');
  assertSha(observed.recoveryRequestSha256, 'observedEvidence.recoveryRequestSha256');
  assertSha(observed.observedDatabaseIdentitySha256, 'observedEvidence.observedDatabaseIdentitySha256');
  assertSha(observed.bootIdSha256, 'observedEvidence.bootIdSha256');
  const expectedNames = ['journal', 'main', 'shm', 'wal'];
  observed.sqliteMembers.forEach((member, index) => {
    assertExactKeys(member, ['name', 'path', 'status', 'device', 'inode', 'sizeBytes', 'sha256'], 'sqlite member');
    if (member.name !== expectedNames[index] || !['ABSENT', 'PRESENT'].includes(member.status)) {
      throw transitionError('integrity_observation_invalid', 'sqlite members must be sorted and complete');
    }
    if (member.status === 'ABSENT') {
      if ([member.device, member.inode, member.sizeBytes, member.sha256].some((value) => value !== null)) {
        throw transitionError('integrity_observation_invalid', 'absent sqlite member facts must be null');
      }
    } else {
      if (![member.device, member.inode, member.sizeBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw transitionError('integrity_observation_invalid', 'present sqlite member facts must be safe nonnegative integers');
      }
      assertSha(member.sha256, 'sqlite member sha256');
    }
  });
  return observed;
}

function prepareIntegrityRecovery(options) {
  const opts = options || {};
  const authority = opts.authority;
  assertExactKeys(authority, [
    'format', 'kind', 'requestId', 'recoveryOperationId', 'recoveryRequestSha256',
    'backupManifestSha256', 'backupDatabaseSha256', 'observedEvidenceSha256',
    'possibleDataLossAcknowledgementSha256', 'databaseLineageInvalidationReceiptSha256',
    'disposition', 'createdAt',
  ], 'database-integrity recovery authority');
  if (
    authority.format !== 1 || authority.kind !== 'DATABASE_INTEGRITY_RECOVERY_AUTHORITY' ||
    authority.disposition !== 'RESTORE_TRUSTED_BACKUP_AND_RECONCILE'
  ) throw transitionError('integrity_authority_invalid', 'database-integrity authority has invalid fixed fields');
  assertOperationId(authority.recoveryOperationId, 'authority.recoveryOperationId');
  validateIntegrityObservation(opts.observedEvidence);
  const recoveryRequestSha256 = codecs.canonicalSha256(opts.recoveryRequest);
  const observedEvidenceSha256 = codecs.canonicalSha256(opts.observedEvidence);
  const backupManifestSha256 = codecs.canonicalSha256(opts.backupManifest);
  if (
    authority.requestId !== opts.recoveryRequest.requestId ||
    authority.recoveryRequestSha256 !== recoveryRequestSha256 ||
    authority.observedEvidenceSha256 !== observedEvidenceSha256 ||
    authority.backupManifestSha256 !== backupManifestSha256 ||
    authority.backupDatabaseSha256 !== opts.backupManifest.databaseSha256 ||
    opts.observedEvidence.recoveryRequestSha256 !== recoveryRequestSha256 ||
    authority.databaseLineageInvalidationReceiptSha256 !== opts.databaseLineageInvalidationReceiptSha256
  ) throw transitionError('integrity_authority_mismatch', 'database-integrity authority graph does not close over the supplied evidence');
  paths.assertNoSymlinkComponents(opts.forensicDestination);
  const forensicDestinationExists = fs.existsSync(opts.forensicDestination);
  const loaded = load.loadProtocolState(opts);
  if (!loaded.initialized || (loaded.resumePending && !pendingTransition(
    loaded,
    authority.recoveryOperationId,
    'DATABASE_INTEGRITY_INVALIDATION'
  ))) {
    throw transitionError('protocol_state_not_ready', 'this verb requires complete roots or its exact pending integrity invalidation');
  }
  const committed = loaded.capability.generations.at(-1);
  const sameCommittedTransition = !loaded.resumePending &&
    committed.generation.operationId === authority.recoveryOperationId &&
    committed.generation.kind === 'DATABASE_INTEGRITY_INVALIDATION';
  if (sameCommittedTransition && fs.existsSync(opts.resultOut)) {
    const committedState = committed.generation.state;
    const existingResult = JSON.parse(fs.readFileSync(opts.resultOut, 'utf8'));
    if (
      committedState.authoritySha256 !== codecs.canonicalSha256(authority) ||
      committedState.observedEvidenceSha256 !== observedEvidenceSha256 ||
      committedState.backupManifestSha256 !== backupManifestSha256 ||
      committedState.forensicDestination !== opts.forensicDestination ||
      committedState.possibleDataLossAcknowledgementSha256 !== authority.possibleDataLossAcknowledgementSha256 ||
      existingResult.kind !== 'DATABASE_INTEGRITY_RECOVERY_PREPARATION_RESULT' ||
      existingResult.result !== 'BACKUP_REPLACEMENT_PREPARED' ||
      existingResult.requestId !== authority.requestId ||
      existingResult.recoveryOperationId !== authority.recoveryOperationId ||
      existingResult.authoritySha256 !== codecs.canonicalSha256(authority) ||
      existingResult.forensicDestination !== opts.forensicDestination ||
      existingResult.invalidationGeneration !== committed.generation.generation ||
      existingResult.invalidationReceiptSha256 !== committedState.invalidationReceiptSha256
    ) throw transitionError('committed_transition_mismatch', 'committed integrity invalidation does not match retry authority');
    return publishImmutableJson(opts.resultOut, existingResult, opts.ownershipAdapter || paths.defaultOwnershipAdapter);
  }
  if (forensicDestinationExists) {
    throw transitionError('forensic_destination_not_absent', 'forensic destination must be absent before invalidation');
  }
  if (!sameCommittedTransition) assertExpectedHeads(loaded, opts);
  if (
    loaded.activity.externalHead.generation !== opts.backupManifest.activityGeneration ||
    loaded.activity.externalHead.entrySha256 !== opts.backupManifest.activityEntrySha256 ||
    codecs.canonicalSha256(loaded.activity.externalHead) !== opts.backupManifest.activityExternalHeadSha256
  ) throw transitionError('integrity_activity_backup_mismatch', 'trusted backup does not bind the current activity roots');
  const predecessor = transitionPredecessor(loaded, authority.recoveryOperationId, 'DATABASE_INTEGRITY_INVALIDATION');
  const priorState = predecessor.generation.state;
  const restoreEpoch = priorState.databaseRestore.restoreEpoch + 1;
  const operationId = authority.recoveryOperationId;
  const createdAt = transitionCreatedAt(loaded, operationId, 'DATABASE_INTEGRITY_INVALIDATION', opts.createdAt);
  const receipt = {
    format: 1,
    receiptKind: 'database-integrity-invalidation',
    operationId,
    requestId: authority.requestId,
    recoveryOperationId: authority.recoveryOperationId,
    restoreEpoch,
    recoveryRequestSha256,
    authoritySha256: codecs.canonicalSha256(authority),
    observedEvidenceSha256,
    databaseLineageInvalidationReceiptSha256: opts.databaseLineageInvalidationReceiptSha256,
    observedDatabaseIdentitySha256: opts.observedEvidence.observedDatabaseIdentitySha256,
    quickCheckResult: opts.observedEvidence.quickCheckResult,
    backupManifestSha256,
    backupDatabaseSha256: opts.backupManifest.databaseSha256,
    backupCommandAuditSha256: opts.backupManifest.commandAuditSha256,
    backupFarmingAuditSha256: opts.backupManifest.farmingAuditSha256,
    forensicDestination: opts.forensicDestination,
    protocolInitialization: 'EXISTING',
    predecessorGeneration: predecessor.generation.generation,
    predecessorHeadSha256: predecessor.generationSha256,
    predecessorWitnessSha256: loaded.capability.witnessByGeneration.get(predecessor.generation.generation).witnessSha256,
    activityGeneration: loaded.activity.externalHead.generation,
    activityEntrySha256: loaded.activity.externalHead.entrySha256,
    activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
    createdAt,
  };
  const transition = appendTransition(
    { ...opts, operationId, createdAt },
    {
      kind: 'DATABASE_INTEGRITY_INVALIDATION',
      state: {
        ...ambientState(priorState),
        databaseRestore: { status: 'RECONCILIATION_REQUIRED', restoreEpoch },
        invalidationReceiptSha256: codecs.canonicalSha256(receipt),
        authoritySha256: codecs.canonicalSha256(authority),
        observedEvidenceSha256,
        backupManifestSha256,
        forensicDestination: opts.forensicDestination,
        activityGeneration: loaded.activity.externalHead.generation,
        activityEntrySha256: loaded.activity.externalHead.entrySha256,
        activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
        possibleDataLossAcknowledgementSha256: authority.possibleDataLossAcknowledgementSha256,
        recoveryOperationId: authority.recoveryOperationId,
      },
      receipt,
      receiptPath: path.join(paths.resolveRoots(opts).databaseIntegrityReceiptsDir, `${restoreEpoch}.invalidation.json`),
    }
  );
  return publishImmutableJson(
    opts.resultOut,
    {
      format: 1,
      kind: 'DATABASE_INTEGRITY_RECOVERY_PREPARATION_RESULT',
      requestId: authority.requestId,
      recoveryOperationId: authority.recoveryOperationId,
      recoveryRequestSha256,
      authoritySha256: codecs.canonicalSha256(authority),
      observedEvidenceSha256,
      databaseLineageInvalidationReceiptSha256: opts.databaseLineageInvalidationReceiptSha256,
      result: 'BACKUP_REPLACEMENT_PREPARED',
      protocolInitialization: 'EXISTING',
      restoreEpoch,
      backupManifestSha256,
      backupDatabaseSha256: opts.backupManifest.databaseSha256,
      backupCommandAuditSha256: opts.backupManifest.commandAuditSha256,
      backupFarmingAuditSha256: opts.backupManifest.farmingAuditSha256,
      forensicDestination: opts.forensicDestination,
      activityGeneration: loaded.activity.externalHead.generation,
      activityEntrySha256: loaded.activity.externalHead.entrySha256,
      activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
      invalidationGeneration: transition.generation,
      invalidationReceiptSha256: transition.receiptSha256,
      invalidationHeadSha256: transition.generationSha256,
      invalidationWitnessSha256: transition.witnessSha256,
      createdAt,
    },
    opts.ownershipAdapter || paths.defaultOwnershipAdapter
  );
}

function completeIntegrityRecovery(options) {
  const opts = options || {};
  const authority = opts.reconciliationAuthority;
  assertExactKeys(authority, [
    'format', 'kind', 'requestId', 'recoveryOperationId', 'restoreEpoch', 'disposition',
    'forensicInventorySha256', 'cloudComparisonSha256', 'offlineImportManifestSha256',
    'recoveredRowsManifestSha256', 'acceptedLossBoundarySha256',
    'commandCapabilityCutoffProofSha256', 'actorPrincipalSha256', 'authorizedAt',
  ], 'database-integrity reconciliation authority');
  if (
    authority.format !== 1 || authority.kind !== 'DATABASE_INTEGRITY_RECONCILIATION_AUTHORITY' ||
    !['IMPORT_RECOVERED_ROWS', 'ACCEPT_BACKUP_CUTOFF'].includes(authority.disposition)
  ) throw transitionError('integrity_reconciliation_authority_invalid', 'reconciliation authority has invalid fixed fields');
  assertOperationId(authority.recoveryOperationId, 'authority.recoveryOperationId');
  for (const field of ['forensicInventorySha256', 'cloudComparisonSha256', 'actorPrincipalSha256']) assertSha(authority[field], field);
  const graphHashes = {
    forensicInventorySha256: codecs.canonicalSha256(opts.forensicInventory),
    cloudComparisonSha256: codecs.canonicalSha256(opts.cloudComparison),
    recoveredRowsManifestSha256: opts.recoveredRowsManifest ? codecs.canonicalSha256(opts.recoveredRowsManifest) : null,
    offlineImportManifestSha256: opts.offlineImportManifest ? codecs.canonicalSha256(opts.offlineImportManifest) : null,
    acceptedLossBoundarySha256: opts.acceptedLossBoundary ? codecs.canonicalSha256(opts.acceptedLossBoundary) : null,
    commandCapabilityCutoffProofSha256: opts.commandCapabilityCutoffProof ? codecs.canonicalSha256(opts.commandCapabilityCutoffProof) : null,
  };
  for (const [field, value] of Object.entries(graphHashes)) {
    if (authority[field] !== value) throw transitionError('integrity_reconciliation_graph_mismatch', `${field} does not match the authority`);
  }
  if (authority.disposition === 'IMPORT_RECOVERED_ROWS') {
    if (!opts.recoveredRowsManifest || !opts.offlineImportManifest || opts.acceptedLossBoundary || opts.commandCapabilityCutoffProof) {
      throw transitionError('integrity_reconciliation_branch_invalid', 'import authority has invalid branch objects');
    }
  } else if (opts.recoveredRowsManifest || opts.offlineImportManifest || !opts.acceptedLossBoundary || !opts.commandCapabilityCutoffProof) {
    throw transitionError('integrity_reconciliation_branch_invalid', 'cutoff authority has invalid branch objects');
  }
  const operationId = `${authority.recoveryOperationId}:database-integrity-reconciled`;
  const loaded = load.loadProtocolState(opts);
  if (!loaded.initialized || (loaded.resumePending && !pendingTransition(loaded, operationId, 'DATABASE_INTEGRITY_RECONCILED'))) {
    throw transitionError('protocol_state_not_ready', 'integrity completion requires complete roots or its exact pending reconciliation');
  }
  const committed = loaded.capability.generations.at(-1);
  const sameCommittedTransition = !loaded.resumePending &&
    committed.generation.operationId === operationId &&
    committed.generation.kind === 'DATABASE_INTEGRITY_RECONCILED';
  if (!sameCommittedTransition) assertExpectedHeads(loaded, opts);
  const prior = transitionPredecessor(loaded, operationId, 'DATABASE_INTEGRITY_RECONCILED');
  const priorState = prior.generation.state;
  if (
    prior.generation.kind !== 'DATABASE_INTEGRITY_INVALIDATION' ||
    priorState.databaseRestore.status !== 'RECONCILIATION_REQUIRED' ||
    priorState.databaseRestore.restoreEpoch !== authority.restoreEpoch ||
    priorState.recoveryOperationId !== authority.recoveryOperationId
  ) throw transitionError('integrity_restore_epoch_mismatch', 'live capability head is not the authority-bound integrity invalidation');
  const historical = opts.historicalRevalidationReceipt;
  if (
    !historical || historical.kind !== 'DATABASE_INTEGRITY_HISTORICAL_REVALIDATION' ||
    historical.requestId !== authority.requestId || historical.recoveryOperationId !== authority.recoveryOperationId ||
    historical.restoreEpoch !== authority.restoreEpoch ||
    !['FRESH_FINAL_DATABASE', 'RETAINED_BACKUP_CLEAR'].includes(historical.proofKind) ||
    historical.historicalUnscopedRows !== 0 || historical.malformedRows !== 0 || historical.unknownRows !== 0 ||
    historical.currentCapabilityGeneration !== prior.generation.generation ||
    historical.currentCapabilityHeadSha256 !== prior.generationSha256 ||
    historical.currentCapabilityWitnessSha256 !== loaded.capability.witnessByGeneration.get(prior.generation.generation).witnessSha256 ||
    historical.activityGeneration !== loaded.activity.externalHead.generation ||
    historical.activityEntrySha256 !== loaded.activity.externalHead.entrySha256 ||
    historical.activityExternalHeadSha256 !== codecs.canonicalSha256(loaded.activity.externalHead)
  ) throw transitionError('integrity_historical_revalidation_invalid', 'historical revalidation does not bind the live clear evidence');
  if (authority.disposition === 'IMPORT_RECOVERED_ROWS' && historical.proofKind !== 'FRESH_FINAL_DATABASE') {
    throw transitionError('integrity_historical_revalidation_invalid', 'import completion requires FRESH_FINAL_DATABASE');
  }
  validateWholeDatabaseAudit(opts.postReconcileFarmingAudit, 'post-reconcile farming audit');
  const postCommandAuditSha256 = codecs.canonicalSha256(opts.postReconcileCommandAudit);
  const postFarmingAuditSha256 = codecs.canonicalSha256(opts.postReconcileFarmingAudit);
  if (historical.finalCommandAuditSha256 !== postCommandAuditSha256) {
    throw transitionError('integrity_final_audit_mismatch', 'historical revalidation does not bind the final command audit');
  }
  if (opts.externalEffectCalls !== 0 || opts.ackTransportCalls !== 0) {
    throw transitionError('integrity_nonzero_effects', 'integrity reconciliation must prove zero external effects and ACK transports');
  }
  const createdAt = transitionCreatedAt(loaded, operationId, 'DATABASE_INTEGRITY_RECONCILED', opts.createdAt);
  const receipt = {
    format: 1,
    receiptKind: 'database-integrity-reconciled',
    operationId,
    requestId: authority.requestId,
    recoveryOperationId: authority.recoveryOperationId,
    restoreEpoch: authority.restoreEpoch,
    invalidationGeneration: prior.generation.generation,
    invalidationReceiptSha256: priorState.invalidationReceiptSha256,
    reconciliationAuthoritySha256: codecs.canonicalSha256(authority),
    historicalRevalidationReceiptSha256: codecs.canonicalSha256(historical),
    databaseLineageInvalidationReceiptSha256: opts.databaseLineageInvalidationReceiptSha256,
    forensicInventorySha256: graphHashes.forensicInventorySha256,
    cloudComparisonSha256: graphHashes.cloudComparisonSha256,
    offlineImportManifestSha256: graphHashes.offlineImportManifestSha256,
    recoveredRowsManifestSha256: graphHashes.recoveredRowsManifestSha256,
    offlineImportReceiptSha256: opts.offlineImportReceiptSha256 || null,
    acceptedLossBoundarySha256: graphHashes.acceptedLossBoundarySha256,
    commandCapabilityCutoffProofSha256: graphHashes.commandCapabilityCutoffProofSha256,
    postReconcileCommandAuditSha256: postCommandAuditSha256,
    postReconcileFarmingAuditSha256: postFarmingAuditSha256,
    activityGeneration: loaded.activity.externalHead.generation,
    activityEntrySha256: loaded.activity.externalHead.entrySha256,
    activityExternalHeadSha256: codecs.canonicalSha256(loaded.activity.externalHead),
    externalEffectCalls: 0,
    ackTransportCalls: 0,
    predecessorHeadSha256: prior.generationSha256,
    createdAt,
  };
  return appendTransition(
    { ...opts, operationId, createdAt },
    {
      kind: 'DATABASE_INTEGRITY_RECONCILED',
      state: {
        ...ambientState(priorState),
        databaseRestore: { status: 'CLEAR', restoreEpoch: authority.restoreEpoch },
        reconciledReceiptSha256: codecs.canonicalSha256(receipt),
        reconciliationAuthoritySha256: codecs.canonicalSha256(authority),
        historicalRevalidationReceiptSha256: codecs.canonicalSha256(historical),
        postReconcileCommandAuditSha256: postCommandAuditSha256,
        postReconcileFarmingAuditSha256: postFarmingAuditSha256,
        forensicInventorySha256: graphHashes.forensicInventorySha256,
        recoveryOperationId: authority.recoveryOperationId,
      },
      receipt,
      receiptPath: path.join(paths.resolveRoots(opts).databaseIntegrityReceiptsDir, `${authority.restoreEpoch}.reconciled.json`),
    }
  );
}

const RESET_BLOCKING_AUDIT_COUNTERS = [
  'scopedCloudNonterminalOutcomeRows', 'scopedCloudAckOutboxRows', 'scopedCloudRetryRows',
  'scopedCloudExternalIntentRows', 'historicalUnscopedTerminalRows', 'historicalUnscopedEffectRows',
  'historicalUnscopedAckOutboxRows', 'historicalUnscopedRetryRows', 'historicalUnscopedReferenceRows',
  'malformedCommandKeyRows', 'unknownProtocolRows', 'orphanCommandReferenceRows', 'conflictingDuplicateRows',
];

function authorizeReset(options) {
  const opts = options || {};
  const confirmation = opts.confirmation;
  assertExactKeys(confirmation, [
    'format', 'authorizationId', 'expectedHeadSha256', 'expectedWitnessSha256', 'expectedGeneration',
    'fromIdentitySha256', 'toIdentitySha256', 'reason', 'expiresAt',
  ], 'reset confirmation');
  if (confirmation.format !== 1) throw transitionError('reset_confirmation_invalid', 'reset confirmation format must be 1');
  assertOperationId(confirmation.authorizationId, 'confirmation.authorizationId');
  for (const field of ['expectedHeadSha256', 'expectedWitnessSha256', 'fromIdentitySha256', 'toIdentitySha256']) {
    assertSha(confirmation[field], `confirmation.${field}`);
  }
  if (!Number.isSafeInteger(confirmation.expectedGeneration) || confirmation.expectedGeneration < 0) {
    throw transitionError('reset_confirmation_invalid', 'confirmation expectedGeneration must be nonnegative');
  }
  const now = opts.now || new Date().toISOString();
  if (!codecs.isIsoTimestamp(confirmation.expiresAt) || Date.parse(confirmation.expiresAt) <= Date.parse(now)) {
    throw transitionError('reset_confirmation_expired', 'reset confirmation is expired');
  }
  for (const counter of RESET_BLOCKING_AUDIT_COUNTERS) {
    if (!Number.isSafeInteger(opts.ackAuditReport[counter]) || opts.ackAuditReport[counter] !== 0) {
      throw transitionError('reset_ack_audit_not_clean', `reset audit counter ${counter} must be zero`);
    }
  }
  const guard = opts.backupManifest && opts.backupManifest.guardEvidence;
  assertExactKeys(guard, [
    'nodeRedAbsent', 'identitydAbsent', 'oneShotChildrenAbsent', 'rcLinksQuarantined',
    'identitydLockAbsent', 'terminalFactsReconciled',
  ], 'reset guard evidence');
  if (Object.values(guard).some((value) => value !== true)) {
    throw transitionError('reset_guard_evidence_incomplete', 'all reset guard facts must be proven true');
  }
  const operationId = confirmation.authorizationId;
  const roots = paths.resolveRoots(opts);
  const receiptPath = path.join(roots.resetReceiptsDir, `${operationId}.json`);
  const loaded = load.loadProtocolState(opts);
  if (!loaded.initialized) throw transitionError('protocol_state_not_ready', 'reset requires complete protocol roots');
  const confirmationSha256 = codecs.canonicalSha256(confirmation);
  const backupManifestSha256 = codecs.canonicalSha256(opts.backupManifest);
  const ackAuditSha256 = codecs.canonicalSha256(opts.ackAuditReport);
  const resetReasonSha256 = codecs.sha256Hex(confirmation.reason);
  const committed = loaded.capability.generations.at(-1);
  if (!loaded.resumePending && committed.generation.operationId === operationId) {
    if (committed.generation.kind !== 'RESET_AUTHORIZATION') {
      throw transitionError('operation_id_kind_conflict', 'reset authorization operationId is committed under a different kind');
    }
    const committedState = committed.generation.state;
    const committedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (
      committedState.authorizationId !== operationId ||
      committedState.confirmationSha256 !== confirmationSha256 ||
      committedState.fromIdentitySha256 !== confirmation.fromIdentitySha256 ||
      committedState.toIdentitySha256 !== confirmation.toIdentitySha256 ||
      committedState.resetReasonSha256 !== resetReasonSha256 ||
      committedReceipt.backupManifestSha256 !== backupManifestSha256 ||
      committedReceipt.ackAuditSha256 !== ackAuditSha256 ||
      committedReceipt.predecessorGeneration !== confirmation.expectedGeneration ||
      committedReceipt.predecessorHeadSha256 !== confirmation.expectedHeadSha256 ||
      committedReceipt.predecessorWitnessSha256 !== confirmation.expectedWitnessSha256
    ) {
      throw transitionError('committed_transition_mismatch', 'committed reset authorization does not match retry authority');
    }
    if (opts.confirmationPath && fs.existsSync(opts.confirmationPath)) {
      fs.unlinkSync(opts.confirmationPath);
      paths.fsyncDir(path.dirname(opts.confirmationPath));
    }
    return {
      generation: committed.generation.generation,
      generationSha256: committed.generationSha256,
      witnessSha256: loaded.capability.head.witnessSha256,
      receiptSha256: codecs.canonicalSha256(committedReceipt),
      state: committedState,
      resumed: true,
    };
  }
  const pending = loaded.resumePending ? pendingTransition(loaded, operationId, 'RESET_AUTHORIZATION') : null;
  assertExpectedHeads(loaded, opts);
  const predecessor = transitionPredecessor(loaded, operationId, 'RESET_AUTHORIZATION');
  const priorState = predecessor.generation.state;
  const predecessorWitness = loaded.capability.witnessByGeneration.get(predecessor.generation.generation);
  if (
    predecessor.generation.generation !== confirmation.expectedGeneration ||
    predecessor.generationSha256 !== confirmation.expectedHeadSha256 ||
    predecessorWitness.witnessSha256 !== confirmation.expectedWitnessSha256 ||
    priorState.activeIdentitySha256 !== confirmation.fromIdentitySha256
  ) throw transitionError('reset_confirmation_head_mismatch', 'reset confirmation does not bind the live identity/head');
  if (
    opts.backupManifest.capabilityGeneration !== predecessor.generation.generation ||
    opts.backupManifest.capabilityHeadSha256 !== predecessor.generationSha256 ||
    opts.backupManifest.capabilityWitnessSha256 !== predecessorWitness.witnessSha256 ||
    opts.backupManifest.ackAuditSha256 !== ackAuditSha256 ||
    opts.backupManifest.fromIdentitySha256 !== confirmation.fromIdentitySha256
  ) throw transitionError('reset_backup_mismatch', 'backup manifest does not bind the live head, identity, and ACK audit');
  const previousResetEpoch = loaded.capability.generations.reduce(
    (max, entry) => (
      entry.generation.generation <= predecessor.generation.generation && entry.generation.kind === 'RESET_AUTHORIZATION'
        ? Math.max(max, entry.generation.state.resetEpoch)
        : max
    ),
    0
  );
  const resetEpoch = pending ? pending.generation.state.resetEpoch : previousResetEpoch + 1;
  const resetAuthorizedAt = pending ? pending.generation.state.resetAuthorizedAt : now;
  const createdAt = transitionCreatedAt(loaded, operationId, 'RESET_AUTHORIZATION', opts.createdAt || resetAuthorizedAt);
  const receipt = {
    format: 1,
    receiptKind: 'reset-authorization',
    operationId: confirmation.authorizationId,
    authorizationId: confirmation.authorizationId,
    confirmationSha256,
    backupManifestSha256,
    ackAuditSha256,
    fromIdentitySha256: confirmation.fromIdentitySha256,
    toIdentitySha256: confirmation.toIdentitySha256,
    resetEpoch,
    resetAuthorizedAt,
    resetReasonSha256,
    predecessorGeneration: predecessor.generation.generation,
    predecessorHeadSha256: predecessor.generationSha256,
    predecessorWitnessSha256: predecessorWitness.witnessSha256,
    createdAt,
  };
  const result = appendTransition(
    { ...opts, operationId, createdAt },
    {
      kind: 'RESET_AUTHORIZATION',
      state: {
        ...ambientState(priorState),
        activeIdentitySha256: confirmation.toIdentitySha256,
        mode: 'RESET_AUTHORIZED',
        authorizationId: confirmation.authorizationId,
        confirmationSha256,
        fromIdentitySha256: confirmation.fromIdentitySha256,
        toIdentitySha256: confirmation.toIdentitySha256,
        resetEpoch,
        resetAuthorizedAt,
        resetReasonSha256,
        resetReceiptSha256: codecs.canonicalSha256(receipt),
      },
      receipt,
      receiptPath,
    }
  );
  if (opts.confirmationPath && fs.existsSync(opts.confirmationPath)) {
    fs.unlinkSync(opts.confirmationPath);
    paths.fsyncDir(path.dirname(opts.confirmationPath));
  }
  return result;
}

function initializeFactoryZero(options) {
  const opts = options || {};
  assertOperationId(opts.operationId, 'operationId');
  let before;
  try {
    before = load.loadProtocolState(opts);
  } catch (err) {
    if (err.code !== 'protocol_state_partial_root_set') throw err;
    before = { initialized: false, midFlight: true };
  }
  if ((before.initialized || before.midFlight) && !fs.existsSync(opts.factoryIntentOut)) {
    throw transitionError(
      'factory_resume_intent_missing',
      'factory-zero may resume existing roots only from its unchanged immutable all-root absence intent'
    );
  }
  if (before.initialized) {
    const generations = before.capability.generations;
    const genesis = generations[0].generation;
    const dispositionOperationId = `${opts.operationId}:factory-zero`;
    const top = generations.at(-1).generation;
    const exactDispositionPrefix =
      generations.length === 2 &&
      top.operationId === dispositionOperationId &&
      top.kind === 'HISTORICAL_V2_DISPOSITION';
    if (genesis.operationId !== opts.operationId || (generations.length !== 1 && !exactDispositionPrefix)) {
      throw transitionError(
        'factory_protocol_roots_not_absent',
        'factory-zero initialization requires absent roots or the exact same-operation factory prefix'
      );
    }
  }
  if (
    !opts.ackAuditReport || opts.ackAuditReport.factorySeedEligible !== true ||
    opts.ackAuditReport.databaseIdentitySha256 !== opts.factorySeedReceipt.databaseIdentitySha256 ||
    opts.ackAuditReport.databaseLineageSha256 !== opts.factorySeedReceipt.databaseLineageSha256
  ) throw transitionError('factory_zero_audit_invalid', 'factory-zero audit is not eligible or does not match seed lineage');
  for (const field of ['seedSha256', 'databaseIdentitySha256', 'databaseLineageSha256']) {
    assertSha(opts.factorySeedReceipt[field], `factorySeedReceipt.${field}`);
  }
  const factoryProvenanceSha256 = codecs.canonicalSha256(opts.factoryProvenance);
  const imageGuardManifestSha256 = codecs.canonicalSha256(opts.imageGuardManifest);
  const factorySeedReceiptSha256 = codecs.canonicalSha256(opts.factorySeedReceipt);
  const factoryZeroAuditSha256 = codecs.canonicalSha256(opts.ackAuditReport);
  const intent = publishImmutableJson(
    opts.factoryIntentOut,
    {
      format: 1,
      kind: 'FACTORY_PROTOCOL_ZERO_INTENT',
      operationId: opts.operationId,
      baselineId: opts.baselineId,
      parentGeneration: opts.parentGeneration,
      factoryProvenanceSha256,
      imageGuardManifestSha256,
      factorySeedReceiptSha256,
      factorySeedIdentitySha256: opts.factorySeedReceipt.databaseIdentitySha256,
      databaseLineageSha256: opts.factorySeedReceipt.databaseLineageSha256,
      factoryZeroAuditSha256,
      protocolRootsAbsent: true,
      createdAt: opts.createdAt || new Date().toISOString(),
    },
    opts.ownershipAdapter || paths.defaultOwnershipAdapter
  );
  const createdAt = intent.createdAt;
  const sourceReceipt = publishImmutableJson(
    opts.factoryZeroSourceReceiptOut,
    {
      format: 1,
      receiptKind: 'factory-protocol-zero-source',
      operationId: opts.operationId,
      baselineId: opts.baselineId,
      parentGeneration: opts.parentGeneration,
      factoryIntentSha256: codecs.canonicalSha256(intent),
      factoryProvenanceSha256,
      imageGuardManifestSha256,
      factorySeedReceiptSha256,
      factorySeedIdentitySha256: opts.factorySeedReceipt.databaseIdentitySha256,
      liveDatabaseIdentitySha256: opts.ackAuditReport.databaseIdentitySha256,
      databaseLineageSha256: opts.factorySeedReceipt.databaseLineageSha256,
      factoryZeroAuditSha256,
      createdAt,
    },
    opts.ownershipAdapter || paths.defaultOwnershipAdapter
  );

  // Dynamic import avoids exporting a second initialization implementation:
  // the factory path uses the same four-root writer as deployment initialize.
  const needsGenesisResume = !before.initialized || (
    before.capability && before.capability.generations.length === 1
  );
  if (needsGenesisResume) {
    require('./index').initialize({
      ...opts,
      operationId: opts.operationId,
      sourceKind: 'factory-baseline',
      createdAt,
    });
  }
  const initialized = load.loadProtocolState(opts);
  const dispositionOperationId = `${opts.operationId}:factory-zero`;
  const top = initialized.capability.generations.at(-1);
  const dispositionPrefix = top.generation.operationId === dispositionOperationId;
  const predecessor = dispositionPrefix
    ? initialized.capability.generations[top.generation.previousGeneration]
    : top;
  const predecessorWitness = initialized.capability.witnessByGeneration.get(predecessor.generation.generation);
  const typedReceipt = {
    format: 1,
    receiptKind: 'historical-v2-disposition',
    operationId: dispositionOperationId,
    sourceKind: 'zero',
    sourceAuthorityKind: 'factory-baseline',
    factoryProvenanceSha256,
    imageGuardManifestSha256,
    factorySeedIdentitySha256: opts.factorySeedReceipt.databaseIdentitySha256,
    liveDatabaseIdentitySha256: opts.ackAuditReport.databaseIdentitySha256,
    factoryZeroAuditSha256,
    factoryZeroSourceReceiptSha256: codecs.canonicalSha256(sourceReceipt),
    imageBaselineOperationId: opts.operationId,
    imageBaselineGeneration: opts.parentGeneration,
    allRootAbsenceIntentSha256: codecs.canonicalSha256(intent),
    predecessorGeneration: predecessor.generation.generation,
    predecessorHeadSha256: predecessor.generationSha256,
    predecessorWitnessSha256: predecessorWitness.witnessSha256,
    historicalV2Disposition: 'CLEAR',
    createdAt: dispositionPrefix ? top.generation.createdAt : createdAt,
  };
  const transitionState = {
    activeIdentitySha256: null,
    mode: 'UNNEGOTIATED',
    historicalV2Disposition: 'CLEAR',
    historicalV2DispositionReceiptSha256: codecs.canonicalSha256(typedReceipt),
    databaseRestore: { status: 'CLEAR', restoreEpoch: 0 },
    sourceKind: 'zero',
    sourceAuthorityKind: 'factory-baseline',
    romProvenanceSha256: factoryProvenanceSha256,
    imageManifestSha256: imageGuardManifestSha256,
    factorySeedIdentitySha256: opts.factorySeedReceipt.databaseIdentitySha256,
    liveDatabaseIdentitySha256: opts.ackAuditReport.databaseIdentitySha256,
    factoryZeroAuditSha256,
    factoryZeroSourceReceiptSha256: codecs.canonicalSha256(sourceReceipt),
    imageBaselineOperationId: opts.operationId,
    imageBaselineGeneration: opts.parentGeneration,
    allRootAbsenceIntentSha256: codecs.canonicalSha256(intent),
  };
  if (dispositionPrefix && (
    top.generation.kind !== 'HISTORICAL_V2_DISPOSITION' ||
    codecs.canonicalJson(top.generation.state) !== codecs.canonicalJson(transitionState)
  )) {
    throw transitionError('factory_prefix_mismatch', 'factory disposition prefix does not match immutable factory authority');
  }
  const result = appendTransition(
    {
      ...opts,
      operationId: dispositionOperationId,
      createdAt: typedReceipt.createdAt,
      expectedHeadSha256: initialized.capability.head.generationSha256,
      expectedWitnessSha256: initialized.capability.head.witnessSha256,
      expectedActivityGeneration: initialized.activity.externalHead.generation,
      expectedActivityHeadSha256: codecs.canonicalSha256(initialized.activity.externalHead),
    },
    {
      kind: 'HISTORICAL_V2_DISPOSITION',
      state: transitionState,
      receipt: typedReceipt,
      receiptPath: path.join(paths.resolveRoots(opts).v2DispositionReceiptsDir, `${dispositionOperationId}.json`),
    }
  );
  const after = load.loadProtocolState(opts);
  return {
    ...result,
    factoryCommandActivityAnchorSha256: activityDb.computeFactoryCommandActivityAnchorSha256(
      after.activity.genesisRow.entry_sha256
    ),
    activityGeneration: after.activity.externalHead.generation,
    activityEntrySha256: after.activity.externalHead.entrySha256,
  };
}

module.exports = {
  MAX_CAPABILITY_GENERATION,
  appendTransition,
  recordHistoricalV2Disposition,
  prepareDispositionRestore,
  invalidateHistoricalV2Disposition,
  prepareDatabaseRestore,
  completeDatabaseRestoreReconciliation,
  prepareIntegrityRecovery,
  completeIntegrityRecovery,
  authorizeReset,
  initializeFactoryZero,
};
