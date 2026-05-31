import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

import { TimelineBrush } from '../TimelineBrush';
import { createDefaultTimeViewport } from '../../../history/useTimeViewport';

describe('TimelineBrush', () => {
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
});
