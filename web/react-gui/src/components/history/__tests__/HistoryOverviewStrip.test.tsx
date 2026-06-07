import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HistoryOverviewStrip } from '../desktop/HistoryOverviewStrip';

describe('HistoryOverviewStrip', () => {
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
});
