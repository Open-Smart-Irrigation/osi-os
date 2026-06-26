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

  it('fails open to true when navigator is unavailable', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isDesktopBrowser()).toBe(true);
  });

  it('fails open to true when userAgent is empty', () => {
    vi.stubGlobal('navigator', { userAgent: '' });
    expect(isDesktopBrowser()).toBe(true);
  });

  it('falls through to UA when userAgentData has no boolean mobile', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: {} });
    expect(isDesktopBrowser()).toBe(true);
  });
});
