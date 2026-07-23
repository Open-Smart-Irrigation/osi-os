import { execFile as execFileCallback } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const GIT_EXECUTABLE = '/usr/bin/git';
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_OUTPUT_BYTES = 128 * 1024;
export const GIT_DIAGNOSTIC_BYTES = 64 * 1024;

export const FIXED_GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_ALLOW_PROTOCOL: 'ssh',
} as const);

const FIXED_SSH_ENV = Object.freeze({
  GIT_SSH_COMMAND: '/usr/bin/ssh -oBatchMode=yes -oIdentitiesOnly=no',
  GIT_SSH_VARIANT: 'ssh',
} as const);

export interface GitProcessResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface GitRunOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface GitProcessReply {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly outputLimit?: boolean;
}

export interface SshAuthSocketFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly realpath: (path: string) => Promise<string>;
}

export type GitExecFile = (
  executable: string,
  argv: readonly string[],
  options: Readonly<Record<string, unknown>>,
) => Promise<GitProcessReply>;

export class GitCommandError extends Error {
  readonly code: 'GIT_COMMAND_FAILED' | 'GIT_OUTPUT_LIMIT' | 'GIT_EXECUTION_FAILED' | 'GIT_COMMAND_TIMEOUT' | 'GIT_COMMAND_ABORTED' | 'GIT_SSH_AUTH_UNAVAILABLE';
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;

  constructor(input: {
    readonly code: GitCommandError['code'];
    readonly argv: readonly string[];
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly timedOut?: boolean;
    readonly aborted?: boolean;
    readonly redactions?: readonly string[];
  }) {
    super(input.code === 'GIT_OUTPUT_LIMIT' ? 'Git command output exceeded the configured bound.' : input.code === 'GIT_COMMAND_TIMEOUT' ? 'Git command timed out.' : input.code === 'GIT_COMMAND_ABORTED' ? 'Git command was aborted.' : input.code === 'GIT_SSH_AUTH_UNAVAILABLE' ? 'The configured SSH authentication agent is unavailable.' : 'Git command failed.');
    this.name = 'GitCommandError';
    this.code = input.code;
    const redactions = input.redactions ?? [];
    this.argv = Object.freeze(input.argv.map((value) => safeArgument(value, redactions)));
    this.exitCode = input.exitCode ?? null;
    this.signal = input.signal ?? null;
    this.stdout = safeDiagnostic(input.stdout ?? '', redactions);
    this.stderr = safeDiagnostic(input.stderr ?? '', redactions);
    this.timedOut = input.timedOut ?? false;
    this.aborted = input.aborted ?? false;
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function bounded(value: string, limit = GIT_MAX_OUTPUT_BYTES): boolean {
  return utf8Bytes(value) <= limit;
}

function truncateUtf8(value: string, limit: number): string {
  let result = '';
  let used = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (used + characterBytes > limit) break;
    result += character;
    used += characterBytes;
  }
  return result;
}

function safeDiagnostic(value: string, redactions: readonly string[] = []): string {
  if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----|(?:SSH_AUTH_SOCK|GIT_SSH_COMMAND|IdentityFile|passphrase)/iu.test(value)) return '[redacted]';
  const redacted = redactions.reduce((current, secret) => current.replaceAll(secret, '[redacted]'), value)
    .replaceAll(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@')
    .replaceAll(/(?:SSH_AUTH_SOCK|GIT_SSH_COMMAND|IdentityFile|private key|passphrase)[^\r\n]*/gi, '[redacted]');
  return truncateUtf8(redacted, GIT_DIAGNOSTIC_BYTES);
}

function safeArgument(value: string, redactions: readonly string[] = []): string {
  if (redactions.some((secret) => value.includes(secret))) return '[redacted]';
  return /(?:sshcommand|identityfile|private key|passphrase|password|-----BEGIN|(?:^|\/)\.ssh(?:\/|$))/iu.test(value)
    ? '[redacted]'
    : value;
}

function validateExecutable(executable: string): string {
  if (!executable.startsWith('/') || executable.includes('\0') || /[\u0001-\u001f\u007f]/u.test(executable)) {
    throw new TypeError('Git executable must be an absolute path without control characters.');
  }
  if (utf8Bytes(executable) > 4096) throw new TypeError('Git executable path is too long.');
  return executable;
}

function validateArgv(argv: readonly string[]): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError('Git argv must not be empty.');
  const result = [...argv];
  let total = 0;
  for (const arg of result) {
    if (typeof arg !== 'string' || arg.includes('\0') || /[\u0001-\u001f\u007f]/u.test(arg)) {
      throw new TypeError('Git arguments must be strings without control characters.');
    }
    if (utf8Bytes(arg) > 16 * 1024) throw new TypeError('Git argument is too long.');
    total += utf8Bytes(arg);
  }
  const hasTrustedGlobalConfig = result[0] === '-c' && result[1] === 'core.hooksPath=/dev/null';
  const commandIndex = hasTrustedGlobalConfig ? 2 : 0;
  const command = result[commandIndex];
  if (typeof command !== 'string' || command.startsWith('-')) throw new TypeError('Git command must follow the fixed global option boundary.');
  for (let index = 0; index < result.length; index += 1) {
    const arg = result[index]!;
    if (arg === '--config-env' || /^--config-env=/iu.test(arg)) throw new TypeError('Git config-env overrides are not allowed.');
    if (arg === '-c') {
      const config = result[index + 1];
      const isHookOrInclude = typeof config === 'string' && /^(?:core\.hookspath=|include(?:if)?\.)/iu.test(config);
      if (index === 0 && hasTrustedGlobalConfig) {
        index += 1;
      } else if (index < commandIndex || isHookOrInclude) {
        throw new TypeError(index < commandIndex ? 'Git global config override is not allowed.' : 'Git hook or include override is not allowed.');
      }
    } else if (arg.startsWith('-c')) {
      throw new TypeError('Git compact config override is not allowed.');
    }
  }
  if (total > 64 * 1024) throw new TypeError('Git argv is too large.');
  return result;
}

async function defaultExecFile(
  executable: string,
  argv: readonly string[],
  options: Readonly<Record<string, unknown>>,
): Promise<GitProcessReply> {
  try {
    const result = await execFile(executable, [...argv], options as Parameters<typeof execFile>[2]);
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
      exitCode: 0,
      signal: null,
    };
  } catch (error) {
    const failure = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
      name?: unknown;
    };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    return {
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      exitCode,
      signal: typeof failure.signal === 'string' ? failure.signal : null,
      timedOut: failure.code === 'ETIMEDOUT' || failure.killed === true,
      aborted: failure.code === 'ABORT_ERR' || failure.name === 'AbortError',
      outputLimit: failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    };
  }
}

export class GitCommand {
  readonly #executable: string;
  readonly #execFile: GitExecFile;
  readonly #sshAuthSock: string | null;
  readonly #socketFileSystem: SshAuthSocketFileSystem;

  constructor(options: { readonly executable?: string; readonly execFile?: GitExecFile; readonly sshAuthSock?: string | null; readonly sshAuthSocketFs?: Partial<SshAuthSocketFileSystem> } = {}) {
    this.#executable = validateExecutable(options.executable ?? GIT_EXECUTABLE);
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#sshAuthSock = options.sshAuthSock === undefined ? (process.env.SSH_AUTH_SOCK ?? null) : options.sshAuthSock;
    this.#socketFileSystem = Object.freeze({ lstat: options.sshAuthSocketFs?.lstat ?? lstat, realpath: options.sshAuthSocketFs?.realpath ?? realpath });
  }

  async run(argv: readonly string[], options: GitRunOptions = {}): Promise<GitProcessResult> {
    const safeArgv = validateArgv(argv);
    const started = Date.now();
    let reply: GitProcessReply;
    let environment: Readonly<Record<string, string>>;
    try {
      environment = await this.#buildEnvironment();
    } catch {
      throw new GitCommandError({ code: 'GIT_SSH_AUTH_UNAVAILABLE', argv: safeArgv, redactions: this.#sshAuthSock ? [this.#sshAuthSock] : [] });
    }
    try {
      reply = await this.#execFile(this.#executable, safeArgv, {
        cwd: options.cwd,
        env: environment,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
        signal: options.signal,
      });
    } catch {
      throw new GitCommandError({ code: 'GIT_EXECUTION_FAILED', argv: safeArgv, redactions: this.#sshAuthSock ? [this.#sshAuthSock] : [] });
    }

    if (reply.outputLimit || !bounded(reply.stdout) || !bounded(reply.stderr)) {
      throw new GitCommandError({ code: 'GIT_OUTPUT_LIMIT', argv: safeArgv, redactions: this.#sshAuthSock ? [this.#sshAuthSock] : [] });
    }

    const result: GitProcessResult = Object.freeze({
      argv: Object.freeze([...safeArgv]),
      exitCode: reply.exitCode,
      signal: reply.signal,
      stdout: reply.stdout,
      stderr: reply.stderr,
      durationMs: Math.max(0, Date.now() - started),
      timedOut: reply.timedOut ?? false,
      aborted: reply.aborted ?? false,
    });
    if (result.aborted || result.timedOut || result.exitCode !== 0) {
      throw new GitCommandError({
        code: result.aborted ? 'GIT_COMMAND_ABORTED' : result.timedOut ? 'GIT_COMMAND_TIMEOUT' : 'GIT_COMMAND_FAILED',
        argv: safeArgv,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        aborted: result.aborted,
        redactions: this.#sshAuthSock ? [this.#sshAuthSock] : [],
      });
    }
    return result;
  }

  async #buildEnvironment(): Promise<Readonly<Record<string, string>>> {
    const socket = await this.#validateSshAuthSocket();
    return Object.freeze({ ...FIXED_GIT_ENV, ...FIXED_SSH_ENV, ...(socket === null ? {} : { SSH_AUTH_SOCK: socket }) });
  }

  async #validateSshAuthSocket(): Promise<string | null> {
    const socket = this.#sshAuthSock;
    if (socket === null) return null;
    if (!socket.startsWith('/') || resolve(socket) !== socket || utf8Bytes(socket) > 4096 || /[\u0000-\u001f\u007f]/u.test(socket)) throw new Error('invalid SSH agent');
    const stats = await this.#socketFileSystem.lstat(socket);
    const canonical = await this.#socketFileSystem.realpath(socket);
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
    if (canonical !== socket || !stats.isSocket() || stats.uid !== effectiveUid) throw new Error('invalid SSH agent');
    return socket;
  }
}
