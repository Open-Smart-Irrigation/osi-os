// @vitest-environment jsdom
//
// Regression coverage for two defects verified on real hardware ahead of the
// 2026-09-25 demo, both involving a registered RAK10701 field tester (type_id
// RAK10701_FIELD_TESTER):
//
// 1. It matched none of FarmingDashboard's explicit type_id filters, so the
//    "Unassigned Devices" section rendered its dashed box and subtitle with
//    nothing inside -- the device existed, but nothing about it was visible
//    or removable.
// 2. A field tester never belongs to an irrigation zone (N11a review, N5), so
//    it must not sit inside -- or trigger the appearance of -- the dashed
//    "Unassigned Devices" box built for sensors waiting to be assigned to
//    one. It gets its own section outside that box.
//
// This test renders the real FieldTesterCard (unmocked) so it fails on
// pre-fix source in both directions: absent entirely (defect 1), or rendered
// inside/gated by the dashed box (defect 2).
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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

// t() returns the key itself, matching this codebase's convention (see
// FarmingDashboardValvePoll.test.tsx).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../services/api', () => ({
  devicesAPI: {
    getAll: devicesGetAll,
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
  irrigationZonesAPI: { getAll: zonesGetAll },
  irrigationOutcomesAPI: { recentActuations },
  valvesAPI: { list: valvesList },
}));

// The gateway's module flags, as `useGatewayModules` reports them.
// FieldTesterCard gates its network-map link on `network === true` (S3,
// review N11a); this keeps that link visible without pulling in the real
// systemSettingsAPI/SWR round trip.
vi.mock('../../hooks/useGatewayModules', () => ({
  useGatewayModules: () => ({ data: true, network: true, gatewayHub: true, journal: true }),
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
// Stubbed like the other heavy device cards above: this file exercises
// FarmingDashboard's own section/placement logic (N5), not KiwiSensorCard's
// internals (which need their own metadata/history API mocking elsewhere).
vi.mock('../../components/farming/KiwiSensorCard', () => ({
  KiwiSensorCard: ({ device }: { device: Device }) => (
    <div data-testid="kiwi-sensor-stub">{device.name}</div>
  ),
}));

function fieldTesterDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C0010000FT01',
    name: 'Walk tester',
    type_id: 'RAK10701_FIELD_TESTER',
    latest_data: {},
    // Verified on real hardware ahead of the 2026-09-25 demo: the edge never
    // gives a field tester's uplinks a `last_seen`.
    last_seen: null,
    irrigation_zone_id: null,
    ...overrides,
  } as Device;
}

function kiwiSensorDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C0010000KW01',
    name: 'Kiwi block A',
    type_id: 'KIWI_SENSOR',
    latest_data: {},
    last_seen: null,
    irrigation_zone_id: null,
    ...overrides,
  } as Device;
}

function renderDashboard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter>
        <FarmingDashboard />
      </MemoryRouter>
    </SWRConfig>,
  );
}

beforeEach(() => {
  devicesGetAll.mockReset();
  zonesGetAll.mockClear().mockResolvedValue([]);
  recentActuations.mockClear();
  valvesList.mockReset().mockResolvedValue([]);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('FarmingDashboard unassigned RAK10701 field tester', () => {
  it('(a) a tester alone shows its own section and no unassigned-devices box', async () => {
    devicesGetAll.mockResolvedValue([fieldTesterDevice()]);

    renderDashboard();

    // The field tester's own section renders.
    expect(await screen.findByText('fieldTester.sectionHeading')).toBeInTheDocument();
    expect(screen.getByText('Walk tester')).toBeInTheDocument();
    expect(screen.getByText('0016C0010000FT01')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'fieldTester.openCoverageMap' })).toHaveAttribute('href', '/network');

    // A gateway whose only unassigned device is a tester shows no dashed
    // "Unassigned Devices" box at all (N5).
    expect(screen.queryByText('unassignedDevices')).not.toBeInTheDocument();
    expect(screen.queryByText('unassignedSubtitle')).not.toBeInTheDocument();
  });

  it('(b) a tester plus an unassigned Kiwi sensor: both sections render, the tester is not inside the unassigned box', async () => {
    devicesGetAll.mockResolvedValue([fieldTesterDevice(), kiwiSensorDevice()]);

    renderDashboard();

    // The dashed "Unassigned Devices" box appears (the Kiwi sensor is a
    // genuinely unassigned sensor) and contains the sensor, not the tester.
    const subtitle = await screen.findByText('unassignedSubtitle');
    const unassignedBox = subtitle.parentElement as HTMLElement;
    expect(within(unassignedBox).getByTestId('kiwi-sensor-stub')).toHaveTextContent('Kiwi block A');
    expect(within(unassignedBox).queryByText('Walk tester')).not.toBeInTheDocument();

    // The tester's own section renders outside that box.
    expect(screen.getByText('fieldTester.sectionHeading')).toBeInTheDocument();
    expect(screen.getByText('Walk tester')).toBeInTheDocument();
  });
});

// Zone-assigned field testers are covered separately in
// IrrigationZoneCardFieldTester.test.tsx, which exercises the real
// IrrigationZoneCard (this file keeps that component out of scope so its own
// environment/dendro API surface doesn't need mocking here).
