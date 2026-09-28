import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { Device, IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';

// A RAK10701 field tester assigned to a zone used to match none of
// IrrigationZoneCard's per-type device filters -- the same defect as the
// unassigned-devices grid on FarmingDashboard, just inside a zone: the device
// existed but never appeared in "Devices in this zone".
const apiMocks = vi.hoisted(() => ({
  getZoneRecommendations: vi.fn(),
  getSummary: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: { getZoneRecommendations: apiMocks.getZoneRecommendations },
  environmentAPI: { getSummary: apiMocks.getSummary },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
  devicesAPI: {
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div data-testid="schedule-section" />,
  normalizeTriggerMetric: (value: string) => value,
}));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => <div /> }));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => <div /> }));
vi.mock('../../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: vi.fn(() => false) }));

// The gateway's module flags, as `useGatewayModules` reports them: both
// IrrigationZoneCard and FieldTesterCard read this hook. `network: true`
// keeps the network-map link visible for this test (S3, review N11a).
vi.mock('../../../hooks/useGatewayModules', () => ({
  useGatewayModules: () => ({ data: true, network: true, gatewayHub: true, journal: true }),
}));

// Same shape as IrrigationZoneCardSensorGating.test.tsx: resolve `defaultValue`
// and `{{placeholders}}` so assertions read the English the card renders.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      const values = (options ?? {}) as Record<string, unknown>;
      const template = typeof values.defaultValue === 'string' ? values.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''));
    },
  }),
}));

const NOW = Date.parse('2026-09-22T12:00:00.000Z');

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

const summary = {
  zoneId: 12,
  zoneName: 'Zone B',
  generatedAt: '2026-09-22T10:00:00.000Z',
  location: { source: 'gateway', latitude: null, longitude: null, timezone: 'UTC' },
  water: {
    available: false,
    observedAt: null,
    areaM2: null,
    irrigationEfficiencyPct: null,
    rainTodayMm: null,
    irrigationTodayLiters: null,
    irrigationTodayNetMm: null,
    irrigationTodayMeasuredLiters: null,
    irrigationTodayEstimatedLiters: null,
    waterNeededTodayMm: null,
    balanceTodayMm: null,
    next24hRainMm: null,
    action: null,
    daily: [],
    sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: [] },
  },
  local: {} as ZoneEnvironmentSummary['local'],
  online: { available: false, cacheStatus: 'miss' } as ZoneEnvironmentSummary['online'],
  agronomic: {} as ZoneEnvironmentSummary['agronomic'],
  forecast: { available: false } as ZoneEnvironmentSummary['forecast'],
  display: { mode: 'unlinked_local', schedulingMode: 'local', sourceLabel: 'Local only', sharedGeneratedAt: null, sharedObservedAt: null, lastReceivedAt: null, fallbackReason: null },
  drift: null,
} as ZoneEnvironmentSummary;

function fieldTester(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C0010000FT01',
    name: 'Walk tester',
    type_id: 'RAK10701_FIELD_TESTER',
    latest_data: {},
    // Verified on real hardware ahead of the 2026-09-25 demo: the edge never
    // gives a field tester's uplinks a `last_seen`.
    last_seen: null,
    ...overrides,
  } as Device;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  window.localStorage.clear();
  apiMocks.getZoneRecommendations.mockReset().mockResolvedValue([]);
  apiMocks.getSummary.mockReset().mockResolvedValue(summary);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('IrrigationZoneCard field tester', () => {
  it('renders an assigned RAK10701 field tester in the zone device list', async () => {
    render(
      <MemoryRouter>
        <IrrigationZoneCard
          zone={zone}
          devices={[fieldTester()]}
          unassignedDevices={[]}
          onUpdate={vi.fn()}
        />
      </MemoryRouter>,
    );

    // First expand the zone card itself (collapsed by default), which reveals
    // the "Devices in this zone" toggle; then expand that to reach the list.
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /devicesInZone/ }));

    expect(await screen.findByText('Walk tester')).toBeInTheDocument();
    expect(screen.getByText('0016C0010000FT01')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'fieldTester.openCoverageMap' })).toHaveAttribute('href', '/network');
    // No last-seen claim: the edge never reports one for this device type.
    expect(screen.getByText('fieldTester.readingsOnMap')).toBeInTheDocument();
    expect(screen.queryByText('fieldTester.lastSeen')).not.toBeInTheDocument();
    expect(screen.queryByText('fieldTester.neverSeen')).not.toBeInTheDocument();
  });
});
