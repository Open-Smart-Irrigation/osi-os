// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../public/locales/en/devices.json';
import fr from '../../../../../public/locales/fr/devices.json';
import de from '../../../../../public/locales/de-CH/devices.json';
import itDevices from '../../../../../public/locales/it/devices.json';
import es from '../../../../../public/locales/es/devices.json';
import pt from '../../../../../public/locales/pt/devices.json';
import lg from '../../../../../public/locales/lg/devices.json';
import { WeatherTab } from '../WeatherTab';
import { ForecastTab } from '../ForecastTab';
import { AgronomicTab } from '../AgronomicTab';
import { LocalTab } from '../LocalTab';
import type { ForecastEnvironment, OnlineEnvironment, LocalEnvironment } from '../../../../types/farming';

const chart = vi.hoisted(() => ({ axes: [] as Record<string, any>[], points: [] as Record<string, unknown>[], line: null as Record<string, any> | null }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  ComposedChart: ({ children, data }: any) => { chart.points = data; return <div>{children}</div>; },
  YAxis: (props: any) => { chart.axes.push(props); return null; },
  XAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Bar: () => null,
  Line: (props: any) => {
    chart.line = props;
    return <svg data-testid="probability-markers">{typeof props.dot === 'function' && chart.points.map((point, index) =>
      props.dot({ index, cx: index * 10, cy: point.prob == null ? undefined : 100 - Number(point.prob) }),
    )}</svg>;
  },
}));
const online: OnlineEnvironment = { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null };
const location = { source: 'zone' as const, latitude: 0, longitude: 0, timezone: 'UTC' };
function forecast(): ForecastEnvironment {
  return { available: true, source: 'open_meteo', cacheStatus: 'live', observedAt: null, expiresAt: null, rainFocus: {
    totalNext24hMm: 0, totalNext72hMm: null, maxHourlyRainMm: 0.3, maxHourlyRainAt: null, nextRainEta: null, rainHoursNext24h: 0,
    next24hCoverage: { coveredHours: 6, expectedHours: 24 },
    daily: [{ date: '2027-01-01', maxTempC: 13, minTempC: 0, rainMm: 0, rainProbabilityPct: 0, weatherCode: null, description: null, windSpeedMps: null, et0MmDay: null, etcMmDay: null }],
    hourly: [{ time: new Date(Date.now() + 3600000).toISOString(), rainMm: null, rainProbabilityPct: 0, tempC: null, windSpeedMps: null }],
  } };
}
function instance() {
  const i = i18next.createInstance();
  void i.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { devices: en }, fr: { devices: fr }, 'de-CH': { devices: de }, it: { devices: itDevices }, es: { devices: es }, pt: { devices: pt }, lg: { devices: lg } }, interpolation: { escapeValue: false } });
  return i;
}
afterEach(() => { cleanup(); chart.axes = []; chart.line = null; });

describe.each([WeatherTab, ForecastTab])('B6 forecast display', (Tab) => {
  it.each([
    [[null, 80, null], 1],
    [[null, 0, null], 1],
    [[80], 1],
    [[80, null, 60], 2],
    [[null, 80, 60, null], 0],
    [[null, null, null], 0],
    [[null, 80, 60, null, 40, null], 1],
  ] as Array<[Array<number | null>, number]>)('marks only isolated probability points in %j', (probabilities, markers) => {
    const f = forecast();
    f.rainFocus!.hourly = probabilities.map((probability, index) => ({
      time: new Date(Date.now() + (index + 1) * 3600000).toISOString(),
      rainMm: null, rainProbabilityPct: probability, tempC: null, windSpeedMps: null,
    }));
    render(<I18nextProvider i18n={instance()}><Tab forecast={f} online={online} location={location} /></I18nextProvider>);
    const circles = screen.getByTestId('probability-markers').querySelectorAll('circle');
    expect(circles).toHaveLength(markers);
    expect(chart.line?.connectNulls).toBe(false);
    expect(chart.points.map(point => point.prob)).toEqual(probabilities);
    if (probabilities[1] === 0) expect(circles[0]).toHaveAttribute('cy', '100');
  });

  it('keeps fractional rain ticks distinct and labels their units', () => {
    render(<I18nextProvider i18n={instance()}><Tab forecast={forecast()} online={online} location={location} /></I18nextProvider>);
    const axis = chart.axes.find(a => a.yAxisId === 'rain')!;
    expect([0, 0.3, 0.6, 0.9, 1.2].map(axis.tickFormatter)).toEqual(['0', '0.3', '0.6', '0.9', '1.2']);
    expect(axis.unit).toBe('\u00a0mm');
    expect(axis.tick.fill).toBe('var(--text-secondary)');
    expect(chart.points[0]).toMatchObject({ rain: null, prob: 0 });
  });
  it('shows Celsius, real zeros and coverage, and follows a live language change', async () => {
    const i = instance();
    render(<I18nextProvider i18n={i}><Tab forecast={forecast()} online={online} location={location} /></I18nextProvider>);
    expect(screen.getByText('13 °C / 0 °C')).toBeInTheDocument();
    expect(screen.getAllByText('0.0 mm')).toHaveLength(2);
    expect(screen.getByText('6 of 24 h')).toBeInTheDocument();
    await act(() => i.changeLanguage('fr'));
    expect(screen.getAllByText('0,0 mm')).toHaveLength(2);
    expect(screen.getByText('0 h')).toBeInTheDocument();
  });
});

it('B6 keeps provider credit visible and reserves help for chart interpretation', () => {
  render(<I18nextProvider i18n={instance()}><WeatherTab forecast={forecast()} online={online} location={location} /></I18nextProvider>);
  expect(screen.getByText('Weather data by Open-Meteo.com, CC BY 4.0')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'About the weather data' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'About hourly rain' }));
  expect(screen.getByText('Bars show rain in millimetres; the dashed line shows rain probability in percent.')).toBeVisible();
});

it('B6 translates agronomy status at render time and retains low-temperature heat index', async () => {
  const i = instance();
  const agronomic = { preferredSource: 'local', current: { thermodynamicSource: 'local', evapotranspirationSource: 'local', cropCoefficientSource: 'local', airTemperatureC: 8, relativeHumidityPct: 0, vpdKpa: 0, dewPointC: null, heatIndexC: 8.2, thi: 66, referenceEt0MmDay: 0, cropCoefficientKc: 0, etcMmDay: 0 } };
  render(<I18nextProvider i18n={i}><AgronomicTab agronomic={agronomic} /></I18nextProvider>);
  expect(screen.getByText('Saturated')).toBeInTheDocument();
  expect(screen.getByText('8.2 °C')).toBeInTheDocument();
  await act(() => i.changeLanguage('fr'));
  expect(screen.getByText('Saturé')).toBeInTheDocument();
  expect(screen.getByText('8,2 °C')).toBeInTheDocument();
  expect(screen.getByText('0,00 kPa')).toBeInTheDocument();
  expect(screen.getByText('0 %')).toBeInTheDocument();
});

it('B6 local sensor numbers use the selected locale and keep zero', async () => {
  const i = instance();
  const local: LocalEnvironment = { available: true, observedAt: null, sensorCount: 1, freshSensorCount: 1, staleSensorCount: 0, devices: [], metrics: [{ key: 'air_temperature_c', label: 'Air temperature', unit: '°C', mean: 0, median: 0, min: 0, max: 12.4, sampleCount: 2 }] };
  render(<I18nextProvider i18n={i}><LocalTab local={local} /></I18nextProvider>);
  await act(() => i.changeLanguage('fr'));
  expect(screen.getByText('0,0 °C')).toBeInTheDocument();
  expect(screen.getByText('0,0–12,4 °C')).toBeInTheDocument();
});

it('B6 current conditions translate compass points and format decimal commas', async () => {
  const i = instance();
  await i.changeLanguage('fr');
  const current = { ...online, available: true, current: { airTemperatureC: 12.4, relativeHumidityPct: 66, windSpeedMps: 2.7, windDirectionDeg: 225, weatherCode: null, description: null, rainMm: null, pressureHpa: null, cloudCoverPct: null, precipitationProbabilityPct: null } };
  render(<I18nextProvider i18n={i}><WeatherTab forecast={forecast()} online={current} location={location} /></I18nextProvider>);
  expect(screen.getByText('12,4 °C')).toBeInTheDocument();
  expect(screen.getByText('66 % HR').textContent).toBe('66\u00a0%\u00a0HR');
  expect(screen.getByText('2,7 m/s SO')).toBeInTheDocument();
});

it('B6 uses paired theme colors for the VPD surface and keeps source labels', () => {
  const agronomic = { preferredSource: 'local', current: { thermodynamicSource: 'local', evapotranspirationSource: 'local', cropCoefficientSource: 'local', airTemperatureC: 0, relativeHumidityPct: 0, vpdKpa: 0, dewPointC: null, heatIndexC: null, thi: 0, referenceEt0MmDay: 0, cropCoefficientKc: 0, etcMmDay: 0 } };
  render(<I18nextProvider i18n={instance()}><AgronomicTab agronomic={agronomic} /></I18nextProvider>);
  const vpd = screen.getByText('0.00 kPa');
  expect(vpd).toHaveStyle({ color: 'var(--info-text)' });
  expect(vpd.closest('.border-2')).toHaveStyle({ background: 'var(--info-bg)' });
  expect(screen.getAllByText('Local sensors').length).toBeGreaterThan(0);
});

it('B6 gives forecast summary tiles theme-aware paired colors', () => {
  const f = forecast();
  f.rainFocus!.totalNext24hMm = 1.5;
  render(<I18nextProvider i18n={instance()}><WeatherTab forecast={f} online={online} location={location} /></I18nextProvider>);
  const value = screen.getByText('1.5 mm');
  expect(value).toHaveClass('text-[var(--info-text)]');
  expect(value.parentElement).toHaveClass('bg-[var(--info-bg)]');
});


it.each([
  ['en', 'RH'], ['de-CH', 'r. F.'], ['fr', 'HR'], ['it', 'UR'],
  ['es', 'HR'], ['pt', 'HR'], ['lg', 'RH'],
])('B6 shows qualified measured-zero humidity in %s', async (locale, qualifier) => {
  const i = instance();
  await i.changeLanguage(locale);
  const current: OnlineEnvironment = { ...online, available: true, current: {
    airTemperatureC: null, relativeHumidityPct: 0, windSpeedMps: null,
    windDirectionDeg: null, weatherCode: null, description: null,
    rainMm: null, pressureHpa: null, cloudCoverPct: null, precipitationProbabilityPct: null,
  } };
  render(<I18nextProvider i18n={i}><WeatherTab forecast={forecast()} online={current} location={location} /></I18nextProvider>);
  expect(screen.getByText(`0 % ${qualifier}`).textContent).toBe(`0\u00a0%\u00a0${qualifier}`);
});
