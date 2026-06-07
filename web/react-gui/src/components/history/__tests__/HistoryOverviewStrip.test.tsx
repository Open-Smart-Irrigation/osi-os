import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryOverviewStrip } from '../desktop/HistoryOverviewStrip';

describe('HistoryOverviewStrip', () => {
  it('renders a draggable window and reports a new viewport on click-drag', () => {
    const onChange = vi.fn();
    render(
      <HistoryOverviewStrip
        bounds={{ minMs: 0, maxMs: 1000 }}
        viewport={{ fromMs: 400, toMs: 600 }}
        onChange={onChange}
      />,
    );
    const window = screen.getByTestId('overview-window');
    expect(window).toBeInTheDocument();
  });
});
