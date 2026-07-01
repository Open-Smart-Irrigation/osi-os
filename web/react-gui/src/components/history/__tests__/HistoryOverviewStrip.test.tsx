import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HistoryOverviewStrip } from '../desktop/HistoryOverviewStrip';

describe('HistoryOverviewStrip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clamps invalid viewport percentages into the visible overview range', () => {
    render(
      <HistoryOverviewStrip
        bounds={{ minMs: 100, maxMs: 200 }}
        viewport={{ fromMs: 0, toMs: 300 }}
        onChange={vi.fn()}
      />,
    );

    const window = screen.getByTestId('overview-window');
    expect(window.style.left).toBe('0%');
    expect(window.style.width).toBe('100%');
  });

  it('coalesces drag panning into one viewport update per animation frame', () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const onChange = vi.fn();

    render(
      <HistoryOverviewStrip
        bounds={{ minMs: 0, maxMs: 1_000_000 }}
        viewport={{ fromMs: 200_000, toMs: 600_000 }}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('group');
    Object.defineProperty(group, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, width: 1_000, top: 0, height: 36, right: 1_000, bottom: 36, x: 0, y: 0, toJSON: () => ({}) }),
    });

    fireEvent.mouseDown(screen.getByTestId('overview-window'), { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 150 });
    fireEvent.mouseMove(window, { clientX: 200 });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      frame?.(0);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ fromMs: 300_000, toMs: 700_000 });
  });
});
