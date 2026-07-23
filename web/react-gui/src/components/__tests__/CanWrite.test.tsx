import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanWrite } from '../CanWrite';

const scopeState = vi.hoisted(() => ({
  loading: false,
  canWrite: true,
  isScoped: true,
  isZoneVisible: vi.fn<(zoneUuid: string) => boolean>(() => true),
}));

vi.mock('../../contexts/ScopeContext', () => ({
  useScope: () => scopeState,
}));

describe('CanWrite', () => {
  beforeEach(() => {
    scopeState.loading = false;
    scopeState.canWrite = true;
    scopeState.isScoped = true;
    scopeState.isZoneVisible.mockReturnValue(true);
  });

  it('does not flash mutation controls while scope is loading', () => {
    scopeState.loading = true;
    render(<CanWrite><button type="button">Save</button></CanWrite>);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('hides writes from viewers and out-of-scope researchers', () => {
    scopeState.canWrite = false;
    const { rerender } = render(
      <CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    scopeState.canWrite = true;
    scopeState.isZoneVisible.mockReturnValue(false);
    rerender(<CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders in-scope writes and preserves flag-off behavior', () => {
    const { rerender } = render(
      <CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    scopeState.isScoped = false;
    scopeState.isZoneVisible.mockReturnValue(false);
    rerender(<CanWrite zoneUuid="zone-foreign"><button type="button">Save</button></CanWrite>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
