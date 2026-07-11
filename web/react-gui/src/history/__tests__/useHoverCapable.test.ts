import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHoverCapable } from '../useHoverCapable';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('useHoverCapable', () => {
  it('returns true on hover-capable devices', () => {
    stubMatchMedia(true);
    expect(renderHook(() => useHoverCapable()).result.current).toBe(true);
  });

  it('returns false on touch-only devices', () => {
    stubMatchMedia(false);
    expect(renderHook(() => useHoverCapable()).result.current).toBe(false);
  });

  it('returns false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useHoverCapable()).result.current).toBe(false);
  });
});
