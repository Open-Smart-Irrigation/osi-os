import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MobileSoilHistory, type MobileSoilHistoryLabels } from '../src/mobile/MobileSoilHistory';
import type { HistoryWindowResult } from '../src/history/useHistoryWindow';
import type { SensorSeries } from '../src/shared/types';
import { createViewportStore } from '../src/shared/viewport';

const labels: MobileSoilHistoryLabels = {
  ranges: { day: '24 h', week: '7 d', month: '30 d', ninetyDays: '90 d' },
  back: 'Back', forward: 'Forward', latest: 'Latest', sensors: 'Sensors', unitNotReported: 'Unit not reported',
  loading: 'Loading', updating: 'Updating', noData: 'No data', allHidden: 'All hidden', unavailable: 'Unavailable',
  pinnedReading: 'Pinned reading', close: 'Close', aggregation: 'Aggregation', points: 'Points', loadedRange: 'Loaded range',
  truncated: 'Truncated', showDay: 'Show day', retry: 'Retry', failure: 'Failed', coverage: 'Coverage', freshness: 'Freshness', notLoaded: 'Not loaded', rangesGroup: 'History ranges', visibleWindow: 'Visible time window',
  seriesLegend: { legend: 'Legend', showAll: 'Show all', plottedSeries: 'Plotted series', seriesCount: (count) => `${count} series`, focusAnnouncement: (label) => `Focused ${label}`, allSeriesAnnouncement: 'All series shown' },
};

function makeSeries(count: number, unit = 'kPa', start = 0): SensorSeries[] {
  return Array.from({ length: count }, (_, index) => ({ id: `soil-${start + index}`, label: `Soil ${start + index + 1}`, unit, points: [{ t: 1_000, value: index }] }));
}

function makeModel(series = makeSeries(8), overrides: Partial<HistoryWindowResult> = {}): HistoryWindowResult {
  const units = [...new Set(series.map((item) => item.unit))];
  const accepted = {
    request: { from: 0, to: 10_000, rangeLabel: '24h' as const, aggregation: 'raw' as const }, coverage: { from: 0, to: 10_000 },
    series, unitGroups: units.map((unit) => ({ unit, label: unit, seriesIds: series.filter((item) => item.unit === unit).map((item) => item.id) })),
    aggregation: { level: 'raw', pointCount: series.length, coveragePct: 100 }, limits: { maxPointsPerSeries: 100, truncated: false },
  };
  return { status: 'ready', accepted, loadingRequest: null, failedRequest: null, error: null, refreshing: false,
    viewportStore: createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 10_000 }, 1_000, 10_000),
    store: createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 10_000 }, 1_000, 10_000), horizon: { from: 0, to: 10_000 },
    selectPreset: vi.fn(), moveWindow: vi.fn(), showLatest: vi.fn(), retry: vi.fn(), ...overrides };
}

function adapterSpy() {
  const adapter = { setData: vi.fn(), setViewport: vi.fn(), setFocusedSeries: vi.fn(), getViewport: () => ({ from: 0, to: 10_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() };
  return { adapter, mount: vi.fn(() => adapter) };
}

describe('mobile legend state contracts', () => {
  test('focus changes only adapter focus and keeps the inspection pin', () => {
    const { adapter, mount } = adapterSpy();
    const historyModel = makeModel();
    render(<MobileSoilHistory model={historyModel} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    const dataCalls = adapter.setData.mock.calls.length;
    const viewportCalls = adapter.setViewport.mock.calls.length;
    fireEvent.click(screen.getByTestId('chart-host'), { clientX: 50, clientY: 50 });
    expect(screen.getByTestId('inspector')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 4' }));
    expect(adapter.setData).toHaveBeenCalledTimes(dataCalls);
    expect(adapter.setViewport).toHaveBeenCalledTimes(viewportCalls);
    expect(adapter.setFocusedSeries).toHaveBeenLastCalledWith('soil-3');
    expect(screen.getByTestId('inspector')).toBeTruthy();
    expect(historyModel.selectPreset).not.toHaveBeenCalled();
    expect(historyModel.moveWindow).not.toHaveBeenCalled();
    expect(historyModel.showLatest).not.toHaveBeenCalled();
  });

  test('retains styles by id through reorder, refill, hide, and new-series insertion', () => {
    const initial = makeSeries(12);
    const { adapter, mount } = adapterSpy();
    const base = makeModel(initial);
    const view = render(<MobileSoilHistory model={base} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    const appearanceById = () => {
      const call = adapter.setData.mock.calls.at(-1)?.[0] as readonly SensorSeries[];
      return new Map(call.map((item) => [item.id, `${item.appearance?.color}|${item.appearance?.dash.join(',')}|${item.appearance?.marker}`]));
    };
    const first = appearanceById();
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 6' }));
    adapter.setFocusedSeries.mockClear();
    const reordered = [initial[5], initial[1], initial[11], ...initial.slice(0, 1), ...initial.slice(2, 5), ...initial.slice(6, 11)];
    view.rerender(<MobileSoilHistory model={makeModel(reordered, { viewportStore: base.viewportStore, store: base.store })} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    expect(adapter.setFocusedSeries.mock.calls).toContainEqual(['soil-5']);
    expect(screen.getByText('Focused Soil 6')).toBeTruthy();
    const second = appearanceById();
    expect(second.get('soil-0')).toBe(first.get('soil-0'));
    expect(second.get('soil-11')).toBe(first.get('soil-11'));
    expect(new Set([...second.values()]).size).toBe(12);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(appearanceById().get('soil-5')).toBe(first.get('soil-5'));
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 6' }));
    adapter.setFocusedSeries.mockClear();
    const refilled = reordered.map((item) => ({ ...item, points: [{ t: 2_000, value: 9 }] }));
    view.rerender(<MobileSoilHistory model={makeModel(refilled, { viewportStore: base.viewportStore, store: base.store })} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    expect(adapter.setFocusedSeries.mock.calls).toContainEqual(['soil-5']);
    expect(screen.getByText('Focused Soil 6')).toBeTruthy();
    expect(appearanceById().get('soil-5')).toBe(first.get('soil-5'));
    view.rerender(<MobileSoilHistory model={makeModel([...refilled, ...makeSeries(1, 'kPa', 12)], { viewportStore: base.viewportStore, store: base.store })} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    expect(new Set([...appearanceById().values()]).size).toBe(12);
  });

  test('resets focus on context, unit, inclusion, and removed-series boundaries', () => {
    const mixed = [...makeSeries(4), ...makeSeries(1, 'VWC', 4)];
    const { mount } = adapterSpy();
    const base = makeModel(mixed);
    const view = render(<MobileSoilHistory model={base} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 2' }));
    expect(screen.getByText('Focused Soil 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Soil 1/ }));
    expect(screen.getByText('All series shown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Soil 2' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'VWC' } });
    expect(screen.getByText('All series shown')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kPa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 2' }));
    view.rerender(<MobileSoilHistory model={makeModel(mixed, { viewportStore: base.viewportStore, store: base.store })} contextKey="other/card" labels={labels} mountAdapter={mount} />);
    expect(screen.getByText('All series shown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 2' }));
    view.rerender(<MobileSoilHistory model={makeModel(mixed.filter((item) => item.id !== 'soil-1'), { viewportStore: base.viewportStore, store: base.store })} contextKey="other/card" labels={labels} mountAdapter={mount} />);
    expect(screen.getByText('All series shown')).toBeTruthy();
  });

  test('keeps descriptor metadata and all-hidden recovery when accepted data becomes empty', () => {
    const series = makeSeries(4);
    const { adapter, mount } = adapterSpy();
    const base = makeModel(series);
    const view = render(<MobileSoilHistory model={base} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    expect(screen.getByText('All hidden')).toBeTruthy();
    const empty = makeModel([], { status: 'empty', accepted: { ...makeModel(series).accepted!, series: [], aggregation: { level: 'raw', pointCount: 0, coveragePct: 0 } } });
    view.rerender(<MobileSoilHistory model={empty} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.getByTestId('chart-host')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    view.rerender(<MobileSoilHistory model={makeModel(series, { viewportStore: base.viewportStore, store: base.store })} contextKey="farm/card" labels={labels} mountAdapter={mount} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.queryByText('All hidden')).toBeNull();
    expect((adapter.setData.mock.calls.at(-1)?.[0] as readonly SensorSeries[]).map((item) => item.id)).toEqual(['soil-0']);
  });
});
