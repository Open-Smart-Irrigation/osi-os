import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { MIN_DISK_FREE_BYTES, validateConfigDocument } from '../../config/config-document.mjs';
import { loadConfig } from '../../config/load.js';
// @ts-expect-error The acceptance CLI is a JavaScript entrypoint without a separate declaration file.
import { checkAuthorityFreeDisk, checkHeldPublisher, evaluateAcceptanceGuards, holdAcceptanceConfig, holdConfiguredAuthorityPaths, inspectConfiguredApprovedRoot, readAcceptanceConfig, readExactHeld, REAL_ACCEPTANCE_NOT_IMPLEMENTED } from '../../scripts/accept-real-target.mjs';
// @ts-expect-error The workstation CLI is a JavaScript entrypoint without a separate declaration file.
import { PREREQUISITE_NAMES } from '../../scripts/run-workstation-test.mjs';

type PrerequisiteResult = Readonly<{
  readonly available: boolean;
  readonly code: string;
  readonly detail: string;
  readonly mutation: 'none' | 'unknown';
}>;
type AcceptanceEnvironment = Record<string, string | undefined>;
type AcceptanceDependencies = Readonly<{
  readonly workstation: Readonly<{ readonly available: boolean; readonly mutation: 'none' | 'unknown'; readonly prerequisites: Record<string, PrerequisiteResult> }>;
  readonly readInstalledInstallation: () => Promise<Readonly<Record<string, unknown>>>;
  readonly inspectImage: (lock: Record<string, unknown>) => Promise<Readonly<Record<string, unknown>>>;
  readonly checkPublisher: (installation: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>>;
  readonly checkApprovedRoot: (rootId: string) => Promise<Readonly<Record<string, unknown>>>;
  readonly checkFreeDisk: (root: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>>;
}>;

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const SHA = 'a'.repeat(40);
const IMAGE_DIGEST = 'b'.repeat(64);
const LOCK = Object.freeze({
  schemaVersion: 1,
  packageVersion: '2026.07.29.1',
  imageRepository: 'osi/firmware-builder',
  imageDigest: IMAGE_DIGEST,
  baseImage: `docker.io/library/debian@sha256:${'c'.repeat(64)}`,
  baseImageDigest: 'c'.repeat(64),
  dockerfileSha256: 'd'.repeat(64),
  packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'],
  rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 },
  nodeVersion: '22.14.0',
  executionDefinitionSha256: 'e'.repeat(64),
  validationEvidenceSha256: 'f'.repeat(64),
  installable: true,
  publisherSha256: '1'.repeat(64),
});
const LOCK_TEXT = `${JSON.stringify(LOCK)}\n`;
const LOCK_SHA = createHash('sha256').update(LOCK_TEXT).digest('hex');
const MANIFEST_SHA = createHash('sha256').update('{}\n').digest('hex');

function availablePrerequisites(): Record<string, PrerequisiteResult> {
  return Object.fromEntries(PREREQUISITE_NAMES.map((name: string) => [name, {
    available: true,
    code: `${name.toUpperCase()}_AVAILABLE`,
    detail: `${name} is available`,
    mutation: 'none',
  }]));
}

async function fixture(): Promise<{
  readonly root: string;
  readonly env: AcceptanceEnvironment;
  readonly dependencies: AcceptanceDependencies;
  readonly installation: Readonly<Record<string, unknown>>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-'));
  temporaryDirectories.push(root);
  const install = join(root, 'attacker-install');
  const approved = join(root, 'images');
  const repository = join(root, 'repository');
  const versionRoot = join(install, LOCK.packageVersion);
  await mkdir(join(versionRoot, 'bin'), { recursive: true });
  await mkdir(join(versionRoot, 'manifest'), { recursive: true });
  await mkdir(approved, { recursive: true });
  await mkdir(repository, { recursive: true });
  await writeFile(join(versionRoot, 'builder.lock.json'), LOCK_TEXT);
  await writeFile(join(versionRoot, 'manifest', 'targets.json'), '{}\n');
  await writeFile(join(versionRoot, 'bin', 'osi-image-publish'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(root, 'sentinel'), 'unchanged\n');
  const env: AcceptanceEnvironment = {
    OSI_IMAGE_BUILDER_REAL: '1',
    OSI_IMAGE_BUILDER_APPROVED_ROOT_ID: 'sdcard-images',
    OSI_IMAGE_BUILDER_PINNED_SHA: SHA,
    OSI_IMAGE_BUILDER_TARGET: 'rpi-5',
    OSI_IMAGE_BUILDER_INSTALL_ROOT: install,
    OSI_IMAGE_BUILDER_APPROVED_ROOT_PATH: '/tmp/attacker-root',
  };
  const installation = {
    versionRoot,
    lockPath: join(versionRoot, 'builder.lock.json'),
    lockText: LOCK_TEXT,
    lock: LOCK,
    selection: {
      packageVersion: LOCK.packageVersion,
      manifestSha256: MANIFEST_SHA,
      lockSha256: LOCK_SHA,
      publisherSha256: LOCK.publisherSha256,
      executionDefinitionSha256: LOCK.executionDefinitionSha256,
    },
  };
  const dependencies: AcceptanceDependencies = {
    workstation: { available: true, mutation: 'none', prerequisites: availablePrerequisites() },
    readInstalledInstallation: async () => installation,
    inspectImage: async () => ({
      available: true,
      repository: LOCK.imageRepository,
      digest: LOCK.imageDigest,
      repoDigests: [`${LOCK.imageRepository}@sha256:${LOCK.imageDigest}`],
      mutation: 'none',
    }),
    checkPublisher: async () => ({ available: true, passed: true, sha256: LOCK.publisherSha256, mutation: 'none' }),
    checkApprovedRoot: async () => ({
      available: true,
      path: approved,
      repositoryPath: repository,
      builderLockPath: join(versionRoot, 'builder.lock.json'),
      mutation: 'none',
    }),
    checkFreeDisk: async () => ({ available: true, mutation: 'none' }),
  };
  return { root, env, dependencies, installation };
}

async function snapshot(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stats = await open(path, entry.isDirectory() ? constants.O_RDONLY | constants.O_DIRECTORY : constants.O_RDONLY)
      .then(async (handle) => {
        try { return await handle.stat({ bigint: true }); } finally { await handle.close(); }
      });
    const metadata = [stats.dev, stats.ino, stats.mode, stats.uid, stats.gid, stats.nlink, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
    entries.push(`${entry.name}:${metadata}${entry.isFile() ? `:${createHash('sha256').update(await readFile(path)).digest('hex')}` : ''}`);
    if (entry.isDirectory()) entries.push(...(await snapshot(path)).map((item) => `${entry.name}/${item}`));
  }
  return entries.sort();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('real-target acceptance guards', () => {
  it('returns only the explicit not-implemented result after every guard passes', async () => {
    const fixtureValue = await fixture();
    const before = await snapshot(fixtureValue.root);
    const result = await evaluateAcceptanceGuards({ target: 'pi5', env: fixtureValue.env, dependencies: fixtureValue.dependencies });
    expect(result).toMatchObject({ ok: true, code: REAL_ACCEPTANCE_NOT_IMPLEMENTED, mutation: 'none', targetId: 'rpi-5' });
    expect(await snapshot(fixtureValue.root)).toEqual(before);
  });

  it.each([
    ['real approval', 'OSI_IMAGE_BUILDER_REAL'],
    ['approved root ID', 'OSI_IMAGE_BUILDER_APPROVED_ROOT_ID'],
    ['full pinned SHA', 'OSI_IMAGE_BUILDER_PINNED_SHA'],
    ['exact target', 'OSI_IMAGE_BUILDER_TARGET'],
  ])('rejects missing %s before mutation', async (_label, key) => {
    const fixtureValue = await fixture();
    const env = { ...fixtureValue.env } as Record<string, string | undefined>;
    delete env[key];
    const result = await evaluateAcceptanceGuards({ target: 'pi5', env, dependencies: fixtureValue.dependencies });
    expect(result.ok).toBe(false);
    expect(result.mutation).toBe('none');
  });

  it('rejects a fake env-only installation path and ignores it as authority', async () => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: { ...fixtureValue.env, OSI_IMAGE_BUILDER_INSTALL_ROOT: '/tmp/attacker-install' },
      dependencies: { ...fixtureValue.dependencies, readInstalledInstallation: async () => { throw new Error('real selected installation is unavailable'); } },
    });
    expect(result).toMatchObject({ ok: false, code: 'INSTALLED_INSTALLATION_UNAVAILABLE', mutation: 'unknown' });
  });

  it('validates accept:all as two target guards without requiring all as a firmware target', async () => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'all',
      env: { ...fixtureValue.env, OSI_IMAGE_BUILDER_TARGET: undefined },
      dependencies: fixtureValue.dependencies,
    });
    expect(result).toMatchObject({ ok: true, code: REAL_ACCEPTANCE_NOT_IMPLEMENTED, targetIds: ['rpi-5', 'rpi-2'] });
  });

  it('rejects accept:all when a single-target environment override is present', async () => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'all',
      env: fixtureValue.env,
      dependencies: fixtureValue.dependencies,
    });
    expect(result).toMatchObject({ ok: false, code: 'TARGET_MISMATCH', mutation: 'none' });
  });

  it.each([
    ['workstation', { workstation: { available: false, mutation: 'unknown', prerequisites: {} } }, 'PREREQUISITE_UNAVAILABLE'],
    ['approved root', { checkApprovedRoot: async () => ({ available: false, code: 'APPROVED_ROOT_UNAVAILABLE', mutation: 'unknown' }) }, 'APPROVED_ROOT_UNAVAILABLE'],
    ['free disk', { checkFreeDisk: async () => ({ available: false, code: 'FREE_DISK_UNAVAILABLE', mutation: 'unknown' }) }, 'FREE_DISK_UNAVAILABLE'],
    ['image inspection', { inspectImage: async () => ({ available: false, code: 'DOCKER_DAEMON_UNAVAILABLE', mutation: 'unknown' }) }, 'DOCKER_DAEMON_UNAVAILABLE'],
    ['publisher', { checkPublisher: async () => ({ available: false, code: 'PUBLISHER_SELF_TEST_FAILED', mutation: 'unknown' }) }, 'PUBLISHER_SELF_TEST_FAILED'],
  ])('preserves unknown mutation evidence from %s failures', async (_label, override, code) => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: fixtureValue.env,
      dependencies: { ...fixtureValue.dependencies, ...override },
    });
    expect(result).toMatchObject({ ok: false, code, mutation: 'unknown' });
  });

  it('rejects exact Docker identity evidence when its mutation state is unknown', async () => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: fixtureValue.env,
      dependencies: {
        ...fixtureValue.dependencies,
        inspectImage: async () => ({
          available: true,
          repository: LOCK.imageRepository,
          digest: LOCK.imageDigest,
          repoDigests: [`${LOCK.imageRepository}@sha256:${LOCK.imageDigest}`],
          mutation: 'unknown',
        }),
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'IMAGE_DIGEST_MISMATCH', mutation: 'unknown' });
  });

  it.each([
    ['approved root', { checkApprovedRoot: async () => { throw new Error('root adapter failed'); } }, 'APPROVED_ROOT_UNAVAILABLE'],
    ['free disk', { checkFreeDisk: async () => { throw new Error('disk adapter failed'); } }, 'FREE_DISK_UNAVAILABLE'],
    ['workstation', { workstation: undefined, probeWorkstation: async () => { throw new Error('workstation adapter failed'); } }, 'PREREQUISITE_UNAVAILABLE'],
    ['image inspection', { inspectImage: async () => { throw new Error('image adapter failed'); } }, 'IMAGE_DIGEST_MISMATCH'],
    ['publisher', { checkPublisher: async () => { throw new Error('publisher adapter failed'); } }, 'PUBLISHER_SELF_TEST_FAILED'],
  ])('reports unknown mutation when the %s adapter throws', async (_label, override, code) => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: fixtureValue.env,
      dependencies: { ...fixtureValue.dependencies, ...override },
    });
    expect(result).toMatchObject({ ok: false, code, mutation: 'unknown' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['incomplete', { available: true, mutation: 'none' }],
  ])('rejects %s workstation adapter evidence immediately with unknown mutation', async (_label, evidence) => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: fixtureValue.env,
      dependencies: {
        ...fixtureValue.dependencies,
        workstation: undefined,
        probeWorkstation: async () => evidence,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PREREQUISITE_UNAVAILABLE',
      mutation: 'unknown',
    });
    expect(result.code).not.toBe('APPROVED_ROOT_CHANGED');
  });

  it('rejects workstation evidence whose aggregate availability and mutation contradict a prerequisite', async () => {
    const fixtureValue = await fixture();
    const prerequisites = availablePrerequisites();
    prerequisites[PREREQUISITE_NAMES[0]] = {
      available: false,
      code: 'CRAFTED_FAILURE',
      detail: 'crafted prerequisite failed with unknown mutation',
      mutation: 'unknown',
    };
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: fixtureValue.env,
      dependencies: {
        ...fixtureValue.dependencies,
        workstation: {
          available: true,
          mutation: 'none',
          prerequisites,
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PREREQUISITE_UNAVAILABLE',
      mutation: 'unknown',
    });
  });

  it('rejects configured authority that does not match the selected lock', async () => {
    const fixtureValue = await fixture();
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: fixtureValue.env,
      dependencies: {
        ...fixtureValue.dependencies,
        checkApprovedRoot: async () => ({
          available: true,
          path: join(fixtureValue.root, 'images'),
          repositoryPath: join(fixtureValue.root, 'repository'),
          builderLockPath: join(fixtureValue.root, 'different', 'builder.lock.json'),
          mutation: 'none',
        }),
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONFIG_INSTALLATION_MISMATCH', mutation: 'none' });
  });

  it('uses the configured repository instead of an environment worktree override', async () => {
    const fixtureValue = await fixture();
    let observedCwd: string | undefined;
    const repositoryPath = join(fixtureValue.root, 'repository');
    const dependencies = {
      ...fixtureValue.dependencies,
      workstation: undefined,
      probeWorkstation: async (input: { readonly cwd: string }) => {
        observedCwd = input.cwd;
        return { available: true, mutation: 'none', prerequisites: availablePrerequisites() };
      },
    };
    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: { ...fixtureValue.env, OSI_IMAGE_BUILDER_WORKTREE: '/tmp/attacker-worktree' },
      dependencies,
    });
    expect(result.ok).toBe(true);
    expect(observedCwd).toBe(repositoryPath);
  });

  it('derives every production authority from trusted passwd home when HOME is poisoned', async () => {
    const fixtureValue = await fixture();
    const trustedHome = join(fixtureValue.root, 'trusted-home');
    const observed: { installRoot?: string; configPath?: string } = {};
    let homeAuthorityHeld = false;
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/attacker-controlled-home';
    try {
      const dependencies = {
        ...fixtureValue.dependencies,
        readInstalledInstallation: undefined,
        resolveTrustedHome: async () => trustedHome,
        withTrustedHomeAuthority: async (
          callback: (authority: Readonly<{ path: string }>) => Promise<unknown>,
        ) => {
          homeAuthorityHeld = true;
          try {
            return await callback({ path: trustedHome });
          } finally {
            homeAuthorityHeld = false;
          }
        },
        readConfiguredAuthorityPaths: async () => ({
          paths: {
            configRoot: join(trustedHome, '.config', 'osi-image-builder'),
            configPath: join(trustedHome, '.config', 'osi-image-builder', 'config.json'),
            stateRoot: join(trustedHome, '.local', 'state', 'osi-image-builder'),
            installRoot: join(trustedHome, '.local', 'lib', 'osi-image-builder'),
          },
          revalidate: async () => undefined,
          close: async () => undefined,
        }),
        holdSelectedInstallation: async (
          options: { readonly installRoot: string },
          callback: (installation: Readonly<Record<string, unknown>>, held: Readonly<Record<string, unknown>>) => Promise<unknown>,
        ) => {
          expect(homeAuthorityHeld).toBe(true);
          observed.installRoot = options.installRoot;
          return callback(fixtureValue.installation, {});
        },
        checkApprovedRoot: async (
          _rootId: string,
          _installation: Readonly<Record<string, unknown>>,
          _configPath: string,
          authorityPaths: { readonly configPath: string },
        ) => {
          observed.configPath = authorityPaths.configPath;
          return fixtureValue.dependencies.checkApprovedRoot('sdcard-images');
        },
      };
      const result = await evaluateAcceptanceGuards({ target: 'pi5', env: fixtureValue.env, dependencies });
      expect(result.ok).toBe(true);
      expect(homeAuthorityHeld).toBe(false);
      expect(observed).toEqual({
        installRoot: join(trustedHome, '.local', 'lib', 'osi-image-builder'),
        configPath: join(trustedHome, '.config', 'osi-image-builder', 'config.json'),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('uses installer-owned custom XDG config and state authorities', async () => {
    const fixtureValue = await fixture();
    const trustedHome = join(fixtureValue.root, 'trusted-home');
    const configRoot = join(fixtureValue.root, 'custom-config', 'osi-image-builder');
    const stateRoot = join(fixtureValue.root, 'custom-state', 'osi-image-builder');
    let observedAuthorities: Readonly<Record<string, unknown>> | undefined;
    const dependencies = {
      ...fixtureValue.dependencies,
      readInstalledInstallation: undefined,
      resolveTrustedHome: async () => trustedHome,
      readConfiguredAuthorityPaths: async () => ({
        paths: {
          configRoot,
          configPath: join(configRoot, 'config.json'),
          stateRoot,
          installRoot: join(trustedHome, '.local', 'lib', 'osi-image-builder'),
        },
        revalidate: async () => undefined,
        close: async () => undefined,
      }),
      holdSelectedInstallation: async (
        _options: Readonly<Record<string, unknown>>,
        callback: (installation: Readonly<Record<string, unknown>>, held: Readonly<Record<string, unknown>>) => Promise<unknown>,
      ) => callback(fixtureValue.installation, {}),
      checkApprovedRoot: async (
        _rootId: string,
        _installation: Readonly<Record<string, unknown>>,
        _configPath: string,
        authorityPaths: Readonly<Record<string, unknown>>,
      ) => {
        observedAuthorities = authorityPaths;
        return fixtureValue.dependencies.checkApprovedRoot('sdcard-images');
      },
    };
    const result = await evaluateAcceptanceGuards({ target: 'pi5', env: fixtureValue.env, dependencies });
    expect(result.ok).toBe(true);
    expect(observedAuthorities).toMatchObject({
      configRoot,
      configPath: join(configRoot, 'config.json'),
      stateRoot,
    });
  });

  it('holds and revalidates installer-owned custom XDG authority evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-xdg-authority-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const installRoot = join(root, 'install');
    const configRoot = join(root, 'custom-config', 'osi-image-builder');
    const stateRoot = join(root, 'custom-state', 'osi-image-builder');
    await mkdir(installRoot, { mode: 0o700 });
    const path = join(installRoot, 'configured-authorities.json');
    const contents = `${JSON.stringify({ schemaVersion: 1, configRoot, stateRoot })}\n`;
    await writeFile(path, contents, { mode: 0o600 });
    const installHandle = await open(installRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const held = await holdConfiguredAuthorityPaths({ executionPath: `/proc/${process.pid}/fd/${installHandle.fd}` }, installRoot);
    expect(held.paths).toEqual({
      configRoot,
      configPath: join(configRoot, 'config.json'),
      stateRoot,
      installRoot,
    });
    await rename(path, `${path}.old`);
    await writeFile(path, contents, { mode: 0o600 });
    await expect(held.revalidate()).rejects.toThrow(/changed/iu);
    await held.close();
    await installHandle.close();

    await writeFile(path, `${contents.trimEnd()}trailing-data`, { mode: 0o600 });
    const trailingInstallHandle = await open(installRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await expect(holdConfiguredAuthorityPaths({ executionPath: `/proc/${process.pid}/fd/${trailingInstallHandle.fd}` }, installRoot)).rejects.toThrow(/JSON|authority|configuration/iu);
    await trailingInstallHandle.close();
  });

  it.each([
    ['malformed selection', { readInstalledInstallation: async () => { throw new Error('selection malformed'); } }, 'INSTALLED_INSTALLATION_UNAVAILABLE', 'unknown'],
    ['selection hash mismatch', { readInstalledInstallation: async () => { throw new Error('selection hash mismatch'); } }, 'INSTALLED_INSTALLATION_UNAVAILABLE', 'unknown'],
    ['incomplete lock', { readInstalledInstallation: async () => { throw new Error('required lock field missing'); } }, 'INSTALLED_INSTALLATION_UNAVAILABLE', 'unknown'],
    ['noncanonical selected path', { readInstalledInstallation: async () => ({ versionRoot: '/tmp/../tmp/installation', lockPath: '/tmp/installation/builder.lock.json', lockText: LOCK_TEXT, lock: LOCK, selection: { packageVersion: LOCK.packageVersion, manifestSha256: MANIFEST_SHA, lockSha256: LOCK_SHA, publisherSha256: LOCK.publisherSha256, executionDefinitionSha256: LOCK.executionDefinitionSha256 } }) }, 'INSTALLED_INSTALLATION_INVALID', 'none'],
    ['publisher no-op', { checkPublisher: async () => ({ available: true, passed: false, mutation: 'none' }) }, 'PUBLISHER_SELF_TEST_FAILED', 'none'],
    ['publisher failure', { checkPublisher: async () => ({ available: false, code: 'PUBLISHER_SELF_TEST_FAILED', mutation: 'none' }) }, 'PUBLISHER_SELF_TEST_FAILED', 'none'],
    ['docker client only', { inspectImage: async () => ({ available: false, code: 'DOCKER_DAEMON_UNAVAILABLE', mutation: 'none' }) }, 'DOCKER_DAEMON_UNAVAILABLE', 'none'],
    ['approved root missing', { checkApprovedRoot: async () => ({ available: false, code: 'APPROVED_ROOT_UNAVAILABLE', mutation: 'none' }) }, 'APPROVED_ROOT_UNAVAILABLE', 'none'],
    ['free disk missing', { checkFreeDisk: async () => ({ available: false, code: 'FREE_DISK_UNAVAILABLE', mutation: 'none' }) }, 'FREE_DISK_UNAVAILABLE', 'none'],
  ])('rejects %s with accurate mutation evidence', async (_label, override, code, mutation) => {
    const fixtureValue = await fixture();
    const before = await snapshot(fixtureValue.root);
    const result = await evaluateAcceptanceGuards({ target: 'pi5', env: fixtureValue.env, dependencies: { ...fixtureValue.dependencies, ...override } });
    expect(result).toMatchObject({ ok: false, code, mutation });
    expect(await snapshot(fixtureValue.root)).toEqual(before);
  });

  it('keeps the workstation package test graph exact', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['test:workstation']).toBe('node scripts/require-node22.mjs && vitest run --config vitest.config.ts test/integration/workstation.test.ts test/integration/release-acceptance.test.ts test/integration/final-verification.test.ts');
    expect(packageJson.scripts['test:workstation']).not.toContain('test:integration');
  });

  it('reads only a canonical private config file with one link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-config-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const configPath = join(root, 'config.json');
    const config = {
      repositoryPath: '/srv/osi-os',
      approvedOutputRoots: [{ id: 'release', label: 'Firmware images', path: '/srv/images' }],
      builderLockPath: '/home/test/.local/lib/osi-image-builder/2026.07.29.1/builder.lock.json',
    };
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const held = await holdAcceptanceConfig(configPath);
    try {
      expect(held.config).toEqual({
        ...config,
        maxQueueLength: 50,
        diskFreeMinimumBytes: MIN_DISK_FREE_BYTES,
      });
      await expect(held.revalidate()).resolves.toBeUndefined();
    } finally {
      await held.close();
    }
    expect(await readAcceptanceConfig(configPath)).toEqual({
      ...config,
      maxQueueLength: 50,
      diskFreeMinimumBytes: MIN_DISK_FREE_BYTES,
    });

    const hardlinkPath = join(root, 'hardlink.json');
    await link(configPath, hardlinkPath);
    await expect(readAcceptanceConfig(configPath)).rejects.toThrow(/metadata|link/iu);
    await rm(hardlinkPath);

    const symlinkPath = join(root, 'symlink.json');
    await symlink(configPath, symlinkPath);
    await expect(readAcceptanceConfig(symlinkPath)).rejects.toThrow(/canonical|metadata|symbolic/iu);
  });

  it('fails with unknown mutation when a later adapter replaces the held acceptance config', async () => {
    const fixtureValue = await fixture();
    const configRoot = join(fixtureValue.root, 'config');
    const stateRoot = join(fixtureValue.root, 'state');
    const installRoot = join(fixtureValue.root, 'attacker-install');
    const configPath = join(configRoot, 'config.json');
    const oldConfigPath = `${configPath}.old`;
    const configText = `${JSON.stringify({
      repositoryPath: join(fixtureValue.root, 'repository'),
      approvedOutputRoots: [{
        id: 'sdcard-images',
        label: 'Firmware images',
        path: join(fixtureValue.root, 'images'),
      }],
      builderLockPath: join(installRoot, LOCK.packageVersion, 'builder.lock.json'),
    })}\n`;
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(configPath, configText, { mode: 0o600 });
    let replaced = false;

    const result = await evaluateAcceptanceGuards({
      target: 'pi5',
      env: fixtureValue.env,
      dependencies: {
        ...fixtureValue.dependencies,
        authorityPaths: {
          configRoot,
          configPath,
          stateRoot,
          installRoot,
        },
        checkApprovedRoot: inspectConfiguredApprovedRoot,
        checkFreeDisk: async () => {
          await rename(configPath, oldConfigPath);
          await writeFile(configPath, configText, { mode: 0o600 });
          replaced = true;
          return { available: true, mutation: 'none' };
        },
      },
    });

    expect(replaced).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      code: 'APPROVED_ROOT_CHANGED',
      mutation: 'unknown',
    });
    expect(result.code).not.toBe(REAL_ACCEPTANCE_NOT_IMPLEMENTED);
    await rm(oldConfigPath);
    await rm(configPath);
  });

  it('rejects oversized and noncanonical config payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-config-invalid-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const configPath = join(root, 'config.json');
    await writeFile(configPath, 'x'.repeat(65_537), { mode: 0o600 });
    await expect(readAcceptanceConfig(configPath)).rejects.toThrow(/size|metadata|large/iu);
    await writeFile(configPath, '{\n  "repositoryPath": "/tmp"\n}\n', { mode: 0o600 });
    await expect(readAcceptanceConfig(configPath)).rejects.toThrow(/canonical|configuration/iu);

    const validConfig = {
      repositoryPath: '/srv/osi-os',
      approvedOutputRoots: [{ id: 'release', label: 'Firmware images', path: '/srv/images' }],
      builderLockPath: '/home/test/.local/lib/osi-image-builder/2026.07.29.1/builder.lock.json',
      maxQueueLength: 50,
      diskFreeMinimumBytes: MIN_DISK_FREE_BYTES,
    };
    await writeFile(configPath, `${JSON.stringify(validConfig)}trailing-data`, { mode: 0o600 });
    await expect(readAcceptanceConfig(configPath)).rejects.toThrow(/JSON|configuration/iu);
  });

  it('completes legal short reads and rejects premature EOF', async () => {
    const payload = Buffer.from('complete payload');
    let offset = 0;
    const shortReader = {
      read: async (buffer: Buffer, bufferOffset: number, length: number) => {
        const bytesRead = Math.min(3, length, payload.length - offset);
        payload.copy(buffer, bufferOffset, offset, offset + bytesRead);
        offset += bytesRead;
        return { bytesRead, buffer };
      },
    };
    await expect(readExactHeld(
      shortReader,
      { size: BigInt(payload.length) },
      payload.length,
      'fixture',
    )).resolves.toEqual(payload);

    const prematureReader = {
      read: async (buffer: Buffer) => ({ bytesRead: 0, buffer }),
    };
    await expect(readExactHeld(
      prematureReader,
      { size: BigInt(payload.length) },
      payload.length,
      'fixture',
    )).rejects.toThrow(/size|changed|read/iu);
  });

  it.each([
    ['invalid root ID', { approvedOutputRoots: [{ id: 'Bad.ID', label: 'images', path: '/srv/images' }] }, 'OUTPUT_ROOT_ID_INVALID'],
    ['zero queue', { maxQueueLength: 0 }, 'MAX_QUEUE_INVALID'],
    ['small disk floor', { diskFreeMinimumBytes: MIN_DISK_FREE_BYTES - 1 }, 'DISK_THRESHOLD_INVALID'],
    ['malformed lock path', { builderLockPath: '/srv/not-versioned/builder.lock.json' }, 'BUILDER_LOCK_PATH_INVALID'],
    ['extra root field', { approvedOutputRoots: [{ id: 'release', label: 'images', path: '/srv/images', extra: true }] }, 'OUTPUT_ROOTS_INVALID'],
  ])('shares production config rejection for %s', async (_label, override, code) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-config-parity-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const configPath = join(root, 'config.json');
    const document = {
      repositoryPath: '/srv/osi-os',
      approvedOutputRoots: [{ id: 'release', label: 'images', path: '/srv/images' }],
      builderLockPath: '/srv/installer/2026.07.29.1/builder.lock.json',
      ...override,
    };
    await writeFile(configPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    expect(() => validateConfigDocument(document)).toThrow(expect.objectContaining({ code }));
    await expect(readAcceptanceConfig(configPath)).rejects.toMatchObject({ code });
    await expect(loadConfig({ configPath })).rejects.toMatchObject({ code });
  });

  it('binds the configured repository, output root, and selected installation lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-authority-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const configRoot = join(root, 'config');
    const repositoryPath = join(root, 'repository');
    const outputPath = join(root, 'images');
    const stateRoot = join(root, 'state');
    const versionRoot = join(root, 'installation', LOCK.packageVersion);
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(repositoryPath, { mode: 0o755 });
    await mkdir(outputPath, { mode: 0o755 });
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(dirname(versionRoot), { mode: 0o755 });
    await mkdir(versionRoot, { mode: 0o555 });
    const lockPath = join(versionRoot, 'builder.lock.json');
    const configPath = join(configRoot, 'config.json');
    await writeFile(configPath, `${JSON.stringify({
      repositoryPath,
      approvedOutputRoots: [{ id: 'release', label: 'Firmware images', path: outputPath }],
      builderLockPath: lockPath,
    })}\n`, { mode: 0o600 });
    const result = await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, {
      stateRoot,
      installRoot: dirname(versionRoot),
    });
    try {
      expect(result).toMatchObject({
        available: true,
        path: outputPath,
        repositoryPath,
        builderLockPath: lockPath,
        mutation: 'none',
      });
      await expect(result.revalidate()).resolves.toBeUndefined();
    } finally {
      await result.close();
    }
  });

  it('rejects group-writable, read-only, and protected-path-overlapping authorities before probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-root-policy-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const configRoot = join(root, 'config');
    const repositoryPath = join(root, 'repository');
    const outputPath = join(root, 'images');
    const stateRoot = join(root, 'state');
    const versionRoot = join(root, 'installation', LOCK.packageVersion);
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(repositoryPath, { mode: 0o755 });
    await mkdir(outputPath, { mode: 0o770 });
    await chmod(outputPath, 0o770);
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(dirname(versionRoot), { mode: 0o755 });
    await mkdir(versionRoot, { mode: 0o555 });
    const lockPath = join(versionRoot, 'builder.lock.json');
    const configPath = join(configRoot, 'config.json');
    const writeConfig = async (path: string, repository = repositoryPath) => writeFile(configPath, `${JSON.stringify({
      repositoryPath: repository,
      approvedOutputRoots: [{ id: 'release', label: 'Firmware images', path }],
      builderLockPath: lockPath,
    })}\n`, { mode: 0o600 });
    await writeConfig(outputPath);
    expect(await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, { stateRoot, installRoot: dirname(versionRoot) })).toMatchObject({
      available: false,
      code: 'APPROVED_ROOT_UNAVAILABLE',
    });

    await chmod(outputPath, 0o500);
    expect(await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, { stateRoot, installRoot: dirname(versionRoot) })).toMatchObject({
      available: false,
      code: 'APPROVED_ROOT_UNAVAILABLE',
    });

    await chmod(outputPath, 0o700);
    await chmod(stateRoot, 0o500);
    expect(await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, { stateRoot, installRoot: dirname(versionRoot) })).toMatchObject({
      available: false,
      code: 'APPROVED_ROOT_UNAVAILABLE',
    });
    await chmod(stateRoot, 0o700);

    const unsafeParent = join(root, 'unsafe-parent');
    const unsafeOutput = join(unsafeParent, 'images');
    await mkdir(unsafeParent, { mode: 0o770 });
    await chmod(unsafeParent, 0o770);
    await mkdir(unsafeOutput, { mode: 0o700 });
    await writeConfig(unsafeOutput);
    expect(await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, { stateRoot, installRoot: dirname(versionRoot) })).toMatchObject({
      available: false,
      code: 'APPROVED_ROOT_UNAVAILABLE',
    });

    const overlappingPath = join(repositoryPath, 'images');
    await mkdir(overlappingPath, { mode: 0o755 });
    await writeConfig(overlappingPath);
    expect(await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, { stateRoot, installRoot: dirname(versionRoot) })).toMatchObject({
      available: false,
      code: 'APPROVED_ROOT_OVERLAP',
    });

    await writeConfig(outputPath, configRoot);
    expect(await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, { stateRoot, installRoot: dirname(versionRoot) })).toMatchObject({
      available: false,
      code: 'APPROVED_ROOT_OVERLAP',
    });
  });

  it('rejects physical aliases among held authorities before downstream probes or mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-physical-alias-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const configRoot = join(root, 'config');
    const configPath = join(configRoot, 'config.json');
    await mkdir(configRoot, { mode: 0o700 });
    const installRoot = '/virtual/install';
    const stateRoot = '/virtual/state';
    const repositoryPath = '/virtual/repository';
    const outputPath = '/virtual/output';
    const lockPath = join(installRoot, LOCK.packageVersion, 'builder.lock.json');
    await writeFile(configPath, `${JSON.stringify({
      repositoryPath,
      approvedOutputRoots: [{ id: 'release', label: 'Firmware images', path: outputPath }],
      builderLockPath: lockPath,
    })}\n`, { mode: 0o600 });
    const before = await snapshot(root);
    let descriptor = 100;
    const holdCalls: string[] = [];
    const authority = (path: string) => Object.freeze({
      path,
      exists: true,
      executionPath: `/proc/self/fd/${descriptor++}`,
      identityChain: Object.freeze([Object.freeze({
        path,
        dev: path === repositoryPath || path === outputPath ? 9n : BigInt(descriptor),
        ino: path === repositoryPath || path === outputPath ? 99n : BigInt(descriptor),
        final: true,
      })]),
      unresolvedSuffix: Object.freeze([]),
      revalidate: async () => undefined,
      close: async () => undefined,
    });
    const result = await inspectConfiguredApprovedRoot(
      'release',
      { lockPath },
      configPath,
      {
        configRoot,
        installRoot,
        stateRoot,
        holdDirectoryAuthority: async (path: string) => {
          holdCalls.push(path);
          return authority(path);
        },
      },
    );
    expect(result).toMatchObject({
      available: false,
      code: 'APPROVED_ROOT_OVERLAP',
      mutation: 'none',
    });
    expect(holdCalls).toEqual([installRoot, outputPath, repositoryPath, stateRoot]);
    expect(await snapshot(root)).toEqual(before);
  });

  it.each(['repository', 'output', 'state'] as const)('detects a configured %s directory replacement while its descriptor is held', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), `osi-acceptance-${kind}-swap-`));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const configRoot = join(root, 'config');
    const repositoryPath = join(root, 'repository');
    const outputPath = join(root, 'images');
    const stateRoot = join(root, 'state');
    const versionRoot = join(root, 'installation', LOCK.packageVersion);
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(repositoryPath, { mode: 0o700 });
    await mkdir(outputPath, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(dirname(versionRoot), { mode: 0o755 });
    await mkdir(versionRoot, { mode: 0o555 });
    const lockPath = join(versionRoot, 'builder.lock.json');
    const configPath = join(configRoot, 'config.json');
    await writeFile(configPath, `${JSON.stringify({
      repositoryPath,
      approvedOutputRoots: [{ id: 'release', label: 'Firmware images', path: outputPath }],
      builderLockPath: lockPath,
    })}\n`, { mode: 0o600 });
    const authority = await inspectConfiguredApprovedRoot('release', { versionRoot, lockPath }, configPath, {
      stateRoot,
      installRoot: dirname(versionRoot),
    });
    expect(authority.available).toBe(true);
    const replacedPath = kind === 'repository' ? repositoryPath : kind === 'output' ? outputPath : stateRoot;
    await rename(replacedPath, `${replacedPath}.old`);
    await mkdir(replacedPath, { mode: 0o700 });
    try {
      await expect(authority.revalidate()).rejects.toThrow(/changed|identity/iu);
    } finally {
      await authority.close();
    }
  });

  it.each([
    ['low output disk', 19, 30, 20],
    ['low state disk', 30, 19, 20],
    ['elevated configured threshold', 30, 30, 40],
  ])('rejects %s through both held filesystem authorities', async (_label, outputGiB, stateGiB, minimumGiB) => {
    const outputPath = '/proc/self/fd/100';
    const statePath = '/proc/self/fd/101';
    const result = await checkAuthorityFreeDisk({
      available: true,
      path: '/approved/images',
      releaseExecutionPath: outputPath,
      stateExecutionPath: statePath,
      minimumFreeBytes: minimumGiB * 1024 ** 3,
      revalidate: async () => undefined,
    }, async (path: string) => ({
      bavail: path === outputPath ? outputGiB : stateGiB,
      bsize: 1024 ** 3,
    }));
    expect(result).toMatchObject({ available: false, code: 'FREE_DISK_UNAVAILABLE', mutation: 'none' });
  });

  it('executes only the held publisher when its pathname is replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-acceptance-publisher-'));
    temporaryDirectories.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const publisher = join(bin, 'osi-image-publish');
    const contents = '#!/bin/sh\nprintf \'%s\\n\' \'{"available":true,"published":false,"quarantined":false,"selfTest":true,"mutationCount":0}\'\n';
    await writeFile(publisher, contents, { mode: 0o555 });
    const binHandle = await open(bin, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const publisherHandle = await open(publisher, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await publisherHandle.stat({ bigint: true });
    const attackSentinel = join(root, 'replacement-executed');
    await rename(publisher, join(bin, 'osi-image-publish.old'));
    await writeFile(publisher, `#!/bin/sh\ntouch '${attackSentinel}'\nprintf '%s\\n' '{"available":true,"published":false,"quarantined":false,"selfTest":true,"mutationCount":0}'\n`, { mode: 0o555 });
    const result = await checkHeldPublisher(
      { publisherSha256: createHash('sha256').update(contents).digest('hex') },
      { handle: publisherHandle, before, parent: binHandle, name: 'osi-image-publish' },
    );
    expect(result).toMatchObject({
      available: false,
      code: 'PUBLISHER_SELF_TEST_FAILED',
      mutation: 'unknown',
    });
    await expect(readFile(attackSentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await publisherHandle.close();
    await binHandle.close();
  });

  it.each(['pi5', 'pi4', 'all'] as const)('CLI rejects %s before any acceptance mutation when guards are absent', async (target) => {
    const root = await mkdtemp(join(tmpdir(), `osi-acceptance-cli-${target}-`));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'sentinel'), 'unchanged\n');
    const result: { readonly code?: number; readonly stdout?: string; readonly stderr?: string } = await execFile(process.execPath, ['scripts/accept-real-target.mjs', target], {
      cwd: new URL('../..', import.meta.url),
      env: { ...process.env, OSI_IMAGE_BUILDER_TEST_ROOT: root },
      maxBuffer: 128 * 1024,
    }).catch((error: unknown) => error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toMatch(/REAL_ACCEPTANCE|PREREQUISITE|MISSING|INVALID/u);
    expect(await readFile(join(root, 'sentinel'), 'utf8')).toBe('unchanged\n');
  });
});
