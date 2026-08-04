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
