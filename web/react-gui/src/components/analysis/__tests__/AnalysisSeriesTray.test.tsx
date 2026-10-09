// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => {
      if (k === 'analysis.tray.unknownSite') return 'Unknown site';
      if (k === 'analysis.tray.reason.unsupported') return 'Unsupported';
      return k;
    },
  }),
}));

import { AnalysisSeriesTray } from '../AnalysisSeriesTray';
import type { AnalysisCatalogEntry, DeviceSource } from '../../../analysis/types';

const channels: AnalysisCatalogEntry[] = [
  { seriesId: 's1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null, sourceKind: 'device' },
  { seriesId: 's2', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_2', displayName: 'SWT 2', unit: 'kPa', availability: 'unsupported', deviceName: null, depthCm: null, sourceKind: 'device' },
];

afterEach(cleanup);

describe('AnalysisSeriesTray', () => {
  it('renders a source with no chart channels and keeps same-name devices separate', () => {
    const sources = [
      { id: 'device-rain-1', hubEui: 'HUB-1', zoneId: null, zoneName: null, name: 'Rain gauge', typeId: 'AQUASCOPE_LORAIN', channelIds: ['rain-1'], presentation: 'timeseries', destination: null, limitation: null },
      { id: 'device-rain-2', hubEui: 'HUB-1', zoneId: null, zoneName: null, name: 'Rain gauge', typeId: 'AQUASCOPE_LORAIN', channelIds: [], presentation: 'specialized', destination: null, limitation: null },
    ];
    const sourceOnlyChannels: AnalysisCatalogEntry[] = [{
      ...channels[0]!, seriesId: 'rain-1', zoneId: null, zoneName: null, deviceName: 'Rain gauge', deviceSourceId: 'device-rain-1',
    }];
    render(<AnalysisSeriesTray channels={sourceOnlyChannels} sources={sources as DeviceSource[]} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getAllByText('Rain gauge')).toHaveLength(2);
    expect(screen.getByText('analysis.tray.unassigned')).toBeInTheDocument();
    expect(screen.getByText('analysis.tray.emptySource')).toBeInTheDocument();
  });

  it('only links a specialized RAK source when the network module is enabled', () => {
    const source: DeviceSource = {
      id: 'device-rak', hubEui: 'HUB-1', zoneId: null, zoneName: null, name: 'Coverage tester', typeId: 'RAK10701_FIELD_TESTER', channelIds: [], presentation: 'specialized', destination: 'network', limitation: null,
    };
    const view = render(<MemoryRouter><AnalysisSeriesTray channels={[]} sources={[source]} gatewayModules={{ data: true, network: true, gatewayHub: true, journal: true }} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'analysis.tray.openNetwork' })).toHaveAttribute('href', '/network');
    view.rerender(<MemoryRouter><AnalysisSeriesTray channels={[]} sources={[source]} gatewayModules={{ data: true, network: false, gatewayHub: true, journal: true }} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: 'analysis.tray.openNetwork' })).not.toBeInTheDocument();
    expect(screen.getByText('analysis.tray.networkDisabled')).toBeInTheDocument();
    view.rerender(<MemoryRouter><AnalysisSeriesTray channels={[]} sources={[source]} gatewayModules={null} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('analysis.tray.networkLoading')).toBeInTheDocument();
  });

  it('keeps other-supported channels selectable under a collapsed explanation', () => {
    const channel: AnalysisCatalogEntry = {
      ...channels[0]!, seriesId: 'historical-swt', deviceName: 'Kiwi', deviceSourceId: 'device-kiwi',
      configurationState: 'other_supported', displayName: 'Kiwi - SWT 3', channelKey: 'swt_3',
    };
    const onAdd = vi.fn();
    render(<AnalysisSeriesTray channels={[channel]} sources={[{ id: 'device-kiwi', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', name: 'Kiwi', typeId: 'KIWI_SENSOR', channelIds: ['historical-swt'], presentation: 'timeseries', destination: null, limitation: null }]} selectedIds={[]} onAdd={onAdd} onRemove={vi.fn()} />);
    expect(screen.getByText('analysis.tray.otherSupported')).toBeInTheDocument();
    expect(screen.getByText('analysis.tray.otherSupported').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('analysis.tray.otherSupported'));
    fireEvent.click(screen.getByRole('button', { name: /SWT 3/ }));
    expect(onAdd).toHaveBeenCalledWith('historical-swt');
  });

  it('adds an available channel on click and disables unsupported ones', () => {
    const onAdd = vi.fn();
    render(<AnalysisSeriesTray channels={channels} selectedIds={[]} onAdd={onAdd} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByText('SWT 1'));
    expect(onAdd).toHaveBeenCalledWith('s1');
    expect(screen.getByText('SWT 2').closest('button')).toBeDisabled();
  });

  it('filters by search text', () => {
    render(<AnalysisSeriesTray channels={channels} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nomatch' } });
    expect(screen.queryByText('SWT 1')).not.toBeInTheDocument();
  });

  it('does not render the hub EUI / site line above the zone', () => {
    const withHub: AnalysisCatalogEntry[] = [
      { seriesId: 'x', hubEui: '0016C001F11766E7', zoneId: 9, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null, sourceKind: 'device' },
    ];
    render(<AnalysisSeriesTray channels={withHub} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByText('0016C001F11766E7')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown site')).not.toBeInTheDocument();
    expect(screen.getByText('North')).toBeInTheDocument();
  });

  it('marks a selected channel with an accessible pressed state', () => {
    render(<AnalysisSeriesTray channels={channels} selectedIds={['s1']} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole('button', { name: /SWT 1/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('explains why an unsupported channel is disabled', () => {
    render(<AnalysisSeriesTray channels={channels} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Unsupported')).toBeInTheDocument();
  });

  it('groups device-backed channels under the device name without exposing hashed source keys', () => {
    const deviceChannels: AnalysisCatalogEntry[] = [
      {
        seriesId: 'c1',
        hubEui: 'HUB-1',
        zoneId: 1,
        zoneName: 'North',
        cardType: 'soil',
        sourceKey: 'soil-src-deadbeefcafe',
        channelKey: 'swt_1',
        displayName: 'Chameleon 1: SWT 5cm',
        unit: 'kPa',
        availability: 'available',
        deviceName: 'Chameleon 1',
        depthCm: 5, sourceKind: 'device',
      },
      {
        seriesId: 'c2',
        hubEui: 'HUB-1',
        zoneId: 1,
        zoneName: 'North',
        cardType: 'soil',
        sourceKey: 'soil-src-deadbeefcafe',
        channelKey: 'swt_2',
        displayName: 'Chameleon 1: SWT 10cm',
        unit: 'kPa',
        availability: 'available',
        deviceName: 'Chameleon 1',
        depthCm: 10, sourceKind: 'device',
      },
    ];

    render(<AnalysisSeriesTray channels={deviceChannels} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText('Chameleon 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SWT 5cm/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SWT 10cm/i })).toBeInTheDocument();
    expect(screen.queryByText(/soil-src-deadbeefcafe/)).not.toBeInTheDocument();
  });

  it('keeps zones with duplicate names separate by zone id', () => {
    const duplicateNamedZones: AnalysisCatalogEntry[] = [
      {
        seriesId: 'zone-10-swt',
        hubEui: 'HUB-1',
        zoneId: 10,
        zoneName: 'East',
        cardType: 'soil',
        sourceKey: 'root-zone',
        channelKey: 'swt_1',
        displayName: 'SWT 1',
        unit: 'kPa',
        availability: 'available',
        deviceName: null,
        depthCm: null, sourceKind: 'device',
      },
      {
        seriesId: 'zone-20-swt',
        hubEui: 'HUB-1',
        zoneId: 20,
        zoneName: 'East',
        cardType: 'soil',
        sourceKey: 'root-zone',
        channelKey: 'swt_2',
        displayName: 'SWT 2',
        unit: 'kPa',
        availability: 'available',
        deviceName: null,
        depthCm: null, sourceKind: 'device',
      },
    ];
    const onAdd = vi.fn();

    render(<AnalysisSeriesTray channels={duplicateNamedZones} selectedIds={[]} onAdd={onAdd} onRemove={vi.fn()} />);

    expect(screen.getAllByText('East')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /SWT 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /SWT 2/i }));
    expect(onAdd).toHaveBeenNthCalledWith(1, 'zone-10-swt');
    expect(onAdd).toHaveBeenNthCalledWith(2, 'zone-20-swt');
  });

  it('shows the channel name, not the source name, on each button of a weather source', () => {
    const agronomy: AnalysisCatalogEntry = {
      seriesId: 'a1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'agronomy-src-zone',
      channelKey: 'etc_mm', displayName: 'North daily agronomy - Crop water demand (ETc)', unit: 'mm', availability: 'available',
      deviceName: 'North daily agronomy', depthCm: null, sourceKind: 'zone_daily_agronomy',
    };
    render(<AnalysisSeriesTray channels={[agronomy]} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Crop water demand (ETc)')).toBeInTheDocument();
    expect(screen.queryByText('North daily agronomy - Crop water demand (ETc)')).not.toBeInTheDocument();
    expect(screen.getByText('North daily agronomy')).toBeInTheDocument();
  });

  it('lists a provider source as its own group under the zone', () => {
    const entries: AnalysisCatalogEntry[] = [
      { seriesId: 'd1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'soil-src-d1506631a773', channelKey: 'swt_1', displayName: 'Kiwi North - Soil tension (S1)', unit: 'kPa', availability: 'available', deviceName: 'Kiwi North', depthCm: null, sourceKind: 'device' },
      { seriesId: 'p1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey: 'et0_mm', displayName: 'Open-Meteo 46.80°N 6.95°E - Reference ET (ET0)', unit: 'mm', availability: 'available', deviceName: 'Open-Meteo 46.80°N 6.95°E', depthCm: null, sourceKind: 'weather_provider' },
    ];
    render(<AnalysisSeriesTray channels={entries} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Kiwi North')).toBeInTheDocument();
    expect(screen.getByText('Open-Meteo 46.80°N 6.95°E')).toBeInTheDocument();
    expect(screen.getByText('Soil tension (S1)')).toBeInTheDocument();
    expect(screen.getByText('Reference ET (ET0)')).toBeInTheDocument();
  });

  it('names each zone as its own group, even when two zones share a provider location', () => {
    const providerName = 'Open-Meteo 46.80°N 6.95°E';
    const zoneChannels = (zoneId: number, zoneName: string): AnalysisCatalogEntry[] => [
      { seriesId: `d${zoneId}`, hubEui: 'HUB-1', zoneId, zoneName, cardType: 'soil', sourceKey: `soil-src-${zoneId}`, channelKey: 'swt_1', displayName: `Kiwi ${zoneName} - Soil tension (S1)`, unit: 'kPa', availability: 'available', deviceName: `Kiwi ${zoneName}`, depthCm: null, sourceKind: 'device' },
      { seriesId: `p${zoneId}`, hubEui: 'HUB-1', zoneId, zoneName, cardType: 'environment', sourceKey: `weather-src-${zoneId}`, channelKey: 'et0_mm', displayName: `${providerName} - Reference ET (ET0)`, unit: 'mm', availability: 'available', deviceName: providerName, depthCm: null, sourceKind: 'weather_provider' },
    ];
    const entries = [...zoneChannels(1, 'North'), ...zoneChannels(2, 'South')];

    render(<AnalysisSeriesTray channels={entries} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);

    const north = screen.getByRole('group', { name: 'North' });
    const south = screen.getByRole('group', { name: 'South' });
    expect(north).not.toBe(south);
    expect(within(north).getByText(providerName)).toBeInTheDocument();
    expect(within(south).getByText(providerName)).toBeInTheDocument();
  });

  it('renders the provider group after the zone device groups regardless of input order', () => {
    const providerName = 'Open-Meteo 46.80°N 6.95°E';
    const entries: AnalysisCatalogEntry[] = [
      // Provider entry listed first on purpose, to prove rendering order does not follow input order.
      { seriesId: 'p1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'weather-src-1', channelKey: 'et0_mm', displayName: `${providerName} - Reference ET (ET0)`, unit: 'mm', availability: 'available', deviceName: providerName, depthCm: null, sourceKind: 'weather_provider' },
      { seriesId: 'd1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'soil-src-d1', channelKey: 'swt_1', displayName: 'Kiwi North - Soil tension (S1)', unit: 'kPa', availability: 'available', deviceName: 'Kiwi North', depthCm: null, sourceKind: 'device' },
    ];

    render(<AnalysisSeriesTray channels={entries} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);

    const zone = screen.getByRole('group', { name: 'North' });
    const groupTexts = within(zone).getAllByRole('group').map((el) => el.textContent ?? '');
    const deviceIndex = groupTexts.findIndex((text) => text.includes('Kiwi North'));
    const providerIndex = groupTexts.findIndex((text) => text.includes(providerName));
    expect(deviceIndex).toBeGreaterThanOrEqual(0);
    expect(providerIndex).toBeGreaterThan(deviceIndex);
  });

  it('names each source group, so buttons with one channel label stay apart for a screen reader', () => {
    const temperature = (seriesId: string, sourceKey: string, deviceName: string, sourceKind: string): AnalysisCatalogEntry => ({
      seriesId, hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey, channelKey: 'ambient_temperature',
      displayName: `${deviceName} - Air temperature`, unit: '°C', availability: 'available', deviceName, depthCm: null, sourceKind,
    });
    const entries = [
      temperature('s1', 'env-src-0123456789ab', 'demo-s2120', 'device'),
      temperature('p1', 'weather-src-0123456789ab', 'Open-Meteo 46.80°N 6.95°E', 'weather_provider'),
    ];
    render(<AnalysisSeriesTray channels={entries} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    const device = screen.getByRole('group', { name: 'demo-s2120' });
    const provider = screen.getByRole('group', { name: 'Open-Meteo 46.80°N 6.95°E' });
    expect(within(device).getByRole('button', { name: /Air temperature/ })).toBeInTheDocument();
    expect(within(provider).getByRole('button', { name: /Air temperature/ })).toBeInTheDocument();
  });

  it('offers a legacy estimate only on request, but always shows one a saved view selected', () => {
    const base = { hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'environment-src-1', availability: 'available' as const, deviceName: 'Gauge', depthCm: null, sourceKind: 'device', deviceSourceId: 'device-gauge' };
    const rain: AnalysisCatalogEntry[] = [
      { ...base, seriesId: 'amount', channelKey: 'rain_mm_delta', displayName: 'Gauge - Rainfall amount', unit: 'mm', legacy: false },
      { ...base, seriesId: 'rate', channelKey: 'rain_mm_per_hour', displayName: 'Gauge - Rain rate', unit: 'mm/h', legacy: true },
      { ...base, seriesId: 'ten', channelKey: 'rain_mm_per_10min', displayName: 'Gauge - Rain (10 min)', unit: 'mm/10min', legacy: true },
    ];
    const view = render(<AnalysisSeriesTray channels={rain} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Rainfall amount')).toBeInTheDocument();
    expect(screen.queryByText(/Rain rate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Rain \(10 min\)/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'analysis.tray.showLegacy' }));
    expect(screen.getByText('Rain rate (analysis.legacyEstimate)')).toBeInTheDocument();
    expect(screen.getByText('Rain (10 min) (analysis.legacyEstimate)')).toBeInTheDocument();

    view.unmount();
    render(<AnalysisSeriesTray channels={rain} selectedIds={['rate']} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Rain rate \(analysis.legacyEstimate\)/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Rain \(10 min\)/)).not.toBeInTheDocument();
  });

  it('shows no legacy switch when the catalogue has no legacy entry', () => {
    render(<AnalysisSeriesTray channels={channels} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: 'analysis.tray.showLegacy' })).not.toBeInTheDocument();
  });
});
