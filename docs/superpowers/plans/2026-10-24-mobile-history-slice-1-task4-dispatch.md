# Mobile history Slice 1 Task 4 dispatch

Use this split only after the reviewed Task 3 corrections are present. The [shell brief](2026-10-24-mobile-history-slice-1-shell-brief.md) and [browser brief](2026-10-24-mobile-history-slice-1-browser-brief.md) remain the behavior contracts. This note assigns files and fixes the label interface so three workers can proceed without editing the same files.

## Shared boundary

Both platform routes import this platform-local function:

```ts
import type { TFunction } from 'i18next';
import type { MobileTensionHistoryLabels } from '@osi/history-uplot';

export function mobileTensionLabels(
  t: TFunction<'history'>,
): MobileTensionHistoryLabels;
```

Edge places it at `web/react-gui/src/history/mobileTensionLabels.ts`; cloud places it at `frontend/src/history/mobileTensionLabels.ts`. Worker C owns both files. Worker B calls the function with `useTranslation('history').t` and uses `t(...)` directly only for route states that appear before the shared shell mounts.

All new keys live below `history.mobileTension` in each platform's `history.json`. Do not add or change locale registration. Do not reuse a differently scoped key merely because its current English text is the same.

## Worker A: canonical shell and diagnostics

Worker A owns only the canonical package:

- create `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx`;
- create `web/history-uplot-core/src/mobile/mobileTension.css`;
- modify `web/history-uplot-core/src/ChartHost.tsx` for the optional adapter-backed diagnostics reader;
- modify `web/history-uplot-core/src/index.ts` to export the shell and public diagnostics types;
- create `web/history-uplot-core/tests/mobileTensionHistory.test.tsx`;
- modify `web/history-uplot-core/tests/chartHost.test.tsx` for registration, actual adapter viewport/plot geometry, and unregister-before-destroy coverage.

Keep any bottom-sheet helper private beside `MobileTensionHistory.tsx`; do not create a host modal framework. Define diagnostics types in the owning shell or ChartHost module and re-export them from `index.ts`; do not broaden shared domain types solely to hold test instrumentation.

Implement all shell states, failure-generation ownership, source selection, stable appearance assignment, focus behavior, accessibility, unit geometry, and narrow-layout rules from the shell brief. The shell creates the injected `HistoryLoader`, passes it to `useHistoryWindow`, and destroys it on unmount. Its diagnostics snapshot combines the loader, viewport store, shell state, and the reader registered by ChartHost. Before ChartHost is ready and after it unregisters, renderer fields are `null` and `snapshot()` does not throw.

Keep the zone-local date readout subscription below the shell render boundary, or memoize the accepted projection and appearances by backing data and selection. The focused test must prove gesture viewport updates do not cause another adapter `setData` call when chart data and selection did not change.

Worker A does not edit either application, locale file, route, adapter, or cloud vendor tree. After A passes `npm test` and `npm run build` in `web/history-uplot-core`, root runs the reviewed vendor sync; no worker hand-edits `frontend/vendor/history-uplot-core/**`.

## Worker B: platform routes and gates

Worker B owns these edge files:

- create `web/react-gui/src/pages/MobileTensionHistoryRoute.tsx`;
- create `web/react-gui/src/history/mobileHistoryInternalGate.ts`;
- modify `web/react-gui/src/App.tsx`;
- modify `web/react-gui/src/vite-env.d.ts`;
- create `web/react-gui/src/pages/__tests__/MobileTensionHistoryRoute.test.tsx`;
- create `web/react-gui/src/history/__tests__/mobileHistoryInternalGate.test.ts`;
- create `web/react-gui/src/__tests__/AppMobileTensionHistoryRoute.test.tsx` if an App-level lazy-chunk assertion cannot live in the route test.

Worker B owns the matching cloud files:

- create `frontend/src/pages/MobileTensionHistoryRoute.tsx`;
- create `frontend/src/history/mobileHistoryInternalGate.ts`;
- modify `frontend/src/App.tsx`;
- modify `frontend/src/vite-env.d.ts`;
- create `frontend/src/pages/__tests__/MobileTensionHistoryRoute.test.tsx`;
- create `frontend/src/history/__tests__/mobileHistoryInternalGate.test.ts`;
- modify `frontend/src/__tests__/AppRouting.test.tsx` only for the internal-route lazy-gate cases.

Implement the exact route paths, positive-safe-integer parsing, existing private/session boundaries, zone loading and retry, absent-zone redirect, timezone validation, session serialization, context, request-dependent read policy, auth behavior, and catalog wiring from the shell brief. The literal conditional around each lazy import is required. Type both `VITE_MOBILE_HISTORY_INTERNAL` and `VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS`; publish diagnostics only when both exact-string gates are true and delete the global only when the unmounting route still owns it.

Use `mobileTensionLabels(t)` for the shared shell. Route-local calls are limited to `history.mobileTension.route.zoneLoading`, `.zonesFailed`, and `.timeZoneUnavailable`, plus the shared `.retry` and `.accessDenied` keys. Worker B does not add fallback English, locale JSON, label-builder code, canonical package code, or vendor files.

The route tests own the full route matrix from the shell brief, including catalog initial/refetch 401 and 403. App tests prove disabled redirect and that the false production branch has no lazy import. Bundle-manifest and full browser behavior remain Task 5.

## Worker C: labels and locale parity

Worker C owns these edge files:

- create `web/react-gui/src/history/mobileTensionLabels.ts`;
- create `web/react-gui/src/history/__tests__/mobileTensionLabels.test.ts`;
- modify `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/history.json`;
- modify `web/react-gui/src/history/__tests__/historyLocaleKeys.test.ts` and `historyLocaleValues.test.ts`;
- modify `docs/i18n/pending-luganda-translations.md`.

Worker C owns these cloud files:

- create `frontend/src/history/mobileTensionLabels.ts`;
- create `frontend/src/history/__tests__/mobileTensionLabels.test.ts`;
- modify `frontend/public/locales/{en,de-CH,fr,it,es,pt,lg}/history.json`;
- modify `frontend/src/i18n/__tests__/localeParity.test.ts` only if its existing automatic parity checks need an explicit regression assertion for this key group.

The two builders must have identical structure, keys, and placeholder names. Tests call every function-valued label and prove no `{{...}}` token leaks into output. Translate and review `de-CH`, `fr`, `it`, `es`, and `pt`; de-CH must contain no `ß`. Edge `lg` copies the English values for this new group, lists every new leaf in `PENDING_HUMAN_LUGANDA`, and adds one grouped row to the pending-translation document. Cloud `lg` is also byte-identical to English under its existing parity rule and does not enter the frozen legacy allowlist.

Worker C does not edit routes, `App.tsx`, the canonical package, adapters, or vendor files. Sol reviews the five European translations and placeholder placement before integration.

## Binding English key map

The builder maps these keys one-for-one to `MobileTensionHistoryLabels`:

| Label field | Key below `history.mobileTension` | English value |
| --- | --- | --- |
| `title` | `title` | `Water tension history` |
| `chart` | `chart` | `Water tension chart` |
| `waterTension` | `waterTension` | `Water tension` |
| `controls` | `controls` | `History controls` |
| `time` | `time` | `Time` |
| `timeRange` | `timeRange` | `Time range` |
| `range24h` | `range24h` | `24 hours` |
| `range7d` | `range7d` | `7 days` |
| `latest` | `latest` | `Latest` |
| `hourlyAverages` | `hourlyAverages` | `Hourly averages` |
| `hourlyAverage` | `hourlyAverage` | `Hourly average` |
| `loading` | `loading` | `Loading history…` |
| `refreshing` | `refreshing` | `Updating history…` |
| `emptyInterval` | `emptyInterval` | `No data in this interval.` |
| `showLatest24h` | `showLatest24h` | `Show latest 24 hours` |
| `unavailableValue` | `unavailableValue` | `Unavailable in this hour` |
| `notLoaded` | `notLoaded` | `Not loaded` |
| `chooseSources` | `chooseSources` | `Choose sources` |
| `historicalUnverified` | `historicalUnverified` | `Historical source; current assignment unverified` |
| `sources` | `sources` | `Sources` |
| `chartSources` | `chartSources` | `Chart sources` |
| `openSources` | `openSources` | `Choose chart sources` |
| `sourceDiscoveryIncomplete` | `sourceDiscoveryIncomplete` | `Source discovery is incomplete.` |
| `catalogFailed` | `catalogFailed` | `Sources could not be loaded.` |
| `unavailableSources` | `unavailableSources` | `Some sources are unavailable.` |
| `requestTooLarge` | `requestTooLarge` | `This request is too large.` |
| `fewerSourcesOrShorterWindow` | `fewerSourcesOrShorterWindow` | `Choose fewer sources or a shorter time range.` |
| `accessDenied` | `accessDenied` | `Access denied.` |
| `incompleteResponse` | `incompleteResponse` | `The history response was incomplete.` |
| `transientFailure` | `transientFailure` | `History is temporarily unavailable.` |
| `retry` | `retry` | `Retry` |
| `details` | `details` | `Details` |
| `close` | `close` | `Close` |
| `pinnedReading` | `pinnedReading` | `Pinned reading` |
| `visibleWindow` | `visibleWindow` | `Visible time window` |
| `seriesLegend.legend` | `seriesLegend.legend` | `Legend` |
| `seriesLegend.showAll` | `seriesLegend.showAll` | `Show all` |
| `seriesLegend.plottedSeries` | `seriesLegend.plottedSeries` | `Plotted series` |
| `seriesLegend.allSeriesAnnouncement` | `seriesLegend.allSeriesAnnouncement` | `All series shown` |

Function-valued labels use exactly these placeholders:

| Label field | Key below `history.mobileTension` | English value |
| --- | --- | --- |
| `sourceCap(limit)` | `sourceCap` | `You can select up to {{limit}} sources.` |
| `sourceCount(selected, total)` | `sourceCount` | `Selected {{selected}} of {{total}} sources.` |
| `invalidHourlyAverages(count)` | `invalidHourlyAverages` | `Invalid hourly averages: {{count}}.` |
| `removedSources(names)` | `removedSources` | `Removed sources: {{names}}.` |
| `removeSource(name)` | `removeSource` | `Remove {{name}}` |
| `transportCoverage(from, to)` | `transportCoverage` | `Loaded from {{from}} to {{to}}.` |
| `bucketInterval(from, to)` | `bucketInterval` | `From {{from}} to {{to}}.` |
| `latestBucket(at)` | `latestBucket` | `Latest hourly average: {{at}}.` |
| `seriesLegend.seriesCount(count)` | `seriesLegend.seriesCount` | `Series shown: {{count}}` |
| `seriesLegend.focusAnnouncement(label)` | `seriesLegend.focusAnnouncement` | `Focused series: {{label}}` |

Route-only keys use this same group:

| Full key | English value |
| --- | --- |
| `history.mobileTension.route.zoneLoading` | `Loading zone…` |
| `history.mobileTension.route.zonesFailed` | `Zones could not be loaded.` |
| `history.mobileTension.route.timeZoneUnavailable` | `This zone has no usable time zone.` |

## Integration order

Root integrates A's canonical package first and runs the vendor sync. C's two builders and locale files land next. B's route commits then resolve against both interfaces without moving ownership. Run the focused package, route, and locale tests after combining the three commits, followed by the platform checks already required by Task 4. Any correction stays with the worker that owns the affected file; do not fix a failing route by adding strings inside the shell or by editing generated vendor files.

## Root review

Approved. Hourly inspection uses “Unavailable in this hour” and “Latest hourly average” to describe the displayed aggregate without exposing bucket terminology. Keep the required focus/race/error and gesture redraw assertions in each worker's handoff; a passing build alone does not close its task.
