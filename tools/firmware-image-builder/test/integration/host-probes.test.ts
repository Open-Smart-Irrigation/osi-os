import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runNativePrerequisiteProbes } from '../../installer/probes.js';

const temporaryDirectories: string[] = [];

async function snapshotTree(root: string): Promise<readonly unknown[]> {
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return [entry.name, await snapshotTree(path)];
    return [entry.name, (await readFile(path)).toString('base64')];
  }));
}

describe('real native host probes', () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('executes the production adapter on the approved-output filesystem without mutation or skip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-host-integration-'));
    temporaryDirectories.push(root);
    const selection = join(root, 'selection.json');
    const output = join(root, 'approved-output');
    await mkdir(output);
    await writeFile(selection, '{"selected":"old-version"}\n');
    await writeFile(join(output, 'release.bin'), 'immutable fixture\n');
    const beforeSelection = await readFile(selection);
    const beforeOutput = await snapshotTree(output);
    const result = await runNativePrerequisiteProbes({ scratchParent: output });
    expect(typeof result.available).toBe('boolean');
    if (result.code === 'PROBE_CLEANUP_FAILED') expect(result.mutation).toBe('unknown');
    else expect(result.mutation).toBe('none');
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail.length).toBeLessThanOrEqual(240);
    if (result.available) expect(result.code).toBe('HOST_PREREQUISITES_AVAILABLE');
    else expect([
      'GCC_MISSING',
      'LIBC_HEADERS_MISSING',
      'MAKE_MISSING',
      'LINUX_RENAMEAT2_UNAVAILABLE',
      'RENAME_NOREPLACE_UNAVAILABLE',
      'FILESYSTEM_UNSUPPORTED',
      'FILESYSTEM_UNAVAILABLE',
      'PROBE_COMPILE_FAILED',
      'PROBE_OUTPUT_INVALID',
      'PROBE_CLEANUP_FAILED',
    ]).toContain(result.code);
    expect(await readFile(selection)).toEqual(beforeSelection);
    expect(await snapshotTree(output)).toEqual(beforeOutput);
  });
});
