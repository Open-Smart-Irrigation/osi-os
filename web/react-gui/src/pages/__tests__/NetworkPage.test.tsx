// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPage, parseObservation } from '../NetworkPage';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(), location: vi.fn(), radio: vi.fn(), observations: vi.fn(), saveLocation: vi.fn(), saveRadio: vi.fn(),
}));
vi.mock('../../services/api', () => ({ devicesAPI: { getAll: mocks.getAll }, networkAPI: {
  location: mocks.location, radio: mocks.radio, observations: mocks.observations,
  saveLocation: mocks.saveLocation, saveRadio: mocks.saveRadio,
} }));
const translate = (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key).replace('{{count}}', String(options?.count ?? ''));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const device = { deveui: 'ABCDEF0123456789', name: 'Gateway radio', type_id: 'KIWI_SENSOR' } as any;
const emptyPage = { rows: [], truncated: false, nextOffset: null, from: '', to: '' };
const renderPage = () => render(<MemoryRouter><NetworkPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  mocks.getAll.mockResolvedValue([device]); mocks.location.mockResolvedValue(null); mocks.radio.mockResolvedValue(null); mocks.observations.mockResolvedValue(emptyPage);
});

describe('NetworkPage', () => {
  it('keeps null coordinates unknown and uses gateway_id for receiver links', () => {
    const parsed = parseObservation({ deveui: device.deveui, recorded_at: '2026-09-10T00:00:00Z', metadata_json: JSON.stringify({ device_location: { latitude: null, longitude: null }, receivers: [{ gateway_id: 'GW-1', position: { latitude: 46.8, longitude: 8.2 }, rssi_dbm: -91 }] }) });
    expect(parsed.device).toBeNull();
    expect(parsed.receivers).toEqual([{ lat: 46.8, lon: 8.2, id: 'GW-1' }]);
  });

  it('prefers the reported mobile fix over an installed location', () => {
    const parsed = parseObservation({ deveui: device.deveui, recorded_at: '2026-09-10T00:00:00Z', metadata_json: JSON.stringify({ reported_position: { latitude: 47, longitude: 9 }, device_location: { latitude: 46, longitude: 8 } }) });
    expect(parsed.device).toEqual({ lat: 47, lon: 9 });
  });

  it('saves a location with a CAS base and shows the persisted position', async () => {
    mocks.saveLocation.mockResolvedValue({ revisionUuid: 'r2', revisionNo: 2, latitude: 46.8, longitude: 8.2, effectiveFrom: '2026-09-10T00:00:00Z', coordinateSource: 'manual' });
    renderPage();
    await screen.findByRole('heading', { name: 'Network observations', level: 1 });
    fireEvent.change(screen.getByPlaceholderText('Latitude'), { target: { value: '46.8' } });
    fireEvent.change(screen.getByPlaceholderText('Longitude'), { target: { value: '8.2' } });
    fireEvent.submit(screen.getAllByRole('button', { name: 'Save' })[0].closest('form')!);
    await waitFor(() => expect(mocks.saveLocation).toHaveBeenCalledWith(device.deveui, expect.objectContaining({ base_revision_uuid: null })));
    expect(mocks.saveLocation.mock.calls[0][1].values).toEqual(expect.objectContaining({ latitude: 46.8, longitude: 8.2 }));
  });

  it('reports a stale revision conflict', async () => {
    mocks.saveLocation.mockRejectedValue({ response: { status: 409 } });
    renderPage();
    await screen.findByRole('heading', { name: 'Network observations', level: 1 });
    fireEvent.change(screen.getByPlaceholderText('Latitude'), { target: { value: '46.8' } });
    fireEvent.change(screen.getByPlaceholderText('Longitude'), { target: { value: '8.2' } });
    fireEvent.submit(screen.getAllByRole('button', { name: 'Save' })[0].closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('This record changed. Reload before saving.');
  });

  it('shows an empty state and pauses on service unavailable', async () => {
    mocks.observations.mockRejectedValue({ response: { status: 503 } });
    renderPage();
    expect(await screen.findByText('No observations')).toBeInTheDocument();
    expect(await screen.findByText('Updates paused')).toBeInTheDocument();
  });
});
