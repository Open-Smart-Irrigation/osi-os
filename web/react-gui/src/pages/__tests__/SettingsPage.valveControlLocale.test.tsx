// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { initReactI18next, I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';

import esCommon from '../../../public/locales/es/common.json';
import esSettings from '../../../public/locales/es/settings.json';
import itCommon from '../../../public/locales/it/common.json';
import itSettings from '../../../public/locales/it/settings.json';
import ptCommon from '../../../public/locales/pt/common.json';
import ptSettings from '../../../public/locales/pt/settings.json';
import frCommon from '../../../public/locales/fr/common.json';
import frSettings from '../../../public/locales/fr/settings.json';
import deCommon from '../../../public/locales/de-CH/common.json';
import deSettings from '../../../public/locales/de-CH/settings.json';
import lgCommon from '../../../public/locales/lg/common.json';
import lgSettings from '../../../public/locales/lg/settings.json';

import { readDisplayPreferences } from '../../utils/displayPreferences';
import { SettingsPage } from '../SettingsPage';

const apiMocks = vi.hoisted(() => ({
  disableAllSchedules: vi.fn(),
  createSupportRequest: vi.fn(),
  getSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  irrigationZonesAPI: {
    disableAllSchedules: apiMocks.disableAllSchedules,
  },
  supportRequestsAPI: {
    create: apiMocks.createSupportRequest,
  },
  systemSettingsAPI: {
    get: apiMocks.getSystemSettings,
    update: apiMocks.updateSystemSettings,
  },
  getApiErrorMessage: (error: unknown, fallback: string) => (
    error instanceof Error && error.message ? error.message : fallback
  ),
}));

// Avoid initializing the app-wide HTTP-backed i18n singleton for this isolated resource test.
vi.mock('../../components/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }));

const localeResources = {
  es: { common: esCommon, settings: esSettings },
  it: { common: itCommon, settings: itSettings },
  pt: { common: ptCommon, settings: ptSettings },
  fr: { common: frCommon, settings: frSettings },
  'de-CH': { common: deCommon, settings: deSettings },
  lg: { common: lgCommon, settings: lgSettings },
};

type Locale = keyof typeof localeResources;

const localeLabels = [
  ['es', 'Control de válvulas'],
  ['it', 'Controllo valvole'],
  ['pt', 'Controlo de válvulas'],
  ['fr', 'Commande des vannes'],
  ['de-CH', 'Ventilsteuerung'],
  ['lg', 'Valve control'],
] as const satisfies ReadonlyArray<readonly [Locale, string]>;

async function createLocaleInstance(locale: Locale) {
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: false,
    fallbackNS: false,
    defaultNS: 'common',
    ns: ['common', 'settings'],
    resources: { [locale]: localeResources[locale] },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}

async function renderSettings(locale: Locale) {
  const i18n = await createLocaleInstance(locale);
  await act(async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </SWRConfig>
      </I18nextProvider>,
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  apiMocks.disableAllSchedules.mockReset();
  apiMocks.createSupportRequest.mockReset();
  apiMocks.getSystemSettings.mockReset();
  apiMocks.getSystemSettings.mockResolvedValue({
    gatewayTimezone: 'UTC',
    dataModuleEnabled: true,
    networkModuleEnabled: true,
    gatewayHubModuleEnabled: true,
    journalModuleEnabled: true,
  });
  apiMocks.updateSystemSettings.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SettingsPage valve-control module localization', () => {
  it.each(localeLabels)('uses the %s settings resource for the module row', async (locale, label) => {
    await renderSettings(locale);

    const row = screen.getByRole('group', { name: label });
    const toggleButtons = within(row).getAllByRole('button');
    const enabled = readDisplayPreferences().modules.valveControl;

    expect(toggleButtons).toHaveLength(2);
    expect(toggleButtons[0]).toHaveAttribute('aria-pressed', String(enabled));
    expect(toggleButtons[1]).toHaveAttribute('aria-pressed', String(!enabled));
  });
});
