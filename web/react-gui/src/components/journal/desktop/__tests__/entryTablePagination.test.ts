import { describe, expect, it } from 'vitest';

import {
  initialPaginationState,
  paginationReducer,
  type PaginationState,
} from '../entryTablePagination';

const FILTERS_A = 'filters-a';
const FILTERS_B = 'filters-b';

function synced(filtersKey: string): PaginationState {
  return paginationReducer(initialPaginationState, { type: 'sync', filtersKey });
}

describe('paginationReducer', () => {
  it('starts on the first page with no history', () => {
    expect(initialPaginationState).toEqual({ filtersKey: null, cursor: null, history: [] });
  });

  it('advances to the next page and remembers the prior cursor', () => {
    const page1 = synced(FILTERS_A);

    const page2 = paginationReducer(page1, {
      type: 'next',
      filtersKey: FILTERS_A,
      nextCursor: 'cursor-2',
    });

    expect(page2).toEqual({ filtersKey: FILTERS_A, cursor: 'cursor-2', history: [null] });
  });

  it('walks back through several pages by popping the history stack', () => {
    let state = synced(FILTERS_A);
    state = paginationReducer(state, { type: 'next', filtersKey: FILTERS_A, nextCursor: 'cursor-2' });
    state = paginationReducer(state, { type: 'next', filtersKey: FILTERS_A, nextCursor: 'cursor-3' });
    expect(state).toEqual({ filtersKey: FILTERS_A, cursor: 'cursor-3', history: [null, 'cursor-2'] });

    state = paginationReducer(state, { type: 'previous', filtersKey: FILTERS_A });
    expect(state).toEqual({ filtersKey: FILTERS_A, cursor: 'cursor-2', history: [null] });

    state = paginationReducer(state, { type: 'previous', filtersKey: FILTERS_A });
    expect(state).toEqual({ filtersKey: FILTERS_A, cursor: null, history: [] });
  });

  it('is defensive: "previous" on the first page is a no-op', () => {
    const page1 = synced(FILTERS_A);

    const result = paginationReducer(page1, { type: 'previous', filtersKey: FILTERS_A });

    expect(result).toBe(page1);
  });

  it('is defensive: "next" with an empty cursor string is a no-op (no more pages)', () => {
    const page1 = synced(FILTERS_A);

    const result = paginationReducer(page1, { type: 'next', filtersKey: FILTERS_A, nextCursor: '' });

    expect(result).toBe(page1);
  });

  it('is defensive: an action for a stale filters key never mutates the current page', () => {
    const page2 = paginationReducer(synced(FILTERS_A), {
      type: 'next',
      filtersKey: FILTERS_A,
      nextCursor: 'cursor-2',
    });

    const staleNext = paginationReducer(page2, {
      type: 'next',
      filtersKey: FILTERS_B,
      nextCursor: 'cursor-stale',
    });
    expect(staleNext).toBe(page2);

    const stalePrevious = paginationReducer(page2, { type: 'previous', filtersKey: FILTERS_B });
    expect(stalePrevious).toBe(page2);
  });

  it('resets to a clean first page when the filters key changes ("sync")', () => {
    const page2 = paginationReducer(synced(FILTERS_A), {
      type: 'next',
      filtersKey: FILTERS_A,
      nextCursor: 'cursor-2',
    });

    const resynced = paginationReducer(page2, { type: 'sync', filtersKey: FILTERS_B });

    expect(resynced).toEqual({ filtersKey: FILTERS_B, cursor: null, history: [] });
  });

  it('"sync" with the same filters key is a no-op (does not clear an in-progress page)', () => {
    const page2 = paginationReducer(synced(FILTERS_A), {
      type: 'next',
      filtersKey: FILTERS_A,
      nextCursor: 'cursor-2',
    });

    const result = paginationReducer(page2, { type: 'sync', filtersKey: FILTERS_A });

    expect(result).toBe(page2);
  });
});
