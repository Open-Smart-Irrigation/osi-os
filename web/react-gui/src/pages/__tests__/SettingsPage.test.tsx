// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDisplayPreferences } from '../../utils/displayPreferences';
import { SettingsPage } from '../SettingsPage';

const i18nMock = vi.hoisted(() => ({
  language: 'en',
  changeLanguage: vi.fn((code: string) => {
    i18nMock.language = code;
    window.localStorage.setItem('i18n_language', code);
    return Promise.resolve();
  }),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    i18n: i18nMock,
    t: (key: string) => {
      const map: Record<string, string> = {
        title: 'Settings',
        subtitle: 'Gateway-wide display and operational defaults.',
        backToDashboard: 'Back to dashboard',
        languageTitle: 'Language',
        appearanceTitle: 'Appearance',
        theme: 'Theme',
        light: 'Light',
        dark: 'Dark',
        system: 'System',
        unitsTitle: 'Units & Display',
        swtUnit: 'Soil water tension unit',
        kpa: 'kPa',
        pf: 'pF',
        density: 'Dashboard density',
        comfortable: 'Comfortable',
        compact: 'Compact',
        swtSample: 'SWT sample',
        dataTitle: 'Data & Refresh',
        autoRefresh: 'Auto-refresh dashboard',
        on: 'On',
        off: 'Off',
      };
      return map[key] ?? key;
    },
  }),
}));

function renderSettings() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  i18nMock.language = 'en';
  i18nMock.changeLanguage.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('SettingsPage', () => {
  it('renders the Stage A settings sections and controls', () => {
    renderSettings();

    expect(screen.getByRole('heading', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Units & Display' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Data & Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'System' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kPa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'pF' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comfortable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compact' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'On' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toBeInTheDocument();
  });

  it('changes language through the settings page switcher', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /Lang EN/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Deutsch (CH)' }));

    expect(i18nMock.changeLanguage).toHaveBeenCalledWith('de-CH');
    expect(window.localStorage.getItem('i18n_language')).toBe('de-CH');
  });

  it('persists SWT display unit and updates the visible sample', () => {
    renderSettings();

    expect(screen.getByText('30.0 kPa')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'pF' }));

    expect(readDisplayPreferences().swtUnit).toBe('pF');
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'kPa' }));
    expect(readDisplayPreferences().swtUnit).toBe('kPa');
    expect(screen.getByText('30.0 kPa')).toBeInTheDocument();
  });

  it('persists theme selection and reapplies it across a reload simulation', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(readDisplayPreferences().theme).toBe('dark');

    cleanup();
    document.documentElement.removeAttribute('data-theme');
    renderSettings();

    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
