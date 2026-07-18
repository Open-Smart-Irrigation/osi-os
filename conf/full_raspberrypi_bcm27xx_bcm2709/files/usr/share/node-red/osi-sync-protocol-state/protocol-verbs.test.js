'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const protocol = require('./index');
const transitions = require('./capability-transitions');

const GENESIS_OPERATION = '11111111-1111-4111-8111-111111111111';
const DISPOSITION_OPERATION = '22222222-2222-4222-8222-222222222222';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);

function makeRoots() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sync-protocol-verbs-'));
  return {
    tmp,
    opts: {
      root: path.join(tmp, 'osi-sync'),
      witnessRoot: path.join(tmp, 'osi-sync-witness', 'protocol-capability-witnesses'),
      activityWitnessRoot: path.join(tmp, 'osi-sync-witness', 'command-activity-witnesses'),
    },
  };
}

test('recordHistoricalV2Disposition appends a receipt-bound deployment zero/CLEAR generation', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const before = protocol.loadProtocolState(opts);

  const result = transitions.recordHistoricalV2Disposition({
    ...opts,
    operationId: DISPOSITION_OPERATION,
    createdAt: '2026-07-19T00:01:00.000Z',
    expectedHeadSha256: before.capability.head.generationSha256,
    expectedWitnessSha256: before.capability.head.witnessSha256,
    expectedActivityGeneration: before.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
    source: {
      sourceKind: 'zero',
      sourceAuthorityKind: 'deployment-backup',
      dispositionReceiptSha256: SHA_A,
      auditSha256: SHA_B,
      databaseSha256: SHA_C,
      backupSha256: SHA_D,
      identitySha256: SHA_E,
      historicalV2Disposition: 'CLEAR',
    },
  });

  assert.equal(result.generation, 1);
  const loaded = protocol.loadProtocolState(opts);
  const current = loaded.capability.generations.at(-1).generation;
  assert.equal(current.kind, 'HISTORICAL_V2_DISPOSITION');
  assert.equal(current.state.sourceKind, 'zero');
  assert.equal(current.state.historicalV2Disposition, 'CLEAR');
  assert.equal(current.state.databaseRestore.status, 'CLEAR');
  assert.match(current.state.historicalV2DispositionReceiptSha256, /^[0-9a-f]{64}$/);
});

test('load fails closed when a committed transition receipt is removed or rewritten', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const before = protocol.loadProtocolState(opts);
  transitions.recordHistoricalV2Disposition({
    ...opts,
    operationId: DISPOSITION_OPERATION,
    createdAt: '2026-07-19T00:01:00.000Z',
    expectedHeadSha256: before.capability.head.generationSha256,
    expectedWitnessSha256: before.capability.head.witnessSha256,
    expectedActivityGeneration: before.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
    source: {
      sourceKind: 'zero', sourceAuthorityKind: 'deployment-backup', dispositionReceiptSha256: SHA_A,
      auditSha256: SHA_B, databaseSha256: SHA_C, backupSha256: SHA_D,
      identitySha256: SHA_E, historicalV2Disposition: 'CLEAR',
    },
  });
  const receiptPath = path.join(opts.root, 'protocol-capabilities', 'v2-disposition-receipts', `${DISPOSITION_OPERATION}.json`);
  const original = fs.readFileSync(receiptPath);
  fs.unlinkSync(receiptPath);
  assert.throws(() => protocol.loadProtocolState(opts), { code: 'typed_receipt_missing' });
  fs.writeFileSync(receiptPath, original, { mode: 0o600 });
  fs.chmodSync(receiptPath, 0o600);
  const tampered = JSON.parse(original.toString('utf8'));
  tampered.historicalV2Disposition = 'RECONCILIATION_REQUIRED';
  fs.writeFileSync(receiptPath, protocol.canonicalJson(tampered), { mode: 0o600 });
  assert.throws(() => protocol.loadProtocolState(opts), { code: 'typed_receipt_hash_mismatch' });
});

test('recordHistoricalV2Disposition resumes every generation/receipt/witness/head crash boundary exactly once', (t) => {
  const dirs = [];
  t.after(() => dirs.forEach((tmp) => fs.rmSync(tmp, { recursive: true, force: true })));
  for (const crashAfter of ['transition_generation', 'transition_receipt', 'transition_witness', 'transition_head']) {
    const { tmp, opts } = makeRoots();
    dirs.push(tmp);
    protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
    const before = protocol.loadProtocolState(opts);
    const call = {
      ...opts,
      operationId: DISPOSITION_OPERATION,
      createdAt: '2026-07-19T00:01:00.000Z',
      expectedHeadSha256: before.capability.head.generationSha256,
      expectedWitnessSha256: before.capability.head.witnessSha256,
      expectedActivityGeneration: before.activity.externalHead.generation,
      expectedActivityHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
      source: {
        sourceKind: 'zero', sourceAuthorityKind: 'deployment-backup', dispositionReceiptSha256: SHA_A,
        auditSha256: SHA_B, databaseSha256: SHA_C, backupSha256: SHA_D,
        identitySha256: SHA_E, historicalV2Disposition: 'CLEAR',
      },
    };
    assert.throws(() => transitions.recordHistoricalV2Disposition({ ...call, crashAfter }), { code: 'injected_transition_crash' });
    const resumed = transitions.recordHistoricalV2Disposition({ ...call, createdAt: '2026-07-19T09:09:09.000Z' });
    assert.equal(resumed.generation, 1, crashAfter);
    assert.equal(resumed.resumed, true, crashAfter);
    const loaded = protocol.loadProtocolState(opts);
    assert.equal(loaded.capability.generations.length, 2, crashAfter);
    assert.equal(loaded.capability.head.generation, 1, crashAfter);
  }
});

test('recordHistoricalV2Disposition reconciles stale locks after hard process death at every transition boundary', (t) => {
  const dirs = [];
  t.after(() => dirs.forEach((tmp) => fs.rmSync(tmp, { recursive: true, force: true })));
  for (const hardCrashAfter of ['transition_generation', 'transition_receipt', 'transition_witness', 'transition_head']) {
    const { tmp, opts } = makeRoots();
    dirs.push(tmp);
    protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
    const before = protocol.loadProtocolState(opts);
    const call = {
      ...opts,
      operationId: DISPOSITION_OPERATION,
      createdAt: '2026-07-19T00:01:00.000Z',
      expectedHeadSha256: before.capability.head.generationSha256,
      expectedWitnessSha256: before.capability.head.witnessSha256,
      expectedActivityGeneration: before.activity.externalHead.generation,
      expectedActivityHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
      source: {
        sourceKind: 'zero', sourceAuthorityKind: 'deployment-backup', dispositionReceiptSha256: SHA_A,
        auditSha256: SHA_B, databaseSha256: SHA_C, backupSha256: SHA_D,
        identitySha256: SHA_E, historicalV2Disposition: 'CLEAR',
      },
    };
    const script = `require(${JSON.stringify(path.join(__dirname, 'capability-transitions.js'))}).recordHistoricalV2Disposition(${JSON.stringify({ ...call, hardCrashAfter })})`;
    const crashed = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(crashed.status, 137, `${hardCrashAfter}: ${crashed.stderr}`);
    const resumed = transitions.recordHistoricalV2Disposition(call);
    assert.equal(resumed.generation, 1, hardCrashAfter);
    assert.equal(resumed.resumed, true, hardCrashAfter);
    assert.equal(protocol.loadProtocolState(opts).capability.generations.length, 2, hardCrashAfter);
  }
});

test('prepareDispositionRestore classifies a committed CLEAR head and publishes immutable intent/result', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const genesis = protocol.loadProtocolState(opts);
  transitions.recordHistoricalV2Disposition({
    ...opts,
    operationId: DISPOSITION_OPERATION,
    createdAt: '2026-07-19T00:01:00.000Z',
    expectedHeadSha256: genesis.capability.head.generationSha256,
    expectedWitnessSha256: genesis.capability.head.witnessSha256,
    expectedActivityGeneration: genesis.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(genesis.activity.externalHead),
    source: {
      sourceKind: 'zero',
      sourceAuthorityKind: 'deployment-backup',
      dispositionReceiptSha256: SHA_A,
      auditSha256: SHA_B,
      databaseSha256: SHA_C,
      backupSha256: SHA_D,
      identitySha256: SHA_E,
      historicalV2Disposition: 'CLEAR',
    },
  });
  const committed = protocol.loadProtocolState(opts);
  const prepareIntentOut = path.join(tmp, 'recovery', 'prepare-intent.json');
  const resultOut = path.join(tmp, 'recovery', 'result.json');
  fs.mkdirSync(path.dirname(prepareIntentOut), { recursive: true, mode: 0o700 });

  const result = transitions.prepareDispositionRestore({
    ...opts,
    deploymentId: 'dep-1',
    parentGeneration: 7,
    recoveryOperationId: '33333333-3333-4333-8333-333333333333',
    auditSha256: SHA_B,
    backupManifestSha256: SHA_D,
    backupSha256: SHA_C,
    identitySha256: SHA_E,
    expectedHeadSha256: committed.capability.head.generationSha256,
    expectedWitnessSha256: committed.capability.head.witnessSha256,
    expectedActivityGeneration: committed.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(committed.activity.externalHead),
    prepareIntentOut,
    resultOut,
    createdAt: '2026-07-19T00:02:00.000Z',
  });

  assert.equal(result.result, 'COMMITTED_CLEAR');
  assert.equal(fs.statSync(prepareIntentOut).mode & 0o777, 0o600);
  assert.equal(fs.statSync(resultOut).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(resultOut, 'utf8')).result, 'COMMITTED_CLEAR');
});

test('prepareDispositionRestore completes one matching unheaded CLEAR proposal', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const loaded = protocol.loadProtocolState(opts);
  const proposalOperationId = '21212121-2121-4212-8212-212121212121';
  const createdAt = '2026-07-19T00:01:00.000Z';
  const receipt = {
    format: 1, receiptKind: 'historical-v2-disposition', operationId: proposalOperationId,
    sourceKind: 'zero', sourceAuthorityKind: 'deployment-backup', sourceDispositionReceiptSha256: SHA_A,
    auditSha256: SHA_B, databaseSha256: SHA_C, backupSha256: SHA_D, identitySha256: SHA_E,
    predecessorGeneration: 0, predecessorHeadSha256: loaded.capability.head.generationSha256,
    predecessorWitnessSha256: loaded.capability.head.witnessSha256,
    historicalV2Disposition: 'CLEAR', createdAt,
  };
  const generation = {
    format: 1, generation: 1, previousGeneration: 0,
    previousSha256: loaded.capability.head.generationSha256,
    operationId: proposalOperationId, kind: 'HISTORICAL_V2_DISPOSITION', createdAt,
    state: {
      activeIdentitySha256: null, mode: 'UNNEGOTIATED', historicalV2Disposition: 'CLEAR',
      historicalV2DispositionReceiptSha256: protocol.canonicalSha256(receipt),
      databaseRestore: { status: 'CLEAR', restoreEpoch: 0 }, sourceKind: 'zero',
      sourceAuthorityKind: 'deployment-backup', dispositionReceiptSha256: SHA_A,
      auditSha256: SHA_B, databaseSha256: SHA_C, backupSha256: SHA_D, identitySha256: SHA_E,
    },
  };
  const roots = protocol.resolveRoots(opts);
  fs.writeFileSync(path.join(roots.generationsDir, '0000000000000001.json'), protocol.canonicalJson(generation), { mode: 0o600 });
  const outDir = path.join(tmp, 'unheaded');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const call = {
    ...opts, deploymentId: 'dep-1', parentGeneration: 7,
    recoveryOperationId: '33333333-3333-4333-8333-333333333333',
    auditSha256: SHA_B, backupManifestSha256: SHA_D, backupSha256: SHA_D,
    databaseSha256: SHA_C, sourceDispositionReceiptSha256: SHA_A, identitySha256: SHA_E,
    expectedHeadSha256: loaded.capability.head.generationSha256,
    expectedWitnessSha256: loaded.capability.head.witnessSha256,
    expectedActivityGeneration: loaded.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(loaded.activity.externalHead),
    prepareIntentOut: path.join(outDir, 'intent.json'), resultOut: path.join(outDir, 'result.json'),
    createdAt: '2026-07-19T00:02:00.000Z',
  };
  const result = transitions.prepareDispositionRestore(call);
  assert.equal(result.result, 'UNHEADED_CLEAR_COMPLETED');
  assert.equal(result.completionOperationId, proposalOperationId);
  assert.equal(protocol.status(opts).capabilityGeneration, 1);
  fs.unlinkSync(call.resultOut);
  const recovered = transitions.prepareDispositionRestore({ ...call, createdAt: '2026-07-19T08:08:08.000Z' });
  assert.deepEqual(recovered, result);
  const retried = transitions.prepareDispositionRestore({ ...call, createdAt: '2026-07-19T09:09:09.000Z' });
  assert.deepEqual(retried, result);
  assert.equal(protocol.status(opts).capabilityGeneration, 1);
});

test('invalidateHistoricalV2Disposition appends restore-invalidation without rewinding the prior CLEAR', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const genesis = protocol.loadProtocolState(opts);
  transitions.recordHistoricalV2Disposition({
    ...opts,
    operationId: DISPOSITION_OPERATION,
    createdAt: '2026-07-19T00:01:00.000Z',
    expectedHeadSha256: genesis.capability.head.generationSha256,
    expectedWitnessSha256: genesis.capability.head.witnessSha256,
    expectedActivityGeneration: genesis.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(genesis.activity.externalHead),
    source: {
      sourceKind: 'zero', sourceAuthorityKind: 'deployment-backup', dispositionReceiptSha256: SHA_A,
      auditSha256: SHA_B, databaseSha256: SHA_C, backupSha256: SHA_D,
      identitySha256: SHA_E, historicalV2Disposition: 'CLEAR',
    },
  });
  const clear = protocol.loadProtocolState(opts);
  const preparationResult = {
    format: 1,
    kind: 'DISPOSITION_RESTORE_PREPARATION_RESULT',
    deploymentId: 'dep-1',
    parentGeneration: 7,
    recoveryOperationId: '33333333-3333-4333-8333-333333333333',
    result: 'COMMITTED_CLEAR',
  };
  const result = transitions.invalidateHistoricalV2Disposition({
    ...opts,
    operationId: '44444444-4444-4444-8444-444444444444',
    recoveryOperationId: preparationResult.recoveryOperationId,
    restorePreparationResult: preparationResult,
    restoreReceiptSha256: SHA_A,
    restoredDatabaseAuditSha256: SHA_B,
    identitySha256: SHA_E,
    expectedHeadSha256: clear.capability.head.generationSha256,
    expectedWitnessSha256: clear.capability.head.witnessSha256,
    expectedActivityGeneration: clear.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(clear.activity.externalHead),
    createdAt: '2026-07-19T00:03:00.000Z',
  });

  assert.equal(result.generation, 2);
  const loaded = protocol.loadProtocolState(opts);
  assert.equal(loaded.capability.generations[1].generation.state.historicalV2Disposition, 'CLEAR');
  const invalidated = loaded.capability.generations[2].generation;
  assert.equal(invalidated.state.sourceKind, 'restore-invalidation');
  assert.equal(invalidated.state.historicalV2Disposition, 'RECONCILIATION_REQUIRED');
  assert.equal(invalidated.state.priorClearGeneration, 1);
});

function farmingAudit(databaseIdentitySha256, tableRowSetSha256) {
  return {
    format: 1,
    databasePath: '/data/db/farming.db',
    databaseIdentitySha256,
    schemaVersion: 1,
    userVersion: 1,
    schemaSha256: SHA_A,
    tableInventorySha256: SHA_B,
    tables: [{ name: 'applied_commands', rowCount: 0, rowSetSha256: tableRowSetSha256 }],
    fullLogicalSha256: SHA_C,
    quickCheck: 'ok',
    firstReadSha256: SHA_D,
    secondReadSha256: SHA_D,
    createdAt: '2026-07-19T00:00:00.000Z',
  };
}

test('prepareDatabaseRestore returns NO_POST_BACKUP_DATABASE_DELTA without advancing capability state', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const loaded = protocol.loadProtocolState(opts);
  const commandAudit = { format: 1, commandStateSha256: SHA_A, commandOwnedTables: ['applied_commands'] };
  const wholeAudit = farmingAudit(SHA_B, SHA_C);
  const backupManifest = { format: 1, databaseSha256: SHA_D };
  const baseline = {
    format: 1,
    kind: 'DATABASE_RESTORE_BASELINE',
    backupCommandAuditSha256: protocol.canonicalSha256(commandAudit),
    backupFarmingAuditSha256: protocol.canonicalSha256(wholeAudit),
    baselineCommandAuditSha256: protocol.canonicalSha256(commandAudit),
    baselineFarmingAuditSha256: protocol.canonicalSha256(wholeAudit),
    expectedMutationDeltaSha256: SHA_E,
    writerGeneration: 4,
  };
  const dir = path.join(tmp, 'general-restore');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const call = {
    ...opts,
    deploymentId: 'dep-1',
    parentGeneration: 9,
    recoveryOperationId: '55555555-5555-4555-8555-555555555555',
    backupManifest,
    restoreBaseline: baseline,
    reverseMergeAdapterInventory: { format: 1, kind: 'DATABASE_RESTORE_REVERSE_ADAPTER_INVENTORY', adapters: [] },
    backupCommandAudit: commandAudit,
    backupFarmingAudit: wholeAudit,
    currentCommandAudit: commandAudit,
    currentFarmingAudit: wholeAudit,
    databaseLineageInvalidationReceiptSha256: null,
    expectedHeadSha256: loaded.capability.head.generationSha256,
    expectedWitnessSha256: loaded.capability.head.witnessSha256,
    expectedActivityGeneration: loaded.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(loaded.activity.externalHead),
    prepareIntentOut: path.join(dir, 'intent.json'),
    resultOut: path.join(dir, 'result.json'),
    currentSnapshot: path.join(dir, 'current-command-state.snapshot.sqlite'),
    createdAt: '2026-07-19T00:04:00.000Z',
  };
  const result = transitions.prepareDatabaseRestore(call);

  assert.equal(result.result, 'NO_POST_BACKUP_DATABASE_DELTA');
  assert.equal(protocol.status(opts).capabilityGeneration, 0);
  assert.equal(fs.existsSync(path.join(dir, 'current-command-state.snapshot.sqlite')), false);
  assert.deepEqual(
    transitions.prepareDatabaseRestore({ ...call, createdAt: '2026-07-19T09:09:09.000Z' }),
    result
  );
});

test('completeDatabaseRestoreReconciliation clears only the exact invalidated restore epoch', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const initial = protocol.loadProtocolState(opts);
  const backupCommandAudit = { format: 1, commandStateSha256: SHA_A, commandOwnedTables: ['applied_commands'] };
  const currentCommandAudit = { format: 1, commandStateSha256: SHA_B, commandOwnedTables: ['applied_commands'] };
  const backupFarmingAudit = farmingAudit(SHA_B, SHA_C);
  const currentFarmingAudit = { ...farmingAudit(SHA_D, SHA_D), fullLogicalSha256: SHA_E };
  const backupManifest = { format: 1, databaseSha256: SHA_D };
  const baseline = {
    format: 1, kind: 'DATABASE_RESTORE_BASELINE',
    backupCommandAuditSha256: protocol.canonicalSha256(backupCommandAudit),
    backupFarmingAuditSha256: protocol.canonicalSha256(backupFarmingAudit),
    baselineCommandAuditSha256: protocol.canonicalSha256(backupCommandAudit),
    baselineFarmingAuditSha256: protocol.canonicalSha256(backupFarmingAudit),
    expectedMutationDeltaSha256: SHA_E, writerGeneration: 4,
  };
  const reverseInventory = { format: 1, kind: 'DATABASE_RESTORE_REVERSE_ADAPTER_INVENTORY', adapters: [{ adapterId: 'command-v1' }] };
  const dir = path.join(tmp, 'general-restore-reconcile');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const recoveryOperationId = '66666666-6666-4666-8666-666666666666';
  const prepared = transitions.prepareDatabaseRestore({
    ...opts, deploymentId: 'dep-1', parentGeneration: 9, recoveryOperationId,
    backupManifest, restoreBaseline: baseline, reverseMergeAdapterInventory: reverseInventory,
    backupCommandAudit, backupFarmingAudit, currentCommandAudit, currentFarmingAudit,
    databaseLineageInvalidationReceiptSha256: null,
    expectedHeadSha256: initial.capability.head.generationSha256,
    expectedWitnessSha256: initial.capability.head.witnessSha256,
    expectedActivityGeneration: initial.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(initial.activity.externalHead),
    prepareIntentOut: path.join(dir, 'intent.json'), resultOut: path.join(dir, 'result.json'),
    currentSnapshot: path.join(dir, 'current-command-state.snapshot.sqlite'),
    snapshotAdapter: ({ snapshotPath, recoveryOperationId: op, restoreEpoch }) => ({
      format: 1, status: 'AVAILABLE', recoveryOperationId: op, restoreEpoch,
      snapshotPath, snapshotSizeBytes: 1, snapshotSha256: SHA_A,
      databaseIdentitySha256: currentFarmingAudit.databaseIdentitySha256,
      commandAuditSha256: protocol.canonicalSha256(currentCommandAudit),
      farmingAuditSha256: protocol.canonicalSha256(currentFarmingAudit),
      reverseMergeAdapterInventorySha256: protocol.canonicalSha256(reverseInventory),
      commandOwnedTables: [{ name: 'applied_commands', rowCount: 0, rowSetSha256: SHA_D }],
      createdAt: '2026-07-19T00:05:00.000Z',
    }),
    createdAt: '2026-07-19T00:05:00.000Z',
  });
  assert.equal(prepared.result, 'RECONCILIATION_REQUIRED');
  const invalidated = protocol.loadProtocolState(opts);
  const mergeReceipt = {
    format: 1, receiptKind: 'database-restore-merge', deploymentId: 'dep-1', parentGeneration: 9,
    recoveryOperationId, restoreEpoch: prepared.restoreEpoch, prepareResultSha256: protocol.canonicalSha256(prepared),
    afterCommandAuditSha256: protocol.canonicalSha256(currentCommandAudit),
    afterFarmingAuditSha256: protocol.canonicalSha256(currentFarmingAudit),
    expectedPostMergeFarmingAuditSha256: protocol.canonicalSha256(currentFarmingAudit),
    activityGeneration: invalidated.activity.externalHead.generation,
    activityEntrySha256: invalidated.activity.externalHead.entrySha256,
    activityExternalHeadSha256: protocol.canonicalSha256(invalidated.activity.externalHead),
    externalEffectCalls: 0, ackTransportCalls: 0, result: 'MERGED', createdAt: '2026-07-19T00:06:00.000Z',
  };
  const result = transitions.completeDatabaseRestoreReconciliation({
    ...opts, operationId: '77777777-7777-4777-8777-777777777777', deploymentId: 'dep-1',
    parentGeneration: 9, recoveryOperationId, prepareResult: prepared, mergeReceipt,
    reverseMergeAdapterInventory: reverseInventory,
    postMergeAuditReport: { format: 1, commandAudit: currentCommandAudit, farmingAudit: currentFarmingAudit },
    expectedHeadSha256: invalidated.capability.head.generationSha256,
    expectedWitnessSha256: invalidated.capability.head.witnessSha256,
    expectedActivityGeneration: invalidated.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(invalidated.activity.externalHead),
    createdAt: '2026-07-19T00:06:00.000Z',
  });

  assert.equal(result.generation, 2);
  assert.deepEqual(protocol.loadProtocolState(opts).capability.generations.at(-1).generation.state.databaseRestore, {
    status: 'CLEAR', restoreEpoch: 1,
  });
});

test('prepareIntegrityRecovery appends the exact existing-root integrity invalidation before replacement', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const before = protocol.loadProtocolState(opts);
  const request = { format: 1, requestId: 'request-1', recoveryRequestSha256: SHA_A };
  const observedEvidence = {
    format: 1, kind: 'DATABASE_INTEGRITY_OBSERVATION', requestId: 'request-1',
    recoveryRequestSha256: protocol.canonicalSha256(request), databasePath: '/data/db/farming.db',
    observedDatabaseIdentitySha256: SHA_B, quickCheckResult: 'failed', sqliteMembers: [
      { name: 'journal', path: '/data/db/farming.db-journal', status: 'ABSENT', device: null, inode: null, sizeBytes: null, sha256: null },
      { name: 'main', path: '/data/db/farming.db', status: 'PRESENT', device: 1, inode: 2, sizeBytes: 3, sha256: SHA_D },
      { name: 'shm', path: '/data/db/farming.db-shm', status: 'ABSENT', device: null, inode: null, sizeBytes: null, sha256: null },
      { name: 'wal', path: '/data/db/farming.db-wal', status: 'ABSENT', device: null, inode: null, sizeBytes: null, sha256: null },
    ],
    bootIdSha256: SHA_C, createdAt: '2026-07-19T00:07:00.000Z',
  };
  const backupManifest = {
    format: 1, databaseSha256: SHA_D, commandAuditSha256: SHA_A, farmingAuditSha256: SHA_B,
    activityGeneration: before.activity.externalHead.generation,
    activityEntrySha256: before.activity.externalHead.entrySha256,
    activityExternalHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
  };
  const recoveryOperationId = '88888888-8888-4888-8888-888888888888';
  const authority = {
    format: 1, kind: 'DATABASE_INTEGRITY_RECOVERY_AUTHORITY', requestId: 'request-1', recoveryOperationId,
    recoveryRequestSha256: protocol.canonicalSha256(request),
    backupManifestSha256: protocol.canonicalSha256(backupManifest), backupDatabaseSha256: SHA_D,
    observedEvidenceSha256: protocol.canonicalSha256(observedEvidence),
    possibleDataLossAcknowledgementSha256: SHA_E, databaseLineageInvalidationReceiptSha256: null,
    disposition: 'RESTORE_TRUSTED_BACKUP_AND_RECONCILE', createdAt: '2026-07-19T00:07:00.000Z',
  };
  const result = transitions.prepareIntegrityRecovery({
    ...opts, recoveryRequest: request, authority, observedEvidence, backupManifest,
    databaseLineageInvalidationReceiptSha256: null,
    forensicDestination: path.join(tmp, 'forensic', 'request-1'),
    resultOut: path.join(tmp, 'integrity', 'prepare-result.json'),
    expectedHeadSha256: before.capability.head.generationSha256,
    expectedWitnessSha256: before.capability.head.witnessSha256,
    expectedActivityGeneration: before.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
    createdAt: '2026-07-19T00:07:00.000Z',
  });

  assert.equal(result.result, 'BACKUP_REPLACEMENT_PREPARED');
  const loaded = protocol.loadProtocolState(opts);
  assert.equal(loaded.capability.generations.at(-1).generation.kind, 'DATABASE_INTEGRITY_INVALIDATION');
  assert.equal(loaded.capability.generations.at(-1).generation.state.databaseRestore.status, 'RECONCILIATION_REQUIRED');
});

test('completeIntegrityRecovery clears only the prepared integrity epoch with cutoff authority', (t) => {
  const { tmp, opts } = makeRoots();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const before = protocol.loadProtocolState(opts);
  const request = { format: 1, requestId: 'request-2', recoveryRequestSha256: SHA_A };
  const observedEvidence = {
    format: 1, kind: 'DATABASE_INTEGRITY_OBSERVATION', requestId: 'request-2',
    recoveryRequestSha256: protocol.canonicalSha256(request), databasePath: '/data/db/farming.db',
    observedDatabaseIdentitySha256: SHA_B, quickCheckResult: 'missing', sqliteMembers: [
      { name: 'journal', path: '/data/db/farming.db-journal', status: 'ABSENT', device: null, inode: null, sizeBytes: null, sha256: null },
      { name: 'main', path: '/data/db/farming.db', status: 'ABSENT', device: null, inode: null, sizeBytes: null, sha256: null },
      { name: 'shm', path: '/data/db/farming.db-shm', status: 'ABSENT', device: null, inode: null, sizeBytes: null, sha256: null },
      { name: 'wal', path: '/data/db/farming.db-wal', status: 'ABSENT', device: null, inode: null, sizeBytes: null, sha256: null },
    ], bootIdSha256: SHA_C, createdAt: '2026-07-19T00:08:00.000Z',
  };
  const backupManifest = {
    format: 1, databaseSha256: SHA_D, commandAuditSha256: SHA_A, farmingAuditSha256: SHA_B,
    activityGeneration: before.activity.externalHead.generation,
    activityEntrySha256: before.activity.externalHead.entrySha256,
    activityExternalHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
  };
  const recoveryOperationId = '99999999-9999-4999-8999-999999999999';
  const authority = {
    format: 1, kind: 'DATABASE_INTEGRITY_RECOVERY_AUTHORITY', requestId: 'request-2', recoveryOperationId,
    recoveryRequestSha256: protocol.canonicalSha256(request), backupManifestSha256: protocol.canonicalSha256(backupManifest),
    backupDatabaseSha256: SHA_D, observedEvidenceSha256: protocol.canonicalSha256(observedEvidence),
    possibleDataLossAcknowledgementSha256: SHA_E, databaseLineageInvalidationReceiptSha256: null,
    disposition: 'RESTORE_TRUSTED_BACKUP_AND_RECONCILE', createdAt: '2026-07-19T00:08:00.000Z',
  };
  const prepared = transitions.prepareIntegrityRecovery({
    ...opts, recoveryRequest: request, authority, observedEvidence, backupManifest,
    databaseLineageInvalidationReceiptSha256: null, forensicDestination: path.join(tmp, 'forensic', 'request-2'),
    resultOut: path.join(tmp, 'integrity-2', 'prepare-result.json'),
    expectedHeadSha256: before.capability.head.generationSha256,
    expectedWitnessSha256: before.capability.head.witnessSha256,
    expectedActivityGeneration: before.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(before.activity.externalHead),
    createdAt: '2026-07-19T00:08:00.000Z',
  });
  const invalidated = protocol.loadProtocolState(opts);
  const forensicInventory = { format: 1, kind: 'DATABASE_INTEGRITY_FORENSIC_INVENTORY', requestId: 'request-2', recoveryOperationId, restoreEpoch: 1, members: [] };
  const cloudComparison = { format: 1, kind: 'DATABASE_INTEGRITY_CLOUD_COMPARISON', requestId: 'request-2', recoveryOperationId, restoreEpoch: 1, families: [] };
  const cutoffProof = { format: 1, kind: 'DATABASE_INTEGRITY_COMMAND_CAPABILITY_CUTOFF_PROOF', requestId: 'request-2', recoveryOperationId, restoreEpoch: 1, proof: 'UNCHANGED_BACKUP_TO_PRE_INVALIDATION_AND_EXACT_INVALIDATION_DESCENDANT' };
  const acceptedLossBoundary = { format: 1, kind: 'DATABASE_INTEGRITY_ACCEPTED_LOSS_BOUNDARY', requestId: 'request-2', recoveryOperationId, restoreEpoch: 1, commandCapabilityCutoffProofSha256: protocol.canonicalSha256(cutoffProof) };
  const reconciliationAuthority = {
    format: 1, kind: 'DATABASE_INTEGRITY_RECONCILIATION_AUTHORITY', requestId: 'request-2', recoveryOperationId,
    restoreEpoch: 1, disposition: 'ACCEPT_BACKUP_CUTOFF',
    forensicInventorySha256: protocol.canonicalSha256(forensicInventory),
    cloudComparisonSha256: protocol.canonicalSha256(cloudComparison),
    offlineImportManifestSha256: null, recoveredRowsManifestSha256: null,
    acceptedLossBoundarySha256: protocol.canonicalSha256(acceptedLossBoundary),
    commandCapabilityCutoffProofSha256: protocol.canonicalSha256(cutoffProof),
    actorPrincipalSha256: SHA_A, authorizedAt: '2026-07-19T00:09:00.000Z',
  };
  const postCommandAudit = { format: 1, commandStateSha256: SHA_B, commandOwnedTables: ['applied_commands'] };
  const postFarmingAudit = farmingAudit(SHA_C, SHA_D);
  const historicalRevalidationReceipt = {
    format: 1, kind: 'DATABASE_INTEGRITY_HISTORICAL_REVALIDATION', requestId: 'request-2', recoveryOperationId,
    restoreEpoch: 1, proofKind: 'RETAINED_BACKUP_CLEAR', backupCommandAuditSha256: SHA_A,
    finalCommandAuditSha256: protocol.canonicalSha256(postCommandAudit), priorHistoricalDispositionReceiptSha256: null,
    currentIdentitySha256: null, currentCapabilityGeneration: invalidated.capability.head.generation,
    currentCapabilityHeadSha256: invalidated.capability.head.generationSha256,
    currentCapabilityWitnessSha256: invalidated.capability.head.witnessSha256,
    activityGeneration: invalidated.activity.externalHead.generation,
    activityEntrySha256: invalidated.activity.externalHead.entrySha256,
    activityExternalHeadSha256: protocol.canonicalSha256(invalidated.activity.externalHead), writerGeneration: 4,
    historicalUnscopedRows: 0, malformedRows: 0, unknownRows: 0, createdAt: '2026-07-19T00:09:00.000Z',
  };
  const result = transitions.completeIntegrityRecovery({
    ...opts, recoveryRequest: request, reconciliationAuthority, forensicInventory, cloudComparison,
    recoveredRowsManifest: null, offlineImportManifest: null, acceptedLossBoundary, commandCapabilityCutoffProof: cutoffProof,
    historicalRevalidationReceipt, postReconcileCommandAudit: postCommandAudit, postReconcileFarmingAudit: postFarmingAudit,
    expectedHeadSha256: invalidated.capability.head.generationSha256,
    expectedWitnessSha256: invalidated.capability.head.witnessSha256,
    expectedActivityGeneration: invalidated.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(invalidated.activity.externalHead),
    databaseLineageInvalidationReceiptSha256: null, externalEffectCalls: 0, ackTransportCalls: 0,
    createdAt: '2026-07-19T00:09:00.000Z',
  });

  assert.equal(result.generation, 2);
  assert.equal(protocol.loadProtocolState(opts).capability.generations.at(-1).generation.state.databaseRestore.status, 'CLEAR');
});

function makeResetFixture() {
  const { tmp, opts } = makeRoots();
  protocol.initialize({ ...opts, operationId: GENESIS_OPERATION, createdAt: '2026-07-19T00:00:00.000Z' });
  const genesis = protocol.loadProtocolState(opts);
  transitions.recordHistoricalV2Disposition({
    ...opts, operationId: DISPOSITION_OPERATION, createdAt: '2026-07-19T00:01:00.000Z',
    expectedHeadSha256: genesis.capability.head.generationSha256,
    expectedWitnessSha256: genesis.capability.head.witnessSha256,
    expectedActivityGeneration: genesis.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(genesis.activity.externalHead),
    source: { sourceKind: 'zero', sourceAuthorityKind: 'deployment-backup', dispositionReceiptSha256: SHA_A,
      auditSha256: SHA_B, databaseSha256: SHA_C, backupSha256: SHA_D, identitySha256: SHA_E,
      historicalV2Disposition: 'CLEAR' },
  });
  const clear = protocol.loadProtocolState(opts);
  const fromIdentity = SHA_A;
  transitions.appendTransition(
    {
      ...opts, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedHeadSha256: clear.capability.head.generationSha256,
      expectedWitnessSha256: clear.capability.head.witnessSha256,
      expectedActivityGeneration: clear.activity.externalHead.generation,
      expectedActivityHeadSha256: protocol.canonicalSha256(clear.activity.externalHead),
      createdAt: '2026-07-19T00:02:00.000Z',
    },
    {
      kind: 'NEGOTIATED',
      state: {
        activeIdentitySha256: fromIdentity, mode: 'V3_PINNED', historicalV2Disposition: 'CLEAR',
        historicalV2DispositionReceiptSha256: clear.capability.generations.at(-1).generation.state.historicalV2DispositionReceiptSha256,
        databaseRestore: { status: 'CLEAR', restoreEpoch: 0 }, identitySha256: fromIdentity,
        normalizedServerBase: 'https://cloud.example', gatewayDeviceEui: '0016C001F11715E2', capabilityProofSha256: SHA_B,
      },
      receipt: { format: 1, receiptKind: 'test-negotiation' },
      receiptPath: path.join(tmp, 'negotiation-test-receipt.json'),
    }
  );
  const active = protocol.loadProtocolState(opts);
  const toIdentity = SHA_B;
  const confirmation = {
    format: 1, authorizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectedHeadSha256: active.capability.head.generationSha256,
    expectedWitnessSha256: active.capability.head.witnessSha256,
    expectedGeneration: active.capability.head.generation,
    fromIdentitySha256: fromIdentity, toIdentitySha256: toIdentity,
    reason: 'gateway migration approved', expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const ackAudit = {
    scopedCloudNonterminalOutcomeRows: 0, scopedCloudAckOutboxRows: 0, scopedCloudRetryRows: 0,
    scopedCloudExternalIntentRows: 0, historicalUnscopedTerminalRows: 0, historicalUnscopedEffectRows: 0,
    historicalUnscopedAckOutboxRows: 0, historicalUnscopedRetryRows: 0, historicalUnscopedReferenceRows: 0,
    malformedCommandKeyRows: 0, unknownProtocolRows: 0, orphanCommandReferenceRows: 0, conflictingDuplicateRows: 0,
  };
  const backupManifest = {
    format: 1, capabilityGeneration: active.capability.head.generation,
    capabilityHeadSha256: active.capability.head.generationSha256,
    capabilityWitnessSha256: active.capability.head.witnessSha256,
    ackAuditSha256: protocol.canonicalSha256(ackAudit), fromIdentitySha256: fromIdentity,
    guardEvidence: { nodeRedAbsent: true, identitydAbsent: true, oneShotChildrenAbsent: true,
      rcLinksQuarantined: true, identitydLockAbsent: true, terminalFactsReconciled: true },
  };
  const confirmationPath = path.join(tmp, 'reset-confirmation.json');
  fs.writeFileSync(confirmationPath, protocol.canonicalJson(confirmation), { mode: 0o600 });
  const call = {
    ...opts, confirmation, backupManifest, ackAuditReport: ackAudit,
    expectedHeadSha256: active.capability.head.generationSha256,
    expectedWitnessSha256: active.capability.head.witnessSha256,
    expectedActivityGeneration: active.activity.externalHead.generation,
    expectedActivityHeadSha256: protocol.canonicalSha256(active.activity.externalHead),
    confirmationPath,
    now: '2026-07-19T00:10:00.000Z', createdAt: '2026-07-19T00:10:00.000Z',
  };
  return { tmp, opts, call, fromIdentity, toIdentity, confirmationPath };
}

test('authorizeReset appends one RESET_AUTHORIZATION generation only after clean all-protocol audit', (t) => {
  const { tmp, opts, call, fromIdentity, toIdentity, confirmationPath } = makeResetFixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const result = transitions.authorizeReset(call);

  assert.equal(result.generation, 3);
  assert.equal(fs.existsSync(confirmationPath), false);
  const reset = protocol.loadProtocolState(opts).capability.generations.at(-1).generation.state;
  assert.equal(reset.mode, 'RESET_AUTHORIZED');
  assert.equal(reset.fromIdentitySha256, fromIdentity);
  assert.equal(reset.toIdentitySha256, toIdentity);
  assert.equal(reset.resetEpoch, 1);
  const receiptPath = path.join(opts.root, 'protocol-capabilities', 'reset-receipts', `${call.confirmation.authorizationId}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.backupManifestSha256 = SHA_E;
  fs.writeFileSync(receiptPath, protocol.canonicalJson(receipt), { mode: 0o600 });
  assert.throws(() => protocol.loadProtocolState(opts), { code: 'typed_receipt_hash_mismatch' });
});

test('authorizeReset resumes every generation/receipt/witness/head crash boundary exactly once', (t) => {
  const dirs = [];
  t.after(() => dirs.forEach((tmp) => fs.rmSync(tmp, { recursive: true, force: true })));
  for (const crashAfter of ['transition_generation', 'transition_receipt', 'transition_witness', 'transition_head']) {
    const { tmp, opts, call, confirmationPath } = makeResetFixture();
    dirs.push(tmp);
    assert.throws(() => transitions.authorizeReset({ ...call, crashAfter }), { code: 'injected_transition_crash' });
    assert.equal(fs.existsSync(confirmationPath), true, crashAfter);
    const resumed = transitions.authorizeReset({
      ...call,
      now: '2026-07-19T00:11:00.000Z',
      createdAt: '2026-07-19T09:09:09.000Z',
    });
    assert.equal(resumed.generation, 3, crashAfter);
    assert.equal(resumed.resumed, true, crashAfter);
    assert.equal(fs.existsSync(confirmationPath), false, crashAfter);
    const loaded = protocol.loadProtocolState(opts);
    assert.equal(loaded.capability.generations.length, 4, crashAfter);
    assert.equal(loaded.capability.head.generation, 3, crashAfter);
    assert.equal(loaded.capability.generations.at(-1).generation.state.resetAuthorizedAt, '2026-07-19T00:10:00.000Z');
  }
});

function makeFactoryFixture() {
  const { tmp, opts } = makeRoots();
  const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const factoryProvenance = { format: 2, imageBuildId: 'image-1', profile: 'bcm2712' };
  const imageGuardManifest = { format: 1, profile: 'bcm2712', manifestSha256: SHA_A };
  const factorySeedReceipt = {
    format: 1, receiptKind: 'factory-seed', seedSha256: SHA_A,
    databaseIdentitySha256: SHA_B, databaseLineageSha256: SHA_C,
  };
  const ackAuditReport = {
    format: 1, factorySeedEligible: true, databaseIdentitySha256: SHA_B,
    databaseLineageSha256: SHA_C, allCountersZero: true,
  };
  const outDir = path.join(tmp, 'factory-protocol');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const call = {
    ...opts, operationId, baselineId: 'baseline-1', parentGeneration: 12,
    factoryProvenance, imageGuardManifest, factorySeedReceipt, ackAuditReport,
    factoryIntentOut: path.join(outDir, 'intent.json'),
    factoryZeroSourceReceiptOut: path.join(outDir, 'source-receipt.json'),
    createdAt: '2026-07-19T00:11:00.000Z',
  };
  return { tmp, opts, call };
}

test('initializeFactoryZero creates genesis plus factory-baseline zero/CLEAR from all-root absence', (t) => {
  const { tmp, opts, call } = makeFactoryFixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const result = transitions.initializeFactoryZero(call);

  assert.equal(result.generation, 1);
  assert.match(result.factoryCommandActivityAnchorSha256, /^[0-9a-f]{64}$/);
  const loaded = protocol.loadProtocolState(opts);
  const zero = loaded.capability.generations.at(-1).generation;
  assert.equal(zero.state.sourceAuthorityKind, 'factory-baseline');
  assert.equal(zero.state.historicalV2Disposition, 'CLEAR');
  assert.equal(loaded.activity.externalHead.generation, 0);
});

test('initializeFactoryZero resumes every factory disposition transition boundary exactly once', (t) => {
  const dirs = [];
  t.after(() => dirs.forEach((tmp) => fs.rmSync(tmp, { recursive: true, force: true })));
  for (const crashAfter of ['transition_generation', 'transition_receipt', 'transition_witness', 'transition_head']) {
    const { tmp, opts, call } = makeFactoryFixture();
    dirs.push(tmp);
    assert.throws(() => transitions.initializeFactoryZero({ ...call, crashAfter }), { code: 'injected_transition_crash' });
    const resumed = transitions.initializeFactoryZero({ ...call, createdAt: '2026-07-19T09:09:09.000Z' });
    assert.equal(resumed.generation, 1, crashAfter);
    assert.equal(resumed.resumed, true, crashAfter);
    const loaded = protocol.loadProtocolState(opts);
    assert.equal(loaded.capability.generations.length, 2, crashAfter);
    assert.equal(loaded.capability.head.generation, 1, crashAfter);
    assert.equal(loaded.capability.generations.at(-1).generation.createdAt, '2026-07-19T00:11:00.000Z');
  }
});

test('initializeFactoryZero resumes every four-root initialization boundary under the immutable factory intent', (t) => {
  const dirs = [];
  const steps = [
    'capability_dirs_created', 'capability_genesis_written', 'witness_root_created',
    'capability_witness_written', 'capability_head_published', 'activity_root_created',
    'activity_database_created', 'activity_head_witness_root_created',
    'activity_checkpoint_written', 'activity_head_published',
  ];
  t.after(() => dirs.forEach((tmp) => fs.rmSync(tmp, { recursive: true, force: true })));
  for (const crashAfter of steps) {
    const { tmp, opts, call } = makeFactoryFixture();
    dirs.push(tmp);
    const script = `require(${JSON.stringify(path.join(__dirname, 'capability-transitions.js'))}).initializeFactoryZero(${JSON.stringify({ ...call, crashAfter })})`;
    const crashed = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(crashed.status, 137, `${crashAfter}: ${crashed.stderr}`);
    const resumed = transitions.initializeFactoryZero({ ...call, createdAt: '2026-07-19T09:09:09.000Z' });
    assert.equal(resumed.generation, 1, crashAfter);
    const loaded = protocol.loadProtocolState(opts);
    assert.equal(loaded.capability.generations.length, 2, crashAfter);
    assert.equal(loaded.capability.generations[0].generation.createdAt, '2026-07-19T00:11:00.000Z', crashAfter);
    assert.equal(loaded.activity.genesisRow.operation_id, call.operationId, crashAfter);
  }
});
