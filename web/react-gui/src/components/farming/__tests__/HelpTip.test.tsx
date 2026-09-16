import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { HelpTip } from '../shared/HelpTip';

afterEach(cleanup);

describe('HelpTip', () => {
  it('starts closed and names itself for assistive technology', () => {
    render(<HelpTip label="About 5V warm-up time">Delays sampling.</HelpTip>);

    const toggle = screen.getByRole('button', { name: 'About 5V warm-up time' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('opens and closes on activation, which covers both tap and keyboard', () => {
    render(<HelpTip label="About advanced device settings">Only external sensors need these.</HelpTip>);
    const toggle = screen.getByRole('button', { name: 'About advanced device settings' });

    fireEvent.click(toggle);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Only external sensors need these.');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', note.id);

    fireEvent.click(toggle);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('is a real button, so Enter and Space reach it without a key handler', () => {
    render(<HelpTip label="About 5V warm-up time">Delays sampling.</HelpTip>);
    const toggle = screen.getByRole('button', { name: 'About 5V warm-up time' });

    // type="button" keeps it out of form submission; the native button element
    // is what makes it keyboard- and touch-reachable, unlike a `title` tooltip.
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('type', 'button');
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
  });
});
