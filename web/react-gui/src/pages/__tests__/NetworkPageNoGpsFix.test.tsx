// @vitest-environment jsdom
//
// A field tester uplink with no GPS fix carries no position and so is never
// drawn. The page must say so instead of leaving an empty map unexplained.
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPage, isNoFixTesterRow, isTesterFixRow } from '../NetworkPage';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(), location: vi.fn(), radio: vi.fn(), observations: vi.fn(), saveLocation: vi.fn(), saveRadio: vi.fn(),
}));
vi.mock('../../services/api', () => ({ devicesAPI: { getAll: mocks.getAll }, networkAPI: {
  location: mocks.location, radio: mocks.radio, observations: mocks.observations,
  saveLocation: mocks.saveLocation, saveRadio: mocks.saveRadio,
} }));
const translate = (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key).replace('{{count}}', String(options?.count ?? ''));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('../../components/AppHeader', () => ({ AppHeader: ({ title }: { title: string }) => <header><h1>{title}</h1></header> }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ username: 'field-admin', logout: vi.fn() }) }));

const TESTER = 'A840410000000001';
const tester = { deveui: TESTER, name: 'Tester', type_id: 'RAK10701_FIELD_TESTER' } as any;
let seq = 0;
const row = (o: { deveui: string; f_port: number; reported_position: unknown; rssi?: number; recorded_at?: string }) => ({
  id: `row-${seq++}`, deveui: o.deveui, recorded_at: o.recorded_at ?? '2026-10-05T10:00:00Z', rssi: o.rssi ?? -90,
  metadata_json: JSON.stringify({ radio: { f_port: o.f_port }, reported_position: o.reported_position, receivers: [{ gateway_id: 'G1', rssi_dbm: o.rssi ?? -90 }] }),
}) as any;
const mockObservations = (rows: any[]) => mocks.observations.mockResolvedValue({ rows, truncated: false, nextOffset: null, from: '', to: '' });
const renderPage = () => render(<MemoryRouter><NetworkPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  mocks.getAll.mockResolvedValue([tester]); mocks.location.mockResolvedValue(null); mocks.radio.mockResolvedValue(null);
  mockObservations([]);
});

describe('No GPS fix on the Network page', () => {
  it('marks a field-tester row without a position as "No GPS fix"', async () => {
    mockObservations([row({ deveui: TESTER, f_port: 1, reported_position: null, rssi: -98 })]);
    renderPage();
    expect(await screen.findByText('No GPS fix')).toBeInTheDocument();
  });
  it('shows the hint when the newest tester uplink has no fix', async () => {
    mockObservations([row({ deveui: TESTER, f_port: 1, reported_position: null, rssi: -98 })]);
    renderPage();
    expect(await screen.findByText(/has no GPS fix yet/)).toBeInTheDocument();
  });
  it('shows no hint once the newest tester uplink has a fix', async () => {
    mockObservations([
      row({ deveui: TESTER, f_port: 1, reported_position: { latitude: 46.5, longitude: 7.5 }, recorded_at: '2026-10-05T10:01:00Z' }),
      row({ deveui: TESTER, f_port: 1, reported_position: null, recorded_at: '2026-10-05T10:00:00Z' }),
    ]);
    renderPage();
    await screen.findAllByText('-90 dBm', { exact: false });
    expect(screen.queryByText(/has no GPS fix yet/)).toBeNull();
  });
  it('never marks a non-tester row', async () => {
    mocks.getAll.mockResolvedValue([{ deveui: 'A84041000000000A', name: 'Soil', type_id: 'KIWI_SENSOR' }]);
    mockObservations([row({ deveui: 'A84041000000000A', f_port: 1, reported_position: null })]);
    renderPage();
    await screen.findAllByText('-90 dBm', { exact: false });
    expect(screen.queryByText('No GPS fix')).toBeNull();
    expect(screen.queryByText(/has no GPS fix yet/)).toBeNull();
  });
  it('an fPort-0 frame newer than a no-fix tester row does not hide the hint', async () => {
    mockObservations([
      row({ deveui: TESTER, f_port: 0, reported_position: null, recorded_at: '2026-10-05T10:01:00Z' }),
      row({ deveui: TESTER, f_port: 1, reported_position: null, recorded_at: '2026-10-05T10:00:00Z' }),
    ]);
    renderPage();
    expect(await screen.findByText(/has no GPS fix yet/)).toBeInTheDocument();
  });
  it('a tester row with only an installed device_location still counts as no fix', async () => {
    mockObservations([{ ...row({ deveui: TESTER, f_port: 1, reported_position: null }), metadata_json: JSON.stringify({ radio: { f_port: 1 }, reported_position: null, device_location: { latitude: 46.5, longitude: 7.5 }, receivers: [] }) }]);
    renderPage();
    expect(await screen.findByText('No GPS fix')).toBeInTheDocument();
  });
  it('classifies rows by fPort, position and tester membership', () => {
    const eus = new Set([TESTER]);
    expect(isNoFixTesterRow(row({ deveui: TESTER.toLowerCase(), f_port: 1, reported_position: null }), eus)).toBe(true);
    expect(isTesterFixRow(row({ deveui: TESTER, f_port: 1, reported_position: { latitude: 1, longitude: 2 } }), eus)).toBe(true);
    expect(isNoFixTesterRow(row({ deveui: TESTER, f_port: 0, reported_position: null }), eus)).toBe(false);
  });
});
