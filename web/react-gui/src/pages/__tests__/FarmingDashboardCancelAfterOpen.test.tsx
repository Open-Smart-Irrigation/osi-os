// @vitest-environment jsdom
//
// Review B2 on #661 (Sol R2 reproduction): the device card's cancel named the valve-list row
// (GET /api/valves, polled every 10 s), and card actions refreshed only the device list. Cancel A,
// open B and Cancel again before the next valve poll sent the stale A; the gateway refuses an
// ended run (409 actuation_not_active) and B stayed queued, where 14720cc8 cancelled B. Real
// FarmingDashboard, StregaValveCard, ValveCancelButton and SWR with production deduping defaults;
// the API boundary is mocked and refuses a named run that is no longer the queued one.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FarmingDashboard } from '../FarmingDashboard';
import type { Device } from '../../types/farming';

const { devicesGetAll, zonesGetAll, recentActuations, valvesList, controlValve, cancelIrrigation } = vi.hoisted(() => ({
  devicesGetAll: vi.fn(), controlValve: vi.fn(), cancelIrrigation: vi.fn(),
  zonesGetAll: vi.fn(() => Promise.resolve([])),
  recentActuations: vi.fn(() => Promise.resolve({ actuations: [] })),
  valvesList: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ username: 'operator', logout: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: any) => opts?.defaultValue ?? key, i18n: { language: 'en' } }),
}));

vi.mock('../../services/api', () => ({
  devicesAPI: { getAll: devicesGetAll, controlValve, cancelIrrigation }, valveAPI: { getTodayLiters: vi.fn().mockResolvedValue({liters: null, source: 'unknown'}) },
  irrigationZonesAPI: { getAll: zonesGetAll },
  irrigationOutcomesAPI: { recentActuations },
  valvesAPI: { list: valvesList },
}));

vi.mock('../../components/DashboardHeader', () => ({
  DashboardHeader: () => <div data-testid="dashboard-header-stub" />,
}));
vi.mock('../../components/farming/AddDeviceModal', () => ({ AddDeviceModal: () => null }));
vi.mock('../../components/farming/CreateZoneModal', () => ({ CreateZoneModal: () => null }));
vi.mock('../../components/farming/IrrigationOutcomesPanel', () => ({
  IrrigationOutcomesPanel: () => <div data-testid="irrigation-outcomes-stub" />,
}));
vi.mock('../../components/farming/SystemPanel', () => ({
  SystemPanel: () => <div data-testid="system-panel-stub" />,
}));
vi.mock('../../contexts/ScopeContext', () => ({ useScope: () => ({ canWrite: true, isAdmin: false, loading: false }) }));

function stregaDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C001F1000001',
    name: 'Valve A',
    type_id: 'STREGA_VALVE',
    latest_data: {},
    irrigation_zone_id: null,
    ...overrides,
  } as Device;
}

function renderDashboard() {
  return render(
    // Production SWR deduping defaults (no dedupingInterval: 0): the stale row came from a cache
    // that only the 10 s poll refreshed.
    <SWRConfig value={{ provider: () => new Map() }}>
      <MemoryRouter>
        <FarmingDashboard />
      </MemoryRouter>
    </SWRConfig>,
  );
}

async function settleInitialFetches() {
  // Flush the microtask queue so the already-resolved fixture promises land and SWR's
  // initial (non-timer) fetch completes before we start counting polls.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  devicesGetAll.mockReset();
  zonesGetAll.mockClear();
  recentActuations.mockClear();
  valvesList.mockReset().mockResolvedValue([]);
  window.localStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    vi.runOnlyPendingTimers();
    await Promise.resolve();
  });
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('card cancel, open, cancel before the next valve poll (review B2)', () => {
  it('cancels the sole new queued open after the previous one was cancelled', async () => {
    window.localStorage.setItem('osi.modules.valveControl', 'false');
    let currentRun: string | null = 'vae-a';
    const active = (id: string | null) => id ? ({expectationId: id, reconciliationState: 'PENDING_OBSERVATION', commandedAt: '2026-11-15T08:00:00Z', expectedCloseAt: '2026-11-15T08:05:00Z', durationSeconds: 300}) : null;
    devicesGetAll.mockImplementation(async () => [stregaDevice({ current_state: 'CLOSED', activeValveActuation: active(currentRun) })]);
    valvesList.mockImplementation(async () => [{deviceEui: '0016C001F1000001', name: 'Valve A', activeActuation: active(currentRun)}]);
    controlValve.mockImplementation(async () => { currentRun = 'vae-b'; });
    cancelIrrigation.mockImplementation(async (_eui: string, options?: {expectationId?: string | null}) => {
      const id = options?.expectationId;
      if (id && id !== currentRun) throw {response: {status: 409, data: {error: 'actuation_not_active', message: 'That actuation is no longer active'}}};
      currentRun = null;
      return {outcome: 'cancelled', collateral: []};
    });
    renderDashboard();
    await settleInitialFetches();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    fireEvent.click(screen.getByRole('button', {name: 'Cancel queued open'}));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(currentRun).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Open {{minutes}} min'}));
    fireEvent.click(screen.getByRole('button', {name: 'Confirm — open for {{minutes}} min'}));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(currentRun).toBe('vae-b');
    fireEvent.click(screen.getByRole('button', {name: 'Cancel queued open'}));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(cancelIrrigation).toHaveBeenCalledTimes(2);
    // Sol's reproduction asserted valvesList was called once (no valve poll had refreshed the
    // cache). The fix reads /api/valves fresh on every cancel and after every card action, so
    // that count no longer holds; the second cancel naming B carries the same intent.
    expect(cancelIrrigation.mock.calls[1][1]?.expectationId).toBe('vae-b');
    expect(currentRun).toBeNull();
  });
});
