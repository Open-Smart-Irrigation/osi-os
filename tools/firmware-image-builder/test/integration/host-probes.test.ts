import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const installer = new URL('../../installer/', import.meta.url).pathname;
const hostSource = join(installer, 'probe-host.c');
const renameSource = join(installer, 'probe-renameat2.c');
const flags = ['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror'];

type ProbeResult = Readonly<{
  readonly available: boolean;
  readonly code: string;
  readonly detail: string;
  readonly prerequisites?: Readonly<Record<string, Readonly<{ readonly available: boolean; readonly code: string; readonly detail: string }>>>;
  readonly collision?: Readonly<{ readonly errno: string; readonly sourceUnchanged: boolean; readonly destinationUnchanged: boolean }>;
}>;

async function compile(source: string, binary: string): Promise<void> {
  await execFile('/usr/bin/gcc', [...flags, source, '-o', binary], { maxBuffer: 64 * 1024 });
}

async function run(binary: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<{ readonly exitCode: number; readonly result: ProbeResult }> {
  try {
    const output = await execFile(binary, [...args], { env, maxBuffer: 64 * 1024 });
    return { exitCode: 0, result: JSON.parse(output.stdout) as ProbeResult };
  } catch (error) {
    const child = error as { readonly code?: number | string; readonly stdout?: string };
    if (typeof child.stdout !== 'string') throw error;
    return { exitCode: typeof child.code === 'number' ? child.code : 2, result: JSON.parse(child.stdout) as ProbeResult };
  }
}

async function snapshotTree(root: string): Promise<readonly unknown[]> {
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return [entry.name, await snapshotTree(path)];
    return [entry.name, (await readFile(path)).toString('base64')];
  }));
}

describe('real native host probes', () => {
  it('compiles and executes host prerequisites without mutating installer fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-host-integration-'));
    const selection = join(root, 'selection.json');
    const output = join(root, 'approved-output');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(output));
    await writeFile(selection, '{"selected":"old-version"}\n');
    await writeFile(join(output, 'release.bin'), 'immutable fixture\n');
    const beforeSelection = await readFile(selection);
    const beforeOutput = await snapshotTree(output);
    const binary = join(root, 'probe-host');
    await compile(hostSource, binary);
    const result = await run(binary, [], process.env);

    expect([0, 2]).toContain(result.exitCode);
    expect(typeof result.result.available).toBe('boolean');
    expect(result.result.detail.length).toBeGreaterThan(0);
    expect(result.result.detail.length).toBeLessThanOrEqual(240);
    if (result.result.available) {
      expect(result.exitCode).toBe(0);
      expect(result.result.code).toBe('HOST_PREREQUISITES_AVAILABLE');
      expect(result.result.prerequisites?.gcc.available).toBe(true);
      expect(result.result.prerequisites?.libcHeaders.available).toBe(true);
      expect(result.result.prerequisites?.make.available).toBe(true);
      expect(result.result.prerequisites?.linuxRenameat2.available).toBe(true);
    } else {
      expect(result.exitCode).toBe(2);
      expect(['GCC_MISSING', 'LIBC_HEADERS_MISSING', 'MAKE_MISSING', 'LINUX_RENAMEAT2_MISSING', 'HOST_PREREQUISITE_UNAVAILABLE']).toContain(result.result.code);
    }
    expect(await readFile(selection)).toEqual(beforeSelection);
    expect(await snapshotTree(output)).toEqual(beforeOutput);
    await rm(root, { recursive: true, force: true });
  });

  it('executes the filesystem probe and returns support evidence or typed unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-rename-integration-'));
    const selection = join(root, 'selection.json');
    const output = join(root, 'approved-output');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(output));
    await writeFile(selection, '{"selected":"old-version"}\n');
    await writeFile(join(output, 'release.bin'), 'immutable fixture\n');
    const beforeSelection = await readFile(selection);
    const beforeOutput = await snapshotTree(output);
    const binary = join(root, 'probe-renameat2');
    await compile(renameSource, binary);
    const result = await run(binary, [root], process.env);

    expect([0, 2]).toContain(result.exitCode);
    expect(typeof result.result.available).toBe('boolean');
    expect(result.result.detail.length).toBeGreaterThan(0);
    expect(result.result.detail.length).toBeLessThanOrEqual(240);
    if (result.result.available) {
      expect(result.exitCode).toBe(0);
      expect(result.result.code).toBe('RENAME_NOREPLACE_AVAILABLE');
      expect(result.result.collision).toEqual({ errno: 'EEXIST', sourceUnchanged: true, destinationUnchanged: true });
    } else {
      expect(result.exitCode).toBe(2);
      expect(['LINUX_RENAMEAT2_UNAVAILABLE', 'RENAME_NOREPLACE_UNAVAILABLE', 'FILESYSTEM_UNSUPPORTED', 'FILESYSTEM_UNAVAILABLE']).toContain(result.result.code);
    }
    expect(await readFile(selection)).toEqual(beforeSelection);
    expect(await snapshotTree(output)).toEqual(beforeOutput);
    await rm(root, { recursive: true, force: true });
  });
});
