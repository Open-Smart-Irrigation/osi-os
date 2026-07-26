import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config/load.js';
import { loadManifest } from '../../manifest/validate.js';
import { createCommandExecutor } from '../../runner/src/command-executor.js';
import { INTERNAL_OPERATION_TOOL_PATH } from '../../runner/src/operation-registry.js';
import {
  resolveTargetSetup,
  type ApiPreparedFeed,
  type LockedTargetSetupOperations,
  type TargetSetupOperationId,
} from '../../runner/src/target-setup.js';

const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;
const fixtureRoot = new URL('../fixtures/target-setup/', import.meta.url).pathname;
const rustFixture = new URL('../fixtures/openwrt-packages-d8cd30f4/lang/rust/Makefile', import.meta.url).pathname;
const rootfsFixture = new URL('../../../../openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh', import.meta.url).pathname;
const operationTool = new URL('../../builder/operations/osi-image-builder-tool.js', import.meta.url).pathname;
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

async function feedTreeSha256(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const stats = await lstat(path);
      if (stats.isDirectory()) {
        hash.update(`D\0${relativePath}\0${stats.mode & 0o777}\0`);
        await visit(path, relativePath);
      } else {
        hash.update(`F\0${relativePath}\0${stats.mode & 0o777}\0`);
        hash.update(await readFile(path));
        hash.update('\0');
      }
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

describe('feed configuration integration boundary', () => {
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
    const sourceSha = 'a'.repeat(40);
    const workspace = join(loaded.stateRoot, 'jobs', jobId, 'workspace', 'source');
    const preparedRoot = join(loaded.stateRoot, 'jobs', jobId, 'prepared-feeds');
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
    await writeFile(join(workspace, 'feeds.conf.default'), [
      'src-git packages https://git.openwrt.org/feed/packages.git^d8cd30f4e281d6853b3de134c4f147a807583e43',
      'src-git luci https://git.openwrt.org/project/luci.git^2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8',
      'src-git routing https://git.openwrt.org/feed/routing.git^c9b636698881059a3c981032770968f5a98ff201',
      'src-link chirpstack feeds/chirpstack-openwrt-feed',
      '',
    ].join('\n'));
    for (const target of manifest.targets) {
      const directory = join(workspace, 'conf', target.environment);
      await mkdir(join(directory, 'patches'), { recursive: true });
      await writeFile(join(directory, '.config'), configFor(target));
      await writeFile(join(directory, 'patches/series'), [
        'no-uart-console.patch',
        'boot-config.patch',
        ...(target.id === 'rpi-5' ? ['add_designware_spi_kmod.patch'] : []),
        'image-with-padded-rootfs.patch',
        '',
      ].join('\n'));
      await copyFile(rootfsFixture, join(directory, 'approved-rootfs.sh'));
    }

    const feeds = [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43' },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8' },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: 'c9b636698881059a3c981032770968f5a98ff201' },
    ] as const;
    const preparedFeeds: ApiPreparedFeed[] = [];
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
    for (const feed of feeds) {
      const directory = join(preparedRoot, feed.name);
      await mkdir(join(directory, '.git'), { recursive: true });
      await writeFile(join(directory, '.git/HEAD'), `${feed.commit}\n`);
      await writeFile(join(directory, '.offline-prepared'), `${feed.location}^${feed.commit}\n`);
      if (feed.name === 'packages') {
        await mkdir(join(directory, 'lang/rust'), { recursive: true });
        await copyFile(rustFixture, join(directory, 'lang/rust/Makefile'));
      }
      if (feed.name === 'luci') {
        const nested = join(root, 'nested-feed-repository');
        const recursive = join(directory, '.offline-recursive');
        await mkdir(nested);
        await fixtureGit(nested, ['init', '--quiet']);
        await fixtureGit(nested, ['config', 'user.name', 'Fixture Author']);
        await fixtureGit(nested, ['config', 'user.email', 'fixture@example.test']);
        await writeFile(join(nested, 'nested.txt'), 'nested offline object\n');
        await fixtureGit(nested, ['add', 'nested.txt']);
        await fixtureGit(nested, ['commit', '--quiet', '-m', 'nested fixture']);
        await mkdir(recursive);
        await fixtureGit(recursive, ['init', '--quiet']);
        await fixtureGit(recursive, ['config', 'user.name', 'Fixture Author']);
        await fixtureGit(recursive, ['config', 'user.email', 'fixture@example.test']);
        await writeFile(join(recursive, 'README'), 'recursive fixture\n');
        await fixtureGit(recursive, ['add', 'README']);
        await fixtureGit(recursive, ['commit', '--quiet', '-m', 'recursive fixture']);
        await fixtureGit(recursive, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', nested, 'nested']);
        await fixtureGit(recursive, ['commit', '--quiet', '-am', 'pin nested fixture']);
      }
      preparedFeeds.push({
        ...feed,
        detached: true,
        clean: true,
        treeSha256: await feedTreeSha256(directory),
        recursiveSubmodulesPrepared: true,
        recursiveSubmodules: [],
        recursiveSubmoduleStatusSha256: createHash('sha256').update('').digest('hex'),
      });
    }

    expect(await lstat(join(workspace, 'openwrt/feeds/packages')).catch(() => null)).toBeNull();
    const executor = createCommandExecutor();
    const calls: TargetSetupOperationId[] = [];
    const noNetworkBin = join(root, 'no-network-bin');
    await mkdir(noNetworkBin);
    for (const command of ['ssh', 'curl', 'wget']) {
      await writeFile(join(noNetworkBin, command), `#!/bin/sh\necho ${command} >> "${join(root, 'network-command.log')}"\nexit 97\n`);
      await chmod(join(noNetworkBin, command), 0o755);
    }
    const operations: LockedTargetSetupOperations = {
      async run(operationId, definition, workspaceCapability) {
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
          '--chdir', workspaceCapability.containerWorkingDirectory,
          ...definition.argv,
        ], {
          cwd: workspaceCapability.descriptorPath,
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
        return { ...command, argv: definition.argv, workspaceCapability };
      },
    };

    const setup = await resolveTargetSetup({
      stateRoot: loaded.pathAuthorities.stateRoot,
      jobId,
      sourceSha,
      target: manifest.targets[1]!,
      targets: manifest.targets,
      preparedFeeds: {
        schemaVersion: 1,
        boundary: 'api-prepared-pinned-feeds-v1',
        networkPolicy: 'runner-offline',
        jobId,
        sourceSha,
        preparedAt: '2026-07-26T10:00:00.000Z',
        feeds: preparedFeeds,
      },
      operations,
      requestId: 'req-feed-integration',
    });

    expect(calls).toEqual([
      'activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config',
      'activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config',
    ]);
    expect(await readFile(join(workspace, 'operation.log'), 'utf8')).toBe([
      `switch-env:${manifest.targets[0]!.environment}`,
      'feeds:update',
      'feeds:install',
      'defconfig:DEVICE_rpi-5',
      `switch-env:${manifest.targets[1]!.environment}`,
      'feeds:update',
      'feeds:install',
      'defconfig:DEVICE_rpi-2',
      '',
    ].join('\n'));
    expect(await readFile(join(root, 'network-command.log'), 'utf8').catch(() => '')).toBe('');
    expect(setup.feed.prepared).toHaveLength(3);
    expect(setup.rust.enforcedSha256).toBe('df5c72347a7f0d862c2cf03c9d2375f4d5de2aef4665e9aa53a37487cbaa3a33');
    expect(setup.config.profile).toBe('DEVICE_rpi-2');
    expect(setup.config.profiles['rpi-5'].resolvedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(setup.config.profiles['rpi-2'].resolvedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readlink(join(workspace, 'conf/.config'))).toBe(`${manifest.targets[1]!.environment}/.config`);
  });
});
