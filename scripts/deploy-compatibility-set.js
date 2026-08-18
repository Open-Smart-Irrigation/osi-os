#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const deploymentState = require('./lib/deployment-state');

const TOPOLOGY_PATHS = deploymentState.COMPATIBILITY_TOPOLOGY_PATHS;

const FORENSIC_PATHS = Object.freeze(['/etc/uci-defaults/94_osi_identityd_enable']);

const TARGET_SAFETY_PATHS = deploymentState.TARGET_SAFETY_PATHS;

const SIX_APPLICATION_LINKS = deploymentState.SIX_APPLICATION_LINKS;

// Legacy 94 is evidence only. It is captured in topology but restore never
// writes it, because the same live path belongs to the non-rollback safety set.
const RESTORABLE_PATHS = Object.freeze(TOPOLOGY_PATHS.filter((item) => !TARGET_SAFETY_PATHS.includes(item) && item !== '/data/osi-deploy/guard-installed.json'));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function shaBytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function shaObject(value) { return shaBytes(Buffer.from(canonical(value))); }
function assertHash(value, label) { if (!/^[0-9a-f]{64}$/.test(value || '')) throw new Error(`${label} must be lowercase sha256`); }
function rooted(root, absolute) {
  if (!path.isAbsolute(root) || !path.isAbsolute(absolute)) throw new Error('root and inventory path must be absolute');
  const base = path.resolve(root);
  const resolved = path.resolve(base, `.${absolute}`);
  if (base === '/') {
    if (!resolved.startsWith('/')) throw new Error('path escapes root');
  } else if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('path escapes root');
  }
  const rootStat = fs.lstatSync(base);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('root must be a real directory');
  const rootReal = fs.realpathSync(base);
  const relative = path.relative(base, resolved);
  const parts = relative === '' ? [] : relative.split(path.sep);
  let cursor = base;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stat = lstatOrNull(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`intermediate symlink ancestor rejected: ${cursor}`);
    if (!stat.isDirectory()) throw new Error(`intermediate path component is not a directory: ${cursor}`);
    const real = fs.realpathSync(cursor);
    if (rootReal !== '/' && real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`realpath confinement failed: ${cursor}`);
    }
  }
  return resolved;
}
function fsyncDirectory(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function requireDirectory(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`${label} must be mode 0700`);
  return stat;
}
function writeExclusive(file, object, mode = 0o600, { allowExactExisting = false, crashLabelPrefix } = {}) {
  const bytes = Buffer.from(`${canonical(object)}\n`);
  const result = deploymentState.publishImmutableBytes(file, bytes, {
    mode, allowExactExisting, crashLabelPrefix,
  });
  return result.rawSha256;
}
function lstatOrNull(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function maybeCrash(label) {
  const boundary = path.join('/tmp', `osi-compat-tests-${process.getuid()}`);
  if (process.env.OSI_REPAIR_PROGRAM_MODE === '1'
      && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
      && process.env.OSI_COMPAT_TEST_BOUNDARY === boundary
      && process.env.OSI_COMPAT_CRASH_AT === label) process.exit(137);
}

function collectedInventory(root) {
  return deploymentState.collectTopologyPathSet(root, [...TOPOLOGY_PATHS, ...FORENSIC_PATHS]);
}

function verifyCapturedTopology(root, entries) {
  const expected = entries.map(withoutCopy);
  const current = collectedInventory(root);
  if (canonical(current) !== canonical(expected)) {
    throw new Error('snapshot topology changed before manifest publication');
  }
}

function capture(root, backupDir, copyFile = fs.copyFileSync) {
  const deduped = collectedInventory(root);
  let index = 0;
  const copyRoot = path.join(backupDir, 'topology-files');
  const created = [];
  let createdRoot = false;
  try {
    for (const entry of deduped) {
      if (entry.type !== 'file') continue;
      if (index === 0) {
        if (!lstatOrNull(copyRoot)) { fs.mkdirSync(copyRoot, { mode: 0o700 }); createdRoot = true; }
        requireDirectory(copyRoot, 'topology copy directory');
      }
      entry.copyPath = `topology-files/${String(++index).padStart(6, '0')}`;
      const destination = path.join(backupDir, entry.copyPath);
      const source = rooted(root, entry.path);
      const sourceBefore = fs.lstatSync(source);
      const sourceHashBefore = shaBytes(fs.readFileSync(source));
      if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink() || sourceBefore.size !== entry.sizeBytes
          || sourceHashBefore !== entry.sha256) throw new Error(`snapshot source changed before copy: ${entry.path}`);
      if (!lstatOrNull(destination)) {
        copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        created.push(destination);
        fs.chmodSync(destination, 0o600);
      }
      const copied = fs.lstatSync(destination);
      if (!copied.isFile() || copied.isSymbolicLink() || copied.uid !== process.getuid()
          || (copied.mode & 0o777) !== 0o600 || copied.size !== entry.sizeBytes
          || shaBytes(fs.readFileSync(destination)) !== entry.sha256) {
        throw new Error(`copied snapshot collision or drift: ${entry.path}`);
      }
      const sourceAfter = fs.lstatSync(source);
      if (!sourceAfter.isFile() || sourceAfter.isSymbolicLink()
          || sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino
          || sourceAfter.size !== sourceBefore.size || (sourceAfter.mode & 0o7777) !== (sourceBefore.mode & 0o7777)
          || sourceAfter.uid !== sourceBefore.uid || sourceAfter.gid !== sourceBefore.gid
          || shaBytes(fs.readFileSync(source)) !== sourceHashBefore) throw new Error(`snapshot source changed during copy: ${entry.path}`);
      const fd = fs.openSync(destination, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fsyncDirectory(copyRoot);
      maybeCrash('after-snapshot-copy');
    }
    verifyCapturedTopology(root, deduped);
  } catch (error) {
    for (const destination of created.reverse()) {
      try { fs.unlinkSync(destination); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
    if (createdRoot && lstatOrNull(copyRoot)) fs.rmdirSync(copyRoot);
    fsyncDirectory(backupDir);
    throw error;
  }
  return deduped;
}

function verifyCopies(backupDir, manifest) {
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    const copy = path.resolve(backupDir, entry.copyPath);
    if (!copy.startsWith(`${path.resolve(backupDir)}${path.sep}`)) throw new Error('copy path escapes backup');
    const stat = fs.lstatSync(copy);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.sizeBytes
        || shaBytes(fs.readFileSync(copy)) !== entry.sha256) throw new Error(`copied snapshot drift: ${entry.path}`);
  }
}
function readManifest(file, expectedSha) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error(`manifest is not a root-owned mode-0600 regular file: ${file}`);
  const bytes = fs.readFileSync(file);
  if (shaBytes(bytes) !== expectedSha) throw new Error(`manifest sha mismatch: ${file}`);
  return JSON.parse(bytes);
}
function readOwnedJson(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error(`${label} must be an owned mode-0600 regular file`);
  const raw = fs.readFileSync(file);
  return { raw, sha256: shaBytes(raw), value: JSON.parse(raw) };
}
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} has an invalid shape`);
}
function compatibilityPathSetSha256() {
  return shaObject({ topologyPaths: TOPOLOGY_PATHS, forensicPaths: FORENSIC_PATHS, targetSafetyPaths: TARGET_SAFETY_PATHS, restorablePaths: RESTORABLE_PATHS });
}
function readSnapshotAuthority(root, backupDir, deploymentId, profileIdentitySha256, targetManifestSha256) {
  const authorityFile = readOwnedJson(`${backupDir}.snapshot-authority.json`, 'compatibility snapshot authority');
  const authority = authorityFile.value;
  exact(authority, ['format', 'deploymentId', 'bootId', 'stoppedRoleGenerations', 'pathSetSha256', 'profileMappingSha256', 'approvedAttemptBackupRoot', 'guardGenerationPath', 'guardGenerationSha256', 'targetManifestPath', 'targetManifestSha256'], 'compatibility snapshot authority');
  exact(authority.stoppedRoleGenerations, ['osi-identityd', 'node-red', 'osi-bootstrap', 'osi-db-integrity'], 'stopped role generations');
  if (authority.format !== 1 || authority.deploymentId !== deploymentId || authority.profileMappingSha256 !== profileIdentitySha256 ||
      authority.targetManifestSha256 !== targetManifestSha256 || authority.pathSetSha256 !== compatibilityPathSetSha256() || authority.approvedAttemptBackupRoot !== backupDir) throw new Error('compatibility snapshot authority binding mismatch');
  for (const generation of Object.values(authority.stoppedRoleGenerations)) if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('stopped role generation is invalid');
  const bootId = fs.readFileSync(rooted(root, '/proc/sys/kernel/random/boot_id'), 'utf8').trim();
  if (!bootId || bootId !== authority.bootId) throw new Error('compatibility snapshot boot ID mismatch');
  const targetFile = readOwnedJson(authority.targetManifestPath, 'immutable target manifest');
  if (targetFile.sha256 !== authority.targetManifestSha256) throw new Error('immutable target manifest bytes changed');
  const target = targetFile.value;
  exact(target, ['format', 'deploymentId', 'entries'], 'immutable target manifest');
  if (target.format !== 1 || target.deploymentId !== deploymentId || !Array.isArray(target.entries)) throw new Error('immutable target manifest binding mismatch');
  const guardFile = readOwnedJson(authority.guardGenerationPath, 'immutable guard generation');
  if (guardFile.sha256 !== authority.guardGenerationSha256) throw new Error('immutable guard generation bytes changed');
  const guard = guardFile.value;
  exact(guard, ['format', 'deploymentId', 'generation', 'phase', 'targetManifestSha256', 'mutatedPaths'], 'immutable guard generation');
  if (guard.format !== 1 || guard.deploymentId !== deploymentId || !Number.isSafeInteger(guard.generation) || guard.generation < 1 ||
      guard.phase !== 'controls-installed' || guard.targetManifestSha256 !== authority.targetManifestSha256 || !Array.isArray(guard.mutatedPaths)) throw new Error('immutable guard generation binding mismatch');
  const targetPaths = target.entries.map((entry) => entry.path).sort();
  if (new Set(targetPaths).size !== targetPaths.length || canonical(targetPaths) !== canonical([...guard.mutatedPaths].sort())) throw new Error('guard generation and target manifest path sets differ');
  for (const entry of target.entries) if (!entry || !isTopologyPath(entry.path) || Object.hasOwn(entry, 'copyPath')) throw new Error('target manifest contains a non-topology identity');
  return { authority, authoritySha256: authorityFile.sha256, target, guard };
}
function isTopologyPath(candidate) { return TOPOLOGY_PATHS.some((base) => candidate === base || candidate.startsWith(`${base}/`)); }
function comparableEntries(root) { return deploymentState.collectTopologyPathSet(root, TOPOLOGY_PATHS); }
function collectPathSet(root, paths) { return deploymentState.collectTopologyPathSet(root, paths); }
function uciIdentitySha256(root) {
  return deploymentState.topologyUciIdentitySha256(root);
}
function withoutCopy(entry) { const result = { ...entry }; delete result.copyPath; return result; }
function isWithinRoots(candidate, roots) {
  return roots.some((base) => candidate === base || candidate.startsWith(`${base}/`));
}
function verifyRestorablePathsRestored(root, manifest) {
  const live = comparableEntries(root).filter((entry) => isWithinRoots(entry.path, RESTORABLE_PATHS));
  const expected = manifest.entries.filter((entry) => isWithinRoots(entry.path, RESTORABLE_PATHS)).map(withoutCopy);
  if (canonical(live) !== canonical(expected)) throw new Error('restorable topology does not match the predecessor snapshot');
}
function entryIdentity(entry) { return shaObject(withoutCopy(entry)); }
function verifyLiveAgainstJournal(root, manifest, journal, immutable) {
  if (!journal || journal.format !== 1 || journal.deploymentId !== manifest.deploymentId || journal.topologyManifestSha256 !== shaBytes(fs.readFileSync(path.join(path.dirname(journal.__path), 'topology-manifest.json'))) || journal.guardGenerationSha256 !== immutable.authority.guardGenerationSha256 || !Array.isArray(journal.mutations)) throw new Error('mutation journal identity mismatch');
  const mutations = new Map();
  for (const mutation of journal.mutations) {
    if (!mutation || Object.keys(mutation).sort().join() !== ['beforeIdentitySha256', 'path'].sort().join()) throw new Error('invalid mutation journal entry');
    if (mutations.has(mutation.path)) throw new Error('duplicate mutation journal path');
    assertHash(mutation.beforeIdentitySha256, 'beforeIdentitySha256');
    if (!isTopologyPath(mutation.path)) throw new Error('mutation journal may name only application-topology paths');
    const before = manifest.entries.find((entry) => entry.path === mutation.path);
    if (!before || entryIdentity(before) !== mutation.beforeIdentitySha256) throw new Error('mutation journal does not bind snapshot identity');
    const after = immutable.target.entries.find((entry) => entry.path === mutation.path);
    if (!after) throw new Error('mutation path has no immutable target identity');
    mutations.set(mutation.path, after);
  }
  if (canonical([...mutations.keys()].sort()) !== canonical(immutable.target.entries.map((entry) => entry.path).sort())) throw new Error('mutation journal does not cover the immutable target path set');
  const live = comparableEntries(root);
  const expected = new Map(manifest.entries.filter((entry) => isTopologyPath(entry.path)).map((entry) => [entry.path, withoutCopy(entry)]));
  for (const [p, after] of mutations) expected.set(p, after);
  const liveMap = new Map(live.map((entry) => [entry.path, entry]));
  if (canonical([...liveMap.entries()].sort()) !== canonical([...expected.entries()].sort())) throw new Error('live topology drift is not journalled to exact target identity');
}
function verifyPreservedAuthorities(root, manifest, journal, immutable) {
  const preservedRoots = TOPOLOGY_PATHS.filter((item) => !RESTORABLE_PATHS.includes(item));
  const expected = new Map(manifest.entries
    .filter((entry) => isWithinRoots(entry.path, preservedRoots))
    .map((entry) => [entry.path, withoutCopy(entry)]));
  for (const mutation of journal.mutations) {
    if (!isWithinRoots(mutation.path, preservedRoots)) continue;
    const target = immutable.target.entries.find((entry) => entry.path === mutation.path);
    if (!target) throw new Error(`preserved authority has no immutable target receipt: ${mutation.path}`);
    expected.set(mutation.path, target);
  }
  const live = collectPathSet(root, preservedRoots);
  if (canonical(live) !== canonical([...expected.values()].sort((a, b) => a.path.localeCompare(b.path)))) {
    throw new Error('preserved guard authority drift from immutable receipt');
  }
}
function removePathDurable(file) {
  const stat = lstatOrNull(file); if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(file, { recursive: true }); else fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}
function applyMetadata(file, entry) {
  if (entry.type === 'symlink') {
    if (!fs.lchownSync) throw new Error('lchown is required for exact symlink ownership');
    fs.lchownSync(file, entry.uid, entry.gid);
  } else {
    fs.chownSync(file, entry.uid, entry.gid);
    fs.chmodSync(file, entry.mode);
  }
}
let restoreMutationCount = 0;
function afterRestoreMutation(label) {
  restoreMutationCount += 1;
  const crashAt = Number(process.env.OSI_COMPAT_CRASH_AFTER_MUTATIONS || 0);
  if (crashAt === restoreMutationCount) {
    const boundary = path.join('/tmp', `osi-compat-tests-${process.getuid()}`);
    if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test'
        || process.env.OSI_COMPAT_TEST_BOUNDARY !== boundary) throw new Error('compatibility crash adapter is outside the fixed test boundary');
    process.stderr.write(`[deploy-compatibility-set] injected crash after ${label}\n`); process.exit(137);
  }
}
function restore(root, backupDir, manifest) {
  verifyCopies(backupDir, manifest);
  const allowed = new Set();
  for (const rootPath of RESTORABLE_PATHS) for (const entry of manifest.entries) if (entry.path === rootPath || entry.path.startsWith(`${rootPath}/`)) allowed.add(entry.path);
  const expected = new Map(manifest.entries.filter((entry) => allowed.has(entry.path)).map((entry) => [entry.path, entry]));
  const live = comparableEntries(root).filter((entry) => RESTORABLE_PATHS.some((base) => entry.path === base || entry.path.startsWith(`${base}/`)));
  for (const entry of live.sort((a, b) => b.path.length - a.path.length)) {
    if (!expected.has(entry.path)) { removePathDurable(rooted(root, entry.path)); afterRestoreMutation(`remove:${entry.path}`); }
  }
  for (const entry of manifest.entries.filter((item) => allowed.has(item.path) && item.type === 'directory').sort((a, b) => a.path.length - b.path.length)) {
    const livePath = rooted(root, entry.path); const stat = lstatOrNull(livePath);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) removePathDurable(livePath);
    fs.mkdirSync(livePath, { recursive: true, mode: entry.mode }); rooted(root, entry.path); applyMetadata(livePath, entry); fsyncDirectory(livePath); fsyncDirectory(path.dirname(livePath)); afterRestoreMutation(`directory:${entry.path}`);
  }
  for (const entry of manifest.entries.filter((item) => allowed.has(item.path) && item.type !== 'directory' && item.type !== 'absent')) {
    const livePath = rooted(root, entry.path); fs.mkdirSync(path.dirname(livePath), { recursive: true, mode: 0o700 }); rooted(root, entry.path);
    const temporary = path.join(path.dirname(livePath), `.${path.basename(livePath)}.restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    if (entry.type === 'file') {
      fs.copyFileSync(path.join(backupDir, entry.copyPath), temporary, fs.constants.COPYFILE_EXCL); applyMetadata(temporary, entry);
      const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else { fs.symlinkSync(entry.target, temporary); applyMetadata(temporary, entry); }
    const current = lstatOrNull(livePath); if (current && current.isDirectory() && !current.isSymbolicLink()) removePathDurable(livePath);
    rooted(root, entry.path); fs.renameSync(temporary, livePath); fsyncDirectory(path.dirname(livePath)); afterRestoreMutation(`publish:${entry.path}`);
  }
  for (const entry of manifest.entries.filter((item) => allowed.has(item.path) && item.type === 'absent')) { removePathDurable(rooted(root, entry.path)); afterRestoreMutation(`absent:${entry.path}`); }
  verifyRestorablePathsRestored(root, manifest);
}

function liveTopologyIdentity(root) {
  return deploymentState.liveTopologyIdentity(root);
}

function topologyRestorationProof(root, backupDir, manifest, compatibilityManifestSha256, restoredPredecessor) {
  deploymentState.validateRestoredPredecessor(restoredPredecessor);
  const uciReview = manifest.uciIdentityComparisonSha256 === null
    ? {
      previousUciIdentitySha256: manifest.previousUciIdentitySha256,
      healedUciIdentitySha256: manifest.healedUciIdentitySha256,
      decision: 'unchanged', comparisonPath: null, comparisonSha256: null,
    }
    : {
      previousUciIdentitySha256: manifest.previousUciIdentitySha256,
      healedUciIdentitySha256: manifest.healedUciIdentitySha256,
      decision: 'preserve-healed', comparisonPath: path.join(backupDir, 'uci-identity-comparison.json'),
      comparisonSha256: manifest.uciIdentityComparisonSha256,
    };
  return {
    format: 1,
    kind: 'TRAIN_A_TOPOLOGY_RESTORATION_PROOF',
    deploymentId: manifest.deploymentId,
    liveRootPath: path.resolve(root),
    compatibilityManifestSha256,
    topologyManifestSha256: manifest.topologyManifestSha256,
    targetSafetyManifestPath: path.join(backupDir, 'target-safety-manifest.json'),
    targetSafetyManifestSha256: manifest.targetSafetyManifestSha256,
    guardGenerationSha256: manifest.guardGenerationSha256,
    ...liveTopologyIdentity(root),
    uciReview,
    restoredPredecessor,
    restoredPredecessorSha256: deploymentState.restoredPredecessorSha256(restoredPredecessor),
  };
}

function publishTopologyRestorationProof(root, backupDir, manifest, compatibilityManifestSha256, restoredPredecessor) {
  const proof = topologyRestorationProof(root, backupDir, manifest, compatibilityManifestSha256, restoredPredecessor);
  const proofPath = path.join(backupDir, 'topology-restoration-proof.json');
  const proofSha256 = writeExclusive(proofPath, proof, 0o600, {
    allowExactExisting: true,
    crashLabelPrefix: 'topology-restoration-proof',
  });
  return { proofPath, proofSha256, proof };
}

const SPECS = {
  'snapshot-topology': ['root', 'backup-dir', 'target-commit', 'deployment-id', 'target-manifest-sha256', 'artifact-sha256', 'profile-identity-sha256'],
  'verify-topology': ['root', 'backup-dir', 'topology-manifest-sha256', 'deployment-id'],
  finalize: ['root', 'backup-dir', 'topology-manifest-sha256', 'target-commit', 'deployment-id', 'target-manifest-sha256', 'target-safety-manifest-sha256', 'runtime-dependency-manifest-sha256'],
  verify: ['root', 'backup-dir', 'manifest-sha256', 'target-commit', 'deployment-id', 'target-manifest-sha256', 'runtime-dependency-manifest-sha256'],
  restore: ['root', 'backup-dir', 'manifest-sha256', 'target-commit', 'deployment-id', 'target-manifest-sha256', 'runtime-dependency-manifest-sha256', 'restored-predecessor-path', 'restored-predecessor-sha256'],
  'restore-topology': ['root', 'backup-dir', 'topology-manifest-sha256', 'deployment-id'],
};
function parse(argv) {
  const verb = argv[0]; const required = SPECS[verb]; if (!required) throw new Error('unknown verb');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index]; const value = argv[index + 1];
    if (!token || !token.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('invalid argv pair');
    const key = token.slice(2); if (!required.includes(key)) throw new Error(`unknown flag: ${token}`); if (Object.hasOwn(values, key)) throw new Error(`duplicate flag: ${token}`); values[key] = value;
  }
  for (const key of required) if (!values[key]) throw new Error(`missing --${key}`);
  for (const key of required.filter((item) => item.includes('sha256'))) assertHash(values[key], key);
  if (!path.isAbsolute(values.root) || !path.isAbsolute(values['backup-dir'])
      || (values['restored-predecessor-path'] && !path.isAbsolute(values['restored-predecessor-path']))) {
    throw new Error('root, backup-dir, and restored-predecessor-path must be absolute');
  }
  return { verb, values };
}
function readRestoredPredecessor(file, expectedSha256, compatibilityManifestSha256) {
  const loaded = readOwnedJson(file, 'restored predecessor identity');
  deploymentState.validateRestoredPredecessor(loaded.value);
  const canonicalSha256 = deploymentState.restoredPredecessorSha256(loaded.value);
  if (canonicalSha256 !== expectedSha256) throw new Error('restored predecessor canonical hash mismatch');
  if (loaded.value.kind === 'legacy-compatibility'
      && loaded.value.compatibilityManifestSha256 !== compatibilityManifestSha256) {
    throw new Error('legacy restored predecessor does not bind this compatibility manifest');
  }
  return loaded.value;
}
function topology(backupDir, expectedSha, deploymentId) { const manifest = readManifest(path.join(backupDir, 'topology-manifest.json'), expectedSha); if (manifest.deploymentId !== deploymentId) throw new Error('deployment id mismatch'); verifyCopies(backupDir, manifest); return manifest; }
function readMutationJournal(backupDir, topologyManifestSha256, deploymentId, guardGenerationSha256) {
  const file = path.join(backupDir, 'mutation-journal.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('mutation journal must be an owned mode-0600 regular file');
  const raw = fs.readFileSync(file); const journal = JSON.parse(raw);
  if (!journal || Object.keys(journal).sort().join() !== ['deploymentId', 'format', 'mutations', 'topologyManifestSha256', 'guardGenerationSha256'].sort().join()) throw new Error('mutation journal has an invalid shape');
  journal.__path = file;
  if (journal.format !== 1 || journal.deploymentId !== deploymentId || journal.topologyManifestSha256 !== topologyManifestSha256 || journal.guardGenerationSha256 !== guardGenerationSha256) throw new Error('mutation journal binding mismatch');
  return { journal, sha256: shaBytes(raw) };
}
function verifyTargetSafety(root, backupDir, expectedSha, deploymentId, guardGenerationSha256) {
  return deploymentState.readAndVerifyTargetSafetyManifest({
    manifestPath: path.join(backupDir, 'target-safety-manifest.json'),
    expectedSha256: expectedSha,
    deploymentId,
    guardGenerationSha256,
    liveRootPath: root,
  });
}
function compatibility(values) {
  const manifest = readManifest(path.join(values['backup-dir'], 'manifest.json'), values['manifest-sha256']);
  for (const key of ['target-commit', 'deployment-id', 'target-manifest-sha256', 'runtime-dependency-manifest-sha256']) if (manifest[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] !== values[key]) throw new Error(`${key} mismatch`);
  const immutable = readSnapshotAuthority(values.root, values['backup-dir'], values['deployment-id'], manifest.profileIdentitySha256, values['target-manifest-sha256']);
  if (immutable.authoritySha256 !== manifest.snapshotAuthoritySha256 || immutable.authority.guardGenerationSha256 !== manifest.guardGenerationSha256) throw new Error('immutable compatibility authority changed after finalize');
  const topo = topology(values['backup-dir'], manifest.topologyManifestSha256, values['deployment-id']);
  const mutation = readMutationJournal(values['backup-dir'], manifest.topologyManifestSha256, values['deployment-id'], immutable.authority.guardGenerationSha256);
  if (mutation.sha256 !== manifest.mutationJournalSha256) throw new Error('mutation journal changed after finalize');
  verifyTargetSafety(values.root, values['backup-dir'], manifest.targetSafetyManifestSha256,
    values['deployment-id'], manifest.guardGenerationSha256);
  verifyPreservedAuthorities(values.root, topo, mutation.journal, immutable);
  if (manifest.uciIdentityComparisonSha256 === null) {
    if (manifest.previousUciIdentitySha256 !== manifest.healedUciIdentitySha256) throw new Error('missing UCI comparison for a changed healed identity');
  } else {
    assertHash(manifest.uciIdentityComparisonSha256, 'uciIdentityComparisonSha256');
    const comparison = readOwnedJson(path.join(values['backup-dir'], 'uci-identity-comparison.json'), 'UCI identity comparison');
    exact(comparison.value, ['format', 'deploymentId', 'previousUciIdentitySha256', 'healedUciIdentitySha256', 'decision'], 'UCI identity comparison');
    if (comparison.sha256 !== manifest.uciIdentityComparisonSha256 || comparison.value.format !== 1 || comparison.value.deploymentId !== values['deployment-id'] ||
        comparison.value.previousUciIdentitySha256 !== manifest.previousUciIdentitySha256 || comparison.value.healedUciIdentitySha256 !== manifest.healedUciIdentitySha256 || comparison.value.decision !== 'preserve-healed') throw new Error('UCI healed identity comparison changed after finalize');
  }
  if (uciIdentitySha256(values.root) !== manifest.healedUciIdentitySha256) throw new Error('current UCI identity differs from the healed compatibility identity');
  return { manifest, topo, mutation, immutable };
}
function completedTopologySnapshot(root, backupDir, values, immutable) {
  const file = readOwnedJson(path.join(backupDir, 'topology-manifest.json'), 'topology snapshot manifest');
  const manifestIntent = readOwnedJson(path.join(backupDir, 'topology-manifest-intent.json'), 'topology manifest intent');
  exact(manifestIntent.value, ['format', 'kind', 'deploymentId', 'manifestSha256'], 'topology manifest intent');
  if (manifestIntent.value.format !== 1 || manifestIntent.value.kind !== 'TRAIN_A_TOPOLOGY_MANIFEST_INTENT'
      || manifestIntent.value.deploymentId !== values['deployment-id']
      || manifestIntent.value.manifestSha256 !== file.sha256) throw new Error('topology manifest intent/hash mismatch');
  const manifest = file.value;
  exact(manifest, ['format', 'kind', 'deploymentId', 'targetCommit', 'targetManifestSha256', 'artifactSha256',
    'profileIdentitySha256', 'uciIdentitySha256', 'bootId', 'stoppedRoleGenerations', 'pathSetSha256',
    'snapshotAuthoritySha256', 'guardGenerationSha256', 'entries'], 'topology snapshot manifest');
  if (manifest.format !== 1 || manifest.kind !== 'TRAIN_A_TOPOLOGY_SNAPSHOT'
      || manifest.deploymentId !== values['deployment-id'] || manifest.targetCommit !== values['target-commit']
      || manifest.targetManifestSha256 !== values['target-manifest-sha256']
      || manifest.artifactSha256 !== values['artifact-sha256']
      || manifest.profileIdentitySha256 !== values['profile-identity-sha256']
      || manifest.bootId !== immutable.authority.bootId
      || canonical(manifest.stoppedRoleGenerations) !== canonical(immutable.authority.stoppedRoleGenerations)
      || manifest.pathSetSha256 !== immutable.authority.pathSetSha256
      || manifest.snapshotAuthoritySha256 !== immutable.authoritySha256
      || manifest.guardGenerationSha256 !== immutable.authority.guardGenerationSha256
      || !Array.isArray(manifest.entries)) throw new Error('completed topology snapshot binding mismatch');
  assertHash(manifest.uciIdentitySha256, 'topology snapshot UCI identity');
  verifyCopies(backupDir, manifest);
  return { manifest, sha256: file.sha256 };
}
function completedCompatibilityManifest(root, backupDir, values) {
  const file = readOwnedJson(path.join(backupDir, 'manifest.json'), 'compatibility manifest');
  const manifestIntent = readOwnedJson(path.join(backupDir, 'compatibility-manifest-intent.json'), 'compatibility manifest intent');
  exact(manifestIntent.value, ['format', 'kind', 'deploymentId', 'manifestSha256'], 'compatibility manifest intent');
  if (manifestIntent.value.format !== 1 || manifestIntent.value.kind !== 'TRAIN_A_COMPATIBILITY_MANIFEST_INTENT'
      || manifestIntent.value.deploymentId !== values['deployment-id']
      || manifestIntent.value.manifestSha256 !== file.sha256) throw new Error('compatibility manifest intent/hash mismatch');
  const manifest = file.value;
  exact(manifest, ['format', 'kind', 'topologyManifestSha256', 'mutationJournalSha256',
    'snapshotAuthoritySha256', 'guardGenerationSha256', 'profileIdentitySha256', 'targetCommit',
    'deploymentId', 'targetManifestSha256', 'targetSafetyManifestSha256', 'runtimeDependencyManifestSha256',
    'previousUciIdentitySha256', 'healedUciIdentitySha256', 'uciIdentityComparisonSha256'], 'compatibility manifest');
  if (manifest.format !== 1 || manifest.kind !== 'TRAIN_A_COMPATIBILITY_SET'
      || manifest.topologyManifestSha256 !== values['topology-manifest-sha256']
      || manifest.targetCommit !== values['target-commit'] || manifest.deploymentId !== values['deployment-id']
      || manifest.targetManifestSha256 !== values['target-manifest-sha256']
      || manifest.targetSafetyManifestSha256 !== values['target-safety-manifest-sha256']
      || manifest.runtimeDependencyManifestSha256 !== values['runtime-dependency-manifest-sha256']) {
    throw new Error('completed compatibility manifest binding mismatch');
  }
  for (const key of ['topologyManifestSha256', 'mutationJournalSha256', 'snapshotAuthoritySha256',
    'guardGenerationSha256', 'profileIdentitySha256', 'targetManifestSha256', 'targetSafetyManifestSha256',
    'runtimeDependencyManifestSha256', 'previousUciIdentitySha256', 'healedUciIdentitySha256']) assertHash(manifest[key], key);
  const topo = topology(backupDir, manifest.topologyManifestSha256, values['deployment-id']);
  const immutable = readSnapshotAuthority(root, backupDir, values['deployment-id'], manifest.profileIdentitySha256,
    values['target-manifest-sha256']);
  if (immutable.authoritySha256 !== manifest.snapshotAuthoritySha256
      || immutable.authority.guardGenerationSha256 !== manifest.guardGenerationSha256
      || topo.snapshotAuthoritySha256 !== manifest.snapshotAuthoritySha256) throw new Error('completed compatibility authority mismatch');
  const mutation = readMutationJournal(backupDir, manifest.topologyManifestSha256, values['deployment-id'],
    immutable.authority.guardGenerationSha256);
  if (mutation.sha256 !== manifest.mutationJournalSha256) throw new Error('completed compatibility mutation journal mismatch');
  verifyTargetSafety(root, backupDir, manifest.targetSafetyManifestSha256,
    values['deployment-id'], manifest.guardGenerationSha256);
  if (manifest.uciIdentityComparisonSha256 !== null) {
    assertHash(manifest.uciIdentityComparisonSha256, 'uciIdentityComparisonSha256');
    const comparison = readOwnedJson(path.join(backupDir, 'uci-identity-comparison.json'), 'UCI identity comparison');
    if (comparison.sha256 !== manifest.uciIdentityComparisonSha256) throw new Error('UCI identity comparison hash mismatch');
  } else if (manifest.previousUciIdentitySha256 !== manifest.healedUciIdentitySha256) {
    throw new Error('missing UCI comparison for a changed healed identity');
  }
  return { manifest, sha256: file.sha256 };
}
function dispatch(argv) {
  const { verb, values: v } = parse(argv); const backup = v['backup-dir'];
  if (verb === 'snapshot-topology') {
    const immutable = readSnapshotAuthority(v.root, backup, v['deployment-id'], v['profile-identity-sha256'], v['target-manifest-sha256']);
    const snapshotIntentPath = `${backup}.snapshot-intent.json`;
    const snapshotIntent = { format: 1, kind: 'TRAIN_A_TOPOLOGY_SNAPSHOT_INTENT', root: v.root,
      backupDir: backup, targetCommit: v['target-commit'], deploymentId: v['deployment-id'],
      targetManifestSha256: v['target-manifest-sha256'], artifactSha256: v['artifact-sha256'],
      profileIdentitySha256: v['profile-identity-sha256'], pathSetSha256: compatibilityPathSetSha256(),
      snapshotAuthoritySha256: immutable.authoritySha256 };
    if (lstatOrNull(backup) && !lstatOrNull(snapshotIntentPath)) throw new Error('backup directory exists without its immutable snapshot intent');
    writeExclusive(snapshotIntentPath, snapshotIntent, 0o600, { allowExactExisting: true,
      crashLabelPrefix: 'compatibility-snapshot-intent' });
    if (!lstatOrNull(backup)) fs.mkdirSync(backup, { mode: 0o700 });
    fs.chmodSync(backup, 0o700); requireDirectory(backup, 'backup directory'); fsyncDirectory(path.dirname(backup));
    maybeCrash('after-backup-mkdir');
    if (lstatOrNull(path.join(backup, 'topology-manifest.json'))) {
      const completed = completedTopologySnapshot(v.root, backup, v, immutable);
      return { ok: true, topologyManifestSha256: completed.sha256 };
    }
    const entries = capture(v.root, backup);
    verifyCapturedTopology(v.root, entries);
    const manifest = { format: 1, kind: 'TRAIN_A_TOPOLOGY_SNAPSHOT', deploymentId: v['deployment-id'], targetCommit: v['target-commit'], targetManifestSha256: v['target-manifest-sha256'], artifactSha256: v['artifact-sha256'], profileIdentitySha256: v['profile-identity-sha256'], uciIdentitySha256: uciIdentitySha256(v.root), bootId: immutable.authority.bootId, stoppedRoleGenerations: immutable.authority.stoppedRoleGenerations, pathSetSha256: immutable.authority.pathSetSha256, snapshotAuthoritySha256: immutable.authoritySha256, guardGenerationSha256: immutable.authority.guardGenerationSha256, entries };
    const topologyManifestSha256 = shaBytes(Buffer.from(`${canonical(manifest)}\n`));
    writeExclusive(path.join(backup, 'topology-manifest-intent.json'), { format: 1,
      kind: 'TRAIN_A_TOPOLOGY_MANIFEST_INTENT', deploymentId: v['deployment-id'],
      manifestSha256: topologyManifestSha256 }, 0o600,
    { allowExactExisting: true, crashLabelPrefix: 'compatibility-topology-manifest-intent' });
    const hash = writeExclusive(path.join(backup, 'topology-manifest.json'), manifest, 0o600,
      { allowExactExisting: true, crashLabelPrefix: 'compatibility-topology-manifest' });
    maybeCrash('after-topology-manifest');
    return { ok: true, topologyManifestSha256: hash };
  }
  if (verb === 'verify-topology' || verb === 'restore-topology') {
    const m = topology(backup, v['topology-manifest-sha256'], v['deployment-id']);
    const immutable = readSnapshotAuthority(v.root, backup, v['deployment-id'], m.profileIdentitySha256, m.targetManifestSha256);
    if (immutable.authoritySha256 !== m.snapshotAuthoritySha256 || immutable.authority.guardGenerationSha256 !== m.guardGenerationSha256) throw new Error('topology snapshot immutable authority mismatch');
    if (verb === 'verify-topology') return { ok: true, topologyManifestSha256: v['topology-manifest-sha256'], entryCount: m.entries.length };
    restore(v.root, backup, m); return { ok: true, restored: true };
  }
  if (verb === 'finalize') {
    requireDirectory(backup, 'backup directory');
    if (lstatOrNull(path.join(backup, 'manifest.json'))) {
      const completed = completedCompatibilityManifest(v.root, backup, v);
      return { ok: true, compatibilityManifestSha256: completed.sha256 };
    }
    const topo = topology(backup, v['topology-manifest-sha256'], v['deployment-id']);
    const immutable = readSnapshotAuthority(v.root, backup, v['deployment-id'], topo.profileIdentitySha256, v['target-manifest-sha256']);
    if (immutable.authoritySha256 !== topo.snapshotAuthoritySha256 || immutable.authority.guardGenerationSha256 !== topo.guardGenerationSha256) throw new Error('snapshot authority no longer matches topology snapshot');
    const mutation = readMutationJournal(backup, v['topology-manifest-sha256'], v['deployment-id'], immutable.authority.guardGenerationSha256);
    verifyLiveAgainstJournal(v.root, topo, mutation.journal, immutable);
    verifyTargetSafety(v.root, backup, v['target-safety-manifest-sha256'], v['deployment-id'],
      immutable.authority.guardGenerationSha256);
    const currentUci = uciIdentitySha256(v.root);
    let uciIdentityComparisonSha256 = null;
    if (currentUci !== topo.uciIdentitySha256) {
      const comparisonFile = readOwnedJson(path.join(backup, 'uci-identity-comparison.json'), 'UCI identity comparison');
      exact(comparisonFile.value, ['format', 'deploymentId', 'previousUciIdentitySha256', 'healedUciIdentitySha256', 'decision'], 'UCI identity comparison');
      if (comparisonFile.value.format !== 1 || comparisonFile.value.deploymentId !== v['deployment-id'] || comparisonFile.value.previousUciIdentitySha256 !== topo.uciIdentitySha256 || comparisonFile.value.healedUciIdentitySha256 !== currentUci || comparisonFile.value.decision !== 'preserve-healed') throw new Error('UCI healed identity comparison mismatch');
      uciIdentityComparisonSha256 = comparisonFile.sha256;
    }
    const manifest = { format: 1, kind: 'TRAIN_A_COMPATIBILITY_SET', topologyManifestSha256: v['topology-manifest-sha256'], mutationJournalSha256: mutation.sha256, snapshotAuthoritySha256: immutable.authoritySha256, guardGenerationSha256: immutable.authority.guardGenerationSha256, profileIdentitySha256: topo.profileIdentitySha256, targetCommit: v['target-commit'], deploymentId: v['deployment-id'], targetManifestSha256: v['target-manifest-sha256'], targetSafetyManifestSha256: v['target-safety-manifest-sha256'], runtimeDependencyManifestSha256: v['runtime-dependency-manifest-sha256'], previousUciIdentitySha256: topo.uciIdentitySha256, healedUciIdentitySha256: currentUci, uciIdentityComparisonSha256 };
    const compatibilityManifestSha256 = shaBytes(Buffer.from(`${canonical(manifest)}\n`));
    writeExclusive(path.join(backup, 'compatibility-manifest-intent.json'), { format: 1,
      kind: 'TRAIN_A_COMPATIBILITY_MANIFEST_INTENT', deploymentId: v['deployment-id'],
      manifestSha256: compatibilityManifestSha256 }, 0o600,
    { allowExactExisting: true, crashLabelPrefix: 'compatibility-final-manifest-intent' });
    const hash = writeExclusive(path.join(backup, 'manifest.json'), manifest, 0o600,
      { allowExactExisting: true, crashLabelPrefix: 'compatibility-final-manifest' });
    maybeCrash('after-compatibility-manifest');
    return { ok: true, compatibilityManifestSha256: hash };
  }
  const loaded = compatibility(v);
  if (verb === 'verify') { verifyLiveAgainstJournal(v.root, loaded.topo, loaded.mutation.journal, loaded.immutable); return { ok: true, compatibilityManifestSha256: v['manifest-sha256'] }; }
  const restoredPredecessor = readRestoredPredecessor(v['restored-predecessor-path'],
    v['restored-predecessor-sha256'], v['manifest-sha256']);
  restoreMutationCount = 0;
  restore(v.root, backup, loaded.topo);
  verifyPreservedAuthorities(v.root, loaded.topo, loaded.mutation.journal, loaded.immutable);
  verifyTargetSafety(v.root, backup, loaded.manifest.targetSafetyManifestSha256,
    v['deployment-id'], loaded.manifest.guardGenerationSha256);
  const proof = publishTopologyRestorationProof(v.root, backup, loaded.manifest, v['manifest-sha256'], restoredPredecessor);
  return { ok: true, restored: true, compatibilityManifestSha256: v['manifest-sha256'],
    topologyRestorationProofPath: proof.proofPath, topologyRestorationProofSha256: proof.proofSha256,
    sixLinkTopologySha256: proof.proof.sixLinkTopologySha256,
    restoredPredecessorSha256: proof.proof.restoredPredecessorSha256 };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(dispatch(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`[deploy-compatibility-set] ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { TOPOLOGY_PATHS, FORENSIC_PATHS, TARGET_SAFETY_PATHS, SIX_APPLICATION_LINKS,
  RESTORABLE_PATHS, dispatch, canonical, shaObject, rooted, collectPathSet, entryIdentity, capture,
  uciIdentitySha256, compatibilityPathSetSha256, liveTopologyIdentity, topologyRestorationProof };
