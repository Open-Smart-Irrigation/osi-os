import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChartHost } from '../src/ChartHost';
import { createViewportStore } from '../src/shared/viewport';

const refreshGeometry = vi.fn();
vi.mock('../src/shared/gestures', () => ({
  attachD3ViewportController: () => ({ destroy: vi.fn(), refreshGeometry, updateExtent: vi.fn() }),
}));

const series = [{ id: 'soil', label: 'Soil', unit: 'kPa', points: [{ t: 1_000, value: 4 }] }] as const;

describe('packaged ChartHost', () => {
  test('inspects the containing half-open bucket with explicit locale inputs', () => {
    const mountAdapter = vi.fn(() => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 7_200_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() }));
    const store = createViewportStore({ from: 0, to: 7_200_000 }, { from: 0, to: 7_200_000 }, 1_000, 7_200_000);
    const buckets = [{ from: 0, to: 3_600_000, value: 23.416666666666668, count: 2, quality: 'ok' }, { from: 3_600_000, to: 7_200_000, value: null, count: 0, quality: 'partial' }] as const;
    const view = render(<ChartHost mountAdapter={mountAdapter} series={[{ ...series[0], buckets }]} store={store} extent={{ from: 0, to: 7_200_000 }} inspectionMode="containing-bucket" locale="fr" timeZone="UTC" />);
    expect(mountAdapter).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ locale: 'fr', timeZone: 'UTC' }));
    fireEvent.click(view.getByTestId('chart-host'), { clientX: 25, clientY: 50 });
    expect(view.getByTestId('inspector').textContent).toContain('23,4167');
    expect(view.getByTestId('inspector').textContent).toContain('janv.');
    view.rerender(<ChartHost mountAdapter={mountAdapter} series={[{ ...series[0], buckets }]} store={store} extent={{ from: 0, to: 7_200_000 }} inspectionMode="containing-bucket" locale="en-GB" timeZone="UTC" />);
    fireEvent.click(view.getByTestId('chart-host'), { clientX: 75, clientY: 50 });
    expect(view.getByTestId('inspector').textContent).toContain('Unavailable');
  });
  test('keeps nearest-point numeric output in legacy raw form', () => {
    const mountAdapter = vi.fn(() => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 7_200_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() }));
    const store = createViewportStore({ from: 0, to: 7_200_000 }, { from: 0, to: 7_200_000 }, 1_000, 7_200_000);
    const view = render(<ChartHost mountAdapter={mountAdapter} series={[{ ...series[0], points: [{ t: 1_800_000, value: 23.416666666666668 }] }]} store={store} extent={{ from: 0, to: 7_200_000 }} />);
    fireEvent.click(view.getByTestId('chart-host'), { clientX: 25, clientY: 50 });
    expect(view.getByTestId('inspector').textContent).toContain('23.416666666666668');
  });
  test('uses rerendered locale for subscribed window updates', () => {
    const mountAdapter = vi.fn(() => ({ setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 7_200_000 }), getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn() }));
    const store = createViewportStore({ from: 0, to: 7_200_000 }, { from: 0, to: 86_400_000 }, 1_000, 86_400_000);
    const view = render(<ChartHost mountAdapter={mountAdapter} series={[{ ...series[0], buckets: [{ from: 0, to: 3_600_000, value: 1, count: 1, quality: 'ok' }] }]} store={store} extent={{ from: 0, to: 86_400_000 }} inspectionMode="containing-bucket" locale="en-US" timeZone="UTC" />);
    view.rerender(<ChartHost mountAdapter={mountAdapter} series={[{ ...series[0], buckets: [{ from: 0, to: 3_600_000, value: 1, count: 1, quality: 'ok' }] }]} store={store} extent={{ from: 0, to: 86_400_000 }} inspectionMode="containing-bucket" locale="fr-FR" timeZone="UTC" />);
    act(() => { store.set({ from: 3_600_000, to: 10_800_000 }, 'external'); });
    expect(view.getByRole('group', { name: 'Visible time window' }).textContent).toContain('janv.');
  });
  test('applies external viewport writes and element resize geometry', () => {
    let resizeCallback: (() => void) | undefined;
    class Observer {
      constructor(callback: () => void) { resizeCallback = callback; }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Observer);
    const setViewport = vi.fn();
    const resize = vi.fn();
    const mountAdapter = vi.fn(() => ({
      setData: vi.fn(),
      setViewport,
      getViewport: () => ({ from: 0, to: 10_000 }),
      getPlotRect: () => new DOMRect(0, 0, 100, 100),
      resize,
      destroy: vi.fn(),
    }));
    const store = createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 20_000 }, 1_000, 20_000);
    render(<ChartHost mountAdapter={mountAdapter} series={series} store={store} extent={{ from: 0, to: 20_000 }} />);
    const initialCalls = setViewport.mock.calls.length;
    act(() => { store.set({ from: 5_000, to: 15_000 }, 'external'); });
    expect(setViewport.mock.calls.length).toBeGreaterThan(initialCalls);
    act(() => { resizeCallback?.(); });
    expect(resize).toHaveBeenCalled();
    expect(refreshGeometry).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('keeps the adapter and inspection pin when the horizon advances', () => {
    const destroy = vi.fn();
    const mountAdapter = vi.fn(() => ({
      setData: vi.fn(), setViewport: vi.fn(), getViewport: () => ({ from: 0, to: 10_000 }),
      getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy,
    }));
    const store = createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 20_000 }, 1_000, 20_000);
    const view = render(<ChartHost mountAdapter={mountAdapter} series={series} store={store} extent={{ from: 0, to: 20_000 }} />);
    fireEvent.click(view.getAllByTestId('chart-host')[0], { clientX: 50, clientY: 50 });
    expect(view.getByTestId('inspector')).toBeTruthy();
    view.rerender(<ChartHost mountAdapter={mountAdapter} series={series} store={store} extent={{ from: 0, to: 30_000 }} />);
    expect(mountAdapter).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(view.getByTestId('inspector')).toBeTruthy();
  });

  test('updates focus without replacing data, viewport, adapter, or inspection', () => {
    const setData = vi.fn();
    const setViewport = vi.fn();
    const setFocusedSeries = vi.fn();
    const mountAdapter = vi.fn(() => ({
      setData, setViewport, setFocusedSeries, getViewport: () => ({ from: 0, to: 10_000 }),
      getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn(),
    }));
    const store = createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 20_000 }, 1_000, 20_000);
    const view = render(<ChartHost mountAdapter={mountAdapter} series={series} focusedSeriesId={null} store={store} extent={{ from: 0, to: 20_000 }} />);
    fireEvent.click(view.getAllByTestId('chart-host')[0], { clientX: 50, clientY: 50 });
    expect(view.getByTestId('inspector')).toBeTruthy();
    const dataCalls = setData.mock.calls.length;
    const viewportCalls = setViewport.mock.calls.length;
    view.rerender(<ChartHost mountAdapter={mountAdapter} series={series} focusedSeriesId="soil" store={store} extent={{ from: 0, to: 20_000 }} />);
    expect(mountAdapter).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledTimes(dataCalls);
    expect(setViewport).toHaveBeenCalledTimes(viewportCalls);
    expect(setFocusedSeries).toHaveBeenLastCalledWith('soil');
    expect(view.getByTestId('inspector')).toBeTruthy();
  });

  test('reapplies focus after a data reconciliation', () => {
    const setFocusedSeries = vi.fn();
    const mountAdapter = vi.fn(() => ({
      setData: vi.fn(), setViewport: vi.fn(), setFocusedSeries, getViewport: () => ({ from: 0, to: 10_000 }),
      getPlotRect: () => new DOMRect(0, 0, 100, 100), resize: vi.fn(), destroy: vi.fn(),
    }));
    const store = createViewportStore({ from: 0, to: 10_000 }, { from: 0, to: 20_000 }, 1_000, 20_000);
    const replacement = [{ ...series[0], points: [{ t: 2_000, value: 5 }] }];
    const view = render(<ChartHost mountAdapter={mountAdapter} series={series} focusedSeriesId="soil" store={store} extent={{ from: 0, to: 20_000 }} />);
    setFocusedSeries.mockClear();
    view.rerender(<ChartHost mountAdapter={mountAdapter} series={replacement} focusedSeriesId="soil" store={store} extent={{ from: 0, to: 20_000 }} />);
    expect(setFocusedSeries).toHaveBeenLastCalledWith('soil');
  });
});
