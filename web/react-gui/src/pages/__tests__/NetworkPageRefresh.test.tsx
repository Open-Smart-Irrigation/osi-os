// @vitest-environment jsdom
//
// Coverage walk (RAK10701 field test, 2026-09-25): a francophone customer
// watches this page on a laptop while an operator walks the farm, and new
// signal points must appear on the map as the walk proceeds -- without
// anyone pressing F5. Before this file, NetworkPage fetched observations once
// (device/window change only); this pins the 15 s refresh tick that replaces
// that silent staleness.
//
// Fake timers are real from the first render (as FarmingDashboardValvePoll.test.tsx
// does for its own poll-count pins), so RTL's own findBy*/waitFor polling
// (setInterval-driven) cannot be used -- `settle()` flushes the microtask
// queue the same way, and assertions read the DOM synchronously afterward.
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const device = { deveui: 'AC1F09FFFE000001', name: 'Field tester', type_id: 'RAK10701_FIELD_TESTER' } as any;
const row = (id: string, recordedAt: string, rssi: number) => ({
  id, deveui: device.deveui, recorded_at: recordedAt, rssi,
  metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 }, receivers: [] }),
});
const page = (rows: unknown[]) => ({ rows, truncated: false, nextOffset: null, from: '2026-09-25T08:00:00Z', to: '2026-09-25T09:00:00Z' });
const renderPage = () => render(<MemoryRouter><NetworkPage /></MemoryRouter>);

// Flushes the microtask queue (pending promise .then callbacks and the React
// state updates/effects they trigger) without advancing any fake timer --
// mirrors FarmingDashboardValvePoll.test.tsx's settleInitialFetches().
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  mocks.getAll.mockResolvedValue([device]); mocks.location.mockResolvedValue(null); mocks.radio.mockResolvedValue(null);
});

afterEach(async () => {
  await act(async () => { vi.clearAllTimers(); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NetworkPage live refresh (coverage walk)', () => {
  it('fetches only a small newest page on each 15 s tick and merges a new row in', async () => {
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    renderPage();
    await settle();
    expect(screen.getByText('1 observations')).toBeInTheDocument();
    expect(mocks.observations).toHaveBeenCalledTimes(1);

    mocks.observations.mockResolvedValueOnce(page([row('b', '2026-09-25T09:00:15Z', -70), row('a', '2026-09-25T09:00:00Z', -80)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();

    // Small page: limit 50, offset 0 -- never the 500-row page the initial
    // load and "Load more" use, because the gateway is a Raspberry Pi 4.
    expect(mocks.observations).toHaveBeenLastCalledWith(50, 0, { hours: 24 });
    expect(screen.getByText('2 observations')).toBeInTheDocument();
  });

  it('does not duplicate a row the tick re-reports that is already loaded', async () => {
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    renderPage();
    await settle();
    expect(screen.getByText('1 observations')).toBeInTheDocument();

    // The tick re-fetches the newest page, which still includes the row
    // already drawn -- it must not be counted twice.
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();

    expect(screen.getByText('1 observations')).toBeInTheDocument();
  });

  it('keeps the prior rows and shows no error when a refresh tick fails', async () => {
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    renderPage();
    await settle();
    expect(screen.getByText('1 observations')).toBeInTheDocument();

    mocks.observations.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();

    expect(screen.getByText('1 observations')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The next tick recovers on its own -- no manual reload needed.
    mocks.observations.mockResolvedValueOnce(page([row('b', '2026-09-25T09:00:15Z', -70), row('a', '2026-09-25T09:00:00Z', -80)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();
    expect(screen.getByText('2 observations')).toBeInTheDocument();
  });

  it('does not fetch on a tick while the tab is hidden', async () => {
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    renderPage();
    await settle();
    expect(mocks.observations).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    mocks.observations.mockResolvedValue(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();

    expect(mocks.observations).toHaveBeenCalledTimes(1);
  });

  it('stops ticking on unmount', async () => {
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    const { unmount } = renderPage();
    await settle();
    unmount();

    mocks.observations.mockResolvedValue(page([row('a', '2026-09-25T09:00:00Z', -80)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(mocks.observations).toHaveBeenCalledTimes(1);
  });
});
