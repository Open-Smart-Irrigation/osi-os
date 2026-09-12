// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import dashboardEn from '../../../public/locales/en/dashboard.json';
import settingsEn from '../../../public/locales/en/settings.json';
import { DashboardHeader } from '../DashboardHeader';

// Regression test for the network-nav i18n bug: DashboardHeader used to read
// the bare `network` key, which fell back (via i18n/config.ts fallbackNS) to
// network.json's `{ "network": { ... } }` object, and i18next rendered the
// literal string "key 'network (en)' returned an object instead of string."
// This test wires up a real i18next instance (no react-i18next mock) loading
// the actual shipped dashboard.json/settings.json resources, so it fails if
// the nav label regresses to reading the wrong key/namespace again.

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

vi.mock('../LanguageSwitcher', () => ({
  LanguageSwitcher: () => <button title="Change language">Lang EN</button>,
}));

const testI18n = i18next.createInstance();
testI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'dashboard',
  // Deliberately excludes the 'network' namespace: the dashboard nav label
  // must resolve entirely from 'dashboard', with no dependency on it.
  ns: ['dashboard', 'settings'],
  resources: {
    en: { dashboard: dashboardEn, settings: settingsEn },
  },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

afterEach(() => {
  cleanup();
});

describe('DashboardHeader network nav label (real i18n resources)', () => {
  it('renders the Network nav link from the dashboard namespace, never the network object', () => {
    render(
      <I18nextProvider i18n={testI18n}>
        <BrowserRouter>
          <DashboardHeader username="farmer" onAddZone={vi.fn()} onAddDevice={vi.fn()} onLogout={vi.fn()} />
        </BrowserRouter>
      </I18nextProvider>,
    );

    const link = screen.getByRole('link', { name: 'Network' });
    expect(link).toHaveAttribute('href', '/network');
    expect(link.textContent).toBe('Network');
    expect(link.textContent).not.toContain('returned an object');
  });
});
