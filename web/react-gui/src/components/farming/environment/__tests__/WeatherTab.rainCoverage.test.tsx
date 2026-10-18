// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import enDevices from '../../../../../public/locales/en/devices.json';
import type { ForecastEnvironment, OnlineEnvironment, RainFocus } from '../../../../types/farming';
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

function renderWith(rainFocus: Partial<RainFocus>) {
  const forecast: ForecastEnvironment = {
    available: true,
    source: 'open_meteo',
    cacheStatus: 'live',
    observedAt: null,
    expiresAt: null,
    rainFocus: {
      totalNext24hMm: 0,
      totalNext72hMm: 0,
      maxHourlyRainMm: 0,
      maxHourlyRainAt: null,
      nextRainEta: null,
      rainHoursNext24h: 0,
      daily: [],
      hourly: [],
      ...rainFocus,
    },
  };
  return render(
    <I18nextProvider i18n={i18n()}>
      <WeatherTab online={online} forecast={forecast} location={{ latitude: 46.8, longitude: 6.9, timezone: 'Europe/Zurich', source: 'zone' }} />
    </I18nextProvider>,
  );
}

function pillValue(label: string): string | null {
  const pill = screen.getByText(label).parentElement;
  return pill ? pill.textContent : null;
}

afterEach(cleanup);

describe('WeatherTab forecast rain totals', () => {
  it('shows a dash, not 0.0 mm, when no forecast hour carries a rain value', () => {
    renderWith({ totalNext24hMm: null, totalNext72hMm: null, next24hCoverage: { coveredHours: 0, expectedHours: 24 } });
    expect(pillValue('Next 24 h')).toBe('Next 24 h—0 of 24 h');
    expect(pillValue('Next 72 h')).toBe('Next 72 h—');
  });

  it('shows how much of the horizon a partly covered total covers', () => {
    renderWith({ totalNext24hMm: 1.5, totalNext72hMm: 1.5, next24hCoverage: { coveredHours: 6, expectedHours: 24 } });
    expect(pillValue('Next 24 h')).toBe('Next 24 h1.5 mm6 of 24 h');
  });

  it('adds nothing to a fully covered total or to an older gateway without coverage', () => {
    renderWith({ totalNext24hMm: 0, next24hCoverage: { coveredHours: 24, expectedHours: 24 } });
    expect(pillValue('Next 24 h')).toBe('Next 24 h0.0 mm');
    cleanup();
    renderWith({ totalNext24hMm: 2.25 });
    expect(pillValue('Next 24 h')).toBe('Next 24 h2.3 mm');
  });
});
