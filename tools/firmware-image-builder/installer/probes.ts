import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const GCC = '/usr/bin/gcc';
const MAKE = '/usr/bin/make';
const COMPILE_FLAGS = Object.freeze(['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror'] as const);
const PROBE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
});
const EXEC_OPTIONS = Object.freeze({
  env: PROBE_ENV,
  encoding: 'utf8' as const,
  timeout: 10_000,
  maxBuffer: 16 * 1024,
  windowsHide: true,
  shell: false,
});

export interface ProbeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError?: string;
}

export type ProbeExec = (
  executable: string,
  args: readonly string[],
  options: Readonly<Record<string, unknown>>,
) => Promise<ProbeCommandResult>;

export interface ProbeFileSystem {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly rm: (path: string, options: Readonly<{ recursive: true; force: true }>) => Promise<void>;
}

export type NativePrerequisiteResult =
  | Readonly<{
      readonly available: true;
      readonly code: 'HOST_PREREQUISITES_AVAILABLE';
      readonly detail: string;
      readonly mutation: 'none';
    }>
  | Readonly<{
      readonly available: false;
      readonly code: string;
      readonly detail: string;
      readonly mutation: 'none' | 'unknown';
    }>;

async function defaultExec(executable: string, args: readonly string[], options: Readonly<Record<string, unknown>>): Promise<ProbeCommandResult> {
  try {
    const result = await execFile(executable, [...args], options as Parameters<typeof execFile>[2]);
    return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0, signal: null };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown };
    return {
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      signal: typeof failure.signal === 'string' ? failure.signal : null,
      spawnError: typeof failure.code === 'string' ? failure.code : undefined,
    };
  }
}

const defaultFileSystem: ProbeFileSystem = Object.freeze({ mkdtemp, rm });

function unavailable(code: string, detail: string): NativePrerequisiteResult {
  return Object.freeze({ available: false, code, detail, mutation: 'none' });
}

function cleanupUnproven(): NativePrerequisiteResult {
  return Object.freeze({
    available: false,
    code: 'PROBE_CLEANUP_FAILED',
    detail: 'private probe scratch cleanup could not be proven',
    mutation: 'unknown',
  });
}

function compileFailure(result: ProbeCommandResult): NativePrerequisiteResult | null {
  if (result.exitCode === 0 && result.signal === null && result.spawnError === undefined) return null;
  if (result.spawnError === 'ENOENT') {
    return unavailable('GCC_MISSING', 'required compiler /usr/bin/gcc is unavailable');
  }
  if (/fatal error: [^:\r\n]+\.h: No such file or directory/.test(result.stderr)) {
    return unavailable('LIBC_HEADERS_MISSING', 'required libc or Linux filesystem headers are unavailable');
  }
  return unavailable('PROBE_COMPILE_FAILED', 'native prerequisite probe compilation failed');
}

interface NativeProbeEvidence {
  readonly available: boolean;
  readonly code: string;
  readonly collision?: Readonly<{
    readonly errno: string;
    readonly sourceUnchanged: boolean;
    readonly destinationUnchanged: boolean;
  }>;
}

function parseEvidence(result: ProbeCommandResult): NativeProbeEvidence | null {
  if (result.spawnError !== undefined || result.signal !== null || ![0, 2].includes(result.exitCode ?? -1)) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.available !== 'boolean' || typeof value.code !== 'string' || value.code.length < 1 || value.code.length > 64) return null;
    if ((value.available && result.exitCode !== 0) || (!value.available && result.exitCode !== 2)) return null;
    return value as unknown as NativeProbeEvidence;
  } catch {
    return null;
  }
}

function mappedEvidence(evidence: NativeProbeEvidence): NativePrerequisiteResult | null {
  if (evidence.available) return null;
  switch (evidence.code) {
  case 'GCC_MISSING':
    return unavailable('GCC_MISSING', 'required compiler /usr/bin/gcc is unavailable');
  case 'LIBC_HEADERS_MISSING':
    return unavailable('LIBC_HEADERS_MISSING', 'required libc or Linux filesystem headers are unavailable');
  case 'MAKE_MISSING':
    return unavailable('MAKE_MISSING', 'required build tool /usr/bin/make is unavailable');
  case 'LINUX_RENAMEAT2_MISSING':
  case 'LINUX_RENAMEAT2_UNAVAILABLE':
    return unavailable('LINUX_RENAMEAT2_UNAVAILABLE', 'Linux renameat2 is unavailable');
  case 'RENAME_NOREPLACE_UNAVAILABLE':
    return unavailable('RENAME_NOREPLACE_UNAVAILABLE', 'RENAME_NOREPLACE is unavailable');
  case 'FILESYSTEM_UNSUPPORTED':
    return unavailable('FILESYSTEM_UNSUPPORTED', 'selected filesystem does not support RENAME_NOREPLACE');
  case 'FILESYSTEM_UNAVAILABLE':
    return unavailable('FILESYSTEM_UNAVAILABLE', 'selected filesystem cannot run the rename probe');
  case 'PROBE_CLEANUP_FAILED':
    return cleanupUnproven();
  default:
    return unavailable('PROBE_OUTPUT_INVALID', 'native prerequisite probe returned malformed evidence');
  }
}

export async function runNativePrerequisiteProbes(options: {
  readonly scratchParent: string;
  readonly sourceDirectory?: string;
  readonly dependencies?: Readonly<{
    readonly exec?: ProbeExec;
    readonly fs?: ProbeFileSystem;
  }>;
}): Promise<NativePrerequisiteResult> {
  if (typeof options.scratchParent !== 'string' || !isAbsolute(options.scratchParent) || options.scratchParent.includes('\0')) {
    return unavailable('SCRATCH_PARENT_INVALID', 'selected-filesystem scratch parent must be absolute');
  }
  const sourceDirectory = options.sourceDirectory ?? new URL('.', import.meta.url).pathname;
  const execute = options.dependencies?.exec ?? defaultExec;
  const fileSystem = options.dependencies?.fs ?? defaultFileSystem;
  const compileScratch = await fileSystem.mkdtemp(join(tmpdir(), 'osi-image-builder-probes-'));
  try {
    const hostBinary = join(compileScratch, 'probe-host');
    const compile = await execute(
      GCC,
      [...COMPILE_FLAGS, join(sourceDirectory, 'probe-host.c'), '-o', hostBinary],
      EXEC_OPTIONS,
    );
    const failure = compileFailure(compile);
    if (failure !== null) return failure;
    const make = await execute(MAKE, ['--version'], EXEC_OPTIONS);
    if (make.spawnError === 'ENOENT') {
      return unavailable('MAKE_MISSING', 'required build tool /usr/bin/make is unavailable');
    }
    if (make.exitCode !== 0 || make.signal !== null || make.spawnError !== undefined) {
      return unavailable('MAKE_MISSING', 'required build tool /usr/bin/make is unavailable');
    }
    const host = parseEvidence(await execute(hostBinary, [], EXEC_OPTIONS));
    if (host === null) return unavailable('PROBE_OUTPUT_INVALID', 'native prerequisite probe returned malformed evidence');
    const hostFailure = mappedEvidence(host);
    if (hostFailure !== null) return hostFailure;
    if (host.code !== 'HOST_PREREQUISITES_AVAILABLE') {
      return unavailable('PROBE_OUTPUT_INVALID', 'native prerequisite probe returned malformed evidence');
    }

    const renameBinary = join(compileScratch, 'probe-renameat2');
    const renameCompile = compileFailure(await execute(
      GCC,
      [...COMPILE_FLAGS, join(sourceDirectory, 'probe-renameat2.c'), '-o', renameBinary],
      EXEC_OPTIONS,
    ));
    if (renameCompile !== null) return renameCompile;
    const rename = parseEvidence(await execute(renameBinary, [options.scratchParent], EXEC_OPTIONS));
    if (rename === null) return unavailable('PROBE_OUTPUT_INVALID', 'native prerequisite probe returned malformed evidence');
    const renameFailure = mappedEvidence(rename);
    if (renameFailure !== null) return renameFailure;
    if (rename.code !== 'RENAME_NOREPLACE_AVAILABLE'
      || rename.collision?.errno !== 'EEXIST'
      || rename.collision.sourceUnchanged !== true
      || rename.collision.destinationUnchanged !== true) {
      return unavailable('PROBE_OUTPUT_INVALID', 'native prerequisite probe returned malformed evidence');
    }
    return Object.freeze({
      available: true,
      code: 'HOST_PREREQUISITES_AVAILABLE',
      detail: 'native host and selected filesystem prerequisites are available',
      mutation: 'none',
    });
  } finally {
    await fileSystem.rm(compileScratch, { recursive: true, force: true });
  }
}
