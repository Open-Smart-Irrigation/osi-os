import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MountAdapter } from '../../src/shared/types';

const adapter: MountAdapter = () => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 1000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() });
const accepted = { cardId: 'soil', request: { from: 0, to: 86_400_000, rangeLabel: '24h', aggregation: 'raw' }, coverage: { from: 0, to: 86_400_000 }, series: [{ id: 'swt', label: 'SWT', unit: 'kPa', points: [{ t: 0, value: 1 }] }], unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['swt'] }], aggregation: { level: 'raw', pointCount: 1 }, limits: { maxPointsPerSeries: 2000, truncated: false } } as const;
const store = { get: () => ({ from: 0, to: 86_400_000 }), set: () => ({ from: 0, to: 86_400_000 }), subscribe: () => () => undefined };
const mocked = vi.hoisted(() => ({ history: null as any, loadAdapter: vi.fn() }));
vi.mock('../../src/routes', async () => ({ ...(await vi.importActual<typeof import('../../src/routes')>('../../src/routes')), loadAdapter: mocked.loadAdapter }));
vi.mock('../../src/pilot/usePilotHistory', () => ({ usePilotHistory: () => mocked.history }));
vi.mock('../../src/ChartHost', () => ({ ChartHost: ({ mountAdapter, series }: { mountAdapter: unknown; series: readonly unknown[] }) => <div data-testid="chart-host" data-series-count={series.length}>{typeof mountAdapter}</div> }));
import { PilotApp } from '../../src/pilot/PilotApp';

function makeHistory(overrides: Record<string, unknown> = {}) {
  return { contextKey: 'edge:0', status: 'ready', refreshing: false, zones: [{ id: 7, name: 'North' }], cards: [{ cardId: 'soil', cardType: 'soil', title: 'Soil', views: ['line-chart'], sourceLabels: [], available: true }], selectedZoneId: 7, selectedCardId: 'soil', accepted, loadingRequest: null, failedRequest: null, error: null, horizon: { from: 0, to: 90 * 86_400_000 }, store, selectZone: vi.fn(), selectCard: vi.fn(), selectPreset: vi.fn(), moveWindow: vi.fn(), showLatest: vi.fn(), retry: vi.fn(), ...overrides };
}

describe('PilotApp mount', () => {
  beforeEach(() => { mocked.loadAdapter.mockReset().mockResolvedValue(adapter); mocked.history = makeHistory(); });
  it('stores a lazy mount adapter function and renders the pilot chart', async () => {
    render(<StrictMode><PilotApp platform="edge" /></StrictMode>);
    expect(await screen.findByTestId('chart-host')).toBeTruthy();
    expect(screen.getByTestId('chart-host').textContent).toBe('function');
    expect(screen.getByTestId('pilot-shell')).toBeTruthy();
  });

  it('keeps the chart gesture surface and interval recovery copy for accepted empty history', async () => {
    mocked.history = makeHistory({ status: 'empty', accepted: { ...accepted, series: [], unitGroups: [] } });
    render(<PilotApp platform="edge" />);
    expect(screen.getByTestId('pilot-empty').textContent).toContain('Pinch, drag, Back, Forward, or Latest');
    expect(await screen.findByTestId('chart-host')).toBeTruthy();
    expect(screen.getByTestId('chart-host').getAttribute('data-series-count')).toBe('0');
    expect(screen.getByTestId('pilot-accepted-range')).toBeTruthy();
    expect(screen.getByTestId('pilot-aggregation').textContent).toContain('raw');
    expect(screen.queryByText(/All series are hidden/)).toBeNull();
  });

  it('retains context metadata, unit, enabled subset, and chart identity across empty recovery', async () => {
    const data = { ...accepted, series: [{ id: 'swt', label: 'SWT', unit: 'kPa', points: [{ t: 0, value: 1 }] }, { id: 'temp', label: 'Temperature', unit: 'kPa', points: [{ t: 0, value: 2 }] }], unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['swt', 'temp'] }] };
    mocked.history = makeHistory({ accepted: data });
    const view = render(<PilotApp platform="edge" />);
    await waitFor(() => expect(screen.getByTestId('pilot-series-toggle-swt')).toBeTruthy());
    fireEvent.click(screen.getByTestId('pilot-series-toggle-temp'));
    fireEvent.click(screen.getByTestId('pilot-series-toggle-swt'));
    const chart = screen.getByTestId('chart-host');
    const chartWrap = document.querySelector('.pilot-chart-wrap');
    mocked.history = makeHistory({ status: 'empty', accepted: { ...data, series: [], unitGroups: [] } });
    view.rerender(<PilotApp platform="edge" />);
    await waitFor(() => expect(screen.getByTestId('pilot-empty').textContent).toContain('Pinch, drag'));
    expect(screen.getByTestId('chart-host')).toBe(chart);
    expect(screen.getByTestId('chart-host').getAttribute('data-series-count')).toBe('0');
    expect(document.querySelector('.pilot-chart-wrap')).toBe(chartWrap);
    expect((screen.getByTestId('pilot-unit-select') as HTMLSelectElement).value).toBe('kPa');
    expect((screen.getByTestId('pilot-series-toggle-swt') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('pilot-series-toggle-temp') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/All series are hidden/)).toBeNull();
    mocked.history = makeHistory({ accepted: data });
    view.rerender(<PilotApp platform="edge" />);
    await waitFor(() => expect(screen.queryByTestId('pilot-empty')).toBeNull());
    expect(screen.getByTestId('chart-host')).toBe(chart);
    expect(document.querySelector('.pilot-chart-wrap')).toBe(chartWrap);
    expect(screen.queryByText(/All series are hidden/)).toBeTruthy();
    expect((screen.getByTestId('pilot-series-toggle-temp') as HTMLInputElement).checked).toBe(false);
  });

  it('does not inherit remembered descriptors into a new card context', async () => {
    const data = { ...accepted, series: [{ id: 'swt', label: 'SWT', unit: 'kPa', points: [{ t: 0, value: 1 }] }], unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['swt'] }] };
    mocked.history = makeHistory({ accepted: data });
    const view = render(<PilotApp platform="edge" />);
    await waitFor(() => expect(screen.getByTestId('pilot-series-toggle-swt')).toBeTruthy());
    mocked.history = makeHistory({ contextKey: 'edge:1', status: 'empty', accepted: { ...data, series: [], unitGroups: [] } });
    view.rerender(<PilotApp platform="edge" />);
    await waitFor(() => expect((screen.getByTestId('pilot-unit-select') as HTMLSelectElement).value).toBe(''));
    expect(screen.queryByTestId('pilot-series-toggle-swt')).toBeNull();
  });

  it('does not inherit descriptors across cards in the same session context', async () => {
    const soil = { ...accepted, series: [{ id: 'swt', label: 'SWT', unit: 'kPa', points: [{ t: 0, value: 1 }] }], unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['swt'] }] };
    const cards = [
      { cardId: 'soil', cardType: 'soil', title: 'Soil', views: ['line-chart'], sourceLabels: [], available: true },
      { cardId: 'environment', cardType: 'environment', title: 'Environment', views: ['line-chart'], sourceLabels: [], available: true },
    ];
    mocked.history = makeHistory({ cards, accepted: soil });
    const view = render(<PilotApp platform="edge" />);
    await waitFor(() => expect(screen.getByTestId('pilot-series-toggle-swt')).toBeTruthy());
    mocked.history = makeHistory({
      cards,
      selectedCardId: 'environment',
      accepted: { ...soil, cardId: 'environment', series: [], unitGroups: [] },
    });
    view.rerender(<PilotApp platform="edge" />);
    await waitFor(() => expect(screen.getByTestId('pilot-empty').textContent).toContain('Pinch, drag'));
    expect((screen.getByTestId('pilot-unit-select') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('pilot-series-toggle-swt')).toBeNull();
    expect(screen.queryByText('SWT')).toBeNull();
  });

  it('chooses a finite unit group when the first group has no measurements', () => {
    const data = { ...accepted, series: [{ id: 'nulls', label: 'Nulls', unit: 'kPa', points: [{ t: 0, value: null }] }, { id: 'temp', label: 'Temp', unit: 'C', points: [{ t: 0, value: 12 }] }], unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['nulls'] }, { unit: 'C', label: 'C', seriesIds: ['temp'] }] };
    mocked.history = makeHistory({ accepted: data });
    render(<PilotApp platform="edge" />);
    expect((screen.getByTestId('pilot-unit-select') as HTMLSelectElement).value).toBe('C');
  });

  it('preserves all-hidden state across a same-card refresh', async () => {
    const data = { ...accepted, series: [{ id: 'swt', label: 'SWT', unit: 'kPa', points: [{ t: 0, value: 1 }] }, { id: 'new', label: 'New', unit: 'kPa', points: [{ t: 0, value: 2 }] }], unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['swt', 'new'] }] };
    mocked.history = makeHistory({ accepted: data });
    const view = render(<PilotApp platform="edge" />);
    const toggle = screen.getByTestId('pilot-series-toggle-swt') as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('pilot-series-toggle-new'));
    mocked.history = makeHistory({ accepted: { ...data, series: data.series.map((item) => ({ ...item, points: [{ t: 1, value: 3 }] })) } });
    view.rerender(<PilotApp platform="edge" />);
    await waitFor(() => expect((screen.getByTestId('pilot-series-toggle-swt') as HTMLInputElement).checked).toBe(false));
    expect((screen.getByTestId('pilot-series-toggle-new') as HTMLInputElement).checked).toBe(false);
  });

  it('reinitializes local sensor toggles when the account context changes', async () => {
    const data = { ...accepted, series: [{ id: 'swt', label: 'SWT', unit: 'kPa', points: [{ t: 0, value: 1 }] }], unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['swt'] }] };
    mocked.history = makeHistory({ accepted: data });
    const view = render(<PilotApp platform="edge" />);
    fireEvent.click(screen.getByTestId('pilot-series-toggle-swt'));
    mocked.history = makeHistory({ contextKey: 'edge:1', accepted: data });
    view.rerender(<PilotApp platform="edge" />);
    await waitFor(() => expect((screen.getByTestId('pilot-series-toggle-swt') as HTMLInputElement).checked).toBe(true));
  });

  it('shows a clear initial error state with retry instead of claiming ready', () => {
    mocked.history = makeHistory({ status: 'error', accepted: null, error: 'Unable to load zones' });
    render(<PilotApp platform="edge" />);
    expect(screen.getByTestId('pilot-load-status').textContent).toContain('Unable to load history');
    expect(screen.getByTestId('pilot-error').textContent).toContain('Unable to load zones');
    expect(screen.getByTestId('pilot-retry')).toBeTruthy();
  });

  it('keeps the accepted chart visible during a same-context refresh', async () => {
    mocked.history = makeHistory({ refreshing: true });
    render(<PilotApp platform="edge" />);
    expect(await screen.findByTestId('chart-host')).toBeTruthy();
    expect(screen.getByTestId('pilot-load-status').textContent).toBe('Ready');
    expect(screen.getByTestId('pilot-refresh-status').textContent).toBe('Updating nearby history…');
    expect(screen.getByTestId('pilot-refresh-status').getAttribute('aria-live')).toBe('off');
    expect(document.querySelector('.pilot-loading-overlay')).toBeNull();
  });

  it('announces initial loading only before accepted data exists', () => {
    mocked.history = makeHistory({ status: 'loading', accepted: null });
    render(<PilotApp platform="edge" />);
    expect(screen.getByTestId('pilot-load-status').textContent).toContain('Loading history');
    expect(screen.getByTestId('pilot-refresh-status').textContent).toBe('');
  });

  it('keeps the chart and retry affordance after a background refresh failure', async () => {
    mocked.history = makeHistory({ status: 'error', error: 'Unable to load history', failedRequest: accepted.request });
    render(<PilotApp platform="edge" />);
    expect(await screen.findByTestId('chart-host')).toBeTruthy();
    expect(screen.getByTestId('pilot-error').textContent).toContain('Retry');
    expect(document.querySelector('.pilot-loading-overlay')).toBeNull();
  });

  it('shows renderer load failure without an unhandled rejection', async () => {
    mocked.loadAdapter.mockRejectedValueOnce(new Error('renderer failed'));
    render(<PilotApp platform="edge" />);
    expect((await screen.findByTestId('pilot-error')).textContent).toContain('renderer failed');
  });
});
