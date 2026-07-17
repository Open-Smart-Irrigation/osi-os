import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalPlot, JournalPlotWritePayload } from '../../types/journal';

const { listPlots, createPlot, updatePlot } = vi.hoisted(() => ({
  listPlots: vi.fn(),
  createPlot: vi.fn(),
  updatePlot: vi.fn(),
}));

vi.mock('../../services/journalApi', () => ({
  journalApi: { listPlots, createPlot, updatePlot },
}));

import { useJournalPlots } from '../useJournalPlots';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalPlots', () => {
  beforeEach(() => {
    listPlots.mockReset();
    createPlot.mockReset();
    updatePlot.mockReset();
  });

  it('does not fetch when disabled', () => {
    renderHook(() => useJournalPlots(false), { wrapper });

    expect(listPlots).not.toHaveBeenCalled();
  });

  it('returns plots when enabled', async () => {
    const plots = [{ plot_uuid: 'p1', plot_code: 'N-1' }];
    listPlots.mockResolvedValue(plots);

    const { result } = renderHook(() => useJournalPlots(true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.plots).toEqual(plots);
    expect(result.current.error).toBeNull();
    expect(result.current.mutationError).toBeNull();
  });

  it('distinguishes initial loading from a read error and retries it', async () => {
    let resolveRead!: (plots: JournalPlot[]) => void;
    listPlots.mockReturnValueOnce(new Promise<JournalPlot[]>((resolve) => {
      resolveRead = resolve;
    }));
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.mutationError).toBeNull();

    const failure = new Error('offline');
    resolveRead([]);
    listPlots.mockRejectedValueOnce(failure);
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.mutationError).toBeNull();

    listPlots.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(listPlots).toHaveBeenCalledTimes(3);
  });

  it('exposes a failed initial read separately from an empty result', async () => {
    const failure = new Error('offline');
    listPlots.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.plots).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.mutationError).toBeNull();
  });

  it('awaits create before revalidating and returns the server plot', async () => {
    const initial = [{ plot_uuid: 'p1', plot_code: 'N-1' }] as JournalPlot[];
    const serverPlot = { plot_uuid: 'p2', plot_code: 'N-2' } as JournalPlot;
    const refreshed = [initial[0], serverPlot];
    const payload = { plot_uuid: 'p2', plot_code: 'N-2' } as JournalPlotWritePayload;
    let resolveCreate!: (plot: JournalPlot) => void;
    let resolveRefresh!: (plots: JournalPlot[]) => void;
    listPlots
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise<JournalPlot[]>((resolve) => {
        resolveRefresh = resolve;
      }));
    createPlot.mockReturnValueOnce(new Promise<JournalPlot>((resolve) => {
      resolveCreate = resolve;
    }));
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let mutation!: Promise<JournalPlot>;
    await act(async () => {
      mutation = result.current.createPlot(payload);
      await Promise.resolve();
    });
    expect(listPlots).toHaveBeenCalledTimes(1);
    expect(result.current.plots).toEqual(initial);

    let settled = false;
    void mutation.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    resolveCreate(serverPlot);
    await waitFor(() => expect(listPlots).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    resolveRefresh(refreshed);
    await act(async () => {
      await expect(mutation).resolves.toEqual(serverPlot);
    });
    expect(listPlots).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.plots).toEqual(refreshed));
    expect(createPlot).toHaveBeenCalledWith(payload);
  });

  it('does not relabel an overlapping retry failure as a create failure', async () => {
    const initial = [{ plot_uuid: 'p1', plot_code: 'N-1' }] as JournalPlot[];
    const serverPlot = { plot_uuid: 'p2', plot_code: 'N-2' } as JournalPlot;
    const refreshed = [initial[0], serverPlot];
    const payload = { plot_uuid: 'p2', plot_code: 'N-2' } as JournalPlotWritePayload;
    const retryFailure = new Error('manual refresh failed');
    let resolveCreate!: (plot: JournalPlot) => void;
    listPlots
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(retryFailure)
      .mockResolvedValueOnce(refreshed);
    createPlot.mockReturnValueOnce(new Promise<JournalPlot>((resolve) => {
      resolveCreate = resolve;
    }));
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let mutation!: Promise<JournalPlot>;
    await act(async () => {
      mutation = result.current.createPlot(payload);
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBe(retryFailure));
    expect(result.current.mutationError).toBeNull();

    resolveCreate(serverPlot);
    await act(async () => {
      await expect(mutation).resolves.toEqual(serverPlot);
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.plots).toEqual(refreshed);
    expect(result.current.mutationError).toBeNull();
  });

  it('does not claim a canonical plot before the create response', async () => {
    const initial = [{ plot_uuid: 'p1', plot_code: 'N-1' }] as JournalPlot[];
    const serverPlot = { plot_uuid: 'p2', plot_code: 'N-2' } as JournalPlot;
    const payload = { plot_uuid: 'p2', plot_code: 'N-2' } as JournalPlotWritePayload;
    let resolveCreate!: (plot: JournalPlot) => void;
    listPlots.mockResolvedValueOnce(initial).mockResolvedValueOnce([serverPlot]);
    createPlot.mockReturnValueOnce(new Promise<JournalPlot>((resolve) => {
      resolveCreate = resolve;
    }));
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let mutation!: Promise<JournalPlot>;
    await act(async () => {
      mutation = result.current.createPlot(payload);
      await Promise.resolve();
    });
    expect(result.current.plots).toEqual(initial);
    expect(result.current.plots).not.toContain(serverPlot);

    resolveCreate(serverPlot);
    await act(async () => {
      await mutation;
    });
  });

  it('awaits update before revalidating and returns the server plot', async () => {
    const initial = [{ plot_uuid: 'p1', plot_code: 'N-1' }] as JournalPlot[];
    const serverPlot = { plot_uuid: 'p1', plot_code: 'N-1-renamed' } as JournalPlot;
    const payload = { plot_uuid: 'p1', plot_code: 'N-1-renamed' } as JournalPlotWritePayload;
    let resolveUpdate!: (plot: JournalPlot) => void;
    let resolveRefresh!: (plots: JournalPlot[]) => void;
    listPlots
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise<JournalPlot[]>((resolve) => {
        resolveRefresh = resolve;
      }));
    updatePlot.mockReturnValueOnce(new Promise<JournalPlot>((resolve) => {
      resolveUpdate = resolve;
    }));
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let mutation!: Promise<JournalPlot>;
    await act(async () => {
      mutation = result.current.updatePlot('p1', payload);
      await Promise.resolve();
    });
    expect(listPlots).toHaveBeenCalledTimes(1);
    expect(result.current.plots).toEqual(initial);

    let settled = false;
    void mutation.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    resolveUpdate(serverPlot);
    await waitFor(() => expect(listPlots).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    resolveRefresh([serverPlot]);
    await act(async () => {
      await expect(mutation).resolves.toEqual(serverPlot);
    });
    expect(listPlots).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.plots).toEqual([serverPlot]));
    expect(updatePlot).toHaveBeenCalledWith('p1', payload);
  });

  it('surfaces API mutation errors but keeps refresh failures as read errors', async () => {
    const initial = [{ plot_uuid: 'p1', plot_code: 'N-1' }] as JournalPlot[];
    const serverPlot = { plot_uuid: 'p1', plot_code: 'N-1-renamed' } as JournalPlot;
    const payload = { plot_uuid: 'p1', plot_code: 'N-1-renamed' } as JournalPlotWritePayload;
    const apiFailure = new Error('save failed');
    const revalidationFailure = new Error('refresh failed');
    let resolveSecondCreate!: (plot: JournalPlot) => void;
    listPlots.mockResolvedValueOnce(initial).mockRejectedValueOnce(revalidationFailure);
    createPlot
      .mockRejectedValueOnce(apiFailure)
      .mockReturnValueOnce(new Promise<JournalPlot>((resolve) => {
        resolveSecondCreate = resolve;
      }));
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.createPlot(payload)).rejects.toBe(apiFailure);
    });
    await waitFor(() => expect(result.current.mutationError).toBe(apiFailure));
    expect(result.current.error).toBeNull();

    let secondMutation!: Promise<JournalPlot>;
    await act(async () => {
      secondMutation = result.current.createPlot(payload);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.mutationError).toBeNull());
    resolveSecondCreate(serverPlot);
    await act(async () => {
      await expect(secondMutation).resolves.toEqual(serverPlot);
    });
    expect(result.current.mutationError).toBeNull();
    expect(result.current.error).toBe(revalidationFailure);
  });
});
