// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useElementSize } from '../useElementSize';

type Callback = (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
let lastCallback: Callback | null = null;
let disconnected = 0;

class ResizeObserverStub {
  constructor(callback: Callback) { lastCallback = callback; }
  observe() {}
  unobserve() {}
  disconnect() { disconnected += 1; }
}

function Probe() {
  const [ref, size] = useElementSize<HTMLDivElement>();
  return <div ref={ref} data-testid="probe">{size ? `${size.width}x${size.height}` : 'unmeasured'}</div>;
}

afterEach(() => {
  cleanup();
  lastCallback = null;
  disconnected = 0;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

describe('useElementSize', () => {
  it('reports the observed content size, rounded to whole pixels', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('unmeasured');
    act(() => lastCallback?.([{ contentRect: { width: 389.6, height: 360.2 } }]));
    expect(screen.getByTestId('probe')).toHaveTextContent('390x360');
  });

  it('ignores a zero-width measurement (hidden or detached element)', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    render(<Probe />);
    act(() => lastCallback?.([{ contentRect: { width: 0, height: 0 } }]));
    expect(screen.getByTestId('probe')).toHaveTextContent('unmeasured');
  });

  it('disconnects on unmount', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    const { unmount } = render(<Probe />);
    unmount();
    expect(disconnected).toBe(1);
  });

  it('stays unmeasured without ResizeObserver', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('unmeasured');
  });
});
