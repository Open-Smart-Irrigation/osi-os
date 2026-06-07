import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryOverviewStrip } from '../desktop/HistoryOverviewStrip';

describe('HistoryOverviewStrip', () => {
  it('renders a draggable window', () => {
    render(<HistoryOverviewStrip bounds={{ minMs: 0, maxMs: 1000 }} viewport={{ fromMs: 400, toMs: 600 }} onChange={() => {}} />);
    expect(screen.getByTestId('overview-window')).toBeInTheDocument();
  });

  it('reports a panned viewport when the window is dragged right', () => {
    const onChange = vi.fn();
    const { container } = render(
      <HistoryOverviewStrip bounds={{ minMs: 0, maxMs: 1000 }} viewport={{ fromMs: 400, toMs: 600 }} onChange={onChange} />,
    );
    const strip = container.querySelector('[role="group"]') as HTMLElement;
    // jsdom returns 0-size rects; stub a real width so deltaMs is finite
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ width: 1000, left: 0, right: 1000, top: 0, bottom: 9, height: 9, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const win = screen.getByTestId('overview-window');
    fireEvent.mouseDown(win, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 200 }); // +100px of 1000px width = +100ms over total 1000
    expect(onChange).toHaveBeenCalled();
    const arg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(arg.fromMs).toBeGreaterThan(400); // dragged right ⇒ window moves later
    fireEvent.mouseUp(window);
  });
});
