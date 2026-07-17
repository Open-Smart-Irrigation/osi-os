'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const mod = require('./index');
const codecs = require('./codecs');
const pathsMod = require('./paths');
const activityDb = require('./activity-db');
const locksMod = require('./locks');
const initMod = require('./init');
const loadMod = require('./load');
const deploymentGate = require('./deployment-state-gate');

const OP_A = '11111111-1111-4111-8111-111111111111';
const OP_B = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-07-16T00:00:00.000Z';

const tempRoots = [];
function makeRoots() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sync-protocol-state-test-'));
  tempRoots.push(tmp);
  return {
    tmp,
    opts: {
      root: path.join(tmp, 'osi-sync'),
      witnessRoot: path.join(tmp, 'osi-sync-witness', 'protocol-capability-witnesses'),
      activityWitnessRoot: path.join(tmp, 'osi-sync-witness', 'command-activity-witnesses'),
    },
  };
}

test.after(() => {
  for (const tmp of tempRoots) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// codecs: canonicalJson / hashing
// ===========================================================================

test('canonicalJson sorts object keys deterministically', () => {
  const a = codecs.canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = codecs.canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('canonicalJson rejects undefined at top level and nested', () => {
  assert.throws(() => codecs.canonicalJson(undefined), { code: 'canonical_json_undefined' });
  assert.throws(() => codecs.canonicalJson({ a: undefined }), { code: 'canonical_json_undefined' });
});

test('canonicalJson encodes arrays and primitives', () => {
  assert.equal(codecs.canonicalJson([1, 'a', true, false, null]), '[1,"a",true,false,null]');
});

test('sha256Hex / canonicalSha256 are deterministic', () => {
  const h1 = codecs.canonicalSha256({ a: 1, b: 2 });
  const h2 = codecs.canonicalSha256({ b: 2, a: 1 });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ===========================================================================
// codecs: GENESIS byte-exact schema
// ===========================================================================

test('buildGenesisGeneration produces the exact literal plan schema', () => {
  const gen = codecs.buildGenesisGeneration({ operationId: OP_A, createdAt: CREATED_AT });
  assert.deepEqual(gen, {
    format: 1,
    generation: 0,
    previousGeneration: null,
    previousSha256: null,
    operationId: OP_A,
    kind: 'GENESIS',
    createdAt: CREATED_AT,
    state: {
      activeIdentitySha256: null,
      mode: 'UNNEGOTIATED',
      historicalV2Disposition: 'UNASSESSED',
      historicalV2DispositionReceiptSha256: null,
      databaseRestore: { status: 'CLEAR', restoreEpoch: 0 },
    },
  });
});

test('buildGenesisWitness / buildCapabilityHead produce the exact literal schema', () => {
  const gen = codecs.buildGenesisGeneration({ operationId: OP_A, createdAt: CREATED_AT });
  const generationSha256 = codecs.canonicalSha256(gen);
  const witness = codecs.buildGenesisWitness({ generationSha256, operationId: OP_A });
  assert.deepEqual(witness, {
    format: 1,
    generation: 0,
    generationSha256,
    previousWitnessSha256: null,
    operationId: OP_A,
  });
  const witnessSha256 = codecs.canonicalSha256(witness);
  const head = codecs.buildCapabilityHead({ generation: 0, generationSha256, witnessSha256 });
  assert.deepEqual(head, { format: 1, generation: 0, generationSha256, witnessSha256 });
});

test('GENESIS generation rejects an unknown field', () => {
  const gen = codecs.buildGenesisGeneration({ operationId: OP_A, createdAt: CREATED_AT });
  gen.extra = 'nope';
  assert.throws(() => codecs.validateGenesisGeneration(gen), { code: 'schema_unknown_field' });
});

test('GENESIS state rejects each field mutated away from its exact literal', () => {
  const base = () => codecs.buildGenesisGeneration({ operationId: OP_A, createdAt: CREATED_AT });
  const mutations = [
    (g) => { g.state.activeIdentitySha256 = 'x'.repeat(64); },
    (g) => { g.state.mode = 'LEGACY_V2'; },
    (g) => { g.state.historicalV2Disposition = 'CLEAR'; },
    (g) => { g.state.historicalV2DispositionReceiptSha256 = 'x'.repeat(64); },
    (g) => { g.state.databaseRestore.status = 'RECONCILIATION_REQUIRED'; },
    (g) => { g.state.databaseRestore.restoreEpoch = 1; },
    (g) => { g.generation = 1; },
    (g) => { g.previousGeneration = 0; },
    (g) => { g.kind = 'NEGOTIATED'; },
  ];
  for (const mutate of mutations) {
    const gen = base();
    mutate(gen);
    assert.throws(() => codecs.validateGeneration(gen), Error, `mutation should have been rejected: ${mutate}`);
  }
});

// ===========================================================================
// codecs: full closed kind union (non-GENESIS) — validation only
// ===========================================================================

function validNegotiatedGeneration() {
  return {
    format: 1,
    generation: 1,
    previousGeneration: 0,
    previousSha256: 'a'.repeat(64),
    operationId: OP_B,
    kind: 'NEGOTIATED',
    createdAt: CREATED_AT,
    state: {
      activeIdentitySha256: 'b'.repeat(64),
      mode: 'V3_PINNED',
      historicalV2Disposition: 'CLEAR',
      historicalV2DispositionReceiptSha256: 'c'.repeat(64),
      databaseRestore: { status: 'CLEAR', restoreEpoch: 0 },
      identitySha256: 'b'.repeat(64),
      normalizedServerBase: 'https://cloud.example.com',
      gatewayDeviceEui: '0016C001F11715E2',
      capabilityProofSha256: null,
    },
  };
}

test('NEGOTIATED generation validates when well-formed', () => {
  assert.doesNotThrow(() => codecs.validateGeneration(validNegotiatedGeneration()));
});

test('NEGOTIATED generation rejects an unknown field', () => {
  const gen = validNegotiatedGeneration();
  gen.state.extraField = 'nope';
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_unknown_field' });
});

test('NEGOTIATED generation requires activeIdentitySha256 === identitySha256', () => {
  const gen = validNegotiatedGeneration();
  gen.state.activeIdentitySha256 = 'd'.repeat(64);
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_invalid_field' });
});

test('NEGOTIATED generation rejects RESET_AUTHORIZATION-only fields (cross-kind rejection)', () => {
  const gen = validNegotiatedGeneration();
  gen.state.authorizationId = OP_A;
  gen.state.toIdentitySha256 = 'e'.repeat(64);
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_unknown_field' });
});

function validResetGeneration() {
  return {
    format: 1,
    generation: 1,
    previousGeneration: 0,
    previousSha256: 'a'.repeat(64),
    operationId: OP_B,
    kind: 'RESET_AUTHORIZATION',
    createdAt: CREATED_AT,
    state: {
      activeIdentitySha256: 'f'.repeat(64),
      mode: 'RESET_AUTHORIZED',
      historicalV2Disposition: 'CLEAR',
      historicalV2DispositionReceiptSha256: 'c'.repeat(64),
      databaseRestore: { status: 'CLEAR', restoreEpoch: 0 },
      authorizationId: OP_A,
      confirmationSha256: 'a1'.repeat(32),
      fromIdentitySha256: 'b'.repeat(64),
      toIdentitySha256: 'f'.repeat(64),
      resetEpoch: 1,
      resetAuthorizedAt: CREATED_AT,
      resetReasonSha256: 'b2'.repeat(32),
    },
  };
}

test('RESET_AUTHORIZATION generation validates when well-formed', () => {
  assert.doesNotThrow(() => codecs.validateGeneration(validResetGeneration()));
});

test('RESET_AUTHORIZATION generation requires activeIdentitySha256 === toIdentitySha256', () => {
  const gen = validResetGeneration();
  gen.state.activeIdentitySha256 = 'z'.repeat(64);
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_invalid_field' });
});

test('RESET_AUTHORIZATION generation rejects NEGOTIATED-only fields (cross-kind rejection)', () => {
  const gen = validResetGeneration();
  gen.state.normalizedServerBase = 'https://cloud.example.com';
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_unknown_field' });
});

function validDispositionGeneration(sourceKind, extra) {
  const base = {
    format: 1,
    generation: 1,
    previousGeneration: 0,
    previousSha256: 'a'.repeat(64),
    operationId: OP_B,
    kind: 'HISTORICAL_V2_DISPOSITION',
    createdAt: CREATED_AT,
    state: Object.assign(
      {
        activeIdentitySha256: null,
        mode: 'UNNEGOTIATED',
        historicalV2Disposition: sourceKind === 'zero' || sourceKind === 'rebind' ? 'CLEAR' : 'RECONCILIATION_REQUIRED',
        historicalV2DispositionReceiptSha256: 'c'.repeat(64),
        databaseRestore: { status: 'CLEAR', restoreEpoch: 0 },
        sourceKind,
      },
      extra
    ),
  };
  return base;
}

test('HISTORICAL_V2_DISPOSITION zero/deployment-backup validates when well-formed', () => {
  const gen = validDispositionGeneration('zero', {
    sourceAuthorityKind: 'deployment-backup',
    dispositionReceiptSha256: 'a'.repeat(64),
    auditSha256: 'b'.repeat(64),
    databaseSha256: 'c'.repeat(64),
    backupSha256: 'd'.repeat(64),
    identitySha256: null,
  });
  assert.doesNotThrow(() => codecs.validateGeneration(gen));
});

test('HISTORICAL_V2_DISPOSITION zero/factory-baseline forbids deployment-backup fields', () => {
  const gen = validDispositionGeneration('zero', {
    sourceAuthorityKind: 'factory-baseline',
    romProvenanceSha256: 'a'.repeat(64),
    imageManifestSha256: 'b'.repeat(64),
    factorySeedIdentitySha256: 'c'.repeat(64),
    liveDatabaseIdentitySha256: 'd'.repeat(64),
    factoryZeroAuditSha256: 'e'.repeat(64),
    factoryZeroSourceReceiptSha256: 'f'.repeat(64),
    imageBaselineOperationId: OP_A,
    imageBaselineGeneration: 0,
    allRootAbsenceIntentSha256: 'a1'.repeat(32),
  });
  assert.doesNotThrow(() => codecs.validateGeneration(gen));
  gen.state.backupSha256 = 'b2'.repeat(32); // forbidden deployment-backup field
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_unknown_field' });
});

test('HISTORICAL_V2_DISPOSITION quarantine requires RECONCILIATION_REQUIRED', () => {
  const gen = validDispositionGeneration('quarantine', {
    dispositionReceiptSha256: 'a'.repeat(64),
    auditSha256: 'b'.repeat(64),
    databaseSha256: 'c'.repeat(64),
    backupSha256: 'd'.repeat(64),
    identitySha256: null,
  });
  assert.doesNotThrow(() => codecs.validateGeneration(gen));
  gen.state.historicalV2Disposition = 'CLEAR';
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_invalid_field' });
});

test('HISTORICAL_V2_DISPOSITION rejects an invalid sourceKind', () => {
  const gen = validDispositionGeneration('bogus', {});
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_invalid_field' });
});

test('DATABASE_RESTORE_INVALIDATION / _RECONCILED validate and enforce their status', () => {
  const invalidation = {
    format: 1,
    generation: 1,
    previousGeneration: 0,
    previousSha256: 'a'.repeat(64),
    operationId: OP_B,
    kind: 'DATABASE_RESTORE_INVALIDATION',
    createdAt: CREATED_AT,
    state: {
      activeIdentitySha256: null,
      mode: 'UNNEGOTIATED',
      historicalV2Disposition: 'CLEAR',
      historicalV2DispositionReceiptSha256: 'c'.repeat(64),
      databaseRestore: { status: 'RECONCILIATION_REQUIRED', restoreEpoch: 1 },
      invalidationReceiptSha256: 'd'.repeat(64),
      recoveryOperationId: OP_A,
    },
  };
  assert.doesNotThrow(() => codecs.validateGeneration(invalidation));
  const wrongStatus = JSON.parse(JSON.stringify(invalidation));
  wrongStatus.state.databaseRestore.status = 'CLEAR';
  assert.throws(() => codecs.validateGeneration(wrongStatus), { code: 'schema_invalid_field' });

  const reconciled = JSON.parse(JSON.stringify(invalidation));
  reconciled.kind = 'DATABASE_RESTORE_RECONCILED';
  delete reconciled.state.invalidationReceiptSha256;
  reconciled.state.databaseRestore.status = 'CLEAR';
  reconciled.state.reconciledReceiptSha256 = 'e'.repeat(64);
  assert.doesNotThrow(() => codecs.validateGeneration(reconciled));
});

test('DATABASE_INTEGRITY_INVALIDATION / _RECONCILED validate and enforce their status', () => {
  const invalidation = {
    format: 1,
    generation: 1,
    previousGeneration: 0,
    previousSha256: 'a'.repeat(64),
    operationId: OP_B,
    kind: 'DATABASE_INTEGRITY_INVALIDATION',
    createdAt: CREATED_AT,
    state: {
      activeIdentitySha256: null,
      mode: 'UNNEGOTIATED',
      historicalV2Disposition: 'UNASSESSED',
      historicalV2DispositionReceiptSha256: null,
      databaseRestore: { status: 'RECONCILIATION_REQUIRED', restoreEpoch: 1 },
      latchObservationSha256: 'a'.repeat(64),
      trustedBackupSha256: 'b'.repeat(64),
      forensicDestinationSha256: 'c'.repeat(64),
      activityRootsSha256: 'd'.repeat(64),
      manualLossAcknowledgementSha256: 'e'.repeat(64),
      recoveryOperationId: OP_A,
    },
  };
  assert.doesNotThrow(() => codecs.validateGeneration(invalidation));

  const reconciled = JSON.parse(JSON.stringify(invalidation));
  reconciled.kind = 'DATABASE_INTEGRITY_RECONCILED';
  delete reconciled.state.latchObservationSha256;
  delete reconciled.state.trustedBackupSha256;
  delete reconciled.state.forensicDestinationSha256;
  delete reconciled.state.activityRootsSha256;
  delete reconciled.state.manualLossAcknowledgementSha256;
  reconciled.state.databaseRestore.status = 'CLEAR';
  Object.assign(reconciled.state, {
    importOrCutoffAuthoritySha256: 'f'.repeat(64),
    restoredOrFinalAuditSha256: 'a1'.repeat(32),
    forensicInventorySha256: 'b2'.repeat(32),
    zeroEffectReceiptSha256: 'c3'.repeat(32),
  });
  assert.doesNotThrow(() => codecs.validateGeneration(reconciled));
});

test('validateGeneration rejects an unknown kind outright', () => {
  const gen = validNegotiatedGeneration();
  gen.kind = 'SOMETHING_ELSE';
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_invalid_field' });
});

test('validateGeneration requires generation === previousGeneration + 1', () => {
  const gen = validNegotiatedGeneration();
  gen.generation = 5;
  assert.throws(() => codecs.validateGeneration(gen), { code: 'schema_invalid_field' });
});

// ===========================================================================
// codecs: normalizedServerBase / identitySha256
// ===========================================================================

test('normalizedServerBase enforces https and lowercases the hostname', () => {
  assert.equal(codecs.normalizedServerBase('https://Cloud.Example.com'), 'https://cloud.example.com/');
  assert.throws(() => codecs.normalizedServerBase('http://cloud.example.com'), { code: 'server_base_requires_https' });
});

test('normalizedServerBase forbids userinfo, query, and fragment', () => {
  assert.throws(() => codecs.normalizedServerBase('https://user:pass@cloud.example.com'), { code: 'server_base_forbids_userinfo' });
  assert.throws(() => codecs.normalizedServerBase('https://cloud.example.com/?x=1'), { code: 'server_base_forbids_query' });
  assert.throws(() => codecs.normalizedServerBase('https://cloud.example.com/#frag'), { code: 'server_base_forbids_fragment' });
});

test('normalizedServerBase omits the default port 443 but retains a non-default port', () => {
  assert.equal(codecs.normalizedServerBase('https://cloud.example.com:443/api'), 'https://cloud.example.com/api');
  assert.equal(codecs.normalizedServerBase('https://cloud.example.com:8443/api'), 'https://cloud.example.com:8443/api');
});

test('normalizedServerBase normalizes a trailing slash on a non-root path', () => {
  assert.equal(codecs.normalizedServerBase('https://cloud.example.com/api/'), 'https://cloud.example.com/api');
  assert.equal(codecs.normalizedServerBase('https://cloud.example.com/'), 'https://cloud.example.com/');
});

test('normalizedServerBase rejects a malformed URL', () => {
  assert.throws(() => codecs.normalizedServerBase('not-a-url'), { code: 'server_base_invalid' });
});

test('identitySha256 is deterministic and uppercases the gateway EUI', () => {
  const args = { peerNode: 'peer-1', serverBase: 'https://cloud.example.com', cloudUserId: 'user-1', gatewayDeviceEui: '0016c001f11715e2' };
  const h1 = codecs.identitySha256(args);
  const h2 = codecs.identitySha256(Object.assign({}, args, { gatewayDeviceEui: '0016C001F11715E2' }));
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('identitySha256 rejects a malformed gateway EUI', () => {
  assert.throws(() => codecs.identitySha256({ peerNode: 'p', serverBase: 'https://c', cloudUserId: 'u', gatewayDeviceEui: 'not-hex' }), { code: 'identity_invalid_gateway_eui' });
});

// ===========================================================================
// paths: symlink/mode/exclusive-write discipline
// ===========================================================================

test('assertNoSymlinkComponents rejects a symlinked directory component', () => {
  const { tmp } = makeRoots();
  const real = path.join(tmp, 'real');
  fs.mkdirSync(real);
  const link = path.join(tmp, 'link');
  fs.symlinkSync(real, link);
  assert.throws(() => pathsMod.assertNoSymlinkComponents(path.join(link, 'child.json')), { code: 'symlink_component' });
});

test('ensureModeDirRecursive creates mode-0700 directories at every level', () => {
  const { tmp } = makeRoots();
  const deep = path.join(tmp, 'a', 'b', 'c');
  pathsMod.ensureModeDirRecursive(deep, pathsMod.defaultOwnershipAdapter);
  for (const p of [path.join(tmp, 'a'), path.join(tmp, 'a', 'b'), deep]) {
    const stat = fs.lstatSync(p);
    assert.equal(stat.mode & 0o777, 0o700);
  }
});

test('writeExclusiveFile refuses to overwrite an existing file', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const p = path.join(tmp, 'f.json');
  pathsMod.writeExclusiveFile(p, Buffer.from('{}'), pathsMod.defaultOwnershipAdapter);
  assert.equal(fs.lstatSync(p).mode & 0o777, 0o600);
  assert.throws(() => pathsMod.writeExclusiveFile(p, Buffer.from('{}'), pathsMod.defaultOwnershipAdapter), { code: 'EEXIST' });
});

test('writeExclusiveOrVerify creates on absence, is a no-op on byte-identical presence, and throws on mismatch', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const p = path.join(tmp, 'f.json');
  const buf = Buffer.from('{"a":1}');
  const r1 = pathsMod.writeExclusiveOrVerify(p, buf, pathsMod.defaultOwnershipAdapter, 'mismatch');
  assert.equal(r1.created, true);
  const r2 = pathsMod.writeExclusiveOrVerify(p, buf, pathsMod.defaultOwnershipAdapter, 'mismatch');
  assert.equal(r2.created, false);
  assert.throws(() => pathsMod.writeExclusiveOrVerify(p, Buffer.from('{"a":2}'), pathsMod.defaultOwnershipAdapter, 'mismatch_code'), { code: 'mismatch_code' });
});

test('listRegularEntries rejects a symlink masquerading as a chain entry', () => {
  const { tmp } = makeRoots();
  const dir = path.join(tmp, 'chain');
  fs.mkdirSync(dir, { recursive: true });
  const real = path.join(tmp, 'real.json');
  fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, path.join(dir, '0000000000000000.json'));
  assert.throws(() => pathsMod.listRegularEntries(dir, /^\d{16}\.json$/), { code: 'chain_entry_not_regular_file' });
});

test('deriveActivityHeadWitnessRoot requires the fixed sibling leaf name', () => {
  assert.throws(() => pathsMod.deriveActivityHeadWitnessRoot('/data/osi-sync-witness/wrong-leaf-name'), { code: 'activity_witness_root_leaf_mismatch' });
  assert.equal(
    pathsMod.deriveActivityHeadWitnessRoot('/data/osi-sync-witness/command-activity-witnesses'),
    '/data/osi-sync-witness/command-activity-head-witnesses'
  );
});

// ===========================================================================
// activity-db: schema / pragmas / genesis row / hot-journal recovery
// ===========================================================================

test('createActivityDatabase produces the fixed schema, pragmas, and a hash-consistent genesis row', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  const { genesisRow, headRow, checkpoint } = activityDb.createActivityDatabase({
    finalPath,
    operationId: OP_A,
    createdAt: CREATED_AT,
    sourceKind: 'deployment',
  });
  assert.equal(genesisRow.kind, 'GENESIS');
  assert.equal(genesisRow.principalKind, 'system');
  assert.equal(genesisRow.commandKeySha256, null);
  assert.equal(genesisRow.adapterId, null);
  assert.equal(headRow.generation, 0);
  assert.equal(checkpoint.checkpointGeneration, 0);
  assert.equal(fs.lstatSync(finalPath).mode & 0o777, 0o600);

  const db = activityDb.openReadOnly(finalPath);
  try {
    activityDb.verifyFixedSchema(db);
    assert.equal(activityDb.quickCheck(db), true);
  } finally {
    db.close();
  }
});

test('createActivityDatabase refuses to overwrite an existing file', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  activityDb.createActivityDatabase({ finalPath, operationId: OP_A, createdAt: CREATED_AT, sourceKind: 'deployment' });
  assert.throws(
    () => activityDb.createActivityDatabase({ finalPath, operationId: OP_B, createdAt: CREATED_AT, sourceKind: 'deployment' }),
    { code: 'activity_db_already_exists' }
  );
});

test('verifyFixedSchema rejects an extra table', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  activityDb.createActivityDatabase({ finalPath, operationId: OP_A, createdAt: CREATED_AT, sourceKind: 'deployment' });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(finalPath);
  db.exec('CREATE TABLE extra_table (id INTEGER PRIMARY KEY)');
  assert.throws(() => activityDb.verifyFixedSchema(db), { code: 'activity_schema_table_mismatch' });
  db.close();
});

test('verifyFixedSchema rejects an extra view/trigger', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  activityDb.createActivityDatabase({ finalPath, operationId: OP_A, createdAt: CREATED_AT, sourceKind: 'deployment' });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(finalPath);
  db.exec('CREATE VIEW extra_view AS SELECT * FROM activity_chain');
  assert.throws(() => activityDb.verifyFixedSchema(db), { code: 'activity_schema_extra_objects' });
  db.close();
});

test('recoverHotJournalIfPresent recovers a real crash-induced hot journal and leaves it absent', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  activityDb.createActivityDatabase({ finalPath, operationId: OP_A, createdAt: CREATED_AT, sourceKind: 'deployment' });

  const childScript = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(finalPath)});
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE activity_head SET segment_count = segment_count + 1 WHERE id=1').run();
    process.exit(137);
  `;
  const child = cp.spawnSync(process.execPath, ['-e', childScript]);
  assert.equal(child.status, 137);
  assert.equal(fs.existsSync(`${finalPath}-journal`), true);

  const result = activityDb.recoverHotJournalIfPresent({ dbPath: finalPath, ownershipAdapter: pathsMod.defaultOwnershipAdapter });
  assert.equal(result.recovered, true);
  assert.equal(fs.existsSync(`${finalPath}-journal`), false);

  const db = activityDb.openReadOnly(finalPath);
  const head = db.prepare('SELECT segment_count FROM activity_head WHERE id=1').get();
  assert.equal(head.segment_count, 1); // the uncommitted increment was rolled back
  db.close();
});

test('recoverHotJournalIfPresent rejects a -wal sidecar', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  fs.writeFileSync(finalPath, '');
  fs.writeFileSync(`${finalPath}-wal`, '');
  assert.throws(
    () => activityDb.recoverHotJournalIfPresent({ dbPath: finalPath, ownershipAdapter: pathsMod.defaultOwnershipAdapter }),
    { code: 'activity_db_unsupported_sidecar' }
  );
});

test('recoverHotJournalIfPresent rejects a symlinked journal', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  fs.writeFileSync(finalPath, '');
  const real = path.join(tmp, 'real-journal');
  fs.writeFileSync(real, '', { mode: 0o600 });
  fs.symlinkSync(real, `${finalPath}-journal`);
  assert.throws(
    () => activityDb.recoverHotJournalIfPresent({ dbPath: finalPath, ownershipAdapter: pathsMod.defaultOwnershipAdapter }),
    { code: 'activity_db_journal_symlink' }
  );
});

test('recoverHotJournalIfPresent rejects a wrong-mode journal', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  fs.writeFileSync(finalPath, '');
  fs.writeFileSync(`${finalPath}-journal`, '', { mode: 0o644 });
  assert.throws(
    () => activityDb.recoverHotJournalIfPresent({ dbPath: finalPath, ownershipAdapter: pathsMod.defaultOwnershipAdapter }),
    { code: 'activity_db_journal_wrong_mode' }
  );
});

test('recoverHotJournalIfPresent rejects a directory where the journal should be', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  fs.writeFileSync(finalPath, '');
  fs.mkdirSync(`${finalPath}-journal`, { mode: 0o700 });
  assert.throws(
    () => activityDb.recoverHotJournalIfPresent({ dbPath: finalPath, ownershipAdapter: pathsMod.defaultOwnershipAdapter }),
    (err) => err.code === 'activity_db_journal_wrong_mode' || err.code === 'activity_db_journal_wrong_type'
  );
});

test('recoverHotJournalIfPresent rejects an extra unexpected sidecar', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  fs.writeFileSync(finalPath, '');
  fs.writeFileSync(`${finalPath}-something-else`, '');
  assert.throws(
    () => activityDb.recoverHotJournalIfPresent({ dbPath: finalPath, ownershipAdapter: pathsMod.defaultOwnershipAdapter }),
    { code: 'activity_db_extra_sidecar' }
  );
});

test('recoveryOnlyHandle rejects a mutating statement even if the injected adapter tries one', () => {
  const { tmp } = makeRoots();
  fs.mkdirSync(tmp, { recursive: true });
  const finalPath = path.join(tmp, 'activity.sqlite');
  activityDb.createActivityDatabase({ finalPath, operationId: OP_A, createdAt: CREATED_AT, sourceKind: 'deployment' });
  fs.writeFileSync(`${finalPath}-journal`, '', { mode: 0o600 });
  const maliciousAdapter = (dbPath) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const handle = activityDb.recoveryOnlyHandle(db);
      handle.exec('DELETE FROM activity_chain');
    } finally {
      db.close();
    }
  };
  assert.throws(
    () =>
      activityDb.recoverHotJournalIfPresent({
        dbPath: finalPath,
        ownershipAdapter: pathsMod.defaultOwnershipAdapter,
        recoveryOnlyAdapter: maliciousAdapter,
      }),
    { code: 'activity_db_recovery_failed' }
  );
});

// ===========================================================================
// locks: four-root lock protocol
// ===========================================================================

test('acquireFourRootLocks acquires in fixed order and writes the documented fields', () => {
  const { tmp, opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  pathsMod.ensureFourRootDirsForLocking(roots, pathsMod.defaultOwnershipAdapter);
  const lock = locksMod.acquireFourRootLocks(
    roots,
    { operationId: OP_A, sourceKind: 'test', sourceAuthority: 'deployment', headIdentities: { x: 1 }, typedReceiptSha256: null },
    { bootId: 'boot-x' }
  );
  const order = pathsMod.fourRootsInLockOrder(roots).map((r) => path.join(r.dir, 'lock.json'));
  assert.deepEqual(lock.lockPaths, order);
  const payload = JSON.parse(fs.readFileSync(lock.lockPaths[0], 'utf8'));
  assert.equal(payload.format, 1);
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.bootId, 'boot-x');
  assert.equal(payload.operationId, OP_A);
  assert.equal(payload.sourceKind, 'test');
  assert.equal(payload.sourceAuthority, 'deployment');
  assert.deepEqual(payload.headIdentities, { x: 1 });
  lock.release();
  for (const p of lock.lockPaths) assert.equal(fs.existsSync(p), false);
});

test('a live same-boot lock owner blocks a second acquisition', () => {
  const { opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  pathsMod.ensureFourRootDirsForLocking(roots, pathsMod.defaultOwnershipAdapter);
  const held = locksMod.acquireFourRootLocks(roots, { operationId: OP_A, sourceKind: 'test' }, { bootId: 'boot-x' });
  assert.throws(
    () => locksMod.acquireFourRootLocks(roots, { operationId: OP_B, sourceKind: 'test' }, { bootId: 'boot-x' }),
    { code: 'lock_live_same_boot_owner' }
  );
  held.release();
});

test('a stale same-boot lock (dead PID) is reconciled and replaced', () => {
  const { opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  pathsMod.ensureFourRootDirsForLocking(roots, pathsMod.defaultOwnershipAdapter);
  const deadPid = 999999; // treated as dead via a fake isProcessAlive below
  const stalePath = path.join(roots.activityHeadWitnessRoot, 'lock.json');
  fs.writeFileSync(
    stalePath,
    JSON.stringify({ format: 1, pid: deadPid, bootId: 'boot-x', operationId: OP_A, sourceKind: 'test', sourceAuthority: null, headIdentities: {}, typedReceiptSha256: null, createdAt: CREATED_AT }),
    { mode: 0o600 }
  );
  let verifyCalled = false;
  const lock = locksMod.acquireFourRootLocks(
    roots,
    { operationId: OP_B, sourceKind: 'test' },
    {
      bootId: 'boot-x',
      isProcessAlive: () => false,
      reconcile: {
        verifyChain: () => { verifyCalled = true; },
        findProposalForOperation: () => null,
      },
    }
  );
  assert.equal(verifyCalled, true);
  lock.release();
});

test('a stale lock naming a still-pending proposal blocks a different operationId', () => {
  const { opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  pathsMod.ensureFourRootDirsForLocking(roots, pathsMod.defaultOwnershipAdapter);
  const stalePath = path.join(roots.activityHeadWitnessRoot, 'lock.json');
  fs.writeFileSync(
    stalePath,
    JSON.stringify({ format: 1, pid: 999999, bootId: 'boot-old', operationId: OP_A, sourceKind: 'test', sourceAuthority: null, headIdentities: {}, typedReceiptSha256: null, createdAt: CREATED_AT }),
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      locksMod.acquireFourRootLocks(
        roots,
        { operationId: OP_B, sourceKind: 'test' },
        {
          bootId: 'boot-new',
          reconcile: {
            verifyChain: () => {},
            findProposalForOperation: (staleOpId) => (staleOpId === OP_A ? { operationId: OP_A } : null),
          },
        }
      ),
    { code: 'lock_stale_proposal_pending' }
  );
});

// ===========================================================================
// init: four-root initialization primitive (strict "any partial blocks")
// ===========================================================================

test('initializeFourRoots creates all four roots with correct modes and a healthy load', () => {
  const { opts } = makeRoots();
  const created = initMod.initializeFourRoots(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
  assert.equal(created.capabilityGeneration.generation, 0);
  const roots = pathsMod.resolveRoots(opts);
  assert.equal(fs.lstatSync(roots.root).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(roots.capabilityRoot).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(roots.capabilityHeadPath).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(roots.activityDbPath).mode & 0o777, 0o600);
  const loaded = loadMod.loadProtocolState(Object.assign({}, opts, { repair: false }));
  assert.equal(loaded.initialized, true);
  assert.equal(loaded.resumePending, false);
});

test('initializeFourRoots blocks a second call against an already-initialized root set', () => {
  const { opts } = makeRoots();
  initMod.initializeFourRoots(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
  assert.throws(
    () => initMod.initializeFourRoots(Object.assign({}, opts, { operationId: OP_B, createdAt: CREATED_AT })),
    { code: 'partial_or_existing_root_set' }
  );
});

test('a crash after intent but before the first root entry resumes cleanly from all-absent', () => {
  const { opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  // Simulate "intent" with nothing on disk yet — a fresh call must simply succeed.
  assert.equal(initMod.probeAnyRootEntry(roots).length, 0);
  const created = initMod.initializeFourRoots(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
  assert.equal(created.capabilityGeneration.generation, 0);
});

const INIT_STEP_PATH = path.join(__dirname, 'init.js');

function crashAtStep(opts, step, operationId, createdAt) {
  const childScript = `
    const mod = require(${JSON.stringify(INIT_STEP_PATH)});
    mod.initializeFourRoots(${JSON.stringify(Object.assign({}, opts, { crashAfter: step, operationId, createdAt }))});
  `;
  const child = cp.spawnSync(process.execPath, ['-e', childScript]);
  assert.equal(child.status, 137, `expected a simulated crash (exit 137) at step "${step}", got ${child.status}: ${child.stderr}`);
}

test('crash-injection: every initialization boundary is independently crash-safe and fully resumable', () => {
  for (const step of initMod.STEPS) {
    const { opts } = makeRoots();
    crashAtStep(opts, step, OP_A, CREATED_AT);
    // status() must never throw an unhandled corruption error for any of
    // these boundaries — it's either uninitialized, mid-flight, or a
    // healthy resumable state.
    const st = mod.status(opts);
    assert.ok(st, `status() should return for crash at ${step}`);
    // A same-operationId, same-createdAt retry through the public
    // initialize() verb must always converge on a fully healthy state
    // without throwing, whether that means creating from scratch, resuming
    // a GENESIS-adjacent/activity one-ahead gap, or discovering the
    // operation had already fully completed before the crash (e.g. a
    // crash immediately after the final head publish, with nothing left
    // to do).
    const result = mod.initialize(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
    assert.ok(result, `initialize() should return for crash at ${step}`);
    const finalStatus = mod.status(opts);
    assert.equal(finalStatus.initialized, true, `final status should be healthy after crash at ${step}`);
    assert.equal(finalStatus.resumePending, false, `final status should have no pending resume after crash at ${step}`);
  }
});

test('a genuinely different operationId is blocked from barging in on an unfinished operation', () => {
  const { opts } = makeRoots();
  crashAtStep(opts, 'capability_genesis_written', OP_A, CREATED_AT);
  assert.throws(() => mod.initialize(Object.assign({}, opts, { operationId: OP_B })), { code: 'lock_stale_proposal_pending' });
});

// ===========================================================================
// load: chain-walking corruption/rollback/fork/gap/replay detection
// (hand-constructed multi-generation fixtures, per brief scope)
// ===========================================================================

function initHealthy(opts) {
  return initMod.initializeFourRoots(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
}

function appendHandCraftedGeneration(roots, priorGenerationSha256, generationObj, witnessObj) {
  pathsMod.writeExclusiveFile(
    path.join(roots.generationsDir, pathsMod.generationFilename(generationObj.generation)),
    Buffer.from(codecs.canonicalJson(generationObj), 'utf8'),
    pathsMod.defaultOwnershipAdapter
  );
  pathsMod.writeExclusiveFile(
    path.join(roots.witnessRoot, pathsMod.generationFilename(witnessObj.generation)),
    Buffer.from(codecs.canonicalJson(witnessObj), 'utf8'),
    pathsMod.defaultOwnershipAdapter
  );
  const generationSha256 = codecs.canonicalSha256(generationObj);
  const witnessSha256 = codecs.canonicalSha256(witnessObj);
  const head = codecs.buildCapabilityHead({ generation: generationObj.generation, generationSha256, witnessSha256 });
  pathsMod.atomicReplaceFile(roots.capabilityHeadPath, Buffer.from(codecs.canonicalJson(head), 'utf8'), pathsMod.defaultOwnershipAdapter);
  return { generationSha256, witnessSha256 };
}

function buildGen1(previousSha256, overrides) {
  return Object.assign(
    {
      format: 1,
      generation: 1,
      previousGeneration: 0,
      previousSha256,
      operationId: OP_B,
      kind: 'NEGOTIATED',
      createdAt: CREATED_AT,
      state: {
        activeIdentitySha256: 'b'.repeat(64),
        mode: 'V3_PINNED',
        historicalV2Disposition: 'CLEAR',
        historicalV2DispositionReceiptSha256: 'c'.repeat(64),
        databaseRestore: { status: 'CLEAR', restoreEpoch: 0 },
        identitySha256: 'b'.repeat(64),
        normalizedServerBase: 'https://cloud.example.com',
        gatewayDeviceEui: '0016C001F11715E2',
        capabilityProofSha256: null,
      },
    },
    overrides || {}
  );
}

test('load: a valid multi-generation chain (hand-crafted gen 1) verifies cleanly', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const genesisSha256 = codecs.canonicalSha256(created.capabilityGeneration);
  const gen1 = buildGen1(genesisSha256);
  const witness1 = { format: 1, generation: 1, generationSha256: codecs.canonicalSha256(gen1), previousWitnessSha256: codecs.canonicalSha256(created.capabilityWitness), operationId: OP_B };
  appendHandCraftedGeneration(roots, genesisSha256, gen1, witness1);
  const result = loadMod.verifyCapabilityChain(roots, { ownershipAdapter: pathsMod.defaultOwnershipAdapter });
  assert.equal(result.maxGeneration, 1);
  assert.equal(result.resumable, null);
});

test('load: detects a fork (previousSha256 does not match the actual predecessor hash)', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const gen1 = buildGen1('f'.repeat(64)); // wrong previousSha256
  const witness1 = { format: 1, generation: 1, generationSha256: codecs.canonicalSha256(gen1), previousWitnessSha256: codecs.canonicalSha256(created.capabilityWitness), operationId: OP_B };
  appendHandCraftedGeneration(roots, 'f'.repeat(64), gen1, witness1);
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_generation_fork' });
});

test('load: detects a replayed operationId across two generations', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const genesisSha256 = codecs.canonicalSha256(created.capabilityGeneration);
  const gen1 = buildGen1(genesisSha256, { operationId: OP_A }); // reuses genesis operationId
  const witness1 = { format: 1, generation: 1, generationSha256: codecs.canonicalSha256(gen1), previousWitnessSha256: codecs.canonicalSha256(created.capabilityWitness), operationId: OP_A };
  appendHandCraftedGeneration(roots, genesisSha256, gen1, witness1);
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_generation_replay' });
});

test('load: detects a generation-number gap', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const genesisSha256 = codecs.canonicalSha256(created.capabilityGeneration);
  const gen2 = buildGen1(genesisSha256, { generation: 2, previousGeneration: 1 });
  pathsMod.writeExclusiveFile(
    path.join(roots.generationsDir, pathsMod.generationFilename(2)),
    Buffer.from(codecs.canonicalJson(gen2), 'utf8'),
    pathsMod.defaultOwnershipAdapter
  );
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_generation_gap' });
});

test('load: detects a witness hash mismatch', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const genesisSha256 = codecs.canonicalSha256(created.capabilityGeneration);
  const gen1 = buildGen1(genesisSha256);
  const badWitness = { format: 1, generation: 1, generationSha256: 'a'.repeat(64), previousWitnessSha256: codecs.canonicalSha256(created.capabilityWitness), operationId: OP_B };
  pathsMod.writeExclusiveFile(path.join(roots.generationsDir, pathsMod.generationFilename(1)), Buffer.from(codecs.canonicalJson(gen1), 'utf8'), pathsMod.defaultOwnershipAdapter);
  pathsMod.writeExclusiveFile(path.join(roots.witnessRoot, pathsMod.generationFilename(1)), Buffer.from(codecs.canonicalJson(badWitness), 'utf8'), pathsMod.defaultOwnershipAdapter);
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_witness_hash_mismatch' });
});

test('load: detects a capability head rollback (older valid pointer with a fully witnessed newer state)', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const genesisSha256 = codecs.canonicalSha256(created.capabilityGeneration);
  const gen1 = buildGen1(genesisSha256);
  const witness1 = { format: 1, generation: 1, generationSha256: codecs.canonicalSha256(gen1), previousWitnessSha256: codecs.canonicalSha256(created.capabilityWitness), operationId: OP_B };
  appendHandCraftedGeneration(roots, genesisSha256, gen1, witness1);
  // Now hand-craft generation 2 (also fully witnessed) so generation 1's
  // head is a "stale but valid" rollback, not the legitimate one-step
  // resume case.
  const gen1Sha256 = codecs.canonicalSha256(gen1);
  const gen2 = buildGen1(gen1Sha256, { generation: 2, previousGeneration: 1, operationId: crypto.randomUUID() });
  const witness2 = { format: 1, generation: 2, generationSha256: codecs.canonicalSha256(gen2), previousWitnessSha256: codecs.canonicalSha256(witness1), operationId: gen2.operationId };
  pathsMod.writeExclusiveFile(path.join(roots.generationsDir, pathsMod.generationFilename(2)), Buffer.from(codecs.canonicalJson(gen2), 'utf8'), pathsMod.defaultOwnershipAdapter);
  pathsMod.writeExclusiveFile(path.join(roots.witnessRoot, pathsMod.generationFilename(2)), Buffer.from(codecs.canonicalJson(witness2), 'utf8'), pathsMod.defaultOwnershipAdapter);
  // Roll the head back to generation 1 (a stale-but-previously-valid head).
  const rolledBackHead = codecs.buildCapabilityHead({ generation: 1, generationSha256: gen1Sha256, witnessSha256: codecs.canonicalSha256(witness1) });
  fs.rmSync(roots.capabilityHeadPath, { force: true });
  pathsMod.writeExclusiveFile(roots.capabilityHeadPath, Buffer.from(codecs.canonicalJson(rolledBackHead), 'utf8'), pathsMod.defaultOwnershipAdapter);
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_head_rollback' });
});

test('load: GENESIS-adjacent resume — witness missing is detected and (with repair) completed', () => {
  const { opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  crashAtStep(opts, 'capability_genesis_written', OP_A, CREATED_AT);
  const before = loadMod.verifyCapabilityChain(roots, {});
  assert.equal(before.resumable && before.resumable.kind, 'WITNESS_CREATION');
  const repaired = loadMod.repairCapabilityChain(roots, before, {});
  assert.equal(fs.existsSync(path.join(roots.witnessRoot, '0000000000000000.json')), true);
  // Repair completes exactly the missing witness (per line 353: "after
  // generation/receipt it resumes the missing witness; after witness it
  // resumes the exact head" — two separate resume points). Having just
  // created the witness, head.json is still absent, so the chain now
  // reports the next resume point rather than a fully healthy state.
  assert.equal(repaired.resumable && repaired.resumable.kind, 'HEAD_PUBLICATION');
  const fullyRepaired = loadMod.repairCapabilityChain(roots, repaired, {});
  assert.equal(fullyRepaired.resumable, null);
  assert.equal(fs.existsSync(roots.capabilityHeadPath), true);
});

test('load: GENESIS-adjacent resume — head missing is detected and (with repair) completed', () => {
  const { opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  crashAtStep(opts, 'capability_witness_written', OP_A, CREATED_AT);
  const before = loadMod.verifyCapabilityChain(roots, {});
  assert.equal(before.resumable && before.resumable.kind, 'HEAD_PUBLICATION');
  const repaired = loadMod.repairCapabilityChain(roots, before, {});
  assert.equal(repaired.resumable, null);
  assert.equal(fs.existsSync(roots.capabilityHeadPath), true);
});

test('load: a non-GENESIS resumable-shaped gap validates-and-blocks rather than auto-repairing', () => {
  // Brief scope: "Single-valid-unheaded-proposal resume rules implemented
  // for GENESIS-adjacent states... disposition/reset/restore resume
  // branches validate-and-block (their creating verbs are out of scope)."
  // A generation-1-written-but-unwitnessed shape is byte-for-byte
  // identical to the legitimate GENESIS-adjacent resume case except that
  // it starts from generation 0 -> 1, which IS the GENESIS-adjacent case
  // — so this fixture instead proves the boundary one step further out:
  // once a witnessed generation 1 exists, an unwitnessed generation 2
  // cannot be auto-resumed and is indistinguishable from a rollback.
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const genesisSha256 = codecs.canonicalSha256(created.capabilityGeneration);
  const gen1 = buildGen1(genesisSha256);
  const witness1 = { format: 1, generation: 1, generationSha256: codecs.canonicalSha256(gen1), previousWitnessSha256: codecs.canonicalSha256(created.capabilityWitness), operationId: OP_B };
  appendHandCraftedGeneration(roots, genesisSha256, gen1, witness1);
  const gen2 = buildGen1(codecs.canonicalSha256(gen1), { generation: 2, previousGeneration: 1, operationId: crypto.randomUUID() });
  // generation 2 written, witness NOT written, head still at generation 1.
  // Since the IMPORTANT-1 fix, this blocks at the bidirectional
  // set-equality check (an orphan generation above the witness chain is
  // indistinguishable from a witness-root rollback) rather than falling
  // through to the head comparison — same block, stricter classification.
  pathsMod.writeExclusiveFile(path.join(roots.generationsDir, pathsMod.generationFilename(2)), Buffer.from(codecs.canonicalJson(gen2), 'utf8'), pathsMod.defaultOwnershipAdapter);
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_witness_missing' });
});

test('load: activity database rollback against a newer external head is detected', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  // Craft an external head claiming a higher generation than the database has.
  const forged = { format: 1, generation: 1, entrySha256: 'a'.repeat(64), checkpointGeneration: 0, checkpointSha256: codecs.canonicalSha256(created.activityCheckpoint) };
  fs.rmSync(roots.activityHeadPath, { force: true });
  pathsMod.writeExclusiveFile(roots.activityHeadPath, Buffer.from(codecs.canonicalJson(forged), 'utf8'), pathsMod.defaultOwnershipAdapter);
  assert.throws(() => loadMod.verifyActivityRoots(roots, {}), { code: 'activity_database_rollback' });
});

test('load: an orphan newer checkpoint than the external head is detected (external-head-only rollback)', () => {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const previousCheckpointSha256 = codecs.canonicalSha256(created.activityCheckpoint);
  const entrySha256 = 'a'.repeat(64);
  const cumulativeSha256 = activityDb.checkpointCumulativeSha256(created.activityCheckpoint.cumulativeSha256, entrySha256);
  const orphanCheckpoint = { format: 1, checkpointGeneration: 1, entrySha256, previousCheckpointSha256, cumulativeSha256, createdAt: CREATED_AT };
  pathsMod.writeExclusiveFile(path.join(roots.checkpointsDir, pathsMod.generationFilename(1)), Buffer.from(codecs.canonicalJson(orphanCheckpoint), 'utf8'), pathsMod.defaultOwnershipAdapter);
  // The checkpoint chain itself is well-formed; the external head.json
  // still points at checkpointGeneration 0 even though a newer, validly
  // chained checkpoint 1 exists on disk — exactly the "external-head-only
  // rollback" shape (a newer checkpoint exists but the published head was
  // replaced with an older valid pointer).
  assert.throws(() => loadMod.verifyActivityRoots(roots, {}), { code: 'activity_external_head_rollback' });
});

test('load: activity one-ahead crash is resumable and completed by repair', () => {
  const { opts } = makeRoots();
  const roots = pathsMod.resolveRoots(opts);
  crashAtStep(opts, 'activity_database_created', OP_A, CREATED_AT);
  const before = loadMod.verifyActivityRoots(roots, {});
  assert.equal(before.resumable && before.resumable.kind, 'EXTERNAL_HEAD_PUBLICATION');
  const repaired = loadMod.repairActivityRoots(roots, before, {});
  assert.equal(repaired.resumable, null);
  assert.equal(fs.existsSync(roots.activityHeadPath), true);
});

// ===========================================================================
// deployment-state-gate
// ===========================================================================

function writeDeploymentState(tmp, obj) {
  const p = path.join(tmp, 'deployment-state.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('requireDeploymentPhase accepts an exact match and rejects a phase/id/generation mismatch', () => {
  const { tmp } = makeRoots();
  const p = writeDeploymentState(tmp, { format: 1, deploymentId: 'dep-1', phase: 'protocol-initializing', parentGeneration: 3 });
  assert.doesNotThrow(() =>
    deploymentGate.requireDeploymentPhase(p, { expectedDeploymentId: 'dep-1', expectedPhase: 'protocol-initializing', expectedParentGeneration: 3 })
  );
  assert.throws(
    () => deploymentGate.requireDeploymentPhase(p, { expectedDeploymentId: 'dep-1', expectedPhase: 'protocol-dispositioning', expectedParentGeneration: 3 }),
    { code: 'deployment_state_wrong_phase' }
  );
  assert.throws(
    () => deploymentGate.requireDeploymentPhase(p, { expectedDeploymentId: 'dep-2', expectedPhase: 'protocol-initializing', expectedParentGeneration: 3 }),
    { code: 'deployment_state_wrong_deployment_id' }
  );
  assert.throws(
    () => deploymentGate.requireDeploymentPhase(p, { expectedDeploymentId: 'dep-1', expectedPhase: 'protocol-initializing', expectedParentGeneration: 4 }),
    { code: 'deployment_state_wrong_parent_generation' }
  );
});

test('readDeploymentStateFile rejects unknown fields and a missing file', () => {
  const { tmp } = makeRoots();
  const p = writeDeploymentState(tmp, { format: 1, deploymentId: 'dep-1', phase: 'protocol-initializing', parentGeneration: 0, extra: 'nope' });
  assert.throws(() => deploymentGate.readDeploymentStateFile(p), { code: 'schema_unknown_field' });
  assert.throws(() => deploymentGate.readDeploymentStateFile(path.join(tmp, 'absent.json')), { code: 'deployment_state_missing' });
});

test('readDeploymentStateFile rejects a symlinked path', () => {
  const { tmp } = makeRoots();
  const real = writeDeploymentState(tmp, { format: 1, deploymentId: 'dep-1', phase: 'protocol-initializing', parentGeneration: 0 });
  const link = path.join(tmp, 'link.json');
  fs.symlinkSync(real, link);
  assert.throws(() => deploymentGate.readDeploymentStateFile(link), { code: 'symlink_component' });
});

// ===========================================================================
// integration: index.js public surface (initialize / status)
// ===========================================================================

test('index.initialize / index.status: fresh happy path is idempotent', () => {
  const { opts } = makeRoots();
  const created = mod.initialize(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
  assert.equal(created.created, true);
  const again = mod.initialize(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
  assert.equal(again.created, false);
  const st = mod.status(opts);
  assert.equal(st.initialized, true);
  assert.equal(st.mode, 'UNNEGOTIATED');
  assert.equal(st.activeIdentitySha256, null);
});

test('index.status never writes to disk (read-only)', () => {
  const { opts } = makeRoots();
  mod.initialize(Object.assign({}, opts, { operationId: OP_A, createdAt: CREATED_AT }));
  const roots = pathsMod.resolveRoots(opts);
  const before = fs.readFileSync(roots.capabilityHeadPath, 'utf8');
  mod.status(opts);
  mod.status(opts);
  const after = fs.readFileSync(roots.capabilityHeadPath, 'utf8');
  assert.equal(before, after);
});

// ===========================================================================
// Fix wave (review IMPORTANT 1): single-root tail-deletion rollback
// detection — bidirectional generation/witness set equality.
// ===========================================================================

// Builds a healthy, fully committed 2-generation chain (genesis + a
// hand-crafted NEGOTIATED generation 1 with its witness and head at 1) and
// returns everything needed to surgically damage single roots afterwards.
function buildHealthyTwoGenerationChain() {
  const { opts } = makeRoots();
  const created = initHealthy(opts);
  const roots = created.roots;
  const genesisSha256 = codecs.canonicalSha256(created.capabilityGeneration);
  const genesisWitnessSha256 = codecs.canonicalSha256(created.capabilityWitness);
  const gen1 = buildGen1(genesisSha256);
  const witness1 = {
    format: 1,
    generation: 1,
    generationSha256: codecs.canonicalSha256(gen1),
    previousWitnessSha256: genesisWitnessSha256,
    operationId: OP_B,
  };
  appendHandCraftedGeneration(roots, genesisSha256, gen1, witness1);
  // sanity: healthy before the attack
  const healthy = loadMod.verifyCapabilityChain(roots, {});
  assert.equal(healthy.maxGeneration, 1);
  assert.equal(healthy.resumable, null);
  return { roots, created, genesisSha256, genesisWitnessSha256, gen1, witness1 };
}

function rewindHeadToGenesis(roots, genesisSha256, genesisWitnessSha256) {
  const rolledBackHead = codecs.buildCapabilityHead({
    generation: 0,
    generationSha256: genesisSha256,
    witnessSha256: genesisWitnessSha256,
  });
  pathsMod.atomicReplaceFile(
    roots.capabilityHeadPath,
    Buffer.from(codecs.canonicalJson(rolledBackHead), 'utf8'),
    pathsMod.defaultOwnershipAdapter
  );
}

test('load: tail generation deleted + head rewound, witness root intact -> BLOCKED (single-root rollback)', () => {
  const { roots, genesisSha256, genesisWitnessSha256 } = buildHealthyTwoGenerationChain();
  fs.rmSync(path.join(roots.generationsDir, pathsMod.generationFilename(1)));
  rewindHeadToGenesis(roots, genesisSha256, genesisWitnessSha256);
  // witness 1 survives in the independent witness root: an orphan witness
  // above the head proves the generation root was rolled back alone.
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_witness_orphan' });
});

test('load: tail witness deleted + head rewound, generation root intact -> BLOCKED (single-root rollback)', () => {
  const { roots, genesisSha256, genesisWitnessSha256 } = buildHealthyTwoGenerationChain();
  fs.rmSync(path.join(roots.witnessRoot, pathsMod.generationFilename(1)));
  rewindHeadToGenesis(roots, genesisSha256, genesisWitnessSha256);
  // generation 1 survives in the generation root: an orphan generation
  // above the witness chain proves the witness root was rolled back alone.
  assert.throws(() => loadMod.verifyCapabilityChain(roots, {}), { code: 'capability_witness_missing' });
});

test('load: CONSISTENT both-roots tail deletion + head rewind is NOT detected (documented threat-model boundary)', () => {
  // Adjudicated against plan line 352: "A privileged actor that
  // consistently rolls back all independent roots is outside the
  // software-only threat model and requires a hardware monotonic counter
  // or external witness; the plan states this limit rather than claiming
  // tamper resistance." Deleting the tail generation AND its same-number
  // witness AND rewinding the head is byte-for-byte indistinguishable from
  // a chain that legitimately never advanced past genesis, so the verifier
  // accepts it BY DESIGN. This test pins that stance so any future change
  // to it is deliberate, not accidental.
  const { roots, genesisSha256, genesisWitnessSha256 } = buildHealthyTwoGenerationChain();
  fs.rmSync(path.join(roots.generationsDir, pathsMod.generationFilename(1)));
  fs.rmSync(path.join(roots.witnessRoot, pathsMod.generationFilename(1)));
  rewindHeadToGenesis(roots, genesisSha256, genesisWitnessSha256);
  const result = loadMod.verifyCapabilityChain(roots, {});
  assert.equal(result.maxGeneration, 0);
  assert.equal(result.resumable, null);
  assert.equal(result.head.generation, 0);
});
