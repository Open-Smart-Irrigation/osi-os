import { describe, expect, it } from 'vitest';

import type { EntryAggregate } from '../../types/journal';
import { groupEntryTablePassRows } from '../groupEntryTablePassRows';

function entry(entryUuid: string, overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    entry_uuid: entryUuid,
    activity_code: 'plant_protection_application',
    plot_uuid: 'p1',
    batch_uuid: null,
    pass_uuid: null,
    status: 'final',
    occurred_start: '2026-07-16T08:00:00.000Z',
    occurred_timezone: 'Europe/Zurich',
    values: [],
    ...overrides,
  } as unknown as EntryAggregate;
}

describe('groupEntryTablePassRows', () => {
  it('groups entries sharing a non-null pass_uuid into one pass row, in first-occurrence order', () => {
    const entries = [
      entry('e1', { pass_uuid: 'pass-a' }),
      entry('e2', { pass_uuid: 'pass-a' }),
      entry('e3', { pass_uuid: 'pass-a' }),
    ];

    expect(groupEntryTablePassRows(entries)).toEqual([
      { kind: 'pass', passUuid: 'pass-a', entries },
    ]);
  });

  it('leaves standalone (null pass_uuid) entries as individual rows', () => {
    const entries = [entry('e1'), entry('e2')];

    expect(groupEntryTablePassRows(entries)).toEqual([
      { kind: 'entry', entry: entries[0] },
      { kind: 'entry', entry: entries[1] },
    ]);
  });

  it('treats a blank pass_uuid the same as null (standalone, not grouped)', () => {
    const entries = [entry('e1', { pass_uuid: '  ' })];

    expect(groupEntryTablePassRows(entries)).toEqual([
      { kind: 'entry', entry: entries[0] },
    ]);
  });

  it('does not group a shared batch_uuid without a shared pass_uuid — a cross-plot batch stays individual rows', () => {
    const entries = [
      entry('e1', { batch_uuid: 'batch-1', plot_uuid: 'p1', pass_uuid: null }),
      entry('e2', { batch_uuid: 'batch-1', plot_uuid: 'p2', pass_uuid: null }),
    ];

    expect(groupEntryTablePassRows(entries)).toEqual([
      { kind: 'entry', entry: entries[0] },
      { kind: 'entry', entry: entries[1] },
    ]);
  });

  it('keeps grouped items in first-input order, interleaved with standalone entries and other passes', () => {
    const entries = [
      entry('standalone-1'),
      entry('pass-b-1', { pass_uuid: 'pass-b' }),
      entry('pass-a-1', { pass_uuid: 'pass-a' }),
      entry('pass-b-2', { pass_uuid: 'pass-b' }),
      entry('standalone-2'),
    ];

    const grouped = groupEntryTablePassRows(entries);

    expect(grouped.map((row) => (row.kind === 'entry' ? row.entry.entry_uuid : row.passUuid)))
      .toEqual(['standalone-1', 'pass-b', 'pass-a', 'standalone-2']);
    expect(grouped[1].kind === 'pass' ? grouped[1].entries.map((e) => e.entry_uuid) : null)
      .toEqual(['pass-b-1', 'pass-b-2']);
  });

  it('never mutates the input array or its entries', () => {
    const entries = [
      entry('e1', { pass_uuid: 'pass-a' }),
      entry('e2', { pass_uuid: 'pass-a' }),
    ];
    const snapshot = entries.map((value) => ({ ...value }));

    groupEntryTablePassRows(entries);

    expect(entries).toEqual(snapshot);
  });
});
