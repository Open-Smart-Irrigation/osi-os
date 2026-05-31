import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HistoryCardFrame } from '../HistoryCardFrame';
import type { HistoryCardDataResponse, HistoryCardSummary } from '../../../history/types';

const useHistoryCardDataMock = vi.fn();

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.cardFrame.typeHistory': '{{cardType}} history',
    'history.cardFrame.viewModes': '{{title}} view modes',
    'history.cardFrame.unavailable': 'This card is not available for the selected zone.',
    'history.cardFrame.timelineBrush': 'Timeline viewport',
    'history.cardFrame.timelineBrushKeyboardHelp':
      'Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset.',
    'history.cardFrame.aggregationBadge': 'Aggregation: {{aggregation}}',
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here when card data APIs are enabled.',
    'history.cardType.gateway': 'Gateway',
    'history.cardType.soil': 'Soil',
    'history.viewMode.status-overview': 'Status Overview',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageConfidence.configured': 'Configured cadence',
    'history.metadata.syncState.local': 'Local',
    'history.metadata.syncState.synced': 'Synced',
    'history.metadata.syncState.unknown': 'Unknown',
    'history.metadata.aggregation.hourly': 'Hourly',
    'history.gatewayStatus.title': 'Gateway status overview',
    'history.gatewayStatus.emptyTitle': 'Limited gateway status data',
    'history.gatewayStatus.emptyBody': 'Gateway status details will appear here as the hub reports them.',
    'history.gatewayStatus.lastSeen': 'Last seen',
    'history.gatewayStatus.dataAsOf': 'Data as of',
    'history.gatewayStatus.syncState': 'Sync state',
    'history.gatewayStatus.eventsTitle': 'Recent gateway events',
    'history.gatewayStatus.noEvents': 'No gateway events in this range.',
    'history.gatewayStatus.eventFallback': 'Gateway event',
    'history.gatewayStatus.status.ok': 'OK',
    'history.gatewayStatus.status.online': 'Online',
    'history.gatewayStatus.category.connectivity': 'Connectivity',
    'history.gatewayStatus.category.storage': 'Storage',
    'history.gatewayStatus.category.system': 'System',
    'history.gatewayStatus.metric.signal': 'Signal',
    'history.gatewayStatus.metric.storage': 'Storage use',
    'history.gatewayStatus.metric.memory': 'Memory use',
    'history.gatewayStatus.metric.cpu': 'CPU',
    'history.gatewayStatus.metric.temperature': 'Temperature',
    'history.gatewayStatus.value.unavailable': 'Not reported',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translateForTest,
  }),
}));

vi.mock('../TimelineBrush', () => ({
  TimelineBrush: () => <div aria-label="Timeline viewport" />,
}));

vi.mock('../../../history/useHistoryCardData', () => ({
  useHistoryCardData: (...args: unknown[]) => useHistoryCardDataMock(...args),
}));

function gatewayCard(): HistoryCardSummary<'gateway'> {
  return {
    cardId: 'gateway:hub',
    cardType: 'gateway',
    scope: 'gateway',
    title: 'Gateway',
    subtitle: 'Central hub',
    defaultView: 'status-overview',
    views: ['status-overview', 'connectivity-timeline'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    metadata: {
      lastSeenAt: '2026-05-31T09:45:00.000Z',
      battery: { status: 'ok', latest: 3.7, unit: 'V' },
      signal: { status: 'online', latest: -70, unit: 'dBm' },
      coveragePct: 88,
      coverageConfidence: 'configured',
      syncState: 'synced',
      gatewayDeviceEui: 'A84041FFFF123456',
    },
    availability: { available: true, reasons: [] },
    ordering: { pinned: true, score: 100, recentRank: 1 },
  };
}

function soilCard(): HistoryCardSummary<'soil'> {
  return {
    cardId: 'zone-1:soil:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil',
    subtitle: 'Root zone tension',
    defaultView: 'soil-profile',
    views: ['soil-profile'],
    supportedRanges: ['24h'],
    defaultRange: '24h',
    metadata: {
      coveragePct: 82,
      coverageConfidence: 'configured',
    },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 50, recentRank: 2 },
  };
}

function historyData(
  overrides: Partial<HistoryCardDataResponse<'gateway'>> = {},
): HistoryCardDataResponse<'gateway'> {
  return {
    cardId: 'gateway:hub',
    cardType: 'gateway',
    view: 'status-overview',
    range: {
      label: '24h',
      from: '2026-05-30T10:00:00.000Z',
      to: '2026-05-31T10:00:00.000Z',
      timezone: 'UTC',
    },
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 88,
      coverageConfidence: 'configured',
      pointCount: 6,
    },
    limits: {
      maxPointsPerSeries: 1000,
      maxEvents: 100,
      maxInterpretations: 20,
      truncated: false,
    },
    series: [
      {
        id: 'gateway-storage-used-percent',
        label: 'storage_used_percent',
        unit: '%',
        points: [{ t: '2026-05-31T09:45:00.000Z', value: 68, coverageConfidence: 'configured' }],
      },
      {
        id: 'gateway-memory-percent',
        label: 'memory_percent',
        unit: '%',
        points: [{ t: '2026-05-31T09:45:00.000Z', value: 42, coverageConfidence: 'configured' }],
      },
      {
        id: 'gateway-cpu-percent',
        label: 'cpu_percent',
        unit: '%',
        points: [{ t: '2026-05-31T09:45:00.000Z', value: 18, coverageConfidence: 'configured' }],
      },
      {
        id: 'gateway-thermal-temperature',
        label: 'thermal_temperature',
        unit: 'C',
        points: [{ t: '2026-05-31T09:45:00.000Z', value: 61, coverageConfidence: 'configured' }],
      },
    ],
    profiles: [],
    events: [
      {
        id: 'evt-sync',
        type: 'sync_complete',
        t: '2026-05-31T09:40:00.000Z',
        label: 'Sync completed',
        severity: 'success',
        metadata: {},
      },
      {
        id: 'evt-raw',
        type: 'raw_payload',
        t: '2026-05-31T09:35:00.000Z',
        label: 'raw_payload A84041FFFF123456',
        severity: 'warning',
        metadata: { rssi: -113 },
      },
      {
        id: 'evt-pending',
        type: 'pending_commands',
        t: '2026-05-31T09:30:00.000Z',
        label: 'Queue cleared',
        severity: 'info',
        metadata: {},
      },
    ],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: '2026-05-31T09:45:00.000Z', syncState: 'local' },
    advancedFields: {
      mem_percent: { field: 'mem_percent', value: 42, unit: '%', availability: 'collected' },
      pending_commands: { field: 'pending_commands', value: 2, unit: null, availability: 'collected' },
      device_eui: { field: 'device_eui', value: 'A84041FFFF123456', unit: null, availability: 'collected' },
      rssi: { field: 'rssi', value: -113, unit: 'dBm', availability: 'collected' },
      firmware_version: { field: 'firmware_version', value: '2026.05.31', unit: null, availability: 'collected' },
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('HistoryCardFrame gateway status overview', () => {
  it('renders farmer-facing gateway summaries without exposing raw diagnostics', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: historyData(),
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<HistoryCardFrame card={gatewayCard()} scope={{ type: 'gateway', gatewayEui: 'A84041FFFF123456' }} />);

    expect(useHistoryCardDataMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'gateway:hub',
        view: 'status-overview',
        scope: { type: 'gateway', gatewayEui: 'A84041FFFF123456' },
      }),
    );

    const overview = screen.getByRole('region', { name: 'Gateway status overview' });
    expect(within(overview).getByText('Data as of')).toBeInTheDocument();
    expect(within(overview).getByText('Sync state')).toBeInTheDocument();
    expect(within(overview).getAllByText('Local').length).toBeGreaterThan(0);
    expect(within(overview).getByText('Connectivity')).toBeInTheDocument();
    expect(within(overview).getByText('Signal')).toBeInTheDocument();
    expect(within(overview).getByText('Online')).toBeInTheDocument();
    expect(within(overview).getByText('Storage')).toBeInTheDocument();
    expect(within(overview).getByText('68 %')).toBeInTheDocument();
    expect(within(overview).getAllByText('System').length).toBeGreaterThan(0);
    expect(within(overview).getByText('42 %')).toBeInTheDocument();
    expect(within(overview).getByText('18 %')).toBeInTheDocument();
    expect(within(overview).getByText('Temperature')).toBeInTheDocument();
    expect(within(overview).getByText('61 C')).toBeInTheDocument();
    expect(within(overview).getByText('Sync completed')).toBeInTheDocument();
    expect(within(overview).getAllByText('Gateway event').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/A84041FFFF123456|device_eui|rssi|dBm|firmware|raw_payload|pending|command|Queue cleared|3\.7 V/i)).not.toBeInTheDocument();
  });

  it('renders a stable limited-data state for sparse or malformed gateway payloads', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: historyData({
        series: undefined as unknown as HistoryCardDataResponse<'gateway'>['series'],
        events: undefined as unknown as HistoryCardDataResponse<'gateway'>['events'],
        freshness: { dataAsOf: 'not-a-date', syncState: 'unknown' },
        advancedFields: {
          storage_used_percent: {
            field: 'storage_used_percent',
            value: Number.NaN,
            unit: '%',
            availability: 'collected',
          },
        },
      }),
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    const card = gatewayCard();
    card.metadata = {
      coveragePct: null,
      coverageConfidence: 'configured',
      battery: { status: '', latest: Number.NaN, unit: 'V' },
      signal: { status: '' },
      lastSeenAt: null,
    };

    render(<HistoryCardFrame card={card} scope={{ type: 'gateway', gatewayEui: 'A84041FFFF123456' }} />);

    expect(screen.getByText('Limited gateway status data')).toBeInTheDocument();
    expect(screen.getByText('Gateway status details will appear here as the hub reports them.')).toBeInTheDocument();
    expect(screen.getByText('No gateway events in this range.')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  it('keeps non-gateway cards on the existing placeholder surface', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<HistoryCardFrame card={soilCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Chart and calendar data will load here when card data APIs are enabled.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Gateway status overview' })).not.toBeInTheDocument();
  });
});
