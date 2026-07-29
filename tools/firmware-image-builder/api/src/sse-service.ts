import type { LogStreamEvent } from './log-stream.js';

const MAX_KEEPALIVE_MS = 15_000;
const DEFAULT_KEEPALIVE_MS = MAX_KEEPALIVE_MS;
const DEFAULT_POLL_MS = 250;
const DEFAULT_MAX_EVENTS_PER_POLL = 1_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EVENT_NAMES = new Set(['stage', 'log', 'terminal', 'log-gap', 'log-truncated']);
const MAX_SSE_FRAME_BYTES = 64 * 1024;

export interface DurableLogStreamSource {
  readonly replaySync: (afterSeq: number) => readonly LogStreamEvent[];
  readonly encodeSse: (event: LogStreamEvent) => string;
  readonly keepalive: () => string;
  readonly close: () => void;
}

export interface SseServiceOptions {
  readonly openStream: (jobId: string) => DurableLogStreamSource;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => void | Promise<void>;
  readonly pollIntervalMs?: number;
  readonly keepaliveIntervalMs?: number;
  readonly maxEventsPerPoll?: number;
}

export interface SseServiceContract {
  readonly open: (jobId: string, afterSeq: number, signal: AbortSignal) => AsyncIterable<string>;
}

type SourceMethodName = keyof DurableLogStreamSource;
type SourceMethod = (...args: never[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function methodFromPrototype(value: object, name: SourceMethodName): SourceMethod {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new Error(`SSE source ${name} must be a data method`);
      }
      return descriptor.value.bind(value) as SourceMethod;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new Error(`SSE source is missing ${name}`);
}

function validateJobId(jobId: string): void {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new Error('SSE job id is invalid');
}

function validateCursor(afterSeq: number): void {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new Error('SSE cursor must be a safe integer at least -1');
}

function validateSignal(signal: AbortSignal): void {
  if (signal === null || typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    throw new Error('SSE signal is invalid');
  }
}

function validatePositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function validateEvent(event: unknown, previousSeq: number): LogStreamEvent {
  if (!isRecord(event)) throw new Error('SSE source returned a non-object event');
  const keys = Reflect.ownKeys(event);
  if (keys.length !== 3 || keys.some((key) => typeof key !== 'string' || !['seq', 'event', 'data'].includes(key))) {
    throw new Error('SSE source returned an event with an invalid shape');
  }
  const seqDescriptor = Object.getOwnPropertyDescriptor(event, 'seq');
  const eventDescriptor = Object.getOwnPropertyDescriptor(event, 'event');
  const dataDescriptor = Object.getOwnPropertyDescriptor(event, 'data');
  if (seqDescriptor === undefined || !('value' in seqDescriptor)
    || eventDescriptor === undefined || !('value' in eventDescriptor)
    || dataDescriptor === undefined || !('value' in dataDescriptor)) {
    throw new Error('SSE source returned an event with accessor fields');
  }
  const seq = seqDescriptor.value;
  const eventName = eventDescriptor.value;
  if (!Number.isSafeInteger(seq) || seq < 0 || seq <= previousSeq) {
    throw new Error('SSE source returned events out of order');
  }
  if (typeof eventName !== 'string' || !EVENT_NAMES.has(eventName)) {
    throw new Error('SSE source returned an unknown event type');
  }
  if (!isRecord(dataDescriptor.value)) throw new Error('SSE source returned event data that is not an object');
  return event as unknown as LogStreamEvent;
}

function validateFrame(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`SSE source ${name} returned a non-string frame`);
  if (Buffer.byteLength(value, 'utf8') > MAX_SSE_FRAME_BYTES) throw new Error(`SSE source ${name} returned an oversized frame`);
  return value;
}

function defaultClock(): number {
  return Date.now();
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

function waitFor(
  sleep: (milliseconds: number, signal: AbortSignal) => void | Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = (): void => finish();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    try {
      Promise.resolve(sleep(milliseconds, signal)).then(finish, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export class SseService implements SseServiceContract {
  readonly #openStream: (jobId: string) => DurableLogStreamSource;
  readonly #clock: () => number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => void | Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #keepaliveIntervalMs: number;
  readonly #maxEventsPerPoll: number;

  constructor(options: SseServiceOptions) {
    if (!isRecord(options)) throw new Error('SSE service options are required');
    if (typeof options.openStream !== 'function') throw new Error('SSE service openStream is required');
    if (options.clock !== undefined && typeof options.clock !== 'function') throw new Error('SSE service clock must be a function');
    if (options.sleep !== undefined && typeof options.sleep !== 'function') throw new Error('SSE service sleep must be a function');
    const keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const maxEventsPerPoll = options.maxEventsPerPoll ?? DEFAULT_MAX_EVENTS_PER_POLL;
    validatePositiveInteger(keepaliveIntervalMs, 'SSE keepalive interval', MAX_KEEPALIVE_MS);
    validatePositiveInteger(pollIntervalMs, 'SSE poll interval', keepaliveIntervalMs);
    validatePositiveInteger(maxEventsPerPoll, 'SSE maximum events per poll', DEFAULT_MAX_EVENTS_PER_POLL);
    this.#openStream = options.openStream;
    this.#clock = options.clock ?? defaultClock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#pollIntervalMs = pollIntervalMs;
    this.#keepaliveIntervalMs = keepaliveIntervalMs;
    this.#maxEventsPerPoll = maxEventsPerPoll;
  }

  open(jobId: string, afterSeq: number, signal: AbortSignal): AsyncIterable<string> {
    validateJobId(jobId);
    validateCursor(afterSeq);
    validateSignal(signal);
    return this.#iterate(jobId, afterSeq, signal);
  }

  async *#iterate(jobId: string, afterSeq: number, signal: AbortSignal): AsyncGenerator<string> {
    if (signal.aborted) return;
    const candidate = this.#openStream(jobId);
    let close: (() => unknown) | undefined;
    try {
      if (!isRecord(candidate)) throw new Error('SSE source is not an object');
      close = methodFromPrototype(candidate, 'close');
      const replaySync = methodFromPrototype(candidate, 'replaySync') as (after: number) => unknown;
      const encodeSse = methodFromPrototype(candidate, 'encodeSse') as (event: LogStreamEvent) => unknown;
      const keepalive = methodFromPrototype(candidate, 'keepalive') as () => unknown;
      let cursor = afterSeq;
      let lastClock = this.#clock();
      if (!Number.isFinite(lastClock) || lastClock < 0) throw new Error('SSE clock returned an invalid time');
      let nextKeepaliveAt = lastClock + this.#keepaliveIntervalMs;

      while (!signal.aborted) {
        const replayed = replaySync(cursor);
        if (!Array.isArray(replayed) || replayed.length > this.#maxEventsPerPoll) {
          throw new Error('SSE source returned an invalid replay batch');
        }
        const events: LogStreamEvent[] = [];
        let batchCursor = cursor;
        for (const item of replayed) {
          const event = validateEvent(item, batchCursor);
          events.push(event);
          batchCursor = event.seq;
        }
        if (events.some((event, index) => event.event === 'terminal' && index !== events.length - 1)) {
          throw new Error('SSE source returned events after a terminal event');
        }
        if (events.length > 0) {
          for (const event of events) {
            if (signal.aborted) return;
            const frame = validateFrame(encodeSse(event), 'encodeSse');
            yield frame;
            cursor = event.seq;
            const now = this.#clock();
            if (!Number.isFinite(now) || now < lastClock) throw new Error('SSE clock moved backwards or returned an invalid time');
            lastClock = now;
            nextKeepaliveAt = now + this.#keepaliveIntervalMs;
            if (event.event === 'terminal') return;
          }
          continue;
        }

        const now = this.#clock();
        if (!Number.isFinite(now) || now < lastClock) throw new Error('SSE clock moved backwards or returned an invalid time');
        lastClock = now;
        if (now >= nextKeepaliveAt) {
          if (signal.aborted) return;
          const frame = validateFrame(keepalive(), 'keepalive');
          yield frame;
          const emittedAt = this.#clock();
          if (!Number.isFinite(emittedAt) || emittedAt < lastClock) throw new Error('SSE clock moved backwards or returned an invalid time');
          lastClock = emittedAt;
          nextKeepaliveAt = emittedAt + this.#keepaliveIntervalMs;
          continue;
        }
        await waitFor(this.#sleep, Math.min(this.#pollIntervalMs, nextKeepaliveAt - now), signal);
      }
    } finally {
      close?.();
    }
  }
}

export const DurableSseService = SseService;

export function createSseService(options: SseServiceOptions): SseServiceContract {
  return new SseService(options);
}

export default SseService;
