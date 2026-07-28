import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { runNativePrerequisiteProbes } from '../../installer/probes.js';

const execFile = promisify(execFileCallback);
const installer = new URL('../../installer/', import.meta.url).pathname;
const hostSource = join(installer, 'probe-host.c');
const renameSource = join(installer, 'probe-renameat2.c');
const flags = ['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror'];
const temporaryDirectories: string[] = [];

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

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createMutationFixture(): Promise<{ readonly root: string; readonly selection: string; readonly output: string }> {
  const root = await temporaryDirectory('osi-image-builder-probe-unit-');
  const selection = join(root, 'selection.json');
  const output = join(root, 'approved-output');
  await writeFile(selection, '{"selected":"old-version"}\n');
  await mkdir(output);
  await writeFile(join(output, 'release.bin'), 'immutable fixture\n');
  return { root, selection, output };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('native host probes', () => {
  it('compiles both probes with the required C17 warning-as-error contract', async () => {
    const root = await temporaryDirectory('osi-image-builder-probe-build-');
    await expect(compile(hostSource, join(root, 'probe-host'))).resolves.toBeUndefined();
    await expect(compile(renameSource, join(root, 'probe-renameat2'))).resolves.toBeUndefined();
  });

  it('requires exactly one absolute selected-filesystem scratch parent', async () => {
    const root = await temporaryDirectory('osi-image-builder-probe-argv-');
    const binary = join(root, 'probe-renameat2');
    await compile(renameSource, binary);

    for (const args of [[], ['relative-output'], ['/tmp', '/tmp']] as const) {
      const result = await run(binary, args);
      expect(result.exitCode).not.toBe(0);
      expect(result.result).toMatchObject({
        available: false,
        code: 'SCRATCH_PARENT_INVALID',
        detail: 'exactly one absolute scratch parent is required',
      });
    }
  });

  it('returns typed host evidence and never writes selection or approved output', async () => {
    const fixture = await createMutationFixture();
    const beforeSelection = await readFile(fixture.selection);
    const beforeOutput = await snapshotTree(fixture.output);
    const root = await temporaryDirectory('osi-image-builder-probe-host-');
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
    const root = await temporaryDirectory('osi-image-builder-probe-rename-');
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
    const root = await temporaryDirectory('osi-image-builder-probe-unsupported-');
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

  it('cleans the approved-output scratch tree after a post-creation ENOSYS failure', async () => {
    const fixture = await createMutationFixture();
    const beforeOutput = await snapshotTree(fixture.output);
    const buildRoot = await temporaryDirectory('osi-image-builder-probe-enosys-');
    const binary = join(buildRoot, 'probe-renameat2-enosys');
    await execFile('/usr/bin/gcc', [
      ...flags,
      '-DPROBE_TEST_FORCE_ENOSYS_AFTER_CREATE',
      renameSource,
      '-o',
      binary,
    ], { maxBuffer: 64 * 1024 });

    const result = await run(binary, [fixture.output]);

    expect(result.exitCode).toBe(2);
    expect(result.result).toMatchObject({
      available: false,
      code: 'LINUX_RENAMEAT2_UNAVAILABLE',
      detail: 'Linux kernel does not expose renameat2',
    });
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });

  it('overrides support evidence when scratch cleanup cannot be proven', async () => {
    const fixture = await createMutationFixture();
    const beforeOutput = await snapshotTree(fixture.output);
    const buildRoot = await temporaryDirectory('osi-image-builder-probe-cleanup-');
    const binary = join(buildRoot, 'probe-renameat2-cleanup-failure');
    await execFile('/usr/bin/gcc', [
      ...flags,
      '-DPROBE_TEST_FORCE_CLEANUP_FAILURE',
      renameSource,
      '-o',
      binary,
    ], { maxBuffer: 64 * 1024 });

    const result = await run(binary, [fixture.output]);

    expect(result.exitCode).toBe(2);
    expect(result.result).toMatchObject({
      available: false,
      code: 'PROBE_CLEANUP_FAILED',
      detail: 'private probe scratch cleanup failed',
    });
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });

  it('returns typed unavailable when private compile scratch cannot be created', async () => {
    let executions = 0;
    let removals = 0;

    const result = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      dependencies: {
        fs: {
          mkdtemp: async () => { throw new Error('sensitive filesystem failure'); },
          rm: async () => { removals += 1; },
        },
        exec: async () => {
          executions += 1;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'COMPILE_SCRATCH_UNAVAILABLE',
      detail: 'private compile scratch could not be created',
      mutation: 'none',
    });
    expect({ executions, removals }).toEqual({ executions: 0, removals: 0 });
  });

  it('overrides successful probe evidence when compile-scratch teardown fails', async () => {
    const result = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      sourceDirectory: installer,
      dependencies: {
        fs: {
          mkdtemp: async () => '/private/compile-teardown',
          rm: async () => { throw new Error('sensitive teardown failure'); },
        },
        exec: async (executable, args) => {
          if (executable === '/usr/bin/gcc' || executable === '/usr/bin/make') {
            return { stdout: '', stderr: '', exitCode: 0, signal: null };
          }
          if (args.length === 0) {
            return {
              stdout: JSON.stringify({ available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'ok' }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          return {
            stdout: JSON.stringify({
              available: true,
              code: 'RENAME_NOREPLACE_AVAILABLE',
              detail: 'ok',
              collision: { errno: 'EEXIST', sourceUnchanged: true, destinationUnchanged: true },
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'PROBE_CLEANUP_FAILED',
      detail: 'private probe scratch cleanup could not be proven',
      mutation: 'unknown',
    });
  });

  it('removes adapter-owned selected-filesystem scratch after a signalled child leaves contents', async () => {
    const fixture = await createMutationFixture();
    const beforeOutput = await snapshotTree(fixture.output);
    let nativeScratchParent: string | undefined;

    const result = await runNativePrerequisiteProbes({
      scratchParent: fixture.output,
      sourceDirectory: installer,
      dependencies: {
        exec: async (executable, args) => {
          if (executable === '/usr/bin/gcc' || executable === '/usr/bin/make') {
            return { stdout: '', stderr: '', exitCode: 0, signal: null };
          }
          if (args.length === 0) {
            return {
              stdout: JSON.stringify({ available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'ok' }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          nativeScratchParent = args[0];
          const abandoned = join(nativeScratchParent!, 'osi-image-builder-probe-child', 'nested');
          await mkdir(abandoned, { recursive: true });
          await writeFile(join(abandoned, 'leftover.bin'), 'child crashed\n');
          return { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL' };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'FILESYSTEM_PROBE_FAILED',
      detail: 'selected-filesystem probe process did not complete',
      mutation: 'none',
    });
    expect(nativeScratchParent).toBeDefined();
    expect(dirname(nativeScratchParent!)).toBe(fixture.output);
    expect(nativeScratchParent).not.toBe(fixture.output);
    expect(nativeScratchParent).toContain('.osi-image-builder-probe-');
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });

  it('does not run the filesystem probe when selected-filesystem wrapper creation fails', async () => {
    let scratchCreations = 0;
    let filesystemProbeExecutions = 0;
    const removals: string[] = [];

    const result = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      sourceDirectory: installer,
      dependencies: {
        fs: {
          mkdtemp: async () => {
            scratchCreations += 1;
            if (scratchCreations === 1) return '/private/compile-wrapper-create';
            throw new Error('selected filesystem rejected wrapper');
          },
          rm: async (path) => { removals.push(path); },
        },
        exec: async (executable, args) => {
          if (executable === '/usr/bin/gcc' || executable === '/usr/bin/make') {
            return { stdout: '', stderr: '', exitCode: 0, signal: null };
          }
          if (args.length === 0) {
            return {
              stdout: JSON.stringify({ available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'ok' }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          filesystemProbeExecutions += 1;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'FILESYSTEM_PROBE_SCRATCH_UNAVAILABLE',
      detail: 'selected-filesystem probe scratch could not be created',
      mutation: 'none',
    });
    expect(filesystemProbeExecutions).toBe(0);
    expect(removals).toEqual(['/private/compile-wrapper-create']);
  });

  it('reports unknown mutation when selected-filesystem wrapper removal fails', async () => {
    let scratchCreations = 0;
    const removals: string[] = [];
    const wrapper = '/approved-output/.osi-image-builder-probe-wrapper';

    const result = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      sourceDirectory: installer,
      dependencies: {
        fs: {
          mkdtemp: async () => {
            scratchCreations += 1;
            return scratchCreations === 1 ? '/private/compile-wrapper-remove' : wrapper;
          },
          rm: async (path) => {
            removals.push(path);
            if (path === wrapper) throw new Error('wrapper removal failed');
          },
        },
        exec: async (executable, args) => {
          if (executable === '/usr/bin/gcc' || executable === '/usr/bin/make') {
            return { stdout: '', stderr: '', exitCode: 0, signal: null };
          }
          if (args.length === 0) {
            return {
              stdout: JSON.stringify({ available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'ok' }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          expect(args).toEqual([wrapper]);
          return { stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM' };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'PROBE_CLEANUP_FAILED',
      detail: 'private probe scratch cleanup could not be proven',
      mutation: 'unknown',
    });
    expect(removals).toEqual([wrapper, '/private/compile-wrapper-remove']);
  });

  it('maps a missing fixed GCC to typed unavailable and cleans compile scratch', async () => {
    const calls: Array<{ readonly executable: string; readonly args: readonly string[]; readonly options: Readonly<Record<string, unknown>> }> = [];
    const removals: string[] = [];

    const result = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      sourceDirectory: installer,
      dependencies: {
        fs: {
          mkdtemp: async () => '/private/compile-scratch',
          rm: async (path) => { removals.push(path); },
        },
        exec: async (executable, args, options) => {
          calls.push({ executable, args, options });
          return { stdout: '', stderr: '', exitCode: null, signal: null, spawnError: 'ENOENT' };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'GCC_MISSING',
      detail: 'required compiler /usr/bin/gcc is unavailable',
      mutation: 'none',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: '/usr/bin/gcc',
      args: ['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', join(installer, 'probe-host.c'), '-o', '/private/compile-scratch/probe-host'],
      options: {
        env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' },
        timeout: 10_000,
        maxBuffer: 16 * 1024,
        shell: false,
      },
    });
    expect(removals).toEqual(['/private/compile-scratch']);
  });

  it('maps a required header compile failure without mutating selection or output', async () => {
    const fixture = await createMutationFixture();
    const beforeSelection = await readFile(fixture.selection);
    const beforeOutput = await snapshotTree(fixture.output);
    const removals: string[] = [];

    const result = await runNativePrerequisiteProbes({
      scratchParent: fixture.output,
      sourceDirectory: installer,
      dependencies: {
        fs: {
          mkdtemp: async () => '/private/header-compile',
          rm: async (path) => { removals.push(path); },
        },
        exec: async () => ({
          stdout: '',
          stderr: 'probe-host.c: fatal error: linux/fs.h: No such file or directory\n',
          exitCode: 1,
          signal: null,
        }),
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'LIBC_HEADERS_MISSING',
      detail: 'required libc or Linux filesystem headers are unavailable',
      mutation: 'none',
    });
    expect(removals).toEqual(['/private/header-compile']);
    expect(await readFile(fixture.selection)).toEqual(beforeSelection);
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });

  it('maps a missing absolute make executable and keeps the environment fixed', async () => {
    const calls: Array<{ readonly executable: string; readonly args: readonly string[]; readonly options: Readonly<Record<string, unknown>> }> = [];
    const result = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      sourceDirectory: installer,
      dependencies: {
        fs: {
          mkdtemp: async () => '/private/make-probe',
          rm: async () => undefined,
        },
        exec: async (executable, args, options) => {
          calls.push({ executable, args, options });
          if (executable === '/usr/bin/make') {
            return { stdout: '', stderr: '', exitCode: null, signal: null, spawnError: 'ENOENT' };
          }
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'MAKE_MISSING',
      detail: 'required build tool /usr/bin/make is unavailable',
      mutation: 'none',
    });
    expect(calls.map(({ executable, args }) => [executable, args])).toEqual([
      ['/usr/bin/gcc', ['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', join(installer, 'probe-host.c'), '-o', '/private/make-probe/probe-host']],
      ['/usr/bin/make', ['--version']],
    ]);
    expect(calls[1]?.options).toMatchObject({
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' },
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      shell: false,
    });
  });

  it.each([
    ['LINUX_RENAMEAT2_UNAVAILABLE', 'LINUX_RENAMEAT2_MISSING', true],
    ['RENAME_NOREPLACE_UNAVAILABLE', 'RENAME_NOREPLACE_UNAVAILABLE', false],
    ['FILESYSTEM_UNSUPPORTED', 'FILESYSTEM_UNSUPPORTED', false],
  ] as const)('maps %s probe evidence with zero fixture mutation', async (expectedCode, emittedCode, failAtHost) => {
    const fixture = await createMutationFixture();
    const beforeSelection = await readFile(fixture.selection);
    const beforeOutput = await snapshotTree(fixture.output);
    const removals: string[] = [];
    let compiled = 0;

    const result = await runNativePrerequisiteProbes({
      scratchParent: fixture.output,
      sourceDirectory: installer,
      dependencies: {
        fs: {
          mkdtemp: async () => '/private/mapping-probe',
          rm: async (path) => { removals.push(path); },
        },
        exec: async (executable, args) => {
          if (executable === '/usr/bin/gcc') {
            compiled += 1;
            return { stdout: '', stderr: '', exitCode: 0, signal: null };
          }
          if (executable === '/usr/bin/make') return { stdout: 'GNU Make', stderr: '', exitCode: 0, signal: null };
          if (args.length === 0) {
            return {
              stdout: JSON.stringify(failAtHost
                ? { available: false, code: emittedCode, detail: 'untrusted detail' }
                : { available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'ok' }),
              stderr: '',
              exitCode: failAtHost ? 2 : 0,
              signal: null,
            };
          }
          return {
            stdout: JSON.stringify({ available: false, code: emittedCode, detail: 'untrusted detail' }),
            stderr: '',
            exitCode: 2,
            signal: null,
          };
        },
      },
    });

    expect(result).toMatchObject({ available: false, code: expectedCode, mutation: 'none' });
    expect(result.detail).not.toContain('untrusted');
    expect(compiled).toBe(failAtHost ? 1 : 2);
    expect(removals).toEqual(failAtHost
      ? ['/private/mapping-probe']
      : ['/private/mapping-probe', '/private/mapping-probe']);
    expect(await readFile(fixture.selection)).toEqual(beforeSelection);
    expect(await snapshotTree(fixture.output)).toEqual(beforeOutput);
  });

  it('preserves cleanup failure evidence without claiming zero mutation', async () => {
    const result = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      sourceDirectory: installer,
      dependencies: {
        fs: { mkdtemp: async () => '/private/cleanup-map', rm: async () => undefined },
        exec: async (executable, args) => {
          if (executable === '/usr/bin/gcc' || executable === '/usr/bin/make') {
            return { stdout: '', stderr: '', exitCode: 0, signal: null };
          }
          if (args.length === 0) {
            return {
              stdout: JSON.stringify({ available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'ok' }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          return {
            stdout: JSON.stringify({ available: false, code: 'PROBE_CLEANUP_FAILED', detail: 'untrusted detail' }),
            stderr: '',
            exitCode: 2,
            signal: null,
          };
        },
      },
    });

    expect(result).toEqual({
      available: false,
      code: 'PROBE_CLEANUP_FAILED',
      detail: 'private probe scratch cleanup could not be proven',
      mutation: 'unknown',
    });
  });

  it('fails closed on malformed probe output and rejects a relative adapter scratch parent', async () => {
    let executions = 0;
    let scratchCreates = 0;
    const relative = await runNativePrerequisiteProbes({
      scratchParent: 'relative-output',
      dependencies: {
        fs: {
          mkdtemp: async () => { scratchCreates += 1; return '/unused'; },
          rm: async () => undefined,
        },
        exec: async () => { executions += 1; return { stdout: '', stderr: '', exitCode: 0, signal: null }; },
      },
    });
    expect(relative).toEqual({
      available: false,
      code: 'SCRATCH_PARENT_INVALID',
      detail: 'selected-filesystem scratch parent must be absolute',
      mutation: 'none',
    });
    expect({ executions, scratchCreates }).toEqual({ executions: 0, scratchCreates: 0 });

    const malformed = await runNativePrerequisiteProbes({
      scratchParent: '/approved-output',
      sourceDirectory: installer,
      dependencies: {
        fs: { mkdtemp: async () => '/private/malformed', rm: async () => undefined },
        exec: async (executable, args) => {
          if (executable === '/usr/bin/gcc' || executable === '/usr/bin/make') {
            return { stdout: '', stderr: '', exitCode: 0, signal: null };
          }
          return { stdout: '{not-json', stderr: '', exitCode: 0, signal: null };
        },
      },
    });
    expect(malformed).toEqual({
      available: false,
      code: 'PROBE_OUTPUT_INVALID',
      detail: 'native prerequisite probe returned malformed evidence',
      mutation: 'none',
    });
  });
});
