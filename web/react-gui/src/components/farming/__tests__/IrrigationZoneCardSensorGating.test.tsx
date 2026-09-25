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
      const statusLabel = ({
        'history.soil.state.wet': 'Wet',
        'history.soil.state.moist': 'Moist',
        'history.soil.state.dry': 'Dry',
      } as Record<string, string>)[key];
      if (statusLabel) return statusLabel;
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
  fireEvent.click(screen.getByRole('button', { expanded: false }));
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
    // The channel it came from, not the 45.0 kPa mean of two burial depths.
    expect(tile).toHaveTextContent('Soil now · Sensor 1');
    expect(tile).toHaveTextContent('45.2 kPa');
    expect(tile).toHaveTextContent('Moist');
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
    expect(screen.getByTestId('water-action-tile')).toBeInTheDocument();
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

describe('water card source gating', () => {
  it('hides the rain tile when nothing in the zone measures rain', async () => {
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    // The summary reports 4.2 mm for a zone with no gauge behind it: the
    // aggregation writes 0 for a day with no sample and the card used to
    // print it as a measurement.
    expect(screen.queryByTestId('water-rain-tile')).not.toBeInTheDocument();
    expect(screen.queryByText('Rain today')).not.toBeInTheDocument();
  });

  it('shows the rain tile for a weather station in the zone', async () => {
    await openCard([sensor({ type_id: 'SENSECAP_S2120', name: 'Station', last_seen: FRESH })]);

    expect(screen.getByTestId('water-rain-tile')).toHaveTextContent('4.2 mm');
  });

  it('shows the rain tile for a gauge the zone device list does not carry', async () => {
    // A shared S2120 reaches the zone through weather_station_zones, so the
    // edge knows about a rain source the card's own device list does not.
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: {
        ...summary.water,
        sensorHealth: { ...summary.water.sensorHealth, rainGaugePresent: true },
      },
    });
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    expect(screen.getByTestId('water-rain-tile')).toHaveTextContent('4.2 mm');
  });

  it('hides the forecast tile when there is no forecast', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: { ...summary.water, next24hRainMm: null },
    });
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    expect(screen.queryByText('Next rain')).not.toBeInTheDocument();
  });

  it('renders no water card at all when the zone has never observed anything', async () => {
    // The empty-zone screen: no devices, no coordinates, no data, and a full
    // water card of zeros with a seven-day chart of zeros underneath it.
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: {
        ...summary.water,
        observedAt: null,
        rainTodayMm: 0,
        irrigationTodayMeasuredLiters: 0,
        balanceTodayMm: null,
        action: { code: null, source: 'insufficient_data', reasonCode: 'balance_unknown', recommendationDate: null },
      },
    });
    render(
      <MemoryRouter>
        <IrrigationZoneCard zone={zone} devices={[]} unassignedDevices={[]} onUpdate={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());

    expect(screen.queryByTestId('water-today-card')).not.toBeInTheDocument();
    expect(screen.queryByText('0.0 mm')).not.toBeInTheDocument();
  });
});

describe('water card reason line', () => {
  it('translates the edge reason code instead of printing its prose', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: {
        ...summary.water,
        action: {
          code: 'delay_irrigation',
          source: 'heuristic',
          reasonCode: 'supply_covers_demand',
          recommendationDate: '2026-07-08',
        },
      },
    });
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    const card = screen.getByTestId('water-today-card');
    expect(card).toHaveTextContent("Rain and irrigation cover today's demand");
    expect(card).not.toHaveTextContent('supply_covers_demand');
    expect(card).not.toHaveTextContent('Daily rain, irrigation, and crop demand summary');
  });

  it('keeps the stored dendrometer reasoning, which is data and not prose the edge wrote', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...summary,
      water: {
        ...summary.water,
        action: {
          code: 'increase_10',
          source: 'dendro',
          reasonCode: null,
          reasoning: 'Stress rose for three consecutive days.',
          recommendationDate: '2026-07-08',
        },
      },
    });
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 45.2 } })]);

    expect(screen.getByTestId('water-today-card')).toHaveTextContent('Stress rose for three consecutive days.');
  });
});

describe('soil tile channel and verdict', () => {
  it('keeps future-dated samples out of the last-valid value and timestamp', async () => {
    await openCard([
      sensor({ deveui: 'OLD', last_seen: STALE, latest_data: { swt_1: 10 } }),
      sensor({ deveui: 'FUTURE', last_seen: '2027-07-08T12:00:00.000Z', latest_data: { swt_1: 90 } }),
    ]);
    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('Last valid 10.0 kPa');
    expect(tile).not.toHaveTextContent('50.0 kPa');
    expect(tile).not.toHaveTextContent('2027');
    expect(tile.querySelector('[data-swt-status]')).toBeNull();
  });

  const scheduledZone = {
    ...zone,
    schedule: { irrigation_zone_id: 12, trigger_metric: 'SWT_1', threshold_kpa: 30, enabled: true },
  } as IrrigationZone;

  async function openScheduled(devices: Device[]) {
    render(
      <MemoryRouter>
        <IrrigationZoneCard zone={scheduledZone} devices={devices} unassignedDevices={[]} onUpdate={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());
    await screen.findByTestId('water-today-card');
  }

  it('reports the channel the scheduler triggers on, with its depth', async () => {
    await openScheduled([sensor({
      last_seen: FRESH,
      soilMoistureProbeDepths: { swt_1: 20, swt_2: 60 },
      latest_data: { swt_1: 56.5, swt_2: 20 },
    })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('Soil now · 20 cm');
    expect(tile).toHaveTextContent('56.5 kPa');
  });

  it('shows fixed status alongside the zone trigger comparison', async () => {
    await openScheduled([sensor({ last_seen: FRESH, latest_data: { swt_1: 56.5 } })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('At or past the trigger');
    expect(tile).toHaveTextContent('Dry');
  });

  it('says a reading is approaching the trigger within 20 percent of it', async () => {
    await openScheduled([sensor({ last_seen: FRESH, latest_data: { swt_1: 26 } })]);

    expect(screen.getByTestId('water-soil-tile')).toHaveTextContent('Approaching the trigger');
  });

  it('says a reading is below the trigger', async () => {
    await openScheduled([sensor({ last_seen: FRESH, latest_data: { swt_1: 10 } })]);

    expect(screen.getByTestId('water-soil-tile')).toHaveTextContent('Below the trigger');
  });

  it('keeps the absolute buckets for a zone with no schedule', async () => {
    await openCard([sensor({ last_seen: FRESH, latest_data: { swt_1: 56.5 } })]);

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('Dry');
    expect(tile).not.toHaveTextContent('trigger');
  });

  it('does not compare a dendrometer stress level against a kPa reading', async () => {
    // threshold_kpa carries an encoded 1-4 stress level when the metric is
    // DENDRO, so it is not a tension the soil reading can be judged against.
    const dendroZone = {
      ...zone,
      schedule: { irrigation_zone_id: 12, trigger_metric: 'DENDRO', threshold_kpa: 2, enabled: true },
    } as IrrigationZone;
    render(
      <MemoryRouter>
        <IrrigationZoneCard zone={dendroZone} devices={[sensor({ last_seen: FRESH, latest_data: { swt_1: 56.5 } })]} unassignedDevices={[]} onUpdate={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByTestId('water-today-card');

    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('Dry');
    expect(tile).not.toHaveTextContent('trigger');
  });
  it('shows SDI-12 Tensiomark as moist tension', async () => {
    await openCard([sensor({
      type_id: 'DRAGINO_SDI12',
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest_data: { swt_1: 30.2, soil_temp_1: 21.5 },
    })]);
    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('30.2 kPa');
    expect(tile).toHaveTextContent('Moist');
    expect(tile).not.toHaveTextContent('Volumetric water content');
  });

  it('does not apply an absent scheduled channel threshold to a fallback channel', async () => {
    await openScheduled([sensor({ last_seen: FRESH, latest_data: { swt_2: 56.5 } })]);
    const tile = screen.getByTestId('water-soil-tile');
    expect(tile).toHaveTextContent('Dry');
    expect(tile).not.toHaveTextContent('At or past the trigger');
    expect(tile).not.toHaveTextContent('Approaching the trigger');
    expect(tile).not.toHaveTextContent('Below the trigger');
  });

});
