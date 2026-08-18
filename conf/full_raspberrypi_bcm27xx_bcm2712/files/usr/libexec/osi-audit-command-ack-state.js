#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const seedLibraryPath = fs.existsSync(path.join(__dirname, 'lib/factory-database-seed.js'))
  ? path.join(__dirname, 'lib/factory-database-seed.js')
  : path.join(__dirname, 'osi-factory-database-seed.js');
const factorySeed = require(seedLibraryPath);
const deploymentStatePath = [
  path.join(__dirname, 'lib/deployment-state.js'), path.join(__dirname, 'osi-deployment-state.js'),
].find((candidate) => fs.existsSync(candidate));
if (!deploymentStatePath) throw new Error('shared deployment-state publication primitive is unavailable');
const deploymentState = require(deploymentStatePath);
const PRODUCTION_ROLE_STATE_ADAPTER = '/usr/libexec/osi-current-role-state';
const SQLITE3 = '/usr/bin/sqlite3';
const SAFE_PROCESS_ENV = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' });
process.env.PATH = SAFE_PROCESS_ENV.PATH;
process.env.LANG = SAFE_PROCESS_ENV.LANG;
process.env.LC_ALL = SAFE_PROCESS_ENV.LC_ALL;

const SPECS = {
  'factory-zero-audit': ['database', 'activity-witness-root', 'activity-head-witness-root', 'deployment-state', 'expected-baseline-id', 'expected-phase', 'expected-baseline-prefix', 'expected-parent-generation', 'factory-provenance', 'factory-seed-receipt', 'database-lineage', 'expected-database-lineage-sha256', 'report-out'],
  audit: ['database', 'activity-witness-root', 'deployment-state', 'expected-deployment-id', 'report-out'],
};
const TABLE_COLUMNS = {
  applied_commands: ['command_id', 'device_eui', 'command_type', 'effect_key', 'applied_at', 'result', 'result_detail', 'originator', 'attempt_count', 'last_error', 'last_ack_attempt_at', 'expires_at'],
  command_ack_outbox: ['id', 'command_id', 'payload_json', 'created_at', 'delivered_at', 'retry_count', 'last_error'],
};
const ROLE_LINKS = Object.freeze({
  'osi-identityd': Object.freeze(['/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd']),
  'node-red': Object.freeze(['/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red']),
  'osi-bootstrap': Object.freeze(['/etc/rc.d/S99osi-bootstrap']),
  'osi-db-integrity': Object.freeze(['/etc/rc.d/S90osi-db-integrity']),
});

function parse(argv) {
  const verb = argv[0];
  const required = SPECS[verb];
  if (!required) throw new Error('unknown verb');
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    const token = argv[i]; const value = argv[i + 1];
    if (!token || !token.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('invalid argv');
    const key = token.slice(2);
    if (!required.includes(key)) throw new Error(`unknown flag ${token}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate flag ${token}`);
    values[key] = value;
  }
  for (const key of required) if (!values[key]) throw new Error(`missing --${key}`);
  return { verb, values };
}

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new Error(`${label} has an invalid shape`);
  }
  return value;
}
function assertCurrentStoppedRoleState(current, stopped, bootId) {
  exact(current, ['format', 'bootId', 'roles'], 'current role-state');
  exact(current.roles, Object.keys(ROLE_LINKS), 'current role-state roles');
  if (current.format !== 1 || current.bootId !== bootId) throw new Error('current stopped-role state boot differs from immutable evidence');
  for (const [role, evidence] of Object.entries(stopped.roles)) {
    const observed = exact(current.roles[role],
      ['running', 'ready', 'pid', 'processStartTime', 'generation', 'bootId', 'rcLinks'],
      `current role-state ${role}`);
    if (observed.running !== false || observed.ready !== false || observed.pid !== null
        || observed.processStartTime !== null || observed.generation !== evidence.generation
        || observed.bootId !== bootId || !Array.isArray(observed.rcLinks)
        || observed.rcLinks.length !== ROLE_LINKS[role].length) {
      throw new Error(`current stopped-role state differs from immutable evidence: ${role}`);
    }
    observed.rcLinks.forEach((link, index) => {
      exact(link, ['path', 'state'], `current role-state link ${role}`);
      if (link.path !== ROLE_LINKS[role][index] || link.state !== 'absent') {
        throw new Error(`current stopped-role link differs from immutable evidence: ${link.path || role}`);
      }
    });
  }
}
function strictFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_error) { throw new Error(`${label} is required`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlink file`);
  if (stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must be mode 0600`);
  return { stat, raw: fs.readFileSync(file) };
}
function strictJson(file, label) {
  const found = strictFile(file, label);
  try { return { ...found, value: JSON.parse(found.raw) }; } catch (_error) { throw new Error(`${label} is invalid JSON`); }
}
function assertTestValidatorBoundary(file, provenancePath) {
  const boundary = path.join('/tmp', `osi-factory-zero-tests-${process.getuid()}`);
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test') throw new Error('factory provenance test validator is disabled');
  for (const [candidate, label] of [[file, 'validator'], [provenancePath, 'provenance']]) {
    const resolved = path.resolve(candidate);
    if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) throw new Error(`${label} is outside the fixed factory-zero test boundary`);
    let cursor = resolved;
    while (true) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`${label} has a symlink ancestor`);
      if (cursor === boundary) break;
      cursor = path.dirname(cursor);
    }
  }
  strictFile(file, 'factory provenance test validator');
}
function loadFactoryProvenanceValidator(provenancePath) {
  const productionCandidates = [
    path.join(__dirname, 'lib/factory-image-provenance.js'),
    path.join(__dirname, 'osi-factory-image-provenance.js'),
  ];
  // A0 commit 2 ships the provenance codec, while the audit-specific
  // validateFactoryImageProvenance contract is added by the sync slice.  Do
  // not mistake the generic codec for that narrower contract; select only a
  // resident module that actually exports the audited validator.
  let validatorPath = productionCandidates.find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    const loaded = require(candidate);
    return typeof loaded.validateFactoryImageProvenance === 'function';
  });
  const adapter = process.env.OSI_FACTORY_PROVENANCE_TEST_VALIDATOR;
  if (adapter) {
    if (validatorPath) throw new Error('test validator cannot override the production factory provenance validator');
    if (!path.isAbsolute(adapter)) throw new Error('factory provenance test validator path must be absolute');
    assertTestValidatorBoundary(adapter, provenancePath);
    validatorPath = adapter;
  }
  if (!validatorPath) throw new Error('shared format-2 factory provenance validator is unavailable');
  const loaded = require(validatorPath);
  exact(loaded, ['validateFactoryImageProvenance'], 'factory provenance validator module');
  if (typeof loaded.validateFactoryImageProvenance !== 'function') throw new Error('factory provenance validator contract is invalid');
  return loaded.validateFactoryImageProvenance;
}
function requireAbsent(target, label) {
  try { fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`${label} must be absent`);
}
function currentBootId() {
  const adapter = process.env.OSI_FACTORY_ZERO_TEST_BOOT_ID_FILE;
  if (!adapter) return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const boundary = path.join('/tmp', `osi-factory-zero-tests-${process.getuid()}`);
  const resolved = path.resolve(adapter);
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test'
      || (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`))) {
    throw new Error('factory boot adapter is outside the fixed test boundary');
  }
  return strictFile(resolved, 'factory boot adapter').raw.toString('utf8').trim();
}
function physicalLinkPath(canonicalPath) {
  const adapterRoot = process.env.OSI_FACTORY_ZERO_TEST_ROOT;
  if (!adapterRoot) return canonicalPath;
  const boundary = path.join('/tmp', `osi-factory-zero-tests-${process.getuid()}`);
  const root = path.resolve(adapterRoot);
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test'
      || (root !== boundary && !root.startsWith(`${boundary}${path.sep}`))) {
    throw new Error('factory filesystem adapter is outside the fixed test boundary');
  }
  return path.join(root, `.${canonicalPath}`);
}
function readCurrentRoleState() {
  let helper = PRODUCTION_ROLE_STATE_ADAPTER;
  let env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };
  if (process.env.OSI_FACTORY_ZERO_TEST_CURRENT_ROLE_STATE_HELPER) {
    const expected = path.join(__dirname, 'current-role-state.js');
    if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test'
        || path.resolve(process.env.OSI_FACTORY_ZERO_TEST_CURRENT_ROLE_STATE_HELPER) !== expected) {
      throw new Error('current role-state helper test adapter must be the production source dependency');
    }
    helper = expected;
    env = { ...process.env };
  }
  const result = cp.spawnSync(helper, ['--json'], {
    encoding: 'utf8', timeout: 5000, env,
  });
  if (result.status !== 0) throw new Error('fixed current role-state adapter is unavailable or failed');
  const raw = Buffer.from(result.stdout);
  let value;
  try { value = JSON.parse(raw); } catch (_error) { throw new Error('fixed current role-state adapter returned invalid JSON'); }
  return { raw, value };
}
function sqliteScalar(database, sql, label) {
  const result = cp.spawnSync(SQLITE3, ['-readonly', database, sql], {
    encoding: 'utf8', timeout: 30000, env: SAFE_PROCESS_ENV,
  });
  if (result.status !== 0) throw new Error(`unable to audit ${label}`);
  return result.stdout.trim();
}
function inspectTable(database, table) {
  const columns = sqliteScalar(database, `SELECT group_concat(name,'|') FROM (SELECT name FROM pragma_table_info('${table}') ORDER BY cid);`, `${table} schema`).split('|');
  if (columns.length !== TABLE_COLUMNS[table].length || columns.some((name, i) => name !== TABLE_COLUMNS[table][i])) {
    throw new Error(`${table} does not have the exact production schema`);
  }
  const value = sqliteScalar(database, `SELECT COUNT(*) FROM "${table}";`, table);
  if (!/^\d+$/.test(value)) throw new Error(`unable to audit ${table}`);
  return Number(value);
}
function fsyncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeExclusive(file, value) {
  deploymentState.publishImmutableBytes(file, Buffer.from(`${factorySeed.canonical(value)}\n`), {
    crashLabelPrefix: `factory-zero-report:${path.basename(file)}`,
  });
}

function factoryZero(v) {
  if (!/^[0-9a-f]{64}$/.test(v['expected-database-lineage-sha256'])) throw new Error('expected lineage hash must be lowercase sha256');
  const stateFile = strictJson(v['deployment-state'], 'deployment state');
  const state = stateFile.value;
  exact(state, ['format', 'parentDeployment', 'activeSubOperation'], 'deployment state');
  const parent = state.parentDeployment;
  if (state.format !== 2 || state.activeSubOperation !== null || !parent ||
      parent.deploymentId !== v['expected-baseline-id'] || parent.phase !== v['expected-phase'] ||
      parent.imageBaselinePrefix !== v['expected-baseline-prefix'] || parent.generation !== Number(v['expected-parent-generation'])) {
    throw new Error('factory baseline deployment-state mismatch');
  }
  if (v['expected-phase'] !== 'image-baseline-initializing' || v['expected-baseline-prefix'] !== 'baseline-completing') throw new Error('factory authority mismatch');
  exact(parent.factoryZeroAuthority, ['factoryProvenanceSha256', 'factorySeedReceiptSha256', 'databaseLineageSha256', 'databaseIdentitySha256', 'protocolRoots', 'bootId', 'stoppedRoleEvidence', 'linkGenerationEvidence'], 'factory zero authority');
  const authority = parent.factoryZeroAuthority;
  exact(authority.protocolRoots, ['root', 'witnessRoot', 'activityWitnessRoot', 'activityHeadWitnessRoot'], 'factory protocol roots');
  if (authority.protocolRoots.activityWitnessRoot !== v['activity-witness-root']) throw new Error('activity witness root is not state-bound');
  if (authority.protocolRoots.activityHeadWitnessRoot !== v['activity-head-witness-root']) throw new Error('activity-head witness root is not state-bound');
  for (const [name, root] of Object.entries(authority.protocolRoots)) requireAbsent(root, `factory protocol ${name}`);

  if (typeof authority.bootId !== 'string' || authority.bootId.length === 0) throw new Error('factory boot ID is invalid');
  if (authority.bootId !== currentBootId()) throw new Error('factory authority is not bound to the current boot');
  for (const field of ['stoppedRoleEvidence', 'linkGenerationEvidence']) {
    exact(authority[field], ['path', 'sha256'], `factory ${field}`);
    if (!path.isAbsolute(authority[field].path) || !/^[0-9a-f]{64}$/.test(authority[field].sha256)) throw new Error(`factory ${field} binding is invalid`);
  }
  const stoppedFile = strictJson(authority.stoppedRoleEvidence.path, 'stopped-role evidence');
  const linksFile = strictJson(authority.linkGenerationEvidence.path, 'link-generation evidence');
  if (sha(stoppedFile.raw) !== authority.stoppedRoleEvidence.sha256 || sha(linksFile.raw) !== authority.linkGenerationEvidence.sha256) throw new Error('factory stopped-role/link-generation evidence is not state-bound');
  exact(stoppedFile.value, ['format', 'bootId', 'roles'], 'stopped-role evidence');
  exact(stoppedFile.value.roles, ['osi-identityd', 'node-red', 'osi-bootstrap', 'osi-db-integrity'], 'stopped-role evidence roles');
  if (stoppedFile.value.format !== 1 || stoppedFile.value.bootId !== authority.bootId) throw new Error('stopped-role evidence boot mismatch');
  for (const [role, evidence] of Object.entries(stoppedFile.value.roles)) {
    exact(evidence, ['running', 'generation'], `stopped role ${role}`);
    if (evidence.running !== false || !Number.isSafeInteger(evidence.generation) || evidence.generation < 1) throw new Error(`role ${role} is not proven stopped at a generation`);
  }
  const currentRolesBefore = readCurrentRoleState();
  assertCurrentStoppedRoleState(currentRolesBefore.value, stoppedFile.value, authority.bootId);
  exact(linksFile.value, ['format', 'bootId', 'links'], 'link-generation evidence');
  if (linksFile.value.format !== 1 || linksFile.value.bootId !== authority.bootId || !Array.isArray(linksFile.value.links) || linksFile.value.links.length !== 6) throw new Error('link-generation evidence boot/shape mismatch');
  const expectedPaths = [
    '/etc/rc.d/K98osi-identityd', '/etc/rc.d/K99node-red', '/etc/rc.d/S90osi-db-integrity',
    '/etc/rc.d/S98osi-identityd', '/etc/rc.d/S99node-red', '/etc/rc.d/S99osi-bootstrap',
  ];
  const paths = [];
  for (const link of linksFile.value.links) {
    exact(link, ['path', 'generation', 'state'], 'link-generation entry');
    if (!path.isAbsolute(link.path) || link.state !== 'absent' || !Number.isSafeInteger(link.generation) || link.generation < 1) throw new Error('link-generation entry is invalid');
    paths.push(link.path);
    requireAbsent(physicalLinkPath(link.path), `stopped application link ${link.path}`);
  }
  if (paths.sort().join() !== expectedPaths.join()) throw new Error('link-generation evidence does not cover the exact canonical six links');

  const provenanceFile = strictJson(v['factory-provenance'], 'factory provenance');
  if (sha(provenanceFile.raw) !== authority.factoryProvenanceSha256) {
    throw new Error('factory provenance does not match state authority');
  }
  const validateProvenance = loadFactoryProvenanceValidator(v['factory-provenance']);
  const validatedProvenance = validateProvenance({ path: v['factory-provenance'], raw: provenanceFile.raw });
  exact(validatedProvenance, ['format', 'profile', 'factorySeedSha256', 'provenanceSha256'], 'format-2 provenance validator result');
  if (validatedProvenance.format !== 2 || !['bcm2712', 'bcm2709'].includes(validatedProvenance.profile) ||
      !/^[0-9a-f]{64}$/.test(validatedProvenance.factorySeedSha256) || validatedProvenance.provenanceSha256 !== authority.factoryProvenanceSha256) throw new Error('format-2 provenance validator result does not bind the authority');
  const seedReceipt = strictFile(v['factory-seed-receipt'], 'factory seed receipt');
  const lineageBefore = strictFile(v['database-lineage'], 'database lineage');
  if (sha(seedReceipt.raw) !== authority.factorySeedReceiptSha256) throw new Error('factory seed receipt does not match state authority');
  if (authority.databaseLineageSha256 !== v['expected-database-lineage-sha256']) throw new Error('database lineage is not state-bound');
  const verified = factorySeed.verifyFactoryDatabaseLineage(v['database-lineage'], {
    database: v.database,
    seedReceiptPath: v['factory-seed-receipt'],
    expectedSeedReceiptSha256: authority.factorySeedReceiptSha256,
    expectedSeedSha256: validatedProvenance.factorySeedSha256,
    expectedDatabaseLineageSha256: v['expected-database-lineage-sha256'],
    databaseLineageState: parent.databaseLineage,
  });
  const initialDatabase = strictFile(v.database, 'live database');
  const dbStat = initialDatabase.stat;
  if (factorySeed.hashObject({ device: dbStat.dev, inode: dbStat.ino }) !== authority.databaseIdentitySha256) throw new Error('live database identity does not match state authority');

  const counters = { appliedCommands: inspectTable(v.database, 'applied_commands'), commandAckOutbox: inspectTable(v.database, 'command_ack_outbox') };
  if (Object.values(counters).some((value) => value !== 0)) throw new Error('factory command state is not zero');
  const repeated = {
    state: strictFile(v['deployment-state'], 'deployment state'),
    stopped: strictFile(authority.stoppedRoleEvidence.path, 'stopped-role evidence'),
    links: strictFile(authority.linkGenerationEvidence.path, 'link-generation evidence'),
    provenance: strictFile(v['factory-provenance'], 'factory provenance'),
    seedReceipt: strictFile(v['factory-seed-receipt'], 'factory seed receipt'),
    lineage: strictFile(v['database-lineage'], 'database lineage'),
    database: strictFile(v.database, 'live database'),
    currentRoles: readCurrentRoleState(),
  };
  assertCurrentStoppedRoleState(repeated.currentRoles.value, stoppedFile.value, authority.bootId);
  const unstable = sha(repeated.state.raw) !== sha(stateFile.raw) || sha(repeated.stopped.raw) !== sha(stoppedFile.raw) ||
    sha(repeated.links.raw) !== sha(linksFile.raw) || sha(repeated.provenance.raw) !== sha(provenanceFile.raw) ||
    sha(repeated.seedReceipt.raw) !== sha(seedReceipt.raw) || sha(repeated.lineage.raw) !== sha(lineageBefore.raw) ||
    sha(repeated.database.raw) !== sha(initialDatabase.raw) ||
    repeated.database.stat.dev !== dbStat.dev || repeated.database.stat.ino !== dbStat.ino || repeated.database.stat.size !== dbStat.size ||
    sha(repeated.currentRoles.raw) !== sha(currentRolesBefore.raw);
  const repeatedCounters = { appliedCommands: inspectTable(v.database, 'applied_commands'), commandAckOutbox: inspectTable(v.database, 'command_ack_outbox') };
  // Absence and boot identity are external authority too. Re-check them in
  // the same stability pass as the immutable files and database; otherwise
  // a role link or protocol root can reappear after its first lstat and
  // still receive a factorySeedEligible report.
  for (const [name, root] of Object.entries(authority.protocolRoots)) {
    requireAbsent(root, `factory protocol ${name} on stability pass`);
  }
  for (const link of linksFile.value.links) {
    requireAbsent(physicalLinkPath(link.path), `stopped application link ${link.path} on stability pass`);
  }
  if (authority.bootId !== currentBootId()) throw new Error('factory boot ID changed between stable repeated reads');
  if (unstable || JSON.stringify(repeatedCounters) !== JSON.stringify(counters)) throw new Error('factory-zero evidence changed between stable repeated reads');
  const report = {
    format: 1,
    kind: 'FACTORY_ZERO_COMMAND_STATE_AUDIT',
    baselineId: parent.deploymentId,
    parentGeneration: parent.generation,
    databasePath: v.database,
    databaseIdentitySha256: authority.databaseIdentitySha256,
    protocolRoots: authority.protocolRoots,
    bootId: authority.bootId,
    stoppedRoleEvidenceSha256: authority.stoppedRoleEvidence.sha256,
    currentRoleStateSha256: sha(currentRolesBefore.raw),
    linkGenerationEvidenceSha256: authority.linkGenerationEvidence.sha256,
    factoryProvenanceSha256: authority.factoryProvenanceSha256,
    factorySeedReceiptSha256: authority.factorySeedReceiptSha256,
    databaseLineageSha256: verified.databaseLineageSha256,
    counters,
    factorySeedEligible: true,
    createdAt: new Date().toISOString(),
  };
  writeExclusive(v['report-out'], report);
  return { ok: true, factorySeedEligible: true, reportSha256: sha(fs.readFileSync(v['report-out'])) };
}

function dispatch(argv) {
  const parsed = parse(argv);
  if (parsed.verb === 'audit') { const error = new Error('ordinary audit belongs to the sync foundation slice'); error.code = 'NOT_IMPLEMENTED_IN_THIS_SLICE'; throw error; }
  return factoryZero(parsed.values);
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(dispatch(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`[audit-command-ack-state] ${error.code || 'error'}: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { SPECS, TABLE_COLUMNS, PRODUCTION_ROLE_STATE_ADAPTER, parse, dispatch };
