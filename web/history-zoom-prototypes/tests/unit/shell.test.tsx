import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartHost } from '../../src/ChartHost';
import { createViewportStore } from '../../src/shared/viewport';
import { FIXTURE_EXTENT, INITIAL_VIEWPORT, type ChartAdapter, type MountAdapter, type SensorSeries, type Viewport } from '../../src/shared/types';
import { fixtureSeries } from '../../src/shared/fixtures';
import * as gestures from '../../src/shared/gestures';

const plot = new DOMRect(52, 16, 326, 308);
const customSeries = (base: number): readonly SensorSeries[] => [
  { id: 'one', label: 'One', unit: 'kPa', points: [{ t: base, value: 0 }, { t: base + 60_000, value: 4 }] },
  { id: 'two', label: 'Two', unit: 'kPa', points: [{ t: base, value: null }, { t: base + 60_000, value: 8 }] },
  { id: 'three', label: 'Three', unit: 'kPa', points: [{ t: base, value: 2 }, { t: base + 60_000, value: null }] },
];

function fakeMount(calls: string[] = [], initial = INITIAL_VIEWPORT) {
  let viewport = { ...initial };
  let currentPlot = plot;
  let nextPlot: DOMRect | null = null;
  let callback: ((next: Viewport) => void) | null = null;
  const adapter: ChartAdapter = {
    setData: () => calls.push('data'),
    setViewport: (next) => { calls.push('viewport'); viewport = { ...next }; },
    getViewport: () => ({ ...viewport }),
    getPlotRect: () => currentPlot,
    resize: () => { calls.push('resize'); if (nextPlot) currentPlot = nextPlot; },
    destroy: () => calls.push('destroy'),
  };
  const mount: MountAdapter = (_host, _initial, onViewportChange) => { calls.push('mount'); callback = onViewportChange; return adapter; };
  return { mount, adapter, calls, change: (next: Viewport) => callback?.(next), setNextPlot: (next: DOMRect) => { nextPlot = next; } };
}

function renderHost(mountAdapter: MountAdapter, series = fixtureSeries('single'), onDiagnostics?: (probe: any) => void) {
  const store = createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT);
  return { store, ...render(<ChartHost route="chartjs" mountAdapter={mountAdapter} series={series} store={store} onDiagnostics={onDiagnostics} />) };
}

describe('history shell', () => {
  it('mounts every candidate with the shared gesture layer and ordered lifecycle', () => {
    for (const route of ['echarts', 'uplot', 'chartjs'] as const) {
      const calls: string[] = [];
      const controller = vi.spyOn(gestures, 'attachD3ViewportController').mockImplementation(() => ({ sync: () => undefined, refreshGeometry: () => undefined, destroy: () => calls.push('controller-destroy') }));
      const { mount, adapter } = fakeMount(calls);
      const store = createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT);
      const { unmount } = render(<ChartHost route={route} mountAdapter={mount} series={fixtureSeries('single')} store={store} />);
      expect(calls.slice(0, 4)).toEqual(['mount', 'data', 'viewport', 'resize']);
      expect(document.querySelector('.gesture-layer')).toBeTruthy();
      unmount();
      expect(calls.slice(-2)).toEqual(['controller-destroy', 'destroy']);
      controller.mockRestore();
      void adapter;
    }
  });

  it('pins the target timestamp and every series row, including null as unavailable', () => {
    const { mount } = fakeMount();
    const base = INITIAL_VIEWPORT.from;
    renderHost(mount, customSeries(base));
    fireEvent.click(screen.getByTestId('chart-host'), { clientX: 52, clientY: 16 });
    expect(screen.getByTestId('inspector')).toBeTruthy();
    expect(screen.getByTestId('inspector-target').getAttribute('dateTime')).toBe(new Date(base).toISOString());
    expect(screen.getByText('One: 0 kPa')).toBeTruthy();
    expect(screen.getByText('Two')).toBeTruthy();
    expect(screen.getByText('Three: 2 kPa')).toBeTruthy();
    expect(screen.getAllByText('Unavailable at this sample')).toHaveLength(1);
  });

  it('projects, hides, and closes the pin guide using frame-relative plot geometry', () => {
    const { mount, store } = (() => {
      const value = fakeMount();
      const store = createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT);
      return { ...value, store };
    })();
    render(<ChartHost route="chartjs" mountAdapter={mount} series={fixtureSeries('single')} store={store} />);
    const host = screen.getByTestId('chart-host');
    const guide = document.querySelector('.inspector-guide') as HTMLElement;
    expect(guide.hidden).toBe(true);
    fireEvent.click(host, { clientX: 215, clientY: 100 });
    expect(guide.hidden).toBe(false);
    expect(guide.style.left).toBe('215px');
    act(() => { store.set({ from: FIXTURE_EXTENT.from, to: FIXTURE_EXTENT.from + 60 * 60_000 }, 'external'); });
    expect(guide.hidden).toBe(true);
    fireEvent.click(screen.getByTestId('inspector-close'));
    expect(screen.queryByTestId('inspector')).toBeNull();
    expect(guide.hidden).toBe(true);
  });

  it('suppresses drag, pinch, cancel, and long-press clicks, then accepts a fresh tap', () => {
    const { mount } = fakeMount();
    renderHost(mount, fixtureSeries('single'));
    const host = screen.getByTestId('chart-host');
    const blocked = [
      () => { fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 100 }] }); fireEvent.touchMove(host, { touches: [{ clientX: 110, clientY: 100 }] }); fireEvent.touchEnd(host); },
      () => { fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 100 }, { clientX: 101, clientY: 100 }] }); fireEvent.touchEnd(host); },
      () => { fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 100 }] }); fireEvent.touchCancel(host); },
    ];
    for (const gesture of blocked) { gesture(); fireEvent.click(host, { clientX: 200, clientY: 100 }); expect(screen.queryByTestId('inspector')).toBeNull(); }
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 100 }] }); clock = 1_500; fireEvent.touchEnd(host); fireEvent.click(host, { clientX: 200, clientY: 100 });
    expect(screen.queryByTestId('inspector')).toBeNull();
    now.mockRestore();
    fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 100 }] }); fireEvent.touchEnd(host); fireEvent.click(host, { clientX: 200, clientY: 100 });
    expect(screen.getByTestId('inspector')).toBeTruthy();
  });

  it('ignores taps outside the plot and refreshes the guide after resize', () => {
    const calls: string[] = [];
    const geometry = fakeMount(calls);
    const { mount } = geometry;
    renderHost(mount);
    const host = screen.getByTestId('chart-host');
    fireEvent.click(host, { clientX: 20, clientY: 100 });
    expect(screen.queryByTestId('inspector')).toBeNull();
    fireEvent.click(host, { clientX: 100, clientY: 100 });
    geometry.setNextPlot(new DOMRect(80, 20, 200, 280));
    window.dispatchEvent(new Event('resize'));
    expect(calls.filter((call) => call === 'resize').length).toBeGreaterThanOrEqual(2);
    expect(Number.parseFloat((document.querySelector('.inspector-guide') as HTMLElement).style.left)).toBeCloseTo(109.44785, 4);
  });

  it('counts accepted store changes once, preserves viewport on data reload, and rejects stale callbacks', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let oldChange: ((next: Viewport) => void) | undefined;
    let newChange: ((next: Viewport) => void) | undefined;
    const first = fakeMount(calls); oldChange = first.change;
    const store = createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT);
    const diagnostics: any[] = [];
    const view = render(<ChartHost route="chartjs" mountAdapter={first.mount} series={fixtureSeries('single')} store={store} onDiagnostics={(probe) => diagnostics.push(probe)} />);
    const initialCalls = calls.filter((call) => call === 'viewport').length;
    const changed = { from: INITIAL_VIEWPORT.from - 60_000, to: INITIAL_VIEWPORT.to - 60_000 };
    act(() => { store.set(changed, 'external'); store.set(changed, 'external'); });
    expect(calls.filter((call) => call === 'viewport').length).toBe(initialCalls + 1);
    act(() => { first.change({ from: changed.from - 60_000, to: changed.to - 60_000 }); });
    expect(calls.filter((call) => call === 'viewport').length).toBe(initialCalls + 1);
    expect(diagnostics).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(100); });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).not.toBe(diagnostics[0]);
    expect(diagnostics[1].viewportNotifications).toBe(2);
    expect(diagnostics[1].adapterSetViewportCalls).toBe(initialCalls + 1);
    const beforeReload = store.get();
    const second = fakeMount(calls); newChange = second.change;
    view.rerender(<ChartHost route="chartjs" mountAdapter={second.mount} series={fixtureSeries('sparse')} store={store} />);
    expect(second.adapter.getViewport()).toEqual(beforeReload);
    view.rerender(<ChartHost route="chartjs" mountAdapter={second.mount} series={fixtureSeries('stress')} store={store} onDiagnostics={(probe) => diagnostics.push(probe)} />);
    act(() => { oldChange?.({ from: INITIAL_VIEWPORT.from, to: INITIAL_VIEWPORT.to }); });
    expect(store.get()).toEqual(beforeReload);
    act(() => { newChange?.({ from: beforeReload.from - 60_000, to: beforeReload.to - 60_000 }); });
    vi.useRealTimers();
  });

  it('stops replaced and unmounted frame samplers and removes the global probe', () => {
    delete window.__historyZoomProbe;
    const callbacks: FrameRequestCallback[] = [];
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callbacks.push(callback); return callbacks.length; });
    let probe: any;
    const { mount } = fakeMount();
    const view = renderHost(mount, fixtureSeries('single'), (next) => { probe = next; });
    probe.startFrameSampling();
    probe.startFrameSampling();
    expect(cancel).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(window.__historyZoomProbe).toBeUndefined();
    expect(() => probe.renderedViewport).toThrow('Chart adapter is not live');
    expect(() => probe.plotRect).toThrow('Chart adapter is not live');
    cancel.mockRestore();
    vi.restoreAllMocks();
  });

  it('clears the inspector and guide when data changes', () => {
    const geometry = fakeMount();
    const first = fixtureSeries('single');
    const view = renderHost(geometry.mount, first);
    const host = screen.getByTestId('chart-host');
    fireEvent.click(host, { clientX: 215, clientY: 100 });
    expect(screen.getByTestId('inspector')).toBeTruthy();
    expect((document.querySelector('.inspector-guide') as HTMLElement).hidden).toBe(false);
    view.rerender(<ChartHost route="chartjs" mountAdapter={geometry.mount} series={[...first]} store={view.store} />);
    expect(screen.queryByTestId('inspector')).toBeNull();
    expect((document.querySelector('.inspector-guide') as HTMLElement).hidden).toBe(true);
  });

  it('clears the inspector and guide on a semantic remount', () => {
    const first = fakeMount();
    const second = fakeMount();
    const series = fixtureSeries('single');
    const store = createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT);
    const view = render(<ChartHost route="chartjs" mountAdapter={first.mount} series={series} store={store} />);
    fireEvent.click(screen.getByTestId('chart-host'), { clientX: 215, clientY: 100 });
    expect(screen.getByTestId('inspector')).toBeTruthy();
    view.rerender(<ChartHost route="uplot" mountAdapter={second.mount} series={series} store={store} />);
    expect(screen.queryByTestId('inspector')).toBeNull();
    expect((document.querySelector('.inspector-guide') as HTMLElement).hidden).toBe(true);
  });
});
