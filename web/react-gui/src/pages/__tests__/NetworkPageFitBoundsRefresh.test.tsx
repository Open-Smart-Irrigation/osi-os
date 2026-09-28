// @vitest-environment jsdom
//
// Companion to NetworkPageRefresh.test.tsx: the 15 s refresh tick must not
// throw away an operator's manual zoom/pan just because it merged in a point
// that is already on screen. FitBounds (NetworkPage.tsx) re-fits a tick's new
// data only when it actually falls outside the current view -- pinned here by
// controlling what `map.getBounds().contains(...)` answers, independent of
// jsdom's own (zero-size) viewport geometry.
//
// Fake timers are real from the first render, so RTL's findBy*/waitFor
// polling cannot be used -- `settle()` flushes the microtask queue instead
// (same pattern as NetworkPageRefresh.test.tsx and FarmingDashboardValvePoll.test.tsx).
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Map as LeafletMap } from 'leaflet';
import { NetworkPage } from '../NetworkPage';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(), location: vi.fn(), radio: vi.fn(), observations: vi.fn(), saveLocation: vi.fn(), saveRadio: vi.fn(),
}));
vi.mock('../../services/api', () => ({ devicesAPI: { getAll: mocks.getAll }, networkAPI: {
  location: mocks.location, radio: mocks.radio, observations: mocks.observations,
  saveLocation: mocks.saveLocation, saveRadio: mocks.saveRadio,
} }));
// Plural-aware, mirroring i18next's own precedence for a count-bearing call
// (see NetworkPageCoverage.test.tsx) -- the page's own point-count text uses
// `defaultValue_one`/`defaultValue_other`.
const translate = (key: string, options?: Record<string, unknown>) => {
  const plural = options?.count === 1 ? options?.defaultValue_one : options?.defaultValue_other;
  return String(plural ?? options?.defaultValue ?? key).replace('{{count}}', String(options?.count ?? ''));
};
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('../../components/AppHeader', () => ({ AppHeader: ({ title }: { title: string }) => <header><h1>{title}</h1></header> }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ username: 'field-admin', logout: vi.fn() }) }));

const device = { deveui: 'AC1F09FFFE000001', name: 'Field tester', type_id: 'RAK10701_FIELD_TESTER' } as any;
const row = (id: string, recordedAt: string, lat: number, lon: number) => ({
  id, deveui: device.deveui, recorded_at: recordedAt, rssi: -80,
  metadata_json: JSON.stringify({ reported_position: { latitude: lat, longitude: lon }, receivers: [] }),
});
const page = (rows: unknown[]) => ({ rows, truncated: false, nextOffset: null, from: '2026-09-25T08:00:00Z', to: '2026-09-25T09:00:00Z' });
const renderPage = () => render(<MemoryRouter><NetworkPage /></MemoryRouter>);

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
  mocks.getAll.mockResolvedValue([device]); mocks.location.mockResolvedValue(null); mocks.radio.mockResolvedValue(null);
});

afterEach(async () => {
  await act(async () => { vi.clearAllTimers(); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FitBounds on a refresh tick', () => {
  it('does not re-fit when the tick’s new point is already inside the current view', async () => {
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', 46.5, 6.5)]));
    const fitBounds = vi.spyOn(LeafletMap.prototype, 'fitBounds');
    let getBounds: ReturnType<typeof vi.spyOn> | undefined;
    try {
      renderPage();
      await settle();
      expect(screen.getByText('1 positioned point')).toBeInTheDocument();
      expect(fitBounds).toHaveBeenCalledTimes(1);
      // Only override getBounds for the tick's re-fit decision -- Leaflet's
      // own setup (pan/zoom limiting) calls it too and needs a real bounds
      // object until the first framing above has already happened.
      getBounds = vi.spyOn(LeafletMap.prototype, 'getBounds').mockReturnValue({ contains: () => true } as any);

      mocks.observations.mockResolvedValueOnce(page([
        row('b', '2026-09-25T09:00:15Z', 46.5001, 6.5001),
        row('a', '2026-09-25T09:00:00Z', 46.5, 6.5),
      ]));
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await settle();
      expect(screen.getByText('2 positioned points')).toBeInTheDocument();

      expect(fitBounds).toHaveBeenCalledTimes(1);
      expect(getBounds).toHaveBeenCalled();
    } finally { fitBounds.mockRestore(); getBounds?.mockRestore(); }
  });

  it('re-fits when the tick’s new point falls outside the current view', async () => {
    mocks.observations.mockResolvedValueOnce(page([row('a', '2026-09-25T09:00:00Z', 46.5, 6.5)]));
    const fitBounds = vi.spyOn(LeafletMap.prototype, 'fitBounds');
    let getBounds: ReturnType<typeof vi.spyOn> | undefined;
    try {
      renderPage();
      await settle();
      expect(screen.getByText('1 positioned point')).toBeInTheDocument();
      expect(fitBounds).toHaveBeenCalledTimes(1);
      getBounds = vi.spyOn(LeafletMap.prototype, 'getBounds').mockReturnValue({ contains: () => false } as any);

      mocks.observations.mockResolvedValueOnce(page([
        row('b', '2026-09-25T09:05:00Z', 47.1, 7.1),
        row('a', '2026-09-25T09:00:00Z', 46.5, 6.5),
      ]));
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await settle();
      expect(screen.getByText('2 positioned points')).toBeInTheDocument();

      expect(fitBounds).toHaveBeenCalledTimes(2);
    } finally { fitBounds.mockRestore(); getBounds?.mockRestore(); }
  });
});
