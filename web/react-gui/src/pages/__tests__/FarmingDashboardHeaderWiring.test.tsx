// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FarmingDashboard } from '../FarmingDashboard';

const { headerProps, logoutSpy } = vi.hoisted(() => ({
  headerProps: [] as Array<{
    username: string | null;
    onAddZone: () => void;
    onAddDevice: () => void;
    onLogout: () => void;
  }>,
  logoutSpy: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    username: 'operator',
    logout: logoutSpy,
  }),
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
        irrigationZones: 'Irrigation Zones',
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
    getAll: vi.fn(() => Promise.resolve([])),
  },
  irrigationZonesAPI: {
    getAll: vi.fn(() => Promise.resolve([])),
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
});
