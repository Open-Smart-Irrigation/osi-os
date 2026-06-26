// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
import type { AnalysisCatalogEntry } from '../../../analysis/types';

const channels: AnalysisCatalogEntry[] = [
  { seriesId: 's1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null },
  { seriesId: 's2', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_2', displayName: 'SWT 2', unit: 'kPa', availability: 'unsupported', deviceName: null, depthCm: null },
];

afterEach(cleanup);

describe('AnalysisSeriesTray', () => {
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
      { seriesId: 'x', hubEui: '0016C001F11766E7', zoneId: 9, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null },
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
        depthCm: 5,
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
        depthCm: 10,
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
        depthCm: null,
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
        depthCm: null,
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
});
