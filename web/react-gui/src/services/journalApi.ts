import { api } from './api';
import type {
  EntryFinalMutationReceipt,
  EntryListFilters,
  EntryListResponse,
  EntryMutationReceipt,
  EntryValueInput,
  EntryWriteStatus,
  JournalCatalog,
  JournalPlot,
  JournalPlotListResponse,
  PlotGroup,
  PlotGroupListResponse,
} from '../types/journal';

export interface JournalCatalogOptions {
  includeDefinitions?: boolean;
}

interface EntryWritePayload {
  status: EntryWriteStatus;
  plot_uuid: string | null;
  activity_code: string;
  template_code: string;
  template_version: number;
  layout_code: string;
  layout_version: number;
  occurred_start_local: string;
  occurred_end_local?: string | null;
  occurred_timezone: string;
  values: EntryValueInput[];
  note?: string | null;
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

  listPlots: async (): Promise<JournalPlot[]> =>
    (await api.get<JournalPlotListResponse>('/api/journal/plots')).data.plots,

  listPlotGroups: async (): Promise<PlotGroup[]> =>
    (await api.get<PlotGroupListResponse>('/api/journal/plot-groups')).data.plot_groups,
};

export function isJournalUnavailable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 501;
}
