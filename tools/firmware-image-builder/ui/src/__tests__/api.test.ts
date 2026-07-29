// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openJobEventStream } from '../api.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(name, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    this.closed = true;
  }

  emit(name: string, id: number, data: Record<string, unknown>): void {
    this.listeners.get(name)?.(new MessageEvent(name, {
      data: JSON.stringify(data),
      lastEventId: String(id),
    }));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe('openJobEventStream', () => {
  it('handles named builder events and reconnects from the last durable sequence', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const onEvent = vi.fn();
    const onConnection = vi.fn();
    const stream = openJobEventStream({
      jobId: 'job-1',
      after: 40,
      onEvent,
      onConnection,
    });

    const first = FakeEventSource.instances[0]!;
    expect(first.url).toContain('after=40');
    first.emit('stage', 41, {
      state: 'building',
      stage: 'build',
      at: '2026-07-28T10:00:00.000Z',
    });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      seq: 41,
      event: 'stage',
      state: 'building',
      stage: 'build',
      at: '2026-07-28T10:00:00.000Z',
    }));

    first.onerror?.();
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances[1]?.url).toContain('after=41');

    stream.close();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
    expect(onConnection).toHaveBeenLastCalledWith('closed');
  });

  it('does not deliver duplicate or default-message-only events', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onEvent = vi.fn();
    const stream = openJobEventStream({
      jobId: 'job-1',
      after: 4,
      onEvent,
      onConnection: vi.fn(),
    });

    const source = FakeEventSource.instances[0]!;
    source.emit('terminal', 5, {
      state: 'succeeded',
      at: '2026-07-28T10:04:00.000Z',
    });
    source.emit('terminal', 5, {
      state: 'succeeded',
      at: '2026-07-28T10:04:00.000Z',
    });
    expect(onEvent).toHaveBeenCalledOnce();
    stream.close();
  });

  it('does not invent a timestamp for durable log data that has none', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onEvent = vi.fn();
    const stream = openJobEventStream({
      jobId: 'job-1',
      after: 8,
      onEvent,
      onConnection: vi.fn(),
    });

    FakeEventSource.instances[0]!.emit('log', 9, { stream: 'docker', text: 'make' });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ seq: 9, at: null }));
    stream.close();
  });
});
