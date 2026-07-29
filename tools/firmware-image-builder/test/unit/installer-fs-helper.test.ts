import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireInstallLock } from '../../installer/production.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

async function compileHelper(): Promise<Readonly<{ root: string; helper: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'installer-fs-helper-test-'));
  directories.push(root);
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
  return { root, helper };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe('production installer filesystem helper', () => {
  it('commits with kernel no-replace semantics and preserves a collision', async () => {
    const { root, helper } = await compileHelper();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await writeFile(source, 'new\n');
    await writeFile(destination, 'existing\n');

    await expect(execFile(helper, [
      'rename-noreplace',
      source,
      destination,
    ])).rejects.toMatchObject({ code: 1 });
    await expect(readFile(source, 'utf8')).resolves.toBe('new\n');
    await expect(readFile(destination, 'utf8')).resolves.toBe('existing\n');

    await rm(destination);
    await expect(execFile(helper, [
      'rename-noreplace',
      source,
      destination,
    ])).resolves.toBeDefined();
    await expect(readFile(destination, 'utf8')).resolves.toBe('new\n');
  });

  it('releases the process-held install lock and permits restart after termination', async () => {
    const { root, helper } = await compileHelper();
    const lockPath = join(root, 'install.lock');
    const release = await acquireInstallLock(helper, lockPath);

    await expect(acquireInstallLock(helper, lockPath)).rejects.toThrow(
      /another installer|code=3/u,
    );
    await release();

    const releaseRestarted = await acquireInstallLock(helper, lockPath);
    await expect(releaseRestarted()).resolves.toBeUndefined();
  });
});
