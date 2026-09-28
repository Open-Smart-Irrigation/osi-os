// @vitest-environment jsdom
//
// N12b design review SHOULDs landed alongside the live-refresh MUST fixes:
// (5) hide the "Unknown positions" heading when it lists nothing, (6) show
// "Load more" only once every fetched row is already on screen (never next
// to "Show all" implying the same thing), (7) observation rows show the
// device name (falling back to the EUI), the RSSI with its unit, and a band
// dot tying the row to the map legend.
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPage } from '../NetworkPage';

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

const device = { deveui: 'ABCDEF0123456789', name: 'Gateway radio', type_id: 'KIWI_SENSOR' } as any;
const other = { deveui: '1111111111111111', name: 'Unpositioned sensor', type_id: 'KIWI_SENSOR' } as any;
const emptyPage = { rows: [], truncated: false, nextOffset: null, from: '', to: '' };
const renderPage = () => render(<MemoryRouter><NetworkPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  mocks.getAll.mockResolvedValue([device]); mocks.location.mockResolvedValue(null); mocks.radio.mockResolvedValue(null);
  mocks.observations.mockResolvedValue(emptyPage);
});

describe('Unknown positions heading (SHOULD 5)', () => {
  it('hides the heading when the installed device has a known location', async () => {
    mocks.location.mockResolvedValue({ revisionUuid: 'r1', revisionNo: 1, latitude: 46.5, longitude: 6.5, effectiveFrom: '2026-09-25T08:00:00Z', coordinateSource: 'manual' });
    renderPage();
    // Waits for the location fetch itself (not just the header, which the
    // mocked AppHeader renders immediately regardless of async state) --
    // otherwise `known` can still be empty at assertion time.
    await screen.findByText(/manual/);

    expect(screen.queryByText('Unknown positions')).not.toBeInTheDocument();
  });

  it('shows the heading and lists only the device with no known position', async () => {
    mocks.getAll.mockResolvedValue([device, other]);
    mocks.location.mockResolvedValue({ revisionUuid: 'r1', revisionNo: 1, latitude: 46.5, longitude: 6.5, effectiveFrom: '2026-09-25T08:00:00Z', coordinateSource: 'manual' });
    renderPage();
    // Waits for the location fetch itself, not just the (synchronously
    // mocked) header -- otherwise the assertions below can race a render
    // where `known` is still empty and both devices read as unknown.
    await screen.findByText(/manual/);

    const list = screen.getByText('Observations').closest('section')!;
    expect(within(list).getByText('Unknown positions')).toBeInTheDocument();
    expect(within(list).getByText(/Unpositioned sensor/)).toBeInTheDocument();
    expect(within(list).queryByText(/^Gateway radio · Unknown$/)).not.toBeInTheDocument();
  });
});

describe('"Show all" / "Load more" (SHOULD 6)', () => {
  const manyRows = (nextOffset: number | null) => ({
    rows: Array.from({ length: 25 }, (_, index) => ({
      id: `row-${index}`, deveui: device.deveui,
      recorded_at: new Date(2026, 8, 25, 9, 0, -index).toISOString(), rssi: -90, metadata_json: '{}',
    })),
    truncated: nextOffset !== null, nextOffset, from: '', to: '',
  });

  it('shows only "Show all" until every fetched row is on screen, then reveals "Load more"', async () => {
    mocks.observations.mockResolvedValue(manyRows(25));
    renderPage();
    await screen.findByText('25 observations');

    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('shows "Load more" without pressing "Show all" once the fetched rows already fit under the cap', async () => {
    mocks.observations.mockResolvedValue({
      rows: [{ id: 'one', deveui: device.deveui, recorded_at: '2026-09-25T09:00:00Z', rssi: -90, metadata_json: '{}' }],
      truncated: true, nextOffset: 1, from: '', to: '',
    });
    renderPage();
    await screen.findByText('1 observations');

    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});

describe('Observation rows (SHOULD 7)', () => {
  it('shows the device name, RSSI in dBm, and a band-colour dot instead of a raw EUI line', async () => {
    mocks.observations.mockResolvedValue({
      rows: [{ id: 'one', deveui: device.deveui, recorded_at: '2026-09-25T09:00:00Z', rssi: -91, metadata_json: '{}' }],
      truncated: false, nextOffset: null, from: '', to: '',
    });
    renderPage();
    await screen.findByText('1 observations');

    const list = screen.getByText('Observations').closest('section')!;
    expect(within(list).getByText('Gateway radio')).toBeInTheDocument();
    expect(within(list).getByText('-91 dBm')).toBeInTheDocument();
    expect(within(list).queryByText(device.deveui)).not.toBeInTheDocument();
    const dot = list.querySelector('[aria-hidden="true"].rounded-full');
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.backgroundColor).not.toBe('');
  });

  it('falls back to the raw EUI when the device is not in the known device list', async () => {
    mocks.observations.mockResolvedValue({
      rows: [{ id: 'one', deveui: '9999999999999999', recorded_at: '2026-09-25T09:00:00Z', rssi: null, metadata_json: '{}' }],
      truncated: false, nextOffset: null, from: '', to: '',
    });
    renderPage();
    await screen.findByText('1 observations');

    const list = screen.getByText('Observations').closest('section')!;
    expect(within(list).getByText('9999999999999999')).toBeInTheDocument();
    expect(within(list).getByText('Unknown')).toBeInTheDocument();
  });
});
