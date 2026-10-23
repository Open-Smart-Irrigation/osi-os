// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setOption = vi.fn();
const resize = vi.fn();
const dispose = vi.fn();
const getDataURL = vi.fn(() => 'data:image/png;base64,AAAA');
const handlers = new Map<string, (params: unknown) => void>();
const on = vi.fn((event: string, handler: (params: unknown) => void) => { handlers.set(event, handler); });
vi.mock('echarts/core', () => ({
  init: vi.fn(() => ({ setOption, resize, dispose, getDataURL, on })),
  use: vi.fn(),
}));
vi.mock('echarts/charts', () => ({ LineChart: {}, ScatterChart: {} }));
vi.mock('echarts/components', () => ({ GridComponent: {}, LegendComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

import * as echarts from 'echarts/core';
import { EChart, type EChartHandle } from '../EChart';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

afterEach(() => { cleanup(); vi.clearAllMocks(); handlers.clear(); });

describe('EChart', () => {
  it('initializes echarts and applies the option', () => {
    render(<EChart option={{ series: [] }} />);
    expect(echarts.init).toHaveBeenCalledTimes(1);
    expect(setOption).toHaveBeenCalledWith({ series: [] }, true);
  });

  it('disposes the instance on unmount', () => {
    const { unmount } = render(<EChart option={{}} />);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('exposes getDataURL through its ref', () => {
    const ref = createRef<EChartHandle>();
    render(<EChart option={{}} ref={ref} />);
    expect(ref.current?.getDataURL()).toBe('data:image/png;base64,AAAA');
  });

  it('renders exportOption in a detached instance without mutating the live chart', () => {
    getDataURL.mockReturnValueOnce('data:image/png;base64,XYZ');
    const ref = createRef<EChartHandle>();
    render(<EChart ref={ref} option={{ a: 1 }} exportOption={{ a: 2 }} />);
    const url = ref.current!.getExportDataURL();
    expect(url).toBe('data:image/png;base64,XYZ');
    expect(echarts.init).toHaveBeenCalledTimes(2); // live + offscreen
    expect(setOption).toHaveBeenCalledWith(expect.objectContaining({ a: 2, animation: false }));
    expect(setOption).not.toHaveBeenCalledWith({ a: 2 }, true); // live chart never swapped
    expect(dispose).toHaveBeenCalled(); // offscreen disposed
  });

  it('keeps the legend selection the user made when a new option arrives (resize rebuilds)', () => {
    const option = { legend: { type: 'scroll' }, series: [{ name: 'Zone 1' }, { name: 'Zone 2' }] };
    const { rerender } = render(<EChart option={option} />);
    handlers.get('legendselectchanged')?.({ selected: { 'Zone 1': true, 'Zone 2': false } });
    rerender(<EChart option={{ ...option, grid: [{ left: 40 }] }} />);
    expect(setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ legend: { type: 'scroll', selected: { 'Zone 1': true, 'Zone 2': false } }, grid: [{ left: 40 }] }),
      true,
    );
  });

  it('passes an option without a legend through unchanged', () => {
    const { rerender } = render(<EChart option={{ series: [] }} />);
    handlers.get('legendselectchanged')?.({ selected: { A: false } });
    rerender(<EChart option={{ series: [1] }} />);
    expect(setOption).toHaveBeenLastCalledWith({ series: [1] }, true);
  });
});
