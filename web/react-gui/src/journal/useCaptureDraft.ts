import { useCallback, useEffect, useRef, useState } from 'react';

import { journalApi } from '../services/journalApi';
import { randomUuid } from '../utils/uuid';
import type {
  CreateEntryPayload,
  UpdateEntryPayload,
} from '../services/journalApi';
import type {
  EntryFinalMutationReceipt,
  EntryMutationReceipt,
} from '../types/journal';

export type CaptureSaveState =
  | 'saving'
  | 'draft-saved-gateway'
  | 'final-saved-gateway'
  | 'cloud-waiting'
  | 'not-saved';

export interface CapturePreflight {
  available: boolean;
  error?: unknown;
}

export interface UseCaptureDraftOptions {
  debounceMs?: number;
  enabled?: boolean;
  preflight?: CapturePreflight;
  onFinalSaved?: (receipt: EntryFinalMutationReceipt) => void | Promise<void>;
  invalidateFinalEntries?: () => void | Promise<void>;
}

export interface UseCaptureDraftResult {
  entryUuid: string | null;
  canEdit: boolean;
  preEditError: unknown | null;
  status: CaptureSaveState;
  draftPayload: CreateEntryPayload | null;
  error: unknown | null;
  sideEffectError: unknown | null;
  lossWarning: boolean;
  unsavedRisk: boolean;
  updateDraft: (payload: CreateEntryPayload) => void;
  setDraft: (payload: CreateEntryPayload) => void;
  saveDraft: () => Promise<EntryMutationReceipt | undefined>;
  finish: (finalPayload: CreateEntryPayload) => Promise<EntryFinalMutationReceipt>;
  retry: () => Promise<EntryMutationReceipt | EntryFinalMutationReceipt | undefined>;
}

const DEFAULT_DEBOUNCE_MS = 500;

function preflightErrorFor(
  enabled: boolean,
  preflight: CapturePreflight | undefined,
): unknown | null {
  if (!enabled) return new Error('Journal capture is not enabled');
  if (preflight?.available === false) {
    return preflight.error ?? new Error('Journal capture is unavailable');
  }
  return null;
}

export function useCaptureDraft(options: UseCaptureDraftOptions = {}): UseCaptureDraftResult {
  const {
    debounceMs = DEFAULT_DEBOUNCE_MS,
    enabled = true,
    preflight,
  } = options;
  const preEditError = preflightErrorFor(enabled, preflight);
  const canEdit = preEditError == null;
  const uuidRef = useRef<string | null>(null);

  const [entryUuid, setEntryUuid] = useState<string | null>(null);
  const [status, setStatus] = useState<CaptureSaveState>('not-saved');
  const [draftPayload, setDraftPayload] = useState<CreateEntryPayload | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [sideEffectError, setSideEffectError] = useState<unknown | null>(null);
  const [lossWarning, setLossWarning] = useState(false);
  const [unsavedRisk, setUnsavedRisk] = useState(false);

  const mountedRef = useRef(true);
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<CreateEntryPayload | null>(null);
  const draftRef = useRef<CreateEntryPayload | null>(null);
  const createdRef = useRef(false);
  const requestTailRef = useRef<Promise<void>>(Promise.resolve());
  const drainRef = useRef<Promise<EntryMutationReceipt | undefined> | null>(null);
  const finishStartedRef = useRef(false);
  const finalPromiseRef = useRef<Promise<EntryFinalMutationReceipt> | null>(null);
  const lastFailureRef = useRef<'draft' | 'final' | null>(null);
  const finalPayloadRef = useRef<CreateEntryPayload | null>(null);
  const onFinalSavedRef = useRef(options.onFinalSaved);
  const invalidateFinalEntriesRef = useRef(options.invalidateFinalEntries);
  onFinalSavedRef.current = options.onFinalSaved;
  invalidateFinalEntriesRef.current = options.invalidateFinalEntries;

  useEffect(() => {
    if (!canEdit || uuidRef.current) return;
    const uuid = randomUuid();
    uuidRef.current = uuid;
    setEntryUuid(uuid);
  }, [canEdit]);

  const normalizedDraft = useCallback((payload: CreateEntryPayload): CreateEntryPayload => ({
    ...payload,
    entry_uuid: uuidRef.current ?? payload.entry_uuid,
    status: 'draft',
    base_sync_version: 0,
  }), []);

  const enqueueRequest = useCallback(<T>(request: () => Promise<T>): Promise<T> => {
    const queued = requestTailRef.current.then(() => {
      if (!mountedRef.current) throw new Error('Journal capture was unmounted');
      if (!canEditRef.current) throw new Error('Journal capture is unavailable');
      return request();
    });
    requestTailRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }, []);

  const persistDraft = useCallback(async (
    next: CreateEntryPayload,
  ): Promise<EntryMutationReceipt> => {
    const uuid = uuidRef.current;
    if (!uuid) throw new Error('Journal capture is unavailable');
    if (mountedRef.current) setStatus('saving');

    try {
      const receipt = await enqueueRequest(() => createdRef.current
        ? journalApi.updateEntry(uuid, next as UpdateEntryPayload)
        : journalApi.createEntry(next));
      createdRef.current = true;
      lastFailureRef.current = null;
      if (mountedRef.current) {
        setError(null);
        setLossWarning(false);
        setStatus('draft-saved-gateway');
      }
      return receipt;
    } catch (caught) {
      if (mountedRef.current) {
        setError(caught);
        setLossWarning(true);
        setStatus('not-saved');
      }
      throw caught;
    }
  }, [enqueueRequest]);

  const drainDraftQueue = useCallback((): Promise<EntryMutationReceipt | undefined> => {
    if (!canEditRef.current) return Promise.resolve(undefined);
    if (drainRef.current) return drainRef.current;

    const drain = (async () => {
      let lastReceipt: EntryMutationReceipt | undefined;
      while (mountedRef.current && canEditRef.current && pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        try {
          lastReceipt = await persistDraft(next);
        } catch (caught) {
          lastFailureRef.current = 'draft';
          if (pendingRef.current) continue;
          pendingRef.current = next;
          throw caught;
        }
      }
      if (
        mountedRef.current &&
        pendingRef.current == null &&
        !finishStartedRef.current
      ) {
        setUnsavedRisk(false);
      }
      return lastReceipt;
    })();

    drainRef.current = drain;
    void drain.finally(() => {
      if (drainRef.current === drain) drainRef.current = null;
    }).catch(() => undefined);
    return drain;
  }, [persistDraft]);

  const cancelTimer = useCallback(() => {
    if (timerRef.current == null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const updateDraft = useCallback((payload: CreateEntryPayload) => {
    if (!canEdit || finishStartedRef.current) return;
    const next = normalizedDraft(payload);
    draftRef.current = next;
    pendingRef.current = next;
    setDraftPayload(next);
    setUnsavedRisk(true);
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!canEditRef.current) return;
      void drainDraftQueue().catch(() => undefined);
    }, debounceMs);
  }, [canEdit, cancelTimer, debounceMs, drainDraftQueue, normalizedDraft]);

  const saveDraft = useCallback(async () => {
    if (!canEdit || finishStartedRef.current || !draftRef.current) return undefined;
    cancelTimer();
    if (!pendingRef.current) pendingRef.current = draftRef.current;
    setUnsavedRisk(true);
    return drainDraftQueue();
  }, [canEdit, cancelTimer, drainDraftQueue]);

  const finish = useCallback((finalPayload: CreateEntryPayload) => {
    if (finalPromiseRef.current) return finalPromiseRef.current;
    if (!canEdit || !uuidRef.current) {
      return Promise.reject(preEditError ?? new Error('Journal capture is unavailable'));
    }
    finishStartedRef.current = true;
    cancelTimer();
    const uuid = uuidRef.current;
    const final = {
      ...finalPayload,
      entry_uuid: uuid,
      status: 'final' as const,
      base_sync_version: 0 as const,
    };
    finalPayloadRef.current = final;
    setUnsavedRisk(true);

    if (!draftRef.current) {
      const firstDraft = normalizedDraft(final);
      draftRef.current = firstDraft;
      pendingRef.current = firstDraft;
      setDraftPayload(firstDraft);
    } else if (!pendingRef.current && !createdRef.current) {
      pendingRef.current = draftRef.current;
    }

    const operation = (async (): Promise<EntryFinalMutationReceipt> => {
      try {
        await drainDraftQueue();
        if (!mountedRef.current) throw new Error('Journal capture was unmounted');
        setStatus('saving');
        const receipt = await enqueueRequest(() =>
          journalApi.updateEntry(uuid, final as UpdateEntryPayload));
        if (!('outbox_event_uuid' in receipt) || !receipt.outbox_event_uuid) {
          throw new Error('Final journal receipt did not include an outbox event');
        }
        if (mountedRef.current) {
          setError(null);
          setSideEffectError(null);
          setLossWarning(false);
          setUnsavedRisk(false);
          setStatus('final-saved-gateway');
        }
        lastFailureRef.current = null;
        if (!mountedRef.current) return receipt;
        let callbackError: unknown | null = null;
        try {
          await onFinalSavedRef.current?.(receipt);
        } catch (caught) {
          callbackError = caught;
        }
        if (!mountedRef.current) return receipt;
        try {
          await invalidateFinalEntriesRef.current?.();
        } catch (caught) {
          callbackError ??= caught;
        }
        if (!mountedRef.current) return receipt;
        setSideEffectError(callbackError);
        return receipt;
      } catch (caught) {
        finishStartedRef.current = false;
        lastFailureRef.current = 'final';
        if (mountedRef.current) {
          setError(caught);
          setLossWarning(true);
          setUnsavedRisk(true);
          setStatus('not-saved');
        }
        throw caught;
      }
    })();
    finalPromiseRef.current = operation;
    void operation.catch(() => {
      if (finalPromiseRef.current === operation) finalPromiseRef.current = null;
    });
    return operation;
  }, [canEdit, cancelTimer, drainDraftQueue, enqueueRequest, normalizedDraft, preEditError]);

  const retry = useCallback(() => {
    if (finalPromiseRef.current) return finalPromiseRef.current;
    if (!canEdit) return Promise.resolve(undefined);
    if (lastFailureRef.current === 'final' && finalPayloadRef.current) {
      return finish(finalPayloadRef.current);
    }
    return saveDraft();
  }, [canEdit, finish, saveDraft]);

  useEffect(() => {
    if (canEdit) return;
    cancelTimer();
    pendingRef.current = null;
  }, [canEdit, cancelTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelTimer();
      pendingRef.current = null;
    };
  }, [cancelTimer]);

  useEffect(() => {
    if (!canEdit || !unsavedRisk) return undefined;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [canEdit, unsavedRisk]);

  return {
    entryUuid,
    canEdit,
    preEditError,
    status,
    draftPayload,
    error,
    sideEffectError,
    lossWarning,
    unsavedRisk,
    updateDraft,
    setDraft: updateDraft,
    saveDraft,
    finish,
    retry,
  };
}
