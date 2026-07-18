import { describe, expect, it, vi } from 'vitest';

import type { EntryAggregate } from '../../types/journal';
import { hydrateBatchMembership } from '../hydrateBatchMembership';

function entry(entry_uuid: string, status: EntryAggregate['status'] = 'final'): EntryAggregate {
  return {
    entry_uuid,
    batch_uuid: 'batch-1',
    status,
    sync_version: 0,
    values: [],
  } as unknown as EntryAggregate;
}

describe('hydrateBatchMembership', () => {
  it('fetches every membership page with status all and limit 100, preserving voided children and order', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce({ entries: [entry('e1')], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ entries: [entry('e2', 'voided')], next_cursor: null });

    const result = await hydrateBatchMembership('batch-1', listPage);

    expect(listPage).toHaveBeenNthCalledWith(1, {
      batch_uuid: 'batch-1', status: 'all', limit: 100,
    });
    expect(listPage).toHaveBeenNthCalledWith(2, {
      batch_uuid: 'batch-1', status: 'all', limit: 100, cursor: 'page-2',
    });
    expect(result.map(({ entry_uuid, status }) => ({ entry_uuid, status }))).toEqual([
      { entry_uuid: 'e1', status: 'final' },
      { entry_uuid: 'e2', status: 'voided' },
    ]);
  });

  it('rejects when 100 unique entries still have a non-null cursor', async () => {
    const firstPageEntries = Array.from({ length: 100 }, (_, index) => entry(`e${index + 1}`));
    const listPage = vi.fn().mockResolvedValue({
      entries: firstPageEntries,
      next_cursor: 'page-2',
    });

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/100.*cursor|complete/i);
    expect(listPage).toHaveBeenCalledOnce();
  });

  it('rejects an oversized first page instead of silently truncating it', async () => {
    const firstPageEntries = Array.from({ length: 120 }, (_, index) => entry(`e${index + 1}`));
    const snapshot = [...firstPageEntries];
    const listPage = vi.fn().mockResolvedValue({
      entries: firstPageEntries,
      next_cursor: 'page-2',
    });

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/100|limit|oversized/i);
    expect(listPage).toHaveBeenCalledOnce();
    expect(firstPageEntries).toEqual(snapshot);
  });

  it('rejects multipage membership overflow instead of silently truncating it', async () => {
    const firstPageEntries = Array.from({ length: 60 }, (_, index) => entry(`first-${index + 1}`));
    const secondPageEntries = Array.from({ length: 60 }, (_, index) => entry(`second-${index + 1}`));
    const listPage = vi.fn()
      .mockResolvedValueOnce({ entries: firstPageEntries, next_cursor: 'page-2' })
      .mockResolvedValueOnce({ entries: secondPageEntries, next_cursor: 'page-3' });

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/100|limit|oversized/i);
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(listPage).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: 'page-3' }));
  });

  it('returns exactly 100 unique entries when the page terminates with a null cursor', async () => {
    const firstPageEntries = Array.from({ length: 100 }, (_, index) => entry(`e${index + 1}`));
    const listPage = vi.fn().mockResolvedValue({ entries: firstPageEntries, next_cursor: null });

    await expect(hydrateBatchMembership('batch-1', listPage)).resolves.toEqual(firstPageEntries);
  });

  it.each([
    ['null cursor', null],
    ['blank cursor', ''],
    ['whitespace cursor', '   '],
  ])('does not fetch after a %s', async (_label, next_cursor) => {
    const listPage = vi.fn().mockResolvedValue({ entries: [entry('e1')], next_cursor });

    await hydrateBatchMembership('batch-1', listPage);

    expect(listPage).toHaveBeenCalledTimes(1);
  });

  it('stops when a cursor repeats and does not mutate page or child arrays', async () => {
    const firstPage = { entries: [entry('e1')], next_cursor: 'same' };
    const secondPage = { entries: [entry('e2', 'voided')], next_cursor: 'same' };
    const pages = [firstPage, secondPage];
    const snapshot = pages.map((page) => ({ entries: [...page.entries], next_cursor: page.next_cursor }));
    const listPage = vi.fn().mockImplementation(async () => pages[listPage.mock.calls.length - 1]);

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/repeat|complete/i);

    expect(listPage).toHaveBeenCalledTimes(2);
    expect(pages).toEqual(snapshot);
  });

  it('trims cursors before the next request and repeat detection', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce({ entries: [entry('e1')], next_cursor: ' page-2 ' })
      .mockResolvedValueOnce({ entries: [entry('e2')], next_cursor: 'page-2' });

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/repeat|complete/i);
    expect(listPage).toHaveBeenNthCalledWith(2, {
      batch_uuid: 'batch-1', status: 'all', limit: 100, cursor: 'page-2',
    });
    expect(listPage).toHaveBeenCalledTimes(2);
  });

  it('deduplicates entry UUIDs in first-seen order while preserving the first object identity', async () => {
    const first = entry('e1');
    const duplicate = entry('e1', 'voided');
    const second = entry('e2');
    const listPage = vi.fn()
      .mockResolvedValueOnce({ entries: [first, duplicate], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ entries: [duplicate, second], next_cursor: null });

    const result = await hydrateBatchMembership('batch-1', listPage);

    expect(result).toEqual([first, second]);
    expect(result[0]).toBe(first);
  });

  it('rejects a page with no new unique entries and a non-null cursor', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce({ entries: [entry('e1')], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ entries: [entry('e1', 'voided')], next_cursor: 'page-3' });

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/progress/i);
  });

  it('rejects a raw page over 100 entries even when deduplication would reduce it', async () => {
    const listPage = vi.fn().mockResolvedValue({
      entries: Array.from({ length: 101 }, () => entry('duplicate')),
      next_cursor: null,
    });

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/100|limit|oversized/i);
    expect(listPage).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid status', { ...entry('invalid-status'), status: 'archived' }],
    ['missing status', (() => {
      const value = { ...entry('missing-status') } as Record<string, unknown>;
      delete value.status;
      return value;
    })()],
    ['invalid sync_version', { ...entry('invalid-version'), sync_version: 1.5 }],
    ['missing sync_version', (() => {
      const value = { ...entry('missing-version') } as Record<string, unknown>;
      delete value.sync_version;
      return value;
    })()],
    ['wrong batch_uuid', { ...entry('wrong-batch'), batch_uuid: 'another-batch' }],
    ['null batch_uuid', { ...entry('null-batch'), batch_uuid: null }],
  ])('rejects a child with %s', async (_label, rawEntry) => {
    const listPage = vi.fn().mockResolvedValue({ entries: [rawEntry], next_cursor: null });

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/invalid|batch|status|sync_version/i);
    expect(listPage).toHaveBeenCalledOnce();
  });

  it.each([
    ['null page', null],
    ['missing entries', { next_cursor: null }],
    ['non-array entries', { entries: {}, next_cursor: null }],
    ['invalid cursor', { entries: [entry('e1')], next_cursor: 42 }],
    ['malformed entry', { entries: [{ entry_uuid: '   ' }], next_cursor: null }],
  ])('rejects a malformed %s safely', async (_label, page) => {
    const listPage = vi.fn().mockResolvedValue(page);

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/invalid|malformed/i);
  });

  it('rejects a blank batch UUID without issuing a request', async () => {
    const listPage = vi.fn();

    await expect(hydrateBatchMembership('  ', listPage)).rejects.toThrow(/batch/i);
    expect(listPage).not.toHaveBeenCalled();
  });

  it('rejects an unbounded source at a finite safety boundary', async () => {
    const listPage = vi.fn().mockImplementation(async () => ({
      entries: [entry(`e-${listPage.mock.calls.length}`)],
      next_cursor: `page-${listPage.mock.calls.length + 1}`,
    }));

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow(/100|limit|complete/i);
    expect(listPage.mock.calls.length).toBeLessThan(102);
  });

  it('propagates a page failure without issuing mutation or apply-all calls', async () => {
    const listPage = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(hydrateBatchMembership('batch-1', listPage)).rejects.toThrow('offline');
    expect(listPage).toHaveBeenCalledOnce();
  });
});
