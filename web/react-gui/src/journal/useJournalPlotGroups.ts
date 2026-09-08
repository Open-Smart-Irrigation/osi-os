import { useState } from 'react';
import useSWR from 'swr';
import { journalApi } from '../services/journalApi';
import type {
  JournalPlotGroupWritePayload,
  PlotGroup,
} from '../types/journal';

export interface JournalPlotGroupResourceActions {
  createPlotGroup: (payload: JournalPlotGroupWritePayload) => Promise<PlotGroup>;
  updatePlotGroup: (
    uuid: string,
    payload: JournalPlotGroupWritePayload,
  ) => Promise<PlotGroup>;
  revalidate: () => Promise<unknown>;
}

export interface JournalPlotGroupsState extends JournalPlotGroupResourceActions {
  groups: PlotGroup[];
  activeGroups: PlotGroup[];
  resolvedGroups: PlotGroup[];
  loading: boolean;
  error: unknown | null;
  mutationError: unknown | null;
  retry: () => Promise<unknown>;
}

export function useJournalPlotGroups(enabled: boolean): JournalPlotGroupsState {
  const { data, error, isLoading, mutate } = useSWR<PlotGroup[]>(
    enabled ? 'journal:plot-groups' : null,
    () => journalApi.listPlotGroups(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const [mutationError, setMutationError] = useState<unknown | null>(null);
  const groups = data ?? [];

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

  const createPlotGroup = async (
    payload: JournalPlotGroupWritePayload,
  ): Promise<PlotGroup> => {
    return runMutation(() => journalApi.createPlotGroup(payload));
  };

  const updatePlotGroup = async (
    uuid: string,
    payload: JournalPlotGroupWritePayload,
  ): Promise<PlotGroup> => {
    return runMutation(() => journalApi.updatePlotGroup(uuid, payload));
  };

  const revalidate = async (): Promise<unknown> => mutate();

  return {
    groups,
    activeGroups: groups.filter((group) => group.resolved_at === null),
    resolvedGroups: groups.filter((group) => group.resolved_at !== null),
    loading: enabled && isLoading,
    error: error ?? null,
    mutationError,
    createPlotGroup,
    updatePlotGroup,
    revalidate,
    retry: revalidate,
  };
}
