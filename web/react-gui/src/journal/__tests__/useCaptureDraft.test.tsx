import { StrictMode, type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateEntryPayload } from '../../services/journalApi';

const { createEntry, updateEntry } = vi.hoisted(() => ({
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
}));

vi.mock('../../services/journalApi', () => ({
  journalApi: { createEntry, updateEntry },
}));

import { useCaptureDraft } from '../useCaptureDraft';

function payload(note: string, status: 'draft' | 'final' = 'draft'): CreateEntryPayload {
  return {
    base_sync_version: 0,
    status,
    plot_uuid: 'plot-1',
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-16T08:30:00',
    occurred_timezone: 'Europe/Zurich',
    values: [],
    note,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useCaptureDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createEntry.mockReset();
    updateEntry.mockReset();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('allocates one usable UUID per committed StrictMode mount', () => {
    const randomUUID = vi.mocked(crypto.randomUUID);
    randomUUID
      .mockReset()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );

    const first = renderHook(() => useCaptureDraft(), { wrapper });
    expect(first.result.current.entryUuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(randomUUID).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useCaptureDraft(), { wrapper });
    expect(second.result.current.entryUuid).toBe('22222222-2222-4222-8222-222222222222');
    expect(randomUUID).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it('allocates one stable UUID and debounces the first draft POST', async () => {
    createEntry.mockResolvedValue({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    const { result, rerender } = renderHook(() => useCaptureDraft({ debounceMs: 500 }));

    const uuid = result.current.entryUuid;
    rerender();
    expect(result.current.entryUuid).toBe(uuid);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

    act(() => result.current.updateDraft(payload('first')));
    act(() => vi.advanceTimersByTime(499));
    expect(createEntry).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(createEntry).toHaveBeenCalledWith({
      ...payload('first'),
      entry_uuid: uuid,
    });
    expect(createEntry.mock.calls[0][0].status).toBe('draft');
    expect(createEntry.mock.calls[0][0].base_sync_version).toBe(0);
  });

  it('uses PUT for every draft after the initial POST', async () => {
    createEntry.mockResolvedValue({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    updateEntry.mockResolvedValue({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    const { result } = renderHook(() => useCaptureDraft({ debounceMs: 10 }));

    act(() => result.current.updateDraft(payload('first')));
    await act(async () => vi.advanceTimersByTime(10));
    await settle();

    act(() => result.current.updateDraft(payload('second')));
    await act(async () => vi.advanceTimersByTime(10));
    await settle();

    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(updateEntry).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      ...payload('second'),
      entry_uuid: '11111111-1111-4111-8111-111111111111',
    });
    expect(updateEntry.mock.calls[0][1].base_sync_version).toBe(0);
  });

  it('exposes saving until a deferred draft request is accepted by the gateway', async () => {
    const draftRequest = deferred<{ entry_uuid: string; sync_version: 0 }>();
    createEntry.mockReturnValueOnce(draftRequest.promise);
    const { result } = renderHook(() => useCaptureDraft({ debounceMs: 10 }));

    act(() => result.current.updateDraft(payload('deferred draft')));
    await act(async () => vi.advanceTimersByTime(10));
    expect(result.current.status).toBe('saving');
    expect(result.current.unsavedRisk).toBe(true);

    await act(async () => draftRequest.resolve({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    }));
    await settle();

    expect(result.current.status).toBe('draft-saved-gateway');
    expect(result.current.unsavedRisk).toBe(false);
  });

  it('serializes a newer queued change immediately after an in-flight request settles', async () => {
    const first = deferred<{ entry_uuid: string; sync_version: 0 }>();
    createEntry.mockReturnValueOnce(first.promise);
    updateEntry.mockResolvedValue({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    const { result } = renderHook(() => useCaptureDraft({ debounceMs: 10 }));

    act(() => result.current.updateDraft(payload('first')));
    await act(async () => vi.advanceTimersByTime(10));
    expect(createEntry).toHaveBeenCalledTimes(1);

    act(() => result.current.updateDraft(payload('second')));
    await act(async () => vi.advanceTimersByTime(10));
    expect(updateEntry).not.toHaveBeenCalled();

    await act(async () => first.resolve({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 }));
    await settle();

    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(updateEntry).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', expect.objectContaining({
      note: 'second',
      status: 'draft',
    }));
  });

  it('flushes the latest draft before promoting the same UUID to final', async () => {
    createEntry.mockResolvedValue({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    updateEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    });
    const calls: string[] = [];
    createEntry.mockImplementation(async (request: CreateEntryPayload) => {
      calls.push(`POST:${request.status}:${request.note}`);
      return { entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 };
    });
    updateEntry.mockImplementation(async (_uuid: string, request: CreateEntryPayload) => {
      calls.push(`PUT:${request.status}:${request.note}`);
      return {
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        outbox_event_uuid: 'outbox-1',
        sync_version: 1,
      };
    });
    const { result } = renderHook(() => useCaptureDraft({ debounceMs: 500 }));

    act(() => result.current.updateDraft(payload('latest')));
    const receipt = await act(async () => result.current.finish(payload('final', 'final')));

    expect(receipt).toEqual({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    });
    expect(calls).toEqual([
      'POST:draft:latest',
      'PUT:final:final',
    ]);
  });

  it('serializes final promotion and ignores edits after finish starts', async () => {
    const finalRequest = deferred<{
      entry_uuid: string;
      outbox_event_uuid: string;
      sync_version: number;
    }>();
    createEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    updateEntry.mockReturnValueOnce(finalRequest.promise);
    const { result } = renderHook(() => useCaptureDraft({ debounceMs: 10 }));

    act(() => result.current.updateDraft(payload('accepted draft')));
    await act(async () => vi.advanceTimersByTime(10));
    await settle();

    let finishPromise!: ReturnType<typeof result.current.finish>;
    act(() => {
      finishPromise = result.current.finish(payload('final', 'final'));
    });
    await settle();
    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(updateEntry.mock.calls[0][1]).toEqual(expect.objectContaining({
      status: 'final',
      note: 'final',
    }));

    act(() => result.current.updateDraft(payload('too late')));
    await act(async () => vi.advanceTimersByTime(10));
    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(result.current.draftPayload?.note).toBe('accepted draft');

    await act(async () => finalRequest.resolve({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    }));
    await finishPromise;
    await act(async () => vi.runAllTimers());
    await settle();

    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('final-saved-gateway');
  });

  it('returns one in-flight final promise for rapid finish and retry calls', async () => {
    const receipt = {
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    };
    const finalRequest = deferred<typeof receipt>();
    createEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    updateEntry
      .mockReturnValueOnce(finalRequest.promise)
      .mockResolvedValue(receipt);
    const { result } = renderHook(() => useCaptureDraft());

    let firstFinish!: ReturnType<typeof result.current.finish>;
    let secondFinish!: ReturnType<typeof result.current.finish>;
    let retry!: ReturnType<typeof result.current.retry>;
    act(() => {
      firstFinish = result.current.finish(payload('first final', 'final'));
      secondFinish = result.current.finish(payload('second final', 'final'));
      retry = result.current.retry();
    });

    expect(secondFinish).toBe(firstFinish);
    expect(retry).toBe(firstFinish);
    await settle();
    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(updateEntry.mock.calls[0][1]).toEqual(expect.objectContaining({
      note: 'first final',
      status: 'final',
    }));

    await act(async () => finalRequest.resolve(receipt));
    await expect(firstFinish).resolves.toBe(receipt);
    await expect(secondFinish).resolves.toBe(receipt);
    await expect(retry).resolves.toBe(receipt);
    await settle();

    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('final-saved-gateway');
  });

  it('exposes saving until a deferred final request is accepted by the gateway', async () => {
    const finalRequest = deferred<{
      entry_uuid: string;
      outbox_event_uuid: string;
      sync_version: number;
    }>();
    createEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    updateEntry.mockReturnValueOnce(finalRequest.promise);
    const { result } = renderHook(() => useCaptureDraft());

    let finishPromise!: ReturnType<typeof result.current.finish>;
    act(() => {
      finishPromise = result.current.finish(payload('final', 'final'));
    });
    await settle();

    expect(result.current.status).toBe('saving');
    expect(result.current.unsavedRisk).toBe(true);

    await act(async () => finalRequest.resolve({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    }));
    await finishPromise;
    await settle();

    expect(result.current.status).toBe('final-saved-gateway');
    expect(result.current.unsavedRisk).toBe(false);
  });

  it('retries a failed draft with the original UUID and keeps the volatile draft', async () => {
    const failure = new Error('gateway offline');
    const add = vi.spyOn(window, 'addEventListener');
    createEntry.mockRejectedValueOnce(failure).mockResolvedValueOnce({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    const { result } = renderHook(() => useCaptureDraft({ debounceMs: 10 }));

    act(() => result.current.updateDraft(payload('still-here')));
    await act(async () => vi.advanceTimersByTime(10));
    await settle();

    expect(result.current.error).toBe(failure);
    expect(result.current.lossWarning).toBe(true);
    expect(result.current.unsavedRisk).toBe(true);
    expect(result.current.draftPayload?.note).toBe('still-here');
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    await act(async () => result.current.retry());
    expect(createEntry).toHaveBeenCalledTimes(2);
    expect(createEntry.mock.calls[1][0].entry_uuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.current.error).toBeNull();
    expect(result.current.lossWarning).toBe(false);
  });

  it('calls the explicit final-saved callback with the outbox receipt', async () => {
    createEntry.mockResolvedValue({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    updateEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    });
    const onFinalSaved = vi.fn();
    const invalidateFinalEntries = vi.fn();
    const { result } = renderHook(() => useCaptureDraft({
      onFinalSaved,
      invalidateFinalEntries,
    }));

    const receipt = await act(async () => result.current.finish(payload('final', 'final')));

    expect(receipt.outbox_event_uuid).toBe('outbox-1');
    expect(onFinalSaved).toHaveBeenCalledWith(receipt);
    expect(invalidateFinalEntries).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('final-saved-gateway');
  });

  it.each(['onFinalSaved', 'invalidateFinalEntries'] as const)(
    'keeps gateway final acceptance authoritative when %s rejects',
    async (callbackName) => {
      const receipt = {
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        outbox_event_uuid: 'outbox-1',
        sync_version: 1,
      };
      const sideEffectFailure = new Error(`${callbackName} failed`);
      const callback = vi.fn().mockRejectedValue(sideEffectFailure);
      createEntry.mockResolvedValue({
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        sync_version: 0,
      });
      updateEntry.mockResolvedValue(receipt);
      const { result } = renderHook(() => useCaptureDraft({
        [callbackName]: callback,
      }));

      let acceptedReceipt;
      await act(async () => {
        acceptedReceipt = await result.current.finish(payload('final', 'final'));
      });

      expect(acceptedReceipt).toEqual(receipt);
      expect(result.current.status).toBe('final-saved-gateway');
      expect(result.current.unsavedRisk).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.sideEffectError).toBe(sideEffectFailure);

      await act(async () => result.current.retry());
      expect(updateEntry).toHaveBeenCalledTimes(1);
    },
  );

  it('exposes a pre-edit failure without allowing editable persistence', () => {
    const failure = new Error('journal capability unavailable');
    const { result } = renderHook(() => useCaptureDraft({
      preflight: { available: false, error: failure },
    }));

    expect(result.current.canEdit).toBe(false);
    expect(result.current.preEditError).toBe(failure);
    act(() => result.current.updateDraft(payload('ignored')));
    expect(createEntry).not.toHaveBeenCalled();
  });

  it('cancels a pending debounce when capture becomes unavailable', async () => {
    createEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useCaptureDraft({ debounceMs: 10, enabled }),
      { initialProps: { enabled: true } },
    );

    act(() => result.current.updateDraft(payload('must not persist')));
    rerender({ enabled: false });
    expect(result.current.canEdit).toBe(false);

    await act(async () => vi.advanceTimersByTime(20));
    await settle();

    expect(createEntry).not.toHaveBeenCalled();
    expect(updateEntry).not.toHaveBeenCalled();
  });

  it('installs the leave guard only while unsaved risk exists and removes it after save', async () => {
    createEntry.mockResolvedValue({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { result } = renderHook(() => useCaptureDraft({ debounceMs: 10 }));

    expect(add).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
    act(() => result.current.updateDraft(payload('guarded')));
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    await act(async () => vi.advanceTimersByTime(10));
    await settle();
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('removes the active leave guard on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { result, unmount } = renderHook(() => useCaptureDraft());

    act(() => result.current.updateDraft(payload('guarded until unmount')));
    const guard = add.mock.calls.find(([type]) => type === 'beforeunload')?.[1];
    expect(guard).toEqual(expect.any(Function));

    unmount();

    expect(remove).toHaveBeenCalledWith('beforeunload', guard);
  });

  it('cancels debounce work and does not issue a late request after unmount', async () => {
    const { result, unmount } = renderHook(() => useCaptureDraft({ debounceMs: 10 }));
    act(() => result.current.updateDraft(payload('unmounted')));
    unmount();
    await act(async () => vi.advanceTimersByTime(100));
    expect(createEntry).not.toHaveBeenCalled();
  });

  it('drops a queued draft when its in-flight request resolves after unmount', async () => {
    const firstDraft = deferred<{ entry_uuid: string; sync_version: 0 }>();
    const onFinalSaved = vi.fn();
    const invalidateFinalEntries = vi.fn();
    createEntry.mockReturnValueOnce(firstDraft.promise);
    updateEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    const { result, unmount } = renderHook(() => useCaptureDraft({
      debounceMs: 10,
      onFinalSaved,
      invalidateFinalEntries,
    }));

    act(() => result.current.updateDraft(payload('in flight')));
    await act(async () => vi.advanceTimersByTime(10));
    act(() => result.current.updateDraft(payload('queued')));
    await act(async () => vi.advanceTimersByTime(10));
    expect(updateEntry).not.toHaveBeenCalled();
    const statusAtUnmount = result.current.status;

    unmount();
    await act(async () => firstDraft.resolve({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    }));
    await settle();

    expect(updateEntry).not.toHaveBeenCalled();
    expect(onFinalSaved).not.toHaveBeenCalled();
    expect(invalidateFinalEntries).not.toHaveBeenCalled();
    expect(result.current.status).toBe(statusAtUnmount);
  });

  it('starts no late write or side effect when final resolves after unmount', async () => {
    const finalRequest = deferred<{
      entry_uuid: string;
      outbox_event_uuid: string;
      sync_version: number;
    }>();
    const onFinalSaved = vi.fn();
    const invalidateFinalEntries = vi.fn();
    createEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    updateEntry.mockReturnValueOnce(finalRequest.promise);
    const { result, unmount } = renderHook(() => useCaptureDraft({
      debounceMs: 10,
      onFinalSaved,
      invalidateFinalEntries,
    }));

    let finishPromise!: ReturnType<typeof result.current.finish>;
    act(() => {
      finishPromise = result.current.finish(payload('final', 'final'));
    });
    await settle();
    expect(result.current.status).toBe('saving');

    act(() => result.current.updateDraft(payload('ignored after finish')));
    await act(async () => vi.advanceTimersByTime(10));
    const statusAtUnmount = result.current.status;
    unmount();

    await act(async () => finalRequest.resolve({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    }));
    await finishPromise;
    await settle();

    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(onFinalSaved).not.toHaveBeenCalled();
    expect(invalidateFinalEntries).not.toHaveBeenCalled();
    expect(result.current.status).toBe(statusAtUnmount);
  });

  it('does not invalidate after unmount while onFinalSaved is pending', async () => {
    const callback = deferred<void>();
    const receipt = {
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      outbox_event_uuid: 'outbox-1',
      sync_version: 1,
    };
    const onFinalSaved = vi.fn().mockReturnValueOnce(callback.promise);
    const invalidateFinalEntries = vi.fn();
    createEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    updateEntry.mockResolvedValue(receipt);
    const { result, unmount } = renderHook(() => useCaptureDraft({
      onFinalSaved,
      invalidateFinalEntries,
    }));

    let finishPromise!: ReturnType<typeof result.current.finish>;
    act(() => {
      finishPromise = result.current.finish(payload('final', 'final'));
    });
    await settle();
    expect(onFinalSaved).toHaveBeenCalledWith(receipt);
    const statusAtUnmount = result.current.status;

    unmount();
    await act(async () => callback.resolve());
    await finishPromise;
    await settle();

    expect(invalidateFinalEntries).not.toHaveBeenCalled();
    expect(result.current.status).toBe(statusAtUnmount);
  });

  it('never calls browser persistence APIs', () => {
    const localStorageSet = vi.spyOn(Storage.prototype, 'setItem');
    const indexedDbOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: indexedDbOpen });
    const { result } = renderHook(() => useCaptureDraft());

    act(() => result.current.updateDraft(payload('memory-only')));
    expect(localStorageSet).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();
  });
});
