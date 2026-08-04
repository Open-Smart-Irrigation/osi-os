import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The workstation CLI is a JavaScript entrypoint without a separate declaration file.
import { FIXED_ENV, PREREQUISITE_NAMES, WORKSTATION_EXECUTABLES, createTrustedGitEnvironment, probeFreeDisk, probeGit, probeWorkstation, readSelectedInstallation, resolveEffectiveHome, resolveTrustedServiceHome, runSelectedPublisherSelfTest, validateGitConfigKeys, validateGitOrigin, verifyReleasePair, withEffectiveHomeAuthority, withSelectedInstallation } from '../../scripts/run-workstation-test.mjs';

type PrerequisiteResult = Readonly<{
  readonly available: boolean;
  readonly code: string;
  readonly detail: string;
  readonly mutation: 'none' | 'unknown';
}>;

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) {
    const makeWritable = async (path: string): Promise<void> => {
      const snapshot = await lstat(path);
      if (snapshot.isSymbolicLink()) return;
      if (snapshot.isDirectory()) {
        await chmod(path, 0o755);
        for (const entry of await readdir(path)) await makeWritable(join(path, entry));
      } else {
        await chmod(path, 0o644);
      }
    };
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

const available = (name: string): PrerequisiteResult => ({
  available: true,
  code: `${name.toUpperCase()}_AVAILABLE`,
  detail: `${name} is available`,
  mutation: 'none',
});

const unavailable = (name: string): PrerequisiteResult => ({
  available: false,
  code: `${name.toUpperCase()}_UNAVAILABLE`,
  detail: `${name} is unavailable`,
  mutation: 'none',
});

function allAvailable(): Record<string, PrerequisiteResult> {
  return Object.fromEntries(PREREQUISITE_NAMES.map((name: string) => [name, available(name)]));
}

async function listenUnixSocket(path: string): Promise<Server> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  return server;
}

async function closeUnixSocket(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

function successfulGitResponse(args: readonly string[], expectedSha: string) {
  if (args.includes('--name-only')) return { ok: true, stdout: 'core.repositoryformatversion\0remote.origin.url\0remote.origin.fetch\0', stderr: '' };
  if (args.at(-1) === 'remote.origin.url') return { ok: true, stdout: 'git@github.com:Open-Smart-Irrigation/osi-os.git\0', stderr: '' };
  if (args.at(-1) === 'remote.origin.fetch') return { ok: true, stdout: '+refs/heads/*:refs/remotes/origin/*\0', stderr: '' };
  return { ok: true, stdout: `${expectedSha}\trefs/heads/main\n`, stderr: '' };
}

async function writeSelectedInstallation(installRoot: string): Promise<{
  readonly packageVersion: string;
  readonly lock: Readonly<Record<string, unknown>>;
}> {
  const packageVersion = '2026.07.29.1';
  const versionRoot = join(installRoot, packageVersion);
  const manifestDirectory = join(versionRoot, 'manifest');
  const binDirectory = join(versionRoot, 'bin');
  const operationsDirectory = join(versionRoot, 'operations');
  await mkdir(manifestDirectory, { recursive: true });
  await mkdir(binDirectory);
  await mkdir(operationsDirectory);
  const publisher = Buffer.from(`#!/bin/sh
printf '%s\\n' '{"available":true,"published":false,"quarantined":false,"selfTest":true,"mutationCount":0}'
`);
  const publisherSha256 = createHash('sha256').update(publisher).digest('hex');
  const dependencyEgressProxy = await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url));
  const dependencyEgressProxySha256 = createHash('sha256').update(dependencyEgressProxy).digest('hex');
  const executionDefinitionSha256 = '1'.repeat(64);
  const lock = {
    schemaVersion: 1,
    packageVersion,
    imageRepository: 'osi/image-builder',
    imageDigest: '2'.repeat(64),
    baseImage: `ubuntu@sha256:${'3'.repeat(64)}`,
    baseImageDigest: '3'.repeat(64),
    dockerfileSha256: '4'.repeat(64),
    packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev', 'libpolly-18-dev'],
    rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.88.0', llvmMajor: 18 },
    nodeVersion: '22.17.0',
    executionDefinitionSha256,
    validationEvidenceSha256: '5'.repeat(64),
    dependencyEgressProxySha256,
    installable: true,
    publisherSha256,
  };
  const lockText = `${JSON.stringify(lock)}\n`;
  const manifestBytes = await readFile(new URL('../../manifest/targets.json', import.meta.url));
  const selection = {
    executionDefinitionSha256,
    lockSha256: createHash('sha256').update(lockText).digest('hex'),
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    packageVersion,
    publisherSha256,
  };
  await writeFile(join(installRoot, 'selected.json'), `${JSON.stringify(selection)}\n`, { mode: 0o600 });
  await writeFile(join(versionRoot, 'builder.lock.json'), lockText, { mode: 0o600 });
  await writeFile(join(manifestDirectory, 'targets.json'), manifestBytes, { mode: 0o444 });
  await writeFile(join(binDirectory, 'osi-image-publish'), publisher, { mode: 0o555 });
  await writeFile(join(operationsDirectory, 'osi-dependency-egress-proxy.cjs'), dependencyEgressProxy, { mode: 0o444 });
  await chmod(manifestDirectory, 0o555);
  await chmod(binDirectory, 0o555);
  await chmod(operationsDirectory, 0o555);
  await chmod(versionRoot, 0o555);
  await chmod(installRoot, 0o700);
  return { packageVersion, lock };
}

function productionLock(packageVersion: string): Readonly<Record<string, unknown>> {
  const llvmMajor = 18;
  const baseImageDigest = 'b'.repeat(64);
  return {
    schemaVersion: 1,
    packageVersion,
    imageRepository: 'osi/image-builder',
    imageDigest: 'a'.repeat(64),
    baseImage: `ubuntu@sha256:${baseImageDigest}`,
    baseImageDigest,
    dockerfileSha256: 'c'.repeat(64),
    packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev', `libpolly-${llvmMajor}-dev`],
    rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.88.0', llvmMajor },
    nodeVersion: '22.17.0',
    executionDefinitionSha256: 'd'.repeat(64),
    validationEvidenceSha256: 'e'.repeat(64),
    dependencyEgressProxySha256: '1'.repeat(64),
    installable: true,
    publisherSha256: 'f'.repeat(64),
  };
}

async function writeRelease(root: string, targetId: 'rpi-5' | 'rpi-2', imageContents: string): Promise<void> {
  const release = join(root, targetId);
  const packageVersion = '2026.07.29.1';
  const lock = `${JSON.stringify(productionLock(packageVersion))}\n`;
  const lockSha256 = createHash('sha256').update(lock).digest('hex');
  const image = Buffer.from(imageContents);
  const imageSha256 = createHash('sha256').update(image).digest('hex');
  await mkdir(release, { recursive: true });
  await writeFile(join(release, 'builder.lock.json'), lock);
  await writeFile(join(release, 'image.img'), image);
  await writeFile(join(release, 'sha256sums'), `${imageSha256}  image.img\n`);
  await writeFile(join(release, 'verification.json'), JSON.stringify({ verified: true, targetId, imageSha256 }));
  await writeFile(join(release, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    targetId,
    installedLockSha256: lockSha256,
    imageSha256,
  }));
  for (const name of ['builder.lock.json', 'image.img', 'sha256sums', 'verification.json', 'manifest.json']) {
    await chmod(join(release, name), 0o444);
  }
  await chmod(release, 0o555);
}

async function snapshot(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    entries.push(`${entry.name}:${entry.isDirectory() ? 'directory' : (await readFile(path)).toString('hex')}`);
  }
  return entries.sort();
}

describe('deterministic workstation prerequisite adapters', () => {
  it('returns typed unavailable results for each missing prerequisite without mutating state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-workstation-test-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'sentinel'), 'unchanged\n');

    for (const missing of PREREQUISITE_NAMES) {
      const before = await snapshot(root);
      const dependencies = allAvailable();
      dependencies[missing] = unavailable(missing);
      const result = await probeWorkstation({
        mode: 'test',
        dependencies,
      });
      expect(result.available).toBe(false);
      expect(result.mutation).toBe('none');
      expect(result.prerequisites[missing]).toMatchObject({
        available: false,
        code: `${missing.toUpperCase()}_UNAVAILABLE`,
        mutation: 'none',
      });
      expect(await snapshot(root)).toEqual(before);
    }
  });

  it('accepts injected available evidence and preserves the no-mutation contract', async () => {
    const result = await probeWorkstation({
      mode: 'test',
      dependencies: allAvailable(),
    });
    expect(result).toEqual({
      available: true,
      mutation: 'none',
      prerequisites: allAvailable(),
    });
  });

  it('preserves unknown mutation evidence instead of relabeling it as no mutation', async () => {
    const dependencies = allAvailable();
    dependencies.renameat2 = {
      available: false,
      code: 'RENAMEAT2_CLEANUP_FAILED',
      detail: 'temporary probe cleanup could not be proven',
      mutation: 'unknown',
    };

    const result = await probeWorkstation({ mode: 'test', dependencies });

    expect(result.available).toBe(false);
    expect(result.mutation).toBe('unknown');
    expect(result.prerequisites.renameat2).toMatchObject({
      available: false,
      code: 'RENAMEAT2_CLEANUP_FAILED',
      mutation: 'unknown',
    });
  });

  it('treats a thrown prerequisite adapter as unknown mutation evidence', async () => {
    const dependencies: Record<string, PrerequisiteResult | (() => never)> = allAvailable();
    dependencies.docker = () => {
      throw new Error('adapter stopped before returning evidence');
    };

    const result = await probeWorkstation({ mode: 'test', dependencies });

    expect(result).toMatchObject({ available: false, mutation: 'unknown' });
    expect(result.prerequisites.docker).toMatchObject({
      available: false,
      code: 'DOCKER_UNAVAILABLE',
      mutation: 'unknown',
    });
  });

  it('reads the selected Task 33 installation through the production descriptor reader', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-installation-'));
    temporaryDirectories.push(installRoot);
    const fixture = await writeSelectedInstallation(installRoot);

    await expect(readSelectedInstallation({ installRoot })).resolves.toMatchObject({
      versionRoot: join(installRoot, fixture.packageVersion),
      lock: fixture.lock,
    });
  });

  it('holds and hashes the installed dependency egress proxy through its selected lock', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-proxy-positive-'));
    temporaryDirectories.push(installRoot);
    const fixture = await writeSelectedInstallation(installRoot);

    await expect(readSelectedInstallation({ installRoot })).resolves.toMatchObject({
      lock: { dependencyEgressProxySha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    expect(fixture.lock.dependencyEgressProxySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects a selected installation when its dependency egress proxy is missing', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-proxy-missing-'));
    temporaryDirectories.push(installRoot);
    const fixture = await writeSelectedInstallation(installRoot);

    await chmod(join(installRoot, fixture.packageVersion, 'operations'), 0o755);
    await rm(join(installRoot, fixture.packageVersion, 'operations', 'osi-dependency-egress-proxy.cjs'));
    await chmod(join(installRoot, fixture.packageVersion, 'operations'), 0o555);

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow(/proxy|not found|unsafe/u);
  });

  it('rejects a selected installation when its dependency egress proxy hash differs from the lock', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-proxy-hash-'));
    temporaryDirectories.push(installRoot);
    const fixture = await writeSelectedInstallation(installRoot);
    const proxyPath = join(installRoot, fixture.packageVersion, 'operations', 'osi-dependency-egress-proxy.cjs');
    await chmod(dirname(proxyPath), 0o755);
    await chmod(proxyPath, 0o644);
    await writeFile(proxyPath, `${await readFile(proxyPath, 'utf8')}\n`);
    await chmod(proxyPath, 0o444);
    await chmod(dirname(proxyPath), 0o555);

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow(/proxy|hash|evidence/u);
  });

  it('rejects a writable or symlinked dependency egress proxy', async () => {
    const writableRoot = await mkdtemp(join(tmpdir(), 'osi-selected-proxy-writable-'));
    temporaryDirectories.push(writableRoot);
    const writableFixture = await writeSelectedInstallation(writableRoot);
    const writablePath = join(writableRoot, writableFixture.packageVersion, 'operations', 'osi-dependency-egress-proxy.cjs');
    await chmod(writablePath, 0o644);
    await expect(readSelectedInstallation({ installRoot: writableRoot })).rejects.toThrow(/proxy|unsafe/u);

    const symlinkRoot = await mkdtemp(join(tmpdir(), 'osi-selected-proxy-symlink-'));
    temporaryDirectories.push(symlinkRoot);
    const symlinkFixture = await writeSelectedInstallation(symlinkRoot);
    const symlinkPath = join(symlinkRoot, symlinkFixture.packageVersion, 'operations', 'osi-dependency-egress-proxy.cjs');
    const movedPath = `${symlinkPath}.real`;
    await chmod(dirname(symlinkPath), 0o755);
    await rename(symlinkPath, movedPath);
    await symlink(movedPath, symlinkPath);
    await chmod(dirname(symlinkPath), 0o555);
    await chmod(movedPath, 0o444);
    await expect(readSelectedInstallation({ installRoot: symlinkRoot })).rejects.toThrow(/proxy|unsafe/u);
  });

  it('rejects a dependency egress proxy pathname swap after opening it', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-proxy-swap-'));
    temporaryDirectories.push(installRoot);
    const fixture = await writeSelectedInstallation(installRoot);
    const proxyPath = join(installRoot, fixture.packageVersion, 'operations', 'osi-dependency-egress-proxy.cjs');
    const proxyBytes = await readFile(proxyPath);
    let swapped = false;

    await expect(readSelectedInstallation({
      installRoot,
      hooks: {
        afterFileOpen: async ({ name }: { name: string }) => {
          if (swapped || name !== 'osi-dependency-egress-proxy.cjs') return;
          swapped = true;
          const operations = dirname(proxyPath);
          await chmod(operations, 0o755);
          await rename(proxyPath, `${proxyPath}.old`);
          await writeFile(proxyPath, proxyBytes, { mode: 0o444 });
          await chmod(operations, 0o555);
        },
      },
    })).rejects.toThrow(/changed|identity|proxy/u);
    expect(swapped).toBe(true);
  });

  it('holds effective-home authority through default selected-installation access', async () => {
    const trustedHome = await mkdtemp(join(tmpdir(), 'osi-selected-effective-home-'));
    temporaryDirectories.push(trustedHome);
    const installRoot = join(trustedHome, '.local', 'lib', 'osi-image-builder');
    const fixture = await writeSelectedInstallation(installRoot);
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    let authorityHeld = false;

    await expect(withSelectedInstallation({
      ownerUid,
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${trustedHome}:/bin/false\n`,
      },
      withEffectiveHomeAuthority: async (
        options: object,
        callback: (authority: Readonly<{ path: string }>) => Promise<unknown>,
      ) => withEffectiveHomeAuthority(options, async (authority: Readonly<{ path: string }>) => {
        authorityHeld = true;
        try {
          return await callback(authority);
        } finally {
          authorityHeld = false;
        }
      }),
    }, async (installation: Readonly<Record<string, unknown>>) => {
      expect(authorityHeld).toBe(true);
      expect(installation.versionRoot).toBe(join(installRoot, fixture.packageVersion));
      return installation;
    })).resolves.toMatchObject({ lock: fixture.lock });
    expect(authorityHeld).toBe(false);
  });

  it('rejects selected installation below a group-writable descendant ancestor before callback or mutation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'osi-selected-unsafe-ancestor-'));
    temporaryDirectories.push(parent);
    const installRoot = join(parent, 'nested', 'install');
    await writeSelectedInstallation(installRoot);
    await chmod(join(parent, 'nested'), 0o770);
    const before = await readdir(parent);
    let callbackCalled = false;

    await expect(withSelectedInstallation({ installRoot }, async () => {
      callbackCalled = true;
      return true;
    })).rejects.toThrow(/unsafe/u);
    expect(callbackCalled).toBe(false);
    expect(await readdir(parent)).toEqual(before);
  });

  it('does not report selected installation success when file or directory close fails', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-close-failure-'));
    temporaryDirectories.push(installRoot);
    await writeSelectedInstallation(installRoot);
    let callbackCalled = false;
    const closeHandle = async (handle: { close: () => Promise<void> }): Promise<void> => {
      await handle.close();
      throw new Error('injected selected-installation close failure');
    };

    await expect(withSelectedInstallation({
      installRoot,
      hooks: { closeHandle },
    }, async () => {
      callbackCalled = true;
      return true;
    })).rejects.toMatchObject({ name: 'AggregateError' });
    expect(callbackCalled).toBe(true);
  });

  it('does not report release-pair success when descriptor close fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-release-close-failure-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    await writeRelease(root, 'rpi-2', 'same image');
    const closeHandle = async (handle: { close: () => Promise<void> }): Promise<void> => {
      await handle.close();
      throw new Error('injected release close failure');
    };

    await expect(verifyReleasePair(root, { hooks: { closeHandle } })).rejects.toMatchObject({ name: 'AggregateError' });
  });

  it('rejects a hash-consistent lock with non-Task-33 nested fields', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-lock-schema-'));
    temporaryDirectories.push(installRoot);
    const { packageVersion } = await writeSelectedInstallation(installRoot);
    const lockPath = join(installRoot, packageVersion, 'builder.lock.json');
    const selectionPath = join(installRoot, 'selected.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    lock.rustConfig = { ...(lock.rustConfig as Record<string, unknown>), unexpected: true };
    const lockText = `${JSON.stringify(lock)}\n`;
    const selection = JSON.parse(await readFile(selectionPath, 'utf8')) as Record<string, unknown>;
    selection.lockSha256 = createHash('sha256').update(lockText).digest('hex');
    await writeFile(lockPath, lockText, { mode: 0o600 });
    await writeFile(selectionPath, `${JSON.stringify(selection)}\n`, { mode: 0o600 });

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow(/generated builder lock is invalid/u);
  });

  it('rejects a lock that omits the dependency egress proxy digest', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-proxy-lock-missing-'));
    temporaryDirectories.push(installRoot);
    const { packageVersion } = await writeSelectedInstallation(installRoot);
    const lockPath = join(installRoot, packageVersion, 'builder.lock.json');
    const selectionPath = join(installRoot, 'selected.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    delete lock.dependencyEgressProxySha256;
    const lockText = `${JSON.stringify(lock)}\n`;
    const selection = JSON.parse(await readFile(selectionPath, 'utf8')) as Record<string, unknown>;
    selection.lockSha256 = createHash('sha256').update(lockText).digest('hex');
    await writeFile(lockPath, lockText, { mode: 0o600 });
    await writeFile(selectionPath, `${JSON.stringify(selection)}\n`, { mode: 0o600 });

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow(/generated builder lock is invalid/u);
  });

  it('rejects hardlinked selected-installation files', async () => {
    for (const relative of ['selected.json', '2026.07.29.1/builder.lock.json', '2026.07.29.1/manifest/targets.json', '2026.07.29.1/bin/osi-image-publish', '2026.07.29.1/operations/osi-dependency-egress-proxy.cjs']) {
      const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-hardlink-'));
      temporaryDirectories.push(installRoot);
      await writeSelectedInstallation(installRoot);
      const source = join(installRoot, relative);
      await link(source, join(installRoot, `alias-${relative.replaceAll('/', '-')}`));
      await expect(readSelectedInstallation({ installRoot })).rejects.toThrow(/unsafe/u);
    }
  });

  it('rejects a symlinked selected version root', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-symlink-'));
    temporaryDirectories.push(installRoot);
    const { packageVersion } = await writeSelectedInstallation(installRoot);
    const versionRoot = join(installRoot, packageVersion);
    const moved = join(installRoot, 'moved-version');
    await rename(versionRoot, moved);
    await symlink(moved, versionRoot);

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow();
  });

  it.each([
    ['selected.json', 0o600],
    ['2026.07.29.1/builder.lock.json', 0o600],
    ['2026.07.29.1/manifest/targets.json', 0o444],
    ['2026.07.29.1/bin/osi-image-publish', 0o555],
    ['2026.07.29.1/operations/osi-dependency-egress-proxy.cjs', 0o444],
  ] as const)('rejects a symlinked selected-installation file: %s', async (relative, finalMode) => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-file-symlink-'));
    temporaryDirectories.push(installRoot);
    await writeSelectedInstallation(installRoot);
    const source = join(installRoot, relative);
    const moved = `${source}.real`;
    const parent = dirname(source);
    if (parent !== installRoot) await chmod(parent, 0o755);
    await rename(source, moved);
    await symlink(moved, source);
    if (parent !== installRoot) await chmod(parent, 0o555);
    await chmod(moved, finalMode);

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow();
  });

  it('rejects oversized selected evidence before parsing', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-oversize-'));
    temporaryDirectories.push(installRoot);
    await writeSelectedInstallation(installRoot);
    await writeFile(join(installRoot, 'selected.json'), JSON.stringify({ padding: 'x'.repeat(65_536) }), { mode: 0o600 });

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow(/unsafe/u);
  });

  it.each([
    ['selected.json', 65_537, 0o600],
    ['2026.07.29.1/builder.lock.json', 65_537, 0o600],
    ['2026.07.29.1/manifest/targets.json', 65_537, 0o444],
    ['2026.07.29.1/bin/osi-image-publish', 16 * 1024 * 1024 + 1, 0o555],
  ] as const)('rejects an oversized selected-installation file: %s', async (relative, size, finalMode) => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-file-oversize-'));
    temporaryDirectories.push(installRoot);
    await writeSelectedInstallation(installRoot);
    const path = join(installRoot, relative);
    await chmod(path, finalMode | 0o200);
    await truncate(path, size);
    await chmod(path, finalMode);

    await expect(readSelectedInstallation({ installRoot })).rejects.toThrow(/unsafe/u);
  });

  it('rejects selected-installation file and directory swaps after opening', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-swap-'));
    temporaryDirectories.push(installRoot);
    const { packageVersion } = await writeSelectedInstallation(installRoot);
    const versionRoot = join(installRoot, packageVersion);
    const lockPath = join(versionRoot, 'builder.lock.json');
    const lockBytes = await readFile(lockPath);
    let fileSwapped = false;
    await expect(readSelectedInstallation({
      installRoot,
      hooks: {
        afterFileOpen: async ({ name }: { name: string }) => {
          if (fileSwapped || name !== 'builder.lock.json') return;
          fileSwapped = true;
          await chmod(versionRoot, 0o755);
          await rename(lockPath, join(versionRoot, 'builder.lock.old'));
          await writeFile(lockPath, lockBytes, { mode: 0o600 });
          await chmod(versionRoot, 0o555);
        },
      },
    })).rejects.toThrow(/changed/u);
    expect(fileSwapped).toBe(true);

    const secondRoot = await mkdtemp(join(tmpdir(), 'osi-selected-swap-source-'));
    temporaryDirectories.push(secondRoot);
    await writeSelectedInstallation(secondRoot);
    let directorySwapped = false;
    await expect(readSelectedInstallation({
      installRoot: secondRoot,
      hooks: {
        beforeFinalRevalidation: async () => {
          directorySwapped = true;
          await rename(join(secondRoot, packageVersion), join(secondRoot, 'version-old'));
          await mkdir(join(secondRoot, packageVersion), { mode: 0o555 });
        },
      },
    })).rejects.toThrow(/changed/u);
    expect(directorySwapped).toBe(true);
  });

  it('executes and hashes the selected publisher through its held identity', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'osi-selected-publisher-'));
    temporaryDirectories.push(installRoot);
    const fixture = await writeSelectedInstallation(installRoot);

    await expect(runSelectedPublisherSelfTest({ installRoot })).resolves.toMatchObject({
      available: true,
      passed: true,
      mutation: 'none',
      sha256: fixture.lock.publisherSha256,
    });
  });

  it('publishes fixed executables and a scrubbed environment for real probes', () => {
    expect(WORKSTATION_EXECUTABLES).toEqual({
      git: '/usr/bin/git',
      docker: '/usr/bin/docker',
      systemctl: '/usr/bin/systemctl',
      sqlite3: '/usr/bin/sqlite3',
      npm: '/usr/bin/npm',
      gcc: '/usr/bin/gcc',
      make: '/usr/bin/make',
    });
    expect(FIXED_ENV).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      DOCKER_CONFIG: '/nonexistent/osi-image-builder-empty-docker-config',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ALLOW_PROTOCOL: 'ssh',
      GIT_SSH_COMMAND: '/usr/bin/ssh -F /dev/null -oBatchMode=yes -oIdentitiesOnly=no',
      GIT_SSH_VARIANT: 'ssh',
    });
    expect(Object.keys(FIXED_ENV)).not.toContain('LD_PRELOAD');
    expect(Object.values(WORKSTATION_EXECUTABLES as Record<string, string>).every((path) => path.startsWith('/'))).toBe(true);
    expect(validateGitConfigKeys(['core.repositoryFormatVersion', 'core.filemode', 'branch.main.remote', 'remote.origin.url', 'remote.origin.fetch'])).toBe(true);
    expect(validateGitConfigKeys(['core.sshCommand', 'include.path', 'remote.origin.pushurl', 'url.insteadOf'])).toBe(false);
    expect(validateGitOrigin('git@github.com:Open-Smart-Irrigation/osi-os.git')).toBe(true);
    expect(validateGitOrigin('https://github.com/Open-Smart-Irrigation/osi-os.git')).toBe(false);
  });

  it('derives the trusted Git home from effective-UID passwd evidence, never HOME', async () => {
    const trustedHome = await mkdtemp(join(tmpdir(), 'osi-trusted-home-'));
    temporaryDirectories.push(trustedHome);
    await chmod(trustedHome, 0o700);
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/attacker-controlled-home';
    try {
      const lookupPasswd = async (uid: number) => `service:x:${uid}:${uid}:service:${trustedHome}:/bin/false\n`;
      await expect(resolveEffectiveHome({ ownerUid, lookupPasswd })).resolves.toBe(trustedHome);
      await expect(resolveTrustedServiceHome({ ownerUid, lookupPasswd })).resolves.toBe(trustedHome);
      const environment = await createTrustedGitEnvironment({ ownerUid, lookupPasswd, sshAuthSock: undefined });
      expect(environment).toMatchObject({
        HOME: trustedHome,
        DOCKER_CONFIG: '/nonexistent/osi-image-builder-empty-docker-config',
      });
      expect(environment).not.toHaveProperty('SSH_AUTH_SOCK');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('binds remote Git access to the requested pinned SHA', async () => {
    const expectedSha = 'a'.repeat(40);
    const calls: string[][] = [];
    const runCommand = async (_executable: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('--name-only')) return { ok: true, stdout: 'core.repositoryformatversion\0remote.origin.url\0remote.origin.fetch\0', stderr: '' };
      if (args.at(-1) === 'remote.origin.url') return { ok: true, stdout: 'git@github.com:Open-Smart-Irrigation/osi-os.git\0', stderr: '' };
      if (args.at(-1) === 'remote.origin.fetch') return { ok: true, stdout: '+refs/heads/*:refs/remotes/origin/*\0', stderr: '' };
      return { ok: true, stdout: `${expectedSha}\trefs/heads/main\n`, stderr: '' };
    };
    const gitEnvironment = async () => FIXED_ENV;

    await expect(probeGit('/tmp/worktree', expectedSha, { runCommand, gitEnvironment })).resolves.toMatchObject({ available: true });
    expect(calls.at(-1)).toEqual(['-C', '/tmp/worktree', 'ls-remote', '--exit-code', '--heads', 'origin']);

    const wrongSha = await probeGit('/tmp/worktree', expectedSha, {
      runCommand: async (executable: string, args: readonly string[]) => {
        const response = await runCommand(executable, args);
        return args.includes('ls-remote') ? { ...response, stdout: `${'b'.repeat(40)}\trefs/heads/main\n` } : response;
      },
      gitEnvironment,
    });
    expect(wrongSha).toMatchObject({ available: false, code: 'GITSSHORIGIN_UNAVAILABLE' });
    const callsBeforeMissingSha = calls.length;
    await expect(probeGit('/tmp/worktree', undefined, { runCommand, gitEnvironment })).resolves.toMatchObject({ available: false });
    expect(calls).toHaveLength(callsBeforeMissingSha);
  });

  it('keeps trusted Git home authority held through every remote probe command', async () => {
    const expectedSha = 'a'.repeat(40);
    let authorityHeld = false;
    const runCommand = async (_executable: string, args: readonly string[]) => {
      expect(authorityHeld).toBe(true);
      if (args.includes('--name-only')) return { ok: true, stdout: 'core.repositoryformatversion\0remote.origin.url\0remote.origin.fetch\0', stderr: '' };
      if (args.at(-1) === 'remote.origin.url') return { ok: true, stdout: 'git@github.com:Open-Smart-Irrigation/osi-os.git\0', stderr: '' };
      if (args.at(-1) === 'remote.origin.fetch') return { ok: true, stdout: '+refs/heads/*:refs/remotes/origin/*\0', stderr: '' };
      return { ok: true, stdout: `${expectedSha}\trefs/heads/main\n`, stderr: '' };
    };

    await expect(probeGit('/tmp/worktree', expectedSha, {
      runCommand,
      gitEnvironment: async () => FIXED_ENV,
      withGitEnvironment: async (
        callback: (environment: typeof FIXED_ENV) => Promise<unknown>,
      ) => {
        authorityHeld = true;
        try {
          return await callback(FIXED_ENV);
        } finally {
          authorityHeld = false;
        }
      },
    })).resolves.toMatchObject({ available: true });
    expect(authorityHeld).toBe(false);
  });

  it('holds a secure Unix SSH agent socket through every Git command', async () => {
    const trustedHome = await mkdtemp(join(tmpdir(), 'osi-trusted-socket-home-'));
    temporaryDirectories.push(trustedHome);
    await chmod(trustedHome, 0o700);
    const socketParent = join(trustedHome, 'agent');
    const socketPath = join(socketParent, 'agent.sock');
    await mkdir(socketParent, { mode: 0o700 });
    const server = await listenUnixSocket(socketPath);
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const expectedSha = 'a'.repeat(40);
    let heldSocketPath: string | undefined;
    try {
      const result = await probeGit('/tmp/worktree', expectedSha, {
        homeOptions: {
          ownerUid,
          lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${trustedHome}:/bin/false\n`,
          sshAuthSock: socketPath,
        },
        runCommand: async (
          _executable: string,
          args: readonly string[],
          options: { readonly env?: Readonly<Record<string, string>> },
        ) => {
          heldSocketPath = options.env?.SSH_AUTH_SOCK;
          expect(heldSocketPath).toMatch(/^\/proc\/\d+\/fd\/\d+\/agent\.sock$/u);
          expect((await lstat(heldSocketPath as string)).isSocket()).toBe(true);
          return successfulGitResponse(args, expectedSha);
        },
      });

      expect(result).toMatchObject({ available: true, mutation: 'none' });
      await expect(lstat(heldSocketPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
      const snapshot = await createTrustedGitEnvironment({
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${trustedHome}:/bin/false\n`,
        sshAuthSock: socketPath,
      });
      expect(snapshot).not.toHaveProperty('SSH_AUTH_SOCK');
    } finally {
      await closeUnixSocket(server);
    }
  });

  it('omits an SSH agent below an effective-owned group-writable grandparent', async () => {
    const trustedHome = await mkdtemp(join(tmpdir(), 'osi-unsafe-socket-home-'));
    temporaryDirectories.push(trustedHome);
    await chmod(trustedHome, 0o700);
    const unsafeGrandparent = join(trustedHome, 'unsafe');
    const socketParent = join(unsafeGrandparent, 'agent');
    const socketPath = join(socketParent, 'agent.sock');
    await mkdir(socketParent, { recursive: true, mode: 0o700 });
    await chmod(unsafeGrandparent, 0o770);
    const server = await listenUnixSocket(socketPath);
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const expectedSha = 'a'.repeat(40);
    try {
      const result = await probeGit('/tmp/worktree', expectedSha, {
        homeOptions: {
          ownerUid,
          lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${trustedHome}:/bin/false\n`,
          sshAuthSock: socketPath,
        },
        runCommand: async (
          _executable: string,
          args: readonly string[],
          options: { readonly env?: Readonly<Record<string, string>> },
        ) => {
          expect(options.env).not.toHaveProperty('SSH_AUTH_SOCK');
          return successfulGitResponse(args, expectedSha);
        },
      });
      expect(result).toMatchObject({ available: true, mutation: 'none' });
    } finally {
      await closeUnixSocket(server);
    }
  });

  it.each(['socket', 'parent'] as const)(
    'rejects Git probing when the held SSH agent %s is replaced during a command',
    async (replacement) => {
      const trustedHome = await mkdtemp(join(tmpdir(), `osi-replaced-${replacement}-home-`));
      temporaryDirectories.push(trustedHome);
      await chmod(trustedHome, 0o700);
      const socketParent = join(trustedHome, 'agent');
      const movedParent = `${socketParent}.old`;
      const socketPath = join(socketParent, 'agent.sock');
      await mkdir(socketParent, { mode: 0o700 });
      let originalServer: Server | undefined = await listenUnixSocket(socketPath);
      let replacementServer: Server | undefined;
      const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
      const expectedSha = 'a'.repeat(40);
      let replaced = false;
      try {
        const result = await probeGit('/tmp/worktree', expectedSha, {
          homeOptions: {
            ownerUid,
            lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${trustedHome}:/bin/false\n`,
            sshAuthSock: socketPath,
          },
          runCommand: async (_executable: string, args: readonly string[]) => {
            if (!replaced) {
              replaced = true;
              if (replacement === 'socket') {
                await closeUnixSocket(originalServer);
                originalServer = undefined;
                await rm(socketPath, { force: true });
              } else {
                await rename(socketParent, movedParent);
                await mkdir(socketParent, { mode: 0o700 });
              }
              replacementServer = await listenUnixSocket(socketPath);
            }
            return successfulGitResponse(args, expectedSha);
          },
        });

        expect(replaced).toBe(true);
        expect(result).toMatchObject({
          available: false,
          code: 'GITSSHORIGIN_UNAVAILABLE',
          mutation: 'none',
        });
      } finally {
        await closeUnixSocket(replacementServer);
        await closeUnixSocket(originalServer);
      }
    },
  );

  it('requires both output and state filesystems at the configured free-space floor', async () => {
    const outputPath = '/approved/images';
    const statePath = '/state/jobs';
    const gibibyte = 1024 ** 3;
    const env = {
      OSI_IMAGE_BUILDER_APPROVED_ROOT_PATH: outputPath,
      OSI_IMAGE_BUILDER_STATE_ROOT_PATH: statePath,
      OSI_IMAGE_BUILDER_DISK_MINIMUM_BYTES: String(25 * gibibyte),
    };
    const lowState = await probeFreeDisk(env, async (path: string) => ({
      bavail: path === outputPath ? 30 : 24,
      bsize: gibibyte,
    }));
    expect(lowState).toMatchObject({ available: false, code: 'FREEDISK_UNAVAILABLE' });
    const sufficient = await probeFreeDisk(env, async () => ({ bavail: 30, bsize: gibibyte }));
    expect(sufficient).toMatchObject({ available: true, code: 'FREEDISK_AVAILABLE', mutation: 'none' });
  });

  it('runs the test-mode CLI without touching its working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-workstation-cli-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'sentinel'), 'unchanged\n');
    const before = await snapshot(root);
    const result = await execFile(process.execPath, ['scripts/run-workstation-test.mjs', '--test'], {
      cwd: new URL('../..', import.meta.url),
      env: { ...process.env, OSI_IMAGE_BUILDER_TEST_ROOT: root },
      maxBuffer: 128 * 1024,
    });
    const output = JSON.parse(result.stdout) as {
      readonly available: boolean;
      readonly mutation: string;
      readonly prerequisites: Record<string, PrerequisiteResult>;
    };
    expect(output.available).toBe(false);
    expect(output.mutation).toBe('none');
    expect(Object.keys(output.prerequisites)).toEqual([...PREREQUISITE_NAMES]);
    expect(Object.values(output.prerequisites).every((item) => item.mutation === 'none')).toBe(true);
    expect(await snapshot(root)).toEqual(before);
  });
});
