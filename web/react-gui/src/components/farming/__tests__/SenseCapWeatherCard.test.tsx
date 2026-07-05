import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { SenseCapWeatherCard } from '../SenseCapWeatherCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
  s2120API: { setZoneAssignments: vi.fn().mockResolvedValue(undefined) },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

vi.mock('../SensorMonitor', () => ({
  SensorMonitor: ({ field }: { field: string }) => <div data-testid="sensor-monitor">{field}</div>,
}));

vi.mock('../WindMonitor', () => ({
  WindMonitor: () => <div data-testid="wind-monitor" />,
}));

vi.mock('../RainMonitor', () => ({
  RainMonitor: () => <div data-testid="rain-monitor" />,
}));

const s2120Device: Device = {
  id: 7,
  deveui: '2CF7F1C0612345AB',
  name: 'Orchard weather station',
  type_id: 'SENSECAP_S2120',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  irrigation_zone_id: null,
  last_seen: '2026-07-04T12:00:00Z',
  latest_data: {
    ambient_temperature: 18.4,
    relative_humidity: 56,
    wind_speed_mps: 3.2,
    wind_gust_mps: 5.6,
    wind_direction_deg: 45,
    rain_mm_today: 4.2,
    rain_mm_delta: 0.2,
    rain_mm_per_10min: 0.2,
    rain_mm_per_hour: 1.2,
    barometric_pressure_hpa: 1013,
    light_lux: 5400,
    uv_index: 5.1,
    bat_pct: 88,
    counter_interval_seconds: 600,
  },
} as unknown as Device;

describe('SenseCapWeatherCard history wiring (issue #33 regression net)', () => {
  it.each([
    ['18.4 °C', 'ambient_temperature'],
    ['56 %', 'relative_humidity'],
    ['1013 hPa', 'barometric_pressure_hpa'],
    ['5.4k lux', 'light_lux'],
    ['5.1 UVI', 'uv_index'],
  ])('opens SensorMonitor for the %s tile with field %s', (buttonName, field) => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    expect(screen.getByTestId('sensor-monitor')).toHaveTextContent(field);
  });

  it('opens WindMonitor from the wind speed tile', () => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: '3.2 m/s' }));
    expect(screen.getByTestId('wind-monitor')).toBeInTheDocument();
  });

  it('opens WindMonitor from the wind direction tile', () => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: 'NE 45°' }));
    expect(screen.getByTestId('wind-monitor')).toBeInTheDocument();
  });

  it('opens RainMonitor (not SensorMonitor) from the Rain Today tile', () => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: '4.2 mm' }));
    expect(screen.getByTestId('rain-monitor')).toBeInTheDocument();
    expect(screen.queryByTestId('sensor-monitor')).not.toBeInTheDocument();
  });
});
