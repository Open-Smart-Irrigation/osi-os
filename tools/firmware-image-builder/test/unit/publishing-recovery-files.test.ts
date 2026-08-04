import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeJson } from '../../api/src/validation.js';
import type {
  ObservedJsonEvidence,
} from '../../api/src/ownership.js';
import type { PublishingRecoveryArtifactObservation } from '../../api/src/publishing-recovery.js';
import type { JobRecord, JsonObject } from '../../api/src/store.js';
import { TEST_BUILDER_IDENTITY } from '../helpers/builder-identity.js';
import {
  loadConfig,
  type LoadedConfig,
  type PathAuthorityDependencies,
} from '../../config/load.js';
import { PIPELINE_STAGE_NAMES } from '../../domain/types.js';
import {
  createTerminalVerification,
  type TerminalVerification,
} from '../../runner/src/terminal-verification.js';
import {
  completeRecoveredPublication,
  createPublicationFiles,
  type PublicationSealingDependencies,
} from '../../runner/src/main.js';

const JOB_ID = 'recovered-publication';
const ROOT_ID = 'images';
const BRANCH = 'main';
const PINNED_SHA = 'a'.repeat(40);
const TARGET_ID = 'rpi-5';
const STAGE_STARTED_AT = '2026-07-29T11:59:00.000Z';
const AT = '2026-07-29T12:00:00.000Z';
const ARTIFACT_MTIME = '2026-07-29T11:58:00.000Z';
const ARTIFACT_BASENAME = 'firmware.img.gz';
const ARTIFACT_BYTES = Buffer.from('recovered firmware image\n', 'utf8');
const ARTIFACT_SHA256 = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');
const FINAL_DIRECTORY = `${BRANCH}/${PINNED_SHA}/${TARGET_ID}`;
const FINAL_PATH = `${FINAL_DIRECTORY}/${ARTIFACT_BASENAME}`;
const STAGING_DIRECTORY = `staging/${JOB_ID}`;
const STAGING_PATH = `${STAGING_DIRECTORY}/${ARTIFACT_BASENAME}`;
const CHECKSUM_PATH = `${STAGING_DIRECTORY}/sha256sums`;
const MANIFEST_PATH = `${STAGING_DIRECTORY}/build-manifest.json`;
const VERIFICATION_PATH = `${STAGING_DIRECTORY}/verification.json`;
const FINAL_CHECKSUM_PATH = `${FINAL_DIRECTORY}/sha256sums`;
const FINAL_MANIFEST_PATH = `${FINAL_DIRECTORY}/build-manifest.json`;
const FINAL_VERIFICATION_PATH = `${FINAL_DIRECTORY}/verification.json`;
const EVIDENCE_PATH = `jobs/${JOB_ID}/evidence/09-publish.json`;

const temporaryDirectories: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeTreeWritable(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(path, entry.name);
    await chmod(child, 0o700);
    await makeTreeWritable(child);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await makeTreeWritable(path);
    await rm(path, { recursive: true, force: true });
  }));
});

function runningVerification(): JsonObject {
  return {
    artifactSha256: ARTIFACT_SHA256,
    artifactSize: ARTIFACT_BYTES.byteLength,
    artifactMtime: ARTIFACT_MTIME,
    artifactBasename: ARTIFACT_BASENAME,
    branch: BRANCH,
    jobId: JOB_ID,
    pinnedSha: PINNED_SHA,
    rootId: ROOT_ID,
    targetId: TARGET_ID,
    observations: {
      stageEvidence: PIPELINE_STAGE_NAMES.map((stage, index) => ({
        stage,
        path: `${String(index).padStart(2, '0')}-${stage}.json`,
        outcome: index === PIPELINE_STAGE_NAMES.length - 1 ? 'running' : 'passed',
      })),
    },
  } as JsonObject;
}

function terminalVerification(): TerminalVerification {
  return createTerminalVerification(JOB_ID, runningVerification());
}

function job(): JobRecord {
  return {
    sourceRemote: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
    sourceRef: 'refs/remotes/origin/main',
    sourceBranch: BRANCH,
    branch: BRANCH,
    expectedSha: PINNED_SHA,
    pinnedSha: PINNED_SHA,
    sourceCommitTime: STAGE_STARTED_AT,
    sourceAuthor: 'test',
    sourceSubject: 'test publication recovery',
    sourcePreparation: null,
    offlineFeedPreparation: null,
    sourceRunnable: false,
    jobId: JOB_ID,
    requestId: `request-${JOB_ID}`,
    request: { branch: BRANCH, target: TARGET_ID },
    targetId: TARGET_ID,
    rootId: ROOT_ID,
    targetManifestSha256: 'b'.repeat(64),
    builderIdentity: TEST_BUILDER_IDENTITY,
    acceptedAt: STAGE_STARTED_AT,
    state: 'publishing',
    currentStage: 'publish',
    queueState: 'dispatched',
    queuePosition: null,
    cancelRequestedAt: null,
    cancelReason: null,
    cancellationCooperativeDeadlineAt: null,
    cancellationEscalationOwner: null,
    cancellationEscalationLeaseExpiresAt: null,
    cancellationStopIntentAt: null,
    cancellationGraceDeadlineAt: null,
    cancellationSignalObservation: null,
    cancellationStopObservation: null,
    cancellationInspectionObservations: null,
    cancellationClockHighWaterAt: null,
    cancellationStopAuthorizedAt: null,
    cancellationStopAuthorizedLeaseExpiresAt: null,
    dispatchedAt: STAGE_STARTED_AT,
    runnerUnit: `osi-image-builder-runner@${JOB_ID}.service`,
    runnerLeaseOwner: 'runner-owner',
    runnerLeaseExpiresAt: '2026-07-29T11:59:30.000Z',
    containerId: null,
    containerName: null,
    containerImageDigest: null,
    containerLabelJobId: null,
    containerLabelManifestSha: null,
    containerLabels: null,
    containerMount: null,
    containerEnvironment: null,
    containerSecurity: null,
    containerInspection: null,
    containerCreatedAt: null,
    containerStartedAt: null,
    containerStoppedAt: null,
    containerRemovedAt: null,
    containerCleanupOutcome: null,
    cleanupBlockerCode: null,
    cleanupBlocker: null,
    terminalErrorCode: null,
    terminalError: null,
    terminalAt: null,
    artifactStagingPath: STAGING_PATH,
    artifactQuarantinePath: null,
    artifactQuarantineIntentPath: `.osi-image-builder/quarantine/${JOB_ID}`,
    artifactFinalDirectory: FINAL_DIRECTORY,
    artifactFinalPath: FINAL_PATH,
    artifactSha256: ARTIFACT_SHA256,
    artifactSize: ARTIFACT_BYTES.byteLength,
    artifactMtime: ARTIFACT_MTIME,
    checksumPath: CHECKSUM_PATH,
    checksumSha256: sha256(`${ARTIFACT_SHA256}  ${ARTIFACT_BASENAME}\n`),
    manifestPath: MANIFEST_PATH,
    manifestSha256: 'c'.repeat(64),
    verificationPath: VERIFICATION_PATH,
    verificationSha256: 'd'.repeat(64),
    publishState: 'publishing',
    releaseSealStatus: 'in_progress',
    publishStartedAt: STAGE_STARTED_AT,
    publishedAt: null,
    publishBlockerCode: null,
    publishBlocker: null,
    freshnessStatus: null,
    freshnessObservedSha: null,
    newerSourceAvailable: null,
    freshnessRequestedAt: null,
    freshnessCheckedAt: null,
    freshnessErrorCode: null,
    freshnessError: null,
    freshnessErrorEvidencePath: null,
    freshnessErrorEvidenceSha256: null,
  } as JobRecord;
}

async function fixture(options: Readonly<{
  readonly pathAuthorityDependencies?: Partial<PathAuthorityDependencies>;
}> = {}): Promise<{
  readonly base: string;
  readonly loaded: LoadedConfig;
  readonly persistedJob: JobRecord;
  readonly manifestBytes: string;
  readonly runningBytes: string;
  readonly terminal: TerminalVerification;
  readonly paths: Readonly<{
    readonly outputRoot: string;
    readonly finalDirectory: string;
    readonly finalVerification: string;
    readonly evidence: string;
  }>;
}> {
  const base = await mkdtemp(join(tmpdir(), 'osi-builder-publish-files-'));
  temporaryDirectories.push(base);
  const configHome = join(base, 'config');
  const stateHome = join(base, 'state');
  const repositoryPath = join(base, 'repository');
  const outputRoot = join(base, 'images');
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  await mkdir(repositoryPath, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const configPath = join(configHome, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [{ id: ROOT_ID, label: 'Images', path: outputRoot }],
    builderLockPath: '/opt/osi-image-builder/2026.07.29/builder.lock.json',
  }), { mode: 0o600 });
  const loaded = await loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    git: {
      getOriginPolicy: async () => ({
        url: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
        fetchRefspec: '+refs/heads/*:refs/remotes/origin/*',
      }),
    },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    pathAuthorityDependencies: options.pathAuthorityDependencies,
  });

  const finalDirectory = join(outputRoot, FINAL_DIRECTORY);
  await mkdir(finalDirectory, { recursive: true, mode: 0o750 });
  await chmod(finalDirectory, 0o700);
  await writeFile(join(finalDirectory, ARTIFACT_BASENAME), ARTIFACT_BYTES, { mode: 0o600 });
  await utimes(join(finalDirectory, ARTIFACT_BASENAME), new Date(ARTIFACT_MTIME), new Date(ARTIFACT_MTIME));
  const checksumBytes = `${ARTIFACT_SHA256}  ${ARTIFACT_BASENAME}\n`;
  const manifest = {
    artifactBasename: ARTIFACT_BASENAME,
    artifactMtime: ARTIFACT_MTIME,
    artifactSha256: ARTIFACT_SHA256,
    artifactSize: ARTIFACT_BYTES.byteLength,
    branch: BRANCH,
    jobId: JOB_ID,
    pinnedSha: PINNED_SHA,
    rootId: ROOT_ID,
    targetId: TARGET_ID,
  };
  const manifestBytes = encodeJson(manifest, 'build manifest fixture', true);
  const terminal = terminalVerification();
  const runningBytes = encodeJson(runningVerification(), 'running verification fixture', true);
  await writeFile(join(finalDirectory, 'sha256sums'), checksumBytes, { mode: 0o600 });
  await writeFile(join(finalDirectory, 'build-manifest.json'), manifestBytes, { mode: 0o600 });
  await writeFile(join(finalDirectory, 'verification.json'), runningBytes, { mode: 0o600 });

  const persistedJob = {
    ...job(),
    checksumSha256: sha256(checksumBytes),
    manifestSha256: sha256(manifestBytes),
    verificationSha256: sha256(runningBytes),
  } as JobRecord;
  await mkdir(join(outputRoot, '.osi-image-builder', 'staging'), { recursive: true, mode: 0o750 });

  return {
    base,
    loaded,
    persistedJob,
    manifestBytes,
    runningBytes,
    terminal,
    paths: {
      outputRoot,
      finalDirectory,
      finalVerification: join(finalDirectory, 'verification.json'),
      evidence: join(loaded.stateRoot, EVIDENCE_PATH),
    },
  };
}

function logs(verifiedAt = AT) {
  return {
    runner: 'sealed' as const,
    docker: 'sealed' as const,
    verifiedAt,
    noGap: true as const,
  };
}

async function finalizationInput(value: Awaited<ReturnType<typeof fixture>>) {
  const root = await stat(value.paths.outputRoot);
  const artifact = {
    stagingPath: value.persistedJob.artifactStagingPath!,
    artifactSha256: value.persistedJob.artifactSha256!,
    artifactSize: value.persistedJob.artifactSize!,
    artifactMtime: value.persistedJob.artifactMtime!,
    checksumPath: value.persistedJob.checksumPath!,
    checksumSha256: value.persistedJob.checksumSha256!,
    manifestPath: value.persistedJob.manifestPath!,
    manifestSha256: value.persistedJob.manifestSha256!,
    verificationPath: value.persistedJob.verificationPath!,
    verificationSha256: value.persistedJob.verificationSha256!,
  };
  const binding = {
    jobId: value.persistedJob.jobId,
    rootId: value.persistedJob.rootId,
    rootPath: value.paths.outputRoot,
    rootDevice: root.dev,
    rootInode: root.ino,
    branch: value.persistedJob.branch,
    branchSlug: BRANCH,
    pinnedSha: value.persistedJob.pinnedSha,
    targetId: value.persistedJob.targetId,
    stagingDirectory: STAGING_DIRECTORY,
    stagingPath: artifact.stagingPath,
    finalDirectory: FINAL_DIRECTORY,
    finalPath: FINAL_PATH,
    artifactSha256: artifact.artifactSha256,
    artifactSize: artifact.artifactSize,
  } as const;
  return {
    binding,
    artifact,
    verificationManifest: value.terminal.manifest,
    verificationManifestBytes: value.terminal.bytes,
    publishEvidencePath: EVIDENCE_PATH,
    publishEvidenceSha256: sha256('publish evidence'),
  } as const;
}

function expectedStageEvidence(
  persistedJob: JobRecord,
  manifestBytes: string,
  manifestContent: JsonObject,
  terminal: TerminalVerification,
  terminalVerificationSha256: string,
): ObservedJsonEvidence {
  const content = {
    schemaVersion: 1,
    jobId: JOB_ID,
    stage: 'publish',
    startedAt: STAGE_STARTED_AT,
    finishedAt: AT,
    outcome: 'passed',
    operationId: null,
    commands: [],
    inputs: {
      branch: BRANCH,
      pinnedSha: PINNED_SHA,
      rootId: ROOT_ID,
      targetId: TARGET_ID,
    },
    observations: {
      checksum: {
        present: true,
        path: FINAL_CHECKSUM_PATH,
        contents: `${ARTIFACT_SHA256}  ${ARTIFACT_BASENAME}\n`,
        sha256: persistedJob.checksumSha256,
      },
      final: { verificationSha256: terminalVerificationSha256 },
      logs: logs(),
      manifest: {
        present: true,
        path: FINAL_MANIFEST_PATH,
        bytes: manifestBytes,
        content: manifestContent,
        sha256: persistedJob.manifestSha256,
      },
      staging: { state: 'absent', path: null, sha256: null, size: null, held: false },
      verification: {
        present: true,
        path: FINAL_VERIFICATION_PATH,
        bytes: terminal.bytes,
        content: terminal.manifest,
        sha256: terminalVerificationSha256,
      },
    },
    error: null,
  };
  const bytes = `${encodeJson(content, 'expected publish evidence', true)}\n`;
  return {
    present: true,
    path: EVIDENCE_PATH,
    bytes,
    sha256: sha256(bytes),
  };
}

describe('recovered publication filesystem completion', () => {
  it('writes exact publish evidence, atomically promotes verification, and returns held observations', async () => {
    const value = await fixture();
    const result = await completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    });
    const manifestContent = JSON.parse(value.manifestBytes) as JsonObject;
    const expected = expectedStageEvidence(
      value.persistedJob,
      value.manifestBytes,
      manifestContent,
      value.terminal,
      sha256(value.terminal.bytes),
    );

    expect(result.stageEvidence).toEqual(expected);
    expect(await readFile(value.paths.evidence, 'utf8')).toBe(expected.bytes);
    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.terminal.bytes);
    expect(await readdir(value.paths.finalDirectory)).toEqual([
      'build-manifest.json',
      ARTIFACT_BASENAME,
      'sha256sums',
      'verification.json',
    ]);
    expect(result.observed).toEqual<PublishingRecoveryArtifactObservation>({
      final: {
        present: true,
        path: FINAL_PATH,
        held: true,
        size: ARTIFACT_BYTES.byteLength,
        sha256: ARTIFACT_SHA256,
      },
      checksum: {
        present: true,
        path: FINAL_CHECKSUM_PATH,
        contents: `${ARTIFACT_SHA256}  ${ARTIFACT_BASENAME}\n`,
        sha256: value.persistedJob.checksumSha256,
      },
      manifest: {
        present: true,
        path: FINAL_MANIFEST_PATH,
        bytes: await readFile(join(value.paths.finalDirectory, 'build-manifest.json'), 'utf8'),
        content: JSON.parse(await readFile(join(value.paths.finalDirectory, 'build-manifest.json'), 'utf8')),
        sha256: value.persistedJob.manifestSha256,
      },
      verification: {
        present: true,
        path: FINAL_VERIFICATION_PATH,
        bytes: value.terminal.bytes,
        content: value.terminal.manifest,
        sha256: sha256(value.terminal.bytes),
      },
      staging: { state: 'absent', path: null, sha256: null, size: null, held: false },
      quarantine: {
        state: 'absent',
        path: null,
        held: false,
        artifactPath: null,
        artifactSize: null,
        artifactSha256: null,
      },
    });
    expect((await stat(value.paths.finalDirectory)).mode & 0o777).toBe(0o555);
    for (const name of [ARTIFACT_BASENAME, 'sha256sums', 'build-manifest.json', 'verification.json']) {
      expect((await stat(join(value.paths.finalDirectory, name))).mode & 0o777).toBe(0o444);
    }
  });

  it('seals the normal runner publication before returning and makes sealing idempotent', async () => {
    const value = await fixture();
    const finalizeVerification = createPublicationFiles(value.loaded, () => {
      throw new Error('workspace is not needed for final publication sealing');
    }).finalizeVerification;
    const input = await finalizationInput(value);

    await finalizeVerification(input);
    await finalizeVerification(input);

    expect((await stat(value.paths.finalDirectory)).mode & 0o777).toBe(0o555);
    for (const name of [ARTIFACT_BASENAME, 'sha256sums', 'build-manifest.json', 'verification.json']) {
      expect((await stat(join(value.paths.finalDirectory, name))).mode & 0o777).toBe(0o444);
    }
  });

  it('rejects a canonical named-inode replacement after the held artifact is chmodded and synced', async () => {
    const value = await fixture();
    let replaced = false;
    const finalizeVerification = createPublicationFiles(value.loaded, () => {
      throw new Error('workspace is not needed for final publication sealing');
    }, {
      afterFileSync: async (name) => {
        if (name !== ARTIFACT_BASENAME || replaced) return;
        replaced = true;
        const artifactPath = join(value.paths.finalDirectory, ARTIFACT_BASENAME);
        await unlink(artifactPath);
        await writeFile(artifactPath, ARTIFACT_BYTES, { mode: 0o444 });
        await utimes(artifactPath, new Date(ARTIFACT_MTIME), new Date(ARTIFACT_MTIME));
      },
    }).finalizeVerification;

    await expect(finalizeVerification(await finalizationInput(value))).rejects.toThrow(/inode|canonical|metadata/i);
    expect(replaced).toBe(true);
  });

  it('rejects a member injected after sealing but before canonical revalidation', async () => {
    const value = await fixture();
    let injected = false;

    await expect(completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
      sealingDependencies: {
        beforeCanonicalRevalidation: async () => {
          injected = true;
          await chmod(value.paths.finalDirectory, 0o700);
          await writeFile(join(value.paths.finalDirectory, 'injected.txt'), 'unexpected\n', { mode: 0o600 });
          await chmod(value.paths.finalDirectory, 0o555);
        },
      },
    })).rejects.toThrow(/member|directory|release/i);

    expect(injected).toBe(true);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects replacement of the approved root pathname after sealing', async () => {
    const value = await fixture();
    const displacedRoot = `${value.paths.outputRoot}.displaced`;
    let replaced = false;

    await expect(completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
      sealingDependencies: {
        beforeCanonicalRevalidation: async () => {
          replaced = true;
          await rename(value.paths.outputRoot, displacedRoot);
          await mkdir(value.paths.outputRoot, { mode: 0o700 });
        },
      },
    })).rejects.toThrow(/root|authority|identity/i);

    expect(replaced).toBe(true);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      label: 'named inode replacement',
      mutate: async (value: Awaited<ReturnType<typeof fixture>>) => {
        const artifactPath = join(value.paths.finalDirectory, ARTIFACT_BASENAME);
        await chmod(value.paths.finalDirectory, 0o700);
        await unlink(artifactPath);
        await writeFile(artifactPath, ARTIFACT_BYTES, { mode: 0o444 });
        await utimes(artifactPath, new Date(ARTIFACT_MTIME), new Date(ARTIFACT_MTIME));
        await chmod(value.paths.finalDirectory, 0o555);
      },
    },
    {
      label: 'tracked file mode drift',
      mutate: async (value: Awaited<ReturnType<typeof fixture>>) => {
        await chmod(join(value.paths.finalDirectory, ARTIFACT_BASENAME), 0o600);
      },
    },
    {
      label: 'late directory member',
      mutate: async (value: Awaited<ReturnType<typeof fixture>>) => {
        await chmod(value.paths.finalDirectory, 0o700);
        await writeFile(join(value.paths.finalDirectory, 'late-member.txt'), 'late member\n', { mode: 0o600 });
        await chmod(value.paths.finalDirectory, 0o555);
      },
    },
  ])('rejects $label at the final canonical identity boundary', async ({ mutate }) => {
    const value = await fixture();
    let injected = false;

    await expect(completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
      sealingDependencies: {
        beforeFinalCanonicalIdentityWalk: async () => {
          injected = true;
          await mutate(value);
        },
      },
    })).rejects.toThrow(/inode|mode|member|metadata|canonical|sealed/i);

    expect(injected).toBe(true);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adopts exact persisted evidence across a later clock and regenerated log proof', async () => {
    const value = await fixture();
    const input = {
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    };

    const first = await completeRecoveredPublication(input);
    const firstEvidence = await readFile(value.paths.evidence, 'utf8');
    const firstVerification = await readFile(value.paths.finalVerification, 'utf8');
    const second = await completeRecoveredPublication({
      ...input,
      at: '2026-07-29T12:05:00.000Z',
      logs: logs('2026-07-29T12:05:00.000Z'),
    });

    expect(second.stageEvidence).toEqual(first.stageEvidence);
    expect(second.observed).toEqual(first.observed);
    expect(await readFile(value.paths.evidence, 'utf8')).toBe(firstEvidence);
    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(firstVerification);
  });

  it('retries after a crash following verification rename and fsyncs again on an already-terminal retry', async () => {
    let syncAttempts = 0;
    const value = await fixture({
      pathAuthorityDependencies: {
        beforeDirectorySync: async () => {
          syncAttempts += 1;
          if (syncAttempts === 1) throw new Error('injected crash after verification rename');
        },
      },
    });
    const input = {
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    };

    await expect(completeRecoveredPublication(input)).rejects.toThrow('injected crash after verification rename');
    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.terminal.bytes);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });

    await completeRecoveredPublication(input);
    const afterRecovery = syncAttempts;
    await completeRecoveredPublication({
      ...input,
      at: '2026-07-29T12:05:00.000Z',
      logs: logs('2026-07-29T12:05:00.000Z'),
    });

    expect(syncAttempts).toBe(afterRecovery + 1);
    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.terminal.bytes);
  });

  it.each([
    { label: 'terminal bytes', bytes: null },
    { label: 'partial bytes', bytes: '{"schema_version":1' },
  ])('recovers an owned deterministic verification temp with $label', async ({ bytes }) => {
    const value = await fixture();
    const temporaryPath = join(value.paths.finalDirectory, `.verification-${JOB_ID}.tmp`);
    await writeFile(temporaryPath, bytes ?? value.terminal.bytes, { mode: 0o600 });

    await completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    });

    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.terminal.bytes);
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(value.paths.finalDirectory)).toEqual([
      'build-manifest.json',
      ARTIFACT_BASENAME,
      'sha256sums',
      'verification.json',
    ]);
  });

  it('rejects a deterministic verification temp with a non-recoverable mode', async () => {
    const value = await fixture();
    const temporaryPath = join(value.paths.finalDirectory, `.verification-${JOB_ID}.tmp`);
    await writeFile(temporaryPath, value.terminal.bytes, { mode: 0o640 });

    await expect(completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    })).rejects.toThrow(/temporary|verification|mode|candidate/i);

    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.runningBytes);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers after a crash once partial verification temp removal is durable', async () => {
    const value = await fixture();
    const temporaryPath = join(value.paths.finalDirectory, `.verification-${JOB_ID}.tmp`);
    await writeFile(temporaryPath, '{"schema_version":1', { mode: 0o600 });
    let injected = false;
    const sealingDependencies: PublicationSealingDependencies = {
      afterVerificationTempRemovalSync: () => {
        if (injected) return;
        injected = true;
        throw new Error('injected crash after verification temp removal sync');
      },
    };
    const input = {
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
      sealingDependencies,
    } as const;

    await expect(completeRecoveredPublication(input)).rejects.toThrow(
      'injected crash after verification temp removal sync',
    );
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.runningBytes);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });

    await completeRecoveredPublication(input);
    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.terminal.bytes);
    expect((await stat(value.paths.finalDirectory)).mode & 0o777).toBe(0o555);
  });

  it('rejects a non-deterministic verification temp as an untracked member', async () => {
    const value = await fixture();
    await writeFile(
      join(value.paths.finalDirectory, `.verification-${JOB_ID}-random.tmp`),
      value.terminal.bytes,
      { mode: 0o600 },
    );

    await expect(completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    })).rejects.toThrow(/member|directory|release/i);

    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.runningBytes);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers after a crash once the deterministic verification temp is durable', async () => {
    const value = await fixture();
    let injected = false;
    const sealingDependencies: PublicationSealingDependencies = {
      afterVerificationTempSync: () => {
        if (injected) return;
        injected = true;
        throw new Error('injected crash after verification temp sync');
      },
    };
    const input = {
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
      sealingDependencies,
    } as const;
    const temporaryPath = join(value.paths.finalDirectory, `.verification-${JOB_ID}.tmp`);

    await expect(completeRecoveredPublication(input)).rejects.toThrow('injected crash after verification temp sync');
    expect(await readFile(temporaryPath, 'utf8')).toBe(value.terminal.bytes);
    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.runningBytes);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });

    await completeRecoveredPublication(input);
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(value.paths.finalDirectory)).mode & 0o777).toBe(0o555);
  });

  it.each([
    'afterFileChmod',
    'afterFileSync',
    'afterDirectoryChmod',
    'afterDirectorySync',
  ] as const)('recovers a publication interrupted at the %s boundary', async (boundary) => {
    const value = await fixture();
    let injected = false;
    const failOnce = () => {
      if (injected) return;
      injected = true;
      throw new Error(`injected crash at ${boundary}`);
    };
    const sealingDependencies = { [boundary]: failOnce } as PublicationSealingDependencies;
    const input = {
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
      sealingDependencies,
    } as const;

    await expect(completeRecoveredPublication(input)).rejects.toThrow(`injected crash at ${boundary}`);
    expect(injected).toBe(true);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
    const interruptedDirectoryMode = (await stat(value.paths.finalDirectory)).mode & 0o777;
    const interruptedFileModes = await Promise.all(
      [ARTIFACT_BASENAME, 'sha256sums', 'build-manifest.json', 'verification.json']
        .map(async (name) => (await stat(join(value.paths.finalDirectory, name))).mode & 0o777),
    );
    if (interruptedDirectoryMode === 0o700) {
      expect(interruptedFileModes.every((mode) => mode === 0o600 || mode === 0o444)).toBe(true);
    } else {
      expect(interruptedDirectoryMode).toBe(0o555);
      expect(interruptedFileModes).toEqual([0o444, 0o444, 0o444, 0o444]);
    }

    await completeRecoveredPublication(input);
    expect((await stat(value.paths.finalDirectory)).mode & 0o777).toBe(0o555);
    for (const name of [ARTIFACT_BASENAME, 'sha256sums', 'build-manifest.json', 'verification.json']) {
      expect((await stat(join(value.paths.finalDirectory, name))).mode & 0o777).toBe(0o444);
    }
    await expect(access(value.paths.evidence)).resolves.toBeUndefined();
  });

  it('rejects an existing evidence file whose durable log binding is incomplete', async () => {
    const value = await fixture();
    const input = {
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    };
    await completeRecoveredPublication(input);

    const stored = JSON.parse(await readFile(value.paths.evidence, 'utf8')) as {
      observations: { logs: { noGap: boolean } };
    };
    stored.observations.logs.noGap = false;
    await writeFile(value.paths.evidence, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

    await expect(completeRecoveredPublication({
      ...input,
      at: '2026-07-29T12:05:00.000Z',
      logs: logs('2026-07-29T12:05:00.000Z'),
    })).rejects.toThrow(/logs|binding|incomplete/i);
  });

  it('does not publish passed evidence before terminal verification can be replaced', async () => {
    const value = await fixture();
    await chmod(value.paths.finalDirectory, 0o500);
    try {
      await expect(completeRecoveredPublication({
        loaded: value.loaded,
        job: value.persistedJob,
        stageStartedAt: STAGE_STARTED_AT,
        at: AT,
        logs: logs(),
      })).rejects.toThrow();
      await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(value.paths.finalVerification, 'utf8')).resolves.toBe(value.runningBytes);
    } finally {
      await chmod(value.paths.finalDirectory, 0o700);
    }
  });

  it('rejects an untracked final-directory member before changing verification or evidence', async () => {
    const value = await fixture();
    await writeFile(join(value.paths.finalDirectory, 'unexpected.txt'), 'not release evidence\n', { mode: 0o600 });

    await expect(completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    })).rejects.toThrow(/member|directory|release/i);

    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.runningBytes);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a mismatched final artifact without mutating verification or evidence', async () => {
    const value = await fixture();
    await writeFile(join(value.paths.finalDirectory, ARTIFACT_BASENAME), Buffer.from('tampered image\n'), { mode: 0o600 });

    await expect(completeRecoveredPublication({
      loaded: value.loaded,
      job: value.persistedJob,
      stageStartedAt: STAGE_STARTED_AT,
      at: AT,
      logs: logs(),
    })).rejects.toThrow(/artifact|mismatch|persisted/i);

    expect(await readFile(value.paths.finalVerification, 'utf8')).toBe(value.runningBytes);
    await expect(access(value.paths.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(value.paths.finalVerification)).isFile()).toBe(true);
  });
});
