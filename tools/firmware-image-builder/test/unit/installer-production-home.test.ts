import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { build } from 'esbuild';
import viteConfig from '../../ui/vite.config.js';

const mocks = vi.hoisted(() => ({
  defaultProbe: vi.fn(async () => ({
    available: false as const,
    code: 'DEFAULT_PROBE_STOP',
    detail: 'stop before production build',
    mutation: 'none' as const,
  })),
}));

vi.mock('../../installer/probes.js', () => ({
  runNativePrerequisiteProbes: mocks.defaultProbe,
}));

import {
  collectProductionRuntimeArtifacts,
  installProductionVersion,
} from '../../installer/production.js';
import { withEffectiveHomeAuthority } from '../../shared/effective-home.mjs';

const temporaryDirectories: string[] = [];
const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTrustedHome(): Promise<Readonly<{
  root: string;
  home: string;
  effectiveHomeOptions: Readonly<{
    ownerUid: number;
    lookupPasswd: (uid: number) => Promise<string>;
  }>;
}>> {
  const root = await mkdtemp(join(homedir(), '.osi-production-home-'));
  temporaryDirectories.push(root);
  const home = join(root, 'service-home');
  await mkdir(home, { mode: 0o700 });
  return Object.freeze({
    root,
    home,
    effectiveHomeOptions: Object.freeze({
      ownerUid,
      lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${home}:/bin/false\n`,
    }),
  });
}

async function createRuntimeArtifactFixture(parent: string, prefix: string): Promise<Readonly<{
  packageRoot: string;
  operations: string;
  proxy: string;
}>> {
  const packageRoot = await mkdtemp(join(parent, prefix));
  temporaryDirectories.push(packageRoot);
  const viteOutput = relative(
    fileURLToPath(new URL('../../', import.meta.url)),
    resolve(viteConfig.root as string, viteConfig.build?.outDir as string),
  );
  const operations = join(packageRoot, 'builder', 'operations');
  const proxy = join(operations, 'osi-dependency-egress-proxy.cjs');
  await mkdir(join(packageRoot, viteOutput), { recursive: true, mode: 0o700 });
  await mkdir(join(packageRoot, 'api', 'migrations'), { recursive: true, mode: 0o700 });
  await mkdir(join(packageRoot, 'systemd'), { mode: 0o700 });
  await mkdir(join(packageRoot, 'manifest'), { mode: 0o700 });
  await mkdir(operations, { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, viteOutput, 'index.html'), '<!doctype html>');
  await writeFile(join(packageRoot, 'api', 'migrations', '001.sql'), 'SELECT 1;\n');
  await writeFile(join(packageRoot, 'systemd', 'api.service'), '[Unit]\n');
  await writeFile(join(packageRoot, 'manifest', 'targets.json'), '{}\n');
  await writeFile(
    proxy,
    await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url)),
    { mode: 0o444 },
  );
  return Object.freeze({ packageRoot, operations, proxy });
}

describe('production installer effective home', () => {
  it('collects the actual Vite output while preserving installed ui paths', async () => {
    const repositoryPackageRoot = fileURLToPath(new URL('../../', import.meta.url));
    expect(typeof viteConfig.root).toBe('string');
    expect(typeof viteConfig.build?.outDir).toBe('string');
    const viteOutput = relative(
      repositoryPackageRoot,
      resolve(viteConfig.root as string, viteConfig.build?.outDir as string),
    );
    expect(viteOutput).not.toMatch(/^\.\.(?:\/|$)/u);

    const packageRoot = await mkdtemp(join(homedir(), '.osi-production-artifacts-'));
    temporaryDirectories.push(packageRoot);
    const expectedIndex = '<!doctype html><title>built ui index</title>';
    await mkdir(join(packageRoot, viteOutput, 'assets'), { recursive: true, mode: 0o700 });
    await mkdir(join(packageRoot, 'dist'), { mode: 0o700 });
    await mkdir(join(packageRoot, 'api', 'migrations'), { recursive: true, mode: 0o700 });
    await mkdir(join(packageRoot, 'builder', 'operations'), { recursive: true, mode: 0o700 });
    await mkdir(join(packageRoot, 'systemd'), { mode: 0o700 });
    await mkdir(join(packageRoot, 'manifest'), { mode: 0o700 });
    const trustedProxy = await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url));
    await Promise.all([
      writeFile(join(packageRoot, viteOutput, 'index.html'), expectedIndex),
      writeFile(join(packageRoot, viteOutput, 'assets', 'application.js'), 'built asset'),
      writeFile(join(packageRoot, 'dist', 'index.html'), '<title>wrong package-root output</title>'),
      writeFile(join(packageRoot, 'api', 'migrations', '001.sql'), 'SELECT 1;\n'),
      writeFile(
        join(packageRoot, 'builder', 'operations', 'osi-dependency-egress-proxy.cjs'),
        trustedProxy,
      ),
      writeFile(join(packageRoot, 'systemd', 'api.service'), '[Unit]\n'),
      writeFile(join(packageRoot, 'manifest', 'targets.json'), '{}\n'),
    ]);

    const result = await collectProductionRuntimeArtifacts(packageRoot);

    expect(result.uiIndex).toBe(expectedIndex);
    expect(result.additionalArtifacts).not.toHaveProperty('ui/index.html');
    expect(Buffer.from(result.additionalArtifacts['ui/assets/application.js'] ?? []).toString('utf8'))
      .toBe('built asset');
    expect(Buffer.from(result.dependencyEgressProxy).toString('utf8'))
      .toContain('resolveDependencyDestination');
    expect(result.additionalArtifacts).not.toHaveProperty('operations/osi-dependency-egress-proxy.cjs');
  });

  it('rejects a source proxy symlink before copying runtime artifacts', async () => {
    const packageRoot = await mkdtemp(join(homedir(), '.osi-production-proxy-symlink-'));
    temporaryDirectories.push(packageRoot);
    const viteOutput = relative(
      fileURLToPath(new URL('../../', import.meta.url)),
      resolve(viteConfig.root as string, viteConfig.build?.outDir as string),
    );
    await mkdir(join(packageRoot, viteOutput), { recursive: true, mode: 0o700 });
    await mkdir(join(packageRoot, 'api', 'migrations'), { recursive: true, mode: 0o700 });
    await mkdir(join(packageRoot, 'systemd'), { mode: 0o700 });
    await mkdir(join(packageRoot, 'manifest'), { mode: 0o700 });
    await writeFile(join(packageRoot, viteOutput, 'index.html'), '<!doctype html>');
    await writeFile(join(packageRoot, 'api', 'migrations', '001.sql'), 'SELECT 1;\n');
    await writeFile(join(packageRoot, 'systemd', 'api.service'), '[Unit]\n');
    await writeFile(join(packageRoot, 'manifest', 'targets.json'), '{}\n');
    await symlink('/etc/passwd', join(packageRoot, 'builder-proxy-link'));
    await mkdir(join(packageRoot, 'builder', 'operations'), { recursive: true, mode: 0o700 });
    await symlink(join(packageRoot, 'builder-proxy-link'), join(packageRoot, 'builder', 'operations', 'osi-dependency-egress-proxy.cjs'));

    await expect(collectProductionRuntimeArtifacts(packageRoot)).rejects.toThrow(/symbolic link|proxy/i);
  });

  it('rejects a deterministic post-validation proxy substitution against the trusted source digest', async () => {
    const packageRoot = await mkdtemp(join(homedir(), '.osi-production-proxy-substitution-'));
    temporaryDirectories.push(packageRoot);
    const viteOutput = relative(
      fileURLToPath(new URL('../../', import.meta.url)),
      resolve(viteConfig.root as string, viteConfig.build?.outDir as string),
    );
    const operations = join(packageRoot, 'builder', 'operations');
    const proxy = join(operations, 'osi-dependency-egress-proxy.cjs');
    await mkdir(join(packageRoot, viteOutput), { recursive: true, mode: 0o700 });
    await mkdir(join(packageRoot, 'api', 'migrations'), { recursive: true, mode: 0o700 });
    await mkdir(join(packageRoot, 'systemd'), { mode: 0o700 });
    await mkdir(join(packageRoot, 'manifest'), { mode: 0o700 });
    await mkdir(operations, { recursive: true, mode: 0o700 });
    await writeFile(join(packageRoot, viteOutput, 'index.html'), '<!doctype html>');
    await writeFile(join(packageRoot, 'api', 'migrations', '001.sql'), 'SELECT 1;\n');
    await writeFile(join(packageRoot, 'systemd', 'api.service'), '[Unit]\n');
    await writeFile(join(packageRoot, 'manifest', 'targets.json'), '{}\n');
    await writeFile(proxy, await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url)), { mode: 0o444 });

    await expect(collectProductionRuntimeArtifacts(packageRoot, {
      beforeDependencyEgressProxyCapture: async () => {
        await rename(proxy, `${proxy}.validated`);
        await writeFile(proxy, 'module.exports = {};\n', { mode: 0o444 });
      },
    })).rejects.toThrow(/trusted|digest|proxy/i);
  });

  it('accepts an ext4-style operations directory link count', async () => {
    const fixture = await createRuntimeArtifactFixture(tmpdir(), 'osi-production-ext4-directory-');
    await mkdir(join(fixture.operations, 'ext4-subdirectory'), { mode: 0o700 });
    expect((await lstat(fixture.operations)).nlink).toBeGreaterThan(1);

    await expect(collectProductionRuntimeArtifacts(fixture.packageRoot)).resolves.toMatchObject({
      dependencyEgressProxy: expect.any(Uint8Array),
    });
  });

  it('rejects a FIFO substituted between proxy lstat and open without blocking and closes the descriptor', async () => {
    const fixture = await createRuntimeArtifactFixture(homedir(), '.osi-production-proxy-fifo-');
    let openedFd: number | undefined;
    const startedAt = Date.now();

    await expect(collectProductionRuntimeArtifacts(fixture.packageRoot, {
      beforeDependencyEgressProxyOpen: async ({ proxyPath }) => {
        await rename(proxyPath, `${proxyPath}.validated`);
        await execFileAsync('/usr/bin/mkfifo', [proxyPath]);
      },
      afterDependencyEgressProxyOpen: ({ fd }) => {
        openedFd = fd;
      },
    })).rejects.toThrow(/proxy.*changed|regular file/iu);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(openedFd).toEqual(expect.any(Number));
    await expect(lstat(`/proc/self/fd/${String(openedFd)}`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts installed API and runner bundles without a bin-local manifest', async () => {
    const root = await mkdtemp(join(homedir(), '.osi-installed-bundle-'));
    temporaryDirectories.push(root);
    const bin = join(root, 'bin');
    const manifest = join(root, 'manifest');
    const operations = join(root, 'operations');
    await mkdir(bin, { mode: 0o700 });
    await mkdir(manifest, { mode: 0o700 });
    await mkdir(operations, { mode: 0o700 });
    await writeFile(
      join(manifest, 'targets.json'),
      await readFile(new URL('../../manifest/targets.json', import.meta.url)),
      { mode: 0o444 },
    );
    await writeFile(
      join(operations, 'osi-dependency-egress-proxy.cjs'),
      await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url)),
      { mode: 0o444 },
    );
    const api = join(bin, 'osi-image-builder-api');
    const runner = join(bin, 'osi-image-builder-runner');
    await Promise.all([
      build({
        entryPoints: [new URL('../../api/src/cli.ts', import.meta.url).pathname],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        mainFields: ['module', 'main'],
        write: true,
        outfile: api,
        sourcemap: false,
        legalComments: 'none',
        banner: { js: '#!/usr/bin/env node' },
      }),
      build({
        entryPoints: [new URL('../../runner/src/cli.ts', import.meta.url).pathname],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        mainFields: ['module', 'main'],
        write: true,
        outfile: runner,
        sourcemap: false,
        legalComments: 'none',
        banner: { js: '#!/usr/bin/env node' },
      }),
    ]);

    await expect(lstat(join(bin, 'targets.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(execFileAsync(process.execPath, [api, 'unexpected'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('API accepts no command arguments\n'),
    });
    await expect(execFileAsync(process.execPath, [runner], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('runner failed: runner requires exactly one job ID\n'),
    });
  });

  it('fails closed in a standalone bundle for missing, writable, mismatched, and substituted proxy runtime paths', async () => {
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    const base = await mkdtemp(join(homedir(), '.osi-installed-proxy-bundle-'));
    temporaryDirectories.push(base);
    const probe = join(base, 'installed-proxy-probe.mjs');
    await build({
      stdin: {
        resolveDir: packageRoot,
        sourcefile: 'installed-proxy-probe.ts',
        loader: 'ts',
        contents: `
          import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
          import { basename, join } from 'node:path';
          import { createInstalledLockReader } from './domain/installed-lock.ts';
          import { validateBuilderLock } from './domain/builder-lock.ts';
          import { loadInstalledDependencyEgressPolicy } from './runner/src/network-policy.ts';

          const root = process.argv[2];
          const substitution = process.argv[3] ?? 'none';
          try {
            const installedLock = await createInstalledLockReader().read(root);
            const parsed = JSON.parse(installedLock.text);
            const validated = validateBuilderLock(parsed, basename(root));
            if (!validated.ok) throw new Error(validated.reason);
            const operations = join(root, 'operations');
            const proxy = join(operations, 'osi-dependency-egress-proxy.cjs');
            await loadInstalledDependencyEgressPolicy(root, validated.lock.dependencyEgressProxySha256, {
              hooks: substitution === 'leaf' ? {
                beforePostRead: async () => {
                  await chmod(operations, 0o755);
                  await rename(proxy, proxy + '.moved');
                  await writeFile(proxy, "'use strict';\\nmodule.exports = {};\\n", { mode: 0o444 });
                  await chmod(operations, 0o555);
                },
              } : substitution === 'parent' ? {
                afterOpenOperations: async () => {
                  await chmod(root, 0o755);
                  await rename(operations, operations + '.moved');
                  await mkdir(operations, { mode: 0o555 });
                  await chmod(root, 0o555);
                },
              } : undefined,
            });
            process.stdout.write('validated\\n');
          } catch (error) {
            process.stderr.write(String(error && typeof error === 'object' && 'code' in error ? error.code : error) + '\\n');
            process.exitCode = 1;
          }
        `,
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: true,
      outfile: probe,
      sourcemap: false,
      legalComments: 'none',
    });

    const proxySource = await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url));
    const proxySha256 = createHash('sha256').update(proxySource).digest('hex');
    const lock = (dependencyEgressProxySha256: string) => ({
      schemaVersion: 1,
      packageVersion: '0.1.28',
      imageRepository: 'registry.example.invalid/osi-image-builder',
      imageDigest: '1'.repeat(64),
      baseImage: `docker.io/library/debian@sha256:${'2'.repeat(64)}`,
      baseImageDigest: '2'.repeat(64),
      dockerfileSha256: '3'.repeat(64),
      packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev', 'libpolly-19-dev'],
      rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 },
      nodeVersion: '22.14.0',
      executionDefinitionSha256: '4'.repeat(64),
      validationEvidenceSha256: '5'.repeat(64),
      dependencyEgressProxySha256,
      installable: true,
    });

    for (const testCase of ['missing', 'writable', 'hash-mismatch', 'leaf', 'parent'] as const) {
      const root = join(base, `${testCase}-root`, '0.1.28');
      const operations = join(root, 'operations');
      const proxy = join(operations, 'osi-dependency-egress-proxy.cjs');
      await mkdir(operations, { recursive: true, mode: 0o700 });
      if (testCase !== 'missing') {
        await writeFile(proxy, testCase === 'hash-mismatch' ? Buffer.from('changed\n') : proxySource, { mode: 0o600 });
        await chmod(proxy, testCase === 'writable' ? 0o644 : 0o444);
      }
      await writeFile(join(root, 'builder.lock.json'), `${JSON.stringify(lock(proxySha256))}\n`, { mode: 0o600 });
      await chmod(operations, 0o555);
      await chmod(root, 0o555);

      const run = execFileAsync(process.execPath, [probe, root, testCase], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      const code = testCase === 'missing'
        ? 'NOT_FOUND'
        : testCase === 'writable'
          ? 'FILE_UNSAFE'
          : testCase === 'hash-mismatch'
            ? 'HASH_MISMATCH'
            : 'RACE_DETECTED';
      await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining(`${code}\n`) });

      await chmod(join(root, 'operations'), 0o700).catch(() => undefined);
      await chmod(join(root, 'operations.moved'), 0o700).catch(() => undefined);
      await chmod(root, 0o700).catch(() => undefined);
      await chmod(`${root}.moved`, 0o700).catch(() => undefined);
    }
  });

  it('acquires the global install lock through the held parent before ensuring installRoot', async () => {
    const source = await readFile(new URL('../../installer/production.ts', import.meta.url), 'utf8');
    const ensureParent = source.indexOf('await installParentAuthority.ensure()');
    const parentLock = source.indexOf('join(installParentExecutionRoot, INSTALL_LOCK_NAME)');
    const ensureInstall = source.indexOf('await installAuthority.ensure()');

    expect(ensureParent).toBeGreaterThan(-1);
    expect(parentLock).toBeGreaterThan(ensureParent);
    expect(ensureInstall).toBeGreaterThan(parentLock);
    expect(source).not.toContain('join(installExecutionRoot, INSTALL_LOCK_NAME)');
  });

  it('ignores poisoned HOME and passes the effective passwd home to prerequisite probing', async () => {
    const fixture = await createTrustedHome();
    const { root, home: trustedHome } = fixture;
    const observed: string[] = [];
    const previousHome = process.env.HOME;
    let authorityHeld = false;
    process.env.HOME = join(root, 'attacker-home');
    try {
      const result = await installProductionVersion({
        effectiveHomeOptions: fixture.effectiveHomeOptions,
        withEffectiveHomeAuthority: async (options, callback) => withEffectiveHomeAuthority(
          options,
          async (authority) => {
            authorityHeld = true;
            try {
              return await callback(authority);
            } finally {
              authorityHeld = false;
            }
          },
        ),
        probePrerequisites: async ({ scratchParent }: { readonly scratchParent: string }) => {
          expect(authorityHeld).toBe(true);
          expect(scratchParent).toMatch(/^\/proc\/\d+\/fd\/\d+$/u);
          expect(await realpath(scratchParent)).toBe(trustedHome);
          observed.push(scratchParent);
          return {
            available: false,
            code: 'INJECTED_PROBE_STOP',
            detail: 'stop before production build',
            mutation: 'none',
          };
        },
      });

      expect(result).toMatchObject({ available: false, code: 'INJECTED_PROBE_STOP' });
      expect(observed).toHaveLength(1);
      expect(mocks.defaultProbe).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it.each(['.local', 'lib'] as const)(
    'rejects an in-home %s symlink before prerequisite probing or installation mutation',
    async (component) => {
      const fixture = await createTrustedHome();
      const external = join(fixture.root, `external-${component.replace('.', '')}`);
      await mkdir(external, { mode: 0o700 });
      if (component === '.local') {
        await symlink(external, join(fixture.home, '.local'));
      } else {
        await mkdir(join(fixture.home, '.local'), { mode: 0o700 });
        await symlink(external, join(fixture.home, '.local', 'lib'));
      }
      const probePrerequisites = vi.fn(async () => ({
        available: false as const,
        code: 'PROBE_MUST_NOT_RUN',
        detail: 'descendant authority should reject first',
        mutation: 'none' as const,
      }));

      await expect(installProductionVersion({
        effectiveHomeOptions: fixture.effectiveHomeOptions,
        probePrerequisites,
      })).rejects.toThrow();

      expect(probePrerequisites).not.toHaveBeenCalled();
      await expect(lstat(join(external, 'osi-image-builder'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(fixture.home, '.local', 'lib', 'osi-image-builder', 'selected.json')))
        .rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|ENOENT/u) });
    },
  );

  it('detects install-root replacement by an unavailable probe without writing either pathname', async () => {
    const fixture = await createTrustedHome();
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/u);
    const installRoot = join(fixture.home, '.local', 'lib', 'osi-image-builder');
    const movedInstallRoot = `${installRoot}-moved`;
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    await chmod(join(fixture.home, '.local'), 0o700);
    await chmod(join(fixture.home, '.local', 'lib'), 0o700);
    await chmod(installRoot, 0o700);
    const probePrerequisites = vi.fn(async () => {
      await rename(installRoot, movedInstallRoot);
      await mkdir(installRoot, { mode: 0o700 });
      return {
        available: false as const,
        code: 'INJECTED_PROBE_STOP',
        detail: 'stop after replacing install root',
        mutation: 'none' as const,
      };
    });

    await expect(installProductionVersion({
      effectiveHomeOptions: fixture.effectiveHomeOptions,
      probePrerequisites,
    })).rejects.toThrow(/identity|pathname|changed/u);

    expect(probePrerequisites).toHaveBeenCalledOnce();
    for (const root of [installRoot, movedInstallRoot]) {
      await expect(lstat(join(root, 'selected.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(root, String(packageJson.version)))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
