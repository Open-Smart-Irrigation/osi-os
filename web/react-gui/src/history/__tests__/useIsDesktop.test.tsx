import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_MIN_WIDTH, useIsDesktop } from '../useIsDesktop';

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
  }));
}

describe('useIsDesktop', () => {
  it('is true at/above the desktop breakpoint', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
    expect(DESKTOP_MIN_WIDTH).toBe(1024);
  });
});
