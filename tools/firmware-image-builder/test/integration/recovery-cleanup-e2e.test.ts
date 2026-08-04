import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type LoadedConfig } from '../../config/load.js';
import { createRecoveryPhysicalVerification } from '../../api/src/recovery-production.js';
import {
  OwnershipStore,
  type CleanupPostcondition,
  type CleanupSnapshot,
  type RunnerWriteCommand,
} from '../../api/src/ownership.js';
import { BuilderStore } from '../../api/src/store.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { encodeJson } from '../../api/src/validation.js';
import { createDefaultDependencyEgressCleanup } from '../../cleanup-worker/src/production.js';
import { createDependencyEgressCredential } from '../../runner/src/dependency-egress-credential.js';
import type { LoadedCleanupConfig } from '../../config/load.js';
import { createTestBuilderIdentity } from '../helpers/builder-identity.js';

const JOB_ID = 'recovery-cleanup-e2e';
const ADMISSION_ID = 'cln_0123456789abcdefghjkmnpqrs';
const MANIFEST_SHA = 'a'.repeat(64);
const ARGUMENTS_SHA = 'b'.repeat(64);
const CREDENTIAL_TOKEN_SHA = 'c'.repeat(64);
const FENCE_TOKEN_SHA = 'd'.repeat(64);
const NOW = '2026-08-03T12:00:00.000Z';
const RUNNER_STARTED = '2026-08-03T12:00:01.000Z';
const RUNNER_LEASE_EXPIRES = '2026-08-03T12:00:01.500Z';
const ADMITTED_AT = '2026-08-03T12:00:02.000Z';
const COMPLETE_AT = '2026-08-03T12:00:03.000Z';
const EXPIRES_AT = '2026-08-03T12:05:00.000Z';
const ROOT_ID = 'release';

const roots: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

function sourcePreparation(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceSha: 'e'.repeat(40),
    gitmodulesBlobSha: 'f'.repeat(40),
    preparedAt: NOW,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed', mode: '040000', type: 'tree', objectId: '1'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt', mode: '040000', type: 'tree', objectId: '2'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function offlineFeedPreparation(): Record<string, unknown> {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    schemaVersion: 1,
    boundary: 'api-prepared-pinned-feeds-v1',
    networkPolicy: 'runner-offline',
    jobId: JOB_ID,
    sourceSha: 'e'.repeat(40),
    preparedAt: NOW,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: '3'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '3'.repeat(64) },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '4'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '4'.repeat(64) },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: '5'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '5'.repeat(64) },
    ],
  };
}

function labels(jobId: string): Record<string, string> {
  return {
    'org.osi.image-builder.job-id': jobId,
    'org.osi.image-builder.manifest-sha': MANIFEST_SHA,
  };
}

function cleanupLoaded(stateRoot: string): LoadedCleanupConfig {
  return {
    stateRoot,
    config: {
      approvedOutputRoots: [],
      builderLockPath: '/opt/osi-image-builder/2026.08.03/builder.lock.json',
    },
    configRoot: '/etc/osi-image-builder',
    pathAuthorities: {} as never,
  } as LoadedCleanupConfig;
}

async function createApiConfig(base: string): Promise<LoadedConfig> {
  const configHome = join(base, 'config-home');
  const stateHome = join(base, 'state-home');
  const repository = join(base, 'repository');
  const output = join(base, 'output');
  const configRoot = join(configHome, 'osi-image-builder');
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(repository, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  const configPath = join(configRoot, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath: repository,
    approvedOutputRoots: [{ id: ROOT_ID, label: 'Release', path: output }],
    builderLockPath: '/opt/osi-image-builder/2026.08.03/builder.lock.json',
  }), { mode: 0o600 });
  return loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    git: { getOriginPolicy: async () => ({ url: 'git@example.com:osi/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
  });
}

function seedJob(db: ReturnType<typeof openBuilderDatabase>): void {
  const identity = createTestBuilderIdentity(MANIFEST_SHA);
  const values = [
    JOB_ID, `${JOB_ID}-request`, JSON.stringify({ branch: 'main', target: 'rpi-5' }), 'git@example.com:osi/osi-os.git',
    'refs/remotes/origin/main', 'main', 'main', 'e'.repeat(40), 'e'.repeat(40), JSON.stringify(sourcePreparation()),
    JSON.stringify(offlineFeedPreparation()), 'rpi-5', ROOT_ID, MANIFEST_SHA, 'admitted', identity.packageVersion,
    identity.packageRoot, identity.lockSha256, identity.executionDefinitionSha256, identity.targetManifestSha256,
    identity.runnerSha256, identity.cleanupWorkerSha256, identity.dependencyEgressProxySha256, identity.imageReference,
    identity.imageId, identity.imageDigest, NOW, 'test', 'recovery cleanup', NOW, 'queued', 'queued', 0, NOW, NOW,
  ];
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, request_json, source_remote, source_ref, source_branch, branch,
    expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json, target_id, root_id, target_manifest_sha256,
    builder_identity_status, builder_package_version, builder_package_root, builder_lock_sha256,
    builder_execution_definition_sha256, builder_target_manifest_sha256, builder_runner_sha256,
    builder_cleanup_worker_sha256, builder_dependency_egress_proxy_sha256,
    builder_image_reference, builder_image_id, builder_image_digest,
    source_commit_time, source_author, source_subject, accepted_at, state, queue_state,
    queue_position, created_at, updated_at
  ) VALUES (${values.map(() => '?').join(', ')})`).run(...values);
  db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run(JOB_ID, 0, NOW);
  db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES (?, 0, 'enqueue', 'queued', NULL, ?, ?)").run(JOB_ID, JSON.stringify({ requestId: `${JOB_ID}-request` }), NOW);
}

function snapshot(operationId: 'frontend-install' | 'build-image', attempt: number): CleanupSnapshot {
  return {
    runner: {
      unit: `osi-image-builder-runner@${JOB_ID}.service`,
      owner: 'runner-a',
      leaseExpiresAt: RUNNER_LEASE_EXPIRES,
      inactiveAt: RUNNER_STARTED,
      observedAt: RUNNER_STARTED,
    },
    state: 'starting',
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: ADMITTED_AT },
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: ADMITTED_AT },
    blocker: 'none',
  };
}

function requireWrite(value: { readonly ok: boolean; readonly conflict?: { readonly message: string } }): void {
  if (!value.ok) throw new Error(value.conflict?.message ?? 'ownership write failed');
}

function admitAndClaim(ownership: OwnershipStore, operationId: 'frontend-install' | 'build-image', attempt: number, admittedSnapshot: CleanupSnapshot): void {
  const runnerUnit = `osi-image-builder-runner@${JOB_ID}.service`;
  requireWrite(ownership.apiWrite({ kind: 'dispatch', jobId: JOB_ID, runnerUnit, claimOwner: 'dispatcher', claimExpiresAt: EXPIRES_AT, at: NOW }));
  requireWrite(ownership.apiWrite({ kind: 'dispatch-start', jobId: JOB_ID, runnerUnit, claimOwner: 'dispatcher', expectedClaimExpiresAt: EXPIRES_AT, claimExpiresAt: EXPIRES_AT, unitInactiveAt: RUNNER_STARTED, startAttemptedAt: RUNNER_STARTED, at: RUNNER_STARTED }));
  const runnerBase = { jobId: JOB_ID, owner: 'runner-a', runnerUnit, leaseExpiresAt: RUNNER_LEASE_EXPIRES, at: RUNNER_STARTED } as const;
  requireWrite(ownership.runnerWrite({ ...runnerBase, kind: 'acquire-lease', expiresAt: RUNNER_LEASE_EXPIRES }));
  requireWrite(ownership.runnerWrite({ ...runnerBase, kind: 'operation-begin', expectedState: 'starting', operationId, attempt, argvHash: ARGUMENTS_SHA, argv: ['dependency-egress'], startedAt: RUNNER_STARTED } as RunnerWriteCommand));
  const admission = {
    kind: 'cleanup-admission' as const,
    jobId: JOB_ID,
    admissionId: ADMISSION_ID,
    owner: 'cleanup-worker',
    unitName: `osi-image-builder-cleanup@${ADMISSION_ID}.service`,
    expiresAt: EXPIRES_AT,
    credentialRelativePath: `recovery/cleanup-credentials/${ADMISSION_ID}.token`,
    credentialSha256: CREDENTIAL_TOKEN_SHA,
    fenceTokenHash: FENCE_TOKEN_SHA,
    snapshot: admittedSnapshot,
    reservationCreatedAt: ADMITTED_AT,
    reservationExpiresAt: EXPIRES_AT,
    at: ADMITTED_AT,
  } as const;
  requireWrite(ownership.apiWrite({ kind: 'cleanup-credential-reserve', jobId: JOB_ID, admissionId: ADMISSION_ID, owner: admission.owner, credentialRelativePath: admission.credentialRelativePath, createdAt: ADMITTED_AT, expiresAt: EXPIRES_AT, at: ADMITTED_AT }));
  requireWrite(ownership.apiWrite(admission));
  requireWrite(ownership.cleanupWrite({ kind: 'claim-lease', jobId: JOB_ID, admissionId: ADMISSION_ID, owner: admission.owner, unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: FENCE_TOKEN_SHA, snapshot: admittedSnapshot, at: ADMITTED_AT }));
}

async function writeCompletion(loaded: LoadedConfig, postcondition: CleanupPostcondition): Promise<{ readonly path: string; readonly sha256: string }> {
  const directory = join(loaded.stateRoot, 'jobs', JOB_ID, 'evidence', 'cleanup');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const envelope = {
    schemaVersion: 1,
    kind: 'cleanup-complete',
    admissionId: ADMISSION_ID,
    jobId: JOB_ID,
    postcondition,
    observedAt: COMPLETE_AT,
  };
  const bytes = Buffer.from(`${encodeJson(envelope, 'cleanup completion evidence', true)}\n`, 'utf8');
  const absolutePath = join(directory, `${ADMISSION_ID}.complete.json`);
  await writeFile(absolutePath, bytes, { mode: 0o600, flag: 'wx' });
  return {
    path: `jobs/${JOB_ID}/evidence/cleanup/${ADMISSION_ID}.complete.json`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function commandResult(argv: readonly string[], stdout: string) {
  return {
    argv: [...argv],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    startedAt: NOW,
    finishedAt: NOW,
  } as const;
}

describe('physical cleanup to API recovery to ownership', () => {
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    ['credential-only', 'frontend-install' as const, 1],
    ['tls-only', 'build-image' as const, 2],
  ] as const)('completes the real %s cleanup path through canonical evidence', async (_name, operationId, attempt) => {
    const base = await mkdtemp(join(tmpdir(), 'osi-recovery-cleanup-e2e-'));
    roots.push(base);
    const loaded = await createApiConfig(base);
    const database = openBuilderDatabase(join(loaded.stateRoot, 'jobs.sqlite'));
    databases.push(database);
    seedJob(database);
    const ownership = new OwnershipStore(database, { now: () => COMPLETE_AT, stateRoot: loaded.stateRoot });
    const admittedSnapshot = snapshot(operationId, attempt);
    admitAndClaim(ownership, operationId, attempt, admittedSnapshot);

    const credentialDirectory = join(loaded.stateRoot, 'jobs', JOB_ID, 'recovery', 'dependency-egress');
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    const expectedCredential = operationId === 'frontend-install'
      ? await createDependencyEgressCredential({ directory: credentialDirectory, jobId: JOB_ID, operationId, attempt })
      : null;
    const tlsDirectory = join(credentialDirectory, `${operationId}-${String(attempt)}.proxy-tls`);
    if (expectedCredential === null) await mkdir(tlsDirectory, { mode: 0o700 });

    const identity = createTestBuilderIdentity(MANIFEST_SHA);
    const run = async (argv: readonly string[]) => {
      if (argv[1] === 'image' && argv[2] === 'inspect') {
        return commandResult(argv, `${JSON.stringify({ Id: identity.imageId, Architecture: 'amd64', Os: 'linux', RepoDigests: [identity.imageReference] })}\n`);
      }
      if (argv[1] === 'ps' || argv[1] === 'network' && argv[2] === 'ls') return commandResult(argv, '');
      throw new Error(`unexpected Docker command: ${argv.join(' ')}`);
    };
    const cleanup = createDefaultDependencyEgressCleanup({
      loaded: cleanupLoaded(loaded.stateRoot),
      stateRoot: loaded.stateRoot,
      ownerUid: process.getuid?.() ?? 0,
      dockerPath: '/usr/bin/docker',
      policy: { executor: { run } as never, env: {}, timeoutMs: 1_000 },
    });
    const job = new BuilderStore(database).getJob(JOB_ID);
    const physicalEgress = await cleanup.cleanup(job);
    expect(physicalEgress.credentials).toHaveLength(1);
    if (expectedCredential !== null) {
      expect(physicalEgress.credentials[0]).toMatchObject({ kind: 'credential-only', expectedSha256: expectedCredential.sha256, observedSha256: expectedCredential.sha256, absent: true });
    } else {
      expect(physicalEgress.credentials[0]).toMatchObject({ kind: 'tls-only', expectedSha256: null, observedSha256: null, absent: true });
    }
    await expect(readdir(credentialDirectory)).resolves.toEqual([]);

    const postcondition: CleanupPostcondition = {
      ...admittedSnapshot,
      runner: { ...admittedSnapshot.runner, inactiveAt: COMPLETE_AT, observedAt: COMPLETE_AT },
      container: { kind: 'null-identity', dockerAction: 'none', globalLabelResult: 'no-match', observedAt: COMPLETE_AT },
      staging: { kind: 'absent', path: null, sourcePath: `staging/${JOB_ID}`, sourceAbsent: true, verifiedAt: COMPLETE_AT },
      logs: { runner: 'absent', docker: 'absent', verifiedAt: COMPLETE_AT },
      egress: physicalEgress,
      blocker: 'none',
    };
    const completion = await writeCompletion(loaded, postcondition);
    const physical = createRecoveryPhysicalVerification({
      stateRootAuthority: loaded.pathAuthorities.stateRoot,
      approvedRootRegistry: loaded.pathAuthorities.approvedRoots,
      ownerUid: process.getuid?.() ?? 0,
    });
    const parsed = await physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: completion.path, sha256: completion.sha256 });
    expect(parsed.postcondition.egress).toEqual(physicalEgress);

    const completed = ownership.cleanupWrite({
      kind: 'complete',
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      owner: 'cleanup-worker',
      unitName: `osi-image-builder-cleanup@${ADMISSION_ID}.service`,
      fenceGeneration: 1,
      fenceTokenHash: FENCE_TOKEN_SHA,
      snapshot: admittedSnapshot,
      postcondition: parsed.postcondition,
      exactContainerId: null,
      containerAbsent: true,
      evidencePath: completion.path,
      evidenceSha256: completion.sha256,
      at: COMPLETE_AT,
    });
    expect(completed).toMatchObject({ ok: true, kind: 'committed' });
    expect(new BuilderStore(database).getJob(JOB_ID)).toMatchObject({
      containerId: null,
      containerName: null,
      containerSecurity: null,
    });
    expect(database.prepare('SELECT status, complete_at, completion_evidence_path, completion_evidence_sha256 FROM cleanup_leases WHERE admission_id=?').get(ADMISSION_ID)).toMatchObject({
      status: 'completed',
      complete_at: COMPLETE_AT,
      completion_evidence_path: completion.path,
      completion_evidence_sha256: completion.sha256,
    });
    expect(database.prepare("SELECT event_type FROM job_events WHERE job_id=? AND event_type='cleanup_complete'").all(JOB_ID)).toHaveLength(1);
  });
});
