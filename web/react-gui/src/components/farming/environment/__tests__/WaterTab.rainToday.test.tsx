// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enCommon from '../../../../../public/locales/en/common.json';
import enDevices from '../../../../../public/locales/en/devices.json';
import type { WaterDay, WaterEnvironment } from '../../../../types/farming';
import { WaterTab } from '../WaterTab';

/**
 * Today's rain tile under the rain-resolution policy: a gauge day certified so far
 * is labelled "so far"; an uncertified day shows no amount, with what the gauge
 * received beside it ("received only"); a legacy day (coverage legacy_unvalidated)
 * looks exactly as before. Runs against the shipped English locale.
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function buildTestI18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'devices',
    ns: ['common', 'devices'],
    resources: { en: { common: enCommon, devices: enDevices } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
  return instance;
}

const TODAY = '2026-09-18';
const SO_FAR = enDevices.environment.water.rainSoFar;
const PROVIDER_PARTIAL = enDevices.environment.water.rainCoverage.providerPartial;
const PARTIAL_RAIN_SOURCES = [
  {
    rainSource: 'weather_service' as const,
    rainStation: null,
    sourceHelp: 'From weather data (not measured)',
  },
  {
    rainSource: 'meteoswiss_station' as const,
    rainStation: { id: 'PAY', name: 'Payerne', distanceKm: 1.2, network: 'ogd-smn' },
    sourceHelp: 'Measured at MeteoSwiss Payerne (1.2 km away)',
  },
];

function week(): WaterDay[] {
  return Array.from({ length: 7 }, (_, index) => ({
    date: `2026-09-${String(12 + index).padStart(2, '0')}`,
    rainMm: null,
    irrigationLiters: 0,
    irrigationNetMm: 0,
    totalWaterMm: null,
  }));
}

function gaugeWater(overrides: Partial<WaterEnvironment> = {}): WaterEnvironment {
  return {
    available: true,
    observedAt: null,
    areaM2: 7000,
    irrigationEfficiencyPct: 80,
    rainTodayMm: null,
    irrigationTodayLiters: 0,
    irrigationTodayNetMm: 0,
    waterNeededTodayMm: 2.2,
    balanceTodayMm: null,
    next24hRainMm: 0,
    action: null,
    todayDate: TODAY,
    daily: week(),
    sensorHealth: {
      sensorCount: 1,
      freshSensorCount: 1,
      staleSensorCount: 0,
      rainGaugePresent: true,
      flowMeterPresent: false,
      warnings: [],
    },
    ...overrides,
  };
}

function renderTab(water: WaterEnvironment) {
  return render(<I18nextProvider i18n={buildTestI18n()}><WaterTab water={water} /></I18nextProvider>);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: 640, height: 288, top: 0, left: 0, right: 640, bottom: 288, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WaterTab rain today under the rain-resolution policy', () => {
  it('labels a gauge day certified so far', () => {
    renderTab(gaugeWater({ rainTodayMm: 1.2, rainTodayStatus: 'observed', rainTodayCoverage: 'complete_so_far' }));

    expect(screen.getByText('1.2 mm')).toBeInTheDocument();
    expect(screen.getByText(SO_FAR)).toBeInTheDocument();
  });

  it('shows no amount for an incomplete day, and what the gauge received beside it', () => {
    renderTab(gaugeWater({ rainTodayMm: null, rainTodayStatus: 'unknown', rainTodayCoverage: 'unknown', rainTodayReceivedMm: 3 }));

    expect(screen.getByText('3.0 mm received only (incomplete day)')).toBeInTheDocument();
    expect(screen.queryByText('3.0 mm')).not.toBeInTheDocument();
    expect(screen.queryByText(SO_FAR)).not.toBeInTheDocument();
  });

  it('shows a legacy day as before: no label, no warning', () => {
    renderTab(gaugeWater({ rainTodayMm: 0.8, rainTodayStatus: 'observed', rainTodayCoverage: 'legacy_unvalidated', rainTodayReceivedMm: null }));

    expect(screen.getByText('0.8 mm')).toBeInTheDocument();
    expect(screen.queryByText(SO_FAR)).not.toBeInTheDocument();
    expect(screen.queryByText(/received only/)).not.toBeInTheDocument();
    expect(screen.queryByText(/legacy/i)).not.toBeInTheDocument();
  });

  it('names the provider even with a configured gauge and keeps its received lower bound visible', () => {
    renderTab(gaugeWater({
      rainTodayMm: 0,
      rainTodayStatus: 'observed',
      rainTodayCoverage: 'partial',
      rainTodayReceivedMm: 3,
      rainSource: 'weather_service',
    }));

    const rainTile = screen.getByText('0.0 mm').parentElement;
    expect(rainTile).toHaveTextContent(PROVIDER_PARTIAL);
    expect(rainTile).toHaveTextContent('3.0 mm received only (incomplete day)');
    fireEvent.click(screen.getByRole('button', { name: 'Where this rain value comes from' }));
    expect(screen.getByText('From weather data (not measured)')).toBeInTheDocument();
  });

  it.each(PARTIAL_RAIN_SOURCES.flatMap((sourceCase) => [false, true].map((hasLowerBound) => ({
    ...sourceCase,
    hasLowerBound,
  }))))(
    'labels partial $rainSource coverage separately from received-only, lower bound: $hasLowerBound',
    ({ rainSource, rainStation, sourceHelp, hasLowerBound }) => {
      renderTab(gaugeWater({
        rainTodayMm: 6,
        rainTodayStatus: 'observed',
        rainTodayCoverage: 'partial',
        rainTodayReceivedMm: hasLowerBound ? 3 : null,
        rainSource,
        rainStation,
      }));

      const rainTile = screen.getByText('6.0 mm').parentElement;
      expect(rainTile).toHaveTextContent(PROVIDER_PARTIAL);
      if (hasLowerBound) {
        expect(rainTile).toHaveTextContent('3.0 mm received only (incomplete day)');
      } else {
        expect(rainTile).not.toHaveTextContent(/received only/);
      }
      fireEvent.click(screen.getByRole('button', { name: 'Where this rain value comes from' }));
      expect(screen.getByText(sourceHelp)).toBeInTheDocument();
    },
  );
});
