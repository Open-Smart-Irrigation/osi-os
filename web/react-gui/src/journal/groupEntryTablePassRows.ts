import type { EntryAggregate } from '../types/journal';

// P2 (live UX pass): a tank-mix pass is N product entries sharing one
// pass_uuid, always on the SAME plot (see JournalCaptureFlow.tsx's own
// passUuid doc comment — a pass is "orthogonal to the multi-plot batch
// mechanism"). The desktop EntryTable rendered each member as its own,
// visually-identical row with no indication they were one recorded pass; the
// mobile JournalTimeline never had this problem because it already groups by
// batch_uuid, and a pass batch's members share a batch_uuid too (the edge
// stamps one on every member of any createFinalBatch call, cross-plot batch
// or single-plot pass alike). Grouping strictly on pass_uuid — not
// batch_uuid — is what keeps this additive: a cross-plot batch never sets
// pass_uuid (see types/journal.ts's own JournalBatchMember doc comment), so
// its members are untouched by this function and keep rendering as
// individual rows exactly as EntryTable did before this existed.
//
// Mirrors groupJournalTimelineEntries's own contract (JournalTimeline.tsx):
// stable, first-occurrence ordering; never mutates the input array or its
// entries.
export type EntryTablePassRow =
  | { kind: 'entry'; entry: EntryAggregate }
  | { kind: 'pass'; passUuid: string; entries: EntryAggregate[] };

export function groupEntryTablePassRows(
  entries: readonly EntryAggregate[],
): EntryTablePassRow[] {
  const rows: EntryTablePassRow[] = [];
  const passRowsByUuid = new Map<string, Extract<EntryTablePassRow, { kind: 'pass' }>>();

  for (const entry of entries) {
    const passUuid = entry.pass_uuid;
    if (typeof passUuid !== 'string' || passUuid.trim() === '') {
      rows.push({ kind: 'entry', entry });
      continue;
    }

    const existing = passRowsByUuid.get(passUuid);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }

    const row: Extract<EntryTablePassRow, { kind: 'pass' }> = {
      kind: 'pass',
      passUuid,
      entries: [entry],
    };
    passRowsByUuid.set(passUuid, row);
    rows.push(row);
  }

  return rows;
}
