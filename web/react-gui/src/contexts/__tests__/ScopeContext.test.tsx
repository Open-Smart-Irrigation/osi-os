import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchScopeProfile } from '../../services/api';
import { ScopeProvider, useScope } from '../ScopeContext';

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ token: 'scope-test-token' }),
}));

vi.mock('../../services/api', () => ({
  fetchScopeProfile: vi.fn(),
}));

const mockedFetchScopeProfile = vi.mocked(fetchScopeProfile);

describe('ScopeContext', () => {
  beforeEach(() => {
    mockedFetchScopeProfile.mockReset();
  });

  it('defaults to unscoped while loading and resolves a scoped researcher profile', async () => {
    mockedFetchScopeProfile.mockResolvedValue({
      username: 'researcher',
      user_uuid: 'u-researcher',
      role: 'researcher',
      zone_uuids: ['z-1'],
      plot_uuids: ['p-1'],
      features: { scoped_access: true },
    });

    const { result } = renderHook(() => useScope(), { wrapper: ScopeProvider });

    expect(result.current.loading).toBe(true);
    expect(result.current.isScoped).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('researcher');
    expect(result.current.canWrite).toBe(true);
    expect(result.current.isZoneVisible('z-1')).toBe(true);
    expect(result.current.isZoneVisible('z-foreign')).toBe(false);
    expect(result.current.isPlotVisible('p-1')).toBe(true);
    expect(result.current.isPlotVisible('p-foreign')).toBe(false);
  });

  it('treats a flag-off profile as a writable wildcard', async () => {
    mockedFetchScopeProfile.mockResolvedValue({
      username: 'admin',
      user_uuid: 'u-admin',
      role: 'admin',
      zone_uuids: null,
      plot_uuids: null,
      features: { scoped_access: false },
    });

    const { result } = renderHook(() => useScope(), { wrapper: ScopeProvider });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isScoped).toBe(false);
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.canWrite).toBe(true);
    expect(result.current.isZoneVisible('any-zone')).toBe(true);
    expect(result.current.isPlotVisible('any-plot')).toBe(true);
  });
});
