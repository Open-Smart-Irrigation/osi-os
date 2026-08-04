import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createProductionSystemdAdapter } from '../../api/src/production.js';
import { createCommandExecutor } from '../../runner/src/command-executor.js';
import { createTestBuilderIdentity } from '../helpers/builder-identity.js';

const execFile = promisify(execFileCallback);
const UNIT_NAMES = [
  'osi-image-builder.service',
  'osi-image-builder-runner@.service',
] as const;
const unitDirectory = new URL('../../systemd/', import.meta.url);
const temporaryDirectories: string[] = [];
const transientUnits: string[] = [];

type UserManagerProbe =
  | Readonly<{ available: true; version: string; mutation: 'none' }>
  | Readonly<{ available: false; code: 'USER_MANAGER_UNAVAILABLE'; detail: string; mutation: 'none' }>;

type VerificationProbe =
  | Readonly<{ available: true; output: string; mutation: 'none' }>
  | Readonly<{ available: false; code: 'SYSTEMD_ANALYZE_UNAVAILABLE'; detail: string; mutation: 'none' }>;

function errorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as { readonly message?: unknown; readonly stderr?: unknown; readonly stdout?: unknown };
  return [value.message, value.stderr, value.stdout]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 512) || 'systemd command failed';
}

async function snapshotTree(root: string): Promise<readonly string[]> {
  const entries: string[] = [];

  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        entries.push(`${name}/`);
        await visit(path);
      } else {
        entries.push(`${name}:${(await readFile(path)).toString('hex')}`);
      }
    }
  }

  await visit(root);
  return entries.sort();
}

function escapeSystemdWord(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error('systemd fixture path contains a forbidden control character');
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll(' ', '\\x20');
}

async function copyUnitFixture(): Promise<{
  readonly root: string;
  readonly paths: readonly string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-systemd-'));
  temporaryDirectories.push(root);
  const unitRoot = join(root, 'units');
  const installRoot = join(root, 'versioned installs', '2026.07.28');
  const binRoot = join(installRoot, 'bin');
  const repositoryRoot = join(root, 'repository');
  const configHome = join(root, 'config-home');
  const configRoot = join(configHome, 'osi-image-builder');
  const stateHome = join(root, 'state-home');
  const stateRoot = join(stateHome, 'osi-image-builder');
  const runtimeRoot = join(root, 'runtime');
  const outputRoots = [join(root, 'output one'), join(root, 'output-two')] as const;
  const outputWorkRoots = outputRoots.map((outputRoot) => join(outputRoot, '.osi-image-builder'));
  await mkdir(binRoot, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  for (const outputWorkRoot of outputWorkRoots) await mkdir(outputWorkRoot, { recursive: true });

  for (const executable of ['osi-image-builder-api', 'osi-image-builder-runner', 'osi-image-builder-cleanup', 'osi-image-publish']) {
    const path = join(binRoot, executable);
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(path, 0o755);
  }

  await mkdir(unitRoot, { recursive: true });
  const paths: string[] = [];
  for (const name of UNIT_NAMES) {
    const source = await readFile(new URL(name, unitDirectory), 'utf8');
    const copied = source
      .replaceAll('%h/.local/lib/osi-image-builder/selected', escapeSystemdWord(installRoot))
      .replaceAll('@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@', escapeSystemdWord(installRoot))
      .replaceAll('@OSI_IMAGE_BUILDER_REPOSITORY_PATH@', escapeSystemdWord(repositoryRoot))
      .replaceAll('@OSI_IMAGE_BUILDER_XDG_CONFIG_HOME@', escapeSystemdWord(configHome))
      .replaceAll('@OSI_IMAGE_BUILDER_CONFIG_ROOT@', escapeSystemdWord(configRoot))
      .replaceAll('@OSI_IMAGE_BUILDER_XDG_STATE_HOME@', escapeSystemdWord(stateHome))
      .replaceAll('@OSI_IMAGE_BUILDER_STATE_ROOT@', escapeSystemdWord(stateRoot))
      .replaceAll('@OSI_IMAGE_BUILDER_XDG_RUNTIME_DIR@', escapeSystemdWord(runtimeRoot))
      .replaceAll('@OSI_IMAGE_BUILDER_OUTPUT_ROOT_PATHS@', outputRoots.map(escapeSystemdWord).join(' '))
      .replaceAll('@OSI_IMAGE_BUILDER_OUTPUT_WORK_ROOT_PATHS@', outputWorkRoots.map(escapeSystemdWord).join(' '));
    const path = join(unitRoot, basename(name));
    await writeFile(path, copied);
    paths.push(path);
  }
  return {
    root,
    paths,
  };
}

async function verifyCopiedUnits(paths: readonly string[]): Promise<VerificationProbe> {
  try {
    const result = await execFile('systemd-analyze', ['--user', 'verify', ...paths], {
      env: { ...process.env, SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' },
      maxBuffer: 64 * 1024,
      timeout: 15_000,
    });
    return { available: true, output: `${result.stdout}${result.stderr}`, mutation: 'none' };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { readonly code?: unknown }).code : undefined;
    if (code === 'ENOENT') return { available: false, code: 'SYSTEMD_ANALYZE_UNAVAILABLE', detail: errorDetail(error), mutation: 'none' };
    throw new Error(`systemd-analyze verify rejected the temporary units: ${errorDetail(error)}`, { cause: error });
  }
}

async function inspectUserManager(): Promise<UserManagerProbe> {
  try {
    const result = await execFile('systemctl', ['--user', 'show', '--no-pager', '--property=Version'], {
      env: { ...process.env, SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' },
      maxBuffer: 16 * 1024,
      timeout: 5_000,
    });
    const version = result.stdout.match(/^Version=(.+)$/mu)?.[1]?.trim();
    if (!version) {
      return { available: false, code: 'USER_MANAGER_UNAVAILABLE', detail: 'user manager returned no Version property', mutation: 'none' };
    }
    return { available: true, version, mutation: 'none' };
  } catch (error) {
    return { available: false, code: 'USER_MANAGER_UNAVAILABLE', detail: errorDetail(error), mutation: 'none' };
  }
}

afterEach(async () => {
  await Promise.all(transientUnits.splice(0).map(async (unit) => {
    await execFile('systemctl', ['--user', 'stop', unit]).catch(() => undefined);
    await execFile('systemctl', ['--user', 'reset-failed', unit]).catch(() => undefined);
  }));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function readJsonWhenPresent(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
        await delay(50);
        continue;
      }
      throw error;
    }
  }
  throw new Error('transient cleanup unit did not write its isolation evidence');
}

describe('temporary systemd unit integration boundary', () => {
  it('verifies copied units and probes the user manager without lifecycle mutation', async () => {
    const fixture = await copyUnitFixture();
    const before = await snapshotTree(fixture.root);
    const verified = await verifyCopiedUnits(fixture.paths);
    expect(verified).toMatchObject({ mutation: 'none' });

    const manager = await inspectUserManager();
    expect(manager).toHaveProperty('available');

    if (!manager.available) {
      expect(manager).toMatchObject({
        available: false,
        code: 'USER_MANAGER_UNAVAILABLE',
        mutation: 'none',
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
      return;
    }

    expect(manager).toMatchObject({ available: true, mutation: 'none' });
    expect(manager.version).toMatch(/\S/u);
    expect(verified).toMatchObject({ available: true, mutation: 'none' });
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it('executes the admitted cleanup path in the actual transient systemd sandbox', async () => {
    const manager = await inspectUserManager();
    if (!manager.available) throw new Error(`user systemd manager is required: ${manager.detail}`);

    const base = await mkdtemp(join(homedir(), '.osi-image-builder-systemd-'));
    temporaryDirectories.push(base);
    const packageVersion = '0.1.24';
    const packageRoot = join(base, packageVersion);
    const binRoot = join(packageRoot, 'bin');
    const configRoot = join(base, 'config root', 'osi-image-builder');
    const stateRoot = join(base, 'state root', 'osi-image-builder');
    const repositoryRoot = join(base, 'repository');
    const outputRoot = join(base, 'output root');
    const outputWorkRoot = join(outputRoot, '.osi-image-builder');
    const evidencePath = join(stateRoot, 'actual-systemd-isolation.json');
    const packageMarker = join(packageRoot, 'admitted-version.txt');
    const configMarker = join(configRoot, 'config-marker.txt');
    const repositoryMarker = join(repositoryRoot, 'branch-marker.txt');
    const outputMarker = join(outputRoot, 'output-marker.txt');
    await Promise.all([
      mkdir(binRoot, { recursive: true }),
      mkdir(configRoot, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
      mkdir(repositoryRoot, { recursive: true }),
      mkdir(outputWorkRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(packageMarker, 'admitted-0.1.24\n'),
      writeFile(configMarker, 'config-visible\n'),
      writeFile(repositoryMarker, 'branch-controlled\n'),
      writeFile(outputMarker, 'output-visible\n'),
    ]);
    const cleanupExecutable = join(binRoot, 'osi-image-builder-cleanup');
    const publisherExecutable = join(binRoot, 'osi-image-publish');
    const cleanupSource = `#!/usr/bin/env node
const fs = require('node:fs');
const canWrite = (path) => { try { fs.writeFileSync(path, 'unexpected'); return true; } catch { return false; } };
const evidence = {
  packageMarker: fs.readFileSync(${JSON.stringify(packageMarker)}, 'utf8').trim(),
  configMarker: fs.readFileSync(${JSON.stringify(configMarker)}, 'utf8').trim(),
  outputMarker: fs.readFileSync(${JSON.stringify(outputMarker)}, 'utf8').trim(),
  repositoryVisible: fs.existsSync(${JSON.stringify(repositoryMarker)}),
  packageWritable: canWrite(${JSON.stringify(join(packageRoot, 'forbidden-write'))}),
  outputRootWritable: canWrite(${JSON.stringify(join(outputRoot, 'forbidden-write'))}),
  outputWorkWritable: canWrite(${JSON.stringify(join(outputWorkRoot, 'allowed-write'))}),
};
fs.writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify(evidence));
setTimeout(() => process.exit(0), 30000);
`;
    await Promise.all([
      writeFile(cleanupExecutable, cleanupSource, { mode: 0o755 }),
      writeFile(publisherExecutable, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 }),
    ]);
    await Promise.all([chmod(cleanupExecutable, 0o755), chmod(publisherExecutable, 0o755)]);

    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('actual user-systemd test requires a POSIX process UID');
    const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
    const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeRoot}/bus`;
    const identity = { ...createTestBuilderIdentity(), packageRoot };
    const admissionId = `cln_0${randomBytes(13).toString('hex').slice(0, 25)}`;
    const productionUnit = `osi-image-builder-cleanup@${admissionId}.service`;
    const unit = `osi-image-builder-cleanup-test-${randomBytes(8).toString('hex')}.service`;
    transientUnits.push(unit);
    let generatedCommand: readonly string[] | undefined;
    const systemd = createProductionSystemdAdapter({
      run: async (argv) => {
        generatedCommand = argv;
        return {
          argv, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        };
      },
    }, {
      XDG_RUNTIME_DIR: runtimeRoot,
      DBUS_SESSION_BUS_ADDRESS: busAddress,
    }, () => new Date().toISOString(), {
      configRoot,
      stateRoot,
      repositoryPath: repositoryRoot,
      approvedOutputRoots: [outputRoot],
    });

    await systemd.startCleanup(productionUnit, identity);
    expect(generatedCommand).toBeDefined();
    const actualCommand = generatedCommand!.map((argument) => (
      argument === `--unit=${productionUnit}` ? `--unit=${unit}` : argument
    ));
    const started = await createCommandExecutor().run(actualCommand, {
      env: {
        PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
        XDG_RUNTIME_DIR: runtimeRoot, DBUS_SESSION_BUS_ADDRESS: busAddress,
      },
      timeoutMs: 15_000,
      maxCaptureBytes: 64 * 1024,
    });
    expect(started, `${started.stdout}\n${started.stderr}`).toMatchObject({ exitCode: 0, timedOut: false, signal: null });
    expect(generatedCommand).toContain('--expand-environment=no');
    const evidence = await readJsonWhenPresent(evidencePath);
    expect(evidence).toEqual({
      packageMarker: 'admitted-0.1.24',
      configMarker: 'config-visible',
      outputMarker: 'output-visible',
      repositoryVisible: false,
      packageWritable: false,
      outputRootWritable: false,
      outputWorkWritable: true,
    });
    const shown = await execFile('systemctl', [
      '--user', 'show', unit, '--no-pager',
      '--property=ExecStart,BindReadOnlyPaths,BindPaths,InaccessiblePaths,NoExecPaths,ExecPaths,ProtectHome,ProtectSystem',
    ], { env: { ...process.env, SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' } });
    expect(shown.stdout).toContain(cleanupExecutable);
    expect(shown.stdout).toContain(packageRoot);
    expect(shown.stdout).toContain(repositoryRoot);
    expect(shown.stdout).toContain('ProtectHome=tmpfs');
    expect(shown.stdout).toContain('ProtectSystem=strict');
  }, 20_000);
});
