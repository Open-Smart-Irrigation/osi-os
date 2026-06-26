// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setOption = vi.fn();
const resize = vi.fn();
const dispose = vi.fn();
const getDataURL = vi.fn(() => 'data:image/png;base64,AAAA');
vi.mock('echarts', () => ({
  init: vi.fn(() => ({ setOption, resize, dispose, getDataURL, on: vi.fn() })),
}));

import * as echarts from 'echarts';
import { EChart, type EChartHandle } from '../EChart';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
});
