import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  INSTALLED_BUILDER_LOCK_MODE,
  installedMigrationsDirectory,
} from '../../domain/installed-layout.js';
import { makeTreeImmutable } from '../../installer/production.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('installed runtime layout', () => {
  it('derives the one migration directory from the selected builder lock', () => {
    expect(installedMigrationsDirectory(
      '/home/phil/.local/lib/osi-image-builder/2026.07.29.1/builder.lock.json',
    )).toBe('/home/phil/.local/lib/osi-image-builder/2026.07.29.1/api/migrations');
    expect(() => installedMigrationsDirectory('/tmp/other.json')).toThrow(/builder lock/u);
    expect(() => installedMigrationsDirectory('builder.lock.json')).toThrow(/absolute/u);
  });

  it('keeps the installed lock private while making payload files immutable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'installed-layout-'));
    roots.push(root);
    const versionRoot = join(root, '2026.07.29.1');
    const bin = join(versionRoot, 'bin');
    const data = join(versionRoot, 'api', 'migrations');
    const operations = join(versionRoot, 'operations');
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await mkdir(data, { recursive: true, mode: 0o700 });
    await mkdir(operations, { recursive: true, mode: 0o700 });
    const lock = join(versionRoot, 'builder.lock.json');
    const executable = join(bin, 'osi-image-builder-api');
    const migration = join(data, '001.sql');
    const dependencyEgressProxy = join(operations, 'osi-dependency-egress-proxy.cjs');
    await writeFile(lock, '{}\n', { mode: 0o600 });
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o600 });
    await writeFile(migration, 'SELECT 1;\n', { mode: 0o600 });
    await writeFile(dependencyEgressProxy, 'module.exports = {};\n', { mode: 0o600 });
    await chmod(versionRoot, 0o700);

    await makeTreeImmutable(versionRoot);

    expect((await lstat(lock)).mode & 0o7777).toBe(INSTALLED_BUILDER_LOCK_MODE);
    expect((await lstat(executable)).mode & 0o7777).toBe(0o555);
    expect((await lstat(migration)).mode & 0o7777).toBe(0o444);
    expect((await lstat(dependencyEgressProxy)).mode & 0o7777).toBe(0o444);
    expect((await lstat(operations)).mode & 0o7777).toBe(0o555);
    expect((await lstat(versionRoot)).mode & 0o7777).toBe(0o555);

    await chmod(data, 0o700);
    await chmod(join(versionRoot, 'api'), 0o700);
    await chmod(bin, 0o700);
    await chmod(operations, 0o700);
    await chmod(versionRoot, 0o700);
  });
});
