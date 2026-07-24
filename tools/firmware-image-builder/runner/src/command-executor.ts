import { spawn } from 'node:child_process';

export interface CommandResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface CommandRunOptions {
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxCaptureBytes?: number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface CommandExecutor {
  run(argv: readonly string[], options: CommandRunOptions): Promise<CommandResult>;
}

export class CommandExecutionError extends Error {
  readonly code: string | number | undefined;
  readonly result: CommandResult | null;

  constructor(message: string, options: { readonly code?: string | number; readonly result?: CommandResult | null; readonly cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'CommandExecutionError';
    this.code = options.code;
    this.result = options.result ?? null;
  }
}

function appendBounded(parts: string[], chunk: string, maxBytes: number): void {
  parts.push(chunk);
  let total = parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
  while (total > maxBytes && parts.length > 1) {
    total -= Buffer.byteLength(parts.shift()!);
  }
  if (total > maxBytes && parts.length === 1) {
    const bytes = Buffer.from(parts[0]!);
    parts[0] = bytes.subarray(bytes.length - maxBytes).toString();
  }
}

export function createCommandExecutor(): CommandExecutor {
  return {
    run(argv, options) {
      if (argv.length === 0 || argv.some((value) => typeof value !== 'string' || value.length === 0)) {
        return Promise.reject(new CommandExecutionError('command argv must contain non-empty strings'));
      }
      if (!Number.isSafeInteger(options.maxCaptureBytes ?? 1_048_576) || (options.maxCaptureBytes ?? 1_048_576) < 1) {
        return Promise.reject(new CommandExecutionError('command capture limit is invalid'));
      }
      if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
        return Promise.reject(new CommandExecutionError('command timeout is invalid'));
      }
      const startedAt = new Date().toISOString();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const maxCaptureBytes = options.maxCaptureBytes ?? 1_048_576;
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return new Promise<CommandResult>((resolve, reject) => {
        let timedOut = false;
        let settled = false;
        const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs);
        child.stdout?.on('data', (chunk: Buffer | string) => {
          const text = chunk.toString();
          appendBounded(stdout, text, maxCaptureBytes);
          try { options.onStdout?.(text); } catch (error) { void error; }
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          const text = chunk.toString();
          appendBounded(stderr, text, maxCaptureBytes);
          try { options.onStderr?.(text); } catch (error) { void error; }
        });
        child.once('error', (error: NodeJS.ErrnoException) => {
          if (timeout) clearTimeout(timeout);
          if (settled) return;
          settled = true;
          reject(new CommandExecutionError(`command could not start: ${argv[0]}`, { code: error.code, cause: error }));
        });
        child.once('close', (exitCode, signal) => {
          if (timeout) clearTimeout(timeout);
          if (settled) return;
          settled = true;
          resolve({ argv: [...argv], exitCode, signal, stdout: stdout.join(''), stderr: stderr.join(''), timedOut, startedAt, finishedAt: new Date().toISOString() });
        });
      });
    },
  };
}
