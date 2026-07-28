import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function createMutationFixture(): Promise<{ readonly root: string; readonly selection: string; readonly output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-probe-unit-'));
  const selection = join(root, 'selection.json');
  const output = join(root, 'approved-output');
  await stat(root);
  await writeFile(selection, '{"selected":"old-version"}\n');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(output));
  await writeFile(join(output, 'release.bin'), 'immutable fixture\n');
  return { root, selection, output };
}

describe('native host probes', () => {
  it('compiles both probes with the required C17 warning-as-error contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-probe-build-'));
    await expect(compile(hostSource, join(root, 'probe-host'))).resolves.toBeUndefined();
    await expect(compile(renameSource, join(root, 'probe-renameat2'))).resolves.toBeUndefined();
  });

  it('returns typed host evidence and never writes selection or approved output', async () => {
    const fixture = await createMutationFixture();
    const beforeSelection = await readFile(fixture.selection);
    const beforeOutput = await snapshotTree(fixture.output);
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-probe-host-'));
    const binary = join(root, 'probe-host');
    await compile(hostSource, binary);

    const result = await run(binary, [], { ...process.env, PATH: '/definitely-missing' });
    expect(result.exitCode).toBe(2);
    expect(result.result.available).toBe(false);
    expect(['GCC_MISSING', 'MAKE_MISSING', 'HOST_PREREQUISITE_UNAVAILABLE']).toContain(result.result.code);
    expect(result.result.detail.length).toBeGreaterThan(0);
    expect(result.result.detail.length).toBeLessThanOrEqual(240);
    expect(result.result.prerequisites).toBeDefined();
    expect(result.result.prerequisites?.gcc.available).toBe(false);
    expect(result.result.prerequisites?.make.available).toBe(false);
    expect(await readFile(fixture.selection)).toEqual(beforeSelection);
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });

  it('executes RENAME_NOREPLACE and proves an existing destination is unchanged', async () => {
    const fixture = await createMutationFixture();
    const beforeSelection = await readFile(fixture.selection);
    const beforeOutput = await snapshotTree(fixture.output);
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-probe-rename-'));
    const binary = join(root, 'probe-renameat2');
    await compile(renameSource, binary);

    const result = await run(binary, [root]);
    if (result.result.available) {
      expect(result.exitCode).toBe(0);
      expect(result.result.code).toBe('RENAME_NOREPLACE_AVAILABLE');
      expect(result.result.collision).toEqual({ errno: 'EEXIST', sourceUnchanged: true, destinationUnchanged: true });
    } else {
      expect(result.exitCode).toBe(2);
      expect(['LINUX_RENAMEAT2_UNAVAILABLE', 'RENAME_NOREPLACE_UNAVAILABLE', 'FILESYSTEM_UNSUPPORTED', 'FILESYSTEM_UNAVAILABLE']).toContain(result.result.code);
      expect(result.result.detail.length).toBeLessThanOrEqual(240);
    }
    expect(await readFile(fixture.selection)).toEqual(beforeSelection);
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });

  it('reports an unsupported scratch filesystem as typed unavailable with zero mutation', async () => {
    const fixture = await createMutationFixture();
    const beforeSelection = await readFile(fixture.selection);
    const beforeOutput = await snapshotTree(fixture.output);
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-probe-unsupported-'));
    const binary = join(root, 'probe-renameat2');
    await compile(renameSource, binary);

    const result = await run(binary, ['/proc']);
    expect(result.exitCode).toBe(2);
    expect(result.result.available).toBe(false);
    expect(['FILESYSTEM_UNSUPPORTED', 'FILESYSTEM_UNAVAILABLE']).toContain(result.result.code);
    expect(result.result.detail.length).toBeLessThanOrEqual(240);
    expect(await readFile(fixture.selection)).toEqual(beforeSelection);
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });
});
