import type { EntryAggregate } from '../types/journal';

const BATCH_MEMBERSHIP_LIMIT = 100;
const MAX_BATCH_MEMBERSHIP_REQUESTS = 100;

export interface BatchMembershipPage {
  entries: EntryAggregate[];
  next_cursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidPage(message: string): Error {
  return new Error(`Invalid batch membership page: ${message}`);
}

function validatePage(value: unknown, batchUuid: string): BatchMembershipPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw invalidPage('entries must be an array');
  }
  if (value.entries.length > BATCH_MEMBERSHIP_LIMIT) {
    throw invalidPage('entries cannot exceed the 100-entry limit');
  }
  if (value.next_cursor !== null && typeof value.next_cursor !== 'string') {
    throw invalidPage('next_cursor must be a string or null');
  }

  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.entry_uuid !== 'string' || entry.entry_uuid.trim() === '') {
      throw invalidPage('every entry must have a non-blank entry_uuid');
    }
    if (entry.status !== 'draft' && entry.status !== 'final' && entry.status !== 'voided') {
      throw invalidPage('every entry must have a valid status');
    }
    if (typeof entry.sync_version !== 'number'
      || !Number.isFinite(entry.sync_version)
      || !Number.isInteger(entry.sync_version)
      || entry.sync_version < 0) {
      throw invalidPage('every entry must have a finite nonnegative integer sync_version');
    }
    if (entry.batch_uuid !== batchUuid) {
      throw invalidPage('every entry must belong to the requested batch');
    }
  }

  return value as unknown as BatchMembershipPage;
}

export async function hydrateBatchMembership(
  batchUuid: string,
  listPage: (filters: {
    batch_uuid: string;
    status: 'all';
    limit: 100;
    cursor?: string;
  }) => Promise<BatchMembershipPage>,
): Promise<EntryAggregate[]> {
  if (typeof batchUuid !== 'string' || batchUuid.trim() === '') {
    throw new Error('Cannot hydrate a blank batch UUID');
  }

  const entries: EntryAggregate[] = [];
  const seenEntryUuids = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let requestCount = 0;

  while (true) {
    if (requestCount >= MAX_BATCH_MEMBERSHIP_REQUESTS) {
      throw new Error('Batch membership request ceiling exceeded');
    }

    const page = validatePage(await listPage(cursor
      ? { batch_uuid: batchUuid, status: 'all', limit: 100, cursor }
      : { batch_uuid: batchUuid, status: 'all', limit: 100 }), batchUuid);
    requestCount += 1;

    const newEntries = page.entries.filter((entry) => {
      if (seenEntryUuids.has(entry.entry_uuid)) return false;
      seenEntryUuids.add(entry.entry_uuid);
      return true;
    });

    if (entries.length + newEntries.length > BATCH_MEMBERSHIP_LIMIT) {
      throw new Error('Batch membership exceeds the 100-entry limit');
    }
    entries.push(...newEntries);

    const nextCursor = page.next_cursor === null ? null : page.next_cursor.trim();
    if (nextCursor === '') return entries;
    if (nextCursor === null) return entries;
    if (entries.length === BATCH_MEMBERSHIP_LIMIT) {
      throw new Error('Batch membership cannot establish completeness after 100 entries');
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('Batch membership cursor repeated before completeness was established');
    }
    if (newEntries.length === 0) {
      throw new Error('Batch membership hydration made no progress');
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}
