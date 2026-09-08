import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from '../uuid';

// Canonical v4 UUID (version nibble 4, variant nibble 8/9/a/b).
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuid', () => {
  const realCrypto = globalThis.crypto;
  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when available (secure context)', () => {
    const spy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    expect(randomUuid()).toBe('11111111-1111-4111-8111-111111111111');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('falls back to a canonical v4 UUID on an INSECURE origin (no crypto.randomUUID)', () => {
    // Simulate an insecure context: getRandomValues present, randomUUID absent.
    const insecure = {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (i * 37 + 11) & 0xff;
        return arr;
      },
    } as unknown as Crypto;
    Object.defineProperty(globalThis, 'crypto', { value: insecure, configurable: true });
    const id = randomUuid();
    expect(id).toMatch(V4);
  });

  it('still returns a canonical v4 UUID when crypto is entirely absent', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const id = randomUuid();
    expect(id).toMatch(V4);
  });

  it('produces distinct values across calls in the fallback path', () => {
    const insecure = {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    } as unknown as Crypto;
    Object.defineProperty(globalThis, 'crypto', { value: insecure, configurable: true });
    const a = randomUuid();
    const b = randomUuid();
    expect(a).not.toBe(b);
  });
});
