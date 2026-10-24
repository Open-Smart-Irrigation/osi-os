import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MobileTensionHistory, type MobileTensionHistoryLabels } from '../src/mobile/MobileTensionHistory';
import type { HistoryLoadContext, HistoryWindowResponse, MobileTensionSource } from '../src/shared/types';
import { HistoryAuthError } from '../src/history/types';
import { MobileHistoryError } from '../src/mobile/mobileHistoryError';

const labels: MobileTensionHistoryLabels = {
  title: 'Water tension history', chart: 'Water tension chart', waterTension: 'Water tension', controls: 'History controls',
  time: 'Time', timeRange: 'Time range', range24h: '24 hours', range7d: '7 days', latest: 'Latest', hourlyAverages: 'Hourly averages',
  hourlyAverage: 'Hourly average', loading: 'Loading history…', refreshing: 'Updating history…', emptyInterval: 'No data in this interval.',
  showLatest24h: 'Show latest 24 hours', unavailableValue: 'Unavailable in this hour', notLoaded: 'Not loaded', chooseSources: 'Choose sources',
  historicalUnverified: 'Historical source; current assignment unverified', sources: 'Sources', chartSources: 'Chart sources', openSources: 'Choose chart sources',
  sourceDiscoveryIncomplete: 'Source discovery is incomplete.', catalogFailed: 'Sources could not be loaded.', unavailableSources: 'Some sources are unavailable.',
  requestTooLarge: 'This request is too large.', fewerSourcesOrShorterWindow: 'Choose fewer sources or a shorter time range.', accessDenied: 'Access denied.',
  incompleteResponse: 'The history response was incomplete.', transientFailure: 'History is temporarily unavailable.', retry: 'Retry', details: 'Details', close: 'Close',
  pinnedReading: 'Pinned reading', visibleWindow: 'Visible time window', sourceCap: (limit) => `You can select up to ${limit} sources.`,
  sourceCount: (selected, total) => `Selected ${selected} of ${total} sources.`, invalidHourlyAverages: (count) => `Invalid hourly averages: ${count}.`,
  removedSources: (names) => `Removed sources: ${names}.`, removeSource: (name) => `Remove ${name}`,
  transportCoverage: (from, to) => `Loaded from ${from} to ${to}.`, bucketInterval: (from, to) => `From ${from} to ${to}.`, latestBucket: (at) => `Latest hourly average: ${at}.`,
  seriesLegend: { legend: 'Legend', showAll: 'Show all', plottedSeries: 'Plotted series', seriesCount: (count) => `Series shown: ${count}`, focusAnnouncement: (label) => `Focused series: ${label}`, allSeriesAnnouncement: 'All series shown' },
};

const source = (index: number): MobileTensionSource => ({ seriesId: `series-${index}`, sourceKey: `source-${index}`, channelKey: 'swt_1', label: `Probe ${index}`, unit: 'kPa', zoneId: '1', available: true, status: 'current', measurementKind: 'soil' });

const load = vi.fn(async (request = { from: 0, to: 86_400_000, rangeLabel: '24h' as const, aggregation: 'hourly' as const }, _signal?: AbortSignal, _context?: HistoryLoadContext): Promise<HistoryWindowResponse> => {
  return ({
  request, coverage: { from: request.from, to: request.to }, series: (request.selectionKey ? JSON.parse(request.selectionKey) : ['series-1']).map((id: string) => ({ id, label: id, unit: 'kPa', points: [{ t: request.from, value: 4 }], buckets: [{ from: request.from, to: request.to, value: 4, count: 1, quality: 'ok' }] })),
  unitGroups: [], aggregation: { level: 'hourly', pointCount: 0 }, limits: { maxPointsPerSeries: 2000, truncated: false }, readPolicy: 'edge-hourly',
  });
});

const props = (overrides: Partial<React.ComponentProps<typeof MobileTensionHistory>> = {}) => ({
  sources: [source(1), source(2)], defaultSelectedIds: ['series-1'], catalogError: null, catalogLoading: false,
  context: { sessionKey: 'session', scopeKey: 'zone:1', cardId: 'mobile-water-tension' }, readPolicy: () => 'edge-hourly' as const,
  locale: 'en-GB', timeZone: 'UTC', zoneLabel: 'North plot', labels, load, refreshCatalogForGeneration: vi.fn(async () => {}), onAuthError: vi.fn(),
  mountAdapter: () => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 86_400_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() }),
  ...overrides,
});

describe('MobileTensionHistory', () => {
  beforeEach(() => load.mockClear());

  test('renders the compact shell, fixed kPa unit, and accessible time/sources sheets', async () => {
    render(<MobileTensionHistory {...props()} />);
    expect(screen.getByRole('heading', { name: labels.title })).toBeTruthy();
    expect(screen.getByText('kPa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: labels.time }));
    expect(screen.getByRole('dialog', { name: labels.timeRange })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: labels.close }));
    fireEvent.click(screen.getByRole('button', { name: labels.openSources }));
    expect(screen.getByRole('dialog', { name: labels.chartSources })).toBeTruthy();
  });

  test('does not load history when the deliberate selection is empty', () => {
    render(<MobileTensionHistory {...props({ defaultSelectedIds: [] })} />);
    expect(screen.getByText(labels.chooseSources)).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });

  test('keeps the empty choice when the catalog later vanishes', async () => {
    const view = render(<MobileTensionHistory {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: labels.openSources }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Probe 1' }));
    fireEvent.click(screen.getByRole('button', { name: labels.close }));
    view.rerender(<MobileTensionHistory {...props({ sources: [], defaultSelectedIds: ['series-1'] })} />);
    await waitFor(() => expect(screen.getByText(labels.chooseSources)).toBeTruthy());
    expect(screen.queryByText(/Selected 1/)).toBeNull();
  });

  test('leaves historical other-supported rows unchecked by default but selectable', () => {
    const historical = { ...source(2), status: 'other_supported' as const };
    const view = render(<MobileTensionHistory {...props({ sources: [source(1), historical], defaultSelectedIds: ['series-2'] })} />);
    fireEvent.click(screen.getByRole('button', { name: labels.openSources }));
    const checkbox = screen.getByRole('checkbox', { name: /Probe 2/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    view.rerender(<MobileTensionHistory {...props({ sources: [source(1), { ...historical }], defaultSelectedIds: ['series-1'] })} />);
    expect((screen.getByRole('checkbox', { name: /Probe 2/ }) as HTMLInputElement).checked).toBe(true);
  });

  test('updates the adapter viewport for a gesture without replacing unchanged chart data', async () => {
    let gesture: ((viewport: { from: number; to: number }) => void) | undefined;
    const setData = vi.fn();
    const mountAdapter = vi.fn((_host, _initial, onViewportChange) => {
      gesture = onViewportChange;
      return { setData, setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 86_400_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() };
    });
    render(<MobileTensionHistory {...props({ mountAdapter })} />);
    await waitFor(() => expect(setData.mock.calls.some(([series]) => series.length === 1 && series[0].points?.some((point: { value: number | null }) => point.value !== null))).toBe(true));
    const initialDataCalls = setData.mock.calls.length;
    act(() => { gesture?.({ from: 3_600_000, to: 90_000_000 }); });
    expect(setData).toHaveBeenCalledTimes(initialDataCalls);
  });

  test('keeps deterministic appearances through an 8 to 7 to 8 selection cycle', async () => {
    const sources = Array.from({ length: 8 }, (_, index) => source(index + 1));
    const setData = vi.fn();
    const mountAdapter = () => ({ setData, setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 86_400_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() });
    render(<MobileTensionHistory {...props({ sources, defaultSelectedIds: sources.map((item) => item.seriesId), mountAdapter })} />);
    await waitFor(() => expect(setData.mock.calls.some(([series]) => series.length === 8)).toBe(true));
    const first = setData.mock.calls.find(([series]) => series.length === 8)?.[0].find((item: { id: string }) => item.id === 'series-1').appearance;
    fireEvent.click(screen.getByRole('button', { name: labels.openSources }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Probe 8' }));
    fireEvent.click(screen.getByRole('button', { name: labels.close }));
    await waitFor(() => expect(screen.getByRole('button', { name: labels.openSources }).textContent).toContain('Selected 7'));
    fireEvent.click(screen.getByRole('button', { name: labels.openSources }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Probe 8' }));
    await waitFor(() => expect(screen.getByRole('button', { name: labels.openSources }).textContent).toContain('Selected 8'));
    const last = [...setData.mock.calls].reverse().find(([series]) => series.length === 8)?.[0].find((item: { id: string }) => item.id === 'series-1').appearance;
    expect(last).toEqual(first);
  });

  test('refreshes the catalog once for a denied source generation and evicts it', async () => {
    const refresh = vi.fn(async () => {});
    const failure = new MobileHistoryError({ kind: 'sources', missingIds: [], dropped: [{ seriesId: 'series-1', reason: 'access_denied' }], accessDeniedIds: ['series-1'], reason: 'denied' });
    load.mockRejectedValueOnce(failure);
    render(<MobileTensionHistory {...props({ refreshCatalogForGeneration: refresh })} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByText(labels.removedSources('Probe 1'))).toBeTruthy();
  });

  test('passes auth failures to the existing session expiry path', async () => {
    const onAuthError = vi.fn();
    load.mockRejectedValueOnce(new HistoryAuthError(401, 'expired'));
    render(<MobileTensionHistory {...props({ onAuthError })} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 401 })));
  });

  test('shows access denied and hides the chart for a series 403', async () => {
    const onAuthError = vi.fn();
    const deniedLoad = vi.fn(async () => { throw new HistoryAuthError(403, 'denied'); });
    render(<MobileTensionHistory {...props({ load: deniedLoad, onAuthError })} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(screen.getByText(labels.accessDenied)).toBeTruthy();
    expect(screen.queryByRole('button', { name: labels.retry })).toBeNull();
    expect(screen.queryByTestId('chart-host')).toBeNull();
  });

  test('traps source-sheet focus, closes on Escape, and restores the opener', () => {
    render(<MobileTensionHistory {...props()} />);
    const opener = screen.getByRole('button', { name: labels.openSources });
    fireEvent.click(opener);
    const sheet = screen.getByRole('dialog', { name: labels.chartSources });
    const controls = [...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    controls.at(-1)?.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
    expect(screen.queryByRole('dialog', { name: labels.chartSources })).toBeNull();
  });

  test('keeps source-sheet focus stable while toggling a source', () => {
    render(<MobileTensionHistory {...props()} />);
    const opener = screen.getByRole('button', { name: labels.openSources });
    fireEvent.click(opener);
    const checkbox = screen.getByRole('checkbox', { name: 'Probe 2' });
    checkbox.focus();
    fireEvent.click(checkbox);
    expect(document.activeElement).toBe(checkbox);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  test('keeps the 26th source visible but disabled at the cap', () => {
    const sources = Array.from({ length: 26 }, (_, index) => source(index + 1));
    render(<MobileTensionHistory {...props({ sources, defaultSelectedIds: sources.slice(0, 25).map((item) => item.seriesId) })} />);
    fireEvent.click(screen.getByRole('button', { name: labels.openSources }));
    const sixth = screen.getByRole('checkbox', { name: 'Probe 26' });
    expect((sixth as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(labels.sourceCap(25))).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(26);
  });

  test('keeps legend focus independent from source selection and network work', async () => {
    render(<MobileTensionHistory {...props()} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    const requests = load.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Probe 1' }));
    expect(screen.getByText(labels.seriesLegend.focusAnnouncement('Probe 1'))).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(requests);
  });

  test('shows the empty interval and latest action for a complete null response', async () => {
    const emptyLoad = vi.fn(async (request = { from: 0, to: 86_400_000, rangeLabel: '24h' as const, aggregation: 'hourly' as const }): Promise<HistoryWindowResponse> => ({
      request, coverage: { from: request.from, to: request.to }, series: [{ id: 'series-1', label: 'Probe 1', unit: 'kPa', points: [{ t: request.from, value: null }], buckets: [{ from: request.from, to: request.to, value: null, count: 0, quality: 'partial' }] }], unitGroups: [], aggregation: { level: 'hourly', pointCount: 1 }, limits: { maxPointsPerSeries: 2000, truncated: false }, readPolicy: 'edge-hourly',
    }));
    render(<MobileTensionHistory {...props({ load: emptyLoad })} />);
    await waitFor(() => expect(screen.getByText(labels.emptyInterval)).toBeTruthy());
    expect(screen.getByRole('button', { name: labels.showLatest24h })).toBeTruthy();
  });

  test('shows loading while the default selection is starting before the first response', async () => {
    let resolveLoad!: (response: HistoryWindowResponse) => void;
    const deferredLoad = vi.fn((request: Parameters<typeof load>[0]): Promise<HistoryWindowResponse> => new Promise((resolve) => { resolveLoad = resolve; }));
    render(<MobileTensionHistory {...props({ load: deferredLoad })} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(labels.loading)).toBeTruthy();
    expect(screen.queryByText(labels.emptyInterval)).toBeNull();
    expect(screen.queryByRole('button', { name: labels.showLatest24h })).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    expect(deferredLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByText(labels.loading)).toBeTruthy();
    expect(screen.queryByText(labels.emptyInterval)).toBeNull();
    expect(screen.queryByRole('button', { name: labels.showLatest24h })).toBeNull();
    const request = deferredLoad.mock.calls[0][0];
    resolveLoad({
      request,
      coverage: { from: request.from, to: request.to },
      series: [{ id: 'series-1', label: 'Probe 1', unit: 'kPa', points: [{ t: request.from, value: null }], buckets: [{ from: request.from, to: request.to, value: null, count: 0, quality: 'partial' }] }],
      unitGroups: [], aggregation: { level: 'hourly', pointCount: 1 }, limits: { maxPointsPerSeries: 2_000, truncated: false }, readPolicy: 'edge-hourly',
    });
    await waitFor(() => expect(screen.queryByText(labels.loading)).toBeNull());
    expect(screen.getByText(labels.emptyInterval)).toBeTruthy();
    expect(screen.getByRole('button', { name: labels.showLatest24h })).toBeTruthy();
  });

  test('empty seven-day view recovers with one exact latest 24-hour request', async () => {
    const emptyLoad = vi.fn(async (request = { from: 0, to: 86_400_000, rangeLabel: '24h' as const, aggregation: 'hourly' as const }): Promise<HistoryWindowResponse> => ({
      request, coverage: { from: request.from, to: request.to }, series: [{ id: 'series-1', label: 'Probe 1', unit: 'kPa', points: [{ t: request.from, value: null }], buckets: [{ from: request.from, to: request.to, value: null, count: 0, quality: 'partial' }] }], unitGroups: [], aggregation: { level: 'hourly', pointCount: 1 }, limits: { maxPointsPerSeries: 2000, truncated: false }, readPolicy: 'edge-hourly',
    }));
    render(<MobileTensionHistory {...props({ load: emptyLoad })} />);
    await waitFor(() => expect(emptyLoad).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: labels.time }));
    fireEvent.click(screen.getByRole('button', { name: labels.range7d }));
    await waitFor(() => expect(emptyLoad).toHaveBeenCalledTimes(2));
    emptyLoad.mockClear();
    fireEvent.click(screen.getByRole('button', { name: labels.showLatest24h }));
    await waitFor(() => expect(emptyLoad).toHaveBeenCalledTimes(1));
    const request = emptyLoad.mock.calls[0][0];
    expect(request.rangeLabel).toBe('24h');
    expect(request.to - request.from).toBe(86_400_000);
  });

  test('hides chart and calls the typed auth path for catalog 403 without retry', async () => {
    const onAuthError = vi.fn();
    render(<MobileTensionHistory {...props({ catalogError: new HistoryAuthError(403, 'denied'), onAuthError })} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(screen.getByText(labels.accessDenied)).toBeTruthy();
    expect(screen.queryByRole('button', { name: labels.retry })).toBeNull();
    expect(screen.queryByTestId('chart-host')).toBeNull();
  });

  test('does not offer a generic retry for catalog size or protocol errors', () => {
    const error = new MobileHistoryError({ kind: 'size', status: 413, reason: 'too large' });
    render(<MobileTensionHistory {...props({ catalogError: error })} />);
    expect(screen.queryByRole('button', { name: labels.retry })).toBeNull();
  });

  test('initializes a completed empty catalog once and does not apply later defaults', async () => {
    const view = render(<MobileTensionHistory {...props({ sources: [], defaultSelectedIds: [], catalogLoading: false })} />);
    expect(screen.getByText(labels.chooseSources)).toBeTruthy();
    view.rerender(<MobileTensionHistory {...props()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(labels.chooseSources)).toBeTruthy();
    expect(screen.queryByText(/Selected 1/)).toBeNull();
  });

  test('never sends old selected IDs while a new context initializes', async () => {
    const view = render(<MobileTensionHistory {...props({ context: { sessionKey: 'session-a', scopeKey: 'zone:1', cardId: 'mobile-water-tension' }, sources: [source(1)], defaultSelectedIds: ['series-1'] })} />);
    await waitFor(() => expect(load.mock.calls.some(([, , context]) => context?.selectedIds?.includes('series-1'))).toBe(true));
    const oldCallCount = load.mock.calls.length;
    view.rerender(<MobileTensionHistory {...props({ context: { sessionKey: 'session-b', scopeKey: 'zone:2', cardId: 'mobile-water-tension' }, sources: [source(2)], defaultSelectedIds: ['series-2'] })} />);
    await waitFor(() => expect(load.mock.calls.slice(oldCallCount).some(([, , context]) => context?.selectedIds?.includes('series-2'))).toBe(true));
    const newContextCalls = load.mock.calls.slice(oldCallCount);
    expect(newContextCalls.every(([, , context]) => context?.selectedIds?.every((id: string) => id === 'series-2'))).toBe(true);
  });
});
