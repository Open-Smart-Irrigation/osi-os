// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enCommon from '../../../../public/locales/en/common.json';
import enDevices from '../../../../public/locales/en/devices.json';
import enHistory from '../../../../public/locales/en/history.json';
import enValves from '../../../../public/locales/en/valves.json';
import type { Device, ValveSummary } from '../../../types/farming';
import { DraginoTempCard } from '../DraginoTempCard';
import { FieldTesterCard } from '../FieldTesterCard';
import { KiwiSensorCard } from '../KiwiSensorCard';
import { LoRainGaugeCard } from '../LoRainGaugeCard';
import { Sdi12SoilCard } from '../Sdi12SoilCard';
import { SenseCapWeatherCard } from '../SenseCapWeatherCard';
import { StregaValveCard } from '../StregaValveCard';
import { ValveTile } from '../valves/ValveTile';

// Owner decision 2026-10-21: every device card has the same footer (battery left, last seen
// right) and no battery tile or last-seen line in its body or header.

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn(), rename: vi.fn(), controlValve: vi.fn(), cancelIrrigation: vi.fn() },
  deviceMetadataAPI: { setSoilMoistureDepths: vi.fn() },
  kiwiAPI: { setUplinkInterval: vi.fn(), enableTemperatureHumidity: vi.fn() },
  valveAPI: { getTodayLiters: vi.fn().mockResolvedValue({ liters: null, source: 'unknown' }) },
  s2120API: { setZoneAssignments: vi.fn() },
  sensorAPI: { getHistory: vi.fn().mockResolvedValue([]) },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('../../../hooks/useGatewayModules', () => ({
  useGatewayModules: () => ({ data: true, network: true, gatewayHub: true, journal: true }),
}));

const NOW = Date.parse('2026-10-21T08:00:00.000Z');
const FRESH = new Date(NOW - 15 * 60_000).toISOString();

function i18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en', fallbackLng: false, defaultNS: 'devices', ns: ['devices', 'common', 'history', 'valves'],
    resources: { en: { devices: enDevices, common: enCommon, history: enHistory, valves: enValves } },
    interpolation: { escapeValue: false }, react: { useSuspense: false }, initImmediate: false,
  });
  return instance;
}

const device = (type: Device['type_id'], over: Partial<Device> = {}, latest: Device['latest_data'] = {}): Device => ({
  deveui: `TEST-EUI-${type}`, name: `Test ${type}`, type_id: type, last_seen: FRESH, latest_data: latest, ...over,
} as Device);

const valve: ValveSummary = {
  deviceEui: 'TEST-EUI-VALVE', name: 'Test valve', zoneId: 1, zoneName: 'Zone A', zoneUuid: 'zone-a',
  timezone: 'Europe/Zurich', currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN1',
  flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE',
  skipTodayDate: null, lastUplinkAt: FRESH, activeActuation: null, recentStaleState: null, nextRun: null,
  scheduleCount: 0, pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
  lastClockSyncAckedAt: null, enclosureTemperatureC: null, enclosureHumidityPct: null, enclosureMeasuredAt: null,
};
const noop = () => undefined;

interface CardCase {
  name: string;
  element: ReactElement;
  /** Expected battery text, or null for a device without a battery reading. */
  battery: string | null;
  lastSeen: string;
}

const CARDS: CardCase[] = [
  { name: 'Kiwi', element: <KiwiSensorCard removeContext="farm" device={device('KIWI_SENSOR', {}, { swt_1: 30, bat_pct: 80 })} />, battery: '80%', lastSeen: 'Last seen 15 min ago' },
  { name: 'Clover', element: <KiwiSensorCard removeContext="farm" device={device('TEKTELIC_CLOVER', {}, { ambient_temperature: 18, bat_pct: 12 })} />, battery: '12%', lastSeen: 'Last seen 15 min ago' },
  { name: 'STREGA card', element: <StregaValveCard removeContext="farm" onUpdate={noop} device={device('STREGA_VALVE', { current_state: 'CLOSED' }, { bat_pct: 64 })} />, battery: '64%', lastSeen: 'Last seen 15 min ago' },
  { name: 'STREGA valve tile', element: <ValveTile valve={valve} nowMs={NOW} onOpen={noop} onSchedule={noop} onCancel={noop} onSkipToday={noop} onPause={noop} onResume={noop} onResend={noop} onSettings={noop} onService={noop} onDelete={noop} canEdit={false} onRename={async () => undefined} busy={false} batteryPercent={55} />, battery: '55%', lastSeen: 'Last seen 15 min ago' },
  { name: 'LSN50 temperature', element: <DraginoTempCard removeContext="farm" device={device('DRAGINO_LSN50', { temp_enabled: 1 }, { ext_temperature_c: 12.5, bat_v: 3.5 })} />, battery: '≈ 93%', lastSeen: 'Last seen 15 min ago' },
  { name: 'LSN50 WATERMARK', element: <DraginoTempCard removeContext="farm" device={device('DRAGINO_LSN50', {}, { bat_v: 3.3, watermark: { recorded_at: FRESH, supply_mv: null, soil_temp_c: null, soil_temp_source: null, die_temp_c: null, channels: [{ status: 'ok', kpa: 20, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null }, { status: 'ok', kpa: 40, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null }] } })} />, battery: '≈ 80%', lastSeen: 'Last seen 15 min ago' },
  { name: 'LSN50 rain gauge', element: <DraginoTempCard removeContext="farm" device={device('DRAGINO_LSN50', { rain_gauge_enabled: 1 }, { rain_mm_delta: 0.2, bat_v: 3.6 })} />, battery: '≈ 100%', lastSeen: 'Last seen 15 min ago' },
  { name: 'SDI-12 Tensiomark', element: <Sdi12SoilCard removeContext="farm" device={device('DRAGINO_SDI12', { sdi12_probe_profile: 'TENSIOMARK', sdi12_probe_status: 'identified' }, { swt_1: 30, bat_v: 3.6 })} />, battery: '≈ 100%', lastSeen: 'Last seen 15 min ago' },
  { name: 'SDI-12 Sentek', element: <Sdi12SoilCard removeContext="farm" device={device('DRAGINO_SDI12', { sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: 'identified', soil_moisture_probe_depths_json: { vwc_1: 10 } }, { vwc_1: 30.5 })} />, battery: null, lastSeen: 'Last seen 15 min ago' },
  { name: 'S2120 weather station', element: <SenseCapWeatherCard removeContext="farm" device={device('SENSECAP_S2120', {}, { ambient_temperature: 18, bat_pct: 90 })} />, battery: '90%', lastSeen: 'Last seen 15 min ago' },
  { name: 'LoRain gauge (voltage only: no LSN50 curve)', element: <LoRainGaugeCard removeContext="farm" device={device('AQUASCOPE_LORAIN', {}, { rain_mm_delta: 0.5, bat_v: 3.0 })} />, battery: null, lastSeen: 'Last seen 15 min ago' },
  { name: 'Field tester (no battery, no last seen)', element: <MemoryRouter><FieldTesterCard removeContext="farm" device={device('RAK10701_FIELD_TESTER', { last_seen: null })} /></MemoryRouter>, battery: null, lastSeen: 'Readings appear on the network map.' },
];

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('every device card shares one footer', () => {
  it.each(CARDS)('$name: one footer with battery left and last seen right', ({ element, battery, lastSeen }) => {
    const { container } = render(<I18nextProvider i18n={i18n()}>{element}</I18nextProvider>);
    const footers = screen.getAllByTestId('device-card-footer');
    expect(footers).toHaveLength(1);
    const footer = footers[0];
    // Pinned to the bottom of a flex-column card, so cards of one row line up.
    expect(footer).toHaveClass('mt-auto');
    expect(footer.parentElement).toHaveClass('flex', 'h-full', 'flex-col');
    expect(footer.firstElementChild).toHaveClass('min-h-5', 'border-t');
    const slot = within(footer).getByTestId('device-card-battery');
    if (battery === null) expect(slot).toBeEmptyDOMElement();
    else expect(slot).toHaveTextContent(battery);
    expect(within(footer).getByTestId('device-card-last-seen')).toHaveTextContent(lastSeen);

    // Nothing above the footer repeats the battery or the age.
    footer.remove();
    expect(container).not.toHaveTextContent(/battery|last seen|last report|never seen|minutes? ago/i);
  });

  it('shows a low battery in amber on any card', () => {
    render(<I18nextProvider i18n={i18n()}>{CARDS[1].element}</I18nextProvider>);
    expect(screen.getByTestId('device-card-battery')).toHaveAttribute('data-battery-low', 'true');
  });
});
