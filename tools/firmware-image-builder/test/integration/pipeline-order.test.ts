import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OwnershipStore,
  type OwnershipResult,
  type RunnerWriteCommand,
} from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import {
  BuilderStore,
  type JobRecord,
  type JsonObject,
  type OperationInput,
  type StoredStage,
} from '../../api/src/store.js';
import { loadConfig } from '../../config/load.js';
import {
  PIPELINE_STAGE_NAMES,
  type BuilderErrorCode,
  type JobState,
  type PipelineStageName,
  type TrustedOperationId,
} from '../../domain/types.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import { loadManifest } from '../../manifest/validate.js';
import type { TargetManifest } from '../../manifest/schema.js';
import {
  createPipeline,
  type PipelineLease,
  type PipelineInput,
  type PipelineOperationExecution,
  type PreparedPublication,
  type StageActionContext,
} from '../../runner/src/pipeline.js';
import { runGuardedComposition, runRunner } from '../../runner/src/main.js';
import { createEvidenceWriter } from '../../runner/src/evidence.js';
import { createOperationDefinition, hashOperationDefinition } from '../../runner/src/operation-registry.js';
import {
  classifyTargetSetupOperationResult,
  createTargetSetupConfigObservations,
  createTargetSetupSourceObservations,
} from '../../runner/src/target-setup.js';
import { verifyTargetSetupConfiguration } from '../../runner/src/verification.js';
import type { PublisherClient, PublisherResponse } from '../../publisher/client.js';

const SHA40 = 'a'.repeat(40);
const HASH_A = 'b'.repeat(64);
const HASH_B = 'c'.repeat(64);
const HASH_C = 'd'.repeat(64);
const ACCEPTED = '2026-07-26T08:00:00.000Z';
const ROOTFS_ALREADY_PRESENT = [
  'Applying patch patches/image-with-padded-rootfs.patch',
  'patching file target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh',
  'Hunk #1 FAILED at 24.',
  '1 out of 1 hunk FAILED -- rejects in file target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh',
  'Patch patches/image-with-padded-rootfs.patch can be reverse-applied',
  '',
].join('\n');
const execFile = promisify(execFileCallback);
const SOURCE_PREPARATION = Object.freeze({
  schemaVersion: 1 as const,
  sourceSha: SHA40,
  gitmodulesBlobSha: 'e'.repeat(40),
  preparedAt: ACCEPTED,
  components: Object.freeze([
    Object.freeze({
      path: 'feeds/chirpstack-openwrt-feed' as const,
      mode: '040000' as const,
      type: 'tree' as const,
      objectId: 'f'.repeat(40),
      provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git',
    }),
    Object.freeze({
      path: 'openwrt' as const,
      mode: '040000' as const,
      type: 'tree' as const,
      objectId: '1'.repeat(40),
      provenanceUrl: 'https://github.com/openwrt/openwrt.git',
    }),
  ]),
});
const LOCK = Object.freeze({
  schemaVersion: 1 as const,
  packageVersion: '0.7.0',
  imageRepository: 'registry.example.test/osi/builder',
  imageDigest: '2'.repeat(64),
  baseImage: `debian@sha256:${'3'.repeat(64)}`,
  baseImageDigest: '3'.repeat(64),
  dockerfileSha256: '4'.repeat(64),
  packageSet: Object.freeze([
    'gcc-14',
    'nodejs',
    'npm',
    'openwrt-build-tools',
    'llvm-dev',
    'libpolly-19-dev',
    'libzstd-dev',
  ]),
  rustConfig: Object.freeze({
    llvmConfig: '/usr/bin/llvm-config',
    channel: 'stable',
    version: '1.88.0',
    llvmMajor: 19,
  }),
  nodeVersion: '22.14.0',
  executionDefinitionSha256: '5'.repeat(64),
  validationEvidenceSha256: '6'.repeat(64),
  installable: true,
});
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

class AdvancingClock {
  #value = Date.parse('2026-07-26T08:01:00.000Z');

  now = (): string => {
    const value = new Date(this.#value).toISOString();
    this.#value += 1_000;
    return value;
  };

  advance(milliseconds: number): void {
    this.#value += milliseconds;
  }
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function configBytes(target: TargetManifest, kind: 'source' | 'resolved'): Buffer {
  const lines = target.configSymbols.map((symbol) => {
    if (symbol.type === 'bool') {
      return symbol.value ? `${symbol.name}=y` : `# ${symbol.name} is not set`;
    }
    return `${symbol.name}=${symbol.type === 'string' ? JSON.stringify(symbol.value) : String(symbol.value)}`;
  });
  return Buffer.from(`${lines.join('\n')}\n# ${kind} profile evidence\n`);
}

function operationState(stage: PipelineStageName): JobState {
  return {
    preflight: 'preflight',
    source: 'source',
    'release-gates': 'release_gates',
    frontend: 'frontend',
    'target-setup': 'target_setup',
    feeds: 'feeds',
    config: 'config',
    build: 'building',
    verify: 'verifying',
    publish: 'publishing',
  }[stage] as JobState;
}

interface Fixture {
  readonly directory: string;
  readonly statePath: string;
  readonly store: BuilderStore;
  readonly ownership: OwnershipStore;
  readonly clock: AdvancingClock;
  readonly input: PipelineInput;
  readonly operationOrder: TrustedOperationId[];
  readonly workspaceChecks: Array<readonly [PipelineStageName, 'before' | 'after']>;
  readonly publishedMetadata: Array<Readonly<{ build: JsonObject; verification: JsonObject }>>;
  readonly publicationPreparationStages: Array<StoredStage | null>;
  readonly verifiedTargetEvidence: readonly unknown[];
  readonly sourceObservations: ReturnType<typeof createTargetSetupSourceObservations>;
  readonly configObservations: ReturnType<typeof createTargetSetupConfigObservations>;
  close(): void;
}

async function fixture(options: {
  readonly failOperation?: TrustedOperationId;
  readonly failStage?: 'preflight' | 'feeds' | 'config';
  readonly throwOperation?: TrustedOperationId;
  readonly failSource?: boolean;
  readonly publisher?: Partial<PublisherClient>;
  readonly tamperMetadata?: 'manifest' | 'verification' | 'checksum';
  readonly tamperFinalProof?: boolean;
  readonly mutateJob?: (job: JobRecord) => JobRecord;
  readonly operationHook?: (operationId: TrustedOperationId, clock: AdvancingClock) => void;
  readonly rejectOwnershipWrite?: RunnerWriteCommand['kind'];
  readonly expectedPatchAlreadyPresent?: boolean;
  readonly publicationBindingMismatch?: boolean;
  readonly workspaceFailureAt?: Readonly<{
    stage: PipelineStageName;
    phase: 'before' | 'after';
  }>;
  readonly verifyProducedTargetEvidence?: boolean;
  readonly predictPublishPassed?: boolean;
} = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-pipeline-order-'));
  temporaryDirectories.push(directory);
  const repository = join(directory, 'repository');
  const images = join(directory, 'images');
  const configHome = join(directory, 'config');
  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(images, { recursive: true }),
    mkdir(configHome, { recursive: true }),
  ]);
  const configPath = join(configHome, 'config.json');
  const lockPath = join(directory, 'installed', LOCK.packageVersion, 'builder.lock.json');
  await mkdir(join(directory, 'installed', LOCK.packageVersion), { recursive: true });
  await writeFile(lockPath, canonical(LOCK));
  await writeFile(configPath, JSON.stringify({
    repositoryPath: repository,
    approvedOutputRoots: [{ id: 'release', label: 'Release', path: images }],
    builderLockPath: lockPath,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath,
    env: {
      HOME: directory,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(directory, 'state-home'),
    },
    git: {
      getOriginPolicy: async () => ({
        url: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
        fetchRefspec: '+refs/heads/*:refs/remotes/origin/*',
      }),
    },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
  });
  const statePath = loaded.stateRoot;
  const database = openBuilderDatabase(join(statePath, 'jobs.sqlite'));
  const ownership = new OwnershipStore(database, { now: () => ACCEPTED });
  const store = new BuilderStore(database);
  const manifestPath = new URL('../../manifest/targets.json', import.meta.url);
  const manifest = loadManifest(manifestPath.pathname);
  const jobId = 'job-pipeline-order';
  const runnerUnit = `osi-image-builder-runner@${jobId}.service`;
  const offlineFeedPreparation = {
    schemaVersion: 1,
    boundary: 'api-prepared-pinned-feeds-v1',
    networkPolicy: 'runner-offline',
    jobId,
    sourceSha: SHA40,
    preparedAt: ACCEPTED,
    feeds: [
      ['packages', 'https://git.openwrt.org/feed/packages.git', 'd8cd30f4e281d6853b3de134c4f147a807583e43'],
      ['luci', 'https://git.openwrt.org/project/luci.git', '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8'],
      ['routing', 'https://git.openwrt.org/feed/routing.git', 'c9b636698881059a3c981032770968f5a98ff201'],
    ].map(([name, location, commit]) => ({
      name,
      location,
      commit,
      detached: true,
      clean: true,
      recursiveSubmodulesPrepared: true,
      recursiveSubmodules: [],
      recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      treeSha256: HASH_A,
    })),
  };
  const request = {
    branch: 'design/agrolink',
    targetId: 'rpi-5',
    rootId: 'release',
    offlineFeedPreparation,
    outputRootIdentity: { device: 1, inode: 2 },
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO jobs (
      job_id, request_id, request_json, source_remote, source_ref,
      source_branch, branch, expected_sha, pinned_sha, source_preparation_json,
      offline_feed_preparation_json, target_id, root_id, target_manifest_sha256,
      source_commit_time, source_author, source_subject, accepted_at, state,
      queue_state, queue_position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued',
      'queued', 0, ?, ?)`).run(
      jobId,
      'request-pipeline-order',
      canonical(request),
      'git@github.com:Open-Smart-Irrigation/osi-os.git',
      'refs/remotes/origin/design/agrolink',
      'design/agrolink',
      'design/agrolink',
      SHA40,
      SHA40,
      canonical(SOURCE_PREPARATION),
      canonical(offlineFeedPreparation),
      'rpi-5',
      'release',
      manifest.sha256,
      ACCEPTED,
      'Builder <builder@example.test>',
      'Pipeline fixture',
      ACCEPTED,
      ACCEPTED,
      ACCEPTED,
    );
    database.prepare(
      'INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, 0, ?)',
    ).run(jobId, ACCEPTED);
    database.prepare(`INSERT INTO job_events (
      job_id, seq, event_type, state, stage, payload_json, at
    ) VALUES (?, 0, 'enqueue', 'queued', NULL, ?, ?)`).run(
      jobId,
      canonical({ requestId: 'request-pipeline-order' }),
      ACCEPTED,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  expect(ownership.apiWrite({
    kind: 'dispatch',
    jobId,
    runnerUnit,
    at: '2026-07-26T08:00:10.000Z',
  }).ok).toBe(true);

  const clock = new AdvancingClock();
  const evidenceWriter = createEvidenceWriter({
    stateRoot: loaded.pathAuthorities.stateRoot,
  });
  const operationOrder: TrustedOperationId[] = [];
  const workspaceChecks: Array<readonly [
    PipelineStageName,
    'before' | 'after',
  ]> = [];
  const operationAttempts = new Map<TrustedOperationId, number>();
  const publishedMetadata: Array<Readonly<{ build: JsonObject; verification: JsonObject }>> = [];
  const publicationPreparationStages: Array<StoredStage | null> = [];
  const verifiedTargetEvidence: unknown[] = [];
  let prepared: PreparedPublication | null = null;

  const write = (command: RunnerWriteCommand): void => {
    let result;
    try {
      result = ownership.runnerWrite(command);
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error
        ? `${error.cause.name}: ${error.cause.message}`
        : 'no nested error';
      throw new Error(`${command.kind} threw: ${cause}`, { cause: error });
    }
    if (!result.ok) throw new Error(`operation ownership failed: ${result.conflict.kind}`);
  };

  const operations = {
    run: async (
      context: StageActionContext,
      operationId: TrustedOperationId,
    ): Promise<PipelineOperationExecution> => {
      operationOrder.push(operationId);
      options.operationHook?.(operationId, clock);
      if (options.throwOperation === operationId) {
        throw new Error('injected operation exception');
      }
      const attempt = (operationAttempts.get(operationId) ?? 0) + 1;
      operationAttempts.set(operationId, attempt);
      const definition = createOperationDefinition(operationId, {
        environment: context.target.environment,
      });
      const startedAt = clock.now();
      write({
        kind: 'operation-begin',
        jobId,
        owner: context.lease.owner,
        runnerUnit: context.lease.runnerUnit,
        leaseExpiresAt: context.lease.expiresAt,
        at: startedAt,
        expectedState: operationState(context.stage),
        operationId,
        attempt,
        argvHash: hashOperationDefinition(definition),
        argv: definition.argv,
        startedAt,
      });
      const containerId = `container-${operationId}-${attempt}`;
      const containerName = `osi-${jobId}-${operationId}-${attempt}`;
      const labels = {
        'org.osi.image-builder.job-id': jobId,
        'org.osi.image-builder.manifest-sha': manifest.sha256,
      };
      const mount = {
        type: 'bind',
        source: repository,
        destination: '/workdir',
        readOnly: false,
      };
      const environment = { SOURCE_DATE_EPOCH: '1785052800' };
      const security = {
        capDrop: ['ALL'],
        noNewPrivileges: true,
        user: '1000:1000',
      };
      const createdAt = clock.now();
      write({
        kind: 'container',
        jobId,
        owner: context.lease.owner,
        runnerUnit: context.lease.runnerUnit,
        leaseExpiresAt: context.lease.expiresAt,
        at: createdAt,
        lifecycle: 'created',
        containerId,
        containerName,
        imageDigest: LOCK.imageDigest,
        labels,
        mount,
        environment,
        security,
        inspection: { running: false, status: 'created' },
        occurredAt: createdAt,
        createdAt,
      });
      const startedContainerAt = clock.now();
      const stoppedAt = clock.now();
      const expectedPatch = options.expectedPatchAlreadyPresent === true
        && operationId === 'activate-target';
      const failed = options.failOperation === operationId || expectedPatch;
      const inspection = {
        running: false,
        status: 'exited',
        exitCode: expectedPatch ? 2 : failed ? 1 : 0,
      };
      write({
        kind: 'container',
        jobId,
        owner: context.lease.owner,
        runnerUnit: context.lease.runnerUnit,
        leaseExpiresAt: context.lease.expiresAt,
        at: stoppedAt,
        lifecycle: 'stopped',
        containerId,
        containerName,
        imageDigest: LOCK.imageDigest,
        labels,
        mount,
        environment,
        security,
        inspection,
        occurredAt: stoppedAt,
        createdAt,
        startedAt: startedContainerAt,
        stoppedAt,
      });
      const finishedAt = clock.now();
      const evidenceRelativePath = `jobs/${jobId}/evidence/operations/${operationId}-${attempt}.json`;
      const evidenceAbsolutePath = join(statePath, evidenceRelativePath);
      await mkdir(dirname(evidenceAbsolutePath), { recursive: true });
      const evidenceBytes = canonical({
        operationId,
        attempt,
        outcome: failed ? 'failed' : 'passed',
      });
      await writeFile(evidenceAbsolutePath, evidenceBytes);
      const operationInput: OperationInput = {
        operationId,
        attempt,
        argvHash: hashOperationDefinition(definition),
        argv: definition.argv,
        startedAt,
        finishedAt,
        containerId,
        containerName,
        containerImageDigest: LOCK.imageDigest,
        containerLabelJobId: jobId,
        containerLabelManifestSha: manifest.sha256,
        containerMount: mount,
        containerEnvironment: environment,
        containerSecurity: security,
        inspection,
        timedOut: false,
        lifecyclePhase: 'stopped',
        exitCode: expectedPatch ? 2 : failed ? 1 : 0,
        signal: null,
        outcome: failed ? 'failed' : 'passed',
        evidencePath: evidenceRelativePath,
        evidenceSha256: hash(evidenceBytes),
        ...(failed
          ? {
              errorCode: 'BUILD_FAILED' as const,
              error: { operationId, reason: 'injected operation failure' },
            }
          : {}),
      };
      write({
        kind: 'operation-complete',
        jobId,
        owner: context.lease.owner,
        runnerUnit: context.lease.runnerUnit,
        leaseExpiresAt: context.lease.expiresAt,
        at: finishedAt,
        expectedState: operationState(context.stage),
        operationId,
        attempt,
        input: operationInput,
      });
      const removedAt = clock.now();
      const cleanupAt = clock.now();
      write({
        kind: 'operation-cleanup',
        jobId,
        owner: context.lease.owner,
        runnerUnit: context.lease.runnerUnit,
        leaseExpiresAt: context.lease.expiresAt,
        at: cleanupAt,
        expectedState: operationState(context.stage),
        operationId,
        attempt,
        proof: {
          kind: 'container-removed',
          id: containerId,
          name: containerName,
          imageDigest: LOCK.imageDigest,
          labels,
          stoppedAt,
          removedAt,
          observedAt: cleanupAt,
          globalLabelResult: 'no-match',
          logs: {
            runner: 'absent',
            docker: 'absent',
            verifiedAt: cleanupAt,
          },
        },
      });
      return Object.freeze({
        operationId,
        attempt,
        outcome: failed ? 'failed' : 'passed',
        command: Object.freeze({
          argv: definition.argv,
          startedAt,
          finishedAt,
          exitCode: expectedPatch ? 2 : failed ? 1 : 0,
          signal: null,
          timedOut: false,
          outputLimit: false,
        }),
        observations: Object.freeze({
          evidencePath: evidenceRelativePath,
          evidenceSha256: hash(evidenceBytes),
          stdout: expectedPatch ? ROOTFS_ALREADY_PRESENT : '',
          stderr: '',
        }),
        ...(failed
          ? {
              error: Object.freeze({
                code: 'BUILD_FAILED' as BuilderErrorCode,
                stage: context.stage,
                details: { operationId },
                retryable: false,
                requestId: 'request-pipeline-order',
                diagnosis: `${operationId} failed`,
                recovery: 'Inspect operation evidence.',
                operationId,
              }),
            }
          : {}),
      });
    },
  };

  const target = manifest.manifest.targets.find((candidate) => candidate.id === 'rpi-5')!;
  const rpi2 = manifest.manifest.targets.find((candidate) => candidate.id === 'rpi-2')!;
  const workspacePath = join(statePath, 'jobs', jobId, 'workspace', 'source');
  const profileEvidence = (candidate: TargetManifest) => Object.freeze({
    target: candidate.id,
    environment: candidate.environment,
    selectedTarget: candidate.openwrtTarget,
    profile: candidate.profile,
    rootfsPartSize: candidate.rootfsPartSize,
    sourceSha256: hash(configBytes(candidate, 'source')),
    sourceConfigEvidencePath: `evidence/target-setup/${candidate.id}.source.config`,
    resolvedSha256: hash(configBytes(candidate, 'resolved')),
    patchDecision: 'applied' as const,
  });
  const profiles = Object.freeze({
    'rpi-5': profileEvidence(target),
    'rpi-2': profileEvidence(rpi2),
  });
  const sourcePhase = Object.freeze({
    phase: 'target-setup' as const,
    workspacePath,
    target: target.id,
    patchDecision: 'applied' as const,
    profiles,
  });
  const configPhase = Object.freeze({
    phase: 'config' as const,
    workspacePath,
    target: target.id,
    config: Object.freeze({
      selectedTarget: target.openwrtTarget,
      profile: target.profile,
      rootfsPartSize: target.rootfsPartSize,
      sourceSha256: profiles['rpi-5'].sourceSha256,
      resolvedSha256: profiles['rpi-5'].resolvedSha256,
      bothProfilesChecked: true as const,
      profiles,
    }),
  });
  const sourceObservations = createTargetSetupSourceObservations(sourcePhase);
  const configObservations = createTargetSetupConfigObservations(configPhase);
  const publicationFiles = {
    prepare: async (value: Parameters<PipelineInput['services']['publicationFiles']['prepare']>[0]) => {
      publicationPreparationStages.push(store.getStage(jobId, 'verify'));
      publishedMetadata.push({
        build: value.buildManifest,
        verification: value.verificationManifest,
      });
      const artifact = {
        stagingPath: `staging/${jobId}/factory.img.gz`,
        artifactSha256: HASH_A,
        artifactSize: 100,
        artifactMtime: value.artifact.mtime,
        checksumPath: `staging/${jobId}/sha256sums`,
        checksumSha256: hash(value.checksumBytes),
        manifestPath: `staging/${jobId}/build-manifest.json`,
        manifestSha256: hash(value.buildManifestBytes),
        verificationPath: `staging/${jobId}/verification.json`,
        verificationSha256: hash(value.verificationManifestBytes),
      };
      prepared = Object.freeze({
        artifact,
        buildManifestBytes: options.tamperMetadata === 'manifest'
          ? `${value.buildManifestBytes} `
          : value.buildManifestBytes,
        verificationManifestBytes: options.tamperMetadata === 'verification'
          ? `${value.verificationManifestBytes} `
          : value.verificationManifestBytes,
        checksumBytes: options.tamperMetadata === 'checksum'
          ? `${HASH_B}  factory.img.gz\n`
          : value.checksumBytes,
      });
      return prepared;
    },
    reopenStaging: async () => {
      if (prepared === null) throw new Error('publication was not prepared');
      return prepared;
    },
    verifyFinal: async (value: Parameters<PipelineInput['services']['publicationFiles']['verifyFinal']>[0]) => ({
      verified: true as const,
      finalPath: value.binding.finalPath,
      artifactSha256: options.tamperFinalProof === true ? HASH_B : value.binding.artifactSha256,
      artifactSize: value.binding.artifactSize,
      checksumPath: `${value.binding.finalDirectory}/sha256sums`,
      checksumSha256: value.artifact.checksumSha256,
      manifestPath: `${value.binding.finalDirectory}/build-manifest.json`,
      manifestSha256: value.artifact.manifestSha256,
      verificationPath: `${value.binding.finalDirectory}/verification.json`,
      verificationSha256: value.artifact.verificationSha256,
      staging: 'absent' as const,
    }),
  };
  const publisherResponse: PublisherResponse = {
    available: true,
    published: true,
    quarantined: false,
    selfTest: false,
    mutationCount: 3,
    renameResult: 'RENAMED',
    publisherVersion: '0.1.0',
    publisherSourceSha256: HASH_C,
    sourceRelativePath: `.osi-image-builder/staging/${jobId}`,
    destinationRelativePath: `${encodeBranchSlug('design/agrolink')}/${SHA40}/rpi-5`,
  };
  const publisher: PublisherClient = {
    publish: vi.fn(async () => publisherResponse),
    recheck: vi.fn(async (): Promise<PublisherResponse> => ({
      available: true,
      published: false,
      quarantined: false,
      selfTest: false,
      mutationCount: 0,
      destination: 'candidate',
      staging: 'absent',
    })),
    quarantine: vi.fn(async (): Promise<PublisherResponse> => ({
      available: true,
      published: false,
      quarantined: true,
      selfTest: false,
      mutationCount: 2,
      renameResult: 'RENAMED',
      publisherVersion: '0.1.0',
      publisherSourceSha256: HASH_C,
      sourceRelativePath: `.osi-image-builder/staging/${jobId}`,
      destinationRelativePath: `.osi-image-builder/quarantine/${jobId}`,
    })),
    ...options.publisher,
  };
  const root = loaded.config.approvedOutputRoots[0]!;
  const pipelineOwnership: PipelineInput['ownership'] = {
    runnerWrite(command): OwnershipResult {
      if (command.kind === options.rejectOwnershipWrite) {
        return {
          ok: false,
          conflict: {
            kind: 'stale-runner-owner',
            message: 'injected ownership loss',
          },
        };
      }
      return ownership.runnerWrite(command);
    },
  };
  const baseInput: PipelineInput = {
    jobId,
    runnerUnit,
    owner: 'runner-pipeline',
    leaseDurationMs: 60_000,
    clock,
    store,
    ownership: pipelineOwnership,
    manifest,
    target,
    approvedRoot: {
      id: root.id,
      path: root.path,
      device: 1,
      inode: 2,
    },
    authoritativeFiles: {
      builderLockPath: lockPath,
      readBuilderLock: async () => readFile(lockPath),
      targetManifestPath: manifestPath.pathname,
      readTargetManifest: async () => readFile(manifestPath),
    },
    evidenceWriter,
    services: {
      workspace: {
        revalidate: async ({ stage, phase }) => {
          workspaceChecks.push([stage, phase]);
          if (
            options.workspaceFailureAt?.stage === stage
            && options.workspaceFailureAt.phase === phase
          ) {
            throw new Error('held workspace replacement detected');
          }
        },
      },
      preflight: {
        recheck: async ({ job }) => {
          if (options.failStage === 'preflight') {
            throw new Error('injected preflight failure');
          }
          return {
            persistedPreflight: true,
            targetId: job.targetId,
            rootId: job.rootId,
          };
        },
      },
      source: {
        setup: async ({ job }) => {
          const command = {
            argv: ['/usr/bin/git', 'status', '--porcelain'],
            startedAt: clock.now(),
            finishedAt: clock.now(),
            exitCode: 0,
            signal: null,
            timedOut: false,
            outputLimit: false,
          } as const;
          if (options.failSource === true) {
            const error = new Error('injected source setup failure');
            Object.defineProperty(error, 'commands', { value: [command] });
            throw error;
          }
          return {
            commands: [command],
            observations: {
              pinnedSha: job.pinnedSha,
              targetOutputAbsent: true,
            },
          };
        },
      },
      operations,
      targetSetup: {
        setup: async (context) => {
          const definition = createOperationDefinition('activate-target', {
            environment: context.target.environment,
          });
          const activation = options.expectedPatchAlreadyPresent === true
            ? await context.runTargetSetupOperation('activate-target', definition)
            : await context.runOperation('activate-target');
          const disposition = options.expectedPatchAlreadyPresent === true
            ? classifyTargetSetupOperationResult('activate-target', definition, {
                ...activation.command,
                signal: activation.command.signal as NodeJS.Signals | null,
                stdout: String(activation.observations.stdout ?? ''),
                stderr: String(activation.observations.stderr ?? ''),
              }).disposition
            : 'passed';
          if (options.verifyProducedTargetEvidence === true) {
            await Promise.all(manifest.manifest.targets.map((candidate) => (
              evidenceWriter.writeTargetSetupSourceConfig({
                jobId,
                targetId: candidate.id,
                contents: configBytes(candidate, 'source'),
              })
            )));
          }
          const executions = [activation];
          return {
            executions,
            observations: disposition === 'expected-rootfs-already-present'
              ? {
                  ...sourceObservations,
                  patchDecision: 'already-present',
                }
              : sourceObservations,
          };
        },
        feeds: async (context) => {
          const executions: PipelineOperationExecution[] = [];
          for (const operationId of [
            'copy-feed-config',
            'update-feeds',
            'install-feeds',
          ] as const) {
            executions.push(await context.runOperation(operationId));
          }
          return {
            executions: options.failStage === 'feeds' ? [] : executions,
            observations: {
              feedsPrepared: true,
            },
          };
        },
        config: async (context) => {
          const executions = [await context.runOperation('resolve-config')];
          if (options.verifyProducedTargetEvidence === true) {
            await Promise.all(manifest.manifest.targets.map(async (candidate) => {
              const directory = join(workspacePath, 'conf', candidate.environment);
              await mkdir(directory, { recursive: true });
              await writeFile(join(directory, '.config'), configBytes(candidate, 'resolved'));
            }));
          }
          return {
            executions: options.failStage === 'config' ? [] : executions,
            observations: configObservations,
          };
        },
      },
      verification: {
        verify: async () => {
          const verifiedConfig = options.verifyProducedTargetEvidence === true
            ? await verifyTargetSetupConfiguration({
                workspace: {
                  stateRoot: loaded.pathAuthorities.stateRoot,
                  jobId,
                },
                target,
                targets: manifest.manifest.targets,
                config: {
                  ...configObservations.config,
                  profiles: {
                    'rpi-5': {
                      ...sourceObservations.profiles['rpi-5'],
                      ...configObservations.config.profiles['rpi-5'],
                    },
                    'rpi-2': {
                      ...sourceObservations.profiles['rpi-2'],
                      ...configObservations.config.profiles['rpi-2'],
                    },
                  },
                },
              })
            : {
                selectedTarget: target.openwrtTarget,
                profile: target.profile,
                rootfsPartSize: target.rootfsPartSize,
                bothProfilesChecked: true as const,
              };
          if (options.verifyProducedTargetEvidence === true) {
            verifiedTargetEvidence.push(verifiedConfig);
          }
          return {
            artifact: {
              path: 'openwrt/bin/targets/factory.img.gz',
              basename: 'factory.img.gz',
              size: 100,
              mtime: clock.now(),
              sha256: HASH_A,
              gzip: true,
            },
            config: verifiedConfig,
            verification: {
              rootfs: { verified: true },
              freshness: { status: 'fresh', pinnedSha: SHA40 },
            },
          };
        },
      },
      publicationFiles,
      publisher,
    },
  };
  let pipelineGetJobCalls = 0;
  const input: PipelineInput = options.mutateJob === undefined
    && options.publicationBindingMismatch !== true
    && options.predictPublishPassed !== true
    ? baseInput
    : {
      ...baseInput,
      store: {
        getJob: (id) => {
          pipelineGetJobCalls += 1;
          const persisted = store.getJob(id);
          if (
            options.publicationBindingMismatch === true
            && pipelineGetJobCalls > 1
          ) {
            return { ...persisted, branch: 'forged/publication' };
          }
          return options.mutateJob?.(persisted) ?? persisted;
        },
        getStage: (id, stage) => {
          if (stage === 'publish' && options.predictPublishPassed === true) {
            return {
              jobId: id,
              stage,
              outcome: 'passed',
              startedAt: ACCEPTED,
              finishedAt: ACCEPTED,
              evidencePath: `jobs/${id}/evidence/09-publish.json`,
              evidenceSha256: HASH_A,
              errorCode: null,
              error: null,
            };
          }
          return store.getStage(id, stage);
        },
        getOperation: (id, operationId, attempt) => (
          store.getOperation(id, operationId, attempt)
        ),
        listEvents: (id, eventOptions) => store.listEvents(id, eventOptions),
      },
    };
  return {
    directory,
    statePath,
    store,
    ownership,
    clock,
    input,
    operationOrder,
    workspaceChecks,
    publishedMetadata,
    publicationPreparationStages,
    verifiedTargetEvidence,
    sourceObservations,
    configObservations,
    close: () => store.close(),
  };
}

describe('trusted pipeline integration', () => {
  it('continues from the exact lease acquired by guarded production composition', async () => {
    const value = await fixture();
    try {
      const at = value.clock.now();
      const expiresAt = new Date(Date.parse(at) + 60_000).toISOString();
      expect(value.ownership.runnerWrite({
        kind: 'acquire-lease',
        jobId: value.input.jobId,
        runnerUnit: value.input.runnerUnit,
        owner: value.input.owner,
        expiresAt,
        at,
      }).ok).toBe(true);
      const initialLease: PipelineLease = {
        owner: value.input.owner,
        runnerUnit: value.input.runnerUnit,
        expiresAt,
      };
      const input = {
        ...value.input,
        initialLease,
      } as PipelineInput;

      await expect(createPipeline(input).run()).resolves.toMatchObject({
        state: 'succeeded',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType, payload }) => (
          eventType === 'state' && payload.runnerOwner === value.input.owner
        ))).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it.each([
    'builder lock',
    'target manifest',
    'native publisher',
    'persisted target',
    'approved root',
  ])('guards %s composition failure with one durable terminal', async (component) => {
    const value = await fixture();
    try {
      const result = await runGuardedComposition({
        args: {
          jobId: value.input.jobId,
          runnerUnit: value.input.runnerUnit,
          owner: value.input.owner,
          leaseExpiresAt: '2026-07-26T09:00:00.000Z',
        },
        clock: value.input.clock,
        store: value.store,
        ownership: value.ownership,
        evidenceWriter: value.input.evidenceWriter,
        compose: async () => {
          throw new Error(`${component} composition failed`);
        },
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        state: 'failed',
      });
      expect(value.store.getStage(value.input.jobId, 'preflight')).toMatchObject({
        outcome: 'failed',
        errorCode: 'BUILD_FAILED',
        evidencePath: expect.stringContaining('00-preflight.json'),
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        terminalErrorCode: 'BUILD_FAILED',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);

      const reopenedDatabase = openBuilderDatabase(join(value.statePath, 'jobs.sqlite'));
      const reopenedStore = new BuilderStore(reopenedDatabase);
      try {
        expect(reopenedStore.getJob(value.input.jobId)).toMatchObject({
          state: 'failed',
          terminalErrorCode: 'BUILD_FAILED',
        });
        expect(reopenedStore.listEvents(value.input.jobId, { limit: 500 }).events
          .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
      } finally {
        reopenedStore.close();
      }
    } finally {
      value.close();
    }
  });

  it('persists an explicit recovery blocker when composition ownership is foreign', async () => {
    const value = await fixture();
    try {
      const at = value.clock.now();
      const expiresAt = new Date(Date.parse(at) + 60_000).toISOString();
      expect(value.ownership.runnerWrite({
        kind: 'acquire-lease',
        jobId: value.input.jobId,
        runnerUnit: value.input.runnerUnit,
        owner: 'foreign-runner',
        expiresAt,
        at,
      }).ok).toBe(true);

      await expect(runGuardedComposition({
        args: {
          jobId: value.input.jobId,
          runnerUnit: value.input.runnerUnit,
          owner: value.input.owner,
          leaseExpiresAt: new Date(Date.parse(expiresAt) + 60_000).toISOString(),
        },
        clock: value.input.clock,
        store: value.store,
        ownership: value.ownership,
        evidenceWriter: value.input.evidenceWriter,
        compose: async () => {
          throw new Error('composition must not run without ownership');
        },
      })).resolves.toMatchObject({
        state: 'recovery-required',
        blockerCode: 'RUNNER_DISAPPEARED',
      });
      const database = openBuilderDatabase(join(value.statePath, 'jobs.sqlite'));
      try {
        const row = database.prepare(
          'SELECT cleanup_blocker_code, cleanup_blocker_json FROM jobs WHERE job_id=?',
        ).get(value.input.jobId) as {
          cleanup_blocker_code: string;
          cleanup_blocker_json: string;
        };
        expect(row.cleanup_blocker_code).toBe('RUNNER_DISAPPEARED');
        expect(JSON.parse(row.cleanup_blocker_json)).toMatchObject({
          phase: 'composition',
          observedOwner: 'foreign-runner',
        });
      } finally {
        database.close();
      }
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(0);
    } finally {
      value.close();
    }
  });

  it('guards the concrete production publisher composition after opening ownership state', async () => {
    const value = await fixture();
    const configHome = join(value.directory, 'config');
    const packageDirectory = join(value.directory, 'installed', LOCK.packageVersion);
    const stateHome = join(value.directory, 'state-home');
    const priorConfigHome = process.env.XDG_CONFIG_HOME;
    const priorStateHome = process.env.XDG_STATE_HOME;
    try {
      await Promise.all([
        mkdir(join(configHome, 'osi-image-builder'), { recursive: true }),
        mkdir(join(packageDirectory, 'manifest'), { recursive: true }),
        mkdir(join(packageDirectory, 'bin'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(configHome, 'osi-image-builder', 'config.json'),
          await readFile(join(configHome, 'config.json')),
        ),
        writeFile(
          join(packageDirectory, 'manifest', 'targets.json'),
          await readFile(new URL('../../manifest/targets.json', import.meta.url)),
        ),
      ]);
      await execFile('/usr/bin/git', ['init', '-q', value.directory + '/repository']);
      await execFile('/usr/bin/git', [
        '-C',
        value.directory + '/repository',
        'remote',
        'add',
        'origin',
        'git@github.com:Open-Smart-Irrigation/osi-os.git',
      ]);
      process.env.XDG_CONFIG_HOME = configHome;
      process.env.XDG_STATE_HOME = stateHome;

      await expect(runRunner([
        '--job-id', value.input.jobId,
        '--runner-unit', value.input.runnerUnit,
        '--owner', value.input.owner,
        '--lease-expires-at', '2026-07-28T09:00:00.000Z',
      ])).resolves.toMatchObject({
        state: 'failed',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        terminalErrorCode: 'BUILD_FAILED',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
      expect(value.store.getStage(value.input.jobId, 'preflight')).toMatchObject({
        outcome: 'failed',
        evidencePath: expect.stringContaining('00-preflight.json'),
      });
    } finally {
      if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorConfigHome;
      if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = priorStateHome;
      value.close();
    }
  });

  it('rejects verification aggregation that predicts a passed publication', async () => {
    const value = await fixture({ predictPublishPassed: true });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
      });
      expect(value.input.services.publisher.publish).not.toHaveBeenCalled();
      expect(value.store.getStage(value.input.jobId, 'verify')).toMatchObject({
        outcome: 'passed',
      });
      expect(value.store.getStage(value.input.jobId, 'publish')).toMatchObject({
        outcome: 'failed',
        errorCode: 'BUILD_FAILED',
      });
      expect(value.publishedMetadata).toHaveLength(0);
    } finally {
      value.close();
    }
  });

  it('runs all ten stages with durable real evidence, exact operations, and one terminal transaction', async () => {
    const value = await fixture();
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'succeeded',
        blockerCode: null,
      });
      expect(value.operationOrder).toEqual([
        'verify-profile-parity',
        'verify-chameleon',
        'verify-db-schema',
        'verify-sync-flow',
        'verify-strega',
        'verify-communication',
        'check-mqtt-topics',
        'frontend-install',
        'frontend-test',
        'frontend-typecheck',
        'frontend-build',
        'mirror-gui',
        'activate-target',
        'copy-feed-config',
        'update-feeds',
        'install-feeds',
        'resolve-config',
        'build-image',
        'verify-image',
      ]);
      expect(value.workspaceChecks).toEqual(PIPELINE_STAGE_NAMES.flatMap((stage) => [
        [stage, 'before'] as const,
        [stage, 'after'] as const,
      ]));
      for (const stage of PIPELINE_STAGE_NAMES) {
        const row = value.store.getStage(value.input.jobId, stage);
        expect(row).toMatchObject({
          stage,
          outcome: 'passed',
          evidencePath: expect.stringContaining(`-${stage}.json`),
          evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
        const evidence = JSON.parse(await readFile(
          join(value.statePath, row!.evidencePath!),
          'utf8',
        )) as Record<string, unknown>;
        expect(evidence).toMatchObject({
          schemaVersion: 1,
          jobId: value.input.jobId,
          stage,
          outcome: 'passed',
        });
        expect(evidence.operationId).toBeNull();
      }
      const events = value.store.listEvents(value.input.jobId, { limit: 500 }).events;
      expect(events.filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
      expect(events.filter(({ eventType }) => eventType === 'stage')).toHaveLength(20);
      expect(events
        .filter(({ eventType }) => eventType === 'operation')
        .map(({ payload }) => [payload.operationId, payload.phase]))
        .toEqual(value.operationOrder.flatMap((operationId) => [
          [operationId, 'begin'],
          [operationId, 'complete'],
        ]));
      expect(events
        .filter(({ eventType, payload }) => (
          eventType === 'operation' && payload.phase === 'begin'
        ))
        .filter(({ payload }) => [
          'activate-target',
          'copy-feed-config',
          'update-feeds',
          'install-feeds',
          'resolve-config',
        ].includes(String(payload.operationId)))
        .map(({ state, payload }) => [payload.operationId, state]))
        .toEqual([
          ['activate-target', 'target_setup'],
          ['copy-feed-config', 'feeds'],
          ['update-feeds', 'feeds'],
          ['install-feeds', 'feeds'],
          ['resolve-config', 'config'],
        ]);
      expect(events
        .filter(({ eventType, payload }) => (
          eventType === 'cleanup' && payload.kind === 'operation-cleanup'
        ))
        .map(({ payload }) => payload.operationId))
        .toEqual(value.operationOrder);
      const stageEvents = events
        .filter(({ eventType }) => eventType === 'stage')
        .map(({ stage, payload }) => [stage, payload.outcome]);
      expect(stageEvents).toEqual(PIPELINE_STAGE_NAMES.flatMap((stage) => [
        [stage, 'running'],
        [stage, 'passed'],
      ]));
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'succeeded',
        publishState: 'published',
        artifactStagingPath: null,
        artifactFinalPath: `${encodeBranchSlug('design/agrolink')}/${SHA40}/rpi-5/factory.img.gz`,
      });
    } finally {
      value.close();
    }
  });

  it('publishes distinct stage 04 and 06 profile evidence before production verification joins it', async () => {
    const value = await fixture({ verifyProducedTargetEvidence: true });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'succeeded',
      });
      expect(value.verifiedTargetEvidence).toHaveLength(1);
      const sourceEvidence = JSON.parse(await readFile(
        join(
          value.statePath,
          value.store.getStage(value.input.jobId, 'target-setup')!.evidencePath!,
        ),
        'utf8',
      )) as { observations: Record<string, unknown> };
      const configEvidence = JSON.parse(await readFile(
        join(
          value.statePath,
          value.store.getStage(value.input.jobId, 'config')!.evidencePath!,
        ),
        'utf8',
      )) as { observations: Record<string, unknown> };
      expect(sourceEvidence.observations).toMatchObject(value.sourceObservations);
      expect(configEvidence.observations).toMatchObject(value.configObservations);
      expect(Object.keys(
        (sourceEvidence.observations.profiles as Record<string, Record<string, unknown>>)
          ['rpi-5']!,
      ).sort()).toEqual([
        'environment',
        'profile',
        'rootfsPartSize',
        'selectedTarget',
        'sourceConfigEvidencePath',
        'sourceSha256',
        'target',
      ]);
      expect(Object.keys(
        ((configEvidence.observations.config as {
          profiles: Record<string, Record<string, unknown>>;
        }).profiles)['rpi-5']!,
      ).sort()).toEqual([
        'environment',
        'profile',
        'resolvedSha256',
        'rootfsPartSize',
        'selectedTarget',
        'sourceConfigEvidencePath',
        'sourceSha256',
        'target',
      ]);
    } finally {
      value.close();
    }
  });

  it('derives complete manifest provenance from authoritative bytes and stage results', async () => {
    const value = await fixture();
    try {
      await createPipeline(value.input).run();
      expect(value.publishedMetadata).toHaveLength(1);
      const { build, verification } = value.publishedMetadata[0]!;
      expect(build).toMatchObject({
        schemaVersion: 1,
        packageVersion: LOCK.packageVersion,
        imageRepository: LOCK.imageRepository,
        imageDigest: LOCK.imageDigest,
        baseImage: LOCK.baseImage,
        baseImageDigest: LOCK.baseImageDigest,
        dockerfileSha256: LOCK.dockerfileSha256,
        packageSet: LOCK.packageSet,
        rustConfig: LOCK.rustConfig,
        nodeVersion: LOCK.nodeVersion,
        executionDefinitionSha256: LOCK.executionDefinitionSha256,
        validationEvidenceSha256: LOCK.validationEvidenceSha256,
        builderLockSha256: hash(canonical(LOCK)),
        canonicalImageRef: `${LOCK.imageRepository}@sha256:${LOCK.imageDigest}`,
        targetManifestSha256: value.input.manifest.sha256,
        jobId: value.input.jobId,
        branch: 'design/agrolink',
        pinnedSha: SHA40,
        targetId: 'rpi-5',
        artifactSha256: HASH_A,
        artifactSize: 100,
      });
      expect(verification).toMatchObject({
        ...build,
        observations: {
          stageEvidence: PIPELINE_STAGE_NAMES.map((stage, index) => ({
            stage,
            path: `${String(index).padStart(2, '0')}-${stage}.json`,
            outcome: stage === 'publish' ? 'running' : 'passed',
          })),
        },
        verification: {
          rootfs: { verified: true },
          freshness: { status: 'fresh', pinnedSha: SHA40 },
        },
      });
      expect(build.tool).toMatchObject({
        preflight: {
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          evidencePath: expect.stringContaining('00-preflight.json'),
          evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          observations: expect.any(Object),
        },
      });
      const verify = value.store.getStage(value.input.jobId, 'verify')!;
      expect(value.publicationPreparationStages).toEqual([
        expect.objectContaining({
          outcome: 'passed',
          evidencePath: expect.stringContaining('08-verify.json'),
        }),
      ]);
      const verifyEvidence = JSON.parse(await readFile(
        join(value.statePath, verify.evidencePath!),
        'utf8',
      )) as { observations: Record<string, unknown> };
      expect(verifyEvidence.observations).toMatchObject({
        freshnessStatus: 'fresh',
        pinnedSha: SHA40,
        rootfs: { verified: true },
      });
    } finally {
      value.close();
    }
  });

  it('lets Task15 classify only the exact expected nonzero quilt result', async () => {
    const value = await fixture({ expectedPatchAlreadyPresent: true });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'succeeded',
      });
      expect(value.store.getOperation(
        value.input.jobId,
        'activate-target',
        1,
      )).toMatchObject({
        outcome: 'failed',
        exitCode: 2,
      });
      const stage = value.store.getStage(value.input.jobId, 'target-setup')!;
      const evidence = JSON.parse(await readFile(
        join(value.statePath, stage.evidencePath!),
        'utf8',
      )) as { observations: Record<string, unknown> };
      expect(evidence.observations.patchDecision).toBe('already-present');
    } finally {
      value.close();
    }
  });

  it.each([
    ['verify-profile-parity', 'release-gates'],
    ['verify-chameleon', 'release-gates'],
    ['verify-db-schema', 'release-gates'],
    ['verify-sync-flow', 'release-gates'],
    ['verify-strega', 'release-gates'],
    ['verify-communication', 'release-gates'],
    ['check-mqtt-topics', 'release-gates'],
    ['frontend-install', 'frontend'],
    ['frontend-test', 'frontend'],
    ['frontend-typecheck', 'frontend'],
    ['frontend-build', 'frontend'],
    ['mirror-gui', 'frontend'],
    ['activate-target', 'target-setup'],
    ['copy-feed-config', 'feeds'],
    ['update-feeds', 'feeds'],
    ['install-feeds', 'feeds'],
    ['resolve-config', 'config'],
    ['build-image', 'build'],
    ['verify-image', 'verify'],
  ] as const)('writes failure evidence and one runner terminal at the %s boundary', async (
    operationId,
    expectedStage,
  ) => {
    const value = await fixture({ failOperation: operationId });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
        blockerCode: null,
      });
      const failedStage = value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType, payload }) => (
          eventType === 'stage' && payload.outcome === 'failed'
      ));
      expect(failedStage).toHaveLength(1);
      const stage = failedStage[0]!.stage!;
      expect(stage).toBe(expectedStage);
      const evidence = JSON.parse(await readFile(
        join(value.statePath, value.store.getStage(value.input.jobId, stage)!.evidencePath!),
        'utf8',
      )) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        outcome: 'failed',
        operationId: null,
      });
      expect((evidence.error as Record<string, unknown>).operationId).toBeUndefined();
      expect(value.store.getOperation(value.input.jobId, operationId, 1)).toMatchObject({
        operationId,
        outcome: 'failed',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
      expect(value.store.getJob(value.input.jobId).state).toBe('failed');
    } finally {
      value.close();
    }
  });

  it.each([
    ['preflight', 'activate-target'],
    ['feeds', 'install-feeds'],
    ['config', 'resolve-config'],
  ] as const)('terminates once with durable evidence at the %s stage boundary', async (
    failStage,
    operationId,
  ) => {
    const value = await fixture({ failStage });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
      });
      const stage = value.store.getStage(value.input.jobId, failStage);
      const evidence = JSON.parse(await readFile(
        join(value.statePath, stage!.evidencePath!),
        'utf8',
      )) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        stage: failStage,
        outcome: 'failed',
        operationId: null,
      });
      expect((evidence.error as Record<string, unknown>).operationId).toBeUndefined();
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('binds a thrown operation exception to the operation actually attempted', async () => {
    const value = await fixture({ throwOperation: 'verify-profile-parity' });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
      });
      const stage = value.store.getStage(value.input.jobId, 'release-gates');
      const evidence = JSON.parse(await readFile(
        join(value.statePath, stage!.evidencePath!),
        'utf8',
      )) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        outcome: 'failed',
        operationId: null,
      });
      expect((evidence.error as Record<string, unknown>).operationId).toBeUndefined();
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('persists source command evidence before one source failure terminal', async () => {
    const value = await fixture({ failSource: true });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
      });
      const stage = value.store.getStage(value.input.jobId, 'source');
      const evidence = JSON.parse(await readFile(
        join(value.statePath, stage!.evidencePath!),
        'utf8',
      )) as { operationId: unknown; commands: unknown[] };
      expect(evidence.operationId).toBeNull();
      expect(evidence.commands).toHaveLength(1);
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it.each(['manifest', 'verification', 'checksum'] as const)(
    'fails verification and terminates once when reopened %s metadata is tampered',
    async (tamperMetadata) => {
      const value = await fixture({ tamperMetadata });
      try {
        await expect(createPipeline(value.input).run()).resolves.toMatchObject({
          state: 'failed',
        });
        expect(value.store.getStage(value.input.jobId, 'verify')).toMatchObject({
          outcome: 'passed',
          errorCode: null,
        });
        expect(value.store.getStage(value.input.jobId, 'publish')).toMatchObject({
          outcome: 'failed',
          errorCode: 'CHECKSUM_FAILED',
        });
        expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
          .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
      } finally {
        value.close();
      }
    },
  );

  it('renews the lease by CAS around long stages and operations', async () => {
    const value = await fixture();
    try {
      await createPipeline(value.input).run();
      const renewals = value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType, payload }) => (
          eventType === 'state' && payload.state === 'runner_lease_renewed'
        ));
      expect(renewals.length).toBeGreaterThan(PIPELINE_STAGE_NAMES.length * 2);
      expect(value.store.getJob(value.input.jobId).runnerLeaseExpiresAt)
        .toMatch(/^2026-07-26T/u);
    } finally {
      value.close();
    }
  });

  it('returns a recovery blocker instead of a failed result when lease ownership is lost', async () => {
    let expired = false;
    const value = await fixture({
      operationHook: (operationId, clock) => {
        if (!expired && operationId === 'frontend-test') {
          expired = true;
          clock.advance(120_000);
        }
      },
    });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'recovery-required',
        blockerCode: 'RUNNER_DISAPPEARED',
      });
      expect(value.store.getJob(value.input.jobId).state).toBe('frontend');
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(0);
    } finally {
      value.close();
    }
  });

  it('fails once when held workspace authority changes after a major stage', async () => {
    const value = await fixture({
      workspaceFailureAt: { stage: 'build', phase: 'after' },
    });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
      });
      expect(value.store.getStage(value.input.jobId, 'build')).toMatchObject({
        outcome: 'failed',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
      expect(value.operationOrder).not.toContain('verify-image');
    } finally {
      value.close();
    }
  });

  it('returns recovery-required when initial lease acquisition loses its CAS', async () => {
    const value = await fixture({ rejectOwnershipWrite: 'acquire-lease' });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'recovery-required',
        blockerCode: 'RUNNER_DISAPPEARED',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'starting',
        runnerLeaseOwner: null,
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(0);
    } finally {
      value.close();
    }
  });

  it('records one guarded terminal for persisted source, target, root, and manifest mismatches', async () => {
    const value = await fixture({
      mutateJob: (job) => ({ ...job, rootId: 'forged-root' }),
    });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
      });
      const job = value.store.getJob(value.input.jobId);
      expect(job.state).toBe('failed');
      expect(value.store.getStage(value.input.jobId, 'preflight')).toMatchObject({
        outcome: 'failed',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('rejects a forged parsed manifest even when its asserted hash matches held bytes', async () => {
    const value = await fixture();
    try {
      const forgedTarget = Object.freeze({
        ...value.input.target,
        label: 'Forged Pi 5',
      });
      const forgedManifest = Object.freeze({
        ...value.input.manifest,
        manifest: Object.freeze({
          ...value.input.manifest.manifest,
          targets: Object.freeze([
            forgedTarget,
            value.input.manifest.manifest.targets[1]!,
          ]),
        }),
      });
      await expect(createPipeline({
        ...value.input,
        manifest: forgedManifest,
        target: forgedTarget,
      }).run()).resolves.toMatchObject({
        state: 'failed',
      });
      expect(value.store.getStage(value.input.jobId, 'preflight')).toMatchObject({
        outcome: 'failed',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('persists publish_started before native publication and one blocked terminal on collision', async () => {
    let observed: JobRecord | null = null;
    const value = await fixture({
      publisher: {
        publish: vi.fn(async (): Promise<PublisherResponse> => {
          observed = value.store.getJob(value.input.jobId);
          return {
            available: true,
            published: false,
            quarantined: false,
            selfTest: false,
            mutationCount: 1,
            errorCode: 'OUTPUT_COLLISION',
            renameResult: 'EEXIST',
            publisherVersion: '0.1.0',
            publisherSourceSha256: HASH_C,
            sourceRelativePath: `.osi-image-builder/staging/${value.input.jobId}`,
            destinationRelativePath: `${encodeBranchSlug('design/agrolink')}/${SHA40}/rpi-5`,
          };
        }),
      },
    });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
        blockerCode: 'OUTPUT_COLLISION',
      });
      expect(observed).toMatchObject({
        state: 'publishing',
        publishState: 'publishing',
        publishStartedAt: expect.any(String),
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        publishState: 'blocked',
        terminalErrorCode: 'OUTPUT_COLLISION',
      });
      expect((value.publishedMetadata[0]!.verification.observations as {
        stageEvidence: Array<{ stage: string; outcome: string }>;
      }).stageEvidence.at(-1)).toEqual({
        stage: 'publish',
        path: '09-publish.json',
        outcome: 'running',
      });
      expect(value.store.getStage(value.input.jobId, 'publish')?.error)
        .not.toHaveProperty('operationId');
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('persists exact quarantine identity and clears removed staging in the blocked terminal', async () => {
    const value = await fixture({
      publisher: {
        publish: vi.fn(async (): Promise<PublisherResponse> => ({
          available: true,
          published: false,
          quarantined: false,
          selfTest: false,
          mutationCount: 3,
          errorCode: 'PUBLISH_FAILED',
          renameResult: 'RENAMED',
          publisherVersion: '0.1.0',
          publisherSourceSha256: HASH_C,
          sourceRelativePath: `.osi-image-builder/staging/${value.input.jobId}`,
          destinationRelativePath: `${encodeBranchSlug('design/agrolink')}/${SHA40}/rpi-5`,
        })),
        recheck: vi.fn(async (): Promise<PublisherResponse> => ({
          available: true,
          published: false,
          quarantined: false,
          selfTest: false,
          mutationCount: 0,
          errorCode: 'PUBLISH_RECOVERY_FAILED',
          destination: 'absent',
          staging: 'present',
        })),
      },
    });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
        blockerCode: 'PUBLISH_RECOVERY_FAILED',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        publishState: 'blocked',
        artifactStagingPath: null,
        artifactQuarantinePath: `.osi-image-builder/quarantine/${value.input.jobId}`,
      });
      const reopenedDatabase = openBuilderDatabase(join(value.statePath, 'jobs.sqlite'));
      const reopenedStore = new BuilderStore(reopenedDatabase);
      try {
        expect(reopenedStore.getJob(value.input.jobId)).toMatchObject({
          artifactStagingPath: null,
          artifactQuarantinePath: `.osi-image-builder/quarantine/${value.input.jobId}`,
        });
      } finally {
        reopenedStore.close();
      }
      expect((value.publishedMetadata[0]!.verification.observations as {
        stageEvidence: Array<{ stage: string; outcome: string }>;
      }).stageEvidence.at(-1)).toMatchObject({
        stage: 'publish',
        outcome: 'running',
      });
    } finally {
      value.close();
    }
  });

  it('retains staging when quarantine proof is failed or unknown', async () => {
    const value = await fixture({
      publisher: {
        publish: vi.fn(async (): Promise<PublisherResponse> => ({
          available: true,
          published: false,
          quarantined: false,
          selfTest: false,
          mutationCount: 3,
          errorCode: 'PUBLISH_FAILED',
          renameResult: 'RENAMED',
          publisherVersion: '0.1.0',
          publisherSourceSha256: HASH_C,
          sourceRelativePath: `.osi-image-builder/staging/${value.input.jobId}`,
          destinationRelativePath: `${encodeBranchSlug('design/agrolink')}/${SHA40}/rpi-5`,
        })),
        recheck: vi.fn(async (): Promise<PublisherResponse> => ({
          available: true,
          published: false,
          quarantined: false,
          selfTest: false,
          mutationCount: 0,
          errorCode: 'PUBLISH_RECOVERY_FAILED',
          destination: 'absent',
          staging: 'present',
        })),
        quarantine: vi.fn(async (): Promise<PublisherResponse> => ({
          available: true,
          published: false,
          quarantined: false,
          selfTest: false,
          mutationCount: 1,
          errorCode: 'QUARANTINE_PENDING',
          renameResult: 'RENAMED',
          publisherVersion: '0.1.0',
          publisherSourceSha256: HASH_C,
          sourceRelativePath: `.osi-image-builder/staging/${value.input.jobId}`,
          destinationRelativePath: `.osi-image-builder/quarantine/${value.input.jobId}`,
        })),
      },
    });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
        blockerCode: 'QUARANTINE_PENDING',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        publishState: 'blocked',
        artifactStagingPath: `staging/${value.input.jobId}/factory.img.gz`,
        artifactQuarantinePath: null,
      });
    } finally {
      value.close();
    }
  });

  it('records publication binding mismatch evidence and one terminal before native mutation', async () => {
    const value = await fixture({ publicationBindingMismatch: true });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
      });
      expect(value.input.services.publisher.publish).not.toHaveBeenCalled();
      expect(value.store.getStage(value.input.jobId, 'publish')).toMatchObject({
        outcome: 'failed',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        publishState: 'staged',
        publishStartedAt: null,
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('retains explicit publishing recovery state when the atomic publish terminal loses ownership', async () => {
    const value = await fixture({ rejectOwnershipWrite: 'publish-terminal' });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'recovery-required',
        blockerCode: 'RUNNER_DISAPPEARED',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'publishing',
        publishState: 'publishing',
        artifactStagingPath: `staging/${value.input.jobId}/factory.img.gz`,
        artifactFinalPath: `${encodeBranchSlug('design/agrolink')}/${SHA40}/rpi-5/factory.img.gz`,
        terminalAt: null,
      });
      expect(value.store.getStage(value.input.jobId, 'publish')).toMatchObject({
        outcome: 'running',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(0);
    } finally {
      value.close();
    }
  });

  it('persists post-rename final-proof mismatch evidence and one blocked terminal', async () => {
    const value = await fixture({ tamperFinalProof: true });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
        blockerCode: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        publishState: 'blocked',
        terminalErrorCode: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      });
      const database = openBuilderDatabase(join(value.statePath, 'jobs.sqlite'));
      try {
        const row = database.prepare(
          'SELECT publish_blocker_code, publish_blocker_json FROM jobs WHERE job_id=?',
        ).get(value.input.jobId) as {
          publish_blocker_code: string;
          publish_blocker_json: string;
        };
        expect(row.publish_blocker_code).toBe('UNVERIFIED_FINAL_PATH_BLOCKER');
        expect(JSON.parse(row.publish_blocker_json)).toMatchObject({
          code: 'UNVERIFIED_FINAL_PATH_BLOCKER',
          staging: 'absent',
          response: {
            published: true,
            renameResult: 'RENAMED',
          },
        });
      } finally {
        database.close();
      }
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('rechecks and completes when the native publish invocation throws after rename', async () => {
    const publish = vi.fn(async (): Promise<PublisherResponse> => {
      throw new Error('publisher exited after native mutation');
    });
    const recheck = vi.fn(async (): Promise<PublisherResponse> => ({
      available: true,
      published: false,
      quarantined: false,
      selfTest: false,
      mutationCount: 0,
      destination: 'candidate',
      staging: 'absent',
    }));
    const value = await fixture({ publisher: { publish, recheck } });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'succeeded',
        blockerCode: null,
      });
      expect(publish).toHaveBeenCalledOnce();
      expect(recheck).toHaveBeenCalledOnce();
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'succeeded',
        publishState: 'published',
      });
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });

  it('persists an unknown blocker when publish and native recheck both fail', async () => {
    const publish = vi.fn(async (): Promise<PublisherResponse> => {
      throw new Error('publisher transport failed');
    });
    const recheck = vi.fn(async (): Promise<PublisherResponse> => {
      throw new Error('publisher recheck failed');
    });
    const value = await fixture({ publisher: { publish, recheck } });
    try {
      await expect(createPipeline(value.input).run()).resolves.toMatchObject({
        state: 'failed',
        blockerCode: 'PUBLISH_RECOVERY_FAILED',
      });
      expect(value.store.getJob(value.input.jobId)).toMatchObject({
        state: 'failed',
        publishState: 'blocked',
        terminalErrorCode: 'PUBLISH_RECOVERY_FAILED',
      });
      const database = openBuilderDatabase(join(value.statePath, 'jobs.sqlite'));
      try {
        const row = database.prepare(
          'SELECT publish_blocker_json FROM jobs WHERE job_id=?',
        ).get(value.input.jobId) as { publish_blocker_json: string };
        expect(JSON.parse(row.publish_blocker_json)).toMatchObject({
          code: 'PUBLISH_RECOVERY_FAILED',
          staging: 'unknown',
          nativeFailures: [
            { phase: 'publish' },
            { phase: 'recheck' },
          ],
        });
      } finally {
        database.close();
      }
      expect(value.store.listEvents(value.input.jobId, { limit: 500 }).events
        .filter(({ eventType }) => eventType === 'terminal')).toHaveLength(1);
    } finally {
      value.close();
    }
  });
});
