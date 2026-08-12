import { act, renderHook, waitFor } from '@testing-library/react';
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

  it('fails closed without a provider', () => {
    const { result } = renderHook(() => useScope());

    expect(result.current.canWrite).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.zoneWritable('any-zone')).toBe(false);
    expect('isZoneVisible' in result.current).toBe(false);
    expect('isPlotVisible' in result.current).toBe(false);
  });

  it('fails closed while loading and resolves a scoped researcher profile', async () => {
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
    expect(result.current.canWrite).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.zoneWritable('z-1')).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('researcher');
    expect(result.current.canWrite).toBe(true);
    expect(result.current.zoneWritable('z-1')).toBe(true);
    expect(result.current.zoneWritable('z-foreign')).toBe(false);
  });

  it('keeps a rejected lookup closed and retries without exposing authority', async () => {
    mockedFetchScopeProfile
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        username: 'admin',
        user_uuid: 'u-admin',
        role: 'admin',
        zone_uuids: null,
        plot_uuids: null,
        features: { scoped_access: false },
      });

    const { result } = renderHook(() => useScope(), { wrapper: ScopeProvider });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loading).toBe(false);
    expect(result.current.canWrite).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.zoneWritable('any-zone')).toBe(false);

    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    expect(result.current.canWrite).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.zoneWritable('any-zone')).toBe(false);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.canWrite).toBe(true);
    expect(result.current.isAdmin).toBe(true);
  });

  it('keeps a never-resolving lookup closed', () => {
    mockedFetchScopeProfile.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useScope(), { wrapper: ScopeProvider });

    expect(result.current.loading).toBe(true);
    expect(result.current.canWrite).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.zoneWritable('any-zone')).toBe(false);
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
    expect(result.current.zoneWritable('any-zone')).toBe(true);
  });
});
