// @vitest-environment jsdom
//
// Fix round R2: FarmingDashboard must not poll GET /api/valves at all for a farm that
// owns zero STREGA valves — the SWR key is `null` (SWR's "do not fetch" sentinel) unless
// at least one loaded device is a STREGA_VALVE. This measures real poll counts under
// PRODUCTION SWR defaults (no `dedupingInterval: 0` override — that override is exactly
// the harness artifact that produced a wrong first reading in the R1 re-review) across
// the three cases the coordinator asked for: no valves, valves with the panel visible,
// and valves with the panel hidden.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FarmingDashboard } from '../FarmingDashboard';
import type { Device } from '../../types/farming';

const { devicesGetAll, zonesGetAll, recentActuations, valvesList } = vi.hoisted(() => ({
  devicesGetAll: vi.fn(),
  zonesGetAll: vi.fn(() => Promise.resolve([])),
  recentActuations: vi.fn(() => Promise.resolve({ actuations: [] })),
  valvesList: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ username: 'operator', logout: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../services/api', () => ({
  devicesAPI: { getAll: devicesGetAll },
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
// Stub the zone-card/unassigned-grid valve tile so the only thing generating /api/valves
// traffic is FarmingDashboard's own useSWR and (when mounted) the real ValveControlPanel —
// the exact pair whose dedupe/no-dedupe behavior is under test. ValveControlPanel itself is
// deliberately left real (unmocked). C2: this placement now renders `DeviceValveTile`
// (formerly `StregaValveCard`).
vi.mock('../../components/farming/valves/DeviceValveTile', () => ({
  DeviceValveTile: () => <div data-testid="device-valve-tile-stub" />,
}));

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

function nonValveDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C001F2000002',
    name: 'Sensor A',
    type_id: 'KIWI_SENSOR',
    latest_data: {},
    irrigation_zone_id: null,
    ...overrides,
  } as Device;
}

function renderDashboard() {
  return render(
    // Deliberately NOT setting dedupingInterval: 0 — production SWR defaults, per the
    // R1 re-review's finding that dedupingInterval: 0 was the harness artifact that made
    // its first poll-count reading wrong.
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

describe('FarmingDashboard /api/valves poll count (production SWR defaults)', () => {
  it('never polls /api/valves for a farm with zero STREGA valves', async () => {
    devicesGetAll.mockResolvedValue([nonValveDevice()]);
    renderDashboard();
    await settleInitialFetches();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(valvesList).toHaveBeenCalledTimes(0);
  });

  it('polls /api/valves on a farm with a STREGA valve, panel visible (dedupe with ValveControlPanel)', async () => {
    window.localStorage.setItem('osi.modules.valveControl', 'true');
    devicesGetAll.mockResolvedValue([stregaDevice()]);
    renderDashboard();
    await settleInitialFetches();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(valvesList.mock.calls.length).toBeGreaterThan(0);
  });

  it('polls /api/valves on a STREGA-valve farm even with the panel hidden — the actual fix', async () => {
    window.localStorage.setItem('osi.modules.valveControl', 'false');
    devicesGetAll.mockResolvedValue([stregaDevice()]);
    renderDashboard();
    await settleInitialFetches();

    // Panel is hidden: confirm ValveControlPanel really did not mount, so any
    // /api/valves traffic below comes only from FarmingDashboard's own gated hook.
    expect(screen.queryByRole('button', { name: /open/i })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(valvesList.mock.calls.length).toBeGreaterThan(0);
  });
});
