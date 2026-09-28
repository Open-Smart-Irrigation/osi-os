// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// AppHeader carries the app-wide chrome (brand header, tabs, account menu) and
// pulls in useGatewayModules/SWR of its own; NetworkPage's tests care about the
// page body, so AppHeader is replaced with a minimal stand-in that still
// renders the title as an h1 -- the same shape JournalPage.test.tsx uses for
// the real header.
vi.mock('../../components/AppHeader', () => ({ AppHeader: ({ title }: { title: string }) => <header><h1>{title}</h1></header> }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ username: 'field-admin', logout: vi.fn() }) }));

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

  it('says it is still loading instead of claiming the gateway has nothing', async () => {
    let releaseDevices: (value: unknown[]) => void = () => {};
    mocks.getAll.mockReturnValue(new Promise((resolve) => { releaseDevices = resolve; }));
    renderPage();

    expect(await screen.findByText('Loading devices…')).toBeInTheDocument();
    expect(screen.getByText('Loading observations…')).toBeInTheDocument();
    expect(screen.queryByText('No observations')).not.toBeInTheDocument();
    expect(screen.queryByText('No known positions')).not.toBeInTheDocument();
    expect(screen.queryByText('0 observations')).not.toBeInTheDocument();

    releaseDevices([device]);
    await waitFor(() => expect(screen.queryByText('Loading devices…')).not.toBeInTheDocument());
    expect(await screen.findByText('No observations')).toBeInTheDocument();
  });

  it('separates a gateway with no devices from a gateway still answering', async () => {
    mocks.getAll.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No devices are known to this gateway yet')).toBeInTheDocument();
    expect(screen.queryByText('Loading observations…')).not.toBeInTheDocument();
    expect(screen.getByText('No observations')).toBeInTheDocument();
  });

  it('formats the observation timestamp instead of printing the raw column', async () => {
    mocks.observations.mockResolvedValue({
      rows: [{ deveui: device.deveui, recorded_at: '2026-09-10T08:30:00.000Z', rssi: -91, metadata_json: '{}' }],
      truncated: false, nextOffset: null, from: '', to: '',
    });
    renderPage();

    const formatted = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date('2026-09-10T08:30:00.000Z'));
    expect(await screen.findByText(new RegExp(formatted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-10T08:30:00\.000Z/)).not.toBeInTheDocument();
  });

  it('shows the installed-location and radio-configuration panels for a fixed installation', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Network observations', level: 1 });
    expect(screen.getByText('Installed location')).toBeInTheDocument();
    expect(screen.getByText('Radio configuration')).toBeInTheDocument();
  });

  it('shows only the most recent 20 observations until "Show all" is pressed', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `row-${index}`,
      deveui: device.deveui,
      recorded_at: new Date(2026, 8, 25, 9, 0, -index).toISOString(),
      rssi: -90,
      metadata_json: '{}',
    }));
    mocks.observations.mockResolvedValue({ rows, truncated: false, nextOffset: null, from: '', to: '' });
    renderPage();

    await screen.findByText('25 observations');
    const list = screen.getByText('Observations').closest('section')!;
    // Rows show the device name (from the known device list), not the raw
    // EUI -- see NetworkPage.tsx's `nameOf`.
    expect(within(list).getAllByText(device.name)).toHaveLength(20);
    const toggle = screen.getByRole('button', { name: 'Show all' });

    fireEvent.click(toggle);
    expect(within(list).getAllByText(device.name)).toHaveLength(25);
    expect(screen.getByText('25 observations')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByText(device.name)).toHaveLength(20);
  });

  it('offers no show-all toggle when every observation already fits', async () => {
    mocks.observations.mockResolvedValue({
      rows: [{ id: 'one', deveui: device.deveui, recorded_at: '2026-09-25T09:00:00Z', rssi: -90, metadata_json: '{}' }],
      truncated: false, nextOffset: null, from: '', to: '',
    });
    renderPage();

    await screen.findByText('1 observations');
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  });
});
