import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { TimelineBrush } from '../TimelineBrush';
import { createDefaultTimeViewport, zoomTimeViewport } from '../../../history/useTimeViewport';

afterEach(() => {
  vi.useRealTimers();
});

describe('TimelineBrush', () => {
  it('keeps zoomed-out ranges from ending after now while preserving duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T12:00:00Z'));
    const viewport = createDefaultTimeViewport('24h', new Date('2026-05-31T12:00:00Z'));

    const zoomed = zoomTimeViewport(viewport, 100);

    expect(zoomed.range.to).toBe('2026-05-31T12:00:00.000Z');
    expect(zoomed.range.from).toBe('2026-05-29T12:00:00.000Z');
    expect(zoomed.aggregation).toBe('auto');
    expect(Date.parse(zoomed.range.to ?? '') - Date.parse(zoomed.range.from ?? '')).toBe(48 * 60 * 60 * 1000);
  });

  it('changes the viewport on wheel inside the timeline only', () => {
    const onViewportChange = vi.fn();
    const viewport = createDefaultTimeViewport('24h', new Date('2026-05-31T12:00:00Z'));

    render(
      <div data-testid="outside">
        <TimelineBrush
          viewport={viewport}
          defaultRange="24h"
          onViewportChange={onViewportChange}
          ariaLabel="Timeline viewport"
        />
      </div>,
    );

    fireEvent.wheel(screen.getByTestId('outside'), { deltaY: -100 });
    expect(onViewportChange).not.toHaveBeenCalled();

    fireEvent.wheel(screen.getByRole('region', { name: 'Timeline viewport' }), { deltaY: -100 });
    expect(onViewportChange).toHaveBeenCalledTimes(1);
    expect(onViewportChange.mock.calls[0][0].range.label).toBe('custom');
    expect(onViewportChange.mock.calls[0][0].aggregation).toBe('auto');
  });

  it('resets to the card default range on double click and double tap', () => {
    const onViewportChange = vi.fn();
    const viewport = {
      ...createDefaultTimeViewport('24h', new Date('2026-05-31T12:00:00Z')),
      range: {
        mode: 'absolute' as const,
        label: 'custom' as const,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T12:00:00.000Z',
        timezone: 'UTC',
      },
    };

    render(
      <TimelineBrush
        viewport={viewport}
        defaultRange="7d"
        onViewportChange={onViewportChange}
        ariaLabel="Timeline viewport"
      />,
    );

    const timeline = screen.getByRole('region', { name: 'Timeline viewport' });
    fireEvent.doubleClick(timeline);
    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: '7d', mode: 'relative' }),
      }),
    );

    fireEvent.touchEnd(timeline);
    fireEvent.touchEnd(timeline);
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: '7d', mode: 'relative' }),
      }),
    );
  });

  it('supports keyboard pan, zoom, and reset controls with accessible instructions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T12:00:00Z'));
    const onViewportChange = vi.fn();
    const viewport = createDefaultTimeViewport('24h', new Date('2026-05-31T12:00:00Z'));

    render(
      <TimelineBrush
        viewport={viewport}
        defaultRange="7d"
        onViewportChange={onViewportChange}
        ariaLabel="Timeline viewport"
        keyboardHelp="Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset."
      />,
    );

    const timeline = screen.getByRole('region', { name: 'Timeline viewport' });
    expect(timeline).toHaveAccessibleDescription(
      'Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset.',
    );

    fireEvent.keyDown(timeline, { key: 'ArrowLeft' });
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({
          label: 'custom',
          from: '2026-05-30T06:00:00.000Z',
          to: '2026-05-31T06:00:00.000Z',
        }),
      }),
    );

    fireEvent.keyDown(timeline, { key: '=' });
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({
          from: '2026-05-30T18:00:00.000Z',
          to: '2026-05-31T06:00:00.000Z',
        }),
      }),
    );

    fireEvent.keyDown(timeline, { key: '-' });
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({
          from: '2026-05-29T12:00:00.000Z',
          to: '2026-05-31T12:00:00.000Z',
        }),
      }),
    );

    fireEvent.keyDown(timeline, { key: 'Enter' });
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: '7d', mode: 'relative' }),
      }),
    );
  });
});
