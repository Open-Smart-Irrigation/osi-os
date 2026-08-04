import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { configureProductionInstaller, loadSelectedInstallation } from '../../installer/configure.js';
import { createProductionBuilderLock } from '../../installer/install.js';
import { acquireInstallLock } from '../../installer/production.js';
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
  for (const name of ['osi-image-builder.service', 'osi-image-builder-runner@.service']) {
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
    dependencyEgressProxySha256: digest('proxy'),
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

async function selectVersion(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  packageVersion: string,
): Promise<void> {
  const versionRoot = join(fixture.installRoot, packageVersion);
  const manifestRoot = join(versionRoot, 'manifest');
  const systemdRoot = join(versionRoot, 'systemd');
  await mkdir(manifestRoot, { recursive: true });
  await mkdir(systemdRoot);
  const manifestText = await readFile(new URL('../../manifest/targets.json', import.meta.url), 'utf8');
  await writeFile(join(manifestRoot, 'targets.json'), manifestText);
  for (const name of ['osi-image-builder.service', 'osi-image-builder-runner@.service']) {
    await writeFile(join(systemdRoot, name), await readFile(new URL(`../../systemd/${name}`, import.meta.url), 'utf8'));
  }
  const lock = createProductionBuilderLock({
    packageVersion,
    imageRepository: 'osi/image-builder',
    imageDigest: digest(`image-${packageVersion}`),
    baseImage: `docker.io/library/debian@sha256:${digest(`base-${packageVersion}`)}`,
    baseImageDigest: digest(`base-${packageVersion}`),
    dockerfileSha256: digest(`dockerfile-${packageVersion}`),
    packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'],
    rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 },
    nodeVersion: '22.14.0',
    executionDefinitionSha256: digest(`execution-${packageVersion}`),
    validationEvidenceSha256: digest(`validation-${packageVersion}`),
    dependencyEgressProxySha256: digest(`proxy-${packageVersion}`),
    publisherSha256: digest(`publisher-${packageVersion}`),
  });
  const lockText = `${JSON.stringify(lock)}\n`;
  await writeFile(join(versionRoot, 'builder.lock.json'), lockText);
  await writeFile(join(fixture.installRoot, 'selected.json'), `${JSON.stringify({
    packageVersion,
    manifestSha256: digest(manifestText),
    lockSha256: digest(lockText),
    publisherSha256: lock.publisherSha256,
    executionDefinitionSha256: lock.executionDefinitionSha256,
  })}\n`);
}

async function establishInitialConfiguration(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
  await configureProductionInstaller({
    approvedRoot: fixture.approvedRoot,
    repositoryPath: fixture.repositoryPath,
  }, {
    env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
    effectiveHomeOptions: {
      ownerUid,
      lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
    },
    output: () => undefined,
    getSystemdUnitState: async () => ({ presence: 'absent' as const }),
    checkServiceHealth: async () => undefined,
    runSystemctl: async () => undefined,
  });
}

async function compileInstallerFsHelper(): Promise<string> {
  const root = await mkdtemp(join(homedir(), '.osi-configure-lock-helper-'));
  temporaryDirectories.push(root);
  const helper = join(root, 'installer-fs-helper');
  await execFile('/usr/bin/gcc', [
    '-std=c17',
    '-D_GNU_SOURCE',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-o',
    helper,
    new URL('../../installer/installer-fs-helper.c', import.meta.url).pathname,
  ]);
  return helper;
}

describe('configured authority evidence', () => {
  it('creates held output work, staging, and quarantine directories before starting systemd', async () => {
    const fixture = await createFixture();
    const workRoot = join(fixture.approvedRoot, '.osi-image-builder');
    const stagingRoot = join(workRoot, 'staging');
    const quarantineRoot = join(workRoot, 'quarantine');
    const userUnitRoot = join(fixture.configHome, 'systemd', 'user');
    const staleCleanupUnit = join(userUnitRoot, 'osi-image-builder-cleanup@.service');
    await mkdir(userUnitRoot, { recursive: true, mode: 0o700 });
    await writeFile(staleCleanupUnit, '[Service]\nExecStart=/old/current-version/cleanup %i\n', { mode: 0o600 });
    const systemctlCalls: string[][] = [];

    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        XDG_STATE_HOME: fixture.stateHome,
      },
      effectiveHomeOptions: {
        ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
        lookupPasswd: async (uid: number) => (
          `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`
        ),
      },
      output: () => undefined,
      runSystemctl: async (argv) => {
        systemctlCalls.push([...argv]);
        for (const path of [workRoot, stagingRoot, quarantineRoot]) {
          const metadata = await lstat(path);
          expect(metadata.isDirectory()).toBe(true);
          expect(metadata.isSymbolicLink()).toBe(false);
          expect(metadata.mode & 0o7777).toBe(0o750);
        }
      },
    });

    expect(systemctlCalls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'restart', 'osi-image-builder.service'],
      ['--user', 'enable', 'osi-image-builder.service'],
    ]);
    await expect(lstat(staleCleanupUnit)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(userUnitRoot, 'osi-image-builder.service'))).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(lstat(join(userUnitRoot, 'osi-image-builder-runner@.service'))).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('rolls back the new service, units, config, and authority when service start fails', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const initialSystemctlCalls: string[][] = [];
    const baseOptions = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      checkServiceHealth: async () => undefined,
    } as const;
    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...baseOptions,
      runSystemctl: async (argv) => { initialSystemctlCalls.push([...argv]); },
    });

    const unitRoot = join(fixture.configHome, 'systemd', 'user');
    const previous = {
      authority: await readFile(join(fixture.installRoot, 'configured-authorities.json'), 'utf8'),
      config: await readFile(join(fixture.configHome, 'osi-image-builder', 'config.json'), 'utf8'),
      unit: await readFile(join(unitRoot, 'osi-image-builder.service'), 'utf8'),
      runner: await readFile(join(unitRoot, 'osi-image-builder-runner@.service'), 'utf8'),
    };
    const nextApprovedRoot = join(fixture.root, 'images-next');
    await mkdir(nextApprovedRoot);
    await selectVersion(fixture, '0.2.0');

    let firstRestart = true;
    const systemctlCalls: string[][] = [];
    await expect(configureProductionInstaller({
      approvedRoot: nextApprovedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...baseOptions,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      runSystemctl: async (argv) => {
        systemctlCalls.push([...argv]);
        if (argv[1] === 'restart' && firstRestart) {
          firstRestart = false;
          throw new Error('new service failed to start');
        }
      },
    })).rejects.toThrow(/failed to start/u);

    expect(systemctlCalls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'restart', 'osi-image-builder.service'],
      ['--user', 'stop', 'osi-image-builder.service'],
      ['--user', 'daemon-reload'],
      ['--user', 'restart', 'osi-image-builder.service'],
      ['--user', 'enable', 'osi-image-builder.service'],
    ]);
    await expect(readFile(join(fixture.installRoot, 'configured-authorities.json'), 'utf8')).resolves.toBe(previous.authority);
    await expect(readFile(join(fixture.configHome, 'osi-image-builder', 'config.json'), 'utf8')).resolves.toBe(previous.config);
    await expect(readFile(join(unitRoot, 'osi-image-builder.service'), 'utf8')).resolves.toBe(previous.unit);
    await expect(readFile(join(unitRoot, 'osi-image-builder-runner@.service'), 'utf8')).resolves.toBe(previous.runner);
    expect(initialSystemctlCalls).toHaveLength(3);
  });

  it('rolls back the new service after it starts but fails the health gate', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const baseOptions = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      checkServiceHealth: async () => undefined,
    } as const;
    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...baseOptions,
      runSystemctl: async () => undefined,
    });
    const previousUnit = await readFile(join(fixture.configHome, 'systemd', 'user', 'osi-image-builder.service'), 'utf8');
    const previousConfig = await readFile(join(fixture.configHome, 'osi-image-builder', 'config.json'), 'utf8');
    const previousAuthority = await readFile(join(fixture.installRoot, 'configured-authorities.json'), 'utf8');
    const nextApprovedRoot = join(fixture.root, 'images-next');
    await mkdir(nextApprovedRoot);
    await selectVersion(fixture, '0.2.0');

    const systemctlCalls: string[][] = [];
    await expect(configureProductionInstaller({
      approvedRoot: nextApprovedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...baseOptions,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
      checkServiceHealth: async (version) => {
        if (version === '0.2.0') throw new Error('migration blocker reported by health');
      },
    })).rejects.toThrow(/migration blocker/u);

    expect(systemctlCalls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'restart', 'osi-image-builder.service'],
      ['--user', 'stop', 'osi-image-builder.service'],
      ['--user', 'daemon-reload'],
      ['--user', 'restart', 'osi-image-builder.service'],
      ['--user', 'enable', 'osi-image-builder.service'],
    ]);
    await expect(readFile(join(fixture.configHome, 'systemd', 'user', 'osi-image-builder.service'), 'utf8')).resolves.toBe(previousUnit);
    await expect(readFile(join(fixture.configHome, 'osi-image-builder', 'config.json'), 'utf8')).resolves.toBe(previousConfig);
    await expect(readFile(join(fixture.installRoot, 'configured-authorities.json'), 'utf8')).resolves.toBe(previousAuthority);
  });

  it('never restarts a service after rollback cannot prove the failed service stopped', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const options = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      checkServiceHealth: async () => undefined,
    } as const;
    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, { ...options, runSystemctl: async () => undefined });
    await selectVersion(fixture, '0.2.0');

    const systemctlCalls: string[][] = [];
    const error = await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...options,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      checkServiceHealth: async () => { throw new Error('new service unhealthy'); },
      runSystemctl: async (argv) => {
        systemctlCalls.push([...argv]);
        if (argv[1] === 'stop') throw new Error('stop failed');
      },
    }).then(() => undefined, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty('message', expect.stringMatching(/service-state=uncertain/u));
    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
  });

  it('restores an absent prior unit without enable, disable, or an old-service restart', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const systemctlCalls: string[][] = [];

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'absent' as const }),
      checkServiceHealth: async () => { throw new Error('first activation unhealthy'); },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    })).rejects.toThrow(/first activation unhealthy/u);

    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable' || argv[1] === 'disable')).toHaveLength(0);
    for (const path of [
      join(fixture.installRoot, 'configured-authorities.json'),
      join(fixture.configHome, 'osi-image-builder', 'config.json'),
      join(fixture.configHome, 'systemd', 'user', 'osi-image-builder.service'),
      join(fixture.configHome, 'systemd', 'user', 'osi-image-builder-runner@.service'),
    ]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('maps systemctl exit 4 from both prior-state probes to an absent unit', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const stateVerbs: string[] = [];
    const systemctlCalls: string[][] = [];

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      runSystemdStateCommand: async (verb: 'is-active' | 'is-enabled') => {
        stateVerbs.push(verb);
        throw Object.assign(new Error(`${verb} absent`), { code: 4 });
      },
      checkServiceHealth: async () => { throw new Error('first activation unhealthy'); },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    })).rejects.toThrow(/first activation unhealthy/u);

    expect(stateVerbs).toEqual(['is-active', 'is-enabled']);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable' || argv[1] === 'disable')).toHaveLength(0);
  });

  it('restores a present inactive and disabled unit without restarting it', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const base = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      checkServiceHealth: async () => undefined,
    } as const;
    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...base,
      getSystemdUnitState: async () => ({ presence: 'absent' as const }),
      runSystemctl: async () => undefined,
    });
    await selectVersion(fixture, '0.2.0');

    const systemctlCalls: string[][] = [];
    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...base,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: false, enabled: false }),
      checkServiceHealth: async () => { throw new Error('new service unhealthy'); },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    })).rejects.toThrow(/new service unhealthy/u);

    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'disable')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
  });

  it('restores a present inactive and enabled unit without restarting it', async () => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const systemctlCalls: string[][] = [];

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: false, enabled: true }),
      checkServiceHealth: async () => { throw new Error('new service unhealthy'); },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    })).rejects.toThrow(/new service unhealthy/u);

    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'disable')).toHaveLength(0);
  });

  it('restores a present active and disabled unit only after old-version health passes', async () => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const healthVersions: string[] = [];
    const systemctlCalls: string[][] = [];

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: false }),
      checkServiceHealth: async (version) => {
        healthVersions.push(version);
        if (version === '0.2.0') throw new Error('new service unhealthy');
      },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    })).rejects.toThrow(/new service unhealthy/u);

    expect(healthVersions).toEqual(['0.2.0', '0.1.0']);
    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(2);
    expect(systemctlCalls.filter((argv) => argv[1] === 'disable')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
  });

  it('stops rollback when the restarted previous package fails its versioned health check', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const base = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
    } as const;
    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...base,
      getSystemdUnitState: async () => ({ presence: 'absent' as const }),
      checkServiceHealth: async () => undefined,
      runSystemctl: async () => undefined,
    });
    await selectVersion(fixture, '0.2.0');

    const healthVersions: string[] = [];
    const systemctlCalls: string[][] = [];
    const error = await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...base,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      checkServiceHealth: async (version) => {
        healthVersions.push(version);
        throw new Error(version === '0.2.0' ? 'new package unhealthy' : 'old package unhealthy');
      },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    }).then(() => undefined, (cause: unknown) => cause);

    expect(healthVersions).toEqual(['0.2.0', '0.1.0']);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty('message', expect.stringMatching(/service-state=stopped/u));
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
    expect(systemctlCalls.at(-1)).toEqual(['--user', 'stop', 'osi-image-builder.service']);
  });

  it('fails a systemd state probe before creating configuration, state, unit, or output paths', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const systemctlCalls: string[][] = [];

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => { throw new Error('systemd state unavailable'); },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    })).rejects.toThrow(/systemd state unavailable/u);

    expect(systemctlCalls).toEqual([]);
    for (const path of [
      join(fixture.installRoot, 'configured-authorities.json'),
      join(fixture.configHome, 'osi-image-builder'),
      join(fixture.configHome, 'systemd'),
      join(fixture.stateHome, 'osi-image-builder'),
      join(fixture.approvedRoot, '.osi-image-builder'),
    ]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects a snapshotted file pathname removed after descriptor open', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const common = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      runSystemctl: async () => undefined,
      checkServiceHealth: async () => undefined,
    } as const;
    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...common,
      getSystemdUnitState: async () => ({ presence: 'absent' as const }),
    });
    await selectVersion(fixture, '0.2.0');

    const systemctlCalls: string[][] = [];
    let substituted = false;
    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...common,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
      snapshotHooks: {
        afterOpen: async ({ name, path }: Readonly<{ name: string; path: string }>) => {
          if (name === 'config.json' && !substituted) {
            substituted = true;
            await rename(path, `${path}.removed-after-open`);
          }
        },
      },
    })).rejects.toThrow(/snapshot|identity|changed/u);

    expect(substituted).toBe(true);
    expect(systemctlCalls).toEqual([]);
  });

  it.each([
    ['replacement', async (path: string) => {
      await rename(path, `${path}.replaced-after-read`);
      await writeFile(path, '{"replacement":true}\n', { mode: 0o600 });
    }],
    ['mutation', async (path: string) => {
      await writeFile(path, '{"mutated":true}\n', { mode: 0o600 });
    }],
  ] as const)('rejects a snapshotted file %s through the afterRead hook', async (_case, alter) => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const systemctlCalls: string[][] = [];
    let altered = false;

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
      checkServiceHealth: async () => undefined,
      snapshotHooks: {
        afterRead: async ({ name, path }: Readonly<{ name: string; path: string }>) => {
          if (name === 'config.json' && !altered) {
            altered = true;
            await alter(path);
          }
        },
      },
    })).rejects.toThrow(/snapshot|identity|changed/u);

    expect(altered).toBe(true);
    expect(systemctlCalls).toEqual([]);
  });

  it('acquires the shared install lock before reading selected.json', async () => {
    const fixture = await createFixture();
    const selectionPath = join(fixture.installRoot, 'selected.json');
    const validSelection = await readFile(selectionPath, 'utf8');
    await writeFile(selectionPath, '{invalid-before-lock\n');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const lockPaths: string[] = [];

    await expect(configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'absent' as const }),
      runSystemctl: async () => undefined,
      checkServiceHealth: async () => undefined,
      acquireConfigureLock: async (path) => {
        lockPaths.push(path);
        await writeFile(selectionPath, validSelection);
        return async () => undefined;
      },
    })).resolves.toMatchObject({ versionRoot: fixture.versionRoot });

    expect(lockPaths).toHaveLength(1);
    expect(lockPaths[0]).toMatch(/\/\.osi-image-builder-install\.lock$/u);
  });

  it('mutually excludes installer and configure through the shared install lock', async () => {
    const fixture = await createFixture();
    const helper = await compileInstallerFsHelper();
    const lockPath = join(fixture.home, '.local', 'lib', '.osi-image-builder-install.lock');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const common = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'absent' as const }),
      runSystemctl: async () => undefined,
    } as const;

    const releaseInstaller = await acquireInstallLock(helper, lockPath);
    try {
      await expect(configureProductionInstaller({
        approvedRoot: fixture.approvedRoot,
        repositoryPath: fixture.repositoryPath,
      }, {
        ...common,
        checkServiceHealth: async () => undefined,
      })).rejects.toThrow(/another installer|install lock|code=3/iu);
    } finally {
      await releaseInstaller();
    }

    let announceHealth: (() => void) | undefined;
    const healthEntered = new Promise<void>((resolveHealth) => { announceHealth = resolveHealth; });
    let releaseHealth: (() => void) | undefined;
    const healthGate = new Promise<void>((resolveHealth) => { releaseHealth = resolveHealth; });
    const configuring = configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...common,
      checkServiceHealth: async () => {
        announceHealth?.();
        await healthGate;
      },
    });
    await healthEntered;

    try {
      const installerAttempt = await acquireInstallLock(helper, lockPath).then(
        (release) => ({ release }),
        (error: unknown) => ({ error }),
      );
      if ('release' in installerAttempt) await installerAttempt.release();
      expect(installerAttempt).toHaveProperty('error', expect.objectContaining({
        message: expect.stringMatching(/another installer|code=3/iu),
      }));
    } finally {
      releaseHealth?.();
    }
    await expect(configuring).resolves.toMatchObject({ versionRoot: fixture.versionRoot });
  });

  it('rejects a concurrent configure while the first transaction is waiting for health', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    let announceHealth: (() => void) | undefined;
    const healthEntered = new Promise<void>((resolveHealth) => { announceHealth = resolveHealth; });
    let releaseHealth: (() => void) | undefined;
    const healthGate = new Promise<void>((resolveHealth) => { releaseHealth = resolveHealth; });
    const common = {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'absent' as const }),
      runSystemctl: async () => undefined,
    } as const;
    const first = configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      ...common,
      checkServiceHealth: async () => {
        announceHealth?.();
        await healthGate;
      },
    });
    await healthEntered;

    try {
      await expect(configureProductionInstaller({
        approvedRoot: fixture.approvedRoot,
        repositoryPath: fixture.repositoryPath,
      }, {
        ...common,
        checkServiceHealth: async () => undefined,
      })).rejects.toThrow(/configure lock|another.*holds|lock helper/iu);
    } finally {
      releaseHealth?.();
    }
    await expect(first).resolves.toMatchObject({ versionRoot: fixture.versionRoot });
  });

  it('leaves the service stopped when rollback daemon-reload fails', async () => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const systemctlCalls: string[][] = [];
    let daemonReloads = 0;

    const error = await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      checkServiceHealth: async () => { throw new Error('new package unhealthy'); },
      runSystemctl: async (argv) => {
        systemctlCalls.push([...argv]);
        if (argv[1] === 'daemon-reload' && ++daemonReloads === 2) {
          throw new Error('rollback daemon-reload failed');
        }
      },
    }).then(() => undefined, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty('message', expect.stringMatching(/service-state=stopped/u));
    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
    expect(systemctlCalls.filter((argv) => argv[1] === 'stop')).not.toHaveLength(0);
  });

  it('leaves the service stopped and aggregates authority evidence when file restore fails', async () => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const movedConfigHome = `${fixture.configHome}-during-rollback`;
    const systemctlCalls: string[][] = [];
    let replaced = false;

    const error = await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      checkServiceHealth: async () => {
        if (!replaced) {
          replaced = true;
          await rename(fixture.configHome, movedConfigHome);
          await mkdir(fixture.configHome, { mode: 0o700 });
        }
        throw new Error('new package unhealthy before restore');
      },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    }).then(() => undefined, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty('message', expect.stringMatching(/service-state=stopped/u));
    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(1);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
    expect(systemctlCalls.filter((argv) => argv[1] === 'stop')).not.toHaveLength(0);
  });

  it('rolls back instead of enabling when authority evidence changes during successful health', async () => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const movedConfigHome = `${fixture.configHome}-after-health`;
    const systemctlCalls: string[][] = [];

    const error = await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      checkServiceHealth: async (version) => {
        if (version === '0.2.0') {
          await rename(fixture.configHome, movedConfigHome);
          await mkdir(fixture.configHome, { mode: 0o700 });
        }
      },
      runSystemctl: async (argv) => { systemctlCalls.push([...argv]); },
    }).then(() => undefined, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty('message', expect.stringMatching(/service-state=stopped/u));
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
    expect(systemctlCalls.filter((argv) => argv[1] === 'stop')).not.toHaveLength(0);
  });

  it('stops the service when restarting the restored previous unit fails', async () => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const systemctlCalls: string[][] = [];
    let restarts = 0;

    const error = await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      checkServiceHealth: async (version) => {
        if (version === '0.2.0') throw new Error('new package unhealthy');
      },
      runSystemctl: async (argv) => {
        systemctlCalls.push([...argv]);
        if (argv[1] === 'restart' && ++restarts === 2) throw new Error('old restart failed');
      },
    }).then(() => undefined, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty('message', expect.stringMatching(/service-state=stopped/u));
    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(2);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(0);
    expect(systemctlCalls.at(-1)).toEqual(['--user', 'stop', 'osi-image-builder.service']);
  });

  it('stops the restored service when restoring prior enablement fails', async () => {
    const fixture = await createFixture();
    await establishInitialConfiguration(fixture);
    await selectVersion(fixture, '0.2.0');
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const systemctlCalls: string[][] = [];

    const error = await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: { XDG_CONFIG_HOME: fixture.configHome, XDG_STATE_HOME: fixture.stateHome },
      effectiveHomeOptions: {
        ownerUid,
        lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`,
      },
      output: () => undefined,
      getSystemdUnitState: async () => ({ presence: 'present' as const, active: true, enabled: true }),
      checkServiceHealth: async (version) => {
        if (version === '0.2.0') throw new Error('new package unhealthy');
      },
      runSystemctl: async (argv) => {
        systemctlCalls.push([...argv]);
        if (argv[1] === 'enable') throw new Error('restore enable failed');
      },
    }).then(() => undefined, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty('message', expect.stringMatching(/service-state=stopped/u));
    expect(systemctlCalls.filter((argv) => argv[1] === 'restart')).toHaveLength(2);
    expect(systemctlCalls.filter((argv) => argv[1] === 'enable')).toHaveLength(1);
    expect(systemctlCalls.at(-1)).toEqual(['--user', 'stop', 'osi-image-builder.service']);
  });

  it('rejects a user-bus authority replacement immediately before service restart', async () => {
    const fixture = await createFixture();
    const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const trustedRuntime = `/run/user/${ownerUid}`;
    const replacementRuntime = `/run/user/${ownerUid + 1}`;
    let deriveCalls = 0;
    const systemctlCalls: string[][] = [];

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
        lookupPasswd: async (uid: number) => (
          `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`
        ),
      },
      deriveSystemdBusEnvironment: async () => {
        deriveCalls += 1;
        const runtimeDir = deriveCalls < 3 ? trustedRuntime : replacementRuntime;
        return Object.freeze({
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
        });
      },
      output: () => undefined,
      runSystemctl: async (argv) => {
        systemctlCalls.push([...argv]);
      },
    })).rejects.toThrow(/systemd user bus authority changed/u);

    expect(deriveCalls).toBe(3);
    expect(systemctlCalls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'stop', 'osi-image-builder.service'],
      ['--user', 'daemon-reload'],
    ]);
  });

  it('normalizes pre-existing secure output directories held at 0700 before starting systemd', async () => {
    const fixture = await createFixture();
    const workRoot = join(fixture.approvedRoot, '.osi-image-builder');
    const stagingRoot = join(workRoot, 'staging');
    const quarantineRoot = join(workRoot, 'quarantine');
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(quarantineRoot, { mode: 0o700 });
    await chmod(workRoot, 0o700);
    await chmod(stagingRoot, 0o700);
    await chmod(quarantineRoot, 0o700);

    await configureProductionInstaller({
      approvedRoot: fixture.approvedRoot,
      repositoryPath: fixture.repositoryPath,
    }, {
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        XDG_STATE_HOME: fixture.stateHome,
      },
      effectiveHomeOptions: {
        ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
        lookupPasswd: async (uid: number) => (
          `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`
        ),
      },
      output: () => undefined,
      runSystemctl: async () => undefined,
    });

    for (const path of [workRoot, stagingRoot, quarantineRoot]) {
      expect((await lstat(path)).mode & 0o7777).toBe(0o750);
    }
  });

  it('creates all output directories at 0750 under a restrictive process umask', async () => {
    const fixture = await createFixture();
    const oldUmask = process.umask(0o077);
    try {
      await configureProductionInstaller({
        approvedRoot: fixture.approvedRoot,
        repositoryPath: fixture.repositoryPath,
      }, {
        env: {
          XDG_CONFIG_HOME: fixture.configHome,
          XDG_STATE_HOME: fixture.stateHome,
        },
        effectiveHomeOptions: {
          ownerUid: process.geteuid?.() ?? process.getuid?.() ?? 0,
          lookupPasswd: async (uid: number) => (
            `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`
          ),
        },
        output: () => undefined,
        runSystemctl: async () => undefined,
      });
    } finally {
      process.umask(oldUmask);
    }

    const workRoot = join(fixture.approvedRoot, '.osi-image-builder');
    for (const path of [workRoot, join(workRoot, 'staging'), join(workRoot, 'quarantine')]) {
      expect((await lstat(path)).mode & 0o7777).toBe(0o750);
    }
  });

  it.each([
    ['regular file', async (path: string, _target: string) => writeFile(path, 'not a directory', { mode: 0o700 })],
    ['symlink', async (path: string, target: string) => symlink(target, path)],
  ] as const)('does not chmod an unsafe output work root (%s)', async (_label, createUnsafe) => {
    const fixture = await createFixture();
    const workRoot = join(fixture.approvedRoot, '.osi-image-builder');
    const target = join(fixture.root, 'unsafe-target');
    await mkdir(target, { mode: 0o700 });
    await createUnsafe(workRoot, target);

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
        lookupPasswd: async (uid: number) => (
          `service:x:${uid}:${uid}:service:${fixture.home}:/bin/false\n`
        ),
      },
      output: () => undefined,
      runSystemctl: async () => undefined,
    })).rejects.toThrow();

    expect((await lstat(target)).mode & 0o7777).toBe(0o700);
  });

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
