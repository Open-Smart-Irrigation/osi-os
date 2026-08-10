// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Banner } from '../Banner';
import { FormField, INPUT_CLASS } from '../FormField';
import { Modal } from '../Modal';

afterEach(cleanup);

describe('Modal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <Modal isOpen={false} title="Create zone" onClose={() => {}}>body</Modal>,
    );
    expect(container.innerHTML).toBe('');
  });
  it('renders a labelled dialog with a close control', () => {
    const onClose = vi.fn();
    render(<Modal isOpen title="Create zone" onClose={onClose}>body</Modal>);
    expect(screen.getByRole('dialog', { name: 'Create zone' })).toBeTruthy();
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  // P0 (adversarial design review): a modal whose content is taller than the
  // viewport has no way to scroll to it, so a long activity-template journal
  // form pushes Save off-screen and unreachable on the phones farmers use in
  // the field. The dialog itself must be the scroll container (not just the
  // page) and must be bounded to the *visual* viewport (dvh, not vh/%) so a
  // mobile browser's address bar / keyboard chrome doesn't reintroduce the
  // same cutoff.
  it('bounds the dialog to the viewport and makes it scrollable so a tall form keeps its last control reachable', () => {
    render(
      <Modal isOpen title="Log activity" onClose={() => {}}>
        <div style={{ height: '4000px' }}>tall template content</div>
        <button type="button">Save</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Log activity' });
    // Bounded to the visual viewport height (dvh accounts for mobile browser
    // chrome), not a fixed pixel value and not a bare vh/% that ignores it.
    expect(dialog.className).toMatch(/max-h-\[[^\]]*dvh[^\]]*\]/);
    // The dialog scrolls its own content when it overflows...
    expect(dialog.className).toMatch(/overflow-y-(auto|scroll)/);
    // ...and the primary action stays inside that same scroll container
    // (not clipped by a non-scrolling ancestor).
    const save = screen.getByRole('button', { name: 'Save' });
    expect(dialog.contains(save)).toBe(true);
  });
});

describe('Banner', () => {
  it('uses the warn tokens and a status role by default', () => {
    render(<Banner>Restarting</Banner>);
    expect(screen.getByRole('status').className).toContain('bg-[var(--warn-bg)]');
  });
  it('uses the error tokens and an alert role for tone="error"', () => {
    render(<Banner tone="error">Failed</Banner>);
    expect(screen.getByRole('alert').className).toContain('bg-[var(--error-bg)]');
  });
  it('declares its politeness level explicitly', () => {
    render(<Banner>Restarting</Banner>);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    cleanup();
    render(<Banner tone="error">Failed</Banner>);
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');
  });
});

describe('FormField', () => {
  it('associates the label with the field content', () => {
    render(
      <FormField id="zone-name" label="Zone name">
        <input id="zone-name" className={INPUT_CLASS} />
      </FormField>,
    );
    expect(screen.getByLabelText('Zone name').className).toContain('touch-target');
  });
});
