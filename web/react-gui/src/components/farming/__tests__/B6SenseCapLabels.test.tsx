// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../../../public/locales/en/devices.json';
import fr from '../../../../public/locales/fr/devices.json';
import { SenseCapWeatherCard } from '../SenseCapWeatherCard';
import type { Device } from '../../../types/farming';

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn(), rename: vi.fn() },
  s2120API: { setZoneAssignments: vi.fn() },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));
vi.mock('../SensorMonitor', () => ({ SensorMonitor: ({ label }: { label: string }) => <h2>{label}</h2> }));
vi.mock('../WindMonitor', () => ({ WindMonitor: () => null }));
vi.mock('../RainMonitor', () => ({ RainMonitor: () => null }));

afterEach(cleanup);
it('B6 weather labels and an open metric monitor follow the selected language', async () => {
  const i = i18next.createInstance();
  await i.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { devices: en }, fr: { devices: fr } }, interpolation: { escapeValue: false } });
  const device = { id: 1, deveui: 'A840410000000001', name: 'Test station', type_id: 'SENSECAP_S2120', latest_data: { ambient_temperature: 18.4, wind_gust_mps: 5.6, rain_mm_delta: 0.2, rain_mm_per_10min: 0.2, counter_interval_seconds: 600 } } as Device;
  render(<I18nextProvider i18n={i}><SenseCapWeatherCard device={device} removeContext="farm" /></I18nextProvider>);
  expect(screen.getByText('Gust 5.6 m/s')).toBeInTheDocument();
  expect(screen.getByText('0.2 mm per 10 min')).toBeInTheDocument();
  expect(screen.getByText('Last uplink: 0.2 mm')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '18.4 °C' }));
  expect(screen.getByRole('heading', { name: en.environment.metrics.air_temperature_c })).toBeInTheDocument();
  await act(() => i.changeLanguage('fr'));
  expect(screen.getByText('Rafale 5.6 m/s')).toBeInTheDocument();
  expect(screen.getByText('0.2 mm par 10 min')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: fr.environment.metrics.air_temperature_c })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Gérer les zones affectées' }));
  expect(screen.getByText('Zones affectées')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeInTheDocument();
});
