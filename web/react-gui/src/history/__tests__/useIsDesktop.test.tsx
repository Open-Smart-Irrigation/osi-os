import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_MIN_WIDTH, useIsDesktop } from '../useIsDesktop';

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: `(min-width: ${DESKTOP_MIN_WIDTH}px)`,
    addEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
  };
  vi.stubGlobal('matchMedia', (query: string) => {
    mql.media = query;
    return mql;
  });
  return {
    setMatches(nextMatches: boolean) {
      mql.matches = nextMatches;
      const event = { matches: nextMatches, media: mql.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

describe('useIsDesktop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is true at/above the desktop breakpoint', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
    expect(DESKTOP_MIN_WIDTH).toBe(1024);
  });

  it('is false below the desktop breakpoint', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(false);
  });

  it('updates when the desktop media query changes', () => {
    const media = mockMatchMedia(false);
    const { result } = renderHook(() => useIsDesktop());

    act(() => {
      media.setMatches(true);
    });

    expect(result.current).toBe(true);
  });
});
