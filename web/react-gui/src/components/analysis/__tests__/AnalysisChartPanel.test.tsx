// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const echartSpy = vi.fn();
vi.mock('../EChart', () => ({
  EChart: ({ onAxisNameClick, ...rest }: any) => {
    echartSpy(rest.option);
    return <button data-testid="fake-axis" onClick={() => onAxisNameClick?.('swt_1', { x: 10, y: 20 })}>axis</button>;
  },
}));
vi.mock('../CorrelationPanel', () => ({ CorrelationPanel: () => <div data-testid="correlation-panel" /> }));
vi.mock('../../../analysis/echartsOptions', () => ({
  buildTimeSeriesOption: vi.fn(() => ({ grid: [] })),
  buildSmallMultiplesOption: vi.fn(() => ({ grid: [] })),
}));

import { AnalysisChartPanel, chartMinHeight } from '../AnalysisChartPanel';
import { buildSmallMultiplesOption, buildTimeSeriesOption } from '../../../analysis/echartsOptions';
import type { AnalysisSeries } from '../../../analysis/types';

function s(id: string, unit: string): AnalysisSeries {
  return {
    seriesId: id, resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: id },
    label: id, unit, coveragePct: 100, points: [{ t: '2026-06-18T00:00:00Z', value: 1, count: 1, quality: 'ok' }], truncated: false,
  };
}

function mkSeries(id: string, channelKey: string, unit: string): AnalysisSeries {
  return {
    seriesId: id, resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey },
    label: id, unit, coveragePct: 100, points: [{ t: '2026-06-18T00:00:00Z', value: 1, count: 1, quality: 'ok' }], truncated: false,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AnalysisChartPanel', () => {
  it('computes chart minimum height by mode and panel count', () => {
    expect(chartMinHeight('stacked', 3)).toBe(720);
    expect(chartMinHeight('stacked', 1)).toBe(360);
    expect(chartMinHeight('overlaid', 5)).toBe(360);
    expect(chartMinHeight('small-multiples', 5)).toBe(440);
  });

  it('shows an empty state with no series', () => {
    render(<AnalysisChartPanel series={[]} mode="timeline" layout="stacked" toggles={{ normalize: false }} channelMeta={new Map()} />);
    expect(screen.queryByTestId('echart')).not.toBeInTheDocument();
    expect(screen.getByText('analysis.empty')).toBeInTheDocument();
  });

  it('renders a chart for timeline mode', () => {
    render(<AnalysisChartPanel series={[s('a', 'kPa')]} mode="timeline" layout="stacked" toggles={{ normalize: false }} channelMeta={new Map()} />);
    expect(screen.getByTestId('fake-axis')).toBeInTheDocument();
    expect(echartSpy).toHaveBeenCalledTimes(1);
  });

  it('routes overlaid layout to the time-series builder with multi-axis enabled', () => {
    render(<AnalysisChartPanel series={[s('a', 'kPa')]} mode="timeline" layout="overlaid" toggles={{ normalize: false }} channelMeta={new Map()} />);
    expect(buildTimeSeriesOption).toHaveBeenCalledWith(expect.objectContaining({ multiAxis: true, normalize: false }));
  });

  it('routes stacked layout to the time-series builder with multi-axis disabled', () => {
    render(<AnalysisChartPanel series={[s('a', 'kPa')]} mode="timeline" layout="stacked" toggles={{ normalize: false }} channelMeta={new Map()} />);
    expect(buildTimeSeriesOption).toHaveBeenCalledWith(expect.objectContaining({ multiAxis: false }));
  });

  it('routes small-multiples layout to the small-multiples builder with normalize', () => {
    const series = [mkSeries('a', 'swt_1', 'kPa')];
    render(<AnalysisChartPanel series={series} mode="timeline" layout="small-multiples" toggles={{ normalize: true }} channelMeta={new Map()} resolveAxisLabel={(k) => k} />);
    expect(buildSmallMultiplesOption).toHaveBeenCalledWith(series, true, expect.any(Function));
    expect(buildTimeSeriesOption).not.toHaveBeenCalled();
  });

  it('applies the stacked-panel height to the chart frame', () => {
    render(<AnalysisChartPanel
      series={[s('a', 'kPa'), s('b', 'C'), s('c', '%')]}
      mode="timeline"
      layout="stacked"
      toggles={{ normalize: false }}
      channelMeta={new Map()}
    />);
    expect(screen.getByTestId('analysis-chart-frame')).toHaveStyle({ minHeight: '720px' });
  });

  it('keeps overlaid charts at the single-panel height', () => {
    render(<AnalysisChartPanel
      series={[s('a', 'kPa'), s('b', 'C'), s('c', '%')]}
      mode="timeline"
      layout="overlaid"
      toggles={{ normalize: false }}
      channelMeta={new Map()}
    />);
    expect(screen.getByTestId('analysis-chart-frame')).toHaveStyle({ minHeight: '360px' });
  });

  it('renders the correlation panel for correlation mode', () => {
    render(<AnalysisChartPanel series={[s('a', 'kPa')]} mode="correlation" layout="stacked" toggles={{ normalize: false }} channelMeta={new Map()} />);
    expect(screen.getByTestId('correlation-panel')).toBeInTheDocument();
  });

  it('opens an inline editor on axis-name click and commits an override', () => {
    const onAxisRename = vi.fn();
    render(<AnalysisChartPanel series={[mkSeries('a','swt_1','kPa')]} mode="timeline" layout="stacked" toggles={{normalize:false}} channelMeta={new Map()} resolveAxisLabel={(k)=>k} onAxisRename={onAxisRename} />);
    fireEvent.click(screen.getByTestId('fake-axis'));
    const input = screen.getByRole('textbox', { name: 'analysis.axis.rename' });
    fireEvent.change(input, { target: { value: 'Soil tension' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAxisRename).toHaveBeenCalledWith('swt_1', 'Soil tension');
  });
});
