import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../../../public/locales/en/devices.json';
import fr from '../../../../public/locales/fr/devices.json';
import { sensorAPI, dendroAPI } from '../../../services/api';
import { SensorMonitor } from '../SensorMonitor';
import { WindMonitor } from '../WindMonitor';
import { RainMonitor } from '../RainMonitor';
import { DendrometerMonitor } from '../DendrometerMonitor';
import { KiwiSensorCard } from '../KiwiSensorCard';
import type { Device } from '../../../types/farming';

vi.mock('../../../services/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../../../services/api')>(), sensorAPI: { getHistory: vi.fn(), getDailyRainHistory: vi.fn() }, dendroAPI: { getHistory: vi.fn() } }));
vi.mock('../WindRoseChart', () => ({ WindRoseChart: () => <div data-testid="rose" /> }));
vi.mock('recharts', () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Leaf = () => null;
  return { Area: Leaf, AreaChart: Container, Bar: Leaf, BarChart: Container, ComposedChart: Container, CartesianGrid: Leaf, Line: Leaf, Legend: Leaf, ResponsiveContainer: Container, Tooltip: Leaf, YAxis: ({ domain }: { domain: unknown }) => <span data-testid="axis-domain">{JSON.stringify(domain)}</span>, XAxis: ({ tickFormatter }: { tickFormatter: (value: string) => string }) => <span data-testid="axis-tick">{tickFormatter('2026-07-01T13:40:00Z')}</span> };
});
const i18n = createInstance();
const props = { deveui: 'A840410000000001', deviceName: 'Fixture device', onClose: vi.fn() };
function mount(node: React.ReactNode) { return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>); }
beforeEach(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', defaultNS: 'devices', resources: { en: { devices: en, common: { close: 'Close' } }, fr: { devices: fr, common: { close: 'Fermer' } } }, interpolation: { escapeValue: false } });
  vi.mocked(sensorAPI.getHistory).mockResolvedValue([{ t: '2026-07-01T13:40:00Z', value: 0 }]);
  vi.mocked(dendroAPI.getHistory).mockResolvedValue([{ t: '2026-07-01T13:40:00Z', valid: 1, stem_change_um: 0, position_mm: 1, dendro_mode_used: 'ratio_mod3' }] as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

describe('core monitor translations', () => {
  it('updates an open Kiwi monitor title and statistics when language changes, preserving its channel', async () => {
    const device = { deveui: props.deveui, name: props.deviceName, latest_data: { swt_1: 25 }, type_id: 'KIWI_SENSOR' } as Device;
    mount(<KiwiSensorCard device={device} removeContext="farm" readOnly />);
    fireEvent.click(screen.getByRole('button', { name: '25.0 kPa' }));
    expect(await screen.findByRole('heading', { name: 'Soil water tension 1' })).toBeInTheDocument();
    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Soil water tension 1 (kPa)' })).toHaveTextContent('kPa');
    expect(screen.getByRole('heading', { name: 'Soil water tension 1 (kPa)' })).not.toHaveTextContent('Soil');
    await act(async () => { await i18n.changeLanguage('fr'); });
    expect(screen.getByRole('heading', { name: fr.kiwiSensor.soilWaterTension1 })).toBeInTheDocument();
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
    expect(sensorAPI.getHistory).toHaveBeenCalledExactlyOnceWith(props.deveui, 'swt_1', 24);
  });
  it.each([['wind', WindMonitor], ['rain', RainMonitor], ['dendrometer', DendrometerMonitor]] as const)('translates an open %s monitor without fetching again', async (_name, Component) => {
    mount(<Component {...props} />);
    await screen.findByTestId('axis-tick');
    const englishTitle = screen.getByRole('heading', { level: 2 }).textContent;
    const requests = vi.mocked(sensorAPI.getHistory).mock.calls.length + vi.mocked(dendroAPI.getHistory).mock.calls.length;
    await act(async () => { await i18n.changeLanguage('fr'); });
    expect(screen.getByRole('heading', { level: 2 }).textContent).not.toBe(englishTitle);
    expect(screen.getByText('24 h')).toBeInTheDocument();
    expect(screen.getByTestId('axis-tick').textContent).toBe(new Date('2026-07-01T13:40:00Z').toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' }));
    expect(vi.mocked(sensorAPI.getHistory).mock.calls.length + vi.mocked(dendroAPI.getHistory).mock.calls.length).toBe(requests);
  });
  it.each([['wind', WindMonitor], ['rain', RainMonitor], ['dendrometer', DendrometerMonitor]] as const)('translates the %s fetch failure while open', async (_name, Component) => {
    vi.mocked(sensorAPI.getHistory).mockRejectedValue(new Error('Synthetic transport failure'));
    vi.mocked(dendroAPI.getHistory).mockRejectedValue(new Error('Synthetic transport failure'));
    mount(<Component {...props} />);
    expect(await screen.findByText(en.monitor.failedToLoad)).toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage('fr'); });
    expect(screen.getByText(fr.monitor.failedToLoad)).toBeInTheDocument();
    expect(screen.queryByText('Synthetic transport failure')).not.toBeInTheDocument();
  });
  it('uses zero as the wind speed baseline and names both series in a visible legend', async () => {
    mount(<WindMonitor {...props} />);
    expect(await screen.findByText('Speed')).toBeInTheDocument();
    expect(screen.getByText('Gust')).toBeInTheDocument();
    expect(screen.getByTestId('axis-domain')).toHaveTextContent('[0,"auto"]');
  });
  it('explains calm winds instead of displaying an empty polar chart', async () => {
    vi.mocked(sensorAPI.getHistory).mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ t: `2026-07-01T${String(i).padStart(2, '0')}:00:00Z`, value: 0 })));
    mount(<WindMonitor {...props} />);
    expect(await screen.findByText('All paired readings are calm; there is no direction to plot.')).toBeInTheDocument();
    expect(screen.queryByTestId('rose')).not.toBeInTheDocument();
  });
  it('translates the sensor empty state while open and preserves custom metric labels', async () => {
    vi.mocked(sensorAPI.getHistory).mockResolvedValue([]);
    mount(<SensorMonitor {...props} field="custom_channel" label="Custom metric" unit="mm" />);
    expect(await screen.findByText('No Custom metric data in the last 24 hours.')).toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage('fr'); });
    expect(screen.queryByText('No Custom metric data in the last 24 hours.')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Custom metric');
  });
});
