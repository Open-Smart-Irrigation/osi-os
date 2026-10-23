import { describe, expect, test, vi } from 'vitest';
import { createRequestOwner } from '../../src/pilot/requestOwner';

describe('pilot request owner', () => {
  test('only applies the latest generation and suppresses stale rejection', async () => {
    let token = 'one';
    const owner = createRequestOwner(() => token);
    let firstReject!: (error: Error) => void;
    const first = owner.run({ load: () => new Promise((_resolve, reject) => { firstReject = reject; }), apply: vi.fn() });
    const secondApply = vi.fn();
    const second = owner.run({ load: async () => 'new', apply: secondApply });
    firstReject(new Error('old request error'));
    await expect(first).resolves.toBe('superseded');
    await expect(second).resolves.toBe('applied');
    expect(secondApply).toHaveBeenCalledWith('new');
  });

  test('token changes advance the session epoch and refuse a late result', async () => {
    let resolve!: (value: string) => void;
    let token = 'one';
    const owner = createRequestOwner(() => token);
    const apply = vi.fn();
    const pending = owner.run({ load: () => new Promise<string>((done) => { resolve = done; }), apply });
    token = 'two';
    resolve('old');
    await expect(pending).resolves.toBe('superseded');
    expect(owner.sessionEpoch).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });

  test('observes one completed-request token transition exactly once', async () => {
    let token = 'one';
    const owner = createRequestOwner(() => token);
    await expect(owner.run({ load: async () => 'first', apply: () => undefined })).resolves.toBe('applied');
    token = 'two';
    await expect(owner.run({ load: async () => 'second', apply: () => undefined })).resolves.toBe('applied');
    expect(owner.sessionEpoch).toBe(1);
    await expect(owner.run({ load: async () => 'third', apply: () => undefined })).resolves.toBe('applied');
    expect(owner.sessionEpoch).toBe(1);
  });

  test('aborts active work before returning auth-required for a missing token', async () => {
    let token: string | null = 'one';
    const owner = createRequestOwner(() => token);
    let signal!: AbortSignal;
    void owner.run({ load: (received) => { signal = received; return new Promise(() => undefined); }, apply: () => undefined });
    token = null;
    await expect(owner.run({ load: async () => 'unreachable', apply: () => undefined })).resolves.toBe('auth-required');
    expect(signal.aborted).toBe(true);
    expect(owner.sessionEpoch).toBe(1);
  });

  test('counts one token transition once when multiple old requests settle', async () => {
    let token = 'one';
    const owner = createRequestOwner(() => token);
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const first = owner.run({ load: () => new Promise<string>((resolve) => { resolveFirst = resolve; }), apply: () => undefined });
    const second = owner.run({ load: () => new Promise<string>((resolve) => { resolveSecond = resolve; }), apply: () => undefined });
    token = 'two';
    const current = owner.run({ load: async () => 'current', apply: () => undefined });
    await expect(current).resolves.toBe('applied');
    resolveFirst('old');
    resolveSecond('older');
    await expect(first).resolves.toBe('superseded');
    await expect(second).resolves.toBe('superseded');
    expect(owner.sessionEpoch).toBe(1);
  });

  test('cancel aborts active work and destroy permanently refuses it', async () => {
    const owner = createRequestOwner(() => 'one');
    let signal!: AbortSignal;
    void owner.run({ load: (receivedSignal) => { signal = receivedSignal; return new Promise(() => undefined); }, apply: () => undefined });
    expect(owner.cancel()).toBe(true);
    expect(signal.aborted).toBe(true);
    owner.destroy();
    await expect(owner.run({ load: async () => 'x', apply: () => undefined })).resolves.toBe('cancelled');
  });
});
