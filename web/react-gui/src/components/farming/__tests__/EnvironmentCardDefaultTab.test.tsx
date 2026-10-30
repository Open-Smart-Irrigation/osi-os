// @vitest-environment jsdom
//
// #310 follow-up, owner-selected behaviour: the Environment card opens on
// Weather when the zone really has current conditions or forecast content
// (a source flag or an all-null section is not content; a finite measured
// zero is), otherwise on the first of Water/Soil/Sensors/Agronomy that has
// something, with an explicit localized no-data state when none does. A tab
// chosen by hand survives the 5-minute refresh even if its data goes away; a
// zone switch resets the choice and never shows the previous zone's summary
// while the new fetch is in flight or when the old one resolves late.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next, { type i18n as I18n } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EnvironmentCard } from '../environment/EnvironmentCard';
import type { DailyForecast, Device, IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';

import enDevices from '../../../../public/locales/en/devices.json';

const apiMocks = vi.hoisted(() => ({ getSummary: vi.fn() }));

vi.mock('../../../services/api', () => ({
  environmentAPI: { getSummary: apiMocks.getSummary },
}));

const zoneA = { id: 12, name: 'Zone B' } as unknown as IrrigationZone;
const zoneB = { id: 13, name: 'Zone C' } as unknown as IrrigationZone;
const devices: Device[] = [];

const tabs = enDevices.environment.tabs;

function buildSummary(overrides: {
  online?: Partial<ZoneEnvironmentSummary['online']>;
  forecast?: Partial<ZoneEnvironmentSummary['forecast']>;
  water?: Partial<ZoneEnvironmentSummary['water']>;
  local?: Partial<ZoneEnvironmentSummary['local']>;
  agronomic?: Partial<ZoneEnvironmentSummary['agronomic']>;
  location?: Partial<ZoneEnvironmentSummary['location']>;
} = {}): ZoneEnvironmentSummary {
  return {
    zoneId: 12,
    zoneName: 'Zone B',
    generatedAt: '2026-10-30T10:00:00.000Z',
    location: { latitude: 47.3769, longitude: 8.5417, timezone: 'Europe/Zurich', source: 'zone', ...overrides.location },
    water: {
      available: false,
      observedAt: null,
      action: null,
      daily: [],
      sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: [] },
      ...overrides.water,
    },
    local: { available: false, observedAt: null, sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, metrics: [], devices: [], ...overrides.local },
    online: { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null, ...overrides.online },
    agronomic: { preferredSource: 'local', current: null, ...overrides.agronomic },
    forecast: { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null, ...overrides.forecast },
    display: null,
    drift: null,
  } as ZoneEnvironmentSummary;
}

const emptyRainFocus = {
  totalNext24hMm: null,
  totalNext72hMm: null,
  maxHourlyRainMm: 0,
  maxHourlyRainAt: null,
  nextRainEta: null,
  rainHoursNext24h: 0,
  daily: [],
  hourly: [],
};

const forecastOnly = buildSummary({
  location: { source: 'zone' },
  forecast: {
    available: true, source: 'open_meteo', cacheStatus: 'live',
    observedAt: '2026-10-30T10:00:00.000Z', expiresAt: '2026-10-30T11:00:00.000Z',
    rainFocus: { ...emptyRainFocus, totalNext24hMm: 3, totalNext72hMm: 4 },
  },
});

const currentOnly = buildSummary({
  online: {
    available: true, source: 'open_meteo', cacheStatus: 'live',
    observedAt: '2026-10-30T10:00:00.000Z', expiresAt: null,
    current: {
      description: null, weatherCode: null, airTemperatureC: 0, relativeHumidityPct: null,
      pressureHpa: null, windSpeedMps: null, windDirectionDeg: null, cloudCoverPct: null, rainMm: null, precipitationProbabilityPct: null,
    },
  },
});

const sensorMetric = { key: 'air_temperature_c', label: 'Air temperature', unit: '°C', mean: 20, median: 20, min: 19, max: 21, sampleCount: 2 };
const soilMetric = { ...sensorMetric, key: 'soil_moisture_pct' };
const waterOnly = buildSummary({ water: { available: true, waterNeededTodayMm: 2.5 } });
const soilOnly = buildSummary({ local: { available: true, metrics: [soilMetric, sensorMetric], devices: [] } });
const sensorsOnly = buildSummary({ local: { available: true, metrics: [sensorMetric], devices: [] } });
const agronomicOnly = buildSummary({
  agronomic: {
    preferredSource: 'local',
    current: {
      thermodynamicSource: 'open_meteo', evapotranspirationSource: 'open_meteo', cropCoefficientSource: 'fao56_curve',
      airTemperatureC: null, relativeHumidityPct: null, vpdKpa: 1.1, dewPointC: null, heatIndexC: null,
      thi: null, referenceEt0MmDay: null, cropCoefficientKc: null, etcMmDay: null,
    },
  },
});

async function buildI18n(): Promise<I18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['devices'],
    defaultNS: 'devices',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: { en: { devices: enDevices } },
  });
  return instance;
}

function tabButton(id: keyof typeof tabs) {
  return screen.getByRole('button', { name: tabs[id] });
}

async function renderExpanded(zone: IrrigationZone = zoneA, zoneDevices: Device[] = devices) {
  const instance = await buildI18n();
  const view = render(
    <I18nextProvider i18n={instance}>
      <EnvironmentCard zone={zone} devices={zoneDevices} />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  return { ...view, instance };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  apiMocks.getSummary.mockReset();
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('EnvironmentCard default tab (#310)', () => {
  it('opens on Weather for forecast-only content without a click', async () => {
    apiMocks.getSummary.mockResolvedValue(forecastOnly);
    await renderExpanded();

    expect(await screen.findByText('3.0 mm')).toBeInTheDocument();
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'true');
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens on Weather for current-only content and renders a measured zero temperature', async () => {
    apiMocks.getSummary.mockResolvedValue(currentOnly);
    await renderExpanded();

    expect(await screen.findByText('0.0 °C')).toBeInTheDocument();
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens on Weather for a forecast of finite zero rain (a dry forecast is data)', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary({
      forecast: {
        available: true, source: 'open_meteo', cacheStatus: 'live',
        observedAt: '2026-10-30T10:00:00.000Z', expiresAt: null,
        rainFocus: { ...emptyRainFocus, totalNext24hMm: 0, totalNext72hMm: 0 },
      },
    }));
    await renderExpanded();

    expect(await screen.findAllByText('0.0 mm')).toHaveLength(2);
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'true');
  });

  it.each<[Partial<DailyForecast>, string]>([
    [{ maxTempC: 17 }, '17°/—'],
    [{ minTempC: 6 }, '—/6°'],
    [{ maxTempC: 0 }, '0°/—'],
    [{ rainMm: 0 }, '0.0 mm'],
    [{ rainProbabilityPct: 10 }, '10%'],
    [{ rainProbabilityPct: 0 }, '0%'],
  ])('displays the partial daily forecast that selects Weather: %j', async (fields, visibleValue) => {
    const day: DailyForecast = {
      date: '2026-10-30', description: null, weatherCode: null,
      maxTempC: null, minTempC: null, rainMm: null, rainProbabilityPct: null,
      windSpeedMps: null, et0MmDay: null, etcMmDay: null, ...fields,
    };
    apiMocks.getSummary.mockResolvedValue(buildSummary({
      water: { available: true, waterNeededTodayMm: 2.5 },
      forecast: { available: true, rainFocus: { ...emptyRainFocus, daily: [day] } },
    }));
    await renderExpanded();

    expect(await screen.findByText(visibleValue)).toBeInTheDocument();
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('2.5 mm')).not.toBeInTheDocument();
  });

  it('does not open on Weather for an available online section whose current object is empty', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary({
      online: {
        available: true, source: 'open_meteo', cacheStatus: 'live',
        observedAt: '2026-10-30T10:00:00.000Z', expiresAt: null,
        current: {
          description: null, weatherCode: null, airTemperatureC: null, relativeHumidityPct: null,
          pressureHpa: null, windSpeedMps: null, windDirectionDeg: null, cloudCoverPct: null, rainMm: null, precipitationProbabilityPct: null,
        },
      },
      water: { available: true, waterNeededTodayMm: 2.5 },
    }));
    await renderExpanded();

    expect(await screen.findByText('2.5 mm')).toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not open on Weather for a forecast that carries only timestamps and counts', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary({
      forecast: {
        available: true, source: 'open_meteo', cacheStatus: 'live',
        observedAt: '2026-10-30T10:00:00.000Z', expiresAt: null,
        rainFocus: {
          ...emptyRainFocus,
          nextRainEta: '2026-10-30T14:00:00Z',
          rainHoursNext24h: 3,
          next24hCoverage: { coveredHours: 24, expectedHours: 24 },
        },
      },
      water: { available: true, waterNeededTodayMm: 2.5 },
    }));
    await renderExpanded();

    expect(await screen.findByText('2.5 mm')).toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back Water, Soil, Sensors, Agronomy in that order', async () => {
    apiMocks.getSummary.mockResolvedValueOnce(waterOnly);
    await renderExpanded();
    expect(await screen.findByText('2.5 mm')).toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
    cleanup();

    apiMocks.getSummary.mockResolvedValueOnce(soilOnly);
    await renderExpanded();
    expect(await screen.findByText(enDevices.environment.soil.moistureVwc)).toBeInTheDocument();
    expect(tabButton('soil')).toHaveAttribute('aria-pressed', 'true');
    cleanup();

    apiMocks.getSummary.mockResolvedValueOnce(sensorsOnly);
    await renderExpanded();
    expect(await screen.findByText('20.0 °C')).toBeInTheDocument();
    expect(tabButton('sensors')).toHaveAttribute('aria-pressed', 'true');
    cleanup();

    apiMocks.getSummary.mockResolvedValueOnce(agronomicOnly);
    await renderExpanded();
    expect(await screen.findByText('1.10 kPa')).toBeInTheDocument();
    expect(tabButton('agronomic')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the localized no-data state when no tab has content, and keeps every tab reachable', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary());
    await renderExpanded();

    expect(await screen.findByText(enDevices.environment.noData)).toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
    // Reachable: an unavailable tab still opens and shows its own honest state.
    fireEvent.click(tabButton('sensors'));
    expect(await screen.findByText(enDevices.environment.local.noData)).toBeInTheDocument();
    expect(tabButton('sensors')).toHaveAttribute('aria-pressed', 'true');
  });

  it('skips unavailable Water history for a visible device soil reading', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary({ water: {
      available: false,
      daily: [{ date: '2026-10-29', rainMm: 4, irrigationLiters: null, irrigationNetMm: null, totalWaterMm: null }],
    } }));
    await renderExpanded(zoneA, [{ latest_data: { swt_1: 25 } } as Device]);

    expect(await screen.findByText('25.0 kPa')).toBeInTheDocument();
    expect(tabButton('soil')).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens Water for source-supported historical zero rain and displays its chart', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary({ local: sensorsOnly.local, water: {
      available: true,
      sensorHealth: { sensorCount: 1, freshSensorCount: 1, staleSensorCount: 0, rainGaugePresent: true, flowMeterPresent: false, warnings: [] },
      daily: [{ date: '2026-10-29', rainMm: 0, irrigationLiters: null, irrigationNetMm: null, totalWaterMm: null }],
    } }));
    await renderExpanded();

    expect(await screen.findByTestId('water-trend-chart')).toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
  });

  it('skips historical received-only rain that the Water chart does not display', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary({ local: soilOnly.local, water: {
      available: true,
      daily: [{ date: '2026-10-29', rainMm: null, rainReceivedMm: 2, irrigationLiters: null, irrigationNetMm: null, totalWaterMm: null }],
    } }));
    await renderExpanded();

    expect(await screen.findByText(enDevices.environment.soil.moistureVwc)).toBeInTheDocument();
    expect(tabButton('soil')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('EnvironmentCard selection persistence (#310)', () => {
  it('updates the automatic tab on device refresh and preserves a later manual choice', async () => {
    apiMocks.getSummary.mockResolvedValue(buildSummary());
    const { rerender, instance } = await renderExpanded();
    await screen.findByText(enDevices.environment.noData);

    const soilDevices = [{ latest_data: { swt_1: 25 } } as Device];
    rerender(<I18nextProvider i18n={instance}><EnvironmentCard zone={zoneA} devices={soilDevices} /></I18nextProvider>);
    expect(await screen.findByText('25.0 kPa')).toBeInTheDocument();
    expect(tabButton('soil')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(tabButton('weather'));
    rerender(<I18nextProvider i18n={instance}><EnvironmentCard zone={zoneA} devices={devices} /></I18nextProvider>);
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'true');
    expect(apiMocks.getSummary).toHaveBeenCalledTimes(1);
  });

  it('keeps a manually chosen tab across the 5-minute refresh even when its data disappears', async () => {
    vi.useFakeTimers();
    apiMocks.getSummary.mockResolvedValueOnce(forecastOnly);
    await renderExpanded();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('3.0 mm')).toBeInTheDocument();
    fireEvent.click(tabButton('soil'));
    expect(tabButton('soil')).toHaveAttribute('aria-pressed', 'true');

    apiMocks.getSummary.mockResolvedValueOnce(waterOnly);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    // The refresh landed (the forecast is gone) but the hand-picked Soil tab
    // stays selected even though the new summary has no soil content.
    expect(screen.queryByText('3.0 mm')).not.toBeInTheDocument();
    expect(tabButton('soil')).toHaveAttribute('aria-pressed', 'true');
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'false');
  });

  it('recomputes the data-based default on refresh while no tab was chosen by hand', async () => {
    vi.useFakeTimers();
    apiMocks.getSummary.mockResolvedValueOnce(forecastOnly);
    await renderExpanded();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'true');

    apiMocks.getSummary.mockResolvedValueOnce(waterOnly);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(screen.getByText('2.5 mm')).toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'false');
  });

  it('resets the choice on zone switch and shows neither the old zone\'s data nor its tab while the new fetch is pending', async () => {
    apiMocks.getSummary.mockResolvedValueOnce(forecastOnly);
    const { rerender } = await renderExpanded(zoneA);
    await screen.findByText('3.0 mm');
    fireEvent.click(tabButton('agronomic'));
    expect(tabButton('agronomic')).toHaveAttribute('aria-pressed', 'true');

    const pending = deferred<ZoneEnvironmentSummary>();
    apiMocks.getSummary.mockReturnValueOnce(pending.promise);
    const instance = await buildI18n();
    rerender(
      <I18nextProvider i18n={instance}>
        <EnvironmentCard zone={zoneB} devices={devices} />
      </I18nextProvider>,
    );

    expect(await screen.findByText(enDevices.environment.loading)).toBeInTheDocument();
    expect(screen.queryByText('3.0 mm')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tabs.water })).not.toBeInTheDocument();

    await act(async () => { pending.resolve(waterOnly); });
    expect(await screen.findByText('2.5 mm')).toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
    expect(tabButton('agronomic')).toHaveAttribute('aria-pressed', 'false');
  });

  it('ignores a late resolution of the previous zone\'s fetch', async () => {
    const late = deferred<ZoneEnvironmentSummary>();
    apiMocks.getSummary.mockReturnValueOnce(late.promise);
    const { rerender } = await renderExpanded(zoneA);

    apiMocks.getSummary.mockResolvedValueOnce(waterOnly);
    const instance = await buildI18n();
    rerender(
      <I18nextProvider i18n={instance}>
        <EnvironmentCard zone={zoneB} devices={devices} />
      </I18nextProvider>,
    );
    expect(await screen.findByText('2.5 mm')).toBeInTheDocument();

    await act(async () => { late.resolve(forecastOnly); });
    expect(screen.queryByText('3.0 mm')).not.toBeInTheDocument();
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('EnvironmentCard responsive controls (#310)', () => {
  it('gives every tab an aria-pressed toggle that stays keyboard reachable', async () => {
    apiMocks.getSummary.mockResolvedValue(waterOnly);
    await renderExpanded();
    await screen.findByText('2.5 mm');

    for (const id of ['water', 'soil', 'weather', 'agronomic', 'sensors'] as const) {
      const button = tabButton(id);
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('tabindex');
      expect(button).toHaveAttribute('aria-pressed', id === 'water' ? 'true' : 'false');
    }
    fireEvent.click(tabButton('weather'));
    expect(tabButton('weather')).toHaveAttribute('aria-pressed', 'true');
    expect(tabButton('water')).toHaveAttribute('aria-pressed', 'false');
  });

  // jsdom renders no CSS, so these are structural pins on the classes the
  // stylesheet turns into geometry (min-h-[48px], flex-wrap): they guard the
  // contract against casual change, not a measurement of physical pixels.
  it('pins the touch-target and wrapping classes of the tab bar and header', async () => {
    apiMocks.getSummary.mockResolvedValue(forecastOnly);
    await renderExpanded();
    await screen.findByText('3.0 mm');

    const bar = tabButton('water').parentElement;
    expect(bar).not.toBeNull();
    expect(bar).toHaveClass('flex-wrap');
    expect(bar).not.toHaveClass('overflow-x-auto');
    for (const id of ['water', 'soil', 'weather', 'agronomic', 'sensors'] as const) {
      expect(tabButton(id)).toHaveClass('min-h-[48px]', 'flex-1');
    }

    const expandButton = screen.getByRole('button', { expanded: true });
    expect(expandButton).toHaveClass('min-h-[48px]');
    const chevron = expandButton.lastElementChild;
    expect(chevron).not.toBeNull();
    expect(chevron).toHaveClass('flex-shrink-0');
  });
});
