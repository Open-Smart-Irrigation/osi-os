// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisCatalogEntry } from '../../../analysis/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MetricAcrossZonesPicker } from '../MetricAcrossZonesPicker';

const channels: AnalysisCatalogEntry[] = [
  { seriesId: 's1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null },
  { seriesId: 's2', hubEui: 'HUB-2', zoneId: 2, zoneName: 'South', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1 East', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null },
  { seriesId: 's3', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'microclimate', channelKey: 'ambient_temperature', displayName: 'Air temperature', unit: 'C', availability: 'available', deviceName: null, depthCm: null },
  { seriesId: 's4', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_2', displayName: 'SWT 2', unit: 'kPa', availability: 'unsupported', deviceName: null, depthCm: null },
];

afterEach(cleanup);

describe('MetricAcrossZonesPicker', () => {
  it('shows distinct available canonical channels only', () => {
    render(<MetricAcrossZonesPicker channels={channels} onApply={vi.fn()} />);

    expect(screen.getByText('analysis.preset.metricLabel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SWT 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Air temperature °C/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /SWT 1 East/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /SWT 2/i })).not.toBeInTheDocument();
  });

  it('applies the selected canonical channel key', () => {
    const onApply = vi.fn();
    render(<MetricAcrossZonesPicker channels={channels} onApply={onApply} />);

    fireEvent.click(screen.getByRole('button', { name: /SWT 1/i }));

    expect(onApply).toHaveBeenCalledWith('swt_1');
  });
});
