# Mobile History Slice 1 Core Corrections Implementation Plan

> **For implementer:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Correct the Slice 1 shared history core so only complete, policy-matched, current-revision Analysis data can enter the cache or visible state, while retaining the existing route and legacy chart behavior.

**Architecture:** Platform adapters convert their different Analysis payloads into one strict, platform-discriminated DTO. The public normalizer validates that DTO and creates one sanitized series array used by the renderer, bucket inspector, and empty-state predicate. `useHistoryWindow` owns selection intent, denied IDs, the last complete backing response, and display projection; `HistoryLoader` owns bounded transport caching and a minimum-revision admission fence. A new full-selection response replaces the backing response wholesale. Local removal and compatible re-add only project the retained response and never grow a union of old source sets.

**Tech Stack:** TypeScript 5.9, React 18 hooks, Vitest 4, Testing Library, uPlot.

**Parent plan:** `docs/superpowers/plans/2026-10-24-mobile-history-real-data-slice-1.md`, Task 1

**Review:** `docs/superpowers/reviews/2026-10-24-mobile-history-slice-1-task-1-review.md`

**Scope:** Change only `web/history-uplot-core`. Adopt the four root regressions into permanent core suites. Do not edit either product, vendor the package, add a route, add another cache, filter raw constituent readings, or change the existing card-history defaults.

## Required public contracts

Put these exports in `src/shared/types.ts`. The two adapters in Task 3 must populate every field; no field below is optional and the core must not infer missing interval ends, counts, quality, dropped rows, truncation, or grid facts.

```ts
export interface MobileAnalysisDtoPoint {
  at: number;
  value: number | null;
  count: number;
  quality: string | null;
}

export interface MobileAnalysisDtoSeries {
  seriesId: string;
  label: string;
  unit: string;
  truncated: boolean;
  points: readonly MobileAnalysisDtoPoint[];
}

export interface MobileAnalysisDroppedSeries {
  seriesId: string;
  reason: string;
}

export type MobileAnalysisGrid =
  | {
      platform: 'cloud';
      from: number;
      to: number;
      stepSeconds: number;
      bucketCount: number;
    }
  | {
      platform: 'edge';
      from: number;
      to: number;
    };

export interface MobileAnalysisResponseDto {
  readPolicy: Exclude<HistoryReadPolicy, 'card-default'>;
  coverage: { from: number; to: number };
  appliedAggregation: string;
  truncated: boolean;
  dropped: readonly MobileAnalysisDroppedSeries[];
  grid: MobileAnalysisGrid;
  series: readonly MobileAnalysisDtoSeries[];
}

export interface HistoryLoadContext {
  selectedIds: readonly string[] | undefined;
  selectionKey: string | undefined;
  requestRevision: number;
  readPolicy: HistoryReadPolicy;
}

export interface HistoryWindowOptions {
  // Existing fields stay unchanged.
  load(
    request: HistoryWindowRequest,
    signal: AbortSignal,
    context?: HistoryLoadContext,
  ): Promise<HistoryWindowResponse>;
}
```

The optional third argument preserves all existing two-argument loaders. The hook always supplies it. `selectedIds` preserves the UI order and is the only selection list a mobile transport may send. `selectionKey` remains a sorted, deduplicated identity string used for comparison; it is never transport order.

Replace the loose mobile error object with these closed inputs and results:

```ts
export type MobileAnalysisFailureInput =
  | { kind: 'network'; message: string }
  | { kind: 'http'; status: number; code: string | null; message: string };

export type MobileHistoryFailure =
  | { kind: 'auth'; status: 401 | 403; reason: string }
  | { kind: 'size'; status: 400 | 413; reason: string }
  | {
      kind: 'sources';
      missingIds: readonly string[];
      dropped: readonly MobileAnalysisDroppedSeries[];
      accessDeniedIds: readonly string[];
      reason: string;
    }
  | { kind: 'protocol'; code: MobileProtocolFailureCode; reason: string }
  | { kind: 'transient'; status: number | null; reason: string };

export class MobileAnalysisValidationError extends Error {
  constructor(readonly failure: Extract<MobileHistoryFailure,
    { kind: 'sources' | 'protocol' }>) {
    super(failure.reason);
    this.name = 'MobileAnalysisValidationError';
  }
}

export function normalizeMobileAnalysisResponse(
  dto: MobileAnalysisResponseDto,
  request: HistoryWindowRequest,
  selectedIds: readonly string[],
): MobileNormalizedResponse;

export function classifyMobileAnalysisFailure(
  input: MobileAnalysisFailureInput | MobileAnalysisValidationError,
): MobileHistoryFailure;
```

Define `MobileProtocolFailureCode` as a literal union for each validator branch: `invalid-selection-count`, `unexpected-read-policy`, `invalid-coverage`, `invalid-aggregation`, `response-truncated`, `duplicate-series`, `unrequested-series`, `invalid-unit`, `invalid-timestamp`, `invalid-cloud-grid`, `invalid-edge-grid`, and `http-error`. Missing selected IDs and any selected entry in `dropped` produce `kind: 'sources'`, preserving every dropped ID and reason and deriving `accessDeniedIds` from reason `access_denied`. Do not collapse these facts into a generic validation message.

`classifyMobileAnalysisFailure` maps network input and HTTP 5xx to `transient`, 401 and 403 separately to `auth`, any 413 to `size`, and only HTTP 400 with code `range_too_large` to `size`. Other HTTP input is `protocol`. The platform adapters must convert axios/fetch failures into `MobileAnalysisFailureInput`; the core must not guess network status by casting `unknown`.

Add the following loader and result contracts:

```ts
export interface HistoryLoader {
  // Existing methods stay unchanged.
  advanceSelectionRevision(context: HistoryContext): number;
}

export function historyResponseSatisfiesDemand(
  data: HistoryAcceptedData,
  demand: HistoryDemand,
): boolean;

export type HistoryEmptyReason = 'no-selection' | 'no-finite-data' | null;

export interface HistoryWindowResult {
  // Existing fields stay unchanged.
  emptyReason: HistoryEmptyReason;
}
```

`status` remains the existing union. Zero selection returns `status: 'empty'` with `emptyReason: 'no-selection'`. A complete loaded interval with no finite selected bucket returns `status: 'empty'` with `emptyReason: 'no-finite-data'`. Existing consumers that read only `status` remain source-compatible.

Use an opt-in formatting union for `ChartHostProps`:

```ts
type ChartHostFormattingProps =
  | { inspectionMode?: 'nearest-point'; locale?: never; timeZone?: never }
  | { inspectionMode: 'containing-bucket'; locale: string; timeZone: string };

export type ChartHostProps = ChartHostBaseProps & ChartHostFormattingProps;
```

The containing-bucket branch passes `locale` and `timeZone` to `mountAdapter` and uses them for initial and subscribed window readouts, inspector target, bucket interval, and values. A locale/timezone change remounts the adapter so its axis callbacks change. The omitted nearest-point branch preserves the pre-Slice-1 behavior exactly: adapter options omit locale/timezone, dates use browser-default `toLocaleString()` behavior, and values use raw string interpolation rather than significant-digit formatting.

## State ownership and admission algorithm

`useHistoryWindow` owns these refs and state for the active component:

- `selectionRef`: ordered, deduplicated intended IDs after denial filtering.
- `selectionRevisionRef`: monotonically increasing revision; increment before any selection side effect.
- `lastControlledSelectionKeyRef`: content key of the last applied `options.selectedIds`, so an unchanged prop does not overwrite a manual selection.
- `deniedIdsRef`: IDs denied within `sessionKey + scopeKey`; clear it only when that authorization scope changes.
- `acceptedRef`: the last complete, compatible full-selection response for the current full history identity. It may exceed 20,000 points because it is component state, not a second cache.
- `intent`: existing viewport/request generation fence.

Route prop changes and `selectSources` call the same `applySelection(nextIds)` function. It performs this order synchronously:

1. Deduplicate in first-occurrence order and remove `deniedIdsRef` members.
2. Return if the ordered result equals `selectionRef.current`.
3. Call `loader.advanceSelectionRevision(context)`, store its returned revision in `selectionRevisionRef`, and update `selectionRef.current` before scheduling or accepting more work. The loader, rather than a component-local counter, allocates revisions so an unmounted and remounted hook cannot reuse a lower revision in the same context.
4. Increment `intent`, clear selection debounce and prefetch timers, and update React selection state.
5. Project the retained backing response to the selected IDs. If it satisfies current coverage, aggregation, read policy, and contains every selected ID, publish it immediately with no load, including `8 -> 7 -> 8` when it exceeds the cache point limit.
6. For zero IDs, publish `empty/no-selection` and send no request. A pure removal stops without transport only when step 5 found complete compatible backing. If the reduced selection is not covered (for example, removal during the initial load), request the reduced full selection immediately so aborting the old request cannot strand the chart. For an addition not present in compatible backing, retain the compatible old projection, wait 150 ms, then request the full ordered selection.

`evictSeries(ids)` first adds IDs to `deniedIdsRef`, then calls the same selection transition with those IDs removed. It also evicts them from loader cache and backing response. A manual or controlled selection cannot restore them while the authorization scope is unchanged. The next valid response for the reduced full selection replaces backing; no partial response is committed.

The loader stores `currentSelectionRevision` per history context. `advanceSelectionRevision` increments and returns it, then aborts foreground and prefetch slots in that context with an older revision. A selected-ID hook calls it once before its initial request and on every later selection transition. `matchingSlot`, cache admission, and the resolve callback inside `makeSlot` all reject work below the current revision. This resolve-time check is required even when a transport ignores `AbortSignal`. Non-selection legacy demands keep `requestRevision` undefined and bypass this fence.

Every scheduled foreground and prefetch demand uses one immutable snapshot containing the decorated request, ordered IDs, sorted `selectionKey`, revision, and read policy. Pass the decorated request to `options.load`; never pass the undecorated neighbor request. Pass the same snapshot as the third load argument. Read `options.load` and callbacks through a render-updated options ref so timer effects do not retain an older loader closure.

Use `historyResponseSatisfiesDemand` in cache lookup, cache admission, accepted-state reuse, and the hook's direct response commit. It checks requested aggregation, visible coverage, all requested IDs, no truncation, and read policy; each caller separately checks the entry or accepted state's context identity. For a non-default policy, `response.readPolicy` must equal it. Only legacy `card-default` may treat an absent response policy as `card-default`. A mismatched response is not cached, merged, or displayed. Remove `mergeAccepted`: a complete response for the requested full selection replaces `acceptedRef` wholesale; local projection never mutates backing metadata.

`normalizeMobileAnalysisResponse` is the sole Analysis data boundary. It must:

1. Validate selected count `1..25`, exact read policy, hourly aggregation, global and per-series truncation, exact requested ID set, dropped rows, units, and finite timestamps. Both `coverage` and `grid.from..grid.to` must cover the logical request.
2. Validate cloud `stepSeconds === 3600`, positive integer `bucketCount`, `to === from + bucketCount * HOUR_MS`, exact point count in every series, and anchor `from + index * HOUR_MS`.
3. Validate edge first anchor equals `grid.from`, every next anchor is exactly one hour later, and the last interval ends at `grid.to` with width in `(0, HOUR_MS]`. Use the next anchor for intermediate ends and `grid.to` for the last end.
4. Preserve every DTO `count` and `quality`. Do not synthesize either value and do not create a bucket when grid facts are absent.
5. Convert only returned hourly averages outside finite `0..1_000_000 kPa` to null, set their quality to `invalid`, and increment `invalidHourlyAverageCount`. Do not inspect or claim to validate raw constituents.
6. Construct `SensorSeries.points` and `SensorSeries.buckets` from the same sanitized bucket array. The renderer and inspector therefore observe the same nulls and intervals. Preserve overlapping partial boundary buckets, including a cloud bucket anchored before logical `from` and an edge final bucket shorter than one hour.

Wire `visibleMobileAnalysisEmpty` into the hook for selected-ID mode. It returns true only after a compatible complete response covers the current viewport and no selected bucket overlapping that viewport has a finite non-null value. Pending, rejected, incomplete, or uncovered responses stay loading/error as appropriate and never become empty.

## Task A: Correct the DTO boundary, policy checks, failures, and formatting

**Files:**

- Modify: `web/history-uplot-core/src/shared/types.ts`
- Modify: `web/history-uplot-core/src/mobile/mobileTensionPolicy.ts`
- Modify: `web/history-uplot-core/src/history/historyLoader.ts`
- Modify: `web/history-uplot-core/src/ChartHost.tsx`
- Modify: `web/history-uplot-core/src/adapters/uplot.ts`
- Modify: `web/history-uplot-core/src/index.ts`
- Modify: `web/history-uplot-core/tests/mobileTensionPolicy.test.ts`
- Modify: `web/history-uplot-core/tests/historyLoader.test.ts`
- Modify: `web/history-uplot-core/tests/chartHost.test.tsx`
- Modify: `web/history-uplot-core/tests/uplot.test.ts`
- Adopt cases from: `web/history-uplot-core/tests/root-task1-regressions.test.tsx`

### A1. Write behavioral tests and prove they fail

Test through `normalizeMobileAnalysisResponse`, loader public methods, and rendered `ChartHost`; do not satisfy this task with export-presence or isolated-helper tests.

Add these cases:

- Cloud normalization rejects missing/dropped/duplicate/unrequested IDs, global or per-series truncation, wrong policy/unit/aggregation, incomplete coverage, malformed timestamps, and wrong grid step/count/end/anchors.
- Edge normalization rejects wrong first anchor, gaps, duplicate/unordered anchors, and an invalid final width. It preserves the returned shorter final end.
- Both platforms preserve `count`, `quality`, null positions, and an overlapping boundary bucket.
- The existing root invalid-average regression asserts that `1_000_001` is null in both normalized `response.series[0].points` and `window.series[0].buckets`; zero and `500_015.5` remain values.
- Missing/dropped failures retain IDs and reasons, including `access_denied`; network and 5xx are transient; 401, 403, any 413, explicit 400 `range_too_large`, and unrelated 400 remain distinct.
- A response with the wrong read policy cannot enter the cache. Cover direct foreground resolution, a joined slot, and prefetch admission.
- Containing-bucket mode supplies locale/timezone to the adapter and formats initial and subscribed windows, axis labels, bucket intervals, and values. Rerendering a changed locale/timezone updates all of them.
- Nearest-point mode omits adapter locale/timezone and retains the old default date and raw-number output.

Run:

```bash
cd web/history-uplot-core
npx vitest run tests/root-task1-regressions.test.tsx tests/mobileTensionPolicy.test.ts tests/historyLoader.test.ts tests/chartHost.test.tsx tests/uplot.test.ts
```

Expected: FAIL on the invalid plotted value, mandatory DTO/grid validation, structured failure details, read-policy admission, ChartHost adapter options/readouts, and legacy formatting.

### A2. Implement the contracts and make the focused tests pass

Replace the optional-bucket fallback with the mandatory DTO normalizer and implement the validation order above. Use the same policy-compatibility rule in loader lookup and admission. Implement the formatting union without changing standalone `mountUplot` defaults.

Run the same focused command. Expected: PASS.

## Task B: Correct selection ownership, revision admission, backing reuse, and empty state

**Files:**

- Modify: `web/history-uplot-core/src/shared/types.ts`
- Modify: `web/history-uplot-core/src/history/types.ts`
- Modify: `web/history-uplot-core/src/history/historyLoader.ts`
- Modify: `web/history-uplot-core/src/history/useHistoryWindow.ts`
- Modify: `web/history-uplot-core/tests/historyLoader.test.ts`
- Modify: `web/history-uplot-core/tests/useHistoryWindow.test.tsx`
- Adopt remaining cases from: `web/history-uplot-core/tests/root-task1-regressions.test.tsx`

### B1. Write behavioral tests and prove they fail

Drive `useHistoryWindow` through rerenders, public selection methods, deferred loads, fake timers, and a real `HistoryLoader`. Add these cases:

- The existing root controlled-selection regression: `options.selectedIds` changes from `['a', 'b']` to `['a']` in the same scope, filters immediately, and performs no load.
- Manual selection and later controlled prop changes use one transition path without an unchanged prop resetting the manual choice.
- The existing root denial regression: after `evictSeries(['b'])`, manual and controlled attempts to select `b` keep it excluded until `sessionKey` or `scopeKey` changes.
- A selection change aborts the old foreground before transport resolution. A transport that ignores abort and resolves later cannot enter cache or accepted state because its revision is below the loader floor.
- Prefetch receives the decorated request and load context. Foreground and prefetch both receive ordered IDs such as `['b', 'a']`, while their selection key is sorted.
- Changing `options.load` before a debounced addition uses the new function, not the closed-over old function.
- A retained response with more than 20,000 points supports `8 -> 7 -> 8` without transport. Adding a ninth absent series keeps the compatible old projection visible during debounce, then sends one full nine-ID request.
- Removing an addition before debounce sends no request when retained backing covers the reduced selection. Removing a source during the initial load aborts the old request and loads the reduced selection; it must not remain loading indefinitely. Resolving an older addition after another selection revision cannot replace backing.
- A successful full-selection response replaces backing wholesale. A later response does not union sources that belonged only to an earlier selection.
- A direct response with mismatched read policy and a would-be combination of different policies cannot commit. There is no merge path left.
- The existing root all-null regression reports `empty/no-finite-data`. Zero selection reports `empty/no-selection` and sends no request. Null buckets outside the visible interval do not make an otherwise finite visible interval ready; incomplete coverage never reports empty.

Run:

```bash
cd web/history-uplot-core
npx vitest run tests/root-task1-regressions.test.tsx tests/historyLoader.test.ts tests/useHistoryWindow.test.tsx
```

Expected: FAIL on controlled synchronization, denial persistence, late admission, ordered load context, accepted-backing reuse, replacement semantics, and empty reason.

### B2. Implement the ownership and admission algorithm

Implement `advanceSelectionRevision`, the render-updated options ref, and the single `applySelection` transition. Remove `mergeAccepted`. Keep the last complete response intact across local projections and replace it only after a complete compatible full-selection response passes the current identity, intent, revision, policy, coverage, aggregation, and ID checks.

Pass the decorated request and immutable `HistoryLoadContext` to both transport lanes. Compute `displayedIds` from selected IDs actually present in the current projection; do not equate it with intended `selectedIds` while an addition is pending.

Run the focused command again. Expected: PASS.

## Final verification

Run:

```bash
cd web/history-uplot-core
npm test
npm run build
```

Expected: all core tests pass and TypeScript reports no errors. The four root regressions must now exist in the permanent subject suites; remove the temporary root file only after proving those equivalent cases run in `npm test`.

Then inspect scope:

```bash
git diff --check
git status --short
git diff --stat 253095ad3..HEAD
```

Expected: no whitespace errors; only the shared-core source/tests and this reviewed correction plan are part of the correction work. Preserve root's review and report files. Do not vendor or integrate into edge/cloud products in this correction.

## Root review

Approved for correction round 1. A removal skips transport only with compatible complete backing; otherwise it must restart the reduced request after aborting the old one. This closes the initial-load cancellation gap in the draft. The other ownership and normalization decisions match the parent specification.
