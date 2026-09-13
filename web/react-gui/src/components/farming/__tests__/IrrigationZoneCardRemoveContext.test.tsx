import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { Device, IrrigationZone } from '../../../types/farming';
import { devicesAPI, irrigationZonesAPI } from '../../../services/api';

// The regression net for a seventh card type wired with the wrong context: every card the
// zone renders must detach through irrigationZonesAPI.removeDevice and must never reach
// devicesAPI.remove, which unlinks the device from the whole account.
vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: { getZoneRecommendations: vi.fn().mockResolvedValue([]) },
  environmentAPI: { getSummary: vi.fn().mockResolvedValue(null) },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
  devicesAPI: {
    remove: vi.fn().mockResolvedValue(undefined),
    controlValve: vi.fn().mockResolvedValue(undefined),
    cancelIrrigation: vi.fn().mockResolvedValue(undefined),
  },
  deviceMetadataAPI: { setSoilMoistureDepths: vi.fn().mockResolvedValue(undefined) },
  kiwiAPI: {
    setUplinkInterval: vi.fn().mockResolvedValue(undefined),
    enableTemperatureHumidity: vi.fn().mockResolvedValue(undefined),
  },
  s2120API: { setZoneAssignments: vi.fn().mockResolvedValue(undefined) },
  stregaAPI: { getSettings: vi.fn().mockResolvedValue(null) },
  valveAPI: { getTodayLiters: vi.fn().mockResolvedValue({ liters: null, source: 'unknown' }) },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div data-testid="schedule-section" />,
  normalizeTriggerMetric: (v: string) => v,
}));

vi.mock('../environment/EnvironmentCard', () => ({
  EnvironmentCard: () => <div data-testid="environment-card" />,
}));

vi.mock('../dendrometer/DendrometerSection', () => ({
  DendrometerSection: () => <div data-testid="dendrometer-section" />,
}));

vi.mock('../../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => false),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      if (key === 'zone.devicesInZone') return 'Devices in zone';
      if (key === 'deviceRemoval.buttonZone') return 'Unassign from this zone';
      if (key === 'deviceRemoval.confirmZone') return 'Yes, unassign';
      if (key === 'stregaValve.removeDeviceTitle') return 'Remove valve';
      if (key === 'stregaValve.yesRemove') return 'Yes, remove valve';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 6,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

function device(deveui: string, type_id: string, extra: Partial<Device> = {}): Device {
  return {
    id: 1,
    deveui,
    name: `Device ${deveui}`,
    type_id,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    last_seen: '2026-09-01T00:00:00Z',
    irrigation_zone_id: 12,
    is_claimed: true,
    latest_data: {},
    ...extra,
  } as unknown as Device;
}

// One device of every type the zone card renders a card for.
const zoneDevices: Array<{ label: string; device: Device; removeTitle: string; confirmText: string }> = [
  { label: 'KIWI_SENSOR', device: device('1000000000000001', 'KIWI_SENSOR', { latest_data: { swt_1: 30 } }), removeTitle: 'Unassign from this zone', confirmText: 'Yes, unassign' },
  { label: 'STREGA_VALVE', device: device('1000000000000002', 'STREGA_VALVE', { current_state: 'CLOSED', strega_model: 'STREGA_VALVE' }), removeTitle: 'Remove valve', confirmText: 'Yes, remove valve' },
  { label: 'DRAGINO_LSN50', device: device('1000000000000003', 'DRAGINO_LSN50'), removeTitle: 'Unassign from this zone', confirmText: 'Yes, unassign' },
  { label: 'DRAGINO_SDI12', device: device('1000000000000004', 'DRAGINO_SDI12'), removeTitle: 'Unassign from this zone', confirmText: 'Yes, unassign' },
  { label: 'SENSECAP_S2120', device: device('1000000000000005', 'SENSECAP_S2120'), removeTitle: 'Unassign from this zone', confirmText: 'Yes, unassign' },
  { label: 'AQUASCOPE_LORAIN', device: device('1000000000000006', 'AQUASCOPE_LORAIN'), removeTitle: 'Unassign from this zone', confirmText: 'Yes, unassign' },
];

function renderZone(devices: Device[]) {
  render(
    <MemoryRouter>
      <IrrigationZoneCard zone={zone} devices={devices} unassignedDevices={[]} onUpdate={vi.fn()} />
    </MemoryRouter>,
  );
  // The whole zone body and then the device grid are both collapsed by default.
  fireEvent.click(screen.getByRole('heading', { name: zone.name }));
  fireEvent.click(screen.getByText('Devices in zone'));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('IrrigationZoneCard device removal is a zone detach for every card type', () => {
  it.each(zoneDevices)('$label detaches from the zone without unlinking the account', async ({ device: zoneDevice, removeTitle, confirmText }) => {
    renderZone([zoneDevice]);

    fireEvent.click(screen.getByTitle(removeTitle));
    fireEvent.click(screen.getByText(confirmText));

    await waitFor(() => {
      expect(irrigationZonesAPI.removeDevice).toHaveBeenCalledWith(zone.id, zoneDevice.deveui);
    });
    expect(devicesAPI.remove).not.toHaveBeenCalled();
  });

  it('renders a card for every device type held by the zone', () => {
    renderZone(zoneDevices.map(({ device: zoneDevice }) => zoneDevice));

    for (const { device: zoneDevice } of zoneDevices) {
      expect(screen.getByText(zoneDevice.deveui)).toBeInTheDocument();
    }
    // Five sensor cards share the zone label; the valve card keeps its own copy.
    expect(screen.getAllByTitle('Unassign from this zone')).toHaveLength(5);
    expect(screen.getAllByTitle('Remove valve')).toHaveLength(1);
  });
});
