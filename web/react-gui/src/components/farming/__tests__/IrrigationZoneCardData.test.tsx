import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { Device, IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';
import { isDesktopBrowser } from '../../../utils/isDesktopBrowser';

const apiMocks = vi.hoisted(() => ({
  getZoneRecommendations: vi.fn(),
  getSummary: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: {
    getZoneRecommendations: apiMocks.getZoneRecommendations,
  },
  environmentAPI: {
    getSummary: apiMocks.getSummary,
  },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div data-testid="schedule-section" />,
  normalizeTriggerMetric: (v: string) => v,
}));

vi.mock('../environment/EnvironmentCard', () => ({
  EnvironmentCard: () => <div data-testid="environment-card" />,
}));

vi.mock('../dendrometer/DendrometerSection', () => ({
  DendrometerSection: ({ predictionAdvisoryEnabled }: { predictionAdvisoryEnabled: boolean }) => (
    <div data-testid="dendrometer-section">
      {predictionAdvisoryEnabled ? 'advisory-on' : 'advisory-off'}
    </div>
  ),
}));

vi.mock('../../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => false),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      if (key === 'zone.deviceCount') return '2 devices';
      if (key === 'zone.assignDevice') return 'Assign Device';
      if (key === 'zone.deleteZone') return 'Delete Zone';
      return key;
    },
  }),
}));

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

const dendroDevice = {
  deveui: 'A84041A75D5E7CFB',
  name: 'Dendro 1',
  type_id: 'DRAGINO_LSN50',
  latest_data: {},
  dendro_enabled: 1,
} as Device;

const environmentSummary = {
  zoneId: 12,
  zoneName: 'Zone B',
  generatedAt: '2026-07-08T10:00:00.000Z',
  location: { source: 'gateway', latitude: null, longitude: null, timezone: 'UTC' },
  water: {
    available: true,
    observedAt: '2026-07-08T09:55:00.000Z',
    areaM2: 100,
    irrigationEfficiencyPct: 80,
    rainTodayMm: 4.2,
    irrigationTodayLiters: 100,
    irrigationTodayNetMm: 0.8,
    irrigationTodayMeasuredLiters: 100,
    irrigationTodayEstimatedLiters: 120,
    measuredIrrigationNetMm: 0.8,
    estimatedIrrigationNetMm: 1,
    waterNeededTodayMm: 3,
    balanceTodayMm: 1.2,
    next24hRainMm: 2.1,
    action: { code: 'monitor_today', source: 'water_balance', reasoning: 'Rain covered demand.', recommendationDate: null },
    daily: [],
    sensorHealth: {
      sensorCount: 2,
      freshSensorCount: 2,
      staleSensorCount: 0,
      rainGaugePresent: true,
      flowMeterPresent: true,
      warnings: [],
    },
  },
  local: {} as ZoneEnvironmentSummary['local'],
  online: { available: false, cacheStatus: 'miss' } as ZoneEnvironmentSummary['online'],
  agronomic: {} as ZoneEnvironmentSummary['agronomic'],
  forecast: { available: false } as ZoneEnvironmentSummary['forecast'],
  display: {
    mode: 'unlinked_local',
    schedulingMode: 'local',
    sourceLabel: 'Local only',
    sharedGeneratedAt: null,
    sharedObservedAt: null,
    lastReceivedAt: null,
    fallbackReason: null,
  },
  drift: null,
} as ZoneEnvironmentSummary;

function renderCard(devices: Device[] = []) {
  render(
    <MemoryRouter>
      <IrrigationZoneCard
        zone={zone}
        devices={devices}
        unassignedDevices={[]}
        onUpdate={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(isDesktopBrowser).mockReturnValue(false);
  apiMocks.getZoneRecommendations.mockReset();
  apiMocks.getZoneRecommendations.mockResolvedValue([]);
  apiMocks.getSummary.mockReset();
  apiMocks.getSummary.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IrrigationZoneCard Data entry', () => {
  it('renders a mobile Data link to the zone fullscreen history view', () => {
    renderCard();

    const dataLink = screen.getByRole('link', { name: /data/i });
    expect(dataLink).toHaveAttribute('href', '/history/zones/12');
    expect(dataLink).toHaveClass(
      'touch-target',
      'bg-[var(--success-border)]',
      'hover:bg-green-700',
      'text-white',
      'px-4',
      'py-2',
      'rounded-lg',
      'text-sm',
      'font-semibold',
      'transition-colors',
      'inline-flex',
      'items-center',
      'justify-center',
    );
  });

  it('hides the zone-card Data link on desktop browsers', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(true);
    renderCard();

    expect(screen.queryByRole('link', { name: /data/i })).not.toBeInTheDocument();
  });

  it('labels a canonical SWT_1 schedule as soil tension (S1)', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    const scheduledZone = {
      ...zone,
      schedule: { enabled: true, trigger_metric: 'SWT_1', threshold_kpa: 30, irrigation_zone_id: 12 },
    } as unknown as IrrigationZone;
    render(
      <MemoryRouter>
        <IrrigationZoneCard zone={scheduledZone} devices={[]} unassignedDevices={[]} onUpdate={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Soil tension \(S1\)/)).toBeInTheDocument();
  });

  it('uses module preferences to gate schedule, environment, water, and advisory surfaces', async () => {
    apiMocks.getSummary.mockResolvedValue(environmentSummary);
    window.localStorage.setItem('osi.modules.schedulerUi', 'false');
    window.localStorage.setItem('osi.modules.environment', 'false');
    window.localStorage.setItem('osi.modules.waterCard', 'false');
    window.localStorage.setItem('osi.modules.predictionAdvisory', 'false');

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('heading', { name: 'Zone B' }));

    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());

    expect(screen.queryByTestId('schedule-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('environment-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Water Today')).not.toBeInTheDocument();
    expect(screen.getByTestId('dendrometer-section')).toHaveTextContent('advisory-off');
  });

  it('shows gated dashboard modules by default and uses theme variables for the water card shell', async () => {
    apiMocks.getSummary.mockResolvedValue(environmentSummary);

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('heading', { name: 'Zone B' }));

    expect(await screen.findByText('Water Today')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-section')).toBeInTheDocument();
    expect(screen.getByTestId('environment-card')).toBeInTheDocument();
    expect(screen.getByTestId('dendrometer-section')).toHaveTextContent('advisory-off');

    const waterCard = screen.getByTestId('water-today-card');
    expect(waterCard).toHaveClass('bg-[var(--card)]');
    expect(waterCard.className).not.toContain('white_55%');
    expect(waterCard.className).not.toContain('sky-100');
  });

  it('enables the advisory surface when prediction advisory is opted in', async () => {
    window.localStorage.setItem('osi.modules.predictionAdvisory', 'true');

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('heading', { name: 'Zone B' }));

    expect(screen.getByTestId('dendrometer-section')).toHaveTextContent('advisory-on');
  });
});
