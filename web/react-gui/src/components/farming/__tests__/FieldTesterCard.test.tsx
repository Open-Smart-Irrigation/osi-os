import '@testing-library/jest-dom/vitest';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { devicesAPI } from '../../../services/api';
import type { Device } from '../../../types/farming';
import { FieldTesterCard } from '../FieldTesterCard';

// t() returns the key itself, matching this codebase's convention (see
// LoRainGaugeCard.test.tsx / Sdi12SoilCard.test.tsx).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: {
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

// The gateway's module flags, as `useGatewayModules` reports them. Tests set
// `.value` per case; S3 (review N11a) requires the network-map link to be
// gated on `network === true`, matching DashboardHeader's own gate.
const gatewayModulesMock = vi.hoisted(() => ({
  value: { data: true, network: true, gatewayHub: true, journal: true } as
    | { data: boolean; network: boolean; gatewayHub: boolean; journal: boolean }
    | null,
}));

vi.mock('../../../hooks/useGatewayModules', () => ({
  useGatewayModules: () => gatewayModulesMock.value,
}));

function fieldTesterDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 1,
    deveui: '0016C0010000FT01',
    name: 'Walk tester',
    type_id: 'RAK10701_FIELD_TESTER',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-09-22T12:00:00Z',
    irrigation_zone_id: null,
    is_claimed: true,
    claimed_by_username: 'test',
    claimed_by_user_uuid: 'uuid-1',
    dendro_ratio_at_retracted: null,
    dendro_ratio_at_extended: null,
    dendro_baseline_pending: 0,
    // Verified on real hardware ahead of the 2026-09-25 demo: the edge never
    // gives a field tester's uplinks a `last_seen` (they land in the radio
    // store, not `device_data`). Every fixture here matches that fact.
    last_seen: null,
    latest_data: {},
    ...overrides,
  } as unknown as Device;
}

function renderCard(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('FieldTesterCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayModulesMock.value = { data: true, network: true, gatewayHub: true, journal: true };
  });

  it('renders name, EUI, badge and the neutral footer line, never a last-seen claim', () => {
    renderCard(<FieldTesterCard device={fieldTesterDevice()} removeContext="farm" />);

    expect(screen.getByText('Walk tester')).toBeInTheDocument();
    expect(screen.getByText('0016C0010000FT01')).toBeInTheDocument();
    expect(screen.getByText('fieldTester.badge')).toBeInTheDocument();
    expect(screen.getByText('fieldTester.readingsOnMap')).toBeInTheDocument();

    expect(screen.queryByText('fieldTester.lastSeen')).not.toBeInTheDocument();
    expect(screen.queryByText('fieldTester.neverSeen')).not.toBeInTheDocument();
    expect(screen.queryByText('fieldTester.online')).not.toBeInTheDocument();
    expect(screen.queryByText('fieldTester.offline')).not.toBeInTheDocument();
  });

  it('links to the network map when the gateway Network module is on', () => {
    gatewayModulesMock.value = { data: true, network: true, gatewayHub: true, journal: true };
    renderCard(<FieldTesterCard device={fieldTesterDevice()} removeContext="farm" />);

    const link = screen.getByRole('link', { name: 'fieldTester.openCoverageMap' });
    expect(link).toHaveAttribute('href', '/network');
  });

  it('hides the network-map link when the gateway Network module is off', () => {
    gatewayModulesMock.value = { data: true, network: false, gatewayHub: true, journal: true };
    renderCard(<FieldTesterCard device={fieldTesterDevice()} removeContext="farm" />);

    expect(screen.queryByRole('link', { name: 'fieldTester.openCoverageMap' })).not.toBeInTheDocument();
    // The rest of the card still renders.
    expect(screen.getByText('fieldTester.readingsOnMap')).toBeInTheDocument();
  });

  it('hides the remove control when readOnly', () => {
    renderCard(<FieldTesterCard device={fieldTesterDevice()} removeContext="farm" readOnly />);

    expect(screen.queryByTitle('deviceRemoval.buttonFarm')).not.toBeInTheDocument();
  });

  it('shows the remove control and confirms removal when not readOnly', async () => {
    const onRemove = vi.fn();
    const device = fieldTesterDevice();
    renderCard(<FieldTesterCard device={device} onRemove={onRemove} removeContext="farm" />);

    fireEvent.click(screen.getByTitle('deviceRemoval.buttonFarm'));
    fireEvent.click(screen.getByText('deviceRemoval.confirmFarm'));

    await waitFor(() => {
      expect(devicesAPI.remove).toHaveBeenCalledWith(device.deveui);
    });
    expect(onRemove).toHaveBeenCalled();
  });
});
