import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config/load.js';
import { GitCommand } from '../../api/src/git/git-command.js';
import { SourceResolver } from '../../api/src/git/source-resolver.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import { PreflightService, TRUSTED_PREFLIGHT_EXECUTABLES } from '../../api/src/preflight.js';
import { BuilderStore } from '../../api/src/store.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { loadManifest } from '../../manifest/validate.js';
import { createCommandExecutor } from '../../runner/src/command-executor.js';
import { createEvidenceWriter } from '../../runner/src/evidence.js';
import {
  createOperationDefinition,
  INTERNAL_OPERATION_TOOL_PATH,
} from '../../runner/src/operation-registry.js';
import {
  classifyTargetSetupOperationResult,
  createTargetSetupConfigObservations,
  createTargetSetupSourceObservations,
  createLockedTargetSetupOperations,
  resolveTargetSetup,
  type TargetSetupOperationId,
} from '../../runner/src/target-setup.js';
import { verifyTargetSetupConfiguration } from '../../runner/src/verification.js';

const loadedManifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname);
const manifest = loadedManifest.manifest;
const fixtureRoot = new URL('../fixtures/target-setup/', import.meta.url).pathname;
const rustFixture = new URL('../fixtures/openwrt-packages-d8cd30f4/lang/rust/Makefile', import.meta.url).pathname;
const packagesGitFixtureRoot = new URL('../fixtures/openwrt-packages-d8cd30f4/git/', import.meta.url).pathname;
const rootfsFixture = new URL('../../../../openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh', import.meta.url).pathname;
const packagesCommit = 'd8cd30f4e281d6853b3de134c4f147a807583e43';
const packagesRustBlob = 'f63c5a5a8a75b7e2f2ab2b06114c1a25413d0ae1';
const packagesGitignoreBlob = '5e2eb9a79195dc242db25c07c782372a3f5dcf01';
const packagesSnapshotPackSha256 = '41c9cecc99835f1d2fda29133d9683bc07d8437f28fd24415ed6ad1d81380db6';
const packagesSnapshotIndexSha256 = 'd988fb93e92117964e0ef7365a30e6f120d894982aae69a768cf9882559d9ee3';
const operationTool = new URL('../../builder/operations/osi-image-builder-tool.js', import.meta.url).pathname;
const repositoryFixtureRoot = new URL('../../../../', import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function configFor(target: (typeof manifest.targets)[number]): string {
  return `${target.configSymbols.map((symbol) => {
    if (symbol.type === 'bool') return symbol.value ? `${symbol.name}=y` : `# ${symbol.name} is not set`;
    if (symbol.type === 'string') return `${symbol.name}="${symbol.value}"`;
    return `${symbol.name}=${symbol.value}`;
  }).join('\n')}\n`;
}

describe('feed configuration integration boundary', () => {
  it('runs the exact repository switch-env recipe to the approved rootfs state for both profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-switch-env-reality-'));
    temporaryDirectories.push(root);
    expect((await readFile(join(repositoryFixtureRoot, 'openwrt/.gitignore'), 'utf8'))
      .split(/\r?\n/u)).toContain('/.pc');
    await copyFile(join(repositoryFixtureRoot, 'Makefile'), join(root, 'Makefile'));
    await copyFile(join(repositoryFixtureRoot, '.gitignore'), join(root, '.gitignore'));
    await mkdir(join(root, 'openwrt/target/linux/bcm27xx/image'), { recursive: true });
    await copyFile(
      join(repositoryFixtureRoot, 'openwrt/.gitignore'),
      join(root, 'openwrt/.gitignore'),
    );
    await expect(lstat(join(root, 'openwrt/.pc'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const relativePath of [
      'openwrt/target/linux/bcm27xx/image/cmdline.txt',
      'openwrt/target/linux/bcm27xx/image/config.txt',
      'openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh',
      'openwrt/target/linux/bcm27xx/bcm2712/config-6.6',
    ]) {
      await mkdir(dirname(join(root, relativePath)), { recursive: true });
      await copyFile(join(repositoryFixtureRoot, relativePath), join(root, relativePath));
    }
    for (const target of manifest.targets) {
      const sourceProfile = join(repositoryFixtureRoot, 'conf', target.environment);
      const targetProfile = join(root, 'conf', target.environment);
      await mkdir(join(targetProfile, 'files'), { recursive: true });
      await mkdir(join(targetProfile, 'patches'), { recursive: true });
      await copyFile(join(sourceProfile, '.config'), join(targetProfile, '.config'));
      const series = await readFile(join(sourceProfile, 'patches/series'), 'utf8');
      await writeFile(join(targetProfile, 'patches/series'), series);
      for (const patch of series.split(/\r?\n/u).filter((line) => line.length > 0)) {
        await copyFile(
          join(sourceProfile, 'patches', patch),
          join(targetProfile, 'patches', patch),
        );
      }
    }
    const gitEnvironment = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(root, 'git-home'),
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    await mkdir(gitEnvironment.HOME);
    for (const argv of [
      ['init', '--quiet'],
      ['config', 'user.name', 'Fixture Author'],
      ['config', 'user.email', 'fixture@example.test'],
      ['add', '.'],
      ['commit', '--quiet', '-m', 'exact switch-env source'],
    ]) {
      await execFile('/usr/bin/git', argv, { cwd: root, env: gitEnvironment });
    }
    const executor = createCommandExecutor();
    for (const target of manifest.targets) {
      const definition = createOperationDefinition('activate-target', {
        environment: target.environment,
      });
      const command = await executor.run(definition.argv, {
        cwd: root,
        env: gitEnvironment,
        timeoutMs: 10_000,
        maxCaptureBytes: 64 * 1024,
      });
      expect(classifyTargetSetupOperationResult(
        'activate-target',
        definition,
        command,
      )).toMatchObject({ disposition: 'expected-rootfs-already-present' });
      expect(command.stdout).not.toContain('Applying patch patches/no-uart-console.patch');
      expect(command.stdout.includes('Applying patch patches/boot-config.patch'))
        .toBe(target.id === 'rpi-5');
      expect(command.stdout.trimEnd()).toMatch(
        /Patch patches\/image-with-padded-rootfs\.patch can be reverse-applied$/u,
      );
      expect(await readFile(join(root, 'openwrt/.pc/.quilt_series'), 'utf8')).toBe('series\n');
      const appliedPatches = join(root, 'openwrt/.pc/applied-patches');
      if (target.id === 'rpi-5') {
        expect(await readFile(appliedPatches, 'utf8')).toBe('boot-config.patch\n');
      } else {
        await expect(lstat(appliedPatches)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(
        join(root, 'openwrt/target/linux/bcm27xx/image/cmdline.txt'),
        'utf8',
      )).toBe('console=tty1 root=@ROOT@ rootfstype=squashfs,ext4 rootwait\n');
      const bootConfig = await readFile(
        join(root, 'openwrt/target/linux/bcm27xx/image/config.txt'),
        'utf8',
      );
      for (const setting of [
        'dtparam=spi=on',
        'enable_uart=1',
        'dtparam=i2c1=on',
        'dtparam=i2c_arm=on',
        'dtoverlay=dwc2',
      ]) {
        expect(bootConfig.split(/\r?\n/u)).toContain(setting);
      }
      expect(bootConfig.includes('dtparam=cooling_fan=okay')).toBe(target.id === 'rpi-5');
    }
    const pi5KernelConfig = await readFile(
      join(root, 'openwrt/target/linux/bcm27xx/bcm2712/config-6.6'),
      'utf8',
    );
    for (const symbol of [
      'CONFIG_SPI=y',
      'CONFIG_SPI_DESIGNWARE=y',
      'CONFIG_SPI_DW_MMIO=y',
      'CONFIG_SPI_DYNAMIC=y',
      'CONFIG_SPI_MASTER=y',
    ]) {
      expect(pi5KernelConfig.split(/\r?\n/u)).toContain(symbol);
    }
    for (const obsoleteDisabledSymbol of [
      '# CONFIG_FIRMWARE_RP1 is not set',
      '# CONFIG_MBOX_RP1 is not set',
      '# CONFIG_RP1_PIO is not set',
      '# CONFIG_SENSORS_RP1_ADC is not set',
    ]) {
      expect(pi5KernelConfig).not.toContain(obsoleteDisabledSymbol);
    }
  }, 30_000);

  it('prepares a fresh worktree offline and executes fixture switch-env, feed update/install, and defconfig scripts for both profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-feed-config-'));
    temporaryDirectories.push(root);
    const configHome = join(root, 'config');
    const repository = join(root, 'repository');
    const images = join(root, 'images');
    await mkdir(configHome, { recursive: true });
    await mkdir(repository, { recursive: true });
    await mkdir(images, { recursive: true });
    await writeFile(join(configHome, 'config.json'), JSON.stringify({
      repositoryPath: repository,
      approvedOutputRoots: [{ id: 'images', label: 'images', path: images }],
      builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
      maxQueueLength: 50,
      diskFreeMinimumBytes: 20 * 1024 ** 3,
    }));
    const loaded = await loadConfig({
      configPath: join(configHome, 'config.json'),
      env: { HOME: root, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(root, 'state-home') },
      git: { getOriginPolicy: async () => ({ url: 'git@github.com:Open-Smart-Irrigation/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
      rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    });

    const jobId = 'job-feed-integration';
    const workspace = join(loaded.stateRoot, 'jobs', jobId, 'workspace', 'source');
    await mkdir(join(workspace, 'openwrt/scripts'), { recursive: true });
    await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/apps/node-red'), { recursive: true });
    await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/apps/node-red-contrib-chirpstack'), { recursive: true });
    await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/apps/node-red-node-sqlite'), { recursive: true });
    await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack'), { recursive: true });
    await mkdir(join(workspace, 'test-support'), { recursive: true });
    await copyFile(join(fixtureRoot, 'Makefile'), join(workspace, 'Makefile'));
    await copyFile(join(fixtureRoot, 'switch-env.sh'), join(workspace, 'test-support/switch-env.sh'));
    await copyFile(join(fixtureRoot, 'openwrt-Makefile'), join(workspace, 'openwrt/Makefile'));
    await copyFile(join(fixtureRoot, 'feeds.sh'), join(workspace, 'openwrt/scripts/feeds'));
    await chmod(join(workspace, 'test-support/switch-env.sh'), 0o755);
    await chmod(join(workspace, 'openwrt/scripts/feeds'), 0o755);
    await expect(lstat(join(workspace, 'openwrt/.pc'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const target of manifest.targets) {
      const directory = join(workspace, 'conf', target.environment);
      await mkdir(join(directory, 'patches'), { recursive: true });
      await writeFile(join(directory, '.config'), configFor(target));
      await writeFile(join(directory, 'patches/series'), [
        ...(target.id === 'rpi-5' ? ['boot-config.patch'] : []),
        'image-with-padded-rootfs.patch',
        '',
      ].join('\n'));
      await copyFile(rootfsFixture, join(directory, 'approved-rootfs.sh'));
    }

    const fixtureGitEnv = {
      PATH: '/usr/bin:/bin',
      HOME: join(root, 'fixture-git-home'),
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'file',
    };
    await mkdir(fixtureGitEnv.HOME);
    const fixtureGit = async (cwd: string, argv: readonly string[]) => execFile('/usr/bin/git', [...argv], { cwd, env: fixtureGitEnv });
    const nestedDonor = join(root, 'nested-feed-dependency');
    const luciDonor = join(root, 'luci-feed');
    const packagesDonor = join(root, 'packages-feed');
    const routingDonor = join(root, 'routing-feed');
    for (const donor of [nestedDonor, luciDonor, routingDonor]) {
      await mkdir(donor);
      await fixtureGit(donor, ['init', '--quiet']);
      await fixtureGit(donor, ['config', 'user.name', 'Fixture Author']);
      await fixtureGit(donor, ['config', 'user.email', 'fixture@example.test']);
    }
    await fixtureGit(root, ['init', '--quiet', '--bare', packagesDonor]);
    const packagesPack = await readFile(join(packagesGitFixtureRoot, 'snapshot.pack'));
    const packagesIndex = await readFile(join(packagesGitFixtureRoot, 'snapshot.idx'));
    expect(createHash('sha256').update(packagesPack).digest('hex')).toBe(packagesSnapshotPackSha256);
    expect(createHash('sha256').update(packagesIndex).digest('hex')).toBe(packagesSnapshotIndexSha256);
    await writeFile(join(packagesDonor, 'objects/pack/fixture.pack'), packagesPack);
    await writeFile(join(packagesDonor, 'objects/pack/fixture.idx'), packagesIndex);
    await writeFile(
      join(packagesDonor, 'shallow'),
      `${packagesCommit}\n`,
    );
    await fixtureGit(packagesDonor, ['config', 'uploadpack.allowFilter', 'true']);
    await fixtureGit(packagesDonor, [
      'update-ref',
      'refs/heads/main',
      packagesCommit,
    ]);
    await fixtureGit(packagesDonor, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const verifiedPack = (await fixtureGit(packagesDonor, [
      'verify-pack',
      '-v',
      'objects/pack/fixture.idx',
    ])).stdout.split('\n').flatMap((line) => {
      const match = /^([0-9a-f]{40}) (blob|commit|tree) /u.exec(line);
      return match === null ? [] : [{ object: match[1]!, type: match[2]! }];
    });
    expect(verifiedPack.filter(({ type }) => type === 'commit')).toEqual([
      { object: packagesCommit, type: 'commit' },
    ]);
    expect(verifiedPack.filter(({ type }) => type === 'blob').sort((left, right) => left.object.localeCompare(right.object))).toEqual([
      { object: packagesGitignoreBlob, type: 'blob' },
      { object: packagesRustBlob, type: 'blob' },
    ].sort((left, right) => left.object.localeCompare(right.object)));
    expect(verifiedPack.filter(({ type }) => type === 'tree')).toHaveLength(2_688);
    expect((await fixtureGit(packagesDonor, [
      'show',
      `${packagesCommit}:lang/rust/Makefile`,
    ])).stdout).toBe(await readFile(rustFixture, 'utf8'));
    await writeFile(join(nestedDonor, 'nested.txt'), 'attached recursive dependency\n');
    await fixtureGit(nestedDonor, ['add', 'nested.txt']);
    await fixtureGit(nestedDonor, ['commit', '--quiet', '-m', 'nested dependency']);
    const nestedCommit = (await fixtureGit(nestedDonor, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(luciDonor, 'README'), 'fixture LuCI feed\n');
    await fixtureGit(luciDonor, ['add', 'README']);
    await fixtureGit(luciDonor, ['commit', '--quiet', '-m', 'fixture LuCI feed']);
    await fixtureGit(luciDonor, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', nestedDonor, 'deps/nested']);
    await fixtureGit(luciDonor, ['commit', '--quiet', '-am', 'attach nested dependency']);
    const luciCommit = (await fixtureGit(luciDonor, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(routingDonor, 'README'), 'fixture routing feed\n');
    await fixtureGit(routingDonor, ['add', 'README']);
    await fixtureGit(routingDonor, ['commit', '--quiet', '-m', 'fixture routing feed']);
    const routingCommit = (await fixtureGit(routingDonor, ['rev-parse', 'HEAD'])).stdout.trim();
    const feeds = [
      { name: 'packages' as const, location: 'https://git.openwrt.org/feed/packages.git', commit: packagesCommit },
      { name: 'luci' as const, location: 'https://git.openwrt.org/project/luci.git', commit: luciCommit },
      { name: 'routing' as const, location: 'https://git.openwrt.org/feed/routing.git', commit: routingCommit },
    ];
    await writeFile(join(workspace, 'feeds.conf.default'), [
      ...feeds.map((feed) => `src-git ${feed.name} ${feed.location}^${feed.commit}`),
      'src-link chirpstack feeds/chirpstack-openwrt-feed',
      '',
    ].join('\n'));
    await copyFile(join(workspace, 'feeds.conf.default'), join(repository, 'feeds.conf.default'));
    await mkdir(join(repository, 'feeds/chirpstack-openwrt-feed'), { recursive: true });
    await mkdir(join(repository, 'openwrt'), { recursive: true });
    await writeFile(join(repository, 'feeds/chirpstack-openwrt-feed/README'), 'vendored feed tree\n');
    await writeFile(join(repository, 'openwrt/README'), 'vendored OpenWrt tree\n');
    await writeFile(join(repository, '.gitmodules'), [
      '[submodule "feeds/chirpstack-openwrt-feed"]',
      '\tpath = feeds/chirpstack-openwrt-feed',
      '\turl = https://github.com/chirpstack/chirpstack-openwrt-feed.git',
      '[submodule "openwrt"]',
      '\tpath = openwrt',
      '\turl = https://github.com/openwrt/openwrt.git',
      '\tbranch = openwrt-24.10',
      '',
    ].join('\n'));
    await fixtureGit(repository, ['init', '--quiet']);
    await fixtureGit(repository, ['config', 'user.name', 'Fixture Author']);
    await fixtureGit(repository, ['config', 'user.email', 'fixture@example.test']);
    await fixtureGit(repository, ['add', '.']);
    await execFile('/usr/bin/git', ['commit', '--quiet', '-m', 'pin fixture feeds'], {
      cwd: repository,
      env: {
        ...fixtureGitEnv,
        GIT_AUTHOR_DATE: '2026-07-26T12:00:00+02:00',
        GIT_COMMITTER_DATE: '2026-07-26T12:00:00+02:00',
      },
    });
    const sourceSha = (await fixtureGit(repository, ['rev-parse', 'HEAD'])).stdout.trim();
    await fixtureGit(repository, ['remote', 'add', 'origin', 'git@github.com:Open-Smart-Irrigation/osi-os.git']);
    await fixtureGit(repository, ['update-ref', 'refs/remotes/origin/main', sourceSha]);

    const donorByUrl = new Map<string, string>([
      [feeds[0]!.location, packagesDonor],
      [feeds[1]!.location, luciDonor],
      [feeds[2]!.location, routingDonor],
    ]);
    const donorCommitByUrl = new Map<string, string>([
      [feeds[0]!.location, feeds[0]!.commit],
      [feeds[1]!.location, luciCommit],
      [feeds[2]!.location, routingCommit],
    ]);
    for (const feed of feeds) {
      expect((await fixtureGit(donorByUrl.get(feed.location)!, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
        donorCommitByUrl.get(feed.location),
      );
    }
    const feedGit = new GitCommand({
      sshAuthSock: null,
      async execFile(_executable, argv, options) {
        const environment = options.env as Readonly<Record<string, string>>;
        const workingDirectory = typeof options.cwd === 'string' && options.cwd.startsWith('/proc/')
          ? await readlink(options.cwd)
          : String(options.cwd);
        const executed = argv.map((value) => {
          const donor = donorByUrl.get(value);
          return donor === undefined ? value : `file://${donor}`;
        });
        const separator = executed.indexOf('--');
        const cloningPackages = executed[0] === 'clone' && argv.at(-2) === feeds[0]!.location;
        if (cloningPackages && separator >= 0) {
          executed.splice(separator, 0, '--filter=blob:none', '--depth=1', '--sparse');
        }
        try {
          const command = await execFile('/usr/bin/git', executed, {
            cwd: options.cwd as string | undefined,
            env: { ...environment, GIT_ALLOW_PROTOCOL: 'file' },
            timeout: options.timeout as number | undefined,
            maxBuffer: 128 * 1024,
          });
          if (argv[0] === 'clone') {
            const location = argv.at(-2)!;
            const checkout = join(options.cwd as string, argv.at(-1)!);
            if (location === feeds[0]!.location) {
              await fixtureGit(checkout, [
                'sparse-checkout',
                'set',
                '--no-cone',
                '.gitignore',
                'lang/rust/Makefile',
              ]);
            } else {
              await fixtureGit(checkout, ['remote', 'set-url', 'origin', location]);
            }
          }
          if (argv[0] === 'checkout' && workingDirectory.endsWith('/packages')) {
            await fixtureGit(
              workingDirectory,
              ['remote', 'set-url', 'origin', feeds[0]!.location],
            );
          }
          return { exitCode: 0, signal: null, stdout: command.stdout, stderr: command.stderr };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string; code?: number; signal?: string };
          return { exitCode: failure.code ?? 1, signal: failure.signal ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
        }
      },
    });
    const sourceGit = new GitCommand({
      sshAuthSock: null,
      async execFile(_executable, argv, options) {
        if (argv[0] === '-c' && argv[1] === 'core.hooksPath=/dev/null' && argv[2] === 'fetch') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        }
        try {
          const command = await execFile('/usr/bin/git', [...argv], {
            cwd: options.cwd as string | undefined,
            env: options.env as NodeJS.ProcessEnv,
            timeout: options.timeout as number | undefined,
            maxBuffer: 128 * 1024,
          });
          return { exitCode: 0, signal: null, stdout: command.stdout, stderr: command.stderr };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string; code?: number; signal?: string };
          return { exitCode: failure.code ?? 1, signal: failure.signal ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
        }
      },
    });
    const resolver = new SourceResolver({
      repositoryPath: repository,
      git: sourceGit,
      feedGit,
      now: () => '2026-07-26T10:00:00.000Z',
    });
    const sourceMetadata = await resolver.resolveAtAcceptance('main', sourceSha);
    expect(sourceMetadata.commitTime).toBe('2026-07-26T10:00:00.000Z');
    const digest = 'b'.repeat(64);
    const preflight = new PreflightService({
      loadedConfig: loaded,
      manifest: loadedManifest,
      idFactory: () => 'pf_feed_integration',
      requestId: 'req-feed-integration',
      capabilities: {
        clock: { now: () => new Date('2026-07-26T10:00:00.000Z') },
        sourceResolver: {
          resolveAtAcceptance: async () => sourceMetadata,
          prepareOfflineFeeds: (sha, stateRoot, acceptedJobId) => resolver.prepareOfflineFeeds(sha, stateRoot, acceptedJobId),
        },
        manifest: {
          inspect: (value, targetId) => ({
            sha256: value.sha256,
            target: value.manifest.targets.find((candidate) => candidate.id === targetId),
          }),
        },
        repository: { inspect: async () => ({ isGitWorktree: true }) },
        fileSystem: { statfs: async () => ({ freeBytes: 30 * 1024 ** 3 }) },
        paths: {
          inspectWorktreeFilesystem: async () => ({ path: loaded.stateRoot, canonical: true, writable: true, symlink: false, device: 1, inode: 1, mountId: 1 }),
          inspectApprovedRoot: async () => ({ path: images, canonical: true, writable: true, symlink: false, device: 1, inode: 2, mountId: 2 }),
          inspectStaging: async () => ({ path: join(images, '.osi-image-builder/staging'), canonical: true, writable: true, symlink: false, device: 1, inode: 3, mountId: 2 }),
          inspectReleasePath: async () => ({ finalExists: false, finalSymlink: false, parentWritable: true }),
        },
        executables: {
          check: async (name) => ({ path: TRUSTED_PREFLIGHT_EXECUTABLES[name], version: `${name} fixture` }),
        },
        docker: {
          inspectLockedImage: async (imageReference) => ({
            available: true,
            imageReference,
            imageDigest: digest,
            imageId: `sha256:${digest}`,
            clientVersion: '27.0.0',
            serverVersion: '27.0.0',
            architecture: 'amd64',
            os: 'linux',
          }),
        },
        systemd: { checkUserManager: async () => ({ available: true, runnerActive: false }) },
        lock: {
          read: async () => JSON.stringify({
            schemaVersion: 1,
            packageVersion: '2026.07.22.1',
            imageRepository: 'registry.osi.invalid/builder',
            imageDigest: digest,
            baseImage: `debian@sha256:${'c'.repeat(64)}`,
            baseImageDigest: 'c'.repeat(64),
            dockerfileSha256: 'd'.repeat(64),
            packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-18-dev', 'libzstd-dev'],
            rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.86.0', llvmMajor: 18 },
            nodeVersion: '22.5.0',
            executionDefinitionSha256: 'e'.repeat(64),
            validationEvidenceSha256: 'f'.repeat(64),
            installable: true,
          }),
        },
      },
    });
    const request = { branch: 'main', expectedSha: sourceSha, targetId: 'rpi-2' as const, outputRootId: 'images' };
    const checked = await preflight.run(request);
    const accepted = await preflight.accept(checked.preflightId, request, jobId);
    expect(accepted.offlineFeedPreparation.feeds.find(({ name }) => name === 'luci')?.recursiveSubmodules).toEqual([
      { path: 'deps/nested', commit: nestedCommit },
    ]);
    const database = openBuilderDatabase(join(loaded.stateRoot, 'jobs.sqlite'));
    const store = new BuilderStore(database);
    const ownership = new OwnershipStore(database);
    expect(ownership.apiWrite({
      kind: 'enqueue',
      input: {
        jobId,
        requestId: 'req-feed-integration',
        request: {
          branch: accepted.branch,
          expectedSha: accepted.expectedSha,
          targetId: accepted.target.id,
          outputRootId: accepted.outputRoot.id,
        },
        sourceRemote: accepted.source.remote,
        sourceRef: accepted.source.ref,
        sourceBranch: accepted.source.branch,
        branch: accepted.branch,
        expectedSha: accepted.expectedSha,
        pinnedSha: accepted.source.sha,
        sourcePreparation: accepted.source.sourcePreparation,
        offlineFeedPreparation: accepted.offlineFeedPreparation,
        targetId: accepted.target.id,
        rootId: accepted.outputRoot.id,
        targetManifestSha256: loadedManifest.sha256,
        sourceCommitTime: accepted.source.commitTime,
        sourceAuthor: accepted.source.author,
        sourceSubject: accepted.source.subject,
        acceptedAt: '2026-07-26T10:00:00.000Z',
      },
    })).toMatchObject({ ok: true });
    const persistedSource = store.getSourceIdentity(jobId);
    expect(persistedSource.offlineFeedPreparation).toEqual(accepted.offlineFeedPreparation);

    expect(await lstat(join(workspace, 'openwrt/feeds/packages')).catch(() => null)).toBeNull();
    const executor = createCommandExecutor();
    const calls: TargetSetupOperationId[] = [];
    const noNetworkBin = join(root, 'no-network-bin');
    await mkdir(noNetworkBin);
    for (const command of ['ssh', 'curl', 'wget']) {
      await writeFile(join(noNetworkBin, command), `#!/bin/sh\necho ${command} >> "${join(root, 'network-command.log')}"\nexit 97\n`);
      await chmod(join(noNetworkBin, command), 0o755);
    }
    const operations = createLockedTargetSetupOperations(
      async ({ operationId, definition, cwd, containerWorkingDirectory, network }) => {
        expect(network).toBe('none');
        calls.push(operationId);
        const operationEnvironment = {
          PATH: '/no-network-bin:/usr/bin:/bin',
          HOME: '/offline-home',
          LANG: 'C',
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_ALLOW_PROTOCOL: 'file',
          OSI_FIXTURE_LOG: '/workdir/operation.log',
        };
        const command = await executor.run([
          '/usr/bin/bwrap',
          '--die-with-parent',
          '--unshare-net',
          '--tmpfs', '/',
          '--ro-bind', '/usr', '/usr',
          '--symlink', 'usr/bin', '/bin',
          '--ro-bind', '/lib', '/lib',
          '--ro-bind', '/lib64', '/lib64',
          '--proc', '/proc',
          '--dev', '/dev',
          '--dir', '/workdir',
          '--bind', '.', '/workdir',
          '--dir', '/offline-home',
          '--dir', '/no-network-bin',
          '--ro-bind', noNetworkBin, '/no-network-bin',
          '--dir', '/opt',
          '--dir', '/opt/osi-image-builder',
          '--dir', '/opt/osi-image-builder/operations',
          '--ro-bind', operationTool, INTERNAL_OPERATION_TOOL_PATH,
          '--chdir', containerWorkingDirectory,
          ...definition.argv,
        ], {
          cwd,
          env: operationEnvironment,
          timeoutMs: 10_000,
          maxCaptureBytes: 64 * 1024,
        });
        expect(command, `${operationId}: ${command.stderr}`).toMatchObject({
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
        if (operationId === 'copy-feed-config') {
          expect(JSON.parse(command.stdout)).toMatchObject({
            operation: 'copy-feed-config',
            source: 'feeds.conf.default',
            destination: 'openwrt/feeds.conf.default',
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          });
        }
        return { ...command, argv: definition.argv };
      },
    );

    const evidenceWriter = createEvidenceWriter({ stateRoot: loaded.pathAuthorities.stateRoot });
    const targetSetup = await resolveTargetSetup({
      stateRoot: loaded.pathAuthorities.stateRoot,
      jobId,
      sourceSha,
      target: manifest.targets[1]!,
      targets: manifest.targets,
      preparedFeeds: persistedSource.offlineFeedPreparation,
      operations,
      evidenceWriter,
      requestId: 'req-feed-integration',
      phase: 'target-setup',
    });
    if (targetSetup.phase !== 'target-setup') throw new Error('target setup phase did not resolve');
    const targetSetupObservations = createTargetSetupSourceObservations(targetSetup);
    await evidenceWriter.write({
      jobId,
      stage: 'target-setup',
      startedAt: '2026-07-26T10:00:00.000Z',
      finishedAt: '2026-07-26T10:01:00.000Z',
      outcome: 'passed',
      operationId: null,
      commands: [],
      inputs: {},
      observations: targetSetupObservations,
      error: null,
    });
    const feedsPhase = await resolveTargetSetup({
      stateRoot: loaded.pathAuthorities.stateRoot,
      jobId,
      sourceSha,
      target: manifest.targets[1]!,
      targets: manifest.targets,
      preparedFeeds: persistedSource.offlineFeedPreparation,
      operations,
      evidenceWriter,
      requestId: 'req-feed-integration',
      phase: 'feeds',
    });
    if (feedsPhase.phase !== 'feeds') throw new Error('feeds phase did not resolve');
    const configPhase = await resolveTargetSetup({
      stateRoot: loaded.pathAuthorities.stateRoot,
      jobId,
      sourceSha,
      target: manifest.targets[1]!,
      targets: manifest.targets,
      preparedFeeds: persistedSource.offlineFeedPreparation,
      operations,
      evidenceWriter,
      requestId: 'req-feed-integration',
      phase: 'config',
      profiles: targetSetup.profiles,
    });
    if (configPhase.phase !== 'config') throw new Error('config phase did not resolve');
    const configObservations = createTargetSetupConfigObservations(configPhase);
    await evidenceWriter.write({
      jobId,
      stage: 'config',
      startedAt: '2026-07-26T10:02:00.000Z',
      finishedAt: '2026-07-26T10:03:00.000Z',
      outcome: 'passed',
      operationId: null,
      commands: [],
      inputs: {},
      observations: configObservations,
      error: null,
    });
    const verifiedConfig = await verifyTargetSetupConfiguration({
      workspace: { stateRoot: loaded.pathAuthorities.stateRoot, jobId },
      target: manifest.targets[1]!,
      targets: manifest.targets,
      config: configPhase.config,
    });

    expect(calls).toEqual([
      'activate-target', 'activate-target',
      'copy-feed-config', 'update-feeds', 'install-feeds',
      'resolve-config', 'resolve-config',
    ]);
    expect(await readFile(join(workspace, 'operation.log'), 'utf8')).toBe([
      `switch-env:${manifest.targets[0]!.environment}`,
      `switch-env:${manifest.targets[1]!.environment}`,
      'feeds:update',
      'feeds:install',
      'defconfig:DEVICE_rpi-5',
      'defconfig:DEVICE_rpi-2',
      '',
    ].join('\n'));
    expect(await readFile(join(root, 'network-command.log'), 'utf8').catch(() => '')).toBe('');
    expect(feedsPhase.feed.prepared).toHaveLength(3);
    expect(feedsPhase.rust.enforcedSha256).toBe('df5c72347a7f0d862c2cf03c9d2375f4d5de2aef4665e9aa53a37487cbaa3a33');
    expect(configPhase.config.profile).toBe('DEVICE_rpi-2');
    expect(configPhase.config.profiles['rpi-5'].resolvedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(configPhase.config.profiles['rpi-2'].resolvedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(targetSetupObservations.profiles['rpi-5']).not.toHaveProperty('resolvedSha256');
    expect(targetSetupObservations.profiles['rpi-2']).not.toHaveProperty('resolvedSha256');
    expect(JSON.parse(
      await readFile(join(loaded.stateRoot, 'jobs', jobId, 'evidence/04-target-setup.json'), 'utf8'),
    )).toMatchObject({ observations: targetSetupObservations });
    expect(JSON.parse(
      await readFile(join(loaded.stateRoot, 'jobs', jobId, 'evidence/06-config.json'), 'utf8'),
    )).toMatchObject({ observations: configObservations });
    for (const target of manifest.targets) {
      const sourceProfile = targetSetup.profiles[target.id];
      const sourceBytes = await readFile(join(
        loaded.stateRoot,
        'jobs',
        jobId,
        sourceProfile.sourceConfigEvidencePath,
      ));
      expect(sourceBytes.toString('utf8')).toBe(configFor(target));
      expect(createHash('sha256').update(sourceBytes).digest('hex')).toBe(sourceProfile.sourceSha256);
      expect(configPhase.config.profiles[target.id].sourceSha256).toBe(sourceProfile.sourceSha256);
    }
    expect(verifiedConfig.profiles['rpi-5'].sourceConfigEvidencePath).toBe('evidence/target-setup/rpi-5.source.config');
    expect(verifiedConfig.profiles['rpi-2'].sourceConfigEvidencePath).toBe('evidence/target-setup/rpi-2.source.config');
    expect(await readlink(join(workspace, 'conf/.config'))).toBe(`${manifest.targets[1]!.environment}/.config`);
    store.close();
  }, 120_000);
});
