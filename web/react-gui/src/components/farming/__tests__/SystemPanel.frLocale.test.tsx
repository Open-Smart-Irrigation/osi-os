// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import devicesEn from '../../../../public/locales/en/devices.json';
import commonEn from '../../../../public/locales/en/common.json';
import devicesFr from '../../../../public/locales/fr/devices.json';
import commonFr from '../../../../public/locales/fr/common.json';
import { SystemPanel } from '../SystemPanel';

// F32 regression test: SystemPanel.tsx used to be 100% hardcoded English in
// all 7 shipped languages (docs/overnight/2026-09-17 evidence,
// silvan-harness-dev/run-full2/ui/i18n-scan.json englishBlocks -- 16 unique
// strings leaking on both the dashboard and zones-devices pages, 32 total).
// This wires a real i18next instance (no react-i18next mock) loading the
// actual shipped en/fr resources and renders the card entirely in French, so
// it fails if any of those strings regress to hardcoded English.
//
// "Max" (a fan-speed preset) and "MB"/"CPU" (technical abbreviations kept
// as-is in French, like "kPa") are intentionally not in this list -- the
// project's own i18n scan didn't flag them as leaks either, and unit/
// acronym cognates are expected to be identical across locales.
const ENGLISH_LEAKS = [
  'Gateway',
  'System status',
  'Updated',
  'Refresh',
  'CPU TEMPERATURE',
  'max 85°C',
  'MEMORY',
  'MB used',
  'CPU LOAD (',
  'FAN CONTROL',
  'Current:',
  'Off',
  'Low',
  'Medium',
  'High',
  'Reboot Gateway',
  'Reboot gateway now?',
  'Yes, Reboot',
  'No fan detected',
  'Fan control failed',
  'Failed to load stats',
];

vi.mock('../../../contexts/ScopeContext', () => ({
  useScope: () => ({
    loading: false,
    isScoped: false,
    role: 'admin',
    canWrite: true,
    isAdmin: true,
    zoneWritable: () => true,
    profile: null,
    error: null,
    retry: () => {},
  }),
}));

const apiMocks = vi.hoisted(() => ({ getStats: vi.fn() }));

vi.mock('../../../services/api', () => ({
  systemAPI: {
    getStats: apiMocks.getStats,
    setFan: vi.fn(),
    reboot: vi.fn(),
  },
}));

const testI18n = i18next.createInstance();
testI18n.use(initReactI18next).init({
  lng: 'fr',
  fallbackLng: 'fr',
  defaultNS: 'devices',
  ns: ['devices', 'common'],
  resources: {
    en: { devices: devicesEn, common: commonEn },
    fr: { devices: devicesFr, common: commonFr },
  },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const baseStats = {
  cpu_temp_c: 42.3,
  mem_total_mb: 2000,
  mem_used_mb: 512,
  mem_free_mb: 1488,
  mem_percent: 25,
  load_1: 0.12,
  load_5: 0.2,
  load_15: 0.3,
  cpu_count: 4,
  fan_available: true,
  fan_mode: 'pwm' as const,
  fan_value: 0,
  fan_max: 255,
};

beforeEach(() => {
  apiMocks.getStats.mockReset();
});

afterEach(() => {
  cleanup();
});

async function renderInFrench() {
  render(
    <I18nextProvider i18n={testI18n}>
      <SystemPanel />
    </I18nextProvider>,
  );
  return screen.findByText('État du système');
}

describe('SystemPanel French rendering (real i18n resources)', () => {
  it('renders the always-visible gateway card copy in French with no hardcoded English leaks', async () => {
    apiMocks.getStats.mockResolvedValue(baseStats);
    await renderInFrench();
    await screen.findByText('Ventilateur');

    const text = document.body.textContent ?? '';
    for (const leak of ENGLISH_LEAKS) {
      expect(text).not.toContain(leak);
    }

    // Sanity check: the French copy is genuinely present, not merely absent
    // of English (a component that rendered nothing would also pass the
    // loop above for the wrong reason).
    expect(text).toContain('Passerelle');
    expect(text).toContain('État du système');
    expect(text).toContain('Température CPU');
    expect(text).toContain('Mémoire');
    expect(text).toContain('Redémarrer la passerelle');
    expect(text).toContain('Arrêt');
    expect(text).toContain('Faible');
    expect(text).toContain('Moyen');
    expect(text).toContain('Élevé');
  });

  it('renders the no-fan and reboot-confirm states in French too', async () => {
    apiMocks.getStats.mockResolvedValue({ ...baseStats, fan_available: false });
    await renderInFrench();

    const noFanText = document.body.textContent ?? '';
    expect(noFanText).toContain('Aucun ventilateur détecté');
    expect(noFanText).not.toContain('No fan detected');

    fireEvent.click(screen.getByRole('button', { name: /Redémarrer la passerelle/ }));
    const confirmText = document.body.textContent ?? '';
    expect(confirmText).toContain('Redémarrer la passerelle maintenant');
    expect(confirmText).toContain('Oui, redémarrer');
    expect(confirmText).not.toContain('Reboot gateway now?');
    expect(confirmText).not.toContain('Yes, Reboot');
  });
});
