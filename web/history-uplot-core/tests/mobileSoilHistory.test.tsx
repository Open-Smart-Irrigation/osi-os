import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MobileSoilHistory, type MobileSoilHistoryLabels } from '../src/mobile/MobileSoilHistory';
import type { HistoryWindowResult } from '../src/history/useHistoryWindow';
import { createViewportStore } from '../src/shared/viewport';

const labels: MobileSoilHistoryLabels = {
  ranges: { day: '24 h', week: '7 d', month: '30 d', ninetyDays: '90 d' },
  back: 'Back', forward: 'Forward', latest: 'Latest', sensors: 'Sensors',
  unitNotReported: 'Unit not reported', loading: 'Loading', updating: 'Updating',
  noData: 'No data', allHidden: 'All hidden', unavailable: 'Unavailable',
  pinnedReading: 'Pinned reading', close: 'Close', aggregation: 'Aggregation',
  points: 'Points', loadedRange: 'Loaded range', truncated: 'Truncated',
  showDay: 'Show day', retry: 'Retry', failure: 'Failed', coverage: 'Coverage',
  freshness: 'Freshness', notLoaded: 'Not loaded',
  rangesGroup: 'Zeiträume', visibleWindow: 'Sichtbarer Zeitraum',
  seriesLegend: {
    legend: 'Legend', showAll: 'Show all', plottedSeries: 'Plotted series',
    seriesCount: (count) => `${count} series`, focusAnnouncement: (label) => `Focused ${label}`,
    allSeriesAnnouncement: 'All series shown',
  },
};

function model(overrides: Partial<HistoryWindowResult> = {}): HistoryWindowResult {
  const accepted = {
    request: { from: 0, to: 10_000, rangeLabel: '24h' as const, aggregation: 'raw' as const },
    coverage: { from: 0, to: 10_000 },
    series: [{ id: 'soil', label: 'Soil', unit: 'kPa', points: [{ t: 1_000, value: 0 }] }],
    unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['soil'] }],
    aggregation: { level: 'raw', pointCount: 1, coveragePct: 50 },
    limits: { maxPointsPerSeries: 100, truncated: false },
  };
  return {
    status: 'ready', accepted, loadingRequest: null, failedRequest: null, error: null,
    refreshing: false, viewportStore: createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 10_000 }, 1_000, 10_000),
    store: createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 10_000 }, 1_000, 10_000),
    horizon: { from: 0, to: 10_000 },
    selectPreset: vi.fn(), moveWindow: vi.fn(), showLatest: vi.fn(), retry: vi.fn(),
    ...overrides,
  };
}

describe('packaged MobileSoilHistory', () => {
  const adapter = () => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 10_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() });

  test('renders translated failure retry and coverage metadata', () => {
    const retry = vi.fn();
    render(<MobileSoilHistory model={model({ status: 'error', error: new Error('offline'), retry })} contextKey="account/card" labels={labels} mountAdapter={() => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 10_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() })} />);
    expect(screen.getByText('Failed: offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByText('Coverage: 50%')).toBeTruthy();
  });

  // Screen readers hear the host's language: the range group and the visible-window readout
  // take their names from the labels, never from English literals in the package.
  test('names the range group and the visible-window readout from the labels', () => {
    const view = render(<MobileSoilHistory model={model()} contextKey="account/card" labels={labels} mountAdapter={adapter} />);
    expect(view.container.querySelector('.history-ranges')?.getAttribute('aria-label')).toBe('Zeiträume');
    expect(view.container.querySelector('.window-readout')?.getAttribute('aria-label')).toBe('Sichtbarer Zeitraum');
    expect(view.container.innerHTML).not.toMatch(/History ranges|Visible time window/);
  });

  test('keeps the chart mounted for empty data and preserves the all-hidden choice', () => {
    const view = render(<MobileSoilHistory model={model()} contextKey="account/card" labels={labels} mountAdapter={() => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 10_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() })} />);
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Soil/ })[0]);
    expect(screen.getByText('All hidden')).toBeTruthy();
    const empty = model({ accepted: { ...model().accepted!, series: [], aggregation: { level: 'raw', pointCount: 0, coveragePct: 0 } }, status: 'empty' });
    view.rerender(<MobileSoilHistory model={empty} contextKey="account/card" labels={labels} mountAdapter={() => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 10_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() })} />);
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.getByTestId('chart-host')).toBeTruthy();
  });

  test('collapses a four-plus series legend and focuses a plotted series without changing inclusion', () => {
    const series = Array.from({ length: 8 }, (_, index) => ({ id: `soil-${index}`, label: `Soil ${index + 1}`, unit: 'kPa', points: [{ t: 1_000, value: index }] }));
    const view = model({ accepted: { ...model().accepted!, series, unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: series.map((item) => item.id) }] } });
    render(<MobileSoilHistory model={view} contextKey="account/card" labels={labels} mountAdapter={adapter} />);
    expect(screen.getByRole('button', { name: 'Legend' })).toBeTruthy();
    expect(screen.getByText('8 series')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 4' }));
    expect(screen.getByText('Focused Soil 4')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
    expect(view.selectPreset).toBeDefined();
  });

  test('keeps one-to-three series labels inline and provides show all after focus', () => {
    const series = Array.from({ length: 3 }, (_, index) => ({ id: `soil-${index}`, label: `Long soil channel ${index + 1}`, unit: 'kPa', points: [{ t: 1_000, value: index }] }));
    const view = model({ accepted: { ...model().accepted!, series, unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: series.map((item) => item.id) }] } });
    render(<MobileSoilHistory model={view} contextKey="account/card" labels={labels} mountAdapter={adapter} />);
    expect(screen.queryByRole('button', { name: 'Legend' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Long soil channel 2/ }));
    expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText('All series shown')).toBeTruthy();
  });

  test('shows the full focused identity and SVG appearance swatches', () => {
    const series = Array.from({ length: 4 }, (_, index) => ({ id: `soil-${index}`, label: `Very long soil channel name ${index + 1}`, unit: 'kPa', points: [{ t: 1_000, value: index }] }));
    const view = model({ accepted: { ...model().accepted!, series, unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: series.map((item) => item.id) }] } });
    render(<MobileSoilHistory model={view} contextKey="account/card" labels={labels} mountAdapter={adapter} />);
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Very long soil channel name 3' }));
    expect(screen.getAllByText('Very long soil channel name 3').length).toBeGreaterThan(1);
    expect(document.querySelectorAll('svg.mobile-series-legend-swatch').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy();
  });

  test('closes the legend panel when inclusion changes', () => {
    const series = Array.from({ length: 4 }, (_, index) => ({ id: `soil-${index}`, label: `Soil ${index + 1}`, unit: 'kPa', points: [{ t: 1_000, value: index }] }));
    const view = model({ accepted: { ...model().accepted!, series, unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: series.map((item) => item.id) }] } });
    render(<MobileSoilHistory model={view} contextKey="account/card" labels={labels} mountAdapter={adapter} />);
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    expect(screen.getByRole('list', { name: 'Plotted series' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Soil 1/ }));
    expect(document.querySelector('.mobile-series-legend-panel')).toBeNull();
  });

  test('keeps the sensor disclosure open across repeated checkbox toggles', () => {
    const series = Array.from({ length: 4 }, (_, index) => ({ id: `soil-${index}`, label: `Soil ${index + 1}`, unit: 'kPa', points: [{ t: 1_000, value: index }] }));
    const view = model({ accepted: { ...model().accepted!, series, unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: series.map((item) => item.id) }] } });
    render(<MobileSoilHistory model={view} contextKey="account/card" labels={labels} mountAdapter={adapter} />);
    const disclosure = document.querySelector('.mobile-history-sensors-disclosure') as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    fireEvent.click(disclosure.querySelector('summary')!);
    expect(disclosure.open).toBe(true);
    const checkbox = screen.getByRole('checkbox', { name: /Soil 1/ });
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    expect(disclosure.open).toBe(true);
  });
});
