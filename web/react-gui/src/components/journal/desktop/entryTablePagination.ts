// Keyset ("opaque cursor") pagination state for the desktop entry table.
//
// The edge API's `cursor` is opaque and filter-bound: it is a hash of the
// exact filter set that produced it, and the server rejects a cursor sent
// alongside a different filter set with a 400 `invalid_cursor` response
// (see osi-journal/api.js `decodeCursor`/`filterHash`). This state machine is
// "defensive" against that failure mode: every action carries the
// `filtersKey` it was issued for, and `next`/`previous` are no-ops unless the
// state already belongs to that same key. A `sync` action is how a caller
// (re)targets the state at the current filters; it wipes cursor/history back
// to a clean first page whenever the key actually changes, and is a no-op
// (returns the same reference) when the key already matches — so it is safe
// to dispatch on every render without disturbing an in-progress page.

export interface PaginationState {
  /** Opaque identity of the filter set this page belongs to, or null before the first sync. */
  filtersKey: string | null;
  /** The cursor to send for the *current* page, or null for the first page. */
  cursor: string | null;
  /** Cursors (or null for the first page) of every page visited before the current one. */
  history: (string | null)[];
}

export type PaginationAction =
  | { type: 'sync'; filtersKey: string }
  | { type: 'next'; filtersKey: string; nextCursor: string | null }
  | { type: 'previous'; filtersKey: string };

export const initialPaginationState: PaginationState = {
  filtersKey: null,
  cursor: null,
  history: [],
};

export function paginationReducer(
  state: PaginationState,
  action: PaginationAction,
): PaginationState {
  switch (action.type) {
    case 'sync': {
      if (state.filtersKey === action.filtersKey) return state;
      return { filtersKey: action.filtersKey, cursor: null, history: [] };
    }
    case 'next': {
      if (state.filtersKey !== action.filtersKey) return state;
      if (!action.nextCursor) return state;
      return {
        filtersKey: action.filtersKey,
        cursor: action.nextCursor,
        history: [...state.history, state.cursor],
      };
    }
    case 'previous': {
      if (state.filtersKey !== action.filtersKey) return state;
      if (state.history.length === 0) return state;
      const history = state.history.slice(0, -1);
      const cursor = state.history[state.history.length - 1];
      return { filtersKey: action.filtersKey, cursor, history };
    }
    default:
      return state;
  }
}
