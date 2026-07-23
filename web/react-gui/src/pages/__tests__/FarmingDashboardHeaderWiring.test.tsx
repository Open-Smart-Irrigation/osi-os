// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FarmingDashboard } from '../FarmingDashboard';

const { headerProps, logoutSpy, getDevices, getZones, scopeState } = vi.hoisted(() => ({
  headerProps: [] as Array<{
    username: string | null;
    onAddZone: () => void;
    onAddDevice: () => void;
    onLogout: () => void;
  }>,
  logoutSpy: vi.fn(),
  getDevices: vi.fn(),
  getZones: vi.fn(),
  scopeState: {
    loading: false,
    isScoped: true,
    role: 'researcher',
    canWrite: true,
    isZoneVisible: vi.fn((zoneUuid: string) => zoneUuid === 'zone-visible'),
  },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    username: 'operator',
    logout: logoutSpy,
  }),
}));

vi.mock('../../contexts/ScopeContext', () => ({
  useScope: () => scopeState,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        welcome: `Welcome ${String(options?.username ?? '')}`,
        loading: 'Loading dashboard...',
        failedToLoad: 'Failed to load data',
        'emptyState.title': 'Welcome to your farm!',
        'emptyState.subtitle': 'Get started',
        'emptyState.createZone': 'Create Zone',
        'emptyState.addDevice': 'Add Device',
        irrigationZones: 'Zones',
        unassignedDevices: 'Unassigned Devices',
        unassignedSubtitle: 'These devices are not assigned',
        soilSensors: 'Soil Sensors',
        smartValves: 'Smart Valves',
        autoRefresh: 'Auto-refreshing',
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../services/api', () => ({
  devicesAPI: {
    getAll: getDevices,
  },
  irrigationZonesAPI: {
    getAll: getZones,
  },
  irrigationOutcomesAPI: {
    recentActuations: vi.fn(() => Promise.resolve({ actuations: [] })),
  },
}));

vi.mock('../../components/DashboardHeader', () => ({
  DashboardHeader: (props: {
    username: string | null;
    onAddZone: () => void;
    onAddDevice: () => void;
    onLogout: () => void;
  }) => {
    headerProps.push(props);
    return (
      <section data-testid="dashboard-header-marker">
        <span>{props.username}</span>
        <button type="button" onClick={props.onAddZone}>header add zone</button>
        <button type="button" onClick={props.onAddDevice}>header add device</button>
        <button type="button" onClick={props.onLogout}>header logout</button>
      </section>
    );
  },
}));

vi.mock('../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div aria-label="language switcher" />,
}));

vi.mock('../../components/farming/AddDeviceModal', () => ({
  AddDeviceModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="add-device-modal">Add device modal</div> : null,
}));

vi.mock('../../components/farming/CreateZoneModal', () => ({
  CreateZoneModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="create-zone-modal">Create zone modal</div> : null,
}));

vi.mock('../../components/farming/IrrigationOutcomesPanel', () => ({
  IrrigationOutcomesPanel: () => <div data-testid="irrigation-outcomes-panel" />,
}));

vi.mock('../../components/farming/IrrigationZoneCard', () => ({
  IrrigationZoneCard: ({ zone }: { zone: { name: string } }) => <article>{zone.name}</article>,
}));

vi.mock('../../components/farming/SystemPanel', () => ({
  SystemPanel: () => <div data-testid="system-panel" />,
}));

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
  headerProps.length = 0;
  getDevices.mockResolvedValue([]);
  getZones.mockResolvedValue([]);
  scopeState.loading = false;
  scopeState.isScoped = true;
  scopeState.role = 'researcher';
  scopeState.canWrite = true;
  scopeState.isZoneVisible.mockImplementation(
    (zoneUuid: string) => zoneUuid === 'zone-visible',
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FarmingDashboard header wiring', () => {
  it('renders DashboardHeader with username and wires add/logout actions', async () => {
    renderDashboard();

    expect(await screen.findByTestId('dashboard-header-marker')).toHaveTextContent('operator');
    expect(headerProps[headerProps.length - 1]?.username).toBe('operator');

    fireEvent.click(screen.getByRole('button', { name: 'header add zone' }));
    expect(screen.getByRole('dialog', { name: 'create-zone-modal' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'header add device' }));
    expect(screen.getByRole('dialog', { name: 'add-device-modal' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'header logout' }));
    expect(logoutSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ['researcher', true, ['Visible zone']],
    ['viewer', true, ['Visible zone']],
    ['admin', false, ['Visible zone', 'Foreign zone']],
  ])(
    'renders only permitted zones for a %s when scoped=%s',
    async (role, isScoped, expectedZones) => {
      scopeState.role = role;
      scopeState.isScoped = isScoped;
      scopeState.isZoneVisible.mockImplementation(
        (zoneUuid: string) => !isScoped || zoneUuid === 'zone-visible',
      );
      getZones.mockResolvedValue([
        {
          id: 1,
          name: 'Visible zone',
          zone_uuid: 'zone-visible',
          device_count: 0,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          schedule: null,
        },
        {
          id: 2,
          name: 'Foreign zone',
          zone_uuid: 'zone-foreign',
          device_count: 0,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          schedule: null,
        },
      ]);

      renderDashboard();

      await waitFor(() => expect(screen.getByText('Visible zone')).toBeInTheDocument());
      for (const zoneName of expectedZones) {
        expect(screen.getByText(zoneName)).toBeInTheDocument();
      }
      if (!expectedZones.includes('Foreign zone')) {
        expect(screen.queryByText('Foreign zone')).not.toBeInTheDocument();
      }
    },
  );
});
