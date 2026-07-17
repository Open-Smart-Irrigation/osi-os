import useSWR from 'swr';
import { useState } from 'react';
import { journalApi } from '../services/journalApi';
import type { JournalPlot, JournalPlotWritePayload } from '../types/journal';

export interface JournalPlotResourceActions {
  createPlot: (payload: JournalPlotWritePayload) => Promise<JournalPlot>;
  updatePlot: (uuid: string, payload: JournalPlotWritePayload) => Promise<JournalPlot>;
  revalidate: () => Promise<unknown>;
}

export interface JournalPlotsState extends JournalPlotResourceActions {
  plots: JournalPlot[];
  loading: boolean;
  error: unknown | null;
  mutationError: unknown | null;
  retry: () => Promise<unknown>;
}

export function useJournalPlots(enabled: boolean): JournalPlotsState {
  const { data, error, isLoading, mutate } = useSWR<JournalPlot[]>(
    enabled ? 'journal:plots' : null,
    () => journalApi.listPlots(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const [mutationError, setMutationError] = useState<unknown | null>(null);

  const runMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    setMutationError(null);
    try {
      const result = await operation();
      await mutate();
      return result;
    } catch (mutationFailure) {
      setMutationError(mutationFailure);
      throw mutationFailure;
    }
  };

  const createPlot = async (payload: JournalPlotWritePayload): Promise<JournalPlot> => {
    return runMutation(() => journalApi.createPlot(payload));
  };

  const updatePlot = async (
    uuid: string,
    payload: JournalPlotWritePayload,
  ): Promise<JournalPlot> => {
    return runMutation(() => journalApi.updatePlot(uuid, payload));
  };

  const revalidate = async (): Promise<unknown> => mutate();

  return {
    plots: data ?? [],
    loading: enabled && isLoading,
    error: error ?? null,
    mutationError,
    createPlot,
    updatePlot,
    revalidate,
    retry: revalidate,
  };
}
