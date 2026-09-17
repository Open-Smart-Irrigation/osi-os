import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { Device, IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';
import { SENSOR_FRESHNESS_WINDOW_MS } from '../../../utils/zoneSoil';

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
  ScheduleSection: () => <div data-testid="schedule-section" />,
  normalizeTriggerMetric: (value: string) => value,
}));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => <div /> }));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => <div /> }));
vi.mock('../../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: vi.fn(() => false) }));

// Same shape as the other zone-card suites: resolve `defaultValue` and
// `{{placeholders}}` so assertions read the English the card renders.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      const values = (options ?? {}) as Record<string, unknown>;
      const template = typeof values.defaultValue === 'string' ? values.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''));
    },
  }),
}));

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();
const STALE = new Date(NOW - SENSOR_FRESHNESS_WINDOW_MS - 60 * 60 * 1000).toISOString();

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

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
    action: { code: 'monitor_today', source: 'water_balance', reasoning: 'Rain covered demand.', recommendationDate: null },
    daily: [],
    sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: [] },
  },
  local: {} as ZoneEnvironmentSummary['local'],
  online: { available: false, cacheStatus: 'miss' } as ZoneEnvironmentSummary['online'],
  agronomic: {} as ZoneEnvironmentSummary['agronomic'],
  forecast: { available: false } as ZoneEnvironmentSummary['forecast'],
  display: { mode: 'unlinked_local', schedulingMode: 'local', sourceLabel: 'Local only', sharedGeneratedAt: null, sharedObservedAt: null, lastReceivedAt: null, fallbackReason: null },
  drift: null,
} as ZoneEnvironmentSummary;

function sensor(overrides: Partial<Device>): Device {
  return {
    deveui: 'A84041A75D5E0001',
    name: 'Soil 1',
    type_id: 'KIWI_SENSOR',
    latest_data: {},
    ...overrides,
  } as Device;
}

async function openCard(devices: Device[]) {
  render(
    <MemoryRouter>
      <IrrigationZoneCard zone={zone} devices={devices} unassignedDevices={[]} onUpdate={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('heading', { name: 'Zone B' }));
  await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());
  await screen.findByTestId('water-today-card');
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  window.localStorage.clear();
  apiMocks.getZoneRecommendations.mockReset().mockResolvedValue([]);
  apiMocks.getSummary.mockReset().mockResolvedValue(summary);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('water card sensor gating', () => {
  it('hides the soil tile when the zone has no soil sensor', async () => {
    await openCard([sensor({ type_id: 'STREGA_VALVE', name: 'Valve 1' })]);

    expect(screen.queryByTestId('water-soil-tile')).not.toBeInTheDocument();
    expect(screen.queryByText('Soil now')).not.toBeInTheDocument();
  });

  it('shows the soil tile with a reading when a fresh soil sensor exists', async () => {
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2, swt_2: 44.8 } })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('45.0 kPa');
    expect(tile).toHaveTextContent('Moderate');
    expect(tile).not.toHaveTextContent('No reading since');
  });

  it('keeps the tile and names the gap when the sensor has gone quiet', async () => {
    await openCard([sensor({ last_seen: STALE, latest_data: { swt_1: 72 } })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('No reading since 4 hours ago');
    // The last value the sensor did report stays on screen with its timestamp,
    // so a silent sensor never reads as a fresh measurement.
    expect(tile.textContent).toMatch(/Last valid 72\.0 kPa · /);
    expect(tile).not.toHaveTextContent('Dry');
  });

  it('says so when a configured sensor has never reported', async () => {
    await openCard([sensor({ last_seen: null, latest_data: {} })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('No reading yet');
    expect(tile).not.toHaveTextContent('0.0 kPa');
  });

  it('calls an out-of-range reading invalid instead of charting it', async () => {
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 4200 } })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('Invalid reading');
    expect(tile).not.toHaveTextContent('4200');
  });

  it('reports an SDI-12 probe as volumetric water content in percent', async () => {
    await openCard([sensor({ type_id: 'DRAGINO_SDI12', last_seen: FRESH, latest_data: { vwc_1: 28, vwc_2: 32 } })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('30.0 %');
    expect(tile).toHaveTextContent('Volumetric water content');
  });

  it('hides the flow-meter tile unless a device has the flow meter enabled', async () => {
    await openCard([sensor({ type_id: 'DRAGINO_LSN50', flow_meter_enabled: 0, last_seen: FRESH })]);

    expect(screen.queryByTestId('water-flow-meter-tile')).not.toBeInTheDocument();
    expect(screen.queryByText('Measured (flow meter)')).not.toBeInTheDocument();
    // The tiles that do not depend on a meter stay put.
    expect(screen.getByText('Rain today')).toBeInTheDocument();
  });

  it('shows the flow-meter tile once one is enabled in the zone', async () => {
    await openCard([sensor({ type_id: 'DRAGINO_LSN50', flow_meter_enabled: 1, last_seen: FRESH })]);

    const tile = screen.getByTestId('water-flow-meter-tile');
    expect(tile).toHaveTextContent('Measured (flow meter)');
    expect(tile).toHaveTextContent('100 L');
    expect(tile).toHaveTextContent('Estimated (valve time × calibration): 120 L');
  });
});

describe('water action tile', () => {
  it('renders the recommendation when the edge could compute one', async () => {
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    const tile = screen.getByTestId('water-action-tile');
    expect(tile).toHaveTextContent('Monitor today');
    expect(tile).toHaveTextContent('Driven by water balance');
  });

  it('advises nothing when the balance could not be computed', async () => {
    // Every zone until someone fills in area and irrigation efficiency. The
    // edge used to read the missing balance as 0 and answer "Delay
    // irrigation" — the one recommendation that costs a crop when it is wrong.
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: {
        ...summary.water,
        areaM2: null,
        irrigationEfficiencyPct: null,
        balanceTodayMm: null,
        action: {
          code: null,
          source: 'insufficient_data',
          reasonCode: 'balance_unknown',
          recommendationDate: '2026-07-08',
        },
      },
    });
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    const tile = screen.getByTestId('water-action-tile');
    expect(tile).toHaveTextContent('Not enough data to advise');
    expect(tile).toHaveTextContent('Set zone area and irrigation efficiency');
    expect(tile).not.toHaveTextContent('Delay irrigation');
    expect(tile).not.toHaveTextContent('Monitor water status');
    expect(tile).not.toHaveTextContent('Driven by water balance');
  });

  it('names a missing forecast as the reason it cannot advise', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: {
        ...summary.water,
        balanceTodayMm: -3,
        next24hRainMm: null,
        action: {
          code: null,
          source: 'insufficient_data',
          reasonCode: 'forecast_unknown',
          recommendationDate: '2026-07-08',
        },
      },
    });
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    expect(screen.getByTestId('water-action-tile')).toHaveTextContent('No rain forecast available');
  });

  it('falls back to a generic reason for a code it does not know', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: {
        ...summary.water,
        action: { code: null, source: 'insufficient_data', reasonCode: 'cloud_only_code', recommendationDate: null },
      },
    });
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    const tile = screen.getByTestId('water-action-tile');
    expect(tile).toHaveTextContent('Waiting for more data');
    expect(tile).not.toHaveTextContent('cloud_only_code');
  });
});
