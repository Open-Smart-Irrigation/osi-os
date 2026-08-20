import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ValveGlyph } from '../ValveGlyph';

describe('ValveGlyph droplets', () => {
  it('keeps each droplet\'s static x/y offset on a wrapping <g>, separate from the animated path', () => {
    const { container } = render(<ValveGlyph state="open" progress={0.5} />);
    const drips = container.querySelectorAll('path.valve-drip');
    expect(drips).toHaveLength(3);

    const parentTransforms = Array.from(drips).map((path) => path.parentElement?.getAttribute('transform'));
    // Regression: each droplet's wrapping <g> must carry a distinct transform (its x offset).
    // A CSS `transform` set by the drip keyframes on the <path> itself completely replaces any
    // `transform` *attribute* on that same element rather than composing with it, so the static
    // per-droplet offset must live one level up or all three droplets collapse onto one x position
    // while animating.
    expect(new Set(parentTransforms).size).toBe(3);
    parentTransforms.forEach((t) => expect(t).toBeTruthy());

    // The animated element itself must not carry its own transform attribute.
    drips.forEach((path) => expect(path.getAttribute('transform')).toBeNull());
  });

  it('does not animate droplets when reducedMotion is set', () => {
    const { container } = render(<ValveGlyph state="open" progress={null} reducedMotion />);
    expect(container.querySelectorAll('path.valve-drip')).toHaveLength(0);
  });
});
