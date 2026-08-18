// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';
import { AppHeader, LIQUID_SIZING, TAB_SIZING } from '../AppHeader';

// Following DashboardHeader.test.tsx's shape: a key->string map rather than
// the real translator, and isDesktopBrowser mocked the same way, since this
// component's own routing/i18n plumbing is out of scope for this test.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => {
      const map: Record<string, string> = {
        'tabs.zones': 'Zones',
        'tabs.data': 'Data',
        'tabs.journal': 'Journal',
        'settings:entryPoint': 'Settings',
        account: 'Account',
        'accountMenu.osiServer': 'OSI Server',
        logout: 'Logout',
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

function renderHeader() {
  render(
    <BrowserRouter>
      <AppHeader title="T" activeTab="zones" onLogout={() => {}} />
    </BrowserRouter>,
  );
}

beforeEach(() => {
  vi.mocked(isDesktopBrowser).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// F2: tabs must read as the dominant navigation, not merely equal to the
// Settings/Account chrome. Assert relative ordering against the actual
// exported tokens rather than presence of a specific class string.
const TEXT_SIZE_RANK: Record<string, number> = { sm: 1, base: 2, lg: 3, xl: 4, '2xl': 5 };

function sizeTokens(sizing: string): { base: number; sm: number } {
  const baseMatch = sizing.match(/(?:^|\s)text-(sm|base|lg|xl|2xl)(?:\s|$)/);
  const smMatch = sizing.match(/sm:text-(sm|base|lg|xl|2xl)/);
  if (!baseMatch || !smMatch) throw new Error(`could not parse text-size tokens from "${sizing}"`);
  return { base: TEXT_SIZE_RANK[baseMatch[1]], sm: TEXT_SIZE_RANK[smMatch[1]] };
}

describe('AppHeader tab prominence (F2)', () => {
  it('tab text size ranks strictly above chrome text size at every breakpoint', () => {
    const chrome = sizeTokens(LIQUID_SIZING);
    const tab = sizeTokens(TAB_SIZING);
    expect(tab.base).toBeGreaterThan(chrome.base);
    expect(tab.sm).toBeGreaterThan(chrome.sm);
  });

  it('tab pill renders with the current TAB_SIZING classes', () => {
    renderHeader();
    const settingsLink = screen.getByRole('link', { name: /settings/i });
    const tab = settingsLink.closest('header')?.querySelector('.glass-tab');

    expect(tab?.className).toContain(TAB_SIZING);
  });
});
