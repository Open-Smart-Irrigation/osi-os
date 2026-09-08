import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type { CaptureSaveState } from '../../../../journal/useCaptureDraft';
import { SaveState } from '../../capture/SaveState';

describe('SaveState', () => {
  it.each([
    ['saving', 'capture.save.saving'],
    ['draft-saved-gateway', 'capture.save.draftSavedGateway'],
    ['final-saved-gateway', 'capture.save.finalSavedGateway'],
    ['cloud-waiting', 'capture.save.cloudWaiting'],
    ['not-saved', 'capture.save.notSaved'],
  ] satisfies Array<[CaptureSaveState, string]>)('renders %s with its semantic status', (status, key) => {
    render(<SaveState status={status} />);

    const element = screen.getByRole('status');
    expect(element).toHaveTextContent(key);
    expect(element).toHaveAttribute('aria-live', 'polite');
  });

  it('offers an accessible retry action only for an unsaved state', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<SaveState status="not-saved" onRetry={onRetry} />);

    const retry = screen.getByRole('button', { name: 'capture.save.retry' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<SaveState status="saving" onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: 'capture.save.retry' })).not.toBeInTheDocument();
  });

  it('keeps the retry control outside the atomic live status region', () => {
    render(<SaveState status="not-saved" onRetry={vi.fn()} />);

    const status = screen.getByRole('status');
    const retry = screen.getByRole('button', { name: 'capture.save.retry' });
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).not.toContainElement(retry);
  });

  it('contains a rejected async retry and keeps the visible not-saved outcome', async () => {
    let rejectRetry!: (reason?: unknown) => void;
    const retryPromise = new Promise<void>((_resolve, reject) => {
      rejectRetry = reject;
    });
    const catchRetry = vi.spyOn(retryPromise, 'catch');
    const onRetry = vi.fn().mockReturnValue(retryPromise);
    render(<SaveState status="not-saved" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: 'capture.save.retry' }));
    expect(catchRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectRetry(new Error('retry failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('capture.save.notSaved');
  });

  it('renders the sticky loss warning as an alert without inventing cloud-pending state', () => {
    render(<SaveState status="not-saved" lossWarning />);

    expect(screen.getByRole('alert')).toHaveTextContent('capture.save.lossWarning');
    expect(screen.queryByText('capture.save.cloudWaiting')).not.toBeInTheDocument();
  });

  it('does not claim cloud waiting unless that state is explicitly supplied', () => {
    render(<SaveState status="final-saved-gateway" />);
    expect(screen.queryByText('capture.save.cloudWaiting')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('capture.save.finalSavedGateway');
  });
});
