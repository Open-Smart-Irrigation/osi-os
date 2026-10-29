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
  getRainSource: vi.fn(),
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
  zoneRainSourceAPI: {
    get: apiMocks.getRainSource,
    set: vi.fn(),
  },
}));

vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div data-testid="schedule-section" />,
  normalizeTriggerMetric: (v: string) => v,
}));

vi.mock('../environment/EnvironmentCard', () => ({
  EnvironmentCard: () => <div data-testid="environment-card" />,
}));

vi.mock('../ZoneConfigModal', () => ({
  ZoneConfigModal: ({ isOpen, onSaved }: { isOpen: boolean; onSaved: () => void }) => isOpen
    ? <button type="button" onClick={onSaved}>Save zone settings</button>
    : null,
}));

vi.mock('../dendrometer/DendrometerSection', () => ({
  DendrometerSection: ({ predictionAdvisoryEnabled }: { predictionAdvisoryEnabled: boolean }) => (
    <div data-testid="dendrometer-section">
      {predictionAdvisoryEnabled ? 'advisory-on' : 'advisory-off'}
    </div>
  ),
}));

// The gateway's module flags, as `useGatewayModules` reports them: `null` while the settings
// are still loading, otherwise one boolean per module. Tests set `.value` per case.
const gatewayModulesMock = vi.hoisted(() => ({
  value: { data: true, network: true, gatewayHub: true, journal: true } as
    | { data: boolean; network: boolean; gatewayHub: boolean; journal: boolean }
    | null,
}));

vi.mock('../../../hooks/useGatewayModules', () => ({
  useGatewayModules: () => gatewayModulesMock.value,
}));

vi.mock('../../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => false),
}));

// Resolves `defaultValue` and `{{placeholders}}` the way i18next does, so the
// assertions below keep reading the English the card actually renders rather
// than a bare key.
const FIXED: Record<string, string> = {
  'zone.deviceCount': '2 devices',
  'zone.assignDevice': 'Assign Device',
  'zone.deleteZone': 'Delete Zone',
  'addMenu.activity': 'Log activity',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      if (FIXED[key]) return FIXED[key];
      const values = (options ?? {}) as Record<string, unknown>;
      const template = typeof values.defaultValue === 'string' ? values.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''));
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

function renderCard(
  devices: Device[] = [],
  zoneOverrides: Partial<IrrigationZone & { zoneUuid?: string | null; zone_uuid?: string | null }> = {},
  canWrite = true,
) {
  render(
    <MemoryRouter>
      <IrrigationZoneCard
        zone={{ ...zone, ...zoneOverrides } as IrrigationZone}
        devices={devices}
        unassignedDevices={[]}
        onUpdate={vi.fn()}
        canWrite={canWrite}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  gatewayModulesMock.value = { data: true, network: true, gatewayHub: true, journal: true };
  vi.mocked(isDesktopBrowser).mockReturnValue(false);
  apiMocks.getZoneRecommendations.mockReset();
  apiMocks.getZoneRecommendations.mockResolvedValue([]);
  apiMocks.getSummary.mockReset();
  apiMocks.getSummary.mockResolvedValue(null);
  apiMocks.getRainSource.mockReset();
  apiMocks.getRainSource.mockResolvedValue({ state: 'none', selectedDeveui: null, basis: null, candidates: [], suggestedDeveui: null });
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

  it('builds the Journal CTA from the typed zoneUuid with URL encoding', () => {
    const zoneUuid = 'zone uuid/typed';
    renderCard([], { zoneUuid });

    const journalLink = screen.getByRole('link', { name: 'Log activity' });
    expect(journalLink).toHaveAttribute(
      'href',
      `/journal?capture=1&zone_uuid=${encodeURIComponent(zoneUuid)}`,
    );
    expect(journalLink).not.toHaveTextContent(zoneUuid);
  });

  it('falls back to the snake_case zone_uuid for the Journal CTA', () => {
    const zoneUuid = 'zone uuid/snake';
    renderCard([], { zone_uuid: zoneUuid });

    expect(screen.getByRole('link', { name: 'Log activity' })).toHaveAttribute(
      'href',
      `/journal?capture=1&zone_uuid=${encodeURIComponent(zoneUuid)}`,
    );
  });

  it('prefers the edge snake_case UUID if compatibility aliases conflict', () => {
    renderCard([], { zone_uuid: 'edge-zone', zoneUuid: 'cloud-zone' });

    expect(screen.getByRole('link', { name: 'Log activity' })).toHaveAttribute(
      'href',
      '/journal?capture=1&zone_uuid=edge-zone',
    );
  });

  it('keeps a generic Journal CTA when the zone UUID is missing', () => {
    renderCard();

    expect(screen.getByRole('link', { name: 'Log activity' })).toHaveAttribute(
      'href',
      '/journal?capture=1',
    );
  });

  it('uses a translated, touch-sized Journal CTA in a wrapping action group', () => {
    renderCard();

    const journalLink = screen.getByRole('link', { name: 'Log activity' });
    expect(journalLink.style.minHeight).toBe('56px');
    expect(getComputedStyle(journalLink).minHeight).toBe('56px');
    expect(journalLink).toHaveClass('touch-target', 'min-h-14');
    expect(journalLink.parentElement).toHaveClass('flex', 'flex-wrap');
    expect(journalLink.parentElement).not.toHaveClass('overflow-x-auto');
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
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());

    expect(screen.queryByTestId('schedule-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('environment-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Water balance')).not.toBeInTheDocument();
    expect(screen.getByTestId('dendrometer-section')).toHaveTextContent('advisory-off');
  });

  it('shows gated dashboard modules by default and uses theme variables for the water card shell', async () => {
    apiMocks.getSummary.mockResolvedValue(environmentSummary);

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(await screen.findByText('Water balance')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-section')).toBeInTheDocument();
    expect(screen.getByTestId('environment-card')).toBeInTheDocument();
    expect(screen.getByTestId('dendrometer-section')).toHaveTextContent('advisory-off');

    const waterCard = screen.getByTestId('water-today-card');
    expect(waterCard).toHaveClass('bg-[var(--card)]');
    expect(waterCard.className).not.toContain('white_55%');
    expect(waterCard.className).not.toContain('sky-100');
  });

  it('shows stamped provider rain for a zone without sensors, a zone-day, or a recommendation', async () => {
    // The provider's accepted observation stamp is the card's evidence time even
    // when this zone has no local sensor, zone-day, or recommendation row.
    const providerObservedAt = '2026-10-08T11:00:00.000Z';
    const providerOnlySummary: ZoneEnvironmentSummary = {
      ...environmentSummary,
      generatedAt: providerObservedAt,
      water: {
        ...environmentSummary.water,
        observedAt: providerObservedAt,
        rainTodayMm: 2.6,
        rainTodayStatus: 'observed',
        rainTodayCoverage: 'complete',
        rainTodayReceivedMm: null,
        rainTodayReasons: [],
        rainSource: 'weather_service',
        rainStation: null,
        irrigationTodayLiters: null,
        irrigationTodayNetMm: null,
        irrigationTodayMeasuredLiters: null,
        irrigationTodayEstimatedLiters: null,
        measuredIrrigationNetMm: null,
        estimatedIrrigationNetMm: null,
        waterNeededTodayMm: null,
        balanceTodayMm: null,
        next24hRainMm: null,
        action: null,
        daily: [],
        todayDate: null,
        sensorHealth: {
          sensorCount: 0,
          freshSensorCount: 0,
          staleSensorCount: 0,
          rainGaugePresent: false,
          flowMeterPresent: false,
          warnings: [],
        },
      },
      forecast: {
        available: true,
        source: 'open_meteo',
        cacheStatus: 'live',
        observedAt: providerObservedAt,
        expiresAt: null,
        rainFocus: null,
      },
    };
    apiMocks.getSummary.mockResolvedValue(providerOnlySummary);

    renderCard();
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    const waterCard = await screen.findByTestId('water-today-card');
    expect(waterCard).toHaveTextContent('Water balance');
    expect(waterCard).toHaveTextContent('Updated');
    expect(screen.getByTestId('water-rain-tile')).toHaveTextContent('2.6 mm');
    expect(screen.queryByTestId('water-flow-meter-tile')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Where this rain value comes from' }));
    expect(screen.getByText('From weather data (not measured)')).toBeInTheDocument();
  });

  it('says in the water card when two rain gauges report and none is chosen', async () => {
    apiMocks.getSummary.mockResolvedValue(environmentSummary);
    apiMocks.getRainSource.mockResolvedValue({
      state: 'ambiguous', selectedDeveui: null, basis: null, suggestedDeveui: 'A840410000000001',
      candidates: [
        { deveui: 'A840410000000001', name: 'Gauge north', typeId: 'AQUASCOPE_LORAIN', via: 'direct' },
        { deveui: 'A840410000000002', name: 'Station east', typeId: 'SENSECAP_S2120', via: 'weather_station' },
      ],
    });

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    const waterCard = await screen.findByTestId('water-today-card');
    await waitFor(() => expect(waterCard).toHaveTextContent(
      'Two rain gauges report for this zone. Choose one in the zone settings.',
    ));
    expect(screen.getByRole('button', { name: 'Configure' })).toBeInTheDocument();
    expect(apiMocks.getRainSource).toHaveBeenCalledWith(12);
  });

  it('gives read-only users rain-gauge guidance they can act on', async () => {
    apiMocks.getSummary.mockResolvedValue(environmentSummary);
    apiMocks.getRainSource.mockResolvedValue({
      state: 'ambiguous', selectedDeveui: null, basis: null, suggestedDeveui: 'A840410000000001',
      candidates: [
        { deveui: 'A840410000000001', name: 'Gauge north', typeId: 'AQUASCOPE_LORAIN', via: 'direct' },
        { deveui: 'A840410000000002', name: 'Station east', typeId: 'SENSECAP_S2120', via: 'weather_station' },
      ],
    });

    renderCard([dendroDevice], {}, false);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    const waterCard = await screen.findByTestId('water-today-card');
    await waitFor(() => expect(waterCard).toHaveTextContent(
      'Ask someone who can edit this zone to choose a rain gauge in zone settings.',
    ));
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('shows no gauge banner once a gauge is chosen', async () => {
    apiMocks.getSummary.mockResolvedValue(environmentSummary);
    apiMocks.getRainSource.mockResolvedValue({
      state: 'selected', selectedDeveui: 'A840410000000001', basis: 'explicit', suggestedDeveui: null,
      candidates: [{ deveui: 'A840410000000001', name: 'Gauge north', typeId: 'AQUASCOPE_LORAIN', via: 'direct' }],
    });

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    const waterCard = await screen.findByTestId('water-today-card');
    await waitFor(() => expect(apiMocks.getRainSource).toHaveBeenCalledWith(12));
    expect(waterCard).not.toHaveTextContent('Two rain gauges report for this zone.');
  });

  it('reloads rain amount and advice after saving the zone rain source', async () => {
    const beforeSave = {
      ...environmentSummary,
      water: {
        ...environmentSummary.water,
        rainTodayMm: 1.2,
        rainSource: 'weather_service',
        action: { ...environmentSummary.water.action, code: 'monitor_today' },
        sensorHealth: { ...environmentSummary.water.sensorHealth, rainGaugePresent: false },
      },
    } as ZoneEnvironmentSummary;
    const afterSave = {
      ...beforeSave,
      generatedAt: '2026-07-08T10:05:00.000Z',
      water: {
        ...beforeSave.water,
        rainTodayMm: 8.5,
        action: { ...beforeSave.water.action, code: 'irrigate_today' },
      },
    } as ZoneEnvironmentSummary;
    apiMocks.getSummary.mockReset().mockResolvedValueOnce(beforeSave).mockResolvedValueOnce(afterSave);
    const onUpdate = vi.fn();

    render(
      <MemoryRouter>
        <IrrigationZoneCard zone={zone} devices={[]} unassignedDevices={[]} onUpdate={onUpdate} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(await screen.findByText('1.2 mm')).toBeInTheDocument();
    expect(screen.getByText('Monitor today')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save zone settings' }));

    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('8.5 mm')).toBeInTheDocument();
    expect(screen.getByText('Irrigate today')).toBeInTheDocument();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not expose scheduling-source controls in the water balance card', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...environmentSummary,
      drift: {
        active: true,
        reason: 'Server and local recommendations diverged.',
        localActionCode: 'monitor_today',
        serverActionCode: 'irrigate_today',
        canSwitchScheduling: true,
      },
    });

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(await screen.findByText('Water balance')).toBeInTheDocument();
    expect(screen.queryByText('Local scheduling')).not.toBeInTheDocument();
    expect(screen.queryByText('Server when fresh')).not.toBeInTheDocument();
    expect(screen.queryByText('Local and OSI Server recommendations are drifting.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use server scheduling' })).not.toBeInTheDocument();
  });

  it('enables the advisory surface when prediction advisory is opted in', async () => {
    window.localStorage.setItem('osi.modules.predictionAdvisory', 'true');

    renderCard([dendroDevice]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByTestId('dendrometer-section')).toHaveTextContent('advisory-on');
  });
});

describe('IrrigationZoneCard module-gated entry points', () => {
  it('offers Log activity when the journal module is on', () => {
    renderCard();

    expect(screen.getByRole('link', { name: 'Log activity' })).toHaveAttribute(
      'href',
      expect.stringContaining('/journal?capture=1'),
    );
  });

  it('does not offer Log activity when the journal module is off', () => {
    gatewayModulesMock.value = { data: true, network: true, gatewayHub: true, journal: false };
    renderCard();

    expect(screen.queryByRole('link', { name: 'Log activity' })).not.toBeInTheDocument();
    // The zone's other actions are unaffected.
    expect(screen.getByRole('button', { name: 'Assign Device' })).toBeInTheDocument();
  });

  it('hides both module entry points while the gateway settings are still loading', () => {
    gatewayModulesMock.value = null;
    renderCard();

    expect(screen.queryByRole('link', { name: 'Log activity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /data/i })).not.toBeInTheDocument();
  });

  it('does not offer the mobile Data link when the data module is off', () => {
    gatewayModulesMock.value = { data: false, network: true, gatewayHub: true, journal: true };
    renderCard();

    expect(screen.queryByRole('link', { name: /data/i })).not.toBeInTheDocument();
  });
});
