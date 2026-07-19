import { api } from './api';
import type {
  BatchMutationReceipt,
  CreateFinalBatchPayload,
  EntryDiscardReceipt,
  EntryFinalMutationReceipt,
  EntryListFilters,
  EntryListResponse,
  EntryMutationReceipt,
  JournalCatalog,
  JournalEntryWriteFields,
  JournalPlot,
  JournalPlotGroupWritePayload,
  JournalPlotListResponse,
  JournalPlotWritePayload,
  PlotGroup,
  PlotGroupListResponse,
} from '../types/journal';

export interface JournalCatalogOptions {
  includeDefinitions?: boolean;
}

interface EntryWritePayload extends JournalEntryWriteFields {
  plot_uuid: string | null;
  duplicate_guard_ack_entry_uuid?: string | null;
  batch_uuid?: string | null;
}

export interface CreateEntryPayload extends EntryWritePayload {
  entry_uuid?: string;
  base_sync_version: 0;
}

export interface UpdateEntryPayload extends EntryWritePayload {
  entry_uuid?: string;
  base_sync_version: number;
}

export const journalApi = {
  getCatalog: async (options: JournalCatalogOptions = {}): Promise<JournalCatalog> => {
    if (options.includeDefinitions) {
      return (
        await api.get<JournalCatalog>('/api/journal/catalog', {
          params: { include: 'definitions' },
        })
      ).data;
    }

    return (await api.get<JournalCatalog>('/api/journal/catalog')).data;
  },

  listEntries: async (filters: EntryListFilters = {}): Promise<EntryListResponse> =>
    (await api.get<EntryListResponse>('/api/journal/entries', { params: filters })).data,

  createEntry: async (payload: CreateEntryPayload): Promise<EntryMutationReceipt> =>
    (await api.post<EntryMutationReceipt>('/api/journal/entries', payload)).data,

  createFinalBatch: async (payload: CreateFinalBatchPayload): Promise<BatchMutationReceipt> =>
    (await api.post<BatchMutationReceipt>('/api/journal/entries', payload)).data,

  updateEntry: async (
    uuid: string,
    payload: UpdateEntryPayload,
  ): Promise<EntryMutationReceipt> =>
    (
      await api.put<EntryMutationReceipt>(
        `/api/journal/entries/${encodeURIComponent(uuid)}`,
        payload,
      )
    ).data,

  voidEntry: async (
    uuid: string,
    void_reason: string,
    base_sync_version: number,
  ): Promise<EntryFinalMutationReceipt> =>
    (
      await api.post<EntryFinalMutationReceipt>(
        `/api/journal/entries/${encodeURIComponent(uuid)}/void`,
        { void_reason, base_sync_version },
      )
    ).data,

  // Reuses the same journal-entry PUT transport as updateEntry: a body of
  // { discard: true } is a distinct verb the edge routes to a transactional
  // hard-delete of a version-zero draft, rather than a save.
  discardDraft: async (uuid: string): Promise<EntryDiscardReceipt> =>
    (
      await api.put<EntryDiscardReceipt>(
        `/api/journal/entries/${encodeURIComponent(uuid)}`,
        { discard: true },
      )
    ).data,

  listPlots: async (): Promise<JournalPlot[]> =>
    (await api.get<JournalPlotListResponse>('/api/journal/plots')).data.plots,

  createPlot: async (payload: JournalPlotWritePayload): Promise<JournalPlot> =>
    (await api.post<{ plot: JournalPlot }>('/api/journal/plots', payload)).data.plot,

  updatePlot: async (
    uuid: string,
    payload: JournalPlotWritePayload,
  ): Promise<JournalPlot> => {
    if (uuid !== payload.plot_uuid) {
      throw new Error('Plot UUID path/body mismatch');
    }

    return (
      await api.put<{ plot: JournalPlot }>(
        `/api/journal/plots/${encodeURIComponent(uuid)}`,
        payload,
      )
    ).data.plot;
  },

  listPlotGroups: async (): Promise<PlotGroup[]> =>
    (await api.get<PlotGroupListResponse>('/api/journal/plot-groups')).data.plot_groups,

  createPlotGroup: async (payload: JournalPlotGroupWritePayload): Promise<PlotGroup> =>
    (await api.post<{ plot_group: PlotGroup }>('/api/journal/plot-groups', payload)).data.plot_group,

  updatePlotGroup: async (
    uuid: string,
    payload: JournalPlotGroupWritePayload,
  ): Promise<PlotGroup> => {
    if (uuid !== payload.group_uuid) {
      throw new Error('Plot-group UUID path/body mismatch');
    }

    return (
      await api.put<{ plot_group: PlotGroup }>(
        `/api/journal/plot-groups/${encodeURIComponent(uuid)}`,
        payload,
      )
    ).data.plot_group;
  },
};

export function isJournalUnavailable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 501;
}
