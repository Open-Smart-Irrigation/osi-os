import useSWR from 'swr';
import { journalApi } from '../../services/journalApi';
import type { EntryAggregate } from '../../types/journal';

/**
 * History-owned data layer for field-journal markers on chart surfaces. This
 * hook is the ONLY place that issues journal entry requests for the marker
 * lane: chart views and the lane component itself must stay fetch-free and
 * consume `markers` as plain data. Keeping the request path singular avoids
 * duplicate journal fetches when several chart branches want the same lane.
 */

export interface JournalMarkerEntry {
  entryUuid: string;
  activityCode: string;
  occurredAtMs: number;
  occurredEndMs: number | null;
  plotUuid: string | null;
  note: string | null;
}

export interface UseJournalMarkersOptions {
  zoneUuid: string | null | undefined;
  fromMs: number;
  toMs: number;
  enabled: boolean;
}

export interface UseJournalMarkersResult {
  markers: JournalMarkerEntry[];
  loading: boolean;
  error: unknown;
  retry: () => Promise<JournalMarkerEntry[] | undefined>;
}

// One page comfortably covers the 500-event stress scenario in 3 requests.
// The hard caps below exist only to bound a misbehaving/runaway server —
// legitimate windows never approach them.
const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const MAX_MARKERS = 5_000;

function normalizeMarker(entry: EntryAggregate): JournalMarkerEntry | null {
  const occurredAtMs = Date.parse(entry.occurred_start);
  if (!Number.isFinite(occurredAtMs)) return null;

  const occurredEndMs = entry.occurred_end ? Date.parse(entry.occurred_end) : NaN;

  return {
    entryUuid: entry.entry_uuid,
    activityCode: entry.activity_code,
    occurredAtMs,
    occurredEndMs: Number.isFinite(occurredEndMs) ? occurredEndMs : null,
    plotUuid: entry.plot_uuid,
    note: entry.note,
  };
}

async function fetchAllMarkers(zoneUuid: string, fromIso: string, toIso: string): Promise<JournalMarkerEntry[]> {
  const markers: JournalMarkerEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    const response = await journalApi.listEntries({
      zone_uuid: zoneUuid,
      status: 'final',
      occurred_from: fromIso,
      occurred_to: toIso,
      limit: PAGE_LIMIT,
      cursor,
    });

    for (const entry of response.entries) {
      const marker = normalizeMarker(entry);
      if (marker) markers.push(marker);
    }

    cursor = response.next_cursor ?? undefined;
    page += 1;
  } while (cursor && markers.length < MAX_MARKERS && page < MAX_PAGES);

  return markers;
}

function canonicalIsoMinute(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function markerKey(options: UseJournalMarkersOptions): [string, string, string, string] | null {
  if (!options.enabled || !options.zoneUuid) return null;
  if (!Number.isFinite(options.fromMs) || !Number.isFinite(options.toMs) || options.toMs <= options.fromMs) return null;

  return [
    'journal-markers',
    options.zoneUuid,
    canonicalIsoMinute(options.fromMs),
    canonicalIsoMinute(options.toMs),
  ];
}

export function useJournalMarkers(options: UseJournalMarkersOptions): UseJournalMarkersResult {
  const key = markerKey(options);
  const { data, error, isLoading, mutate } = useSWR<JournalMarkerEntry[]>(
    key,
    () => fetchAllMarkers(
      options.zoneUuid as string,
      new Date(options.fromMs).toISOString(),
      new Date(options.toMs).toISOString(),
    ),
    { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 1_500 },
  );

  return {
    markers: data ?? [],
    loading: Boolean(key) && isLoading,
    error,
    retry: mutate,
  };
}
