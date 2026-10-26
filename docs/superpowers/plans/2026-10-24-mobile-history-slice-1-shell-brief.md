# Mobile history Slice 1 shell and route implementation brief

This brief resolves the implementation details for Task 4 of `2026-10-24-mobile-history-real-data-slice-1.md`. It depends on the reviewed Task 1 core corrections and Task 3 adapters. Keep the first tranche internal and limited to water tension, 24 hours and 7 days. Do not change either Analysis backend or add another cache, route framework, modal framework, measurement selector, calendar, profile, or irrigation UI.

## File and ownership boundary

The canonical package owns the product-neutral chart shell:

- Create `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx` and `mobileTension.css`.
- Export the shell and its public types from `web/history-uplot-core/src/index.ts`.
- Add interaction tests in `web/history-uplot-core/tests/mobileTensionHistory.test.tsx`.
- Import the existing mobile chart styles and render the root with both `mobile-soil-history` and `mobile-tension-history`. `SeriesLegend` rules currently depend on the first class. Put every new rule under `.mobile-tension-history` so legacy imports of the package index cannot alter another page.

Each platform wrapper owns authentication context, zone lookup, timezone validation, catalog loading, request policy, translation, and routing:

- Edge: `web/react-gui/src/pages/MobileTensionHistoryRoute.tsx` and `src/history/mobileHistoryInternalGate.ts`.
- Cloud: `frontend/src/pages/MobileTensionHistoryRoute.tsx` and `src/history/mobileHistoryInternalGate.ts`.
- The edge implementation is canonical. Vendor the reviewed package into the cloud only after its focused tests and build pass.

The adapters own wire parsing and failure classification. The shell must not inspect Axios errors, response JSON, or arbitrary error messages.

## Shared shell contract

Use the existing core types instead of introducing parallel source, response, or failure models. The Task 4 public surface should be equivalent to:

```ts
export interface MobileTensionHistoryLabels {
  title: string;
  chart: string;
  waterTension: string;
  controls: string;
  time: string;
  timeRange: string;
  range24h: string;
  range7d: string;
  latest: string;
  hourlyAverages: string;
  hourlyAverage: string;
  loading: string;
  refreshing: string;
  emptyInterval: string;
  showLatest24h: string;
  unavailableValue: string;
  notLoaded: string;
  chooseSources: string;
  historicalUnverified: string;
  sources: string;
  chartSources: string;
  openSources: string;
  sourceDiscoveryIncomplete: string;
  catalogFailed: string;
  unavailableSources: string;
  requestTooLarge: string;
  fewerSourcesOrShorterWindow: string;
  accessDenied: string;
  incompleteResponse: string;
  transientFailure: string;
  retry: string;
  details: string;
  close: string;
  sourceCap(limit: number): string;
  sourceCount(selected: number, total: number): string;
  invalidHourlyAverages(count: number): string;
  removedSources(names: string): string;
  removeSource(name: string): string;
  transportCoverage(from: string, to: string): string;
  bucketInterval(from: string, to: string): string;
  latestBucket(at: string): string;
  seriesLegend: {
    legend: string;
    showAll: string;
    plottedSeries: string;
    seriesCount(count: number): string;
    focusAnnouncement(label: string): string;
    allSeriesAnnouncement: string;
  };
  pinnedReading: string;
  visibleWindow: string;
}

export interface MobileTensionHistoryProps {
  sources: readonly MobileTensionSource[];
  defaultSelectedIds: readonly string[];
  catalogError: MobileHistoryError | HistoryAuthError | null;
  catalogLoading: boolean;
  context: HistoryContext;
  readPolicy(request: HistoryWindowRequest): HistoryReadPolicy;
  locale: string;
  timeZone: string;
  zoneLabel: string;
  labels: MobileTensionHistoryLabels;
  load: HistoryWindowOptions['load'];
  refreshCatalogForGeneration(generation: number): Promise<void>;
  onAuthError(error: HistoryAuthError): void;
}
```

Use the final exported type names from Task 1 if they differ. Do not weaken the callback or error types to `string`, `Error`, or `unknown`. `readPolicy` is a request-dependent callback because cloud changes policy at the 24-hour boundary. `refreshCatalogForGeneration` maps directly to the adapter hook's `refreshForGeneration(generation)`; there is no unscoped `refreshCatalog()` call.

Pass every `ChartHost` label explicitly: `pinnedReading`, `close`, `unavailable`, `visibleWindow`, `hourlyAverage`, and `bucketInterval`, plus `notLoadedLabel`. Pass all six `SeriesLegend` labels explicitly. The shell must not expose the English component defaults to users of another locale.

## Composition and state

Render a compact zone eyebrow, then the water-tension title and Time control on the same wrapping row, as in the approved preview. Include a short zone-local date summary beside Time. Keep Sources compact and all controls at least 44 px; below the controls render the `Hourly averages` caption, unit row, `ChartHost`, and `SeriesLegend`. Time and Sources open bottom sheets. Details is a disclosure for invalid-average count, transport coverage, and the latest finite bucket for each selected series.

Render `kPa` in the unit row from the fixed water-tension catalog contract even while the catalog is loading, the interval is empty, or zero sources are selected. A catalog source with another unit never reaches this shell because the adapter excludes it.

Initialize selected IDs once from `defaultSelectedIds` for a new session and zone. A later catalog result reconciles the existing selection but never restores defaults after a deliberate empty selection. Keep source inclusion separate from legend focus:

- Source inclusion drives `useHistoryWindow`; zero selected sources sends no request and shows Choose sources.
- Legend focus changes only `ChartHost` emphasis and never selection, viewport, cache keys, or network work.
- Assign `getSeriesAppearance(index)` from each source's index in the complete deterministic catalog order before filtering to selected or displayed sources. Removing and restoring a source must not recolor the others.
- Use `analysisHourlyRangeStrategy`, a Unix-epoch-to-current-minute horizon, a one-hour minimum, and a seven-day maximum. Use only the 24 h and 7 d presets plus Latest.
- Build `viewportIdentity` as `[sessionKey, zoneId, 'water-tension'].join('|')`. Never put selected IDs or request revision in `context.sourceKey`.
- Preserve compatible accepted points at their true timestamps while additions, refreshes, or viewport requests load. Never place an old point into a new hour or commit a partial response as complete.
- Keep the zone-local date summary's viewport subscription below the shell boundary so a pan or pinch updates only that readout. If implementation instead subscribes the shell, memoize the accepted-series projection and appearance mapping against their backing accepted data and selection inputs. `useHistoryWindow` currently creates a new filtered `series` array whenever its owner renders with controlled selection, and `ChartHost` treats a changed `series` reference as new data. A viewport-only update must not therefore call the chart adapter's `setData`; it should update only the adapter viewport and date readout.

The source sheet lists every discoverable eligible source. At 25 selected sources, additional unselected rows remain visible and explain why their controls are disabled; selected rows remain removable. Sources that disappear from a refreshed catalog are removed immediately. The shell never silently substitutes another source.

## Failure and recovery ownership

The shell owns visible recovery because it owns selection, displayed backing data, and the Time and Sources controls. The platform wrapper supplies classified adapter errors and the catalog refresh function. The catalog hook is the second-line deduplication guard.

The shell owns one monotonically increasing failure generation. Allocate a new generation for each distinct source failure or user catalog-retry action, and call `refreshCatalogForGeneration(generation)` exactly once for that generation. Do not automatically repeat the failed series request. A repeated render or duplicate notification must reuse the generation; the hook then also refuses a second refresh.

Handle failures as follows:

| Failure | Shell behavior | Recovery |
| --- | --- | --- |
| `HistoryAuthError` 401 | Clear/hide route data immediately and call the platform's existing session-expiry path. | Existing protected-route login flow. |
| `HistoryAuthError` 403 | Clear/hide route data and show Access denied; do not log out. | Leave the route or retry only after the surrounding authorization state changes. |
| `MobileHistoryError` `sources` with access-denied IDs | Call `evictSeries(ids)` immediately, disable those sources, and refresh the catalog once for the failure generation. A stale refresh must not re-enable them. | Explain which sources were removed. |
| Other `sources` failure | Retain only previously accepted compatible data; never commit the incomplete subset. Refresh the catalog once. | Show each affected source with a one-tap exclusion action. The first plot remains unavailable until a complete reduced request or compatible cache entry exists. |
| `size` | Retain compatible data and show the size explanation. | Open Time and Sources actions; omit Retry because it would repeat the same request. |
| `transient` | Retain compatible data and show the transient message. | Retry repeats the series request. |
| `protocol` | Retain compatible data when available and show Incomplete response. | No automatic repeat and no raw error text. |

Catalog initial-load and revalidation failures use the same closed taxonomy. Convert them at the platform adapter boundary rather than in JSX. A catalog 401 follows session expiry, a catalog 403 clears the route and shows Access denied, and a transient catalog error shows Source discovery incomplete with Retry. That Retry allocates a new generation and calls `refreshCatalogForGeneration` once. Never reveal server, Axios, or exception messages.

`MobileHistoryError.failure` must reach the shell unchanged. `HistoryAuthError`, cancellation, and `HistoryAbortError` retain the behavior defined in the adapter brief. Do not wrap or stringify them in the route.

## Chart geometry and narrow layout

Keep the approved preview geometry rather than generically restyling the chart:

- Chart frame height is `clamp(22rem, 58vh, 38rem)` with a `22rem` minimum.
- The unit is a normal-flow row immediately before `ChartHost`. Give its inline wrapper the width `PLOT_INSETS.left`, then apply `transform: translateX(-14px)` to align the unit's right edge with numeric Y tick text. Keep `min-height: 1rem`, `line-height: 1.4`, `font-size: .7rem`, `font-weight: 700`, `align-items: flex-end`, `justify-content: flex-end`, and `pointer-events: none`.
- Document the 14 px adjustment beside the rule: uPlot's default numeric tick ends 10 px before the tick plus a 5 px axis gap, offset by the 1 px host border.
- Preserve `PLOT_INSETS` and plot height. Do not put the unit in the gesture overlay or reserve an absolute 16 px top gutter.
- Keep the visible-window readout clear of axis text. At 200% text, labels may wrap without clipping, horizontal page overflow, or covering the plot.
- Use the approved compact legend behavior. Do not hide series names to make the layout fit.

## Bottom-sheet accessibility

Implement one small bottom-sheet component inside `MobileTensionHistory.tsx` or beside it in the shared mobile folder. Follow the existing platform `useModalFocus` behavior without importing a host hook or creating a general modal package:

- Render `role="dialog"`, `aria-modal="true"`, a localized accessible name, and a visible localized Close control.
- Focus the first enabled control on open.
- Trap Tab and Shift+Tab within the sheet, contain stray focus, and close on Escape.
- Restore focus to the button that opened the sheet.
- Keep inactive sheet content unmounted. If sheets can replace each other, only the top sheet handles focus and Escape.
- Use 44 px minimum controls, a fixed bottom layout no wider than 480 px, and `max-height: min(90vh, 42rem)` with internal scrolling.

Tests must use keyboard behavior and focus restoration, not only ARIA attributes.

## Platform routes and gates

Both gates must return true only for the exact string `'true'`:

```ts
export const mobileHistoryInternalEnabled = (value: unknown): boolean => value === 'true';
export const MOBILE_HISTORY_INTERNAL_ENABLED = mobileHistoryInternalEnabled(
  import.meta.env.VITE_MOBILE_HISTORY_INTERNAL,
);
```

In `App.tsx`, the lazy expression itself must use `import.meta.env.VITE_MOBILE_HISTORY_INTERNAL === 'true' ? lazy(() => import('./pages/MobileTensionHistoryRoute')) : null`. Do not rely on Vite evaluating a call to the gate helper to remove the import; the helper pins parsing behavior in tests.

Add `VITE_MOBILE_HISTORY_INTERNAL?: string` to both `vite-env.d.ts` files. Put the lazy import inside the literal enabled branch so a false production build contains no internal route chunk. Add no navigation link, query override, or local-storage override.

The edge path is `#/internal/mobile-history/zones/:zoneId` under its existing `HashRouter`. The cloud path is `/internal/mobile-history/zones/:zoneId` under its existing `BrowserRouter`. In both applications:

- Keep the route inside the existing private-route/session boundary. Edge adds route-local `Suspense`; cloud may use its existing global `Suspense`.
- When disabled, the matching route redirects to `/history`.
- Accept only a decimal positive safe integer zone parameter. Redirect malformed parameters to `/history` before any Analysis request.
- Load zones with the existing `irrigationZonesAPI.getAll()`. While the zone list loads, show localized loading. A zone-list transport failure shows localized Retry; it must not be treated as an inaccessible zone. After a successful list response, redirect an absent or inaccessible zone ID to `/history`.
- Require a nonempty timezone accepted by `Intl.DateTimeFormat`; accept `UTC`. A missing or invalid value renders the localized timezone-unavailable state and disables both catalog and series calls.
- Use `i18n.resolvedLanguage ?? i18n.language`.

Build the history context exactly as:

```ts
{
  sessionKey,
  scopeKey: `zone:${zoneId}`,
  cardId: 'mobile-water-tension',
}
```

Edge obtains `sessionKey` from `useAuth().sessionIdentity` with `serializeSessionIdentity` in `services/authSession.ts` and always supplies `edge-hourly`. Cloud uses the serializer in `contexts/AuthSessionDataBoundary.tsx` and supplies `cloud-raw-hourly` when the logical span is at most 24 hours, otherwise `cloud-rollup-hourly`.

Each wrapper calls its platform `useMobileTensionCatalog({ enabled, zoneId, sessionKey })` and passes `sources`, `defaultSelectedIds`, `error`, `isLoading`, and `refreshForGeneration` directly into the shared contract. `enabled` requires a valid zone, valid timezone, active session, and enabled route gate.

The route itself also needs localized `zoneLoading`, `zonesFailed`, `retry`, `timeZoneUnavailable`, and `accessDenied` strings for states rendered before the shared shell mounts. Keep these in the same `history` namespace; they do not need to become unused shell props.

## Localization

Add every shell, error, Details, source, ChartHost, SeriesLegend, dialog, loading, retry, and timezone label in this brief to all seven existing `history` namespaces: `en`, `de-CH`, `fr`, `it`, `es`, `pt`, and `lg`. Reuse a key only when its full meaning and placeholders match. Keep reviewed translations for the European locales. Copy new English text to Luganda only under the existing pending-translation process; do not replace existing human Luganda.

Both applications already register the `history` namespace and these locales. No `i18n/config.ts` change is needed unless implementation evidence shows a missing namespace registration.

## Focused verification

The shared shell tests must cover:

- initial default selection, deliberate empty selection, `8 -> 7 -> 8`, an addition removed before completion, and rejection of its late response;
- independent legend focus, stable appearances, and unchanged viewport/network state when focus changes;
- 26 visible sources with the 26th disabled at the cap and selected rows removable;
- the failure table above, including exactly one catalog refresh per failure generation and both catalog and series 401/403 behavior;
- empty, loading, refreshing, zero, invalid-average gap, first-load incomplete, retained compatible data, source eviction, and Details disclosure states;
- repeated gesture-sourced viewport updates change the zone-local date summary and adapter viewport without replacing unchanged chart data or calling the adapter's `setData` again;
- Time and Sources focus trapping, Escape, focus restoration, localized accessible names, and 44 px controls.

Each route test must cover the exact gate, protected composition, disabled redirect, strict parameter parsing, zone-list loading/failure/retry, absent-zone redirect after a successful response, missing/invalid timezone with no Analysis calls, UTC acceptance, correct session/context/policy wiring, and catalog initial/refetch 401 and 403 handling. Keep the existing HashRouter and BrowserRouter forms under test.

Task 5 browser coverage must port the approved real-canvas alignment probe. At 320 px and 448 px, with normal and 200% root text, intercept numeric uPlot `fillText` calls only when `textAlign === 'right'` and `textBaseline === 'middle'`. The recorded `x` is the tick label's right anchor; do not add `measureText()` width. Assert the unit is inside the chart frame, left of the plot, no lower than the plot top, and within 1 CSS px of the rightmost numeric tick anchor. Also assert no clipping or horizontal viewport overflow and preserve the existing real touch gesture/navigation scenarios.

## Amendments to the parent Task 4 plan

Before implementation, update the parent plan in these four places:

1. Replace scalar `readPolicy` and `refreshCatalog()` with `readPolicy(request)` and `refreshCatalogForGeneration(generation)`, matching the hook's `refreshForGeneration` API.
2. Expand `MobileTensionHistoryLabels` to cover every `ChartHost`, `SeriesLegend`, dialog, loading, catalog, timezone, and recovery string listed here. Keep `HistoryAuthError` and `MobileHistoryError.failure` typed through the route.
3. Remove the planned `i18n/config.ts` edits from both platforms unless a focused test proves the existing `history` registration incomplete.
4. Add the real canvas tick-anchor assertion to Task 5 at 320 px and 448 px under normal and 200% text, and add zone-list transport retry plus catalog initial/refetch 401/403 to the route tests.

## Root review

Approved with a closed catalog-error prop (`MobileHistoryError | HistoryAuthError | null`) and a literal env comparison at the lazy import. Timezone-unavailable is a route label only. These resolve contradictions in the draft without expanding the product scope. The four parent-plan amendments above are accepted.

The optional browser diagnostics reader and exact-string diagnostics gate are defined in the [browser brief](2026-10-24-mobile-history-slice-1-browser-brief.md). Include that seam in the Task 4 canonical commit before vendoring; it reports the actual adapter viewport and remains absent unless the explicit internal diagnostics build flag is enabled.
