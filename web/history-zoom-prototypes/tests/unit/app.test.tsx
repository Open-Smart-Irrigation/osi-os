import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MountAdapter } from '../../src/shared/types';

const adapter: MountAdapter = () => ({
  setData: () => undefined,
  setViewport: () => undefined,
  getViewport: () => ({ from: 0, to: 1 }),
  getPlotRect: () => new DOMRect(0, 0, 100, 100),
  resize: () => undefined,
  destroy: () => undefined,
});

let adapterFailure = false;

vi.mock('../../src/routes', () => ({
  candidateFromHash: () => window.location.hash.includes('uplot') ? 'uplot' : 'chartjs',
  routeFromHash: () => window.location.hash.startsWith('#/pilot/') ? ({ kind: 'pilot', platform: window.location.hash.endsWith('/cloud') ? 'cloud' : 'edge' }) : ({ kind: 'candidate', candidate: window.location.hash.includes('uplot') ? 'uplot' : 'chartjs' }),
  loadAdapter: async () => {
    if (adapterFailure) throw new Error('adapter failed');
    return adapter;
  },
}));

vi.mock('../../src/ChartHost', () => ({
  ChartHost: ({ series }: { series: readonly { points: readonly unknown[] }[] }) => (
    <div data-testid="fake-chart">{series.map((item) => item.points.length).join(',')}</div>
  ),
}));

import { App } from '../../src/App';

function chooseFixture(kind: string) {
  fireEvent.change(screen.getByTestId('fixture-select'), { target: { value: kind } });
}

function chooseDelay(delay: number) {
  fireEvent.change(screen.getByTestId('load-delay-ms'), { target: { value: String(delay) } });
}

describe('App fixture loading lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); adapterFailure = false; window.location.hash = ''; });
  afterEach(() => vi.useRealTimers());

  it('loads successfully after StrictMode effect replay', async () => {
    render(<StrictMode><App /></StrictMode>);
    chooseFixture('single');
    fireEvent.click(screen.getByTestId('load-fixture'));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId('accepted-fixture').textContent).toContain('single');
    expect(screen.getByTestId('point-count').textContent).toContain('1');
    expect(screen.getByRole('status').textContent).toContain('Showing single fixture');
  });

  it('applies only the latest selected request and keeps loading until it settles', async () => {
    render(<StrictMode><App /></StrictMode>);
    chooseFixture('nominal');
    chooseDelay(100);
    fireEvent.click(screen.getByTestId('load-fixture'));
    chooseFixture('single');
    chooseDelay(10);
    fireEvent.click(screen.getByTestId('load-fixture'));

    expect(screen.getByTestId('load-fixture').hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Loading single fixture…');
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByTestId('accepted-fixture').textContent).toContain('single');
    expect(screen.getByRole('status').textContent).toContain('Showing single fixture');
    await vi.advanceTimersByTimeAsync(90);
    expect(screen.getByRole('status').textContent).toContain('Showing single fixture');
    expect(screen.getByTestId('accepted-fixture').textContent).toContain('single');
  });

  it('labels loading with the fixture captured by the pending request', async () => {
    render(<StrictMode><App /></StrictMode>);
    chooseFixture('nominal');
    chooseDelay(100);
    fireEvent.click(screen.getByTestId('load-fixture'));
    chooseFixture('single');
    expect(screen.getByRole('status').textContent).toContain('Loading nominal fixture…');
    await vi.advanceTimersByTimeAsync(100);
  });

  it('shows lazy adapter errors without an unhandled rejection', async () => {
    adapterFailure = true;
    window.location.hash = '#/uplot';
    render(<StrictMode><App /></StrictMode>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('Candidate unavailable: adapter failed')).toBeTruthy();
    adapterFailure = false;
  });

  it('does not update after unmounting with a request pending', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<StrictMode><App /></StrictMode>);
    chooseDelay(100);
    fireEvent.click(screen.getByTestId('load-fixture'));
    view.unmount();
    await vi.advanceTimersByTimeAsync(100);
    expect(errors.mock.calls).toHaveLength(0);
    errors.mockRestore();
  });

  it('transitions between candidate and both pilot platforms without canonicalizing pilot hashes', async () => {
    render(<App />);
    await act(async () => { window.history.replaceState(null, '', '#/pilot/edge'); window.dispatchEvent(new HashChangeEvent('hashchange')); await Promise.resolve(); });
    expect(screen.getByTestId('pilot-shell')).toBeTruthy();
    expect(window.location.hash).toBe('#/pilot/edge');
    await act(async () => { window.history.replaceState(null, '', '#/pilot/cloud'); window.dispatchEvent(new HashChangeEvent('hashchange')); await Promise.resolve(); });
    expect(screen.getByText(/Authenticated history pilot · cloud/)).toBeTruthy();
    await act(async () => { window.history.replaceState(null, '', '#/uplot'); window.dispatchEvent(new HashChangeEvent('hashchange')); await Promise.resolve(); });
    expect(screen.getByTestId('fixture-select')).toBeTruthy();
    expect(window.location.hash).toBe('#/uplot');
  });
});
