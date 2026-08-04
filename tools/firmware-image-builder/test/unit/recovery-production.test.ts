import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { access, chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ConfigAuthorityError, loadConfig, type LoadedConfig } from '../../config/load.js';
import { ADMISSION_ID_PATTERN } from '../../domain/types.js';
import { encodeJson } from '../../api/src/validation.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { DurableLogStream } from '../../api/src/log-stream.js';
import { createProductionCleanupSystemd, createProductionSystemdAdapter, recoveryLogObservation } from '../../api/src/production.js';
import type { CleanupPostcondition } from '../../api/src/ownership.js';
import type { RecoveryLogVerificationInput, RecoveryStagingPostcondition } from '../../api/src/recovery.js';
import { RecoveryBoundaryError, RecoveryInfrastructureError } from '../../api/src/recovery.js';
import { classifyRecoveryAuthorityError, classifyRecoveryFileSystemError, createRecoveryPhysicalVerification } from '../../api/src/recovery-production.js';
import { createTestBuilderIdentity } from '../helpers/builder-identity.js';

const JOB_ID = 'recovery-production-job';
const ADMISSION_ID = 'cln_0123456789abcdefghjkmnpqrs';
const ROOT_ID = 'images';
const OTHER_ROOT_ID = 'other-images';
const NOW = '2026-07-28T12:00:00.000Z';
const STALE = '2026-07-28T11:55:00.000Z';
const HASH64 = /^[0-9a-f]{64}$/u;
const CHECKSUM_BYTES = Buffer.from(`${'1'.repeat(64)}  image.img.gz\n`, 'utf8');
const MANIFEST_BYTES = Buffer.from('{"schemaVersion":1,"target":"rpi-5"}\n', 'utf8');
const VERIFICATION_BYTES = Buffer.from('{"schemaVersion":1,"verified":true}\n', 'utf8');
const execFile = promisify(nodeExecFile);

function postcondition(staging: CleanupPostcondition['staging'] = {
  kind: 'absent',
  path: null,
  sourcePath: `staging/${JOB_ID}`,
  sourceAbsent: true,
  verifiedAt: NOW,
}): CleanupPostcondition {
  return {
    runner: {
      unit: `osi-image-builder-runner@${JOB_ID}.service`,
      owner: 'runner',
      leaseExpiresAt: STALE,
      inactiveAt: NOW,
      observedAt: NOW,
    },
    state: 'building',
    container: {
      kind: 'null-identity',
      dockerAction: 'none',
      globalLabelResult: 'no-match',
      observedAt: NOW,
    },
    staging,
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    egress: { persistedDocker: null, discoveredDocker: [], credentials: [], globalLabelResult: 'no-match' },
    blocker: 'none',
  };
}

function stateRootBoundEgress(stateRoot: string, options: Readonly<{ readonly credentialRoot?: string }> = {}): Record<string, unknown> {
  const credentialRoot = options.credentialRoot ?? join(stateRoot, 'jobs', JOB_ID, 'recovery', 'dependency-egress');
  const hostPath = join(credentialRoot, 'frontend-install-1.proxy-credential');
  const tlsHostDirectory = join(credentialRoot, 'frontend-install-1.proxy-tls');
  const docker = {
    operationId: 'frontend-install',
    attempt: 1,
    proxy: { id: 'a'.repeat(64), absent: true },
    network: { id: 'b'.repeat(64), absent: true },
    tls: { hostDirectory: tlsHostDirectory, absent: true },
    credential: { hostPath, sha256: 'c'.repeat(64) },
  };
  return {
    persistedDocker: { ...docker, globalLabelResult: 'no-match' },
    discoveredDocker: [],
    credentials: [{ kind: 'normal', operationId: 'frontend-install', attempt: 1, hostPath, expectedSha256: 'c'.repeat(64), observedSha256: 'c'.repeat(64), tls: { hostDirectory: tlsHostDirectory, absent: true }, absent: true }],
    globalLabelResult: 'no-match',
  };
}

function completionEnvelope(condition = postcondition()): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'cleanup-complete',
    admissionId: ADMISSION_ID,
    jobId: JOB_ID,
    postcondition: condition,
    observedAt: NOW,
  };
}

async function fixture(beforeRead?: (handle: FileHandle) => Promise<void>): Promise<{ readonly base: string; readonly loaded: LoadedConfig }> {
  const base = await mkdtemp(join(tmpdir(), 'osi-image-builder-recovery-production-'));
  const configHome = join(base, 'config-home');
  const stateHome = join(base, 'state-home');
  const repository = join(base, 'repository');
  const output = join(base, 'output');
  const otherOutput = join(base, 'other-output');
  const configRoot = join(configHome, 'osi-image-builder');
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(repository, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  await mkdir(otherOutput, { mode: 0o700 });
  const configPath = join(configRoot, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath: repository,
    approvedOutputRoots: [
      { id: ROOT_ID, label: 'Images', path: output },
      { id: OTHER_ROOT_ID, label: 'Other images', path: otherOutput },
    ],
    builderLockPath: '/opt/osi-image-builder/v2026.07.28/builder.lock.json',
  }), { mode: 0o600 });
  const loaded = await loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    git: { getOriginPolicy: async () => ({ url: 'git@example.com:osi/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    ...(beforeRead === undefined ? {} : { pathAuthorityDependencies: { beforeRead } }),
  });
  return { base, loaded };
}

async function writeCompletion(loaded: LoadedConfig, value: Record<string, unknown>, name = `${ADMISSION_ID}.complete.json`): Promise<{ readonly path: string; readonly sha256: string; readonly absolutePath: string }> {
  const directory = join(loaded.stateRoot, 'jobs', JOB_ID, 'evidence', 'cleanup');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${encodeJson(value, 'completion evidence', true)}\n`, 'utf8');
  const path = join(directory, name);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path: `jobs/${JOB_ID}/evidence/cleanup/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), absolutePath: path };
}

async function writeRawCompletion(loaded: LoadedConfig, bytes: Buffer, name = `${ADMISSION_ID}.complete.json`): Promise<{ readonly path: string; readonly sha256: string; readonly absolutePath: string }> {
  const directory = join(loaded.stateRoot, 'jobs', JOB_ID, 'evidence', 'cleanup');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const absolutePath = join(directory, name);
  await writeFile(absolutePath, bytes, { mode: 0o600 });
  return { path: `jobs/${JOB_ID}/evidence/cleanup/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), absolutePath };
}

async function setupOutput(loaded: LoadedConfig, rootId = ROOT_ID): Promise<string> {
  const output = loaded.config.approvedOutputRoots.find((root) => root.id === rootId)!.path;
  const builder = join(output, '.osi-image-builder');
  await mkdir(builder, { mode: 0o750 });
  await mkdir(join(builder, 'staging'), { mode: 0o750 });
  await mkdir(join(builder, 'quarantine'), { mode: 0o750 });
  return output;
}

function quarantinedPostcondition(sha256: string | null = null, size: number | null = null): CleanupPostcondition['staging'] {
  return {
    kind: 'quarantined',
    sourcePath: `staging/${JOB_ID}`,
    destinationPath: `quarantine/${JOB_ID}`,
    sourceAbsent: true,
    destinationPresent: true,
    sha256,
    size,
    verifiedAt: NOW,
  };
}

function presentPostcondition(sha256: string, size: number): RecoveryStagingPostcondition {
  return {
    kind: 'present',
    sourcePath: `staging/${JOB_ID}`,
    sourcePresent: true,
    destinationPath: `quarantine/${JOB_ID}`,
    destinationAbsent: true,
    sha256,
    size,
    verifiedAt: NOW,
  };
}

function createFactory(loaded: LoadedConfig) {
  return createRecoveryPhysicalVerification({
    stateRootAuthority: loaded.pathAuthorities.stateRoot,
    approvedRootRegistry: loaded.pathAuthorities.approvedRoots,
    ownerUid: process.getuid?.() ?? 0,
  });
}

function logVerificationInput(bytes: Buffer): RecoveryLogVerificationInput {
  return {
    jobId: JOB_ID,
    completedAt: NOW,
    completionEventSeq: 10,
    postcondition: { ...postcondition().logs, runner: 'sealed' },
    generations: [{
      stream: 'runner',
      generation: 0,
      path: 'logs/runner-0.log',
      startedAt: STALE,
      sealedAt: NOW,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
    events: [{
      stream: 'runner',
      fileGeneration: 0,
      seq: 0,
      eventType: 'log',
      at: NOW,
      byteOffset: 0,
      byteLength: bytes.length,
      partial: 0,
    }],
  };
}

async function writeLog(loaded: LoadedConfig, bytes = Buffer.from('runner cleanup log\n')): Promise<string> {
  const directory = join(loaded.stateRoot, 'jobs', JOB_ID, 'logs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'runner-0.log');
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

async function createUnixSocket(path: string): Promise<Server> {
  const server = createServer();
  const boundPath = `/tmp/osi-recovery-socket-${process.pid}-${Math.random().toString(36).slice(2)}`;
  server.listen(boundPath);
  await once(server, 'listening');
  await rename(boundPath, path);
  return server;
}

async function createFifo(path: string): Promise<void> {
  await execFile('/usr/bin/mkfifo', [path], { windowsHide: true });
}

async function physicalReadWithTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('physical recovery read timed out')), 250);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stagingInput(staging: RecoveryStagingPostcondition, overrides: Partial<{
  readonly rootId: string;
  readonly publishState: string | null;
  readonly artifactStagingPath: string | null;
  readonly artifactSha256: string | null;
  readonly artifactSize: number | null;
  readonly artifactMtime: string | null;
  readonly checksumPath: string | null;
  readonly checksumSha256: string | null;
  readonly manifestPath: string | null;
  readonly manifestSha256: string | null;
  readonly verificationPath: string | null;
  readonly verificationSha256: string | null;
}> = {}) {
  return {
    jobId: JOB_ID,
    admissionId: ADMISSION_ID,
    rootId: overrides.rootId ?? ROOT_ID,
    publishState: overrides.publishState ?? null,
    artifactStagingPath: overrides.artifactStagingPath ?? null,
    artifactSha256: overrides.artifactSha256 ?? null,
    artifactSize: overrides.artifactSize ?? null,
    artifactMtime: overrides.artifactMtime ?? null,
    checksumPath: overrides.checksumPath ?? null,
    checksumSha256: overrides.checksumSha256 ?? null,
    manifestPath: overrides.manifestPath ?? null,
    manifestSha256: overrides.manifestSha256 ?? null,
    verificationPath: overrides.verificationPath ?? null,
    verificationSha256: overrides.verificationSha256 ?? null,
    postcondition: staging,
  } as const;
}

function trackedIdentity(artifact: Buffer) {
  return {
    artifactStagingPath: `staging/${JOB_ID}/image.img.gz`,
    artifactSha256: createHash('sha256').update(artifact).digest('hex'),
    artifactSize: artifact.byteLength,
    artifactMtime: NOW,
    checksumPath: `staging/${JOB_ID}/sha256sums`,
    checksumSha256: createHash('sha256').update(CHECKSUM_BYTES).digest('hex'),
    manifestPath: `staging/${JOB_ID}/build-manifest.json`,
    manifestSha256: createHash('sha256').update(MANIFEST_BYTES).digest('hex'),
    verificationPath: `staging/${JOB_ID}/verification.json`,
    verificationSha256: createHash('sha256').update(VERIFICATION_BYTES).digest('hex'),
  } as const;
}

async function writeTrackedQuarantine(loaded: LoadedConfig, artifact: Buffer): Promise<string> {
  const output = await setupOutput(loaded);
  const destination = join(output, '.osi-image-builder', 'quarantine', JOB_ID);
  await mkdir(destination, { mode: 0o700 });
  await writeTrackedFiles(destination, artifact);
  return destination;
}

async function writeTrackedFiles(destination: string, artifact: Buffer): Promise<void> {
  const artifactPath = join(destination, 'image.img.gz');
  await writeFile(artifactPath, artifact, { mode: 0o600 });
  await utimes(artifactPath, new Date(NOW), new Date(NOW));
  await writeFile(join(destination, 'sha256sums'), CHECKSUM_BYTES, { mode: 0o600 });
  await writeFile(join(destination, 'build-manifest.json'), MANIFEST_BYTES, { mode: 0o600 });
  await writeFile(join(destination, 'verification.json'), VERIFICATION_BYTES, { mode: 0o600 });
}

describe('production recovery physical verification', () => {
  it('verifies logs written by DurableLogStream through the real recovery verifier', async () => {
    const value = await fixture();
    const database = openBuilderDatabase(join(value.base, 'builder.sqlite'));
    const jobRoot = join(value.loaded.stateRoot, 'jobs', JOB_ID);
    await mkdir(jobRoot, { recursive: true, mode: 0o700 });
    const targetManifestSha256 = 'c'.repeat(64);
    const identity = createTestBuilderIdentity(targetManifestSha256);
    const values = [
      JOB_ID, `${JOB_ID}-request`, '{}', 'ssh://example/repo', 'refs/remotes/origin/main', 'main', 'main',
      'a'.repeat(40), 'a'.repeat(40), '{}', '{}', 'rpi-5', ROOT_ID, targetManifestSha256, 'admitted',
      identity.packageVersion, identity.packageRoot, identity.lockSha256, identity.executionDefinitionSha256,
      identity.targetManifestSha256, identity.runnerSha256, identity.cleanupWorkerSha256,
      identity.dependencyEgressProxySha256, identity.imageReference,
      identity.imageId, identity.imageDigest, NOW, 'test', 'logs', NOW, 'building', 'released', null, NOW, NOW,
    ];
    database.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json,
      target_id, root_id, target_manifest_sha256, builder_identity_status, builder_package_version,
      builder_package_root, builder_lock_sha256, builder_execution_definition_sha256, builder_target_manifest_sha256,
      builder_runner_sha256, builder_cleanup_worker_sha256, builder_dependency_egress_proxy_sha256,
      builder_image_reference, builder_image_id, builder_image_digest,
      source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at)
      VALUES (${values.map(() => '?').join(', ')})`).run(...values);
    const stream = new DurableLogStream({ db: database, root: jobRoot, jobId: JOB_ID, now: () => NOW });
    stream.appendSync('runner', Buffer.from('runner output\n'));
    stream.appendSync('docker', Buffer.from('docker output\n'));
    stream.sealSync('runner');
    stream.sealSync('docker');
    stream.close();
    try {
      await expect(recoveryLogObservation(database, createFactory(value.loaded), JOB_ID, NOW)).resolves.toMatchObject({
        snapshot: { runner: 'sealed', docker: 'sealed', verifiedAt: NOW },
      });
      expect((await stat(join(jobRoot, 'logs'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(jobRoot, 'logs', 'runner.0'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(jobRoot, 'logs', 'docker.0'))).mode & 0o777).toBe(0o600);
    } finally {
      database.close();
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('uses a collected admission-specific systemd sandbox exposing only the admitted package', async () => {
    const run = vi.fn(async (argv: readonly string[]) => ({
      argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW,
    }));
    const identity = createTestBuilderIdentity();
    const systemd = createProductionSystemdAdapter({ run } as never, {
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    }, () => NOW, {
      configRoot: '/home/builder/.config/osi-image-builder',
      stateRoot: '/home/builder/.local/state/osi-image-builder',
      repositoryPath: '/home/builder/Repos/osi-os',
      approvedOutputRoots: ['/home/builder/sdcard images'],
    });
    const unit = `osi-image-builder-cleanup@${ADMISSION_ID}.service`;
    await expect(systemd.startCleanup(unit, identity)).resolves.toMatchObject({
      argv: expect.arrayContaining(['systemd-run', '--user', `--unit=${unit}`, '--collect', '--no-block']),
    });
    const argv = run.mock.calls[0]![0] as readonly string[];
    expect(argv[0]).toBe('/usr/bin/systemd-run');
    expect(argv).toContain('--expand-environment=no');
    expect(argv).toContain('--service-type=exec');
    expect(argv).toContain(`--property=BindReadOnlyPaths="${identity.packageRoot}" "/home/builder/.config/osi-image-builder" "/home/builder/sdcard images" "/run/user/1000"`);
    expect(argv).toContain('--property=BindPaths="/home/builder/.local/state/osi-image-builder" "/home/builder/sdcard images/.osi-image-builder"');
    expect(argv).toContain('--property=InaccessiblePaths="-/home/builder/Repos/osi-os"');
    expect(argv).toContain('--property=ProtectHome=tmpfs');
    expect(argv).toContain('--property=ProtectSystem=strict');
    expect(argv).toContain('--property=NoExecPaths=/');
    expect(argv).toContain(`--property=ExecPaths="${identity.packageRoot}/bin/osi-image-builder-cleanup" "${identity.packageRoot}/bin/osi-image-publish" "/usr/bin/env" "/usr/bin/node" "/usr/bin/systemctl" "/usr/bin/docker" "/usr/lib" "/usr/lib64"`);
    expect(argv).not.toContain(expect.stringMatching(/selected|0\.1\.25/u));
    expect(argv.slice(-3)).toEqual(['--', `${identity.packageRoot}/bin/osi-image-builder-cleanup`, ADMISSION_ID]);
  });

  it.each([
    ['state root', '/home/builder/state$HOME'],
    ['state root', '/home/builder/state%h'],
    ['state root', '/home/builder/state:ro'],
    ['state root', '/home/builder/state\\x20alias'],
    ['state root', '/home/builder/state"alias'],
    ['state root', "/home/builder/state'alias"],
    ['state root', '/home/builder/state=alias'],
    ['state root', '/home/builder/state;alias'],
    ['state root', '/home/builder/state\talias'],
    ['output root', '/home/builder/output%h'],
  ] as const)('rejects a %s containing systemd property syntax: %s', async (field, unsafePath) => {
    const run = vi.fn(async (argv: readonly string[]) => ({
      argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW,
    }));
    const systemd = createProductionSystemdAdapter({ run } as never, {
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    }, () => NOW, {
      configRoot: '/home/builder/.config/osi-image-builder',
      stateRoot: field === 'state root' ? unsafePath : '/home/builder/.local/state/osi-image-builder',
      repositoryPath: '/home/builder/Repos/osi-os',
      approvedOutputRoots: [field === 'output root' ? unsafePath : '/home/builder/sdcard images'],
    });

    await expect(systemd.startCleanup(
      `osi-image-builder-cleanup@${ADMISSION_ID}.service`,
      createTestBuilderIdentity(),
    )).rejects.toThrow(new RegExp(`cleanup systemd ${field} is invalid`, 'iu'));
    expect(run).not.toHaveBeenCalled();
  });

  it('routes recovery admission starts through the cleanup-specific systemd boundary', async () => {
    const unit = `osi-image-builder-cleanup@${ADMISSION_ID}.service`;
    const startCleanup = vi.fn(async () => ({
      unit, argv: ['systemd-run', '--user', `--unit=${unit}`], exitCode: 0, timedOut: false, signal: null,
    }));
    const identity = createTestBuilderIdentity();
    const recoverySystemd = createProductionCleanupSystemd({
      startCleanup,
      isActive: async () => false,
      stop: async () => undefined,
      inspectRecovery: async () => ({ unit, active: false, observedAt: NOW }),
    }, async () => identity);
    await recoverySystemd.start(unit);
    expect(startCleanup).toHaveBeenCalledWith(unit, identity);
  });
  it('classifies semantic and identity ConfigAuthorityError values as recovery boundaries', () => {
    const semantic = new ConfigAuthorityError('unknown approved root', undefined, 'OUTPUT_ROOT_ID_UNKNOWN');
    const identity = new ConfigAuthorityError('approved root identity changed');
    expect(classifyRecoveryAuthorityError('approved root authority failed', semantic)).toBeInstanceOf(RecoveryBoundaryError);
    expect(classifyRecoveryAuthorityError('approved root authority failed', identity)).toBeInstanceOf(RecoveryBoundaryError);
  });

  it.each(['ENOENT', 'ELOOP', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'] as const)('classifies authority-wrapped %s as a recovery boundary', (code) => {
    const cause = Object.assign(new Error(`authority failed: ${code}`), { code });
    const classified = classifyRecoveryAuthorityError('approved root authority failed', new ConfigAuthorityError('authority failed', { cause }));
    expect(classified).toBeInstanceOf(RecoveryBoundaryError);
    expect(classified).not.toBeInstanceOf(RecoveryInfrastructureError);
  });

  it.each([
    Object.assign(new Error('read-only filesystem'), { code: 'EROFS' }),
    Object.assign(new Error('interrupted operation'), { code: 'EINTR' }),
    Object.assign(new Error('device failure'), { code: 'EIO' }),
    Object.assign(new Error('unknown errno'), { code: 'EUNKNOWN' }),
    new Error('authority cause without errno'),
  ])('classifies an authority-wrapped unknown or infrastructure cause as recovery infrastructure', (cause) => {
    const classified = classifyRecoveryAuthorityError('approved root authority failed', new ConfigAuthorityError('authority failed', { cause }));
    expect(classified).toBeInstanceOf(RecoveryInfrastructureError);
    expect(classified).not.toBeInstanceOf(RecoveryBoundaryError);
  });

  it.each(['EIO', 'EMFILE', 'ENFILE', 'ENOMEM', 'ESTALE'] as const)('classifies descriptor-open %s as recovery infrastructure failure', (code) => {
    const error = Object.assign(new Error(`open failed: ${code}`), { code });
    const classified = classifyRecoveryFileSystemError('open', 'cannot open recovery evidence', error);
    expect(classified).toBeInstanceOf(RecoveryInfrastructureError);
    expect(classified).not.toBeInstanceOf(RecoveryBoundaryError);
  });

  it.each(['ENOENT', 'ELOOP'] as const)('classifies descriptor-open %s as a recovery boundary failure', (code) => {
    const error = Object.assign(new Error(`open failed: ${code}`), { code });
    expect(classifyRecoveryFileSystemError('open', 'cannot open recovery evidence', error)).toBeInstanceOf(RecoveryBoundaryError);
  });

  it('classifies an unknown descriptor-open exception as recovery infrastructure failure', () => {
    const classified = classifyRecoveryFileSystemError('open', 'cannot open recovery evidence', new Error('unexpected open failure'));
    expect(classified).toBeInstanceOf(RecoveryInfrastructureError);
    expect(classified).not.toBeInstanceOf(RecoveryBoundaryError);
  });

  it.each(['stat', 'read', 'close'] as const)('classifies raw descriptor %s failure as recovery infrastructure failure', (operation) => {
    const classified = classifyRecoveryFileSystemError(operation, `recovery descriptor ${operation} failed`, new Error('raw I/O failure'));
    expect(classified).toBeInstanceOf(RecoveryInfrastructureError);
    expect(classified).not.toBeInstanceOf(RecoveryBoundaryError);
  });

  it('reads a canonical completion envelope from the held state-root authority and hashes its actual bytes', async () => {
    expect(ADMISSION_ID_PATTERN.test(ADMISSION_ID)).toBe(true);
    const value = await fixture();
    try {
      const file = await writeCompletion(value.loaded, completionEnvelope());
      const physical = createFactory(value.loaded);

      await expect(physical.evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).resolves.toMatchObject({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        sha256: file.sha256,
        postcondition: postcondition(),
      });
      await expect(readFile(join(value.loaded.stateRoot, file.path))).resolves.toBeTruthy();
      expect(file.sha256).toMatch(HASH64);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects legacy persisted Docker evidence without bound operation, TLS, and credential identity', async () => {
    const value = await fixture();
    try {
      const condition = postcondition();
      const withPersistedDocker = {
        ...condition,
        egress: {
          ...condition.egress,
          persistedDocker: {
            proxy: { id: 'a'.repeat(64), absent: true },
            network: { id: 'b'.repeat(64), absent: true },
            globalLabelResult: 'no-match',
          },
        },
      } as unknown as CleanupPostcondition;
      const file = await writeCompletion(value.loaded, completionEnvelope(withPersistedDocker));
      await expect(createFactory(value.loaded).evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).rejects.toThrow(/persistedDocker|egress/u);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('reads state-root-bound persisted, TLS, and credential absence evidence', async () => {
    const value = await fixture();
    try {
      const condition = { ...postcondition(), egress: stateRootBoundEgress(value.loaded.stateRoot) } as unknown as CleanupPostcondition;
      const file = await writeCompletion(value.loaded, completionEnvelope(condition));
      await expect(createFactory(value.loaded).evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).resolves.toMatchObject({ postcondition: condition });
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('reads state-root-bound discovered Docker, TLS, and credential absence evidence', async () => {
    const value = await fixture();
    try {
      const credentialRoot = join(value.loaded.stateRoot, 'jobs', JOB_ID, 'recovery', 'dependency-egress');
      const hostPath = join(credentialRoot, 'frontend-install-1.proxy-credential');
      const condition = {
        ...postcondition(),
        egress: {
          persistedDocker: null,
          discoveredDocker: [{
            operationId: 'frontend-install',
            attempt: 1,
            proxy: null,
            network: { id: 'a'.repeat(64), absent: true },
            tls: { hostDirectory: join(credentialRoot, 'frontend-install-1.proxy-tls'), absent: true },
            credential: { hostPath, sha256: 'b'.repeat(64) },
          }],
          credentials: [{ kind: 'normal', operationId: 'frontend-install', attempt: 1, hostPath, expectedSha256: 'b'.repeat(64), observedSha256: 'b'.repeat(64), tls: { hostDirectory: join(credentialRoot, 'frontend-install-1.proxy-tls'), absent: true }, absent: true }],
          globalLabelResult: 'no-match',
        },
      } as unknown as CleanupPostcondition;
      const file = await writeCompletion(value.loaded, completionEnvelope(condition));
      await expect(createFactory(value.loaded).evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).resolves.toMatchObject({ postcondition: condition });
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('reads an exact TLS-only remnant without inventing a credential hash', async () => {
    const value = await fixture();
    try {
      const credentialRoot = join(value.loaded.stateRoot, 'jobs', JOB_ID, 'recovery', 'dependency-egress');
      const hostPath = join(credentialRoot, 'build-image-2.proxy-credential');
      const hostDirectory = join(credentialRoot, 'build-image-2.proxy-tls');
      const condition = {
        ...postcondition(),
        egress: {
          persistedDocker: null,
          discoveredDocker: [],
          credentials: [{ kind: 'tls-only', operationId: 'build-image', attempt: 2, hostPath, expectedSha256: null, observedSha256: null, tls: { hostDirectory, absent: true }, absent: true }],
          globalLabelResult: 'no-match',
        },
      } as unknown as CleanupPostcondition;
      const file = await writeCompletion(value.loaded, completionEnvelope(condition));
      await expect(createFactory(value.loaded).evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 })).resolves.toMatchObject({ postcondition: condition });
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects state-root escape in a Docker or credential absence proof', async () => {
    const value = await fixture();
    try {
      const condition = {
        ...postcondition(),
        egress: stateRootBoundEgress(value.loaded.stateRoot, { credentialRoot: join(value.loaded.stateRoot, 'jobs', 'other-job', 'recovery', 'dependency-egress') }),
      } as unknown as CleanupPostcondition;
      const file = await writeCompletion(value.loaded, completionEnvelope(condition));
      await expect(createFactory(value.loaded).evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).rejects.toThrow(/state root|egress|credential/u);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects nested global-label attestation on discovered Docker absence evidence', async () => {
    const value = await fixture();
    try {
      const malformed = {
        ...postcondition(),
        egress: {
          ...postcondition().egress,
          discoveredDocker: [{
            proxy: null,
            network: { id: 'a'.repeat(64), absent: true },
            globalLabelResult: 'no-match',
          }],
        },
      };
      const file = await writeCompletion(value.loaded, completionEnvelope(malformed as unknown as CleanupPostcondition));
      await expect(createFactory(value.loaded).evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).rejects.toThrow(/discoveredDocker/u);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects duplicate discovered operation evidence before recovery hand-back', async () => {
    const value = await fixture();
    try {
      const credentialRoot = join(value.loaded.stateRoot, 'jobs', JOB_ID, 'recovery', 'dependency-egress');
      const hostPath = join(credentialRoot, 'frontend-install-1.proxy-credential');
      const proof = {
        operationId: 'frontend-install',
        attempt: 1,
        proxy: null,
        network: { id: 'a'.repeat(64), absent: true },
        tls: { hostDirectory: join(credentialRoot, 'frontend-install-1.proxy-tls'), absent: true },
        credential: { hostPath, sha256: 'b'.repeat(64) },
      };
      const malformed = {
        ...postcondition(),
        egress: {
          persistedDocker: null,
          discoveredDocker: [proof, { ...proof, network: { id: 'c'.repeat(64), absent: true } }],
          credentials: [{ kind: 'normal', operationId: 'frontend-install', attempt: 1, hostPath, expectedSha256: 'b'.repeat(64), observedSha256: 'b'.repeat(64), tls: { hostDirectory: join(credentialRoot, 'frontend-install-1.proxy-tls'), absent: true }, absent: true }],
          globalLabelResult: 'no-match',
        },
      } as unknown as CleanupPostcondition;
      const file = await writeCompletion(value.loaded, completionEnvelope(malformed));
      await expect(createFactory(value.loaded).evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).rejects.toThrow(/duplicate|Docker absence/u);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a completion envelope without exact dependency egress absence evidence', async () => {
    const value = await fixture();
    try {
      const malformed = { ...postcondition(), egress: { globalLabelResult: 'no-match' } };
      const file = await writeCompletion(value.loaded, completionEnvelope(malformed as CleanupPostcondition));
      await expect(createFactory(value.loaded).evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 })).rejects.toThrow(/egress/u);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rebinds the state-root pathname after completion evidence is read', async () => {
    let loadedRoot = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || loadedRoot === '') return;
      swapped = true;
      const replacement = `${loadedRoot}.replacement`;
      await rename(loadedRoot, replacement);
      await mkdir(loadedRoot, { mode: 0o700 });
    });
    loadedRoot = value.loaded.stateRoot;
    try {
      const file = await writeCompletion(value.loaded, completionEnvelope());
      const physical = createFactory(value.loaded);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 })).rejects.toThrow(/state root|authority|identity/);
      expect(swapped).toBe(true);
      await rm(loadedRoot, { recursive: true, force: true });
      await rename(`${loadedRoot}.replacement`, loadedRoot);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a completion evidence basename swap after hashing the held descriptor', async () => {
    let evidencePath = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || evidencePath === '') return;
      swapped = true;
      await rename(evidencePath, `${evidencePath}.held`);
      const replacement = await writeCompletion(value.loaded, completionEnvelope());
      expect(replacement.absolutePath).toBe(evidencePath);
    });
    try {
      const file = await writeCompletion(value.loaded, completionEnvelope());
      evidencePath = file.absolutePath;
      const physical = createFactory(value.loaded);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 })).rejects.toThrow(/descriptor identity|identity|changed/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a completion evidence subtree swap after hashing the held descriptor', async () => {
    let cleanupPath = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || cleanupPath === '') return;
      swapped = true;
      await rename(cleanupPath, `${cleanupPath}.held`);
      await mkdir(cleanupPath, { mode: 0o700 });
      const replacement = await writeCompletion(value.loaded, completionEnvelope());
      expect(replacement.absolutePath).toBe(join(cleanupPath, `${ADMISSION_ID}.complete.json`));
    });
    try {
      const file = await writeCompletion(value.loaded, completionEnvelope());
      cleanupPath = join(value.loaded.stateRoot, 'jobs', JOB_ID, 'evidence', 'cleanup');
      const physical = createFactory(value.loaded);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 })).rejects.toThrow(/descriptor identity|identity|changed/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('physically verifies every sealed log generation under the state-root authority', async () => {
    const value = await fixture();
    try {
      const bytes = Buffer.from('runner cleanup log\n');
      await writeLog(value.loaded, bytes);
      const physical = createFactory(value.loaded);
      await expect(physical.logs.verify(logVerificationInput(bytes))).resolves.toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it.each(['tampered bytes', 'wrong mode', 'hard link'] as const)('rejects post-cleanup physical log %s evidence', async (mutation) => {
    const value = await fixture();
    try {
      const bytes = Buffer.from('runner cleanup log\n');
      const path = await writeLog(value.loaded, bytes);
      if (mutation === 'tampered bytes') await writeFile(path, Buffer.from('runner tampered!\n'), { mode: 0o600 });
      if (mutation === 'wrong mode') await chmod(path, 0o640);
      if (mutation === 'hard link') await link(path, join(value.loaded.stateRoot, 'hard-linked-log'));
      const physical = createFactory(value.loaded);
      await expect(physical.logs.verify(logVerificationInput(bytes))).rejects.toThrow(/log|unsafe|hash|changed/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a state-root swap while the physical log descriptor is held', async () => {
    let loadedRoot = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || loadedRoot === '') return;
      swapped = true;
      const replacement = `${loadedRoot}.replacement`;
      await rename(loadedRoot, replacement);
      await mkdir(loadedRoot, { mode: 0o700 });
    });
    loadedRoot = value.loaded.stateRoot;
    try {
      const bytes = Buffer.from('runner cleanup log\n');
      await writeLog(value.loaded, bytes);
      const physical = createFactory(value.loaded);
      await expect(physical.logs.verify(logVerificationInput(bytes))).rejects.toThrow(/state root|authority|identity/);
      expect(swapped).toBe(true);
      await rm(loadedRoot, { recursive: true, force: true });
      await rename(`${loadedRoot}.replacement`, loadedRoot);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a physical log basename swap after hashing the held descriptor', async () => {
    let logPath = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || logPath === '') return;
      swapped = true;
      await rename(logPath, `${logPath}.held`);
      await writeFile(logPath, Buffer.from('runner cleanup log\n'), { mode: 0o600 });
    });
    try {
      const bytes = Buffer.from('runner cleanup log\n');
      logPath = await writeLog(value.loaded, bytes);
      const physical = createFactory(value.loaded);
      await expect(physical.logs.verify(logVerificationInput(bytes))).rejects.toThrow(/descriptor identity|identity|changed/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a physical log subtree swap after hashing the held descriptor', async () => {
    let logDirectory = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || logDirectory === '') return;
      swapped = true;
      await rename(logDirectory, `${logDirectory}.held`);
      await mkdir(logDirectory, { mode: 0o700 });
      await writeFile(join(logDirectory, 'runner-0.log'), Buffer.from('runner cleanup log\n'), { mode: 0o600 });
    });
    try {
      const bytes = Buffer.from('runner cleanup log\n');
      logDirectory = join(value.loaded.stateRoot, 'jobs', JOB_ID, 'logs');
      await writeLog(value.loaded, bytes);
      const physical = createFactory(value.loaded);
      await expect(physical.logs.verify(logVerificationInput(bytes))).rejects.toThrow(/descriptor identity|identity|changed/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('reopens the canonical log chain after the final authority revalidation', async () => {
    let logDirectory = '';
    let swapped = false;
    let beforeReads = 0;
    const value = await fixture(async () => {
      beforeReads += 1;
      if (beforeReads !== 2 || swapped || logDirectory === '') return;
      swapped = true;
      await rename(logDirectory, `${logDirectory}.held`);
      await mkdir(logDirectory, { mode: 0o700 });
      await writeFile(join(logDirectory, 'runner-0.log'), Buffer.from('runner cleanup log\n'), { mode: 0o600 });
      await writeFile(join(logDirectory, 'unexpected-extra.log'), Buffer.from('unexpected\n'), { mode: 0o600 });
    });
    try {
      const bytes = Buffer.from('runner cleanup log\n');
      logDirectory = join(value.loaded.stateRoot, 'jobs', JOB_ID, 'logs');
      await writeLog(value.loaded, bytes);
      await expect(createFactory(value.loaded).logs.verify(logVerificationInput(bytes))).rejects.toThrow(/identity|changed|unindexed|entry/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects an unindexed physical log when both persisted streams are absent', async () => {
    const value = await fixture();
    try {
      await writeLog(value.loaded);
      const physical = createFactory(value.loaded);
      const absent: RecoveryLogVerificationInput = {
        jobId: JOB_ID,
        completedAt: NOW,
        completionEventSeq: 10,
        postcondition: { ...postcondition().logs, runner: 'absent', docker: 'absent' },
        generations: [],
        events: [],
      };
      await expect(physical.logs.verify(absent)).rejects.toThrow(/unindexed|log tree|entry/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it.each([
    ['a single oversized log path segment', `logs/${'x'.repeat(5000)}`],
    ['an excessively deep log path', `logs/${Array.from({ length: 17 }, (_, index) => `d${index}`).join('/')}/runner.log`],
    ['a log path whose encoded bytes exceed the total bound', `logs/${Array.from({ length: 16 }, () => 'x'.repeat(255)).join('/')}`],
  ])('rejects %s before opening the state root', async (_label, path) => {
    const value = await fixture();
    try {
      const physical = createFactory(value.loaded);
      await expect(physical.logs.verify({
        jobId: JOB_ID,
        completedAt: NOW,
        completionEventSeq: 10,
        postcondition: { ...postcondition().logs, runner: 'sealed' },
        generations: [{ stream: 'runner', generation: 0, path, startedAt: STALE, sealedAt: NOW, sizeBytes: 0, sha256: 'a'.repeat(64) }],
        events: [],
      })).rejects.toThrow(/path|depth|bounded|descriptor/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a log descriptor plan overflow before any physical traversal', async () => {
    const value = await fixture();
    try {
      const generations = Array.from({ length: 128 }, (_, generation) => ({
        stream: 'runner' as const,
        generation,
        path: `logs/${Array.from({ length: 15 }, (_, depth) => `g${generation}-${depth}`).join('/')}/runner.log`,
        startedAt: STALE,
        sealedAt: NOW,
        sizeBytes: 0,
        sha256: 'a'.repeat(64),
      }));
      await expect(createFactory(value.loaded).logs.verify({
        jobId: JOB_ID,
        completedAt: NOW,
        completionEventSeq: 10,
        postcondition: { ...postcondition().logs, runner: 'sealed' },
        generations,
        events: [],
      })).rejects.toThrow(/descriptor|plan|bounded|depth/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a near-limit log descriptor plan before traversal or materialization', async () => {
    let reachedPhysicalTraversal = false;
    const value = await fixture(async () => {
      reachedPhysicalTraversal = true;
    });
    try {
      const generations = Array.from({ length: 83 }, (_, generation) => ({
        stream: 'runner' as const,
        generation,
        path: `logs/${Array.from({ length: 11 }, (_, depth) => `g${generation}-${depth}`).join('/')}/runner.log`,
        startedAt: STALE,
        sealedAt: NOW,
        sizeBytes: 0,
        sha256: 'a'.repeat(64),
      }));
      await expect(createFactory(value.loaded).logs.verify({
        jobId: JOB_ID,
        completedAt: NOW,
        completionEventSeq: 10,
        postcondition: { ...postcondition().logs, runner: 'sealed' },
        generations,
        events: [],
      })).rejects.toThrow(/descriptor|plan|bounded/);
      expect(reachedPhysicalTraversal).toBe(false);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a path outside the fixed completion file, a wrong hash, and a non-canonical extra field', async () => {
    const value = await fixture();
    try {
      const physical = createFactory(value.loaded);
      const file = await writeCompletion(value.loaded, completionEnvelope());
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: `jobs/${JOB_ID}/evidence/cleanup/other.json`, sha256: file.sha256 })).rejects.toThrow(/fixed completion path/);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: 'a'.repeat(64) })).rejects.toThrow(/hash/);
      const extra = completionEnvelope() as Record<string, unknown>;
      extra.extra = true;
      const extraFile = await writeCompletion(value.loaded, extra);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: extraFile.path, sha256: extraFile.sha256 })).rejects.toThrow(/extra or missing fields/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects corrupt, non-canonical, and oversized evidence before returning a postcondition', async () => {
    const value = await fixture();
    try {
      const physical = createFactory(value.loaded);
      const corrupt = await writeRawCompletion(value.loaded, Buffer.from('{"kind":"cleanup-complete"}\n', 'utf8'));
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: corrupt.path, sha256: corrupt.sha256 })).rejects.toThrow(/identity|extra|missing/);
      await unlink(corrupt.absolutePath);
      const nonCanonical = Buffer.from('{"schemaVersion":1,"kind":"cleanup-complete","admissionId":"cln_0123456789abcdefghjkmnpqrs","jobId":"recovery-production-job","postcondition":{},"observedAt":"2026-07-28T12:00:00.000Z"}\n', 'utf8');
      const nonCanonicalFile = await writeRawCompletion(value.loaded, nonCanonical);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: nonCanonicalFile.path, sha256: nonCanonicalFile.sha256 })).rejects.toThrow(/canonical|postcondition/);
      await unlink(nonCanonicalFile.absolutePath);
      const oversized = await writeRawCompletion(value.loaded, Buffer.alloc(65_538, 0x20));
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: oversized.path, sha256: oversized.sha256 })).rejects.toThrow(/bounded read/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects evidence symlinks, hard links, and wrong file modes', async () => {
    const value = await fixture();
    try {
      const physical = createFactory(value.loaded);
      const first = await writeCompletion(value.loaded, completionEnvelope());
      const outside = join(value.base, 'outside-evidence.json');
      await writeFile(outside, await readFile(join(value.loaded.stateRoot, first.path)), { mode: 0o600 });
      await unlink(first.absolutePath);
      await symlink(outside, first.absolutePath);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: first.path, sha256: first.sha256 })).rejects.toThrow(/open recovery evidence|unsafe|regular/);
      await unlink(first.absolutePath);
      const second = await writeCompletion(value.loaded, completionEnvelope());
      await link(second.absolutePath, join(value.loaded.stateRoot, 'hard-link-evidence.json'));
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: second.path, sha256: second.sha256 })).rejects.toThrow(/unsafe cleanup evidence/);
      await unlink(join(value.loaded.stateRoot, 'hard-link-evidence.json'));
      await chmod(second.absolutePath, 0o644);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: second.path, sha256: second.sha256 })).rejects.toThrow(/unsafe cleanup evidence/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a Unix socket completion candidate without waiting for a readable stream', async () => {
    const value = await fixture();
    let server: Server | null = null;
    try {
      const file = await writeCompletion(value.loaded, completionEnvelope());
      await unlink(file.absolutePath);
      server = await createUnixSocket(file.absolutePath);
      const operation = physicalReadWithTimeout(createFactory(value.loaded).evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 }));
      await expect(operation).rejects.toThrow(/evidence|regular|unsafe|socket/);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('rejects a FIFO completion candidate without blocking the recovery read', async () => {
    const value = await fixture();
    try {
      const file = await writeCompletion(value.loaded, completionEnvelope());
      await unlink(file.absolutePath);
      await createFifo(file.absolutePath);
      await expect(physicalReadWithTimeout(createFactory(value.loaded).evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 }))).rejects.toThrow(/evidence|regular|unsafe/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects Unix socket log and quarantine candidates without waiting for a readable stream', async () => {
    const value = await fixture();
    let logServer: Server | null = null;
    let artifactServer: Server | null = null;
    try {
      const bytes = Buffer.from('runner cleanup log\n');
      const logPath = await writeLog(value.loaded, bytes);
      await unlink(logPath);
      logServer = await createUnixSocket(logPath);
      await expect(physicalReadWithTimeout(createFactory(value.loaded).logs.verify(logVerificationInput(bytes)))).rejects.toThrow(/log|regular|unsafe|socket/);

      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      const destination = await writeTrackedQuarantine(value.loaded, artifact);
      const artifactPath = join(destination, 'image.img.gz');
      await unlink(artifactPath);
      artifactServer = await createUnixSocket(artifactPath);
      await expect(physicalReadWithTimeout(createFactory(value.loaded).staging.verify(stagingInput(
        quarantinedPostcondition(tracked.artifactSha256, tracked.artifactSize), tracked,
      )))).rejects.toThrow(/artifact|regular|unsafe|socket/);
    } finally {
      await new Promise<void>((resolve) => logServer?.close(() => resolve()) ?? resolve());
      await new Promise<void>((resolve) => artifactServer?.close(() => resolve()) ?? resolve());
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a state-root path swap instead of following the replacement', async () => {
    const value = await fixture();
    const replacement = `${value.loaded.stateRoot}.held`;
    try {
      const physical = createFactory(value.loaded);
      const file = await writeCompletion(value.loaded, completionEnvelope());
      await rename(value.loaded.stateRoot, replacement);
      await symlink('/tmp', value.loaded.stateRoot);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 })).rejects.toThrow(/state root|configured path authority/);
      await unlink(value.loaded.stateRoot);
      await rename(replacement, value.loaded.stateRoot);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('verifies an explicitly absent staging and quarantine pair without mutating it', async () => {
    const value = await fixture();
    try {
      const output = await setupOutput(value.loaded);
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(postcondition().staging))).resolves.toBe(true);
      await expect(physical.staging.verify(stagingInput(postcondition().staging, {
        publishState: 'not_started',
        ...trackedIdentity(Buffer.from('planned artifact bytes\n', 'utf8')),
      }))).resolves.toBe(true);
      await expect(physical.staging.verify(stagingInput(postcondition().staging, {
        artifactStagingPath: `staging/${JOB_ID}/image.img.gz`,
        publishState: 'not_started',
      }))).rejects.toThrow(/complete artifact preparation intent/);
      await expect(physical.staging.verify(stagingInput(postcondition().staging, {
        publishState: 'publishing',
        ...trackedIdentity(Buffer.from('planned artifact bytes\n', 'utf8')),
      }))).rejects.toThrow(/publish state|not_started/);
      await expect(access(join(output, '.osi-image-builder', 'staging'))).resolves.toBeUndefined();
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('verifies a tracked quarantined artifact by hash and size, selecting the root from each request', async () => {
    const value = await fixture();
    try {
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      const destination = await writeTrackedQuarantine(value.loaded, artifact);
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition(tracked.artifactSha256, artifact.byteLength), tracked))).resolves.toBe(true);

      const otherOutput = await setupOutput(value.loaded, OTHER_ROOT_ID);
      await mkdir(join(otherOutput, '.osi-image-builder', 'quarantine', JOB_ID), { mode: 0o700 });
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition(), { rootId: OTHER_ROOT_ID }))).resolves.toBe(true);

      await writeFile(join(destination, 'image.img.gz'), Buffer.from('tampered\n'), { mode: 0o600 });
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition(tracked.artifactSha256, artifact.byteLength), tracked))).rejects.toThrow(/hash|size/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('returns held physical identity for an exact tracked staging artifact', async () => {
    const value = await fixture();
    try {
      const artifact = Buffer.from('tracked staging artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      const output = await setupOutput(value.loaded);
      const source = join(output, '.osi-image-builder', 'staging', JOB_ID);
      await mkdir(source, { mode: 0o700 });
      await writeTrackedFiles(source, artifact);

      await expect(createFactory(value.loaded).staging.verify(stagingInput(
        presentPostcondition(tracked.artifactSha256, tracked.artifactSize),
        { publishState: 'publishing', ...tracked },
      ))).resolves.toEqual({
        kind: 'present',
        path: tracked.artifactStagingPath,
        held: true,
        size: tracked.artifactSize,
        sha256: tracked.artifactSha256,
        verifiedAt: NOW,
      });
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a tracked artifact path that aliases the canonical checksum sidecar', async () => {
    const value = await fixture();
    try {
      const artifact = CHECKSUM_BYTES;
      const tracked = {
        ...trackedIdentity(artifact),
        artifactStagingPath: `staging/${JOB_ID}/sha256sums`,
      };
      const destination = await writeTrackedQuarantine(value.loaded, artifact);
      expect(destination).toContain(JOB_ID);
      await expect(createFactory(value.loaded).staging.verify(stagingInput(
        quarantinedPostcondition(tracked.artifactSha256, tracked.artifactSize), tracked,
      ))).rejects.toThrow(/distinct|collision|alias|path/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('surfaces production artifact-read device failure as recovery infrastructure failure', async () => {
    const ioError = Object.assign(new Error('device read failed'), { code: 'EIO' });
    const value = await fixture(async () => { throw ioError; });
    try {
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      await writeTrackedQuarantine(value.loaded, artifact);
      const physical = createFactory(value.loaded);
      const operation = physical.staging.verify(stagingInput(
        quarantinedPostcondition(tracked.artifactSha256, tracked.artifactSize),
        tracked,
      ));
      await expect(operation).rejects.toBeInstanceOf(RecoveryInfrastructureError);
      await expect(operation).rejects.not.toBeInstanceOf(RecoveryBoundaryError);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects expected tracked artifact bytes with a different physical mtime', async () => {
    const value = await fixture();
    try {
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      const destination = await writeTrackedQuarantine(value.loaded, artifact);
      await utimes(join(destination, 'image.img.gz'), new Date(STALE), new Date(STALE));
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(
        quarantinedPostcondition(tracked.artifactSha256, tracked.artifactSize),
        tracked,
      ))).rejects.toThrow(/mtime/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it.each([
    ['checksum', 'missing', 'sha256sums', CHECKSUM_BYTES],
    ['checksum', 'tampered', 'sha256sums', CHECKSUM_BYTES],
    ['manifest', 'missing', 'build-manifest.json', MANIFEST_BYTES],
    ['manifest', 'tampered', 'build-manifest.json', MANIFEST_BYTES],
    ['verification', 'missing', 'verification.json', VERIFICATION_BYTES],
    ['verification', 'tampered', 'verification.json', VERIFICATION_BYTES],
  ] as const)('rejects a %s sidecar when it is %s', async (_sidecar, mutation, name, original) => {
    const value = await fixture();
    try {
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      const destination = await writeTrackedQuarantine(value.loaded, artifact);
      const sidecar = join(destination, name);
      if (mutation === 'missing') {
        await unlink(sidecar);
      } else {
        await writeFile(sidecar, Buffer.concat([original, Buffer.from('tampered\n')]), { mode: 0o600 });
      }
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(
        quarantinedPostcondition(tracked.artifactSha256, tracked.artifactSize),
        tracked,
      ))).rejects.toThrow(/sidecar|evidence|hash|open/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects an identical quarantine destination swapped in while tracked files are held', async () => {
    let destination = '';
    let replacement = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || destination.length === 0) return;
      swapped = true;
      await rename(destination, `${destination}.held`);
      await rename(replacement, destination);
    });
    try {
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      destination = await writeTrackedQuarantine(value.loaded, artifact);
      replacement = `${destination}.replacement`;
      await mkdir(replacement, { mode: 0o700 });
      await writeTrackedFiles(replacement, artifact);
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(
        quarantinedPostcondition(tracked.artifactSha256, tracked.artifactSize),
        tracked,
      ))).rejects.toThrow(/destination|identity|changed/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a tracked quarantine basename swap after hashing the held file', async () => {
    let artifactPath = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || artifactPath === '') return;
      swapped = true;
      await rename(artifactPath, `${artifactPath}.held`);
      await writeFile(artifactPath, Buffer.from('tracked artifact bytes\n'), { mode: 0o600 });
    });
    try {
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      const destination = await writeTrackedQuarantine(value.loaded, artifact);
      artifactPath = join(destination, 'image.img.gz');
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition(tracked.artifactSha256, artifact.byteLength), tracked))).rejects.toThrow(/descriptor identity|identity|changed|quarantine/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects an approved-root pathname swapped while tracked files are held', async () => {
    let output = '';
    let swapped = false;
    const value = await fixture(async () => {
      if (swapped || output.length === 0) return;
      swapped = true;
      await rename(output, `${output}.held`);
      await mkdir(output, { mode: 0o700 });
    });
    try {
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const tracked = trackedIdentity(artifact);
      const destination = await writeTrackedQuarantine(value.loaded, artifact);
      output = value.loaded.config.approvedOutputRoots.find((root) => root.id === ROOT_ID)!.path;
      expect(destination.startsWith(output)).toBe(true);
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(
        quarantinedPostcondition(tracked.artifactSha256, tracked.artifactSize),
        tracked,
      ))).rejects.toThrow(/approved root|authority|identity|changed/);
      expect(swapped).toBe(true);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects staging and quarantine ambiguity, symlinks, and unsafe modes', async () => {
    const value = await fixture();
    try {
      const output = await setupOutput(value.loaded);
      const physical = createFactory(value.loaded);
      const source = join(output, '.osi-image-builder', 'staging', JOB_ID);
      const destination = join(output, '.osi-image-builder', 'quarantine', JOB_ID);
      await mkdir(source, { mode: 0o700 });
      await mkdir(destination, { mode: 0o700 });
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition()))).rejects.toThrow(/source and destination state/);
      await rm(source, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
      await symlink('/tmp', destination);
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition()))).rejects.toThrow(/inspect recovery directory/);
      await unlink(destination);
      await mkdir(destination, { mode: 0o700 });
      for (const mode of [0o750, 0o755]) {
        await chmod(destination, mode);
        await expect(physical.staging.verify(stagingInput(quarantinedPostcondition()))).rejects.toThrow(/unsafe recovery job directory/);
      }
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it.each([0o700, 0o755])('rejects publisher parent mode %o instead of exact 0750', async (mode) => {
    const value = await fixture();
    try {
      const output = await setupOutput(value.loaded);
      await chmod(join(output, '.osi-image-builder', 'quarantine'), mode);
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(postcondition().staging))).rejects.toThrow(/unsafe recovery publisher directory/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects an approved-root path swap and a postcondition with a non-fixed source path', async () => {
    const value = await fixture();
    const output = value.loaded.config.approvedOutputRoots[0]!.path;
    const replacement = `${output}.held`;
    try {
      await setupOutput(value.loaded);
      const physical = createFactory(value.loaded);
      const invalid = { ...postcondition().staging, sourcePath: 'staging/other-job' };
      await expect(physical.staging.verify(stagingInput(invalid))).rejects.toThrow(/invalid|fixed/);
      await rename(output, replacement);
      await symlink('/tmp', output);
      await expect(physical.staging.verify(stagingInput(postcondition().staging))).rejects.toThrow(/approved root|configured path authority/);
      await unlink(output);
      await rename(replacement, output);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });
});
