import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DurableLogStream } from '../../api/src/log-stream.js';
import type { LogCleanupProof } from '../../api/src/ownership.js';
import { canonicalInstant } from '../../api/src/validation.js';
import { PIPELINE_STAGE_NAMES } from '../../domain/types.js';

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

function validateJobId(jobId: unknown): asserts jobId is string {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new Error('invalid job id');
}

function validateAt(at: unknown, field: string): asserts at is string {
  canonicalInstant(at, field);
}

export interface ByteBoundedTextCapture {
  readonly byteLimit: number;
  readonly bytesUsed: number;
  readonly truncated: boolean;
  readonly append: (chunk: Buffer | string) => void;
  readonly toString: () => string;
}

export function createByteBoundedTextCapture(byteLimit: number): ByteBoundedTextCapture {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) throw new Error('byte limit must be a non-negative safe integer');
  const bytes = Buffer.alloc(byteLimit);
  let bytesUsed = 0;
  let truncated = false;
  return {
    byteLimit,
    get bytesUsed() { return bytesUsed; },
    get truncated() { return truncated; },
    append: (chunk) => {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const copyLength = Math.min(input.length, byteLimit - bytesUsed);
      if (copyLength > 0) {
        input.copy(bytes, bytesUsed, 0, copyLength);
        bytesUsed += copyLength;
      }
      if (copyLength < input.length) truncated = true;
    },
    toString: () => bytes.subarray(0, bytesUsed).toString('utf8'),
  };
}

export function createRunnerLogCoordinator(options: RunnerLogCoordinatorOptions): RunnerLogCoordinator {
  validateJobId(options.jobId);
  const now = (): string => canonicalInstant(options.clock.now(), 'clock.now()');
  now();
  if (!lstatSync(options.jobRoot).isDirectory()) throw new Error('job root must be an existing directory');
  const stream = new DurableLogStream({ db: options.db, root: options.jobRoot, jobId: options.jobId, now });
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

  function proof(operationFinishedAt: string): LogCleanupProof {
    assertOpen();
    const canonicalFinishedAt = canonicalInstant(operationFinishedAt, 'operationFinishedAt');
    for (const kind of STREAMS) seal(kind);
    const verifiedAt = now();
    if (Date.parse(verifiedAt) < Date.parse(canonicalFinishedAt)) {
      throw new Error('verifiedAt is before operationFinishedAt');
    }
    const presentStreams = STREAMS.filter((kind) => present.has(kind));
    if (presentStreams.length > 0) {
      const rows = options.db.prepare(`SELECT stream, sealed_at
        FROM job_log_generations
        WHERE job_id=? AND stream IN (${presentStreams.map(() => '?').join(',')}) AND sealed_at IS NOT NULL`).all(options.jobId, ...presentStreams) as Array<{ stream: string; sealed_at: string | null }>;
      for (const row of rows) {
        const sealedAt = canonicalInstant(row.sealed_at, `${row.stream} sealed_at`);
        if (Date.parse(verifiedAt) < Date.parse(sealedAt)) throw new Error('verifiedAt is before persisted log seal');
      }
    }
    return {
      runner: present.has('runner') ? 'sealed' : 'absent',
      docker: present.has('docker') ? 'sealed' : 'absent',
      verifiedAt,
    };
  }

  const coordinator: RunnerLogCoordinator = {
    pipelineLogWriter: {
      write: (entry) => {
        assertOpen();
        validateJobId(entry.jobId);
        if (!(PIPELINE_STAGE_NAMES as readonly string[]).includes(entry.stage)) throw new Error('invalid pipeline stage');
        if (entry.outcome !== 'running' && entry.outcome !== 'passed' && entry.outcome !== 'failed') throw new Error('invalid pipeline outcome');
        validateAt(entry.at, 'pipeline entry at');
        if (entry.jobId !== options.jobId) throw new Error('pipeline entry job id does not match coordinator job id');
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
