'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const seed = require('./lib/factory-database-seed');

const ROLE_LINKS = {
  'osi-identityd': ['/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd'],
  'node-red': ['/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red'],
  'osi-bootstrap': ['/etc/rc.d/S99osi-bootstrap'],
  'osi-db-integrity': ['/etc/rc.d/S90osi-db-integrity'],
};

const cli = path.join(__dirname, 'audit-command-ack-state.js');
function run(args, env = {}) { return cp.spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function db(file, { nonzero = false, abbreviated = false } = {}) {
  const sql = abbreviated
    ? 'CREATE TABLE applied_commands(command_id TEXT); CREATE TABLE command_ack_outbox(id INTEGER);'
    : `CREATE TABLE applied_commands(command_id TEXT PRIMARY KEY,device_eui TEXT NOT NULL,command_type TEXT NOT NULL,effect_key TEXT,applied_at TEXT NOT NULL,result TEXT NOT NULL,result_detail TEXT,originator TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_ack_attempt_at TEXT,expires_at TEXT);
       CREATE TABLE command_ack_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,delivered_at TEXT,retry_count INTEGER NOT NULL DEFAULT 0,last_error TEXT);`;
  const insert = nonzero ? "INSERT INTO applied_commands(command_id,device_eui,command_type,applied_at,result) VALUES('x','e','t','now','ok');" : '';
  const r = cp.spawnSync('sqlite3', [file, `${sql}${insert}`], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
}

function fixture(options = {}) {
  const boundary = path.join('/tmp', `osi-factory-zero-tests-${process.getuid()}`);
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  fs.chmodSync(boundary, 0o700);
  const d = fs.mkdtempSync(path.join(boundary, 'case-'));
  const factorySeed = path.join(d, 'seed.db'); db(factorySeed, options);
  const seedBoundary = path.join('/tmp', `osi-factory-seed-tests-${process.getuid()}`);
  fs.mkdirSync(seedBoundary, { recursive: true, mode: 0o700 }); fs.chmodSync(seedBoundary, 0o700);
  const mountAdapter = path.join(seedBoundary, 'factory-mountinfo.test');
  fs.writeFileSync(mountAdapter,
    '36 25 8:1 / @DATA_ROOT@ rw,relatime - ext4 /dev/test-factory rw\n', { mode: 0o600 });
  fs.chmodSync(mountAdapter, 0o600);
  const seedCase = fs.mkdtempSync(path.join(seedBoundary, 'factory-zero-'));
  const database = path.join(seedCase, 'data/db/farming.db');
  const receipt = path.join(d, 'receipts/base-1.factory-seed.json');
  const lineage = path.join(d, 'factory-database-lineage.json');
  const seedSha256 = sha(factorySeed);
  const previousSeedRoot = process.env.OSI_FACTORY_SEED_TEST_ROOT;
  const previousRepairMode = process.env.OSI_REPAIR_PROGRAM_MODE;
  const previousArtifactMode = process.env.OSI_DEPLOY_ARTIFACT_MODE;
  const previousMountInfo = process.env.OSI_FACTORY_SEED_TEST_MOUNTINFO;
  process.env.OSI_REPAIR_PROGRAM_MODE = '1';
  process.env.OSI_DEPLOY_ARTIFACT_MODE = 'test';
  process.env.OSI_FACTORY_SEED_TEST_ROOT = seedBoundary;
  process.env.OSI_FACTORY_SEED_TEST_MOUNTINFO = mountAdapter;
  const realized = seed.realize({ factorySeed, expectedSeedSha256: seedSha256, database, operationId: 'base-1', receiptOut: receipt, databaseLineageOut: lineage });
  if (previousSeedRoot === undefined) delete process.env.OSI_FACTORY_SEED_TEST_ROOT; else process.env.OSI_FACTORY_SEED_TEST_ROOT = previousSeedRoot;
  if (previousRepairMode === undefined) delete process.env.OSI_REPAIR_PROGRAM_MODE; else process.env.OSI_REPAIR_PROGRAM_MODE = previousRepairMode;
  if (previousArtifactMode === undefined) delete process.env.OSI_DEPLOY_ARTIFACT_MODE; else process.env.OSI_DEPLOY_ARTIFACT_MODE = previousArtifactMode;
  if (previousMountInfo === undefined) delete process.env.OSI_FACTORY_SEED_TEST_MOUNTINFO;
  else process.env.OSI_FACTORY_SEED_TEST_MOUNTINFO = previousMountInfo;
  const provenance = path.join(d, 'factory-image-provenance.json');
  fs.writeFileSync(provenance, JSON.stringify({ format: 2, imageBuildId: 'image-1', profile: 'bcm2712', factorySeedSha256: seedSha256, signedEnvelope: 'test-only' }), { mode: 0o600 });
  const validator = path.join(d, 'factory-image-provenance-validator.js');
  fs.writeFileSync(validator, `
const crypto = require('node:crypto');
const fs = require('node:fs');
exports.validateFactoryImageProvenance = ({ raw }) => {
  const value = JSON.parse(raw);
  if (value.format !== 2 || !['bcm2712', 'bcm2709'].includes(value.profile) || !/^[0-9a-f]{64}$/.test(value.factorySeedSha256)) throw new Error('invalid format-2 provenance');
  if (process.env.OSI_FACTORY_PROVENANCE_TEST_MUTATE) {
    if (process.env.OSI_FACTORY_PROVENANCE_TEST_MUTATE_ROLE_STATE === '1') {
      const current = JSON.parse(fs.readFileSync(process.env.OSI_FACTORY_PROVENANCE_TEST_MUTATE, 'utf8'));
      current.roles['node-red'].generation += 1;
      fs.writeFileSync(process.env.OSI_FACTORY_PROVENANCE_TEST_MUTATE, JSON.stringify(current), { mode: 0o600 });
    } else fs.appendFileSync(process.env.OSI_FACTORY_PROVENANCE_TEST_MUTATE, ' ');
  }
  if (process.env.OSI_FACTORY_PROVENANCE_TEST_CREATE_PATH) {
    fs.mkdirSync(require('node:path').dirname(process.env.OSI_FACTORY_PROVENANCE_TEST_CREATE_PATH), { recursive: true });
    fs.writeFileSync(process.env.OSI_FACTORY_PROVENANCE_TEST_CREATE_PATH, 'reappeared', { mode: 0o600 });
  }
  return { format: 2, profile: value.profile, factorySeedSha256: value.factorySeedSha256, provenanceSha256: crypto.createHash('sha256').update(raw).digest('hex') };
};
`, { mode: 0o600 });
  const roots = {
    root: path.join(d, 'capability'),
    witnessRoot: path.join(d, 'witness'),
    activityWitnessRoot: path.join(d, 'activity'),
    activityHeadWitnessRoot: path.join(d, 'activity-head'),
  };
  const bootId = 'boot-factory-test';
  const bootIdFile = path.join(d, 'current-boot-id');
  fs.writeFileSync(bootIdFile, `${bootId}\n`, { mode: 0o600 });
  const stoppedRoles = path.join(d, 'stopped-roles.json');
  const currentRoleState = path.join(d, 'current-role-state.json');
  const linkGenerations = path.join(d, 'link-generations.json');
  const roles = {
    'osi-identityd': { running: false, generation: 7 },
    'node-red': { running: options.currentRunning === true, generation: 11 },
    'osi-bootstrap': { running: false, generation: 3 },
    'osi-db-integrity': { running: false, generation: 5 },
  };
  fs.writeFileSync(stoppedRoles, JSON.stringify({ format: 1, bootId: options.staleBoot ? 'old-boot' : bootId, roles }), { mode: 0o600 });
  const currentRoles = Object.fromEntries(Object.entries(roles).map(([role, evidence]) => [role, {
    running: evidence.running,
    ready: evidence.running,
    pid: evidence.running ? 1234 : null,
    processStartTime: evidence.running ? '987654' : null,
    generation: evidence.generation,
    bootId,
    rcLinks: ROLE_LINKS[role].map((linkPath) => ({ path: linkPath, state: 'absent' })),
  }]));
  if (options.currentGenerationDrift) currentRoles['node-red'].generation += 1;
  if (options.currentRestarted) {
    currentRoles['node-red'].running = true;
    currentRoles['node-red'].ready = true;
    currentRoles['node-red'].pid = 5678;
    currentRoles['node-red'].processStartTime = '1234567';
  }
  if (options.currentLinkEnabled) {
    currentRoles['node-red'].rcLinks[0] = {
      path: '/etc/rc.d/S99node-red', state: 'symlink', target: '../init.d/node-red',
    };
  }
  fs.writeFileSync(currentRoleState, JSON.stringify({ format: 1, bootId, roles: currentRoles }), { mode: 0o600 });
  const links = ['S90osi-db-integrity', 'S98osi-identityd', 'K98osi-identityd', 'S99node-red', 'K99node-red', 'S99osi-bootstrap']
    .map((name, index) => ({ path: `/etc/rc.d/${options.noncanonicalLink && index === 0 ? `wrong-${name}` : name}`, generation: index + 1, state: 'absent' }));
  fs.writeFileSync(linkGenerations, JSON.stringify({ format: 1, bootId, links }), { mode: 0o600 });
  const state = path.join(d, 'deployment-state.json');
  fs.writeFileSync(state, JSON.stringify({
    format: 2,
    parentDeployment: {
      deploymentId: 'base-1', phase: 'image-baseline-initializing', generation: 4,
      imageBaselinePrefix: 'baseline-completing',
      databaseLineage: { status: 'valid', databaseLineageSha256: realized.databaseLineageSha256, seedReceiptSha256: realized.seedReceiptSha256 },
      factoryZeroAuthority: {
        factoryProvenanceSha256: sha(provenance), factorySeedReceiptSha256: realized.seedReceiptSha256,
        databaseLineageSha256: realized.databaseLineageSha256, databaseIdentitySha256: realized.databaseIdentitySha256,
        protocolRoots: roots, bootId,
        stoppedRoleEvidence: { path: stoppedRoles, sha256: sha(stoppedRoles) },
        linkGenerationEvidence: { path: linkGenerations, sha256: sha(linkGenerations) },
      },
    },
    activeSubOperation: null,
  }), { mode: 0o600 });
  const report = path.join(d, 'audit.json');
  const args = ['factory-zero-audit', '--database', database,
    '--activity-witness-root', roots.activityWitnessRoot,
    '--activity-head-witness-root', roots.activityHeadWitnessRoot, '--deployment-state', state,
    '--expected-baseline-id', 'base-1', '--expected-phase', 'image-baseline-initializing',
    '--expected-baseline-prefix', 'baseline-completing', '--expected-parent-generation', '4',
    '--factory-provenance', provenance, '--factory-seed-receipt', receipt,
    '--database-lineage', lineage, '--expected-database-lineage-sha256', realized.databaseLineageSha256,
    '--report-out', report];
  const env = {
    OSI_REPAIR_PROGRAM_MODE: '1', OSI_DEPLOY_ARTIFACT_MODE: 'test',
    OSI_FACTORY_PROVENANCE_TEST_VALIDATOR: validator,
    OSI_FACTORY_ZERO_TEST_ROOT: d,
    OSI_FACTORY_ZERO_TEST_BOOT_ID_FILE: bootIdFile,
    OSI_FACTORY_ZERO_TEST_CURRENT_ROLE_STATE_HELPER: path.join(__dirname, 'current-role-state.js'),
    OSI_CURRENT_ROLE_STATE_TEST_SNAPSHOT: currentRoleState,
    OSI_FACTORY_SEED_TEST_ROOT: seedBoundary,
    OSI_FACTORY_SEED_TEST_MOUNTINFO: mountAdapter,
  };
  return { d, database, receipt, lineage, provenance, roots, state, report, args, realized, stoppedRoles, currentRoleState, linkGenerations, env };
}

test('factory-zero-audit requires and cross-binds provenance, seed receipt, lineage, live database, roots, and exact tables', () => {
  const f = fixture();
  const shadowBin = path.join(f.d, 'path-shadow');
  const shadowMarker = path.join(f.d, 'path-shadow-sqlite3-ran');
  fs.mkdirSync(shadowBin, { mode: 0o700 });
  const shadowSqlite = path.join(shadowBin, 'sqlite3');
  fs.writeFileSync(shadowSqlite, `#!/bin/sh\nprintf ran >${JSON.stringify(shadowMarker)}\nexit 99\n`, { mode: 0o755 });
  fs.chmodSync(shadowSqlite, 0o755);
  const result = run(f.args, { ...f.env, PATH: `${shadowBin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(shadowMarker), false, 'audit must execute pinned /usr/bin/sqlite3, never PATH sqlite3');
  const body = JSON.parse(fs.readFileSync(f.report));
  assert.deepEqual(body.counters, { appliedCommands: 0, commandAckOutbox: 0 });
  assert.deepEqual(body.protocolRoots, f.roots);
  assert.equal(body.factoryProvenanceSha256, sha(f.provenance));
  assert.equal(body.factorySeedReceiptSha256, f.realized.seedReceiptSha256);
  assert.equal(body.databaseLineageSha256, f.realized.databaseLineageSha256);
  assert.equal(body.factorySeedEligible, true);
  assert.notEqual(run(f.args, f.env).status, 0, 'the report is immutable and one-use');
});

test('factory-zero-audit rejects missing evidence, any existing protocol root, abbreviated schemas, and nonzero rows', () => {
  for (const mutation of ['missing-provenance', 'activity-root', 'activity-head-root', 'abbreviated-schema', 'nonzero']) {
    const f = fixture({ abbreviated: mutation === 'abbreviated-schema', nonzero: mutation === 'nonzero' });
    if (mutation === 'missing-provenance') fs.unlinkSync(f.provenance);
    if (mutation === 'activity-root') fs.mkdirSync(f.roots.activityWitnessRoot);
    if (mutation === 'activity-head-root') fs.mkdirSync(f.roots.activityHeadWitnessRoot);
    const result = run(f.args, f.env);
    assert.notEqual(result.status, 0, mutation);
    assert.equal(fs.existsSync(f.report), false, `${mutation} must not publish a report`);
  }
});

test('factory-zero-audit rejects noncanonical links, stale boot evidence, and current role restart/generation drift', () => {
  for (const options of [{ noncanonicalLink: true }, { staleBoot: true }, { currentRunning: true },
    { currentRestarted: true }, { currentGenerationDrift: true }, { currentLinkEnabled: true }]) {
    const f = fixture(options);
    const result = run(f.args, f.env);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.equal(fs.existsSync(f.report), false);
  }
});

test('factory-zero-audit fails closed without the shared format-2 validator and on unstable repeated evidence reads', () => {
  const absent = fixture();
  assert.notEqual(run(absent.args, { OSI_REPAIR_PROGRAM_MODE: '1' }).status, 0, 'production absence of commit-2 validator must reject');
  assert.equal(fs.existsSync(absent.report), false);

  const unstable = fixture();
  const result = run(unstable.args, { ...unstable.env, OSI_FACTORY_PROVENANCE_TEST_MUTATE: unstable.stoppedRoles });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stable|changed|evidence/i);
  assert.equal(fs.existsSync(unstable.report), false);

  const currentDrift = fixture();
  const currentResult = run(currentDrift.args, {
    ...currentDrift.env, OSI_FACTORY_PROVENANCE_TEST_MUTATE: currentDrift.currentRoleState,
    OSI_FACTORY_PROVENANCE_TEST_MUTATE_ROLE_STATE: '1',
  });
  assert.notEqual(currentResult.status, 0);
  assert.match(currentResult.stderr, /stable|changed|evidence/i);
  assert.equal(fs.existsSync(currentDrift.report), false);
});

test('factory-zero-audit second pass rejects every reappearing link and protocol authority root', () => {
  const template = fixture();
  const linkPaths = JSON.parse(fs.readFileSync(template.linkGenerations, 'utf8')).links
    .map((link) => path.join(template.d, `.${link.path}`));
  const reappearing = [...linkPaths, template.roots.root];
  for (const target of reappearing) {
    const f = fixture();
    const actualTarget = target === template.roots.root
      ? f.roots.root
      : path.join(f.d, path.relative(template.d, target));
    const result = run(f.args, { ...f.env, OSI_FACTORY_PROVENANCE_TEST_CREATE_PATH: actualTarget });
    assert.notEqual(result.status, 0, actualTarget);
    assert.match(result.stderr, /absent|stable|changed|authority|link/i, actualTarget);
    assert.equal(fs.existsSync(f.report), false, `${actualTarget}: report must not publish`);
  }
});

test('ordinary audit remains explicitly outside the A0 skeleton', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-audit-ordinary-'));
  const result = run(['audit', '--database', path.join(d, 'db'), '--activity-witness-root', path.join(d, 'a'),
    '--deployment-state', path.join(d, 's'), '--expected-deployment-id', 'd', '--report-out', path.join(d, 'r')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NOT_IMPLEMENTED_IN_THIS_SLICE/);
});
