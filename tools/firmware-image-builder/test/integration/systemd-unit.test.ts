import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const UNIT_NAMES = [
  'osi-image-builder.service',
  'osi-image-builder-runner@.service',
  'osi-image-builder-cleanup@.service',
] as const;
const unitDirectory = new URL('../../systemd/', import.meta.url);
const temporaryDirectories: string[] = [];

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

async function copyUnitFixture(): Promise<{ readonly root: string; readonly paths: readonly string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-systemd-'));
  temporaryDirectories.push(root);
  const unitRoot = join(root, 'units');
  const installRoot = join(root, 'selected');
  const binRoot = join(installRoot, 'bin');
  const repositoryRoot = join(root, 'repository');
  const configHome = join(root, 'config-home');
  const configRoot = join(configHome, 'osi-image-builder');
  const stateHome = join(root, 'state-home');
  const stateRoot = join(stateHome, 'osi-image-builder');
  const outputRoot = join(root, 'output');
  const stagingRoot = join(outputRoot, '.osi-image-builder', 'staging');
  const quarantineRoot = join(outputRoot, '.osi-image-builder', 'quarantine');
  await mkdir(binRoot, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(quarantineRoot, { recursive: true });

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
      .replaceAll('%h/.local/lib/osi-image-builder/selected', installRoot)
      .replaceAll('@OSI_IMAGE_BUILDER_REPOSITORY_PATH@', repositoryRoot)
      .replaceAll('@OSI_IMAGE_BUILDER_XDG_CONFIG_HOME@', configHome)
      .replaceAll('@OSI_IMAGE_BUILDER_CONFIG_ROOT@', configRoot)
      .replaceAll('@OSI_IMAGE_BUILDER_XDG_STATE_HOME@', stateHome)
      .replaceAll('@OSI_IMAGE_BUILDER_STATE_ROOT@', stateRoot)
      .replaceAll('@OSI_IMAGE_BUILDER_OUTPUT_ROOT_PATHS@', outputRoot)
      .replaceAll('@OSI_IMAGE_BUILDER_CLEANUP_WRITE_PATHS@', `${stagingRoot} ${quarantineRoot}`);
    const path = join(unitRoot, basename(name));
    await writeFile(path, copied);
    paths.push(path);
  }
  return { root, paths };
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
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
});
