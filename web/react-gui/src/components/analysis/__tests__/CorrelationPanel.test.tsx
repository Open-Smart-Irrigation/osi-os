// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../EChart', () => ({ EChart: () => <div data-testid="echart" /> }));

import { CorrelationPanel } from '../CorrelationPanel';
import type { AnalysisSeries } from '../../../analysis/types';
import type { ChannelMeta } from '../../../analysis/channelLabels';

const channelMeta: ChannelMeta = new Map([
  ['swt_1', { displayName: 'Soil water tension 1', unit: 'kPa' }],
  ['ambient_temperature', { displayName: 'Air temperature', unit: 'C' }],
  ['dendro', { displayName: 'Stem diameter change', unit: 'um' }],
]);

function series(zoneId: number, channelKey: string, n: number): AnalysisSeries {
  return {
    seriesId: `${zoneId}-${channelKey}`,
    resolved: { hubEui: null, zoneId, cardType: 'soil', sourceKey: 'root-zone', channelKey },
    label: `Zone ${zoneId} ${channelKey}`,
    unit: 'x',
    coveragePct: 100,
    points: Array.from({ length: n }, (_, i) => ({ t: `t${i}`, value: i, count: 1, quality: 'ok' })),
    truncated: false,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('CorrelationPanel', () => {
  it('prompts when fewer than two distinct channels exist', () => {
    render(<CorrelationPanel series={[series(1, 'swt_1', 40)]} channelMeta={channelMeta} />);
    expect(screen.getByText('analysis.correlation.needTwoChannels')).toBeInTheDocument();
    expect(screen.queryByTestId('echart')).not.toBeInTheDocument();
  });

  it('renders the scatter and a per-zone summary with r when enough samples', () => {
    render(<CorrelationPanel series={[series(1, 'swt_1', 40), series(1, 'dendro', 40)]} channelMeta={channelMeta} />);
    expect(screen.getByTestId('echart')).toBeInTheDocument();
    expect(screen.getAllByText('Soil water tension 1 (kPa)').length).toBeGreaterThan(0);
    expect(screen.getByText('Zone 1')).toBeInTheDocument();
    expect(screen.getByText('1.00')).toBeInTheDocument();
  });

  it('suppresses r below the minimum sample count', () => {
    render(<CorrelationPanel series={[series(2, 'swt_1', 5), series(2, 'dendro', 5)]} channelMeta={channelMeta} />);
    expect(screen.getByText(/analysis.correlation.insufficient/)).toBeInTheDocument();
  });

  it('reports pairs dropped for missing data (spec §5.5)', () => {
    const x: AnalysisSeries = {
      seriesId: '1-swt_1',
      resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
      label: 'Zone 1 soil',
      unit: 'x',
      coveragePct: 100,
      points: Array.from({ length: 40 }, (_, i) => ({
        t: `t${i}`,
        value: i < 3 ? null : i,
        count: i < 3 ? 0 : 1,
        quality: i < 3 ? 'gap' : 'ok',
      })),
      truncated: false,
    };
    render(<CorrelationPanel series={[x, series(1, 'dendro', 40)]} channelMeta={channelMeta} />);
    const row = screen.getByText('Zone 1').closest('tr') as HTMLElement;
    expect(within(row).getByText('37')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
  });

  it('states that correlation is exploratory rather than inferential', () => {
    render(<CorrelationPanel series={[series(1, 'swt_1', 40), series(1, 'dendro', 40)]} channelMeta={channelMeta} />);
    expect(screen.getByText('analysis.correlation.exploratory')).toBeInTheDocument();
  });

  it('shows a tooltip explaining Pooled', () => {
    render(<CorrelationPanel series={[series(1, 'swt_1', 40), series(1, 'dendro', 40)]} channelMeta={channelMeta} />);
    const checkbox = screen.getByLabelText(/pooled/i);
    expect(checkbox).toHaveAttribute('title', 'analysis.pooled.tooltip');
  });

  it('collapses legacy and canonical channel aliases into a single picker option', () => {
    render(
      <CorrelationPanel
        series={[series(1, 'temperature', 40), series(1, 'ambient_temperature', 40), series(1, 'dendro', 40)]}
        channelMeta={channelMeta}
      />,
    );

    expect(screen.getAllByRole('option', { name: 'Air temperature (°C)' })).toHaveLength(2);
  });
});
