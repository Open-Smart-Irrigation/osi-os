import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
export const BUILD_TIMEOUT_GRACE_MS = 5 * 1000;
export const BUILD_OUTPUT_TAIL_BYTES = 96 * 1024;

type SpawnProcess = (executable: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

export interface StreamingBuildOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
  readonly spawnProcess?: SpawnProcess;
}

export function runStreamingBuild(argv: readonly string[], cwd: string, options: StreamingBuildOptions = {}): Promise<{ readonly tail: string }> {
  const executable = options.executable ?? '/usr/bin/docker';
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
  const graceMs = options.graceMs ?? BUILD_TIMEOUT_GRACE_MS;
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer | string) => { tail = `${tail}${chunk.toString()}`.slice(-BUILD_OUTPUT_TAIL_BYTES); };
    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const removeOutputListeners = () => {
      child.stdout?.removeListener('data', append);
      child.stderr?.removeListener('data', append);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeOutputListeners();
      if (error) reject(error);
      else resolve({ tail });
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`docker build timed out after ${timeoutMs}ms\n${tail}`));
      } else if (code === 0) {
        finish();
      } else {
        finish(new Error(`docker build exited with code=${code ?? 'null'} signal=${signal ?? 'none'}\n${tail}`));
      }
    });
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* close/error will report the process outcome */ }
      killTimer = setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL'); } catch { /* close/error will report the process outcome */ }
        }
      }, graceMs);
    }, timeoutMs);
  });
}
