import { describe, expect, it, vi } from 'vitest';
import { DurableSseService, SseService, type DurableLogStreamSource } from '../../api/src/sse-service.js';
import type { LogStreamEvent } from '../../api/src/log-stream.js';

const JOB_ID = 'job-sse';

function event(seq: number, name: LogStreamEvent['event'] = 'stage'): LogStreamEvent {
  return { seq, event: name, data: { jobId: JOB_ID, state: name } };
}

function sourceFor(
  events: readonly LogStreamEvent[] | ((afterSeq: number) => readonly LogStreamEvent[]),
): DurableLogStreamSource & { readonly closed: { value: boolean } } {
  const closed = { value: false };
  const source = {
    replaySync: vi.fn((afterSeq: number) => typeof events === 'function' ? events(afterSeq) : events.filter((item) => item.seq > afterSeq)),
    encodeSse: vi.fn((item: LogStreamEvent) => `id: ${item.seq}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`),
    keepalive: vi.fn(() => ': keepalive\n\n'),
    close: vi.fn(() => { closed.value = true; }),
    closed,
  } satisfies DurableLogStreamSource & { readonly closed: { value: boolean } };
  return source;
}

async function collect(iterable: AsyncIterable<string>, limit = 20): Promise<string[]> {
  const output: string[] = [];
  for await (const frame of iterable) {
    output.push(frame);
    if (output.length >= limit) break;
  }
  return output;
}

describe('DurableSseService', () => {
  it('exports the generic service name and durable alias', () => {
    expect(DurableSseService).toBe(SseService);
  });

  it('replays paginated events in order and advances the cursor only after each yield', async () => {
    const source = sourceFor((afterSeq) => afterSeq < 1 ? [event(0), event(1)] : afterSeq < 3 ? [event(2), event(3)] : []);
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const service = new DurableSseService({ openStream: () => source, clock: () => now, sleep, pollIntervalMs: 10 });
    const iterator = service.open(JOB_ID, -1, new AbortController().signal)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toContain('id: 0');
    expect(source.replaySync).toHaveBeenLastCalledWith(-1);
    expect((await iterator.next()).value).toContain('id: 1');
    expect((await iterator.next()).value).toContain('id: 2');
    expect(source.replaySync).toHaveBeenLastCalledWith(1);
    expect((await iterator.next()).value).toContain('id: 3');
    await iterator.return?.();
    expect(source.closed.value).toBe(true);
  });

  it('polls for new events and emits keepalive at the configured idle deadline', async () => {
    let now = 0;
    let available: LogStreamEvent[] = [];
    const source = sourceFor((afterSeq) => available.filter((item) => item.seq > afterSeq));
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
      if (now >= 20) available = [event(4)];
    });
    const service = new DurableSseService({
      openStream: () => source,
      clock: () => now,
      sleep,
      pollIntervalMs: 5,
      keepaliveIntervalMs: 15,
    });
    const iterator = service.open(JOB_ID, -1, new AbortController().signal)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toBe(': keepalive\n\n');
    expect(sleep).toHaveBeenCalledTimes(3);
    expect((await iterator.next()).value).toContain('id: 4');
    await iterator.return?.();
    expect(source.closed.value).toBe(true);
  });

  it('closes after a terminal event and does not poll beyond it', async () => {
    const source = sourceFor([event(7), event(8, 'terminal')]);
    const service = new DurableSseService({ openStream: () => source, sleep: async () => undefined });
    const frames = await collect(service.open(JOB_ID, 6, new AbortController().signal));

    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain('event: terminal');
    expect(source.replaySync).toHaveBeenCalledTimes(1);
    expect(source.closed.value).toBe(true);
  });

  it('stops promptly on abort and closes the source even when injected sleep does not resolve', async () => {
    const source = sourceFor([]);
    const controller = new AbortController();
    let releaseSleep!: () => void;
    const sleep = vi.fn(() => new Promise<void>((resolve) => { releaseSleep = resolve; }));
    const service = new DurableSseService({ openStream: () => source, sleep, pollIntervalMs: 5 });
    const iterator = service.open(JOB_ID, -1, controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(source.closed.value).toBe(true);
    releaseSleep();
  });

  it('fails closed for invalid source batches, ordering, frames, and option values', async () => {
    const invalidSources = [
      sourceFor([event(1), event(1)]),
      sourceFor([event(2), event(1)]),
      sourceFor([event(1), event(2, 'terminal'), event(3)]),
      sourceFor(() => undefined as unknown as readonly LogStreamEvent[]),
    ];
    for (const source of invalidSources) {
      const service = new DurableSseService({ openStream: () => source, sleep: async () => undefined });
      await expect(collect(service.open(JOB_ID, -1, new AbortController().signal,))).rejects.toThrow(/SSE source|order|batch/i);
      expect(source.closed.value).toBe(true);
    }
    const oversized = sourceFor([event(1)]);
    vi.spyOn(oversized, 'encodeSse').mockReturnValue('x'.repeat(64 * 1024 + 1));
    await expect(collect(new DurableSseService({ openStream: () => oversized }).open(JOB_ID, -1, new AbortController().signal))).rejects.toThrow(/oversized/i);
    expect(oversized.closed.value).toBe(true);

    expect(() => new DurableSseService({ openStream: () => sourceFor([]), keepaliveIntervalMs: 15_001 })).toThrow(/keepalive/i);
    expect(() => new DurableSseService({ openStream: () => sourceFor([]), pollIntervalMs: 11, keepaliveIntervalMs: 10 })).toThrow(/poll/i);
    expect(() => new DurableSseService({ openStream: () => sourceFor([]), maxEventsPerPoll: 0 })).toThrow(/maximum/i);
    expect(() => new DurableSseService({ openStream: null as never })).toThrow(/openStream/i);
  });
});
