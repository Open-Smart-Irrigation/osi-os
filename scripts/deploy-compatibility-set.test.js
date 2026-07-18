'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const compat = require('./deploy-compatibility-set');
const deploymentState = require('./lib/deployment-state');

const cli = path.join(__dirname, 'deploy-compatibility-set.js');
const H = 'a'.repeat(64);
const J = 'b'.repeat(64);
const K = 'c'.repeat(64);

function run(args, extraEnv = {}) {
  const boundary = path.join(os.tmpdir(), `osi-compat-tests-${process.getuid()}`);
  return cp.spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OSI_REPAIR_PROGRAM_MODE: '1', OSI_DEPLOY_ARTIFACT_MODE: 'test', OSI_COMPAT_TEST_BOUNDARY: boundary, ...extraEnv },
  });
}
function setup() {
  const boundary = path.join(os.tmpdir(), `osi-compat-tests-${process.getuid()}`);
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(boundary, 'case-'));
  const root = path.join(dir, 'root');
  const backup = path.join(dir, 'compatibility-set');
  fs.mkdirSync(path.join(root, 'srv/node-red'), { recursive: true });
  fs.writeFileSync(path.join(root, 'srv/node-red/flows.json'), 'old-flow');
  fs.writeFileSync(path.join(root, 'srv/node-red/.chirpstack.env'), 'SECRET=do-not-print');
  fs.mkdirSync(path.join(root, 'etc/rc.d'), { recursive: true });
  fs.symlinkSync('../init.d/node-red', path.join(root, 'etc/rc.d/S99node-red'));
  fs.mkdirSync(path.join(root, 'etc/uci-defaults'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/uci-defaults/94_osi_identityd_enable'), 'guard-aware');
  fs.mkdirSync(path.join(root, 'proc/sys/kernel/random'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proc/sys/kernel/random/boot_id'), 'boot-compat-test\n');
  return { dir, root, backup, targetEntries: [] };
}
function prepareSnapshotAuthority(f) {
  if (f.targetManifestSha256) return;
  const targetManifestPath = `${f.backup}.target-manifest.json`;
  const targetManifestSha256 = writeOwned(targetManifestPath, { format: 1, deploymentId: 'dep-1', entries: f.targetEntries });
  const guardGenerationPath = `${f.backup}.guard-generation.json`;
  const guardGenerationSha256 = writeOwned(guardGenerationPath, { format: 1, deploymentId: 'dep-1', generation: 9,
    phase: 'controls-installed', targetManifestSha256, mutatedPaths: f.targetEntries.map((entry) => entry.path) });
  writeOwned(`${f.backup}.snapshot-authority.json`, { format: 1, deploymentId: 'dep-1', bootId: 'boot-compat-test',
    stoppedRoleGenerations: { 'osi-identityd': 3, 'node-red': 5, 'osi-bootstrap': 7, 'osi-db-integrity': 11 },
    pathSetSha256: compat.compatibilityPathSetSha256(), profileMappingSha256: K, approvedAttemptBackupRoot: f.backup,
    guardGenerationPath, guardGenerationSha256, targetManifestPath, targetManifestSha256 });
  f.targetManifestPath = targetManifestPath;
  f.targetManifestSha256 = targetManifestSha256;
  f.guardGenerationSha256 = guardGenerationSha256;
}
function snapshotArgs(f) {
  prepareSnapshotAuthority(f);
  return ['snapshot-topology', '--root', f.root, '--backup-dir', f.backup,
    '--target-commit', '1'.repeat(40), '--deployment-id', 'dep-1',
    '--target-manifest-sha256', f.targetManifestSha256, '--artifact-sha256', J,
    '--profile-identity-sha256', K];
}
function writeOwned(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function fileTargetEntry(logicalPath, bytes, mode, stat = null) {
  return { path: logicalPath, mode, uid: stat ? stat.uid : process.getuid(), gid: stat ? stat.gid : process.getgid(),
    type: 'file', sizeBytes: Buffer.byteLength(bytes), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function prepareFinalization(f, topologyManifestSha256, mutations = []) {
  const journal = { format: 1, deploymentId: 'dep-1', topologyManifestSha256, guardGenerationSha256: f.guardGenerationSha256, mutations };
  writeOwned(path.join(f.backup, 'mutation-journal.json'), journal);
  const topology = JSON.parse(fs.readFileSync(path.join(f.backup, 'topology-manifest.json')));
  const currentUci = compat.uciIdentitySha256(f.root);
  if (currentUci !== topology.uciIdentitySha256) writeOwned(path.join(f.backup, 'uci-identity-comparison.json'), {
    format: 1, deploymentId: 'dep-1', previousUciIdentitySha256: topology.uciIdentitySha256,
    healedUciIdentitySha256: currentUci, decision: 'preserve-healed',
  });
  const manifestPath = path.join(f.backup, 'target-safety-manifest.json');
  const safety = { format: 1, kind: 'TRAIN_A_TARGET_SAFETY', deploymentId: 'dep-1',
    manifestPath, guardGenerationSha256: f.guardGenerationSha256,
    entries: compat.collectPathSet(f.root, compat.TARGET_SAFETY_PATHS) };
  const targetSafetyManifestSha256 = writeOwned(manifestPath, safety);
  return { targetSafetyManifestSha256 };
}
function restoredPredecessorArgs(f, compatibilityManifestSha256) {
  const identityPath = `${f.backup}.restored-predecessor.json`;
  const restoredPredecessor = { kind: 'legacy-compatibility', compatibilityManifestSha256,
    topologySha256: 'd'.repeat(64), databaseIdentitySha256: 'e'.repeat(64),
    flowStamp: '2026-07-19T00-00-00Z' };
  if (!fs.existsSync(identityPath)) writeOwned(identityPath, restoredPredecessor);
  f.restoredPredecessor = restoredPredecessor;
  return ['--restored-predecessor-path', identityPath, '--restored-predecessor-sha256',
    deploymentState.restoredPredecessorSha256(restoredPredecessor)];
}

test('snapshot, verify, finalize, restore preserve bytes and symlink targets without exposing secrets', () => {
  const f = setup();
  const safetyPath = '/etc/uci-defaults/94_osi_identityd_enable';
  const safetyStat = fs.statSync(path.join(f.root, safetyPath));
  f.targetEntries = [fileTargetEntry(safetyPath, 'guard-aware-healed', safetyStat.mode & 0o7777, safetyStat)];
  const snap = run(snapshotArgs(f));
  assert.equal(snap.status, 0, snap.stderr);
  assert.doesNotMatch(snap.stdout + snap.stderr, /do-not-print/);
  const s = JSON.parse(snap.stdout);
  const verify = run(['verify-topology', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--deployment-id', 'dep-1']);
  assert.equal(verify.status, 0, verify.stderr);
  // The preclaim legacy 94 is forensic evidence only. A later healed,
  // target-safety-bound value is preserved, never rolled back.
  const topology = JSON.parse(fs.readFileSync(path.join(f.backup, 'topology-manifest.json')));
  const beforeSafety = topology.entries.find((entry) => entry.path === safetyPath);
  fs.writeFileSync(path.join(f.root, safetyPath), 'guard-aware-healed');
  const prepared = prepareFinalization(f, s.topologyManifestSha256,
    [{ path: safetyPath, beforeIdentitySha256: compat.entryIdentity(beforeSafety) }]);
  const fin = run(['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256, '--runtime-dependency-manifest-sha256', K]);
  assert.equal(fin.status, 0, fin.stderr);
  const m = JSON.parse(fin.stdout);
  fs.writeFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'new-flow');
  fs.unlinkSync(path.join(f.root, 'etc/rc.d/S99node-red'));
  const restored = run(['restore', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', m.compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--runtime-dependency-manifest-sha256', K, ...restoredPredecessorArgs(f, m.compatibilityManifestSha256)]);
  assert.equal(restored.status, 0, restored.stderr);
  const restoredResult = JSON.parse(restored.stdout);
  const proofPath = path.join(f.backup, 'topology-restoration-proof.json');
  assert.equal(restoredResult.topologyRestorationProofPath, proofPath);
  assert.equal(restoredResult.topologyRestorationProofSha256,
    crypto.createHash('sha256').update(fs.readFileSync(proofPath)).digest('hex'));
  const proof = JSON.parse(fs.readFileSync(proofPath));
  assert.deepEqual(proof, compat.topologyRestorationProof(f.root, f.backup,
    JSON.parse(fs.readFileSync(path.join(f.backup, 'manifest.json'))), m.compatibilityManifestSha256,
    f.restoredPredecessor));
  assert.equal(proof.liveRootPath, f.root);
  assert.deepEqual(proof.restoredPredecessor, f.restoredPredecessor);
  assert.equal(proof.restoredPredecessorSha256,
    deploymentState.restoredPredecessorSha256(f.restoredPredecessor));
  assert.deepEqual(compat.liveTopologyIdentity(f.root), {
    restoredTopologySha256: proof.restoredTopologySha256,
    restoredMetadataSha256: proof.restoredMetadataSha256,
    sixLinkTopologySha256: proof.sixLinkTopologySha256,
    uciIdentitySha256: proof.uciIdentitySha256,
  });
  assert.equal(proof.sixLinkTopologySha256,
    compat.shaObject({ entries: compat.collectPathSet(f.root, compat.SIX_APPLICATION_LINKS) }));
  assert.equal(fs.readFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'utf8'), 'old-flow');
  assert.equal(fs.readlinkSync(path.join(f.root, 'etc/rc.d/S99node-red')), '../init.d/node-red');
  assert.equal(fs.readFileSync(path.join(f.root, 'etc/uci-defaults/94_osi_identityd_enable'), 'utf8'), 'guard-aware-healed');
});

test('restore proof is immutable and a tampered proof cannot be replaced by a later restore', () => {
  const f = setup();
  const s = JSON.parse(run(snapshotArgs(f)).stdout);
  const prepared = prepareFinalization(f, s.topologyManifestSha256);
  const finalized = JSON.parse(run(['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256,
    '--runtime-dependency-manifest-sha256', K]).stdout);
  const args = ['restore', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', finalized.compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--runtime-dependency-manifest-sha256', K,
    ...restoredPredecessorArgs(f, finalized.compatibilityManifestSha256)];
  assert.equal(run(args).status, 0);
  const proofPath = path.join(f.backup, 'topology-restoration-proof.json');
  const proof = JSON.parse(fs.readFileSync(proofPath));
  proof.restoredMetadataSha256 = 'f'.repeat(64);
  fs.writeFileSync(proofPath, JSON.stringify(proof), { mode: 0o600 }); fs.chmodSync(proofPath, 0o600);
  assert.notEqual(run(args).status, 0, 'immutable proof tamper must not be overwritten');
});

test('finalize accepts only an exact journaled target identity and rejects unjournaled drift or target-safety drift', () => {
  const f = setup();
  const target = '/srv/node-red/flows.json';
  const liveStat = fs.statSync(path.join(f.root, target));
  f.targetEntries = [{ path: target, mode: liveStat.mode & 0o7777, uid: liveStat.uid, gid: liveStat.gid,
    type: 'file', sizeBytes: Buffer.byteLength('new-target-flow'), sha256: crypto.createHash('sha256').update('new-target-flow').digest('hex') }];
  const snap = run(snapshotArgs(f)); assert.equal(snap.status, 0, snap.stderr);
  const s = JSON.parse(snap.stdout);
  const topology = JSON.parse(fs.readFileSync(path.join(f.backup, 'topology-manifest.json')));
  const before = topology.entries.find((entry) => entry.path === target);
  fs.writeFileSync(path.join(f.root, target), 'new-target-flow');
  const prepared = prepareFinalization(f, s.topologyManifestSha256, [{ path: target, beforeIdentitySha256: compat.entryIdentity(before) }]);
  const args = ['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256, '--runtime-dependency-manifest-sha256', K];
  const finalized = run(args);
  assert.equal(finalized.status, 0, finalized.stderr);
  const compatibilityManifestSha256 = JSON.parse(finalized.stdout).compatibilityManifestSha256;

  const unjournalled = setup();
  const snap2 = JSON.parse(run(snapshotArgs(unjournalled)).stdout);
  fs.writeFileSync(path.join(unjournalled.root, target), 'not-journalled');
  const prepared2 = prepareFinalization(unjournalled, snap2.topologyManifestSha256);
  const bad = run(['finalize', '--root', unjournalled.root, '--backup-dir', unjournalled.backup,
    '--topology-manifest-sha256', snap2.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', unjournalled.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared2.targetSafetyManifestSha256, '--runtime-dependency-manifest-sha256', K]);
  assert.notEqual(bad.status, 0);

  fs.writeFileSync(path.join(f.root, 'etc/uci-defaults/94_osi_identityd_enable'), 'tampered-safety');
  const safetyDrift = run(['verify', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256, '--runtime-dependency-manifest-sha256', K]);
  assert.notEqual(safetyDrift.status, 0);
});

test('restore is resumable after a hard crash and preserves the target safety set', () => {
  const f = setup();
  const s = JSON.parse(run(snapshotArgs(f)).stdout);
  const prepared = prepareFinalization(f, s.topologyManifestSha256);
  const fin = run(['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256, '--runtime-dependency-manifest-sha256', K]);
  assert.equal(fin.status, 0, fin.stderr);
  const m = JSON.parse(fin.stdout);
  fs.writeFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'new-flow');
  fs.writeFileSync(path.join(f.root, 'srv/node-red/new-descendant'), 'new');
  const restoreArgs = ['restore', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', m.compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256, '--runtime-dependency-manifest-sha256', K,
    ...restoredPredecessorArgs(f, m.compatibilityManifestSha256)];
  const boundary = path.join(os.tmpdir(), `osi-compat-tests-${process.getuid()}`);
  const crashed = cp.spawnSync(process.execPath, [cli, ...restoreArgs], { encoding: 'utf8', env: {
    ...process.env, OSI_REPAIR_PROGRAM_MODE: '1', OSI_DEPLOY_ARTIFACT_MODE: 'test', OSI_COMPAT_TEST_BOUNDARY: boundary,
    OSI_COMPAT_CRASH_AFTER_MUTATIONS: '1',
  } });
  assert.equal(crashed.status, 137, crashed.stderr);
  const resumed = run(restoreArgs); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'utf8'), 'old-flow');
  assert.equal(fs.existsSync(path.join(f.root, 'srv/node-red/new-descendant')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'etc/uci-defaults/94_osi_identityd_enable'), 'utf8'), 'guard-aware');
});

test('restore rolls back only restorable paths and preserves an immutable newly installed guard authority', () => {
  const f = setup();
  const guardPath = '/data/osi-deploy/guard-installed.json';
  const flowPath = '/srv/node-red/flows.json';
  const inhibitorPath = '/etc/init.d/osi-deployment-inhibit';
  const guardBytes = '{"installed":true}\n';
  const targetFlowBytes = 'installed-target-flow';
  const inhibitorBytes = 'target-inhibitor';
  const flowStat = fs.statSync(path.join(f.root, flowPath));
  f.targetEntries = [
    { path: guardPath, mode: 0o600, uid: process.getuid(), gid: process.getgid(), type: 'file',
      sizeBytes: Buffer.byteLength(guardBytes), sha256: crypto.createHash('sha256').update(guardBytes).digest('hex') },
    { path: flowPath, mode: flowStat.mode & 0o7777, uid: flowStat.uid, gid: flowStat.gid, type: 'file',
      sizeBytes: Buffer.byteLength(targetFlowBytes), sha256: crypto.createHash('sha256').update(targetFlowBytes).digest('hex') },
    fileTargetEntry(inhibitorPath, inhibitorBytes, 0o700),
  ];
  const snap = run(snapshotArgs(f));
  assert.equal(snap.status, 0, snap.stderr);
  const topologyManifestSha256 = JSON.parse(snap.stdout).topologyManifestSha256;
  const topology = JSON.parse(fs.readFileSync(path.join(f.backup, 'topology-manifest.json')));
  const beforeGuard = topology.entries.find((entry) => entry.path === guardPath);
  const beforeFlow = topology.entries.find((entry) => entry.path === flowPath);
  const beforeInhibitor = topology.entries.find((entry) => entry.path === inhibitorPath);
  assert.equal(beforeGuard.type, 'absent', 'guard marker is genuinely absent in the predecessor snapshot');

  fs.mkdirSync(path.join(f.root, 'data/osi-deploy'), { recursive: true });
  fs.writeFileSync(path.join(f.root, guardPath), guardBytes, { mode: 0o600 });
  fs.mkdirSync(path.join(f.root, 'etc/init.d'), { recursive: true });
  fs.writeFileSync(path.join(f.root, inhibitorPath), inhibitorBytes, { mode: 0o700 });
  fs.writeFileSync(path.join(f.root, flowPath), targetFlowBytes);
  const prepared = prepareFinalization(f, topologyManifestSha256, [
    { path: guardPath, beforeIdentitySha256: compat.entryIdentity(beforeGuard) },
    { path: flowPath, beforeIdentitySha256: compat.entryIdentity(beforeFlow) },
    { path: inhibitorPath, beforeIdentitySha256: compat.entryIdentity(beforeInhibitor) },
  ]);
  const finalized = run(['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256,
    '--runtime-dependency-manifest-sha256', K]);
  assert.equal(finalized.status, 0, finalized.stderr);
  const compatibilityManifestSha256 = JSON.parse(finalized.stdout).compatibilityManifestSha256;
  const restoreArgs = ['restore', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--runtime-dependency-manifest-sha256', K,
    ...restoredPredecessorArgs(f, compatibilityManifestSha256)];

  fs.writeFileSync(path.join(f.root, flowPath), 'failed-deployment-flow');
  const restored = run(restoreArgs);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, flowPath), 'utf8'), 'old-flow');
  assert.equal(fs.readFileSync(path.join(f.root, guardPath), 'utf8'), guardBytes);
  assert.equal(fs.readFileSync(path.join(f.root, 'etc/init.d/osi-deployment-inhibit'), 'utf8'), 'target-inhibitor');

  fs.writeFileSync(path.join(f.root, guardPath), '{"tampered":true}\n');
  const tampered = run(restoreArgs);
  assert.notEqual(tampered.status, 0, 'preserved guard marker must still match its immutable target receipt');
  assert.match(tampered.stderr, /guard|preserv|authority|target/i);
});

test('snapshot refuses and cleans copied bytes that differ from the initially measured manifest facts', () => {
  const f = setup();
  fs.mkdirSync(f.backup, { mode: 0o700 });
  assert.equal(typeof compat.capture, 'function', 'direct snapshot race seam must be exported');
  let injected = false;
  assert.throws(() => compat.capture(f.root, f.backup, (source, destination, flags) => {
    if (!injected) {
      injected = true;
      fs.appendFileSync(source, '-changed-after-measure');
    }
    fs.copyFileSync(source, destination, flags);
  }), /snapshot|copied|drift|changed/i);
  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(f.backup, 'topology-files')), false,
    'all attempt-owned snapshot copies are removed after a binding failure');
  assert.equal(fs.existsSync(path.join(f.backup, 'topology-manifest.json')), false);
});

test('snapshot re-reads the source after copy and rejects mutation after completed copy', () => {
  const f = setup();
  fs.mkdirSync(f.backup, { mode: 0o700 });
  let injected = false;
  assert.throws(() => compat.capture(f.root, f.backup, (source, destination, flags) => {
    fs.copyFileSync(source, destination, flags);
    if (!injected) {
      injected = true;
      fs.appendFileSync(source, '-changed-after-copy');
    }
  }), /source|snapshot|copied|drift|changed/i);
  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(f.backup, 'topology-files')), false);
});

test('snapshot recollects full topology after copying and rejects symlink or directory drift', () => {
  for (const mutation of ['symlink-target', 'directory-mode', 'directory-descendant']) {
    const f = setup();
    fs.mkdirSync(f.backup, { mode: 0o700 });
    let injected = false;
    assert.throws(() => compat.capture(f.root, f.backup, (source, destination, flags) => {
      fs.copyFileSync(source, destination, flags);
      if (injected) return;
      injected = true;
      if (mutation === 'symlink-target') {
        const link = path.join(f.root, 'etc/rc.d/S99node-red');
        fs.unlinkSync(link); fs.symlinkSync('../init.d/other-node-red', link);
      } else if (mutation === 'directory-mode') {
        fs.chmodSync(path.join(f.root, 'srv/node-red'), 0o750);
      } else {
        fs.writeFileSync(path.join(f.root, 'srv/node-red/late-descendant'), 'late');
      }
    }), /topology|snapshot|source|drift|changed/i, mutation);
    assert.equal(injected, true, mutation);
    assert.equal(fs.existsSync(path.join(f.backup, 'topology-files')), false,
      `${mutation}: fresh attempt copies must be removed after full-topology drift`);
  }
});

test('snapshot resumes exact directory and completed-copy crash prefixes but rejects tampered copies', () => {
  for (const crashPoint of ['after-backup-mkdir', 'after-snapshot-copy', 'after-topology-manifest']) {
    const f = setup();
    const crashed = run(snapshotArgs(f), { OSI_COMPAT_CRASH_AT: crashPoint });
    assert.equal(crashed.status, 137, `${crashPoint}: ${crashed.stderr}`);
    if (crashPoint === 'after-topology-manifest') {
      fs.writeFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'mutation-after-durable-snapshot');
    }
    const resumed = run(snapshotArgs(f));
    assert.equal(resumed.status, 0, `${crashPoint}: ${resumed.stderr}`);
    assert.match(JSON.parse(resumed.stdout).topologyManifestSha256, /^[0-9a-f]{64}$/);
  }

  const f = setup();
  assert.equal(run(snapshotArgs(f), { OSI_COMPAT_CRASH_AT: 'after-snapshot-copy' }).status, 137);
  const copied = fs.readdirSync(path.join(f.backup, 'topology-files'))
    .map((name) => path.join(f.backup, 'topology-files', name))
    .find((candidate) => fs.lstatSync(candidate).isFile());
  fs.appendFileSync(copied, 'tampered');
  const rejected = run(snapshotArgs(f));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /collision|copy|snapshot|drift|tamper/i);
});

test('finalize resumes an exactly published immutable manifest after a crash', () => {
  const f = setup();
  const s = JSON.parse(run(snapshotArgs(f)).stdout);
  const prepared = prepareFinalization(f, s.topologyManifestSha256);
  const args = ['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256,
    '--runtime-dependency-manifest-sha256', K];
  const crashed = run(args, { OSI_COMPAT_CRASH_AT: 'after-compatibility-manifest' });
  assert.equal(crashed.status, 137, crashed.stderr);
  fs.writeFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'mutation-after-durable-finalize');
  const resumed = run(args);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(JSON.parse(resumed.stdout).compatibilityManifestSha256, /^[0-9a-f]{64}$/);
});

test('snapshot and finalize reject byte-tampered published manifest collisions on retry', () => {
  const snapshotFixture = setup();
  assert.equal(run(snapshotArgs(snapshotFixture), { OSI_COMPAT_CRASH_AT: 'after-topology-manifest' }).status, 137);
  fs.appendFileSync(path.join(snapshotFixture.backup, 'topology-manifest.json'), ' ');
  assert.notEqual(run(snapshotArgs(snapshotFixture)).status, 0);

  const finalFixture = setup();
  const s = JSON.parse(run(snapshotArgs(finalFixture)).stdout);
  const prepared = prepareFinalization(finalFixture, s.topologyManifestSha256);
  const args = ['finalize', '--root', finalFixture.root, '--backup-dir', finalFixture.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', finalFixture.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256,
    '--runtime-dependency-manifest-sha256', K];
  assert.equal(run(args, { OSI_COMPAT_CRASH_AT: 'after-compatibility-manifest' }).status, 137);
  fs.appendFileSync(path.join(finalFixture.backup, 'manifest.json'), ' ');
  assert.notEqual(run(args).status, 0);
});

test('copied snapshot drift, unknown flags, and destination reuse fail closed', () => {
  const f = setup();
  const snap = run(snapshotArgs(f));
  assert.equal(snap.status, 0, snap.stderr);
  const s = JSON.parse(snap.stdout);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.backup, 'topology-manifest.json')));
  const file = manifest.entries.find((entry) => entry.type === 'file');
  fs.appendFileSync(path.join(f.backup, file.copyPath), 'tamper');
  assert.notEqual(run(['verify-topology', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--deployment-id', 'dep-1']).status, 0);
  assert.notEqual(run([...snapshotArgs(setup()), '--bogus', 'x']).status, 0);
  assert.notEqual(run(snapshotArgs(f)).status, 0);
});

test('caller-authored after identities and mutated immutable target bytes are rejected', () => {
  const target = '/srv/node-red/flows.json';
  for (const mode of ['caller-after', 'mutated-target']) {
    const f = setup();
    const stat = fs.statSync(path.join(f.root, target));
    f.targetEntries = [{ path: target, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, type: 'file',
      sizeBytes: 6, sha256: crypto.createHash('sha256').update('target').digest('hex') }];
    const s = JSON.parse(run(snapshotArgs(f)).stdout);
    const topology = JSON.parse(fs.readFileSync(path.join(f.backup, 'topology-manifest.json')));
    const before = topology.entries.find((entry) => entry.path === target);
    fs.writeFileSync(path.join(f.root, target), 'target');
    const mutation = { path: target, beforeIdentitySha256: compat.entryIdentity(before) };
    if (mode === 'caller-after') mutation.after = compat.collectPathSet(f.root, [target])[0];
    const prepared = prepareFinalization(f, s.topologyManifestSha256, [mutation]);
    if (mode === 'mutated-target') fs.appendFileSync(f.targetManifestPath, ' ');
    const result = run(['finalize', '--root', f.root, '--backup-dir', f.backup,
      '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
      '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
      '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256, '--runtime-dependency-manifest-sha256', K]);
    assert.notEqual(result.status, 0, mode);
  }
});

test('finalize binds an explicit healed UCI comparison and verify/restore preserve it', () => {
  const f = setup();
  const s = JSON.parse(run(snapshotArgs(f)).stdout);
  fs.mkdirSync(path.join(f.root, 'etc/config'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'etc/config/osi-server'), "config cloud 'cloud'\n option device_eui 'ABCDEF0123456789'\n option server_url 'https://edge.example'\n");
  const prepared = prepareFinalization(f, s.topologyManifestSha256);
  const fin = run(['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256, '--runtime-dependency-manifest-sha256', K]);
  assert.equal(fin.status, 0, fin.stderr);
  const m = JSON.parse(fin.stdout);
  const restoreArgs = ['restore', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', m.compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256, '--runtime-dependency-manifest-sha256', K,
    ...restoredPredecessorArgs(f, m.compatibilityManifestSha256)];
  fs.writeFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'new-flow');
  assert.equal(run(restoreArgs).status, 0);
  assert.match(fs.readFileSync(path.join(f.root, 'etc/config/osi-server'), 'utf8'), /ABCDEF0123456789/);
  fs.appendFileSync(path.join(f.root, 'etc/config/osi-server'), " option device_eui 'DRIFT'\n");
  assert.notEqual(run(restoreArgs).status, 0, 'restore must reject UCI identity drift from the healed comparison');
});

test('exports one closed snapshot-visible but non-restorable permanent safety inventory', () => {
  const mod = require('./deploy-compatibility-set');
  const permanentSafety = [
    '/usr/libexec/osi-deployment-state.js',
    '/usr/libexec/osi-deployment-state-cli.js',
    '/usr/libexec/osi-node-red-guarded-launch.js',
    '/usr/libexec/osi-current-role-state',
    '/usr/libexec/osi-record-role-start',
    '/etc/init.d/osi-deployment-inhibit',
    '/etc/rc.d/S01osi-deployment-inhibit',
    '/usr/libexec/osi-deployment-inhibit.sh',
    '/etc/uci-defaults/94_osi_identityd_enable',
  ];
  for (const resident of permanentSafety) {
    assert.ok(mod.TOPOLOGY_PATHS.includes(resident), `${resident}: predecessor snapshot evidence`);
    assert.ok(mod.TARGET_SAFETY_PATHS.includes(resident), `${resident}: current target-safety authority`);
    assert.equal(mod.RESTORABLE_PATHS.includes(resident), false, `${resident}: rollback must never remove or revert`);
  }
  assert.ok(mod.TOPOLOGY_PATHS.includes('/data/osi-deploy/guard-installed.json'));
  assert.equal(mod.RESTORABLE_PATHS.includes('/data/osi-deploy/guard-installed.json'), false);
});

test('restoration proof binds the exact immutable target-safety manifest locator', () => {
  const f = setup();
  const snap = run(snapshotArgs(f));
  assert.equal(snap.status, 0, snap.stderr);
  const topology = JSON.parse(snap.stdout);
  const prepared = prepareFinalization(f, topology.topologyManifestSha256);
  const finalized = run(['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', topology.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256,
    '--runtime-dependency-manifest-sha256', K]);
  assert.equal(finalized.status, 0, finalized.stderr);
  const manifest = JSON.parse(finalized.stdout);
  fs.writeFileSync(path.join(f.root, 'srv/node-red/flows.json'), 'new-flow');
  const restored = run(['restore', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', manifest.compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--runtime-dependency-manifest-sha256', K,
    ...restoredPredecessorArgs(f, manifest.compatibilityManifestSha256)]);
  assert.equal(restored.status, 0, restored.stderr);
  const proof = JSON.parse(fs.readFileSync(path.join(f.backup, 'topology-restoration-proof.json')));
  assert.equal(proof.targetSafetyManifestPath, path.join(f.backup, 'target-safety-manifest.json'));
});

test('root confinement accepts the real slash root without constructing a double-slash prefix', () => {
  assert.equal(compat.rooted('/', '/etc/rc.d/S99node-red'), '/etc/rc.d/S99node-red');
  assert.throws(() => compat.rooted('/', '../etc/passwd'));
});

test('capture rejects an intermediate symlink escape while preserving final symlink evidence', () => {
  const f = setup();
  const outside = path.join(f.dir, 'outside');
  fs.mkdirSync(path.join(outside, 'rc.d'), { recursive: true });
  fs.rmSync(path.join(f.root, 'etc'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.root, 'etc'));
  assert.throws(
    () => compat.collectPathSet(f.root, ['/etc/rc.d/S99node-red']),
    /symlink|confinement|ancestor/
  );
});

test('restore rejects an intermediate symlink swap and never writes outside the captured root', () => {
  const f = setup();
  const s = JSON.parse(run(snapshotArgs(f)).stdout);
  const prepared = prepareFinalization(f, s.topologyManifestSha256);
  const fin = run(['finalize', '--root', f.root, '--backup-dir', f.backup,
    '--topology-manifest-sha256', s.topologyManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--target-safety-manifest-sha256', prepared.targetSafetyManifestSha256, '--runtime-dependency-manifest-sha256', K]);
  assert.equal(fin.status, 0, fin.stderr);
  const m = JSON.parse(fin.stdout);
  const outside = path.join(f.dir, 'outside');
  fs.mkdirSync(path.join(outside, 'node-red'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'node-red/flows.json'), 'outside-sentinel');
  fs.rmSync(path.join(f.root, 'srv'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.root, 'srv'));
  const restored = run(['restore', '--root', f.root, '--backup-dir', f.backup,
    '--manifest-sha256', m.compatibilityManifestSha256, '--target-commit', '1'.repeat(40),
    '--deployment-id', 'dep-1', '--target-manifest-sha256', f.targetManifestSha256,
    '--runtime-dependency-manifest-sha256', K,
    ...restoredPredecessorArgs(f, m.compatibilityManifestSha256)]);
  assert.notEqual(restored.status, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'node-red/flows.json'), 'utf8'), 'outside-sentinel');
});
