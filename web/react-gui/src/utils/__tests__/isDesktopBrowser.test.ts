import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktopBrowser } from '../isDesktopBrowser';

afterEach(() => vi.unstubAllGlobals());

describe('isDesktopBrowser', () => {
  it('is false for a mobile user agent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
    expect(isDesktopBrowser()).toBe(false);
  });

  it('is true for a desktop user agent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(isDesktopBrowser()).toBe(true);
  });

  it('prefers userAgentData.mobile when present', () => {
    vi.stubGlobal('navigator', { userAgent: '', userAgentData: { mobile: true } });
    expect(isDesktopBrowser()).toBe(false);
  });
});
