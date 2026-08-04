import { describe, expect, it } from 'vitest';

import { loadManifest } from '../../manifest/validate.js';
import { SourceResolverError } from '../../api/src/git/source-resolver.js';
import { validateBuilderLock } from '../../domain/builder-lock.js';
import {
  createReadOnlyPreflightDefaults, deriveSystemdBusEnvironment, PreflightError, PreflightService, TRUSTED_PREFLIGHT_EXECUTABLES,
  type PreflightCapabilities, type PreflightExecCapability, type PreflightRequest,
} from '../../api/src/preflight.js';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const baseDigest = 'c'.repeat(64);
const fixedNow = '2026-07-23T12:00:00.000Z';
const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname);
const request: PreflightRequest = Object.freeze({ branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'images' });
const config = {
    repository: { path: '/work/osi-os', remote: 'origin' as const },
  approvedOutputRoots: [{ id: 'images', label: 'Images', path: '/output/images', quarantinePath: '/output/images/.osi-image-builder/quarantine' }],
  builderLockPath: '/opt/osi-image-builder/2026.07.23.1/builder.lock.json', maxQueueLength: 50, diskFreeMinimumBytes: 20 * 1024 ** 3,
};
const loadedConfig = { config, redacted: config, configRoot: '/etc/osi-image-builder', stateRoot: '/state', pathAuthorities: { approvedRoots: {} as never, stateRoot: {} as never } };

function validSource() {
  return {
    remote: 'origin' as const,
    originUrl: 'ssh://git.example/osi-os',
    ref: 'refs/remotes/origin/main',
    branch: 'main',
    sha,
    commitTime: fixedNow,
    author: 'OSI <osi@example.com>',
    subject: 'current source',
    sourcePreparation: {
      schemaVersion: 1 as const,
      sourceSha: sha,
      gitmodulesBlobSha: '1'.repeat(40),
      preparedAt: fixedNow,
      components: [
        { path: 'feeds/chirpstack-openwrt-feed' as const, mode: '040000' as const, type: 'tree' as const, objectId: '2'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
        { path: 'openwrt' as const, mode: '040000' as const, type: 'tree' as const, objectId: '3'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
      ],
    },
  };
}

function sourceCapability(
  resolveAtAcceptance: PreflightCapabilities['sourceResolver']['resolveAtAcceptance'] = async () => validSource(),
): PreflightCapabilities['sourceResolver'] {
  return {
    resolveAtAcceptance,
    discardOfflineFeeds: async () => undefined,
    prepareOfflineFeeds: async (sourceSha, _stateRoot, jobId) => ({
      schemaVersion: 1,
      boundary: 'api-prepared-pinned-feeds-v1',
      networkPolicy: 'runner-offline',
      jobId,
      sourceSha,
      preparedAt: fixedNow,
      feeds: [],
    }),
  };
}

function validLock(): Record<string, unknown> {
  return {
    schemaVersion: 1, packageVersion: '2026.07.23.1', imageRepository: 'registry.osi.invalid/builder', imageDigest: digest,
    baseImage: `debian@sha256:${baseDigest}`, baseImageDigest: baseDigest, dockerfileSha256: 'd'.repeat(64),
    packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-18-dev', 'libzstd-dev'], rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.86.0', llvmMajor: 18 }, nodeVersion: '22.5.0',
    executionDefinitionSha256: 'e'.repeat(64), validationEvidenceSha256: 'f'.repeat(64), dependencyEgressProxySha256: '1'.repeat(64), installable: true,
  };
}

function capabilities(overrides: Partial<PreflightCapabilities> = {}) {
  const calls: Record<string, number> = Object.create(null) as Record<string, number>;
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const paths = {
    inspectWorktreeFilesystem: async () => { count('worktree'); return { path: '/state', canonical: true, writable: true, symlink: false, device: 7, inode: 1, mountId: 10 }; },
    inspectApprovedRoot: async () => { count('root'); return { path: '/output/images', canonical: true, writable: true, symlink: false, device: 7, inode: 2, mountId: 20 }; },
    inspectStaging: async () => { count('staging'); return { path: '/output/images/.osi-image-builder/staging', canonical: true, writable: true, symlink: false, device: 999, inode: 3, mountId: 20 }; },
    inspectReleasePath: async () => { count('release'); return { finalExists: false, finalSymlink: false, parentWritable: true }; },
  };
  const result: PreflightCapabilities & { readonly calls: Record<string, number> } = {
    calls, clock: { now: () => new Date(fixedNow) },
    sourceResolver: sourceCapability(async () => { count('sourceResolver'); return validSource(); }),
    manifest: { inspect: (loaded, targetId) => { count('manifest'); return { sha256: loaded.sha256, target: loaded.manifest.targets.find((candidate) => candidate.id === targetId) }; } },
    repository: { inspect: async () => { count('repository'); return { isGitWorktree: true }; } },
    fileSystem: { statfs: async () => { count('statfs'); return { freeBytes: 25 * 1024 ** 3 }; } }, paths,
    executables: { check: async (name) => { count(`executable:${name}`); return { path: TRUSTED_PREFLIGHT_EXECUTABLES[name], version: `${name} 1.0` }; } },
    docker: { inspectLockedImage: async (imageReference) => { count('docker'); return { available: true, imageReference, imageDigest: digest, imageId: `sha256:${digest}`, clientVersion: '27.0', serverVersion: '27.0', architecture: 'amd64', os: 'linux' }; } },
    systemd: { checkUserManager: async () => { count('systemd'); return { available: true, runnerActive: false }; } },
    lock: { read: async () => { count('lock'); return JSON.stringify(validLock()); } },
    ...overrides,
  };
  return result;
}

function service(caps: PreflightCapabilities, options: { idFactory?: () => string; maxCacheEntries?: number } = {}) {
  return new PreflightService({ loadedConfig, manifest, capabilities: caps, idFactory: options.idFactory ?? (() => 'pf_test_01'), requestId: 'req-test', maxCacheEntries: options.maxCacheEntries });
}

describe('typed preflight checks', () => {
  it('keeps preflight read-only and prepares offline feeds only for the accepted real job ID', async () => {
    const prepared = Object.freeze({
      schemaVersion: 1 as const,
      boundary: 'api-prepared-pinned-feeds-v1' as const,
      networkPolicy: 'runner-offline' as const,
      jobId: 'job-prepared-01',
      sourceSha: sha,
      preparedAt: fixedNow,
      feeds: Object.freeze([]),
    });
    const preparationCalls: unknown[][] = [];
    const caps = capabilities({
      sourceResolver: {
        resolveAtAcceptance: async () => validSource(),
        discardOfflineFeeds: async () => undefined,
        prepareOfflineFeeds: async (...args: unknown[]) => {
          preparationCalls.push(args);
          return prepared;
        },
      },
    } as Partial<PreflightCapabilities>);
    const preflight = service(caps);

    const checked = await preflight.run(request);
    expect(preparationCalls).toEqual([]);

    await expect(preflight.accept(checked.preflightId, request, 'job-prepared-01')).resolves.toMatchObject({
      jobId: 'job-prepared-01',
      offlineFeedPreparation: prepared,
    });
    expect(preparationCalls).toEqual([[sha, loadedConfig.pathAuthorities.stateRoot, 'job-prepared-01']]);
  });

  it('pins source, selects approved target/root, and expires exactly ten minutes later', async () => {
    const caps = capabilities();
    const result = await service(caps).run(request);
    expect(result).toMatchObject({ preflightId: 'pf_test_01', observedSha: sha, createdAt: fixedNow, expiresAt: '2026-07-23T12:10:00.000Z' });
    expect(result.source.sourcePreparation).toEqual(validSource().sourcePreparation);
    expect(result.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(result.checks.find((check) => check.id === 'same-filesystem-staging')?.details).toMatchObject({ outputMountId: 20, stagingMountId: 20 });
    expect(caps.calls.worktree).toBe(1);
  });

  it('derives the worktree filesystem from LoadedConfig state authority, with distinct disk thresholds', async () => {
    const paths: string[] = [];
    const caps = capabilities({ fileSystem: { statfs: async (path) => { paths.push(path); return { freeBytes: path === '/state' ? 19 * 1024 ** 3 : 25 * 1024 ** 3 }; } } });
    await expect(service(caps).run(request)).rejects.toMatchObject({ code: 'PREFLIGHT_DISK_SPACE' });
    expect(paths).toEqual(['/state', '/output/images']);
  });

  it('preserves SourceResolver stable codes and observed SHA details', async () => {
    for (const code of ['INVALID_BRANCH', 'BRANCH_MOVED', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'SOURCE_NOT_COMMIT'] as const) {
      const details = code === 'BRANCH_MOVED' ? { observedSha: '9'.repeat(40) } : { reason: code };
      const caps = capabilities({ sourceResolver: sourceCapability(async () => { throw new SourceResolverError(code, details as unknown as Record<string, string>); }) });
      await expect(service(caps).run(request)).rejects.toMatchObject({ code, details: expect.objectContaining(details) });
    }
  });

  it('uses the shared BuilderError contract and stable validation/systemd codes', async () => {
    let error: PreflightError;
    try { await service(capabilities()).run({ ...request, targetId: 'rpi-9' as never }); throw new Error('expected rejection'); } catch (value) { error = value as PreflightError; }
    expect(error).toBeInstanceOf(PreflightError);
    expect(error.toJSON()).toMatchObject({ code: 'PREFLIGHT_INVALID_TARGET', stage: 'preflight', retryable: false, requestId: 'req-test', diagnosis: 'The requested firmware target is not approved.', recovery: 'Select an approved Raspberry Pi target and run preflight again.', checks: [] });
    await expect(service(capabilities()).run({ ...request, outputRootId: 'unknown' })).rejects.toMatchObject({ code: 'PREFLIGHT_INVALID_OUTPUT_ROOT' });
    await expect(service(capabilities({ systemd: { checkUserManager: async () => ({ available: false, runnerActive: false }) } })).run(request)).rejects.toMatchObject({ code: 'SYSTEMD_USER_UNAVAILABLE' });
  });

  it('validates the exact canonical production lock matrix', async () => {
    const mutations: Array<[string, (lock: Record<string, unknown>) => void]> = [
      ['missing installable', (lock) => { delete lock.installable; }], ['false installable', (lock) => { lock.installable = false; }],
      ['schema non-integer', (lock) => { lock.schemaVersion = 1.5; }], ['zero digest', (lock) => { lock.imageDigest = '0'.repeat(64); }],
      ['bad base binding', (lock) => { lock.baseImage = 'debian:bookworm'; }], ['invalid node', (lock) => { lock.nodeVersion = '20.0.0'; }], ['garbage node', (lock) => { lock.nodeVersion = '22garbage'; }],
      ['invalid rust fixture', (lock) => { lock.rustConfig = { llvmConfig: '/usr/bin/llvm-config', llvmMajor: 18, nested: { artifact: 'rust-ci-llvm' } }; }], ['extra key', (lock) => { lock.extra = true; }],
      ['not nodejs package', (lock) => { lock.packageSet = ['gcc-14', 'not-nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-18-dev', 'libzstd-dev']; }],
      ['fixture evidence uses non-installable lock', (lock) => { lock.imageRepository = 'registry.osi.fixture/builder'; lock.installable = false; }],
      ['invalid optional publisher', (lock) => { lock.publisherSha256 = 'bad'; }], ['invalid optional image ID', (lock) => { lock.imageId = 'bad'; }],
      ['wrong install directory', (lock) => { lock.packageVersion = '2026.07.23.2'; }],
    ];
    for (const [name, mutate] of mutations) {
      const caps = capabilities({ lock: { read: async () => { const lock = validLock(); mutate(lock); return JSON.stringify(lock); } } });
      await expect(service(caps).run(request), name).rejects.toMatchObject({ code: 'BUILDER_LOCK_INVALID' });
    }
    await expect(service(capabilities()).run(request)).resolves.toBeDefined();
    const optional = validLock(); optional.publisherSha256 = '1'.repeat(64); optional.imageId = digest;
    await expect(service(capabilities({ lock: { read: async () => JSON.stringify(optional) }, docker: { inspectLockedImage: async (imageReference) => ({ available: true, imageReference, imageDigest: digest, imageId: `sha256:${digest}`, clientVersion: '27', serverVersion: '27', architecture: 'amd64', os: 'linux' }) } })).run(request)).resolves.toBeDefined();
    const legitimateRepository = validLock(); legitimateRepository.imageRepository = 'registry.osi.invalid/contest/test';
    expect(validateBuilderLock(legitimateRepository, '2026.07.23.1')).toMatchObject({ ok: true });
  });

  it('applies exact Docker repository grammar to builder and base references', async () => {
    const cases: Array<[string, boolean, (lock: Record<string, unknown>) => void]> = [
      ['builder', true, (lock) => { lock.imageRepository = 'builder'; }],
      ['namespace/repo', true, (lock) => { lock.imageRepository = 'contest/test'; }],
      ['registry port with namespace', true, (lock) => { lock.imageRepository = 'registry.osi.invalid:5000/contest/test'; }],
      ['zero port', false, (lock) => { lock.imageRepository = 'registry.osi.invalid:0/contest/test'; }],
      ['port too large', false, (lock) => { lock.imageRepository = 'registry.osi.invalid:65536/contest/test'; }],
      ['single component port tag', false, (lock) => { lock.imageRepository = 'builder:5000'; }],
      ['uppercase', false, (lock) => { lock.imageRepository = 'Registry/Builder'; }],
      ['credentials', false, (lock) => { lock.imageRepository = 'user:pass@registry/builder'; }],
      ['tag', false, (lock) => { lock.imageRepository = 'registry/builder:12'; }],
      ['digest', false, (lock) => { lock.imageRepository = `registry/builder@sha256:${digest}`; }],
      ['base tag with digest', false, (lock) => { lock.baseImage = `debian:12@sha256:${'c'.repeat(64)}`; }],
    ];
    for (const [name, expected, mutate] of cases) {
      const lock = validLock();
      mutate(lock);
      expect(validateBuilderLock(lock, '2026.07.23.1'), name).toMatchObject({ ok: expected });
    }
  });

  it('rejects invalid explicit cache capacities without coercion', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 1001]) {
      expect(() => service(capabilities(), { maxCacheEntries: value })).toThrow(TypeError);
    }
    expect(() => service(capabilities(), { maxCacheEntries: 1 })).not.toThrow();
    expect(() => service(capabilities(), { maxCacheEntries: 1000 })).not.toThrow();
  });

  it('uses actual mount IDs and rejects absent, symlinked, or cross-mount staging', async () => {
    const cases = [
      { label: 'absent', staging: () => { throw new Error('ENOENT'); }, code: 'STAGING_DIRECTORY_INVALID' },
      { label: 'symlink', staging: async () => ({ path: '/staging', canonical: true, writable: true, symlink: true, device: 7, inode: 3, mountId: 20 }), code: 'STAGING_DIRECTORY_INVALID' },
      { label: 'cross mount', staging: async () => ({ path: '/staging', canonical: true, writable: true, symlink: false, device: 7, inode: 3, mountId: 21 }), code: 'STAGING_FILESYSTEM_MISMATCH' },
    ] as const;
    for (const testCase of cases) {
      const caps = capabilities({ paths: { inspectWorktreeFilesystem: async () => ({ path: '/state', canonical: true, writable: true, symlink: false, device: 7, inode: 1, mountId: 10 }), inspectApprovedRoot: async () => ({ path: '/output/images', canonical: true, writable: true, symlink: false, device: 7, inode: 2, mountId: 20 }), inspectStaging: testCase.staging, inspectReleasePath: async () => ({ finalExists: false, finalSymlink: false, parentWritable: true }) } });
      await expect(service(caps).run(request), testCase.label).rejects.toMatchObject({ code: testCase.code });
    }
  });

  it('rejects every unsafe release ancestor, unwritable parent, and final collision', async () => {
    for (const inspection of [
      { finalExists: false, finalSymlink: false, parentWritable: true, unsafeAncestor: 'symlink' as const },
      { finalExists: false, finalSymlink: false, parentWritable: true, unsafeAncestor: 'not-directory' as const },
      { finalExists: false, finalSymlink: false, parentWritable: false }, { finalExists: true, finalSymlink: false, parentWritable: true },
    ]) {
      const caps = capabilities({ paths: { inspectWorktreeFilesystem: async () => ({ path: '/state', canonical: true, writable: true, symlink: false, device: 7, inode: 1, mountId: 10 }), inspectApprovedRoot: async () => ({ path: '/output/images', canonical: true, writable: true, symlink: false, device: 7, inode: 2, mountId: 20 }), inspectStaging: async () => ({ path: '/staging', canonical: true, writable: true, symlink: false, device: 7, inode: 3, mountId: 20 }), inspectReleasePath: async () => inspection } });
      await expect(service(caps).run(request)).rejects.toMatchObject({ code: 'OUTPUT_COLLISION' });
    }
  });

  it('reruns every read-only check only for a matching unexpired acceptance', async () => {
    let now = new Date(fixedNow);
    const caps = capabilities({ clock: { now: () => new Date(now) } });
    const preflight = service(caps);
    const first = await preflight.run(request);
    const initial = { ...caps.calls };
    now = new Date('2026-07-23T12:09:59.999Z');
    await expect(preflight.accept(first.preflightId, request, 'job-accept-valid')).resolves.toMatchObject({
      createdAt: fixedNow,
      checkedAt: '2026-07-23T12:09:59.999Z',
      expiresAt: '2026-07-23T12:10:00.000Z',
    });
    for (const name of ['sourceResolver', 'repository', 'manifest', 'lock', 'worktree', 'root', 'staging', 'release']) expect(caps.calls[name]).toBeGreaterThan(initial[name] ?? 0);
    const afterValid = { ...caps.calls };
    await expect(preflight.accept(first.preflightId, { ...request, targetId: 'rpi-2' }, 'job-accept-valid')).rejects.toMatchObject({ code: 'PREFLIGHT_REQUEST_MISMATCH' });
    expect(caps.calls).toEqual(afterValid);
    now = new Date('2026-07-23T12:10:00.000Z');
    await expect(preflight.accept(first.preflightId, request, 'job-accept-valid')).rejects.toMatchObject({ code: 'PREFLIGHT_EXPIRED' });
    expect(caps.calls).toEqual(afterValid);
  });

  it('rejects a token that expires while its acceptance recheck is running', async () => {
    const times = ['2026-07-23T12:00:00.000Z', '2026-07-23T12:00:00.000Z', '2026-07-23T12:09:59.999Z', '2026-07-23T12:09:59.999Z', '2026-07-23T12:10:00.000Z'];
    let index = 0;
    const caps = capabilities({ clock: { now: () => new Date(times[Math.min(index++, times.length - 1)]!) } });
    const preflight = service(caps);
    const first = await preflight.run(request);
    await expect(preflight.accept(first.preflightId, request, 'job-accept-expiring')).rejects.toMatchObject({ code: 'PREFLIGHT_EXPIRED' });
    expect(caps.calls.sourceResolver).toBe(2);
  });

  it('rejects a token that expires while offline feeds are being prepared', async () => {
    let now = new Date(fixedNow);
    const discarded: string[] = [];
    const caps = capabilities({
      clock: { now: () => new Date(now) },
      sourceResolver: {
        resolveAtAcceptance: async () => validSource(),
        discardOfflineFeeds: async (_stateRoot, jobId) => { discarded.push(jobId); },
        prepareOfflineFeeds: async (sourceSha, _stateRoot, jobId) => {
          now = new Date('2026-07-23T12:10:00.000Z');
          return {
            schemaVersion: 1,
            boundary: 'api-prepared-pinned-feeds-v1',
            networkPolicy: 'runner-offline',
            jobId,
            sourceSha,
            preparedAt: fixedNow,
            feeds: [],
          };
        },
      },
    });
    const preflight = service(caps);
    const first = await preflight.run(request);

    await expect(preflight.accept(
      first.preflightId,
      request,
      'job-offline-preparation-expired',
    )).rejects.toMatchObject({
      code: 'PREFLIGHT_EXPIRED',
      details: {
        checkedAt: '2026-07-23T12:10:00.000Z',
      },
    });
    expect(discarded).toEqual(['job-offline-preparation-expired']);
  });

  it('bounds IDs and cache, preserves the original on duplicate, and prunes at expiry', async () => {
    let now = new Date(fixedNow);
    const caps = capabilities({ clock: { now: () => new Date(now) } });
    const duplicate = service(caps, { idFactory: () => 'pf_same' });
    const first = await duplicate.run(request);
    await expect(duplicate.run(request)).rejects.toMatchObject({ code: 'PREFLIGHT_CACHE_DUPLICATE' });
    await expect(duplicate.accept(first.preflightId, request, 'job-accept-duplicate')).resolves.toBeDefined();
    await expect(service(capabilities(), { idFactory: () => 'bad id' }).run(request)).rejects.toMatchObject({ code: 'PREFLIGHT_INVALID_ID' });
    let boundedNow = new Date(fixedNow);
    const boundedCaps = capabilities({ clock: { now: () => new Date(boundedNow) } });
    let boundedId = 0;
    const bounded = service(boundedCaps, { maxCacheEntries: 1, idFactory: () => `pf_bounded_${++boundedId}` });
    await bounded.run(request);
    await expect(bounded.run(request)).rejects.toMatchObject({ code: 'PREFLIGHT_CACHE_FULL' });
    boundedNow = new Date('2026-07-23T12:10:00.000Z');
    await expect(bounded.run(request)).resolves.toMatchObject({ preflightId: 'pf_bounded_3' });
    now = new Date('2026-07-23T12:10:00.000Z');
    now = new Date('2026-07-23T12:10:00.000Z');
    await expect(duplicate.run(request)).resolves.toBeDefined();
  });

  it('runs fixed bounded production probes and fails closed on malformed evidence', async () => {
    const calls: Array<{ executable: string; argv: readonly string[]; options: unknown }> = [];
    const exec: PreflightExecCapability = { run: async (executable, argv, options) => {
      calls.push({ executable, argv, options });
      if (argv[0] === 'version') return { stdout: JSON.stringify({ Client: { Version: '27' }, Server: { Version: '27', Arch: 'amd64' } }), stderr: '', exitCode: 0 };
      if (argv[0] === 'image') return { stdout: JSON.stringify({ Id: `sha256:${digest}`, Architecture: 'amd64', Os: 'linux', RepoDigests: [`registry.osi.example/builder@sha256:${digest}`] }), stderr: '', exitCode: 0 };
      if (argv[0] === '--user') return { stdout: argv[1] === 'is-system-running' ? 'running\n' : 'active\n', stderr: '', exitCode: 0 };
      return { stdout: argv[0] === '-C' ? 'true\n' : `${executable} 27\n`, stderr: '', exitCode: 0 };
    } };
    const defaults = createReadOnlyPreflightDefaults({ exec, systemdBusEnvironment: async () => ({ XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }) });
    await defaults.repository.inspect('/work/osi-os');
    await defaults.systemd.checkUserManager();
    await defaults.docker.inspectLockedImage(`registry.osi.invalid/builder@sha256:${digest}`);
    for (const name of Object.keys(TRUSTED_PREFLIGHT_EXECUTABLES) as Array<keyof typeof TRUSTED_PREFLIGHT_EXECUTABLES>) await defaults.executables.check(name, TRUSTED_PREFLIGHT_EXECUTABLES[name]);
    expect(calls.map(({ executable, argv }) => [executable, argv])).toContainEqual(['/usr/bin/git', ['-C', '/work/osi-os', 'rev-parse', '--is-inside-work-tree']]);
    expect(calls.map(({ executable, argv }) => [executable, argv])).toContainEqual(['/usr/bin/docker', ['version', '--format', '{{json .}}']]);
    expect(calls.every((call) => expect.objectContaining({ timeoutMs: 5_000, maxBuffer: 8 * 1024, shell: false }).asymmetricMatch(call.options))).toBe(true);
    const failed: PreflightExecCapability = { run: async () => ({ stdout: '', stderr: 'failed', exitCode: 1 }) };
    await expect(createReadOnlyPreflightDefaults({ exec: failed }).executables.check('git', TRUSTED_PREFLIGHT_EXECUTABLES.git)).rejects.toThrow();
    const malformed: PreflightExecCapability = { run: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }) };
    await expect(createReadOnlyPreflightDefaults({ exec: malformed }).docker.inspectLockedImage('image@sha256:x')).resolves.toMatchObject({ available: false, imageDigest: null, imageId: null });
  });

  it('derives only a validated service-user systemd bus environment', async () => {
    const uid = 1000;
    const runtimeDir = `/run/user/${uid}`;
    const fs = {
      lstat: async (path: string) => path === runtimeDir
        ? { isSymbolicLink: () => false, isDirectory: () => true, isSocket: () => false, uid, mode: 0o40700 }
        : { isSymbolicLink: () => false, isDirectory: () => false, isSocket: () => true, uid, mode: 0o14666 },
      realpath: async (path: string) => path,
    };
    await expect(deriveSystemdBusEnvironment({ uid, fs })).resolves.toEqual({ XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` });
    await expect(deriveSystemdBusEnvironment({ uid, fs: { ...fs, lstat: async (path: string) => path === runtimeDir ? { isSymbolicLink: () => true, isDirectory: () => true, isSocket: () => false, uid, mode: 0o40700 } : await fs.lstat(path) } })).rejects.toThrow();
  });

  it('classifies unavailable Docker evidence separately from a valid digest mismatch', async () => {
    const unavailable = capabilities({ docker: { inspectLockedImage: async (imageReference) => ({ available: false, imageReference, imageDigest: null, imageId: null, clientVersion: null, serverVersion: null, architecture: null, os: null }) } });
    await expect(service(unavailable).run(request)).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    const mismatch = capabilities({ docker: { inspectLockedImage: async (imageReference) => ({ available: true, imageReference, imageDigest: '1'.repeat(64), imageId: `sha256:${digest}`, clientVersion: '27', serverVersion: '27', architecture: 'amd64', os: 'linux' }) } });
    await expect(service(mismatch).run(request)).rejects.toMatchObject({ code: 'BUILDER_DIGEST_MISMATCH' });
  });

  it('requires locked image architecture and rejects daemon/image disagreement without mutation', async () => {
    for (const image of [{ Architecture: 'arm64', Os: 'linux' }, { Os: 'linux' }] as const) {
      const calls: Array<{ executable: string; argv: readonly string[] }> = [];
      const exec: PreflightExecCapability = { run: async (executable, argv) => {
        calls.push({ executable, argv });
        if (argv[0] === 'version') return { stdout: JSON.stringify({ Client: { Version: '27' }, Server: { Version: '27', Arch: 'amd64' } }), stderr: '', exitCode: 0 };
        return { stdout: JSON.stringify({ Id: `sha256:${digest}`, RepoDigests: [`registry.osi.invalid/builder@sha256:${digest}`], ...image }), stderr: '', exitCode: 0 };
      } };
      const defaults = createReadOnlyPreflightDefaults({ exec });
      await expect(service(capabilities({ docker: defaults.docker })).run(request), image.Architecture ?? 'missing image architecture').rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
      expect(calls.map(({ executable, argv }) => [executable, argv])).toEqual([
        ['/usr/bin/docker', ['version', '--format', '{{json .}}']],
        ['/usr/bin/docker', ['image', 'inspect', '--format', '{{json .}}', `registry.osi.invalid/builder@sha256:${digest}`]],
      ]);
      expect(calls.flatMap(({ argv }) => argv).some((argument) => new Set(['build', 'run', 'rm', 'create', 'push']).has(argument))).toBe(false);
    }
  });

  it('reserves cache capacity and IDs before concurrent evaluation begins', async () => {
    let started!: () => void;
    let release!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    const sourceRelease = new Promise<void>((resolve) => { release = resolve; });
    let id = 0;
    const caps = capabilities({ sourceResolver: sourceCapability(async () => { started(); await sourceRelease; return validSource(); }) });
    const concurrent = service(caps, { maxCacheEntries: 1, idFactory: () => `pf_concurrent_${++id}` });
    const first = concurrent.run(request);
    await sourceStarted;
    await expect(concurrent.run(request)).rejects.toMatchObject({ code: 'PREFLIGHT_CACHE_FULL', retryable: true });
    release();
    await expect(first).resolves.toMatchObject({ preflightId: 'pf_concurrent_1' });

    let duplicateRelease!: () => void;
    const duplicateStarted = new Promise<void>((resolve) => { duplicateRelease = resolve; });
    const duplicateCaps = capabilities({ sourceResolver: sourceCapability(async () => { await duplicateStarted; return validSource(); }) });
    let duplicateIdCalls = 0;
    const duplicate = service(duplicateCaps, { idFactory: () => { duplicateIdCalls += 1; return 'pf_duplicate'; } });
    const duplicateFirst = duplicate.run(request);
    await expect(duplicate.run(request)).rejects.toMatchObject({ code: 'PREFLIGHT_CACHE_DUPLICATE' });
    duplicateRelease();
    await expect(duplicateFirst).resolves.toMatchObject({ preflightId: 'pf_duplicate' });
    expect(duplicateIdCalls).toBe(2);
  });

  it('serializes retryability from the approved preflight taxonomy', async () => {
    const moved = capabilities({ sourceResolver: sourceCapability(async () => { throw new SourceResolverError('BRANCH_MOVED', { observedSha: '9'.repeat(40) }); }) });
    await expect(service(moved).run(request)).rejects.toMatchObject({ code: 'BRANCH_MOVED', retryable: true, diagnosis: 'The branch no longer points at the expected SHA.' });
  });

  it('fails closed for null, missing, and malformed Docker identity evidence', async () => {
    const cases = [
      { version: { Client: null, Server: null }, image: { Id: `sha256:${digest}`, RepoDigests: [`registry.osi.invalid/builder@sha256:${digest}`] } },
      { version: { Client: {}, Server: { Version: '27' } }, image: { Id: `sha256:${digest}`, RepoDigests: [`registry.osi.invalid/builder@sha256:${digest}`] } },
      { version: { Client: { Version: '27' }, Server: { Version: '27' } }, image: { RepoDigests: [`registry.osi.invalid/builder@sha256:${digest}`] } },
      { version: { Client: { Version: '27' }, Server: { Version: '27' } }, image: { Id: 'not-an-id', RepoDigests: [`registry.osi.invalid/builder@sha256:${digest}`] } },
      { version: { Client: { Version: '27' }, Server: { Version: '27' } }, image: { Id: `sha256:${digest}`, RepoDigests: ['registry.osi.invalid/builder@sha256:bad'] } },
    ];
    for (const evidence of cases) {
      let imageCall = false;
      const exec: PreflightExecCapability = { run: async (_executable, argv) => {
        if (argv[0] === 'version') return { stdout: JSON.stringify(evidence.version), stderr: '', exitCode: 0 };
        if (argv[0] === 'image') { imageCall = true; return { stdout: JSON.stringify(evidence.image), stderr: '', exitCode: 0 }; }
        return { stdout: 'running\n', stderr: '', exitCode: 0 };
      } };
      const result = await createReadOnlyPreflightDefaults({ exec }).docker.inspectLockedImage(`registry.osi.invalid/builder@sha256:${digest}`);
      expect(imageCall).toBe(true);
      expect(result.available).toBe(false);
    }
  });

  it('probes active and activating runner units with compatible systemd status semantics', async () => {
    const calls: Array<readonly string[]> = [];
    const environments: Array<Readonly<Record<string, string>>> = [];
    const exec: PreflightExecCapability = { run: async (_executable, argv, options) => {
      calls.push(argv);
      environments.push(options.env);
      if (argv[1] === 'is-system-running') return { stdout: 'degraded\n', stderr: '', exitCode: 1 };
      return { stdout: 'osi-image-builder-runner@job.service\tactivating\n', stderr: '', exitCode: 0 };
    } };
    await expect(createReadOnlyPreflightDefaults({ exec, systemdBusEnvironment: async () => ({ XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }) }).systemd.checkUserManager()).resolves.toEqual({ available: true, runnerActive: true });
    expect(calls).toEqual([
      ['--user', 'is-system-running'],
      ['--user', 'list-units', '--type=service', '--state=active,activating', '--no-legend', 'osi-image-builder-runner@*.service'],
    ]);
    expect(environments[0]).toMatchObject({ PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
    expect(environments[1]).toEqual(environments[0]);
  });

  it('requires the shared production lock semantic floor', async () => {
    for (const mutate of [
      (lock: Record<string, unknown>) => { lock.packageSet = {}; },
      (lock: Record<string, unknown>) => { lock.packageSet = ['gcc-14']; },
      (lock: Record<string, unknown>) => { lock.rustConfig = { channel: 'stable' }; },
      (lock: Record<string, unknown>) => { lock.rustConfig = { llvmConfig: '/usr/bin/llvm-config', artifact: 'rust-ci-llvm' }; },
    ]) {
      const caps = capabilities({ lock: { read: async () => { const lock = validLock(); mutate(lock); return JSON.stringify(lock); } } });
      await expect(service(caps).run(request)).rejects.toMatchObject({ code: 'BUILDER_LOCK_INVALID' });
    }
  });

  it('releases a failed reservation so the next request can use capacity immediately', async () => {
    let sourceCalls = 0;
    let ids = 0;
    const caps = capabilities({ sourceResolver: sourceCapability(async () => {
      sourceCalls += 1;
      if (sourceCalls === 1) throw new Error('temporary source failure');
      return validSource();
    }) });
    const oneSlot = service(caps, { maxCacheEntries: 1, idFactory: () => `pf_failure_${++ids}` });
    await expect(oneSlot.run(request)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(oneSlot.run(request)).resolves.toMatchObject({ preflightId: 'pf_failure_2' });
  });
});
