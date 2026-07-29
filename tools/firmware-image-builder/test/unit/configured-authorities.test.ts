import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { configureProductionInstaller, loadSelectedInstallation } from '../../installer/configure.js';
import { createProductionBuilderLock } from '../../installer/install.js';
import { withEffectiveHomeAuthority } from '../../shared/effective-home.mjs';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(homedir(), '.osi-configured-authorities-'));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const installRoot = join(home, '.local', 'lib', 'osi-image-builder');
  const packageVersion = '0.1.0';
  const versionRoot = join(installRoot, packageVersion);
  const manifestRoot = join(versionRoot, 'manifest');
  const systemdRoot = join(versionRoot, 'systemd');
  const approvedRoot = join(root, 'images');
  const repositoryPath = join(root, 'repository');
  const configHome = join(root, 'xdg-config');
  const stateHome = join(root, 'xdg-state');
  await mkdir(manifestRoot, { recursive: true });
  await mkdir(systemdRoot);
  await mkdir(approvedRoot);
  await mkdir(repositoryPath);
  await execFile('/usr/bin/git', ['init', '--quiet', repositoryPath]);

  const manifestText = await readFile(new URL('../../manifest/targets.json', import.meta.url), 'utf8');
  await writeFile(join(manifestRoot, 'targets.json'), manifestText);
  for (const name of ['osi-image-builder.service', 'osi-image-builder-runner@.service', 'osi-image-builder-cleanup@.service']) {
    await writeFile(join(systemdRoot, name), await readFile(new URL(`../../systemd/${name}`, import.meta.url), 'utf8'));
  }
  const lock = createProductionBuilderLock({
    packageVersion,
    imageRepository: 'osi/image-builder',
    imageDigest: digest('image'),
    baseImage: `docker.io/library/debian@sha256:${digest('base')}`,
    baseImageDigest: digest('base'),
    dockerfileSha256: digest('dockerfile'),
    packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'],
    rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 },
    nodeVersion: '22.14.0',
    executionDefinitionSha256: digest('execution'),
    validationEvidenceSha256: digest('validation'),
    publisherSha256: digest('publisher'),
  });
  const lockText = `${JSON.stringify(lock)}\n`;
  await writeFile(join(versionRoot, 'builder.lock.json'), lockText);
  await writeFile(join(installRoot, 'selected.json'), `${JSON.stringify({
    packageVersion,
    manifestSha256: digest(manifestText),
    lockSha256: digest(lockText),
    publisherSha256: lock.publisherSha256,
    executionDefinitionSha256: lock.executionDefinitionSha256,
  })}\n`);
  return {
    root,
    home,
    installRoot,
    packageVersion,
    versionRoot,
    approvedRoot,
    repositoryPath,
    configHome,
    stateHome,
  };
}

describe('configured authority evidence', () => {
  it('ignores poisoned HOME while persisting custom XDG roots under the effective passwd installation root', async () => {
    const {
      root,
      home,
      installRoot,
      approvedRoot,
      repositoryPath,
      configHome,
      stateHome,
    } = await createFixture();

    let authorityHeld = false;
    const result = await configureProductionInstaller({
      approvedRoot,
      repositoryPath,
    }, {
      env: {
        HOME: join(root, 'attacker-home'),
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
      },
      effectiveHomeOptions: {
        ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${home}:/bin/false\n`,
      },
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
      output: () => undefined,
      runSystemctl: async () => {
        expect(authorityHeld).toBe(true);
      },
    });

    const authorityPath = join(installRoot, 'configured-authorities.json');
    expect(result.authorityPath).toBe(authorityPath);
    expect(await readFile(authorityPath, 'utf8')).toBe(`${JSON.stringify({
      schemaVersion: 1,
      configRoot: join(configHome, 'osi-image-builder'),
      stateRoot: join(stateHome, 'osi-image-builder'),
    })}\n`);
    expect((await lstat(authorityPath)).mode & 0o7777).toBe(0o600);
  });

  it('reads the selected installation through a held descriptor after pathname replacement', async () => {
    const { installRoot, packageVersion, versionRoot } = await createFixture();
    const handle = await open(installRoot, 'r');
    const moved = `${installRoot}-moved`;
    try {
      await rename(installRoot, moved);
      await mkdir(installRoot, { recursive: true });

      await expect(loadSelectedInstallation(
        installRoot,
        join(installRoot, 'selected.json'),
        `/proc/${process.pid}/fd/${handle.fd}`,
      )).resolves.toEqual({
        versionRoot,
        lockPath: join(versionRoot, 'builder.lock.json'),
        executionVersionRoot: `/proc/${process.pid}/fd/${handle.fd}/${packageVersion}`,
      });
    } finally {
      await handle.close();
    }
  });

  it('rejects home replacement before any configured file mutation', async () => {
    const fixture = await createFixture();
    const movedHome = `${fixture.home}-moved`;
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        XDG_STATE_HOME: fixture.stateHome,
      },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      withEffectiveHomeAuthority: async (options, callback) => withEffectiveHomeAuthority(
        options,
        async (authority) => {
          await rename(fixture.home, movedHome);
          await mkdir(fixture.home);
          return callback(authority);
        },
      ),
      output: () => undefined,
      runSystemctl: async () => undefined,
    })).rejects.toSatisfy((error: unknown) => (
      error instanceof AggregateError
      && error.errors.some((cause) => (
        cause instanceof Error && /pathname identity changed/u.test(cause.message)
      ))
    ));

    for (const path of [
      join(movedHome, '.local', 'lib', 'osi-image-builder', 'configured-authorities.json'),
      join(fixture.home, '.local', 'lib', 'osi-image-builder', 'configured-authorities.json'),
    ]) {
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each([
    'config-state',
    'config-install',
    'output-config',
    'repository-state',
  ])('rejects custom-XDG %s overlap before authority, config, unit, or systemd mutation', async (scenario) => {
    const fixture = await createFixture();
    let configHome = fixture.configHome;
    let stateHome = fixture.stateHome;
    let approvedRoot = fixture.approvedRoot;
    let repositoryPath = fixture.repositoryPath;
    if (scenario === 'config-state') {
      stateHome = configHome;
    } else if (scenario === 'config-install') {
      configHome = join(fixture.home, '.local', 'lib');
    } else if (scenario === 'output-config') {
      approvedRoot = join(configHome, 'osi-image-builder');
      await mkdir(approvedRoot, { recursive: true });
    } else {
      repositoryPath = join(stateHome, 'osi-image-builder');
      await mkdir(repositoryPath, { recursive: true });
      await execFile('/usr/bin/git', ['init', '--quiet', repositoryPath]);
    }
    const configPath = join(configHome, 'osi-image-builder', 'config.json');
    const authorityPath = join(fixture.installRoot, 'configured-authorities.json');
    const unitPaths = [
      'osi-image-builder.service',
      'osi-image-builder-runner@.service',
      'osi-image-builder-cleanup@.service',
    ].map((name) => join(configHome, 'systemd', 'user', name));
    for (const path of [authorityPath, configPath, ...unitPaths]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    let systemctlCalls = 0;

    await expect(configureProductionInstaller({
      approvedRoot,
      repositoryPath,
    }, {
      env: {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
      },
      effectiveHomeOptions: {
        ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      runSystemctl: async () => {
        systemctlCalls += 1;
      },
    })).rejects.toThrow(/overlap/u);

    expect(systemctlCalls).toBe(0);
    for (const path of [authorityPath, configPath, ...unitPaths]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects an in-home config symlink before authority, config, unit, state, or systemd mutation', async () => {
    const fixture = await createFixture();
    const externalConfigHome = join(fixture.root, 'external-config-home');
    await mkdir(externalConfigHome);
    await symlink(externalConfigHome, join(fixture.home, '.config'));
    const authorityPath = join(fixture.installRoot, 'configured-authorities.json');
    const configPath = join(externalConfigHome, 'osi-image-builder', 'config.json');
    const stateRoot = join(fixture.home, '.local', 'state', 'osi-image-builder');
    const unitPaths = [
      'osi-image-builder.service',
      'osi-image-builder-runner@.service',
      'osi-image-builder-cleanup@.service',
    ].map((name) => join(externalConfigHome, 'systemd', 'user', name));
    let systemctlCalls = 0;

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: {},
      effectiveHomeOptions: {
        ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      runSystemctl: async () => {
        systemctlCalls += 1;
      },
    })).rejects.toThrow();

    expect(systemctlCalls).toBe(0);
    for (const path of [authorityPath, configPath, stateRoot, ...unitPaths]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects an external XDG user-unit descendant symlink before configured mutation', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.configHome, { mode: 0o700 });
    const externalUnits = join(fixture.root, 'external-units');
    await mkdir(externalUnits, { mode: 0o700 });
    await symlink(externalUnits, join(fixture.configHome, 'systemd'));
    const authorityPath = join(fixture.installRoot, 'configured-authorities.json');
    const configPath = join(fixture.configHome, 'osi-image-builder', 'config.json');
    const stateRoot = join(fixture.stateHome, 'osi-image-builder');
    let systemctlCalls = 0;

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        XDG_STATE_HOME: fixture.stateHome,
      },
      effectiveHomeOptions: {
        ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      runSystemctl: async () => {
        systemctlCalls += 1;
      },
    })).rejects.toThrow();

    expect(systemctlCalls).toBe(0);
    for (const path of [authorityPath, configPath, stateRoot, join(externalUnits, 'user')]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('detects a held XDG component replacement after output and before configured mutation', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.configHome, { mode: 0o700 });
    const movedConfigHome = `${fixture.configHome}-moved`;
    const authorityPath = join(fixture.installRoot, 'configured-authorities.json');
    const configPath = join(fixture.configHome, 'osi-image-builder', 'config.json');
    const movedConfigPath = join(movedConfigHome, 'osi-image-builder', 'config.json');
    const stateRoot = join(fixture.stateHome, 'osi-image-builder');
    let replaced = false;
    let systemctlCalls = 0;

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        XDG_STATE_HOME: fixture.stateHome,
      },
      effectiveHomeOptions: {
        ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => {
        if (!replaced) {
          replaced = true;
          renameSync(fixture.configHome, movedConfigHome);
          mkdirSync(fixture.configHome, { mode: 0o700 });
        }
      },
      runSystemctl: async () => {
        systemctlCalls += 1;
      },
    })).rejects.toThrow(/identity|pathname|changed/u);

    expect(systemctlCalls).toBe(0);
    for (const path of [authorityPath, configPath, movedConfigPath, stateRoot]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
