# Mobile history Slice 1 adapter implementation brief

This brief resolves the repository-specific details for Task 3 of `2026-10-24-mobile-history-real-data-slice-1.md`. Implement the approved shared contracts from `2026-10-24-mobile-history-slice-1-core-corrections.md`; do not add a second response model or move shared validation into either product.

## Existing HTTP contracts

Both frontends already declare camelCase Analysis types and send camelCase JSON. Keep that casing.

| Fact | Edge | Cloud |
| --- | --- | --- |
| Catalog | `GET /api/analysis/channels` | `GET /api/v1/analysis/channels` |
| Series | `POST /api/analysis/series` | `POST /api/v1/analysis/series` |
| Request | `{ selectors: [{ seriesId }], range: { mode, label, from, to }, aggregation }` | Same |
| Catalog response | `{ generatedAt, channels, sources }` | `{ generatedAt, channels }` |
| Resolved range | `{ from, to }`; current TypeScript also permits `label` and `timezone`, but the Node helper does not emit them | `{ label, from, to, timezone: "UTC" }` |
| Aggregation | `{ requested, applied }` | `{ requested, applied, bucketSizeSeconds }` |
| Grid | Absent | `{ stepSeconds, from, to, bucketCount }` |
| Point | `{ t, value, count, quality }`; `quality` is often null | `{ t, value, count, quality }`; aligned gaps use `0` and `"gap"`, values use `"ok"` |
| Series | `{ seriesId, resolved, label, unit, points, truncated, cadence, timezone }` | `{ seriesId, resolved, label, unit, coveragePct, points, truncated }` |
| Dropped | `{ seriesId: string | null, reason }` | Same |
| Oversize | HTTP 413 with `{ error, suggestion }`; there is no code | HTTP 400 whose Spring detail/reason is `range_too_large` |

The edge helper returns the exact requested range. The mobile edge request builder must floor `from` and ceil `to` to UTC hour boundaries, so that returned range is also the edge grid. Cloud receives the logical timestamps unchanged; `AnalysisGrid` floors and ceils them and emits the resulting grid.

Correct the product TypeScript declarations while adding the adapters:

- Edge `AnalysisPoint.quality` is `string | null`, not `string`.
- Edge response fields that the helper does not emit remain optional; the mobile adapter must require only the facts used above.
- Cloud `AnalysisPoint.quality` should be `string | null` because the Java record permits null even though the current aligner emits `ok` or `gap`.
- Keep `AnalysisDropped.seriesId` nullable. The adapter must reject a null or blank dropped ID as shared protocol code `unrequested-series`; never coerce it to an empty ID or discard it.

## Catalog mapping

Create the same exported surface in both `mobileMeasurementCatalog.ts` files:

```ts
export function normalizeMobileTensionCatalog(
  response: AnalysisCatalogResponse,
  zoneId: string,
): MobileTensionSource[];

export function initialMobileTensionSelection(
  sources: readonly MobileTensionSource[],
  zoneId: string,
  savedIds: readonly string[] | undefined,
): { selectedIds: string[]; unavailableIds: string[] };
```

Filter catalog rows to the numeric zone represented by `zoneId`, `cardType === 'soil'`, `channelKey` matching `swt_1|swt_2|swt_3`, `unit === 'kPa'`, `availability === 'available'`, and `legacy !== true`. Reject a non-finite zone ID before comparing. Map fields without constructing or translating an opaque ID:

| `MobileTensionSource` | Catalog field |
| --- | --- |
| `seriesId` | `seriesId` verbatim |
| `sourceKey` | `sourceKey` verbatim |
| `channelKey` | `channelKey` verbatim |
| `label` | `displayName` |
| `unit` | literal `kPa` after the equality check |
| `zoneId` | `String(entry.zoneId)` |
| `depthCm` | `depthCm` |
| `available` | `availability === 'available'` |
| `legacy` | `legacy === true` |
| `measurementKind` | `soil` |
| `status` on edge | `configurationState ?? 'unknown'` |
| `status` on cloud | `unknown` |

Leave `deviceId` unset. Edge `deviceSourceId` is an Analysis source record ID, not a device identifier, and cloud has no matching field. Repeated devices or depths stay distinct through `seriesId` and `sourceKey`.

When `savedIds` is undefined, `initialMobileTensionSelection` returns the IDs from shared `selectMobileTensionSources`, which orders by source key, channel key, and series ID and takes eight. When `savedIds` is present, including `[]`, call shared `reconcileMobileSelection`; this preserves a deliberate empty selection and reports vanished IDs. Keep edge `other_supported` rows in `sources` for the chooser but let the shared default selector leave them unchecked. Cloud rows use `unknown` and may be selected by default.

## Request and response adapters

Create these platform-specific exports in each `mobileAnalysisHistoryAdapter.ts`:

```ts
export function buildMobileAnalysisRequest(
  ids: readonly string[],
  logical: HistoryWindowRequest,
): AnalysisSeriesRequest | null;

export function adaptMobileAnalysisResponse(
  raw: AnalysisSeriesResponse,
  logical: HistoryWindowRequest,
  load: HistoryLoadContext,
): MobileNormalizedResponse;

export function createMobileAnalysisLoader(): HistoryWindowOptions['load'];

export function toMobileFailureInput(error: unknown): MobileAnalysisFailureInput;
```

`buildMobileAnalysisRequest` deduplicates nothing. Return null for zero IDs; reject duplicates or more than 25 IDs with `MobileAnalysisValidationError` and code `invalid-selection-count`. Preserve ID order in `selectors`. Set `mode: 'custom'`, `aggregation: 'hourly'`, and label `24h` when `logical.to - logical.from <= 24 * HOUR_MS`, otherwise `7d`.

For edge, serialize `from = floor(logical.from / HOUR_MS) * HOUR_MS` and `to = ceil(logical.to / HOUR_MS) * HOUR_MS`. For cloud, serialize the logical bounds exactly. Both use `new Date(value).toISOString()`.

`createMobileAnalysisLoader` requires the hook's third `HistoryLoadContext`. Reject a missing context or missing `selectedIds`; zero IDs returns an empty-selection error without HTTP. Require `edge-hourly` on edge. On cloud require `cloud-raw-hourly` for a logical span at most 24 hours and `cloud-rollup-hourly` for a larger span. Call `analysisAPI.getSeries(hostRequest, { signal })`, adapt the response, and return `normalized.response`.

Build the mandatory shared DTO as follows:

- `readPolicy`: `load.readPolicy` after the platform check.
- `coverage`: parsed milliseconds from `raw.range.from/to`.
- `appliedAggregation`: `raw.aggregation.applied` verbatim.
- `truncated`: `raw.series.some(series => series.truncated)`; neither API has a separate global flag.
- `dropped`: preserve each nonblank `seriesId` and `reason` verbatim.
- `series`: `seriesId`, `label`, `unit`, and `truncated` verbatim; map each point to `{ at: Date.parse(t), value, count, quality }`. Do not filter invalid timestamps, values, counts, or quality before shared normalization.
- Edge `grid`: `{ platform: 'edge', from: Date.parse(raw.range.from), to: Date.parse(raw.range.to) }`.
- Cloud `grid`: `{ platform: 'cloud', from: Date.parse(raw.grid.from), to: Date.parse(raw.grid.to), stepSeconds: raw.grid.stepSeconds, bucketCount: raw.grid.bucketCount }`.

Call shared `normalizeMobileAnalysisResponse(dto, logical, load.selectedIds)` exactly once. It owns ID-set, coverage, policy, grid, unit, truncation, and average-domain validation. Do not create bucket ends in the adapter.

Change both API methods to this compatible signature and pass the config as Axios's third `post` argument:

```ts
getSeries: async (
  request: AnalysisSeriesRequest,
  options: { signal?: AbortSignal } = {},
): Promise<AnalysisSeriesResponse> => {
  const response = await api.post<AnalysisSeriesResponse>(url, request, {
    signal: options.signal,
  });
  return response.data;
}
```

On edge, retain `resolveAnalysisRangeForRequest(request.range)` in the posted body. Its explicit custom bounds remain unchanged. The edge Axios interceptor combines the supplied signal with the auth-session signal. Cloud Axios binds the current auth snapshot but does not add a session abort signal; the history loader aborts series requests, and `AuthSessionDataBoundary` makes a late catalog response unreachable after session rotation.

## Thrown-error contract

Add one shared wrapper to `@osi/history-uplot`; do not create edge and cloud error classes:

```ts
export type MobileHistoryOperationalFailure = Exclude<
  MobileHistoryFailure,
  { kind: 'auth' }
>;

export class MobileHistoryError extends Error {
  readonly name = 'MobileHistoryError';
  constructor(
    readonly failure: MobileHistoryOperationalFailure,
    readonly original?: unknown,
  ) {
    super(failure.reason);
  }
}

export function mobileHistoryFailureError(
  input: MobileAnalysisFailureInput | MobileAnalysisValidationError,
  original: unknown = input,
): MobileHistoryError | HistoryAuthError {
  const failure = classifyMobileAnalysisFailure(input);
  return failure.kind === 'auth'
    ? new HistoryAuthError(failure.status, failure.reason)
    : new MobileHistoryError(failure, original);
}
```

Export these from the package index. `MobileAnalysisValidationError` remains the normalizer's precise internal boundary error. The loader catches it and throws `mobileHistoryFailureError(error)`, so the hook and shell see the same `MobileHistoryError.failure` object, including all missing IDs, dropped reasons, and access-denied IDs. No generic `Error` reconstruction may replace it.

Use one catch path in each `createMobileAnalysisLoader`:

```ts
function isAxiosCancellation(error: unknown): boolean {
  return axios.isCancel(error)
    || (axios.isAxiosError(error) && error.code === 'ERR_CANCELED');
}

function rethrowMobileAnalysisError(
  error: unknown,
  signal: AbortSignal,
): never {
  if (signal.aborted || error instanceof HistoryAbortError || isAxiosCancellation(error)) {
    throw error;
  }
  if (error instanceof HistoryAuthError || error instanceof MobileHistoryError) {
    throw error;
  }
  if (error instanceof MobileAnalysisValidationError) {
    throw mobileHistoryFailureError(error);
  }
  if (axios.isAxiosError(error)) {
    const input = toMobileFailureInput(error);
    throw mobileHistoryFailureError(input, error);
  }
  const reason = error instanceof Error && error.message
    ? error.message
    : 'unexpected mobile Analysis failure';
  throw new MobileHistoryError(
    { kind: 'protocol', code: 'http-error', reason },
    error,
  );
}

```

The loader's catch clause calls `rethrowMobileAnalysisError(error, signal)` and performs no other conversion.

`isAxiosCancellation` covers `axios.isCancel(error)` and Axios code `ERR_CANCELED`. Cancellation and `HistoryAbortError` pass through unchanged; the history loader/hook already suppresses superseded work. A non-Axios unexpected exception is protocol, not a network failure.

For HTTP failures, `toMobileFailureInput` returns `{ kind: 'http', status, code, message }`. For an Axios error with no response, it returns `{ kind: 'network', message }`. Extract nonblank response strings in this order:

1. Machine `code`: `data.code`, then `data.detail`, then `data.error`.
2. Human `message`: `data.detail`, then `data.message`, then `data.error`, then Axios's message.

The order matters on cloud: `GlobalExceptionHandler.handleErrorResponse` puts the `ResponseStatusException` reason in `ProblemDetail.detail`, while the generic problem title/error may say only `Bad Request`. Thus HTTP 400 detail `range_too_large` reaches the shared size classifier. Edge HTTP 413 needs no code, but using the same extraction order is harmless.

`useHistoryWindow` receives the thrown types without another conversion:

- `MobileHistoryError` becomes `hook.error`; Task 4 narrows with `error instanceof MobileHistoryError` and switches on `error.failure.kind` for `sources`, `size`, `transient`, or `protocol`.
- `HistoryAuthError` follows the hook's existing `onAuthError` path. The callback checks `status`: 401 follows current expiry/session cleanup; 403 clears route data and records route access denied without global logout.
- Cancellation and `HistoryAbortError` never become shell errors or Retry prompts.

Adapter tests must cover this thrown surface: a normalizer source failure retains its complete `failure` under `MobileHistoryError`; network and 5xx become transient; 413 and cloud detail `range_too_large` become size; 401 and 403 become `HistoryAuthError` with the original status; cancellation is the same cancellation object; and a plain unexpected `Error` becomes protocol `MobileHistoryError`. Include a cloud fixture with `{ title: 'Bad Request', detail: 'range_too_large', error: 'Bad Request' }` to prove detail wins for the machine code.

## Session-scoped catalog hook

Use this identical hook interface on both platforms:

```ts
export interface MobileTensionCatalogOptions {
  enabled: boolean;
  zoneId: string;
  sessionKey: string;
}

export function useMobileTensionCatalog(options: MobileTensionCatalogOptions): {
  sources: readonly MobileTensionSource[];
  defaultSelectedIds: readonly string[];
  error: MobileHistoryError | HistoryAuthError | null;
  isLoading: boolean;
  refreshForGeneration(generation: number): Promise<void>;
};
```

Use the SWR key `['mobile-tension-catalog', platform, sessionKey, zoneId]`, or null when disabled. The fetcher calls `analysisAPI.getChannels()` and immediately runs the platform catalog normalizer. Keep `revalidateOnFocus: false`. Product wrappers obtain `sessionKey` with the existing serializer:

- Edge: `serializeSessionIdentity` from `src/services/authSession.ts`.
- Cloud: `serializeSessionIdentity` from `src/contexts/AuthSessionDataBoundary.tsx`.

Both applications already mount private content inside an `AuthSessionDataBoundary` whose SWR provider is a new `Map` per session. Use the hook-local `mutate`; never import SWR's global mutate. `refreshForGeneration` stores refreshed generation numbers for the current SWR key and calls `await mutate()` once for a new generation. A repeated call for that generation is a no-op, even if the backend's catalog cache returns stale data. Reset the generation set when session or zone changes. Return shared default IDs as data only; Task 4 initializes route selection once and must not refill a deliberate empty selection after revalidation.

## Backend fixture recipes

Add assertions to the existing tests without production backend changes.

For edge `analysis.test.js`, reuse `weatherDb()`, `catalog(raw)`, `series(raw, selected, range, aggregation)`, `entry(...)`, and the existing SQLite insert helpers:

- Select 25 available entries from `await catalog(raw)`, use a one-hour range, and assert the response contains the same 25 IDs with empty `dropped`; send 26 distinct selector objects and assert the existing 413 guard fires before row reads. Keep the existing combined 30,000-row test as the overflow proof.
- Insert device readings on exact UTC hours, issue two aligned hourly ranges with an overlapping hour, and assert the shared point has the same `t`, `value`, `count`, and `quality`. Assert `range.from/to`, `aggregation.applied === 'hourly'`, and every returned series has `truncated === false`.
- Reuse the existing historical SDI-12 fixture to assert `configurationState: 'other_supported'` remains catalog-visible after a channel is removed from current depths.
- Copy the canonical test file byte-for-byte to bcm2709 and run profile parity.

For cloud, retain Mockito and the fixed clock in the three existing test classes:

- In `AnalysisSeriesServiceTest`, use one available `AnalysisCatalogEntry`, mock `rawQueryRepository.findHourlyReadingsForAnalysis` and `rollupRepository.findRollups`, then send explicit custom ranges of exactly 24 hours and 24 hours plus 1 ms with aggregation `hourly`. Verify the first uses raw aggregates and the second stored rollups. Assert grid step, count, end, point anchors, point count, `count/quality`, and `truncated === false`.
- Add the changed-scope omission case with a root soil entry and four sequential `scopeReader.requireAuthorized` snapshots: attempt-one manifest A then B, attempt-two manifest C then D, with each pair's internal source key different. The final response must omit the series while leaving `dropped` empty. This pins the client rule that requested-ID equality is independent of `dropped`.
- Keep the existing exact-2,000 and over-2,000 bucket tests. In `AnalysisControllerTest`, retain the 26-selector `too_many_series` case and add a 25-selector delegation case.
- In `AnalysisCatalogServiceTest`, return two accessible SWT devices at the same depth and assert distinct `sourceKey` and `seriesId` values, equal `depthCm`, `unit: kPa`, and `availability: available`.

## Frontend test shape and commands

Adapter tests use literal raw fixtures matching the table above. Assert the posted request and signal through mocked `analysisAPI.getSeries`; test the returned `HistoryWindowResponse`, including the same sanitized null in `points` and `buckets`, rather than asserting that a helper was exported.

Hook tests wrap each render in `SWRConfig` with `provider: () => new Map()` and mock `analysisAPI.getChannels` with deferred promises. Cover same-key deduplication, different zone and session keys, disabled mode, late old-key resolution, and one `refreshForGeneration` call per generation. Test catalog ordering, initial eight, 25 cap, saved empty selection, vanished IDs, edge `other_supported`, cloud `unknown`, and repeated depths in the pure catalog suite.

Run:

```bash
# Edge backend and frontend
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.test.js
node scripts/verify-profile-parity.js
cd web/react-gui
npx vitest run src/history/__tests__/mobileMeasurementCatalog.test.ts src/history/__tests__/mobileAnalysisHistoryAdapter.test.ts src/history/__tests__/useMobileTensionCatalog.test.tsx
npm run typecheck

# Cloud backend and frontend
cd /home/phil/Repos/osi-server/.worktrees/mobile-history-real-data-slice1/backend
./gradlew test --tests 'org.osi.server.analysis.AnalysisCatalogServiceTest' --tests 'org.osi.server.analysis.AnalysisSeriesServiceTest' --tests 'org.osi.server.analysis.AnalysisControllerTest'
cd ../frontend
npx vitest run --environment jsdom src/history/__tests__/mobileMeasurementCatalog.test.ts src/history/__tests__/mobileAnalysisHistoryAdapter.test.ts src/history/__tests__/useMobileTensionCatalog.test.tsx
npm run build
```

Task 3 stops after these adapter, hook, API, and additive backend contract tests. Route wiring, recovery UI, and vendor parity remain in Tasks 2 and 4.

## Root review

Approved with the shared error wrapper and exact machine-code precedence above. Apply the same boundary conversion to catalog fetches, so the hook returns `MobileHistoryError | HistoryAuthError | null` to the shell rather than raw Axios or unknown exceptions. Preserve cancellation identity on both transports. The shared wrapper is a small Task 3 addition, committed canonically before the cloud vendor is refreshed.
