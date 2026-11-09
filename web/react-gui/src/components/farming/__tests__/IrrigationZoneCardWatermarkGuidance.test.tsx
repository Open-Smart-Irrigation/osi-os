import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enHistory from '../../../../public/locales/en/history.json';
import enDevices from '../../../../public/locales/en/devices.json';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import { WatermarkProbeSection } from '../shared/WatermarkProbeSection';
import type { Device, IrrigationZone, WatermarkLatest, ZoneEnvironmentSummary } from '../../../types/farming';
import { SENSOR_FRESHNESS_WINDOW_MS } from '../../../utils/zoneSoil';

const apiMocks = vi.hoisted(() => ({ getSummary: vi.fn() }));
vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: { getZoneRecommendations: vi.fn().mockResolvedValue([]) },
  environmentAPI: { getSummary: apiMocks.getSummary },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined), removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../ScheduleSection', () => ({ ScheduleSection: () => <div />, normalizeTriggerMetric: (value: string) => value }));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => <div /> }));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => <div /> }));
// Minimal stand-in for the LSN50 card: it mounts the real WATERMARK probe
// section under the same condition the real card does (latest_data.watermark
// present, DraginoTempCard.tsx:230), so the family notice rendered beside the
// zone tile is the shipped component, not a claim about a stub.
vi.mock('../DraginoTempCard', async () => {
  const { WatermarkProbeSection: WatermarkSection } = await import('../shared/WatermarkProbeSection');
  return {
    DraginoTempCard: ({ device }: { device: Device }) => {
      const watermark: WatermarkLatest | null = device.latest_data?.watermark ?? null;
      return (
        <div data-testid="lsn50-card">
          {watermark != null && (
            <WatermarkSection
              soilTempC={null}
              probes={([1, 2] as const).map((channel) => ({
                channel,
                depthCm: null,
                reading: watermark.channels[channel - 1] ?? null,
              }))}
            />
          )}
        </div>
      );
    },
  };
});
vi.mock('../../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: vi.fn(() => false) }));

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();
const STALE = new Date(NOW - SENSOR_FRESHNESS_WINDOW_MS - 60 * 60 * 1000).toISOString();
const DEVICE_NOTICE = 'Phase 1 automation does not use WATERMARK readings to decide irrigation.';
const WATERMARK_NOTICE = 'This value includes WATERMARK readings. Phase 1 automation does not use those readings to decide irrigation.';
const watermark = (recordedAt: string, channel1: number | null, channel2: number | null): WatermarkLatest => ({
  recorded_at: recordedAt, supply_mv: null, soil_temp_c: null, soil_temp_source: null, die_temp_c: null,
  channels: [
    { status: 'ok', kpa: channel1, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null },
    { status: 'ok', kpa: channel2, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null },
  ],
});

const zone = {
  id: 12, name: 'Zone B', device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  schedule: { irrigation_zone_id: 12, trigger_metric: 'SWT_1', threshold_kpa: 40, enabled: true },
} as IrrigationZone;
const summary = {
  zoneId: 12, zoneName: 'Zone B', generatedAt: FRESH,
  location: { source: 'gateway', latitude: null, longitude: null, timezone: 'UTC' },
  water: {
    available: true, observedAt: FRESH, areaM2: 100, irrigationEfficiencyPct: 80,
    rainTodayMm: null, irrigationTodayLiters: null, irrigationTodayNetMm: null,
    irrigationTodayMeasuredLiters: null, irrigationTodayEstimatedLiters: null,
    waterNeededTodayMm: null, balanceTodayMm: null, next24hRainMm: null,
    action: null, daily: [],
    sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: [] },
  },
  local: {} as ZoneEnvironmentSummary['local'],
  online: { available: false, cacheStatus: 'miss' } as ZoneEnvironmentSummary['online'],
  agronomic: {} as ZoneEnvironmentSummary['agronomic'],
  forecast: { available: false } as ZoneEnvironmentSummary['forecast'],
  display: { mode: 'unlinked_local', schedulingMode: 'local', sourceLabel: 'Local only', sharedGeneratedAt: null, sharedObservedAt: null, lastReceivedAt: null, fallbackReason: null },
  drift: null,
} as ZoneEnvironmentSummary;

function sensor(overrides: Partial<Device>): Device {
  return { deveui: 'A84041A75D5E0001', name: 'Soil probe', type_id: 'KIWI_SENSOR', latest_data: {}, ...overrides } as Device;
}
function i18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', defaultNS: 'devices', ns: ['devices', 'history'],
    resources: { en: { devices: enDevices, history: enHistory } },
    interpolation: { escapeValue: false }, initImmediate: false,
  });
  return instance;
}
async function openCard(devices: Device[], selectedChannel: 'SWT_1' | 'SWT_2' = 'SWT_1') {
  const instance = i18n();
  const renderZone = (nextDevices: Device[], nextChannel: 'SWT_1' | 'SWT_2') => (
    <I18nextProvider i18n={instance}><MemoryRouter><IrrigationZoneCard
      zone={{ ...zone, schedule: { ...zone.schedule, trigger_metric: nextChannel } } as IrrigationZone}
      devices={nextDevices} unassignedDevices={[]} onUpdate={vi.fn()}
    /></MemoryRouter></I18nextProvider>
  );
  const view = render(renderZone(devices, selectedChannel));
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());
  await screen.findByTestId('water-soil-tile');
  return { rerender: (nextDevices: Device[], nextChannel: 'SWT_1' | 'SWT_2' = 'SWT_1') => view.rerender(renderZone(nextDevices, nextChannel)) };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  window.localStorage.clear();
  apiMocks.getSummary.mockReset().mockResolvedValue(summary);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('IrrigationZoneCard WATERMARK guidance', () => {
  it('resolves both notices from the shipped English devices resource', () => {
    const instance = i18n();
    const deviceNotice = instance.t('watermark.automation.phase1Notice', { ns: 'devices' });
    const zoneNotice = instance.t('watermark.automation.zonePhase1Notice', { ns: 'devices' });
    expect(deviceNotice).toBe(DEVICE_NOTICE);
    expect(zoneNotice).toBe(WATERMARK_NOTICE);
    render(<I18nextProvider i18n={instance}><WatermarkProbeSection soilTempC={null} probes={[
      { channel: 1, depthCm: null, reading: { status: 'ok', kpa: null, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null } },
    ]} /></I18nextProvider>);
    expect(screen.getByText(deviceNotice)).toBeInTheDocument();
  });

  it('shows localized guidance for a WATERMARK-only value without changing its measurement or status', async () => {
    await openCard([sensor({ type_id: 'DRAGINO_LSN50', chameleon_enabled: 0, last_seen: FRESH,
      latest_data: { swt_1: 70, watermark: watermark(FRESH, 70, null) },
    })]);
    const tile = within(screen.getByTestId('water-soil-tile'));
    expect(tile.getByText('70.0 kPa')).toBeInTheDocument();
    expect(tile.getByText('Dry')).toBeInTheDocument();
    expect(tile.getByText(WATERMARK_NOTICE)).toBeInTheDocument();
    expect(tile.queryByText('At or past the trigger')).toBeInTheDocument();
  });

  it('keeps zone and family guidance for a legacy flag-on WATERMARK device', async () => {
    await openCard([sensor({ type_id: 'DRAGINO_LSN50', chameleon_enabled: 1, last_seen: FRESH,
      latest_data: { swt_1: 70, watermark: watermark(FRESH, 70, null) },
    })]);
    const tile = within(screen.getByTestId('water-soil-tile'));
    expect(tile.getByText('70.0 kPa')).toBeInTheDocument();
    expect(tile.getByText('Dry')).toBeInTheDocument();
    expect(tile.getByText(WATERMARK_NOTICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Devices in this zone:/ }));
    expect(screen.getAllByText(DEVICE_NOTICE)).toHaveLength(1);
    expect(screen.getByTestId('lsn50-card')).toBeInTheDocument();
  });

  it('keeps the zone note off a selected Chameleon channel when WATERMARK is only on another channel', async () => {
    await openCard([
      sensor({ deveui: 'CHAMELEON', type_id: 'DRAGINO_LSN50', chameleon_enabled: 1, last_seen: FRESH,
        latest_data: { swt_1: 10, swt_2: 30 } }),
      sensor({ deveui: 'WATERMARK', type_id: 'DRAGINO_LSN50', chameleon_enabled: 0, last_seen: FRESH,
        latest_data: { swt_1: 70, swt_2: null, watermark: watermark(FRESH, 70, null) } }),
    ], 'SWT_2');
    const tile = within(screen.getByTestId('water-soil-tile'));
    expect(tile.getByText('30.0 kPa')).toBeInTheDocument();
    expect(tile.getByText('Moist')).toBeInTheDocument();
    expect(tile.queryByText(WATERMARK_NOTICE)).not.toBeInTheDocument();
    expect(tile.queryByText('At or past the trigger')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Devices in this zone:/ }));
    expect(screen.getByText(DEVICE_NOTICE)).toBeInTheDocument();
    expect(screen.getAllByTestId('lsn50-card')).toHaveLength(2);
  });

  it('updates zone guidance with the displayed provenance on rerender', async () => {
    const watermarkDevice = sensor({ type_id: 'DRAGINO_LSN50', last_seen: FRESH,
      latest_data: { swt_1: 70, watermark: watermark(FRESH, 70, null) },
    });
    const chameleon = sensor({ type_id: 'DRAGINO_LSN50', chameleon_enabled: 1, last_seen: FRESH,
      latest_data: { swt_1: 30 } });
    const { rerender } = await openCard([watermarkDevice]);
    expect(within(screen.getByTestId('water-soil-tile')).getByText(WATERMARK_NOTICE)).toBeInTheDocument();

    rerender([chameleon]);
    const chameleonTile = within(screen.getByTestId('water-soil-tile'));
    expect(chameleonTile.getByText('30.0 kPa')).toBeInTheDocument();
    expect(chameleonTile.getByText('Moist')).toBeInTheDocument();
    expect(chameleonTile.queryByText(WATERMARK_NOTICE)).not.toBeInTheDocument();

    rerender([watermarkDevice]);
    expect(within(screen.getByTestId('water-soil-tile')).getByText(WATERMARK_NOTICE)).toBeInTheDocument();
  });

  it('keeps a stale valid WATERMARK value, status, age and guidance when it is the displayed fallback', async () => {
    await openCard([sensor({ type_id: 'DRAGINO_LSN50', last_seen: STALE,
      latest_data: { swt_1: 70, watermark: watermark(STALE, 70, null) },
    })]);
    const tile = within(screen.getByTestId('water-soil-tile'));
    expect(tile.getByText('70.0 kPa')).toBeInTheDocument();
    expect(tile.getByText('Dry')).toBeInTheDocument();
    expect(tile.getByText('Last reading 4 hours ago')).toBeInTheDocument();
    expect(tile.getByText(WATERMARK_NOTICE)).toBeInTheDocument();
  });

  it('keeps the zone note off a fresh Chameleon value that outranks a stale WATERMARK one', async () => {
    await openCard([
      sensor({ deveui: 'CURRENT-CHAMELEON', type_id: 'DRAGINO_LSN50', chameleon_enabled: 1, last_seen: FRESH,
        latest_data: { swt_1: 30 } }),
      sensor({ deveui: 'OLD-WATERMARK', type_id: 'DRAGINO_LSN50', chameleon_enabled: 0, last_seen: STALE,
        latest_data: { swt_1: 90, watermark: watermark(STALE, 90, null) } }),
    ]);
    const tile = within(screen.getByTestId('water-soil-tile'));
    expect(tile.getByText('30.0 kPa')).toBeInTheDocument();
    expect(tile.getByText('Moist')).toBeInTheDocument();
    expect(tile.getByText('Below the trigger')).toBeInTheDocument();
    expect(tile.queryByText(WATERMARK_NOTICE)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Devices in this zone:/ }));
    expect(screen.getByText(DEVICE_NOTICE)).toBeInTheDocument();
    expect(screen.getAllByTestId('lsn50-card')).toHaveLength(2);
  });

  it('shows the zone note when a fresh WATERMARK value outranks a stale Chameleon one', async () => {
    await openCard([
      sensor({ deveui: 'WATERMARK', type_id: 'DRAGINO_LSN50', chameleon_enabled: 0, last_seen: FRESH,
        latest_data: { swt_1: 90, watermark: watermark(FRESH, 90, null) } }),
      sensor({ deveui: 'OLD-CHAMELEON', type_id: 'DRAGINO_LSN50', chameleon_enabled: 1, last_seen: STALE,
        latest_data: { swt_1: 30 } }),
    ]);
    const tile = within(screen.getByTestId('water-soil-tile'));
    expect(tile.getByText('90.0 kPa')).toBeInTheDocument();
    expect(tile.getByText('Dry')).toBeInTheDocument();
    expect(tile.getByText('At or past the trigger')).toBeInTheDocument();
    expect(tile.getByText(WATERMARK_NOTICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Devices in this zone:/ }));
    expect(screen.getAllByText(DEVICE_NOTICE)).toHaveLength(1);
  });

  it('follows the fallback contributors for the zone note while the invalid-trigger warning stays visible', async () => {
    await openCard([
      sensor({ deveui: 'CHAMELEON', type_id: 'DRAGINO_LSN50', chameleon_enabled: 1, last_seen: FRESH,
        latest_data: { swt_1: 30 } }),
      sensor({ deveui: 'WATERMARK', type_id: 'DRAGINO_LSN50', chameleon_enabled: 0, last_seen: FRESH,
        latest_data: { swt_1: 70, swt_2: 1_000_001, watermark: watermark(FRESH, 70, 1_000_001) } }),
    ], 'SWT_2');
    const tile = within(screen.getByTestId('water-soil-tile'));
    expect(tile.getByText('50.0 kPa')).toBeInTheDocument();
    expect(tile.getByText('Moist')).toBeInTheDocument();
    expect(tile.getByText(WATERMARK_NOTICE)).toBeInTheDocument();
    expect(tile.getByText('Trigger probe: invalid reading')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Devices in this zone:/ }));
    expect(screen.getByText(DEVICE_NOTICE)).toBeInTheDocument();
  });
});
