# Initial mobile history selection correction

## Defect

`MobileTensionHistory` initializes its local selection as `[]`, then applies the catalog defaults in an effect. During that transition, `useHistoryWindow` reports `status: 'empty'` with the valid `HistoryEmptyReason` value `'no-selection'`. The shell has already rendered the nonempty default selection, so its current condition treats that temporary hook state as a completed empty interval and shows **No data in this interval** and **Show latest 24 hours** before any request or accepted coverage exists.

## RED regression

Add one component test to `web/history-uplot-core/tests/mobileTensionHistory.test.tsx` with an available default source and a deferred loader.

1. Render `MobileTensionHistory` with the normal nonempty `defaultSelectedIds`.
2. Before advancing the 150 ms selection debounce or resolving the loader, flush the initial React effects.
3. Require **Loading history…** to be visible.
4. Require **No data in this interval** and **Show latest 24 hours** to be absent.
5. Advance the debounce so the loader is called, but keep its promise pending; the same loading assertions must hold.
6. Resolve the loader with the existing complete all-null hourly response fixture. Require loading to disappear and require both the empty message and Show latest action to appear.

This must fail before the product change at step 3 or 4. Do not use an immediately resolved loader, because that can skip the transient state under test.

Keep two existing behaviors explicit:

- The existing complete all-null response test remains green and still renders the empty interval plus Show latest.
- The existing deliberate `defaultSelectedIds: []` test remains green and renders **Choose sources** without calling the loader. It must not render the interval-empty action.

## Product change

Change only `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx`.

Derive the temporary state from the closed union already exported by the core:

```ts
const selectionStarting = !noSelection
  && model.status === 'empty'
  && model.emptyReason === 'no-selection';
const hasCompletedEmptyInterval = !noSelection
  && model.status === 'empty'
  && model.emptyReason === 'no-finite-data'
  && accepted !== null;
```

Render the loading status when either the model is loading without accepted data or `selectionStarting` is true. Render the empty-interval message and `model.showLatest('24h')` action only when `!catalogLoading && hasCompletedEmptyInterval`.

`HistoryEmptyReason` is exactly `'no-selection' | 'no-finite-data' | null`; do not add a new state or change loader ownership. The accepted-data guard makes the action evidence-based even if a later hook transition accidentally reuses the empty status.

## Verification

Run the focused mobile tension component suite, then the core suite and core build. The result must demonstrate all three states independently: initial default selection is loading, a completed all-null response is interval-empty, and a deliberate zero selection asks the user to choose sources without transport.
