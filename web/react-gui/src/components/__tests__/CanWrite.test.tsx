import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanWrite } from '../CanWrite';

const scopeState = vi.hoisted(() => ({
  loading: false,
  canWrite: true,
  isScoped: true,
  zoneWritable: vi.fn<(zoneUuid: string) => boolean>(() => true),
}));

vi.mock('../../contexts/ScopeContext', () => ({
  useScope: () => scopeState,
}));

describe('CanWrite', () => {
  beforeEach(() => {
    scopeState.loading = false;
    scopeState.canWrite = true;
    scopeState.isScoped = true;
    scopeState.zoneWritable.mockClear();
    scopeState.zoneWritable.mockReturnValue(true);
  });

  it('does not flash mutation controls while scope is loading', () => {
    scopeState.loading = true;
    render(<CanWrite><button type="button">Save</button></CanWrite>);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('hides writes from viewers and from zones outside the write scope', () => {
    scopeState.canWrite = false;
    const { rerender } = render(
      <CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    scopeState.canWrite = true;
    scopeState.zoneWritable.mockReturnValue(false);
    rerender(<CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders writable zones and stays open when the write scope is a wildcard', () => {
    const { rerender } = render(
      <CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    scopeState.isScoped = false;
    scopeState.zoneWritable.mockReturnValue(true);
    rerender(<CanWrite zoneUuid="zone-foreign"><button type="button">Save</button></CanWrite>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('renders unscoped children when no zone is named', () => {
    scopeState.zoneWritable.mockReturnValue(false);
    render(<CanWrite><button type="button">Save</button></CanWrite>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(scopeState.zoneWritable).not.toHaveBeenCalled();
  });
});
