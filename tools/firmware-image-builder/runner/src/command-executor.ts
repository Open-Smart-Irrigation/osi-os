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
  readonly timeoutDisarmSignal?: AbortSignal;
  readonly maxCaptureBytes?: number;
  readonly onStdoutBytes?: (chunk: Buffer) => void;
  readonly onStderrBytes?: (chunk: Buffer) => void;
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
        let observerFailed = false;
        let observerError: unknown;
        let spawnError: NodeJS.ErrnoException | undefined;
        let observerKillTimer: NodeJS.Timeout | undefined;
        let timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs);
        const disarmTimeout = (): void => {
          if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
          }
        };
        if (options.timeoutDisarmSignal?.aborted === true) disarmTimeout();
        else options.timeoutDisarmSignal?.addEventListener('abort', disarmTimeout, { once: true });
        const failObserver = (error: unknown): void => {
          if (observerFailed) return;
          observerFailed = true;
          observerError = error;
          child.kill('SIGTERM');
          observerKillTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1_000);
        };
        child.stdout?.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!observerFailed) {
            try { options.onStdoutBytes?.(bytes); } catch (error) { failObserver(error); }
          }
          const text = bytes.toString();
          appendBounded(stdout, text, maxCaptureBytes);
          if (!observerFailed) {
            try { options.onStdout?.(text); } catch (error) { failObserver(error); }
          }
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!observerFailed) {
            try { options.onStderrBytes?.(bytes); } catch (error) { failObserver(error); }
          }
          const text = bytes.toString();
          appendBounded(stderr, text, maxCaptureBytes);
          if (!observerFailed) {
            try { options.onStderr?.(text); } catch (error) { failObserver(error); }
          }
        });
        child.once('error', (error: NodeJS.ErrnoException) => {
          spawnError = error;
        });
        child.once('close', (exitCode, signal) => {
          if (timeout) clearTimeout(timeout);
          options.timeoutDisarmSignal?.removeEventListener('abort', disarmTimeout);
          if (observerKillTimer) clearTimeout(observerKillTimer);
          if (settled) return;
          settled = true;
          const result = { argv: [...argv], exitCode, signal, stdout: stdout.join(''), stderr: stderr.join(''), timedOut, startedAt, finishedAt: new Date().toISOString() };
          if (observerFailed) {
            reject(new CommandExecutionError(`command output observer failed: ${argv[0]}`, { result, cause: observerError }));
          } else if (spawnError) {
            reject(new CommandExecutionError(`command could not start: ${argv[0]}`, { code: spawnError.code, result, cause: spawnError }));
          } else {
            resolve(result);
          }
        });
      });
    },
  };
}
