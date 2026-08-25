import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ValveGlyph } from '../ValveGlyph';

// The body path is filled for open/closing and hollow otherwise. Comparing the `d` attribute
// against itself across states is how we pin that without hardcoding 700 characters of path.
function bodyPath(container: HTMLElement): string {
  return container.querySelector('path.valve-glyph__body')?.getAttribute('d') ?? '';
}

describe('ValveGlyph', () => {
  it('fills the valve body only when water is actually flowing', () => {
    const open = render(<ValveGlyph state="open" />);
    const closed = render(<ValveGlyph state="closed" />);
    const closing = render(<ValveGlyph state="closing" />);
    const pending = render(<ValveGlyph state="pending" />);
    const failed = render(<ValveGlyph state="failed" />);

    const filled = bodyPath(open.container);
    const outline = bodyPath(closed.container);
    expect(filled).not.toBe('');
    expect(filled).not.toBe(outline);

    // closing is still passing water, so it stays filled
    expect(bodyPath(closing.container)).toBe(filled);
    // a command the valve has not confirmed, and a plan it never took, must not
    // look like a running valve
    expect(bodyPath(pending.container)).toBe(outline);
    expect(bodyPath(failed.container)).toBe(outline);
  });

  it('draws water for open and closing, and none for the dry states', () => {
    for (const state of ['open', 'closing'] as const) {
      const { container } = render(<ValveGlyph state={state} />);
      expect(container.querySelector('.valve-glyph__water')).toBeInTheDocument();
    }
    for (const state of ['closed', 'pending', 'failed'] as const) {
      const { container } = render(<ValveGlyph state={state} />);
      expect(container.querySelector('.valve-glyph__water')).not.toBeInTheDocument();
    }
  });

  it('animates only a confirmed-open valve', () => {
    // `closing` shows water but must not animate — the run is already over, and moving water
    // would claim otherwise.
    const closing = render(<ValveGlyph state="closing" />);
    expect(closing.container.querySelector('.valve-glyph')).toHaveClass('valve-glyph--static');

    const open = render(<ValveGlyph state="open" />);
    expect(open.container.querySelector('.valve-glyph')).not.toHaveClass('valve-glyph--static');
  });

  it('does not animate when reducedMotion is set', () => {
    const { container } = render(<ValveGlyph state="open" reducedMotion />);
    expect(container.querySelector('.valve-glyph')).toHaveClass('valve-glyph--static');
    // the water itself is still drawn — a dry outlet on an open valve would be wrong
    expect(container.querySelector('.valve-glyph__water')).toBeInTheDocument();
  });

  it('keeps each droplet\'s static offset in cx/cy, never in a transform attribute', () => {
    const { container } = render(<ValveGlyph state="open" />);
    const drops = container.querySelectorAll('.valve-glyph__drop');
    expect(drops).toHaveLength(3);

    // Regression guard, carried over from the previous glyph: the drop keyframes set
    // `transform` in CSS, and a CSS transform REPLACES an SVG transform attribute rather than
    // composing with it. Any static offset placed in a transform attribute is therefore
    // destroyed the moment the animation runs, collapsing all three drops onto one point.
    drops.forEach((drop) => {
      expect(drop.getAttribute('transform')).toBeNull();
      const circle = drop.querySelector('circle');
      expect(circle?.getAttribute('cx')).toBeTruthy();
      expect(circle?.getAttribute('cy')).toBeTruthy();
    });

    // and the three sit at distinct positions
    const xs = [...drops].map((d) => d.querySelector('circle')?.getAttribute('cx'));
    expect(new Set(xs).size).toBe(3);
  });

  it('never renders a countdown ring, in any state, including while open (the ring was removed; only the textual countdown remains)', () => {
    for (const state of ['closed', 'pending', 'open', 'closing', 'failed'] as const) {
      const { container } = render(<ValveGlyph state={state} />);
      expect(container.querySelector('.valve-glyph__ring')).not.toBeInTheDocument();
      expect(container.querySelector('circle[stroke-dasharray]')).not.toBeInTheDocument();
    }
  });

  it('shows exactly one status badge, and only for the states that have one', () => {
    const cases: Array<['pending' | 'closing' | 'failed', string]> = [
      ['pending', '.valve-glyph__badge--pending'],
      ['closing', '.valve-glyph__badge--closing'],
      ['failed', '.valve-glyph__badge--failed'],
    ];
    for (const [state, selector] of cases) {
      const { container } = render(<ValveGlyph state={state} />);
      expect(container.querySelectorAll('.valve-glyph__badge')).toHaveLength(1);
      expect(container.querySelector(selector)).toBeInTheDocument();
    }
    for (const state of ['open', 'closed'] as const) {
      const { container } = render(<ValveGlyph state={state} />);
      expect(container.querySelectorAll('.valve-glyph__badge')).toHaveLength(0);
    }
  });

  it('is decorative: the accessible name comes from the tile, not the glyph', () => {
    const { container } = render(<ValveGlyph state="open" />);
    expect(container.querySelector('.valve-glyph')).toHaveAttribute('aria-hidden', 'true');
  });
});
