// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import enDevices from '../../../../../public/locales/en/devices.json';
import type { ForecastEnvironment, OnlineEnvironment } from '../../../../types/farming';
import { WeatherTab } from '../WeatherTab';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function i18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', defaultNS: 'devices', ns: ['devices'], resources: { en: { devices: enDevices } }, interpolation: { escapeValue: false }, initImmediate: false });
  return instance;
}

const online: OnlineEnvironment = { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null };

function forecast(source: ForecastEnvironment['source']): ForecastEnvironment {
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    available: true,
    source,
    cacheStatus: 'live',
    observedAt: null,
    expiresAt: null,
    rainFocus: {
      totalNext24hMm: 1.2,
      totalNext72hMm: 3.4,
      maxHourlyRainMm: 0.6,
      maxHourlyRainAt: inOneHour,
      nextRainEta: inOneHour,
      rainHoursNext24h: 2,
      daily: [],
      hourly: [{ time: inOneHour, rainMm: 0.6, rainProbabilityPct: 70, tempC: 14, windSpeedMps: 2 }],
    },
  };
}

function renderTab(source: ForecastEnvironment['source']) {
  return render(
    <I18nextProvider i18n={i18n()}>
      <WeatherTab online={online} forecast={forecast(source)} location={{ latitude: 46.8, longitude: 6.9, timezone: 'Europe/Zurich', source: 'zone' }} />
    </I18nextProvider>,
  );
}

afterEach(cleanup);

describe('WeatherTab provider attribution', () => {
  it('credits Open-Meteo behind a HelpTip beside the hourly rain heading', () => {
    renderTab('open_meteo');

    expect(screen.queryByText('Weather data by Open-Meteo.com, CC BY 4.0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About the weather data' }));
    expect(screen.getByText('Weather data by Open-Meteo.com, CC BY 4.0')).toBeInTheDocument();
  });

  it('credits nobody for a forecast that did not come from Open-Meteo', () => {
    renderTab('openagri');

    expect(screen.queryByRole('button', { name: 'About the weather data' })).not.toBeInTheDocument();
  });
});

describe('WeatherTab provider attribution without an hourly chart', () => {
  it('keeps the Open-Meteo credit HelpTip when the forecast has no hourly rows', () => {
    const noHours = forecast('open_meteo');
    noHours.rainFocus = { ...noHours.rainFocus!, hourly: [] };
    render(
      <I18nextProvider i18n={i18n()}>
        <WeatherTab online={online} forecast={noHours} location={{ latitude: 46.8, longitude: 6.9, timezone: 'Europe/Zurich', source: 'zone' }} />
      </I18nextProvider>,
    );
    expect(screen.queryByText('Hourly rain (next 24 h)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About the weather data' }));
    expect(screen.getByText('Weather data by Open-Meteo.com, CC BY 4.0')).toBeInTheDocument();
  });
});
