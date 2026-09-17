import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next, { type i18n as I18n } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { Device, IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';

import enCommon from '../../../../public/locales/en/common.json';
import enDashboard from '../../../../public/locales/en/dashboard.json';
import enDevices from '../../../../public/locales/en/devices.json';
import frCommon from '../../../../public/locales/fr/common.json';
import frDashboard from '../../../../public/locales/fr/dashboard.json';
import frDevices from '../../../../public/locales/fr/devices.json';

const apiMocks = vi.hoisted(() => ({
  getZoneRecommendations: vi.fn(),
  getSummary: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: { getZoneRecommendations: apiMocks.getZoneRecommendations },
  environmentAPI: { getSummary: apiMocks.getSummary },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div />,
  normalizeTriggerMetric: (value: string) => value,
}));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => <div /> }));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => <div /> }));
vi.mock('../../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: vi.fn(() => false) }));

/**
 * Every literal the water card and the zone chips used to render before this
 * pass. A leak here means a string went back to being hardcoded, or a key was
 * added to `en` without a `fr` value (i18next would then fall back to English).
 *
 * "Action" and "OSI Server" are deliberately absent: the first is the same
 * word in French, the second is a product name that must not be translated.
 * "Scheduler off" and "Driven by dendrometer recommendation" are covered by
 * their own cases below — each is the branch this fixture does not take.
 */
const PREVIOUSLY_HARDCODED = [
  'Water balance',
  'Daily rain, irrigation, and crop demand summary for this zone.',
  'Updated ',
  'Rain today',
  'Measured (flow meter)',
  'Estimated (valve time',
  'Next rain',
  'Forecast next 24 h',
  'Soil now',
  'Tree stress',
  'Awaiting recommendation',
  'Confidence updates with the latest dendro run',
  'Driven by water balance',
  'Monitor today',
  'Local only',
  'Dendro active',
  'Soil tension (S1)',
  'Dragino LSN50 Nodes',
  'SDI-12 Soil Nodes',
  'Weather Stations',
  'Rain Gauges',
  'View history',
  'Configure',
];

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: { enabled: true, trigger_metric: 'SWT_1', threshold_kpa: 30, irrigation_zone_id: 12 },
} as unknown as IrrigationZone;

const summary = {
  zoneId: 12,
  zoneName: 'Zone B',
  generatedAt: '2026-07-08T10:00:00.000Z',
  location: { source: 'gateway', latitude: null, longitude: null, timezone: 'UTC' },
  water: {
    available: true,
    observedAt: '2026-07-08T09:55:00.000Z',
    areaM2: 100,
    irrigationEfficiencyPct: 80,
    rainTodayMm: 4.2,
    irrigationTodayLiters: 100,
    irrigationTodayNetMm: 0.8,
    irrigationTodayMeasuredLiters: 100,
    irrigationTodayEstimatedLiters: 120,
    waterNeededTodayMm: 3,
    balanceTodayMm: 1.2,
    next24hRainMm: 2.1,
    // No reasoning text, so the card falls back to its own localized subtitle.
    action: { code: 'monitor_today', source: 'water_balance', reasoning: undefined as unknown as string, recommendationDate: null },
    daily: [],
    sensorHealth: { sensorCount: 1, freshSensorCount: 1, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: true, warnings: [] },
  },
  local: {} as ZoneEnvironmentSummary['local'],
  online: { available: false, cacheStatus: 'miss' } as ZoneEnvironmentSummary['online'],
  agronomic: {} as ZoneEnvironmentSummary['agronomic'],
  forecast: { available: false } as ZoneEnvironmentSummary['forecast'],
  display: { mode: 'unlinked_local', schedulingMode: 'local', sourceLabel: 'Local only', sharedGeneratedAt: null, sharedObservedAt: null, lastReceivedAt: null, fallbackReason: null },
  drift: null,
} as ZoneEnvironmentSummary;

// One device of every kind the zone card groups, so every group heading and
// every gated tile renders in the same pass.
const devices = [
  { deveui: 'A1', name: 'Kiwi 1', type_id: 'KIWI_SENSOR', last_seen: '2026-07-08T09:55:00.000Z', latest_data: { swt_1: 45 } },
  { deveui: 'A2', name: 'Dendro 1', type_id: 'DRAGINO_LSN50', last_seen: '2026-07-08T09:55:00.000Z', latest_data: {}, dendro_enabled: 1, flow_meter_enabled: 1 },
  { deveui: 'A3', name: 'Probe 1', type_id: 'DRAGINO_SDI12', last_seen: '2026-07-08T09:55:00.000Z', latest_data: {} },
  { deveui: 'A4', name: 'Station 1', type_id: 'SENSECAP_S2120', last_seen: '2026-07-08T09:55:00.000Z', latest_data: {} },
  { deveui: 'A5', name: 'Gauge 1', type_id: 'AQUASCOPE_LORAIN', last_seen: '2026-07-08T09:55:00.000Z', latest_data: {} },
] as unknown as Device[];

async function buildI18n(language: string): Promise<I18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['devices', 'dashboard', 'common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: {
      en: { devices: enDevices, dashboard: enDashboard, common: enCommon },
      fr: { devices: frDevices, dashboard: frDashboard, common: frCommon },
    },
  });
  return instance;
}

/**
 * Whole-word match. A plain substring test would call the French "Configurer"
 * an English leak of "Configure".
 */
function occurs(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^\w/.test(phrase) ? '\\b' : '';
  const tail = /\w$/.test(phrase) ? '\\b' : '';
  return new RegExp(`${lead}${escaped}${tail}`).test(haystack);
}

/**
 * Visible text plus the attributes a screen reader or tooltip would read out.
 * Text nodes are joined with newlines rather than read off `body.textContent`,
 * which would run adjacent elements together ("1 device" + "Water balance")
 * and destroy the word boundaries `occurs` relies on.
 */
function renderedStrings(): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent) parts.push(node.textContent);
  }
  for (const element of Array.from(document.querySelectorAll('[title], [aria-label], [placeholder]'))) {
    for (const name of ['title', 'aria-label', 'placeholder']) {
      const value = element.getAttribute(name);
      if (value) parts.push(value);
    }
  }
  return parts.join('\n');
}

async function renderIn(language: string) {
  const instance = await buildI18n(language);
  render(
    <I18nextProvider i18n={instance}>
      <MemoryRouter>
        <IrrigationZoneCard zone={zone} devices={devices} unassignedDevices={[]} onUpdate={vi.fn()} />
      </MemoryRouter>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('heading', { name: 'Zone B' }));
  await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());
  await screen.findByTestId('water-today-card');
  // Expand the device list so the group headings render too.
  const heading = screen.queryByText(enDevices.zone.devicesInZone)
    ?? screen.getByText(frDevices.zone.devicesInZone);
  fireEvent.click(heading.closest('button')!);
}

beforeEach(() => {
  window.localStorage.clear();
  apiMocks.getZoneRecommendations.mockReset().mockResolvedValue([]);
  apiMocks.getSummary.mockReset().mockResolvedValue(summary);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IrrigationZoneCard locale coverage', () => {
  it('renders the English source strings when the language is English', async () => {
    await renderIn('en');
    const text = renderedStrings();
    const missing = PREVIOUSLY_HARDCODED.filter((phrase) => !occurs(text, phrase));
    expect(missing, 'English phrases the card should still render').toEqual([]);
  });

  it('leaks no English from the water card or the zone chips in French', async () => {
    await renderIn('fr');
    const text = renderedStrings();
    const leaked = PREVIOUSLY_HARDCODED.filter((phrase) => occurs(text, phrase));
    expect(leaked, 'untranslated English still rendered under fr').toEqual([]);
  });

  it('translates the branches the main fixture does not take', async () => {
    const instance = await buildI18n('fr');
    render(
      <I18nextProvider i18n={instance}>
        <MemoryRouter>
          <IrrigationZoneCard
            zone={{ ...zone, schedule: { ...(zone as any).schedule, enabled: false } } as unknown as IrrigationZone}
            devices={devices}
            unassignedDevices={[]}
            onUpdate={vi.fn()}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );
    expect(screen.getByText(frDevices.zone.chips.schedulerOff)).toBeInTheDocument();
    expect(screen.queryByText('Scheduler off')).not.toBeInTheDocument();
    expect(frDevices.zone.water.drivenByDendro).not.toBe('Driven by dendrometer recommendation');
  });

  it('names the provenance chip after the recommendation, not a water supply', async () => {
    // F36: the chip beside "Updated <time>" reports where the irrigation
    // recommendation came from (OSI Server, a local fallback, local only).
    // Its unrecognised-mode label used to read "Water source", which names a
    // supply of water instead.
    apiMocks.getSummary.mockResolvedValue({ ...summary, display: { ...summary.display, mode: null } });
    await renderIn('en');
    const card = screen.getByTestId('water-today-card');
    expect(card).toHaveTextContent('Recommendation source');
    expect(card).not.toHaveTextContent('Water source');

    cleanup();
    apiMocks.getSummary.mockResolvedValue({ ...summary, display: { ...summary.display, mode: null } });
    await renderIn('fr');
    expect(screen.getByTestId('water-today-card')).toHaveTextContent('Source de la recommandation');
  });

  it('formats the water-card timestamp with the app language, not the host locale', async () => {
    await renderIn('fr');
    const card = screen.getByTestId('water-today-card');
    const expected = new Intl.DateTimeFormat('fr', { hour: '2-digit', minute: '2-digit' })
      .format(new Date('2026-07-08T09:55:00.000Z'));
    expect(card).toHaveTextContent(`Mis à jour ${expected}`);
  });
});
