import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DurableLogStream } from '../../api/src/log-stream.js';
import type { LogCleanupProof } from '../../api/src/ownership.js';

export interface RunnerLogClock {
  readonly now: () => string;
}

export interface RunnerLogPipelineEntry {
  readonly jobId: string;
  readonly stage: string;
  readonly outcome: 'running' | 'passed' | 'failed';
  readonly at: string;
}

export interface RunnerLogCoordinatorOptions {
  readonly db: DatabaseSync;
  readonly jobRoot: string;
  readonly jobId: string;
  readonly clock: RunnerLogClock;
}

export interface RunnerLogCoordinator {
  readonly pipelineLogWriter: {
    readonly write: (entry: RunnerLogPipelineEntry) => void;
  };
  readonly appendDockerBytes: (bytes: Buffer) => void;
  readonly finalize: (operationFinishedAt: string) => LogCleanupProof;
  readonly sealForCancellation: (at: string) => LogCleanupProof;
  readonly close: () => void;
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STREAMS = ['runner', 'docker'] as const;
type CoordinatedStream = (typeof STREAMS)[number];

function validateJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error('invalid job id');
}

function validateAt(at: string, field: string): void {
  if (!Number.isFinite(Date.parse(at))) throw new Error(`${field} must be an ISO timestamp`);
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function appendUtf8Prefix(target: string[], bytes: Buffer, limit: number): void {
  if (bytes.length === 0 || limit === 0) return;
  let end = Math.min(bytes.length, limit);
  if (end < bytes.length) {
    while (end > 0 && bytes.subarray(0, end).toString('utf8').includes('\ufffd')) end -= 1;
  }
  if (end > 0) target.push(bytes.subarray(0, end).toString('utf8'));
}

export function appendByteBoundedTextCapture(target: string[], chunk: Buffer | string, byteLimit: number): void {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) throw new Error('byte limit must be a non-negative safe integer');
  const used = Buffer.byteLength(target.join(''), 'utf8');
  if (used > byteLimit) throw new Error('text capture already exceeds byte limit');
  appendUtf8Prefix(target, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'), byteLimit - used);
}

export function createRunnerLogCoordinator(options: RunnerLogCoordinatorOptions): RunnerLogCoordinator {
  validateJobId(options.jobId);
  validateAt(options.clock.now(), 'clock.now()');
  if (!lstatSync(options.jobRoot).isDirectory()) throw new Error('job root must be an existing directory');
  const stream = new DurableLogStream({ db: options.db, root: options.jobRoot, jobId: options.jobId, now: options.clock.now });
  const present = new Set<CoordinatedStream>();
  const sealed = new Set<CoordinatedStream>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error('runner log coordinator is closed');
  }

  function append(kind: CoordinatedStream, bytes: Buffer): void {
    assertOpen();
    if (!Buffer.isBuffer(bytes)) throw new TypeError('log bytes must be a Buffer');
    if (sealed.has(kind)) {
      stream.rotateSync(kind);
      sealed.delete(kind);
    }
    stream.appendSync(kind, bytes);
    present.add(kind);
  }

  function seal(kind: CoordinatedStream): void {
    if (!present.has(kind) || sealed.has(kind)) return;
    stream.sealSync(kind);
    sealed.add(kind);
  }

  function proof(finishedAt: string): LogCleanupProof {
    assertOpen();
    validateAt(finishedAt, 'operationFinishedAt');
    for (const kind of STREAMS) seal(kind);
    return {
      runner: present.has('runner') ? 'sealed' : 'absent',
      docker: present.has('docker') ? 'sealed' : 'absent',
      verifiedAt: maxTimestamp(options.clock.now(), finishedAt),
    };
  }

  const coordinator: RunnerLogCoordinator = {
    pipelineLogWriter: {
      write: (entry) => {
        assertOpen();
        append('runner', Buffer.from(`${JSON.stringify({ jobId: options.jobId, stage: entry.stage, outcome: entry.outcome, at: entry.at })}\n`, 'utf8'));
      },
    },
    appendDockerBytes: (bytes) => append('docker', bytes),
    finalize: proof,
    sealForCancellation: proof,
    close: () => {
      if (closed) return;
      const errors: unknown[] = [];
      for (const kind of STREAMS) {
        try { seal(kind); } catch (error) { errors.push(error); }
      }
      try { stream.close(); } catch (error) { errors.push(error); }
      closed = true;
      if (errors.length > 0) throw new AggregateError(errors, 'runner log coordinator close failed');
    },
  };
  return coordinator;
}
