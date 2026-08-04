import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type PathAuthorityDependencies, type StateRootAuthority } from '../../config/load.js';
import { loadManifest } from '../../manifest/validate.js';
import type { TargetManifest } from '../../manifest/schema.js';
import {
  CANONICAL_MAIN_APPLIED_PATCHES,
  CANONICAL_MAIN_QUILT_FILES,
  ROOTFS_PADDING_PATCH,
  classifyTargetSetupOperationResult,
  createLockedTargetSetupOperations,
  createTargetSetupConfigObservations,
  createTargetSetupSourceObservations,
  resolveTargetSetup,
  type ApiPreparedFeed,
  type LockedTargetSetupOperations,
  type OfflineFeedPreparation,
  type TargetSetupCommandExecutor,
  type TargetSetupOperationId,
} from '../../runner/src/target-setup.js';
import type { CommandResult } from '../../runner/src/command-executor.js';
import { createEvidenceWriter } from '../../runner/src/evidence.js';
import { createOperationDefinition } from '../../runner/src/operation-registry.js';

const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;
const targets = manifest.targets;
const TARGET_LINKS = [
  ['conf/.config', (environment: string) => `${environment}/.config`],
  ['conf/files', (environment: string) => `${environment}/files`],
  ['conf/patches', (environment: string) => `${environment}/patches`],
  ['openwrt/.config', () => '../conf/.config'],
  ['openwrt/files', () => '../conf/files'],
  ['openwrt/patches', () => '../conf/patches'],
] as const;
const sourceSha = 'a'.repeat(40);
const packagesCommit = 'd8cd30f4e281d6853b3de134c4f147a807583e43';
const rustFixture = new URL('../fixtures/openwrt-packages-d8cd30f4/lang/rust/Makefile', import.meta.url).pathname;
const rootfsFixture = new URL('../../../../openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh', import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const requiredPackages = ['node-red', 'node-red-contrib-chirpstack', 'node-red-node-sqlite', 'chirpstack'] as const;

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function result(
  argv: readonly string[],
  overrides: Partial<Pick<CommandResult, 'exitCode' | 'signal' | 'stdout' | 'stderr' | 'timedOut'>> = {},
): CommandResult {
  return {
    argv,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    startedAt: '2026-07-26T10:00:00.000Z',
    finishedAt: '2026-07-26T10:00:01.000Z',
    ...overrides,
  };
}

function configFor(target: TargetManifest): string {
  return `${target.configSymbols.map((symbol) => {
    if (symbol.type === 'bool') return symbol.value ? `${symbol.name}=y` : `# ${symbol.name} is not set`;
    if (symbol.type === 'string') return `${symbol.name}="${symbol.value}"`;
    return `${symbol.name}=${symbol.value}`;
  }).join('\n')}\n`;
}

async function feedTreeSha256(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const stats = await lstat(path);
      if (stats.isDirectory()) {
        hash.update(`D\0${relativePath}\0${stats.mode & 0o777}\0`);
        await visit(path, relativePath);
      } else if (stats.isFile()) {
        hash.update(`F\0${relativePath}\0${stats.mode & 0o777}\0`);
        hash.update(await readFile(path));
        hash.update('\0');
      } else if (stats.isSymbolicLink()) {
        hash.update(`L\0${relativePath}\0${await readlink(path)}\0`);
      } else {
        throw new Error(`unsupported fixture entry: ${path}`);
      }
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

interface Fixture {
  readonly root: string;
  readonly statePath: string;
  readonly stateRoot: StateRootAuthority;
  readonly jobId: string;
  readonly sourceSha: string;
  readonly workspace: string;
  readonly preparedRoot: string;
  readonly preparedFeeds: OfflineFeedPreparation;
}

async function authorityFixture(pathAuthorityDependencies?: Partial<PathAuthorityDependencies>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'osi-target-setup-'));
  temporaryDirectories.push(root);
  const configHome = join(root, 'config');
  const repositoryPath = join(root, 'repository');
  await mkdir(configHome, { recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(join(root, 'images'), { recursive: true });
  const configPath = join(configHome, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [{ id: 'images', label: 'images', path: join(root, 'images') }],
    builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath,
    env: { HOME: root, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(root, 'state-home') },
    git: { getOriginPolicy: async () => ({ url: 'git@github.com:Open-Smart-Irrigation/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    pathAuthorityDependencies,
  });
  const jobId = 'job-target-15';
  const workspace = join(loaded.stateRoot, 'jobs', jobId, 'workspace', 'source');
  const preparedRoot = join(loaded.stateRoot, 'jobs', jobId, 'prepared-feeds');
  await mkdir(join(workspace, 'openwrt'), { recursive: true });
  await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/apps/node-red'), { recursive: true });
  await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/apps/node-red-contrib-chirpstack'), { recursive: true });
  await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/apps/node-red-node-sqlite'), { recursive: true });
  await mkdir(join(workspace, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack'), { recursive: true });
  await writeFile(join(workspace, 'feeds.conf.default'), [
    `src-git packages https://git.openwrt.org/feed/packages.git^${packagesCommit}`,
    'src-git luci https://git.openwrt.org/project/luci.git^2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8',
    'src-git routing https://git.openwrt.org/feed/routing.git^c9b636698881059a3c981032770968f5a98ff201',
    'src-link chirpstack feeds/chirpstack-openwrt-feed',
    '',
  ].join('\n'));
  for (const target of targets) {
    await mkdir(join(workspace, 'conf', target.environment, 'files'), { recursive: true });
    await mkdir(join(workspace, 'conf', target.environment, 'patches'), { recursive: true });
    await writeFile(join(workspace, 'conf', target.environment, '.config'), configFor(target));
    await writeFile(join(workspace, 'conf', target.environment, 'patches', 'series'), [
      'no-uart-console.patch',
      'boot-config.patch',
      ...(target.id === 'rpi-5' ? ['add_designware_spi_kmod.patch'] : []),
      ROOTFS_PADDING_PATCH,
      '',
    ].join('\n'));
  }
  await mkdir(join(workspace, 'openwrt/.pc'), { recursive: true });
  await writeFile(join(workspace, 'openwrt/.pc/.quilt_patches'), CANONICAL_MAIN_QUILT_FILES.patches);
  await writeFile(join(workspace, 'openwrt/.pc/.quilt_series'), CANONICAL_MAIN_QUILT_FILES.series);
  await writeFile(join(workspace, 'openwrt/.pc/.version'), CANONICAL_MAIN_QUILT_FILES.version);
  await writeFile(join(workspace, 'openwrt/.pc/applied-patches'), CANONICAL_MAIN_APPLIED_PATCHES);
  await mkdir(join(workspace, 'openwrt/target/linux/bcm27xx/image'), { recursive: true });
  await copyFile(rootfsFixture, join(workspace, 'openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh'));

  const feedSources = [
    { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: packagesCommit },
    { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8' },
    { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: 'c9b636698881059a3c981032770968f5a98ff201' },
  ] as const;
  const prepared: ApiPreparedFeed[] = [];
  for (const feed of feedSources) {
    const directory = join(preparedRoot, feed.name);
    await mkdir(join(directory, '.git'), { recursive: true });
    await writeFile(join(directory, '.git', 'HEAD'), `${feed.commit}\n`);
    if (feed.name === 'packages') {
      await mkdir(join(directory, 'lang/rust'), { recursive: true });
      await copyFile(rustFixture, join(directory, 'lang/rust/Makefile'));
    } else {
      await writeFile(join(directory, 'fixture.txt'), `${feed.name}\n`);
    }
    prepared.push({
      name: feed.name,
      location: feed.location,
      commit: feed.commit,
      detached: true,
      clean: true,
      treeSha256: await feedTreeSha256(directory),
      recursiveSubmodulesPrepared: true,
      recursiveSubmodules: [],
      recursiveSubmoduleStatusSha256: sha256(''),
    });
  }
  return {
    root,
    statePath: loaded.stateRoot,
    stateRoot: loaded.pathAuthorities.stateRoot,
    jobId,
    sourceSha,
    workspace,
    preparedRoot,
    preparedFeeds: {
      schemaVersion: 1,
      boundary: 'api-prepared-pinned-feeds-v1',
      networkPolicy: 'runner-offline',
      jobId,
      sourceSha,
      preparedAt: '2026-07-26T10:00:00.000Z',
      feeds: prepared,
    },
  };
}

interface OperationsOptions {
  readonly commandFailure?: { readonly operation: TargetSetupOperationId; readonly result: CommandResult };
  readonly corruptCopy?: boolean;
  readonly copyOutputOverride?: string;
  readonly missingLink?: string;
  readonly wrongLink?: string;
  readonly sourceConfigOverride?: Readonly<Partial<Record<TargetManifest['id'], string>>>;
  readonly resolvedConfigOverride?: Readonly<Partial<Record<TargetManifest['id'], string>>>;
  readonly mutateRustAfter?: 'update-feeds' | 'install-feeds';
  readonly mutateFeedAfter?: {
    readonly operation: 'update-feeds' | 'install-feeds';
    readonly name: 'luci' | 'routing';
  };
  readonly afterOperation?: (operationId: TargetSetupOperationId) => Promise<void>;
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function operations(fixture: Fixture, options: OperationsOptions = {}): {
  readonly runner: LockedTargetSetupOperations;
  readonly execute: TargetSetupCommandExecutor;
  readonly calls: Array<{ readonly operationId: TargetSetupOperationId; readonly argv: readonly string[]; readonly environment: string }>;
} {
  const calls: Array<{ operationId: TargetSetupOperationId; argv: readonly string[]; environment: string }> = [];
  let activeTarget = targets[0]!;
  const execute: TargetSetupCommandExecutor = async ({ operationId, definition, cwd: workspace }) => {
      const environment = operationId === 'activate-target'
        ? definition.argv[3]!
        : activeTarget.environment;
      calls.push({ operationId, argv: definition.argv, environment });
      if (options.commandFailure?.operation === operationId) return options.commandFailure.result;
      let command = result(definition.argv);
      if (operationId === 'activate-target') {
        activeTarget = targets.find((target) => target.environment === environment)!;
        for (const path of ['conf/.config', 'conf/files', 'conf/patches', 'openwrt/.config', 'openwrt/files', 'openwrt/patches']) {
          await removeIfPresent(join(workspace, path));
        }
        await symlink(`${environment}/.config`, join(workspace, 'conf/.config'));
        await symlink(`${environment}/files`, join(workspace, 'conf/files'));
        await symlink(`${environment}/patches`, join(workspace, 'conf/patches'));
        await symlink('../conf/.config', join(workspace, 'openwrt/.config'));
        await symlink('../conf/files', join(workspace, 'openwrt/files'));
        await symlink('../conf/patches', join(workspace, 'openwrt/patches'));
        const sourceOverride = options.sourceConfigOverride?.[activeTarget.id];
        if (sourceOverride !== undefined) await writeFile(join(workspace, 'conf', activeTarget.environment, '.config'), sourceOverride);
        command = result(definition.argv, {
          stdout: `${JSON.stringify({ operation: 'activate-target', environment })}\n`,
        });
      }
      if (operationId === 'copy-feed-config') {
        const source = await readFile(join(workspace, 'feeds.conf.default'), 'utf8');
        const destination = source.replace('src-link chirpstack feeds/chirpstack-openwrt-feed', 'src-link chirpstack ../../feeds/chirpstack-openwrt-feed');
        await writeFile(join(workspace, 'openwrt/feeds.conf.default'), destination);
        command = result(definition.argv, {
          stdout: options.copyOutputOverride ?? `${JSON.stringify({
            operation: 'copy-feed-config',
            source: 'feeds.conf.default',
            destination: 'openwrt/feeds.conf.default',
            sha256: sha256(source),
            sourceSha256: sha256(source),
            destinationSha256: sha256(destination),
          })}\n`,
        });
        if (options.corruptCopy) await writeFile(join(workspace, 'openwrt/feeds.conf.default'), 'changed\n');
      }
      if (operationId === 'update-feeds') {
        await symlink('../../feeds/chirpstack-openwrt-feed', join(workspace, 'openwrt/feeds/chirpstack'));
        if (options.mutateRustAfter === operationId) await writeFile(join(workspace, 'openwrt/feeds/packages/lang/rust/Makefile'), 'changed\n');
        if (options.mutateFeedAfter?.operation === operationId) {
          await writeFile(join(workspace, 'openwrt/feeds', options.mutateFeedAfter.name, 'fixture.txt'), 'changed\n');
        }
      }
      if (operationId === 'install-feeds') {
        const parent = join(workspace, 'openwrt/package/feeds/chirpstack');
        await mkdir(parent, { recursive: true });
        for (const packageName of requiredPackages) {
          if (options.missingLink === packageName) continue;
          const targetPath = packageName === 'chirpstack'
            ? '../../../feeds/chirpstack/chirpstack/chirpstack'
            : `../../../feeds/chirpstack/apps/${packageName}`;
          await symlink(options.wrongLink === packageName ? '../../../feeds/chirpstack/apps/node-red' : targetPath, join(parent, packageName));
        }
        if (options.mutateRustAfter === operationId) await writeFile(join(workspace, 'openwrt/feeds/packages/lang/rust/Makefile'), 'changed\n');
        if (options.mutateFeedAfter?.operation === operationId) {
          await writeFile(join(workspace, 'openwrt/feeds', options.mutateFeedAfter.name, 'fixture.txt'), 'changed\n');
        }
      }
      if (operationId === 'resolve-config') {
        const activeConfig = await readlink(join(workspace, 'conf/.config'));
        activeTarget = targets.find((target) => (
          activeConfig === `${target.environment}/.config`
        ))!;
        const resolved = options.resolvedConfigOverride?.[activeTarget.id] ?? configFor(activeTarget);
        await writeFile(join(workspace, 'openwrt/.config'), resolved);
      }
      await options.afterOperation?.(operationId);
      return command;
  };
  const runner = createLockedTargetSetupOperations(execute);
  return { runner, execute, calls };
}

function input(fixture: Fixture, runner: LockedTargetSetupOperations, target = targets[0]!) {
  return {
    stateRoot: fixture.stateRoot,
    jobId: fixture.jobId,
    sourceSha: fixture.sourceSha,
    target,
    targets,
    preparedFeeds: fixture.preparedFeeds,
    operations: runner,
    evidenceWriter: createEvidenceWriter({ stateRoot: fixture.stateRoot }),
    requestId: 'req-target-setup',
  } as const;
}

describe('target setup', () => {
  it('derives the workspace, prepares every pinned feed offline, resolves both profiles, and restores the selected profile', async () => {
    const fixture = await authorityFixture();
    expect(await lstat(join(fixture.workspace, 'openwrt/feeds')).catch(() => null)).toBeNull();
    const { runner, calls } = operations(fixture);

    const setup = await resolveTargetSetup(input(fixture, runner));

    expect(setup.workspacePath).toBe(fixture.workspace);
    expect(calls.map((call) => call.operationId)).toEqual([
      'activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config',
    ]);
    expect(calls.filter((call) => call.operationId === 'activate-target').map((call) => call.environment))
      .toEqual([targets[0]!.environment]);
    expect(setup.feed.sourceSha256).not.toBe(setup.feed.destinationSha256);
    expect(setup.feed.prepared.map((feed) => feed.name)).toEqual(['packages', 'luci', 'routing']);
    expect(setup.rust).toMatchObject({ sourceCommit: packagesCommit, hostTriple: 'x86_64-unknown-linux-gnu' });
    expect(setup.config.profiles['rpi-5']).toMatchObject({ profile: 'DEVICE_rpi-5', rootfsPartSize: 14336 });
    expect(setup.config.profiles['rpi-2']).toMatchObject({ profile: 'DEVICE_rpi-2', rootfsPartSize: 14336 });
    expect(setup.config.profiles['rpi-5'].sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(setup.config.profiles['rpi-2'].resolvedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readlink(join(fixture.workspace, 'conf/.config'))).toBe(`${targets[0]!.environment}/.config`);
    expect(await readFile(join(fixture.workspace, 'openwrt/feeds/packages/lang/rust/Makefile'), 'utf8')).toContain('download-ci-llvm=false');
  });

  it('derives a destination for source-parser-compatible whitespace and CRLF', async () => {
    const fixture = await authorityFixture();
    const source = (await readFile(join(fixture.workspace, 'feeds.conf.default'), 'utf8'))
      .replace('src-link chirpstack feeds/chirpstack-openwrt-feed\n', '  src-link chirpstack feeds/chirpstack-openwrt-feed  \r\n')
      .replaceAll('\n', '\r\n')
      .replace('\r\r\n', '\r\n');
    await writeFile(join(fixture.workspace, 'feeds.conf.default'), source);
    const { runner } = operations(fixture);

    await expect(resolveTargetSetup(input(fixture, runner))).resolves.toMatchObject({ target: 'rpi-5' });
    expect(await readFile(join(fixture.workspace, 'openwrt/feeds.conf.default'), 'utf8'))
      .toContain('  src-link chirpstack ../../feeds/chirpstack-openwrt-feed  \r\n');
  });

  it('rejects invalid UTF-8 in the pinned feed configuration', async () => {
    const fixture = await authorityFixture();
    await writeFile(join(fixture.workspace, 'feeds.conf.default'), Buffer.concat([
      await readFile(join(fixture.workspace, 'feeds.conf.default')),
      Buffer.from('# '),
      Buffer.from([0xff]),
      Buffer.from('\n'),
    ]));
    const { runner } = operations(fixture);

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
  });

  it('rejects copy-feed-config output whose hashes do not attest the observed source and destination', async () => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, {
      copyOutputOverride: `${JSON.stringify({
        operation: 'copy-feed-config',
        source: 'feeds.conf.default',
        destination: 'openwrt/feeds.conf.default',
        sha256: '0'.repeat(64),
        sourceSha256: '0'.repeat(64),
        destinationSha256: '0'.repeat(64),
      })}\n`,
    });

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({
      code: 'FEED_INSTALL_FAILED',
      operationId: 'copy-feed-config',
    });
  });

  it('rejects mismatched copy-feed-config hashes in the phased feeds path', async () => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, {
      copyOutputOverride: `${JSON.stringify({
        operation: 'copy-feed-config',
        source: 'feeds.conf.default',
        destination: 'openwrt/feeds.conf.default',
        sha256: '0'.repeat(64),
        sourceSha256: '0'.repeat(64),
        destinationSha256: '0'.repeat(64),
      })}\n`,
    });
    await resolveTargetSetup({ ...input(fixture, runner), phase: 'target-setup' });

    await expect(resolveTargetSetup({ ...input(fixture, runner), phase: 'feeds' })).rejects.toMatchObject({
      code: 'FEED_INSTALL_FAILED',
      operationId: 'copy-feed-config',
    });
  });

  it('preserves a UTF-8 BOM before a first-line canonical ChirpStack entry', async () => {
    const fixture = await authorityFixture();
    const lines = (await readFile(join(fixture.workspace, 'feeds.conf.default'), 'utf8'))
      .trimEnd()
      .split('\n');
    const chirpstack = lines.find((line) => line.startsWith('src-link chirpstack '))!;
    const source = `\uFEFF${chirpstack}\n${lines.filter((line) => line !== chirpstack).join('\n')}\n`;
    await writeFile(join(fixture.workspace, 'feeds.conf.default'), source);
    const { runner } = operations(fixture);

    await expect(resolveTargetSetup(input(fixture, runner))).resolves.toMatchObject({ target: 'rpi-5' });
    expect(await readFile(join(fixture.workspace, 'openwrt/feeds.conf.default'), 'utf8'))
      .toMatch(/^\uFEFFsrc-link chirpstack \.\.\/\.\.\/feeds\/chirpstack-openwrt-feed/u);
  });

  it('executes activation, feed, and both-profile config mutations in separate phases', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);

    const targetSetup = await resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'target-setup',
    });
    if (targetSetup.phase !== 'target-setup') throw new Error('unexpected target setup phase');
    expect(calls.map(({ operationId }) => operationId)).toEqual(['activate-target']);

    const feeds = await resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'feeds',
    });
    if (feeds.phase !== 'feeds') throw new Error('unexpected feeds phase');
    expect(calls.map(({ operationId }) => operationId)).toEqual([
      'activate-target',
      'copy-feed-config',
      'update-feeds',
      'install-feeds',
    ]);

    const config = await resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'config',
      profiles: targetSetup.profiles,
    });
    if (config.phase !== 'config') throw new Error('unexpected config phase');
    expect(calls.map(({ operationId }) => operationId)).toEqual([
      'activate-target',
      'copy-feed-config',
      'update-feeds',
      'install-feeds',
      'resolve-config',
    ]);
    expect(feeds.feed.sourceSha256).not.toBe(feeds.feed.destinationSha256);
    expect(config.config).toMatchObject({
      bothProfilesChecked: true,
      selectedTarget: targets[0]!.openwrtTarget,
      profile: targets[0]!.profile,
    });
    const sourceObservations = createTargetSetupSourceObservations(targetSetup);
    const configObservations = createTargetSetupConfigObservations(config);
    expect(targetSetup.profiles['rpi-5']).not.toHaveProperty('resolvedSha256');
    expect(sourceObservations.profiles['rpi-5']).toEqual({
      target: 'rpi-5',
      environment: targets[0]!.environment,
      selectedTarget: targets[0]!.openwrtTarget,
      profile: targets[0]!.profile,
      rootfsPartSize: targets[0]!.rootfsPartSize,
      sourceSha256: targetSetup.profiles['rpi-5'].sourceSha256,
      sourceConfigEvidencePath: 'evidence/target-setup/rpi-5.source.config',
    });
    expect(Object.keys(sourceObservations.profiles['rpi-5']).sort()).toEqual([
      'environment',
      'profile',
      'rootfsPartSize',
      'selectedTarget',
      'sourceConfigEvidencePath',
      'sourceSha256',
      'target',
    ]);
    expect(configObservations.config.profiles['rpi-5']).toEqual({
      target: 'rpi-5',
      environment: targets[0]!.environment,
      selectedTarget: targets[0]!.openwrtTarget,
      profile: targets[0]!.profile,
      rootfsPartSize: targets[0]!.rootfsPartSize,
      resolvedSha256: config.config.profiles['rpi-5'].resolvedSha256,
    });
    expect(Object.keys(configObservations.config.profiles['rpi-5']).sort()).toEqual([
      'environment',
      'profile',
      'resolvedSha256',
      'rootfsPartSize',
      'selectedTarget',
      'target',
    ]);
    expect(await readlink(join(fixture.workspace, 'conf/.config')))
      .toBe(`${targets[0]!.environment}/.config`);
  });

  it('activates only the selected profile and leaves its links unchanged during config resolution', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);

    const targetSetup = await resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'target-setup',
    });
    if (targetSetup.phase !== 'target-setup') throw new Error('unexpected target setup phase');
    expect(calls.filter(({ operationId }) => operationId === 'activate-target').map(({ environment }) => environment))
      .toEqual([targets[0]!.environment]);

    calls.splice(0);
    await expect(resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'config',
      profiles: targetSetup.profiles,
    })).resolves.toMatchObject({ phase: 'config' });
    expect(calls.map(({ operationId }) => operationId)).toEqual(['resolve-config']);
    expect(await readlink(join(fixture.workspace, 'conf/.config')))
      .toBe(`${targets[0]!.environment}/.config`);
  });

  it('does not delete a regular active link when config-stage verification rejects it', async () => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture);
    const targetSetup = await resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'target-setup',
    });
    if (targetSetup.phase !== 'target-setup') throw new Error('unexpected target setup phase');
    const path = join(fixture.workspace, 'conf/.config');
    await rm(path);
    await writeFile(path, 'raced regular file\n');

    await expect(resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'config',
      profiles: targetSetup.profiles,
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    expect(await readFile(path, 'utf8')).toBe('raced regular file\n');
  });

  it('removes only held builder feed entries left by a crash before resolving both profiles', async () => {
    const fixture = await authorityFixture();
    await mkdir(join(fixture.workspace, 'openwrt/feeds/packages/partial'), { recursive: true });
    await writeFile(join(fixture.workspace, 'openwrt/feeds/packages/partial/object'), 'interrupted copy\n');
    await mkdir(join(fixture.workspace, 'openwrt/package/feeds/chirpstack'), { recursive: true });
    await writeFile(join(fixture.workspace, 'openwrt/package/feeds/chirpstack/partial'), 'interrupted install\n');
    await writeFile(join(fixture.workspace, 'openwrt/not-builder-created'), 'preserve\n');
    const { runner } = operations(fixture);

    await expect(resolveTargetSetup(input(fixture, runner))).resolves.toMatchObject({
      config: { bothProfilesChecked: true },
    });

    expect(await readFile(join(fixture.workspace, 'openwrt/not-builder-created'), 'utf8')).toBe('preserve\n');
    expect(await lstat(join(fixture.workspace, 'openwrt/feeds/packages/partial')).catch(() => null)).toBeNull();
    expect(await lstat(join(fixture.workspace, 'openwrt/package/feeds/chirpstack/partial')).catch(() => null)).toBeNull();
  });

  it.each([
    ['openwrt feeds', ['feeds']],
    ['OpenWrt package ancestor', ['package']],
    ['installed package feeds', ['package', 'feeds']],
  ] as const)('refuses a symlink substituted for %s during cleanup', async (_case, path) => {
    const fixture = await authorityFixture();
    const external = join(fixture.root, 'external-cleanup');
    await mkdir(external);
    const parent = join(fixture.workspace, 'openwrt', ...path.slice(0, -1));
    await mkdir(parent, { recursive: true });
    await symlink(external, join(parent, path.at(-1)!));
    const { runner, calls } = operations(fixture);

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({
      code: 'FEED_INSTALL_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('publishes exact source config bytes for both profiles before resolution', async () => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, {
      resolvedConfigOverride: {
        'rpi-5': `${configFor(targets[0]!)}# resolved\n`,
        'rpi-2': `${configFor(targets[1]!)}# resolved\n`,
      },
    });

    const setup = await resolveTargetSetup(input(fixture, runner));

    for (const target of targets) {
      const bytes = await readFile(join(
        fixture.statePath,
        'jobs',
        fixture.jobId,
        'evidence',
        'target-setup',
        `${target.id}.source.config`,
      ));
      expect(bytes.toString('utf8')).toBe(configFor(target));
      expect(setup.config.profiles[target.id].sourceSha256).toBe(sha256(bytes));
    }
  });

  it.each([
    ['label', { ...targets[0]!, label: 'Changed' }],
    ['nested config symbol', { ...targets[0]!, configSymbols: [{ ...targets[0]!.configSymbols[0]!, value: false }, ...targets[0]!.configSymbols.slice(1)] }],
    ['operation list', { ...targets[0]!, operations: targets[0]!.operations.slice(1) }],
  ])('rejects a selected target whose %s differs from the validated manifest entry', async (_field, selected) => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup(input(fixture, runner, selected as TargetManifest))).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    expect(calls).toEqual([]);
  });

  it('rejects duplicate manifest target IDs before invoking operations', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), targets: [targets[0]!, targets[0]!] })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    expect(calls).toEqual([]);
  });

  const operationFailures = (['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config'] as const)
    .flatMap((operationId) => [
      [operationId, 'non-zero exit', { exitCode: 1 }],
      [operationId, 'signal', { signal: 'SIGTERM' as NodeJS.Signals }],
      [operationId, 'timeout', { timedOut: true }],
      [operationId, 'argv mismatch', { argv: ['wrong-command'] }],
    ] as const);

  it.each(operationFailures)('rejects %s operation success evidence with %s', async (operationId, _case, changed) => {
    const fixture = await authorityFixture();
    const expected = createOperationDefinition(operationId, { environment: targets[1]!.environment }).argv;
    const failed = result('argv' in changed ? changed.argv : expected, 'argv' in changed ? {} : changed);
    const { runner } = operations(fixture, { commandFailure: { operation: operationId, result: failed } });
    const code = operationId === 'activate-target'
      ? 'PATCH_STATE_AMBIGUOUS'
      : operationId === 'resolve-config'
        ? 'TARGET_CONFIG_MISMATCH'
        : 'FEED_INSTALL_FAILED';
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code, operationId });
  });

  it('rejects a caller-forged operation adapter before invoking it', async () => {
    const fixture = await authorityFixture();
    let invoked = false;
    const runner: LockedTargetSetupOperations = {
      async run(_operationId, definition) {
        invoked = true;
        return result(definition.argv);
      },
    };
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({
      code: 'WORKTREE_CREATE_FAILED',
    });
    expect(invoked).toBe(false);
  });

  it('classifies the exact immutable activation-tool result', () => {
    const definition = createOperationDefinition('activate-target', {
      environment: targets[0]!.environment,
    });
    const command = result(definition.argv, {
      stdout: `${JSON.stringify({ operation: 'activate-target', environment: targets[0]!.environment })}\n`,
    });

    expect(classifyTargetSetupOperationResult('activate-target', definition, command)).toEqual({
      disposition: 'passed',
      command,
    });
  });

  it('rejects every non-zero legacy switch-env result', () => {
    const definition = createOperationDefinition('activate-target', {
      environment: targets[0]!.environment,
    });
    const legacyResult = result(definition.argv, {
      exitCode: 2,
      stdout: 'legacy switch-env transcript\n',
      stderr: 'make: *** [Makefile:60: switch-env] Error 1\n',
    });

    expect(() => classifyTargetSetupOperationResult('activate-target', definition, legacyResult))
      .toThrowError(expect.objectContaining({ code: 'PATCH_STATE_AMBIGUOUS' }));
  });

  it('rejects arbitrary output from an exit-zero activate-target command', () => {
    const definition = createOperationDefinition('activate-target', {
      environment: targets[0]!.environment,
    });

    expect(() => classifyTargetSetupOperationResult('activate-target', definition, result(
      definition.argv,
      {
        stdout: 'branch-controlled output\n',
        stderr: '',
      },
    ))).toThrowError(expect.objectContaining({ code: 'PATCH_STATE_AMBIGUOUS' }));
  });

  it('rejects arbitrary output from an exit-zero copy-feed-config command', () => {
    const definition = createOperationDefinition('copy-feed-config', {
      environment: targets[0]!.environment,
    });

    expect(() => classifyTargetSetupOperationResult('copy-feed-config', definition, result(
      definition.argv,
      { stdout: 'branch-controlled output\n' },
    ))).toThrowError(expect.objectContaining({ code: 'FEED_INSTALL_FAILED' }));
  });

  it('profiles Pi 4 before Pi 5 while retaining the canonical main patch state', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);

    const setup = await resolveTargetSetup(input(fixture, runner));

    expect(calls.filter((call) => call.operationId === 'activate-target').map((call) => call.environment))
      .toEqual([targets[0]!.environment]);
    expect(setup.patchDecision).toBe('applied');
    expect(setup.config.profiles['rpi-5'].patchDecision).toBe('applied');
    expect(setup.config.profiles['rpi-2'].patchDecision).toBe('applied');
    for (const [path, expected] of TARGET_LINKS) {
      expect(await readlink(join(fixture.workspace, path)), path).toBe(expected(targets[0]!.environment));
    }
    expect(await readFile(join(fixture.workspace, 'openwrt/.pc/applied-patches'), 'utf8')).toBe(CANONICAL_MAIN_APPLIED_PATCHES);
  });

  it.each(TARGET_LINKS)('rejects mutation of %s immediately after activation', async (path) => {
    const fixture = await authorityFixture();
    let mutated = false;
    const { runner } = operations(fixture, {
      async afterOperation(operationId) {
        if (mutated || operationId !== 'activate-target') return;
        mutated = true;
        await rm(join(fixture.workspace, path));
        await symlink('wrong-profile-target', join(fixture.workspace, path));
      },
    });

    await expect(resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'target-setup',
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    expect(mutated).toBe(true);
  });

  it.each(TARGET_LINKS)('rejects mutation of %s at the feeds stage boundary', async (path) => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture);
    const targetSetup = await resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'target-setup',
    });
    await rm(join(fixture.workspace, path));
    await symlink('wrong-profile-target', join(fixture.workspace, path));

    await expect(resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'feeds',
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    expect(targetSetup.phase).toBe('target-setup');
  });

  it.each(TARGET_LINKS)('rejects mutation of %s at the config stage boundary', async (path) => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture);
    const targetSetup = await resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'target-setup',
    });
    if (targetSetup.phase !== 'target-setup') throw new Error('unexpected target setup phase');
    await rm(join(fixture.workspace, path));
    await symlink('wrong-profile-target', join(fixture.workspace, path));

    await expect(resolveTargetSetup({
      ...input(fixture, runner),
      phase: 'config',
      profiles: targetSetup.profiles,
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
  });

  it.each([
    ['malformed Quilt series metadata', async (fixture: Fixture) => {
      await writeFile(join(fixture.workspace, 'openwrt/.pc/.quilt_series'), '../series\n');
    }],
    ['symlinked applied patch metadata', async (fixture: Fixture) => {
      const applied = join(fixture.workspace, 'openwrt/.pc/applied-patches');
      const held = join(fixture.workspace, 'openwrt/.pc/applied-patches.held');
      await rename(applied, held);
      await symlink(held, applied);
    }],
    ['directory applied patch metadata', async (fixture: Fixture) => {
      const applied = join(fixture.workspace, 'openwrt/.pc/applied-patches');
      await rm(applied);
      await mkdir(applied);
    }],
  ] as const)('rejects %s', async (_case, mutate) => {
    const fixture = await authorityFixture();
    let mutated = false;
    const { runner } = operations(fixture, {
      async afterOperation(operationId) {
        if (mutated || operationId !== 'activate-target') return;
        mutated = true;
        await mutate(fixture);
      },
    });

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({
      code: 'PATCH_STATE_AMBIGUOUS',
    });
    expect(mutated).toBe(true);
  });

  it('rejects replacement of the canonical profile series after opening its descriptor', async () => {
    let fixture: Fixture;
    let swapped = false;
    fixture = await authorityFixture({
      async beforeRead(handle) {
        const path = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!swapped && path.endsWith(`/conf/${targets[0]!.environment}/patches/series`)) {
          swapped = true;
          await rename(path, `${path}.held`);
          await writeFile(path, `${ROOTFS_PADDING_PATCH}\n`);
        }
      },
    });
    const { runner } = operations(fixture);

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({
      code: 'PATCH_STATE_AMBIGUOUS',
    });
    expect(swapped).toBe(true);
  });

  it('rejects an altered applied-patches file after immutable activation', async () => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, {
      async afterOperation(operationId) {
        if (operationId === 'activate-target') {
          await writeFile(join(fixture.workspace, 'openwrt/.pc/applied-patches'), `${ROOTFS_PADDING_PATCH}\n`);
        }
      },
    });

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({
      code: 'PATCH_STATE_AMBIGUOUS',
    });
  });

  it('accepts ordinary Git checkout filenames while retaining no-follow traversal', async () => {
    const fixture = await authorityFixture();
    const luciDirectory = join(fixture.preparedRoot, 'luci');
    await writeFile(join(luciDirectory, 'file with + sign.txt'), 'valid Git filename\n');
    const treeSha256 = await feedTreeSha256(luciDirectory);
    const preparedFeeds = {
      ...fixture.preparedFeeds,
      feeds: fixture.preparedFeeds.feeds.map((feed) => feed.name === 'luci' ? { ...feed, treeSha256 } : feed),
    };
    const { runner } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), preparedFeeds })).resolves.toMatchObject({ target: 'rpi-5' });
  });

  it('rejects a prepared checkout whose held HEAD differs from the attested commit', async () => {
    const fixture = await authorityFixture();
    const luciDirectory = join(fixture.preparedRoot, 'luci');
    await writeFile(join(luciDirectory, '.git/HEAD'), `${'f'.repeat(40)}\n`);
    const treeSha256 = await feedTreeSha256(luciDirectory);
    const preparedFeeds = {
      ...fixture.preparedFeeds,
      feeds: fixture.preparedFeeds.feeds.map((feed) => feed.name === 'luci' ? { ...feed, treeSha256 } : feed),
    };
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), preparedFeeds })).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(calls).toEqual([]);
  });

  it('rejects a preparation handoff that omits one pinned Git feed', async () => {
    const fixture = await authorityFixture();
    const preparedFeeds = { ...fixture.preparedFeeds, feeds: fixture.preparedFeeds.feeds.filter((feed) => feed.name !== 'routing') };
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), preparedFeeds })).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['job ID', { jobId: 'job-other' }],
    ['source SHA', { sourceSha: 'f'.repeat(40) }],
  ])('rejects an offline preparation attestation bound to another %s', async (_case, changed) => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({
      ...input(fixture, runner),
      preparedFeeds: { ...fixture.preparedFeeds, ...changed },
    })).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['attached checkout', (feed: ApiPreparedFeed) => ({ ...feed, detached: false })],
    ['dirty checkout', (feed: ApiPreparedFeed) => ({ ...feed, clean: false })],
    ['unprepared recursion', (feed: ApiPreparedFeed) => ({ ...feed, recursiveSubmodulesPrepared: false })],
    ['unbound recursion digest', (feed: ApiPreparedFeed) => ({ ...feed, recursiveSubmoduleStatusSha256: 'f'.repeat(64) })],
    ['escaping submodule path', (feed: ApiPreparedFeed) => ({
      ...feed,
      recursiveSubmodules: [{ path: '../escape', commit: 'e'.repeat(40) }],
      recursiveSubmoduleStatusSha256: sha256(`e${'e'.repeat(39)}\0../escape\n`),
    })],
  ])('rejects a prepared feed with %s attestation', async (_case, change) => {
    const fixture = await authorityFixture();
    const preparedFeeds = {
      ...fixture.preparedFeeds,
      feeds: fixture.preparedFeeds.feeds.map((feed, index) => index === 1 ? change(feed) : feed),
    } as OfflineFeedPreparation;
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), preparedFeeds })).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(calls).toEqual([]);
  });

  it('rejects a missing API-prepared packages feed before operations', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);
    await rm(join(fixture.preparedRoot, 'packages'), { recursive: true });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it('rejects an API-prepared feed tree hash mismatch before operations', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);
    await writeFile(join(fixture.preparedRoot, 'luci', 'fixture.txt'), 'tampered\n');
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(calls).toEqual([]);
  });

  it('rejects a prepared feed directory symlink escape', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);
    const external = join(fixture.root, 'external-packages');
    await rename(join(fixture.preparedRoot, 'packages'), external);
    await symlink(external, join(fixture.preparedRoot, 'packages'));
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it('rejects a prepared feed file symlink escape', async () => {
    const fixture = await authorityFixture();
    const makefile = join(fixture.preparedRoot, 'packages/lang/rust/Makefile');
    const external = join(fixture.root, 'external-rust');
    await rename(makefile, external);
    await symlink(external, makefile);
    const packages = fixture.preparedFeeds.feeds.find((feed) => feed.name === 'packages')!;
    const preparedFeeds = { ...fixture.preparedFeeds, feeds: fixture.preparedFeeds.feeds.map((feed) => feed.name === 'packages' ? { ...packages, treeSha256: '0'.repeat(64) } : feed) };
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), preparedFeeds })).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it('rejects a changed pinned Rust source before activation', async () => {
    const fixture = await authorityFixture();
    await writeFile(join(fixture.preparedRoot, 'packages/lang/rust/Makefile'), 'changed\n');
    const packageDirectory = join(fixture.preparedRoot, 'packages');
    const changedTreeSha256 = await feedTreeSha256(packageDirectory);
    const preparedFeeds = {
      ...fixture.preparedFeeds,
      feeds: fixture.preparedFeeds.feeds.map((feed) => feed.name === 'packages' ? { ...feed, treeSha256: changedTreeSha256 } : feed),
    };
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), preparedFeeds })).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it.each(['update-feeds', 'install-feeds'] as const)('rejects a Rust transform changed after %s', async (operationId) => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture, { mutateRustAfter: operationId });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    expect(calls.at(-1)?.operationId).toBe(operationId);
  });

  it.each([
    ['update-feeds', 'luci'],
    ['install-feeds', 'routing'],
  ] as const)('rejects a non-Rust %s tree changed after %s', async (operationId, name) => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture, {
      mutateFeedAfter: { operation: operationId, name },
    });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({
      code: 'FEED_INSTALL_FAILED',
      operationId,
    });
    expect(calls.at(-1)?.operationId).toBe(operationId);
  });

  it('rejects a symlinked job workspace', async () => {
    const fixture = await authorityFixture();
    const external = join(fixture.root, 'external-workspace');
    await rename(fixture.workspace, external);
    await symlink(external, fixture.workspace);
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
    expect(calls).toEqual([]);
  });

  it('binds every registered operation to one held workspace descriptor capability', async () => {
    const fixture = await authorityFixture();
    const base = operations(fixture);
    const requests: Parameters<TargetSetupCommandExecutor>[0][] = [];
    const runner = createLockedTargetSetupOperations(async (request) => {
        requests.push(request);
        if (!request.cwd.startsWith(`/proc/${process.pid}/fd/`)) {
          throw new Error('operation has no held workspace capability');
        }
        return base.execute(request);
    });

    await expect(resolveTargetSetup(input(fixture, runner))).resolves.toMatchObject({ target: 'rpi-5' });
    expect(requests).toHaveLength(5);
    expect(new Set(requests.map((request) => request.cwd)).size).toBe(1);
    expect(new Set(requests.map((request) => `${request.workspaceIdentity.device}:${request.workspaceIdentity.inode}`)).size).toBe(1);
    expect(requests.every((request) => request.network === 'none')).toBe(true);
  });

  it('cannot redirect an operation when the named workspace is replaced at the command boundary', async () => {
    const fixture = await authorityFixture();
    const base = operations(fixture);
    const heldWorkspace = `${fixture.workspace}.held`;
    let replaced = false;
    const runner = createLockedTargetSetupOperations(async (request) => {
        if (!replaced) {
          replaced = true;
          await rename(fixture.workspace, heldWorkspace);
          await mkdir(join(fixture.workspace, 'openwrt'), { recursive: true });
        }
        return base.execute(request);
    });

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
    expect(replaced).toBe(true);
    expect(await lstat(join(fixture.workspace, 'openwrt/.pc')).catch(() => null)).toBeNull();
    expect((await lstat(join(heldWorkspace, 'openwrt/.pc'))).isDirectory()).toBe(true);
  });

  it('rejects replacement of the state-root parent chain at the command boundary', async () => {
    const fixture = await authorityFixture();
    const base = operations(fixture);
    const stateParent = join(fixture.root, 'state-home');
    const heldStateParent = `${stateParent}.held`;
    let replaced = false;
    const runner = createLockedTargetSetupOperations(async (request) => {
        if (!replaced) {
          replaced = true;
          await rename(stateParent, heldStateParent);
          await mkdir(fixture.statePath, { recursive: true });
        }
        return base.execute(request);
    });

    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
    expect(replaced).toBe(true);
  });

  it('rejects replacement of the workspace binding after its descriptor is held', async () => {
    let fixture: Fixture;
    let swapped = false;
    fixture = await authorityFixture({
      async beforeDirectoryAccess(handle) {
        const path = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!swapped && path === fixture.workspace) {
          swapped = true;
          const hidden = `${fixture.workspace}.hidden`;
          await rename(fixture.workspace, hidden);
          await symlink(hidden, fixture.workspace);
        }
      },
    });
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
    expect(swapped).toBe(true);
    expect(calls).toEqual([]);
  });

  it('rejects a symlinked local ChirpStack feed', async () => {
    const fixture = await authorityFixture();
    const local = join(fixture.workspace, 'feeds/chirpstack-openwrt-feed');
    const external = join(fixture.root, 'external-chirpstack');
    await rename(local, external);
    await symlink(external, local);
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(calls).toEqual([]);
  });

  it('rejects replacement of the local feed binding after activation', async () => {
    const fixture = await authorityFixture();
    let swapped = false;
    const { runner, calls } = operations(fixture, {
      async afterOperation(operationId) {
        if (!swapped && operationId === 'activate-target') {
          swapped = true;
          const local = join(fixture.workspace, 'feeds/chirpstack-openwrt-feed');
          const hidden = join(fixture.workspace, 'feeds/chirpstack-hidden');
          await rename(local, hidden);
          await symlink(hidden, local);
        }
      },
    });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(swapped).toBe(true);
    expect(calls.map((call) => call.operationId)).toEqual(['activate-target']);
  });

  it('rejects a local feed replacement race during no-follow traversal', async () => {
    let fixture: Fixture;
    let swapped = false;
    fixture = await authorityFixture({
      async beforeDirectoryAccess(handle) {
        const path = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!swapped && path === join(fixture.workspace, 'feeds')) {
          swapped = true;
          const local = join(fixture.workspace, 'feeds/chirpstack-openwrt-feed');
          const hidden = join(fixture.workspace, 'feeds/chirpstack-hidden');
          await rename(local, hidden);
          await symlink(hidden, local);
        }
      },
    });
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(swapped).toBe(true);
    expect(calls).toEqual([]);
  });

  it('rejects a Rust file replacement race after opening the held descriptor', async () => {
    let fixture: Fixture;
    let swapped = false;
    fixture = await authorityFixture({
      async beforeRead(handle) {
        const path = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!swapped && path.endsWith('/prepared-feeds/packages/lang/rust/Makefile')) {
          swapped = true;
          const hidden = `${path}.hidden`;
          await rename(path, hidden);
          await symlink(hidden, path);
        }
      },
    });
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    expect(swapped).toBe(true);
    expect(calls).toEqual([]);
  });

  it('rejects a copied feed hash mismatch before offline feed update', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture, { corruptCopy: true });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED', operationId: 'copy-feed-config' });
    expect(calls.map((call) => call.operationId)).toEqual(['activate-target', 'copy-feed-config']);
  });

  it('rejects a non-local ChirpStack feed entry before operations', async () => {
    const fixture = await authorityFixture();
    const feedConfig = await readFile(join(fixture.workspace, 'feeds.conf.default'), 'utf8');
    await writeFile(join(fixture.workspace, 'feeds.conf.default'), feedConfig.replace(
      'src-link chirpstack feeds/chirpstack-openwrt-feed',
      'src-link chirpstack /tmp/external-feed',
    ));
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_INSTALL_FAILED' });
    expect(calls).toEqual([]);
  });

  it.each(targets.filter((target) => target.id === 'rpi-5').map((target) => [target.id, target] as const))('rejects a mismatched %s source profile config', async (_id, target) => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, { sourceConfigOverride: { [target.id]: '# invalid\n' } });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
  });

  it.each(targets.filter((target) => target.id === 'rpi-5').map((target) => [target.id, target] as const))('rejects a mismatched %s resolved profile config', async (_id, target) => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, { resolvedConfigOverride: { [target.id]: '# invalid\n' } });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH', operationId: 'resolve-config' });
  });

  it('rejects a missing installed package link', async () => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, { missingLink: 'node-red' });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_LINKS_MISSING' });
  });

  it('rejects an installed package link that resolves to the wrong local package', async () => {
    const fixture = await authorityFixture();
    const { runner } = operations(fixture, { wrongLink: 'chirpstack' });
    await expect(resolveTargetSetup(input(fixture, runner))).rejects.toMatchObject({ code: 'FEED_LINKS_MISSING' });
  });

  it('rejects unsafe job IDs before authority traversal', async () => {
    const fixture = await authorityFixture();
    const { runner, calls } = operations(fixture);
    await expect(resolveTargetSetup({ ...input(fixture, runner), jobId: '../escape' })).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
    expect(calls).toEqual([]);
  });
});
