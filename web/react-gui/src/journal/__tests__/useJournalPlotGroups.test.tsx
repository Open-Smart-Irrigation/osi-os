import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  JournalPlotGroupWritePayload,
  PlotGroup,
} from '../../types/journal';

const { listPlotGroups, createPlotGroup, updatePlotGroup } = vi.hoisted(() => ({
  listPlotGroups: vi.fn(),
  createPlotGroup: vi.fn(),
  updatePlotGroup: vi.fn(),
}));

vi.mock('../../services/journalApi', () => ({
  journalApi: { listPlotGroups, createPlotGroup, updatePlotGroup },
}));

import { useJournalPlotGroups } from '../useJournalPlotGroups';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalPlotGroups', () => {
  beforeEach(() => {
    listPlotGroups.mockReset();
    createPlotGroup.mockReset();
    updatePlotGroup.mockReset();
  });

  it('does not fetch while disabled', () => {
    renderHook(() => useJournalPlotGroups(false), { wrapper });

    expect(listPlotGroups).not.toHaveBeenCalled();
  });

  it('distinguishes initial loading from a read error and retries it', async () => {
    let resolveRead!: (groups: PlotGroup[]) => void;
    listPlotGroups.mockReturnValueOnce(new Promise<PlotGroup[]>((resolve) => {
      resolveRead = resolve;
    }));
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.mutationError).toBeNull();

    resolveRead([]);
    const failure = new Error('offline');
    listPlotGroups.mockRejectedValueOnce(failure);
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBe(failure));

    listPlotGroups.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(listPlotGroups).toHaveBeenCalledTimes(3);
  });

  it('exposes a failed initial read separately from an empty group result', async () => {
    const failure = new Error('offline');
    listPlotGroups.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.loading).toBe(false);
    expect(result.current.mutationError).toBeNull();
    expect(result.current.groups).toEqual([]);
  });

  it('keeps resolved groups in raw groups while exposing only unresolved groups as active', async () => {
    const active = { group_uuid: 'g1', label: 'Active', resolved_at: null } as PlotGroup;
    const resolved = {
      group_uuid: 'g2',
      label: 'Resolved',
      resolved_at: '2026-07-17T10:00:00Z',
    } as PlotGroup;
    listPlotGroups.mockResolvedValueOnce([active, resolved]);
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups).toEqual([active, resolved]);
    expect(result.current.activeGroups).toEqual([active]);
    expect(result.current.resolvedGroups).toEqual([resolved]);
  });

  it('awaits create before revalidating and returns the server group', async () => {
    const initial = [{ group_uuid: 'g1', label: 'Active', resolved_at: null }] as PlotGroup[];
    const serverGroup = {
      group_uuid: 'g2',
      label: 'New group',
      resolved_at: null,
    } as PlotGroup;
    const refreshed = [initial[0], serverGroup];
    const payload = {
      group_uuid: 'g2',
      base_sync_version: 0,
      label: 'New group',
      members: [],
      resolved: false,
    } as JournalPlotGroupWritePayload;
    let resolveCreate!: (group: PlotGroup) => void;
    let resolveRefresh!: (groups: PlotGroup[]) => void;
    listPlotGroups
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise<PlotGroup[]>((resolve) => {
        resolveRefresh = resolve;
      }));
    createPlotGroup.mockReturnValueOnce(new Promise<PlotGroup>((resolve) => {
      resolveCreate = resolve;
    }));
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let mutation!: Promise<PlotGroup>;
    await act(async () => {
      mutation = result.current.createPlotGroup(payload);
      await Promise.resolve();
    });
    expect(listPlotGroups).toHaveBeenCalledTimes(1);
    expect(result.current.groups).toEqual(initial);

    let settled = false;
    void mutation.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    resolveCreate(serverGroup);
    await waitFor(() => expect(listPlotGroups).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    resolveRefresh(refreshed);
    await act(async () => {
      await expect(mutation).resolves.toEqual(serverGroup);
    });
    expect(listPlotGroups).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.groups).toEqual(refreshed));
  });

  it('does not claim a canonical group before the create response', async () => {
    const initial = [{ group_uuid: 'g1', label: 'Active', resolved_at: null }] as PlotGroup[];
    const serverGroup = {
      group_uuid: 'g2',
      label: 'New group',
      resolved_at: null,
    } as PlotGroup;
    const payload = {
      group_uuid: 'g2',
      base_sync_version: 0,
      label: 'New group',
      members: [],
      resolved: false,
    } as JournalPlotGroupWritePayload;
    let resolveCreate!: (group: PlotGroup) => void;
    listPlotGroups.mockResolvedValueOnce(initial).mockResolvedValueOnce([serverGroup]);
    createPlotGroup.mockReturnValueOnce(new Promise<PlotGroup>((resolve) => {
      resolveCreate = resolve;
    }));
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let mutation!: Promise<PlotGroup>;
    await act(async () => {
      mutation = result.current.createPlotGroup(payload);
      await Promise.resolve();
    });
    expect(result.current.groups).toEqual(initial);
    expect(result.current.groups).not.toContain(serverGroup);

    resolveCreate(serverGroup);
    await act(async () => {
      await mutation;
    });
  });

  it('awaits update before revalidating and returns the server group', async () => {
    const initial = [{ group_uuid: 'g1', label: 'Active', resolved_at: null }] as PlotGroup[];
    const serverGroup = {
      group_uuid: 'g1',
      label: 'Renamed',
      resolved_at: null,
    } as PlotGroup;
    const payload = {
      group_uuid: 'g1',
      base_sync_version: 1,
      label: 'Renamed',
      members: [],
      resolved: false,
    } as JournalPlotGroupWritePayload;
    let resolveUpdate!: (group: PlotGroup) => void;
    let resolveRefresh!: (groups: PlotGroup[]) => void;
    listPlotGroups
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise<PlotGroup[]>((resolve) => {
        resolveRefresh = resolve;
      }));
    updatePlotGroup.mockReturnValueOnce(new Promise<PlotGroup>((resolve) => {
      resolveUpdate = resolve;
    }));
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let mutation!: Promise<PlotGroup>;
    await act(async () => {
      mutation = result.current.updatePlotGroup('g1', payload);
      await Promise.resolve();
    });
    expect(listPlotGroups).toHaveBeenCalledTimes(1);
    expect(result.current.groups).toEqual(initial);

    let settled = false;
    void mutation.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    resolveUpdate(serverGroup);
    await waitFor(() => expect(listPlotGroups).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    resolveRefresh([serverGroup]);
    await act(async () => {
      await expect(mutation).resolves.toEqual(serverGroup);
    });
    expect(listPlotGroups).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.groups).toEqual([serverGroup]));
  });

  it('keeps a rejected create refresh as a read error', async () => {
    const initial = [{ group_uuid: 'g1', label: 'Active', resolved_at: null }] as PlotGroup[];
    const serverGroup = {
      group_uuid: 'g2',
      label: 'New group',
      resolved_at: null,
    } as PlotGroup;
    const payload = {
      group_uuid: 'g2',
      base_sync_version: 0,
      label: 'New group',
      members: [],
      resolved: false,
    } as JournalPlotGroupWritePayload;
    const refreshFailure = new Error('refresh failed');
    listPlotGroups
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(refreshFailure);
    createPlotGroup.mockResolvedValueOnce(serverGroup);
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.createPlotGroup(payload)).resolves.toEqual(serverGroup);
    });
    expect(result.current.mutationError).toBeNull();
    expect(result.current.error).toBe(refreshFailure);
  });

  it('keeps a rejected update refresh as a read error', async () => {
    const initial = [{ group_uuid: 'g1', label: 'Active', resolved_at: null }] as PlotGroup[];
    const serverGroup = {
      group_uuid: 'g1',
      label: 'Renamed',
      resolved_at: null,
    } as PlotGroup;
    const payload = {
      group_uuid: 'g1',
      base_sync_version: 1,
      label: 'Renamed',
      members: [],
      resolved: false,
    } as JournalPlotGroupWritePayload;
    const refreshFailure = new Error('refresh failed');
    listPlotGroups
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(refreshFailure);
    updatePlotGroup.mockResolvedValueOnce(serverGroup);
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.updatePlotGroup('g1', payload)).resolves.toEqual(serverGroup);
    });
    expect(result.current.mutationError).toBeNull();
    expect(result.current.error).toBe(refreshFailure);
  });

  it('surfaces and rethrows mutation errors while clearing stale errors', async () => {
    const initial = [{ group_uuid: 'g1', label: 'Active', resolved_at: null }] as PlotGroup[];
    const serverGroup = { group_uuid: 'g1', label: 'Renamed', resolved_at: null } as PlotGroup;
    const payload = {
      group_uuid: 'g1',
      base_sync_version: 1,
      label: 'Renamed',
      members: [],
      resolved: false,
    } as JournalPlotGroupWritePayload;
    const failure = new Error('save failed');
    listPlotGroups.mockResolvedValueOnce(initial).mockResolvedValueOnce([serverGroup]);
    createPlotGroup.mockRejectedValueOnce(failure).mockResolvedValueOnce(serverGroup);
    const { result } = renderHook(() => useJournalPlotGroups(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.createPlotGroup(payload)).rejects.toBe(failure);
    });
    await waitFor(() => expect(result.current.mutationError).toBe(failure));

    await act(async () => {
      await expect(result.current.createPlotGroup(payload)).resolves.toEqual(serverGroup);
    });
    await waitFor(() => expect(result.current.mutationError).toBeNull());
  });
});
