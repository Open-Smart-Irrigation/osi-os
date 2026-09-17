// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

function renderHeader() {
  render(
    <I18nextProvider i18n={testI18n}>
      <BrowserRouter>
        <DashboardHeader username="farmer" onAddZone={vi.fn()} onAddDevice={vi.fn()} onLogout={vi.fn()} />
      </BrowserRouter>
    </I18nextProvider>,
  );
}

describe('DashboardHeader network nav label (real i18n resources)', () => {
  // The label regression this file was written for can only be caught while
  // the entry actually renders, so the original assertion is kept verbatim
  // for the module-on case (the default on main) rather than dropped.
  it('renders the Network nav link from the dashboard namespace, never the network object', () => {
    renderHeader();

    const link = screen.getByRole('link', { name: 'Network' });
    expect(link).toHaveAttribute('href', '/network');
    expect(link.textContent).toBe('Network');
    expect(link.textContent).not.toContain('returned an object');
  });

  // Module visibility (2026-09-17): with the network module off there is no
  // entry to label at all. Asserting the absence here keeps this file honest
  // about which state it is checking.
  it('renders no Network nav entry at all when the network module is off', () => {
    window.localStorage.setItem('osi.modules.network', 'false');
    renderHeader();

    expect(screen.queryByRole('link', { name: 'Network' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('returned an object');
  });
});
