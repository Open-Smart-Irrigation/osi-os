# Mobile history Slice 1 browser acceptance brief

This brief resolves the browser harness details for Task 5 of `2026-10-24-mobile-history-real-data-slice-1.md`. It assumes Tasks 1–4 are reviewed and green. Keep all traffic intercepted and local. Build the actual production applications with the internal route enabled or disabled; do not mount a test component, bypass `PrivateRoute`, reuse the edge demo, or access a live backend.

## Harness boundary

Keep the Task 5 files named in the parent plan. Each platform gets its own Vite build-matrix runner, static server, Playwright config, fixture module, and browser specification. Share fixture concepts through this brief, not through a new cross-repository package.

The matrix runner must:

1. Build a default-off production bundle and an internal-on production bundle into fresh temporary directories.
2. Set `VITE_BASE_PATH=/gui/` for both edge builds. Serve edge off/on at `http://127.0.0.1:4181/gui/` and `:4182/gui/`, including `/gui/index.html` fallback. Serve cloud off/on at `http://127.0.0.1:4281/` and `:4282/`, including `index.html` fallback for BrowserRouter deep links.
3. Enable the browser diagnostics flag only in the on builds used by Playwright. It must use the exact-string gate described below.
4. Wait on a static health URL from each server, pass explicit off/on base URLs to Playwright, and always terminate both servers and remove both build directories in `finally`.
5. Keep generated builds and JSON evidence outside tracked source directories.

Navigate edge directly to `/gui/#/internal/mobile-history/zones/1` and cloud directly to `/internal/mobile-history/zones/1`. Use the same paths on the off and on builds; only the compiled gate changes.

The browser fixture installs routes before navigation, records method, path, request body, authorization header, start/release time, status, response byte count, and scenario role, and fails the test for any unlisted `/api/**` request. Static application assets, locale JSON, source maps, and the explicitly handled cloud WebSocket are outside that API allowlist. Record `pageerror`, failed requests, and unexpected `console.error`; only a named cancellation scenario may classify its expected aborted series request instead of failing.

## Fixed identity and time

Use one named account and one fixed clock in every scenario:

```ts
export const FIXTURE_NOW = Date.UTC(2026, 9, 24, 12, 17, 0);
export const FIXTURE_USERNAME = 'mobile-history-fixture';
export const FIXTURE_USER_UUID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_ZONE_ID = 1;
export const FIXTURE_ZONE_UUID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_TIME_ZONE = 'Europe/Zurich';
```

Before application startup, replace `Date.now` with a function returning `FIXTURE_NOW`; leave `performance.now`, timers, `requestAnimationFrame`, and the `Date` constructor untouched. This gives the route a minute-offset logical viewport while preserving real loading and frame timing. The initial 24-hour request therefore intersects 25 UTC hour buckets. The 7-day request intersects 169.

Use Playwright context storage or `page.addInitScript` before `goto`; never set authentication after the application has started.

## Edge startup fixtures

Store `auth_token = "edge-mobile-history-token"` and `username = FIXTURE_USERNAME`. The edge `AuthProvider` treats that stored token as the session; it does not call an auth hydration endpoint. The global `ScopeProvider` and `GatewayRestartBanner` do make requests, so both are mandatory fixtures:

| Request | Response |
| --- | --- |
| `GET /api/me` | `{ username, user_uuid: FIXTURE_USER_UUID, role: "viewer", zone_uuids: null, plot_uuids: null, features: { scoped_access: false } }` |
| `GET /api/system/stats` | `{ cpu_temp_c: 45, mem_total_mb: 1024, mem_used_mb: 256, mem_free_mb: 768, mem_percent: 25, load_1: 0.1, load_5: 0.1, load_15: 0.1, cpu_count: 4, fan_available: false, fan_mode: "none", fan_value: null, fan_max: null, restartPending: null }` |

Use this minimal valid zone response for `GET /api/irrigation-zones`:

```ts
[{
  id: 1,
  name: 'North plot',
  device_count: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-10-24T00:00:00.000Z',
  zone_uuid: FIXTURE_ZONE_UUID,
  timezone: FIXTURE_TIME_ZONE,
  schedule: null,
}]
```

## Cloud startup fixtures and STOMP

Store this three-part JWT, `username = FIXTURE_USERNAME`, `role = "USER"`, and `osi.modules.migratedToServer = "true"` before startup:

```text
eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJtb2JpbGUtaGlzdG9yeS1maXh0dXJlIn0.fixture
```

The payload has the string subject that `subjectOf()` requires. The signature is deliberately inert because every request is intercepted; it is not an authorization bypass against a server.

The cloud startup performs two legitimate profile reads: `AuthProvider` validates the stored session and `GatewayProvider` resolves its per-user storage key. Fulfill both identical requests. The migration marker prevents an empty server preference map from causing a fixture-only PUT.

| Request | Response |
| --- | --- |
| `GET /api/v1/users/me` | `{ id: 7, username, email: "mobile-history@example.invalid", role: "USER", enabled: true, dataRetentionDays: 365, createdAt: "2026-01-01T00:00:00.000Z" }` |
| `GET /api/v1/users/me/linked-gateways` | `[]` |
| `GET /api/v1/user/module-preferences` | `{ modules: {} }` |

Use this minimal valid cloud zone for `GET /api/v1/irrigation-zones`:

```ts
[{
  id: 1,
  zoneUuid: FIXTURE_ZONE_UUID,
  name: 'North plot',
  userId: 7,
  devices: [],
  soilDevices: [],
  deviceCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
  timezone: FIXTURE_TIME_ZONE,
  access: { level: 'owner', canManage: true, canDelete: true },
}]
```

The empty device projections and zero current-device count are intentional: this route discovers retained historical sources from the Analysis catalog, not from the current zone-device projection. The three catalog source keys represent retained sources and do not make the route depend on dashboard device DTOs.

Install `page.routeWebSocket('**/ws', handler)` before `goto`. Parse NUL-terminated STOMP frames and tolerate standalone heartbeat newlines. On the first frame whose command is `CONNECT` or `STOMP`, verify that it contains `Authorization:Bearer <fixture token>` and send exactly:

```text
CONNECTED
version:1.2
heart-beat:0,0

\0
```

Allow a `DISCONNECT` frame during logout, 401 cleanup, or page teardown. If it carries a nonblank `receipt` header, answer `RECEIPT\nreceipt-id:<receipt value>\n\n\0`; otherwise record it and close normally. The internal history route mounts no device, command, or resource-invalidation subscription consumer, so `SUBSCRIBE`, `UNSUBSCRIBE`, `SEND`, and application data frames remain unexpected. A prompt `CONNECTED` prevents the ten-second SockJS fallback; any request to `/ws-fallback` is unexpected.

## Disabled-build redirect fixtures

The off-build assertion starts from the protected internal URL with the stored session. It must reach the existing `/history` route, not `/login`, on both platforms. The redirect mounts real startup code and has observable side effects that need explicit stubs.

For edge, retain `/api/me` and `/api/system/stats` above and fulfill `GET /api/system/features` with all five history flags false. The edge history page then suppresses zones, cards, and workspaces. Fail if it requests Analysis or if a query/local-storage value makes the internal page appear.

For cloud, retain the profile, linked-gateway, preference, STOMP, and zone fixtures above. The cloud history page always requests these additional resources even when its history feature is false:

- `GET /api/v1/devices` returns `[]`.
- `GET /api/v1/system/features` returns all five history flags false.

With the false feature response, no history-card or workspace request is valid. Assert the cloud URL is `/history`, the edge hash is `#/history`, the internal heading and diagnostics global are absent, and no Analysis request occurred. Build with Vite's manifest enabled and assert that the off manifest has no `MobileTensionHistoryRoute.tsx` entry or dynamic import. The on manifest must name and serve that lazy chunk. Do not add a product marker solely for bundle inspection.

The edge stats hook and cloud history device/zone hooks poll at 30 seconds. Return the same fixture for a legitimate repeat and record it; do not make a long browser scenario depend on exactly one call. Unexpected paths and methods still fail.

Use this same exact feature response on both platforms, at their respective endpoint:

```ts
{
  historyUxEnabled: false,
  historyComparisonEnabled: false,
  historyWorkspacesEnabled: false,
  historyAdvancedOverlaysEnabled: false,
  historyCloudAiEnabled: false,
}
```

## Catalog fixture

Use the exact source keys `soil-src-probe-1`, `soil-src-probe-2`, and `soil-src-probe-3`. Probe 1 and probe 2 have `swt_1`, `swt_2`, and `swt_3`; probe 3 has `swt_1` and `swt_2`. Generate each `seriesId` with the production rule `sha256("1|soil|<sourceKey>|<channelKey>").slice(0, 16)` in the fixture helper. Assert this mapping in the browser fixture specification so a typo cannot turn the run into a different selection:

```ts
const EXPECTED_SERIES = [
  ['soil-src-probe-1', 'swt_1', 'd9db14c69d12d3b3'],
  ['soil-src-probe-1', 'swt_2', '0c54b653d6eab0c0'],
  ['soil-src-probe-1', 'swt_3', 'c94f32ca9561a261'],
  ['soil-src-probe-2', 'swt_1', '8aa3c3b56ecec5df'],
  ['soil-src-probe-2', 'swt_2', '27e73fefed8d27e6'],
  ['soil-src-probe-2', 'swt_3', '1ae759d0b4091681'],
  ['soil-src-probe-3', 'swt_1', 'f613eada91b02b88'],
  ['soil-src-probe-3', 'swt_2', 'ef61638ceb200d5a'],
] as const;
```

Every catalog row has `zoneId: 1`, `zoneName: "North plot"`, `cardType: "soil"`, `unit: "kPa"`, `availability: "available"`, a nonblank device/display name, and depth 10, 20, or 30 cm for `swt_1`, `swt_2`, or `swt_3`. Edge rows also carry `hubEui`, `sourceKind: "device"`, a stable `deviceSourceId`, `configurationState: "current"`, and `legacy: false`. Cloud rows use their exact catalog DTO and omit edge-only fields. Use `generatedAt = new Date(FIXTURE_NOW).toISOString()`.

This catalog is the normal eight-source fixture and produces the approved default selection without saved selection state. Build 26-source cap scenarios by adding explained probe/channel rows through the same generator, not by cloning one row with conflicting identity fields.

## Valid hourly series fixture

Parse and validate every POST body before answering:

- `selectors` are nonempty, unique, no more than 25, and all occur in the active catalog.
- `aggregation` is `hourly`; range mode is `custom`; label matches the scenario's logical preset before platform transport alignment.
- Edge timestamps are already floored/ceiled to UTC hours. Cloud timestamps preserve the minute-offset logical bounds.
- Every response contains exactly the requested IDs in request order unless the named scenario explicitly tests missing, dropped, or denied sources.

For edge, use the received range bounds as response `range.from/to`, omit `grid`, and generate one point at each UTC hour from `from` inclusive to `to` exclusive. Validate the label against the logical action recorded by the scenario, not the rounded transport span: the initial logical 24-hour request is transported across 25 hours and must still carry `label: "24h"`; the logical seven-day request similarly carries `label: "7d"`. Include `cadence: "hourly"`, `timezone: FIXTURE_TIME_ZONE`, `truncated: false`, `coveragePct: 100`, and `{ requested: "hourly", applied: "hourly" }`.

For cloud, floor the received logical `from`, ceil `to`, and return that transport interval in both `range` and `grid`. The range has the request label and `timezone: "UTC"`. Set `grid.stepSeconds = 3600`, `grid.bucketCount = (to - from) / 3_600_000`, `aggregation` to requested/applied hourly with `bucketSizeSeconds = 3600`, and one point at every grid anchor. The initial 24-hour response has 25 points per series; the 7-day response has 169.

Both responses use fixed `generatedAt`, echo each requested catalog row's series ID, label, unit, and resolved zone/card/source/channel identity, and return `dropped: []`. This keeps the fixture at the real adapter boundary rather than relying on fields the normalizer happens not to read today.

Use `value = 18 + seriesIndex * 2 + Math.sin(bucketIndex / 6)`, `count = 1`, and `quality = "ok"`. This gives stable nonzero curves without encoding a product claim. Never insert a point outside the advertised transport range. A scenario helper may replace one named bucket with a negative value to test rejected averages, but the ordinary fixture remains valid.

Serialize the final response once, measure its UTF-8 byte length, then delay fulfillment by `600 ms + bytes / 125_000 * 1_000`. Report catalog bytes and completion separately from series bytes and delay. Do not estimate payload size from object counts.

## Internal diagnostics seam

The existing `onDiagnostics` callback records a scheduling snapshot and cannot prove final cache or lane state. `ChartHost` also keeps the adapter private. Add only this opt-in path:

1. The mobile shell creates the existing `HistoryLoader` explicitly, supplies it to `useHistoryWindow`, and reads `loader.diagnostics()` when a browser snapshot is requested. It destroys that loader on shell unmount. Do not add another loader or cache.
2. Add an optional internal diagnostics registration prop to `ChartHost`. Once mounted, register a reader that returns `adapter.getViewport()` and `adapter.getPlotRect()` directly; unregister it before destroying the adapter. A focused unit test gives the fake adapter a viewport different from the store and proves the reader reports the adapter value.
3. Add an optional internal diagnostics sink to `MobileTensionHistory`. Its snapshot combines the requested viewport from `viewportStore.get()`, the rendered viewport from the registered ChartHost reader, current `loader.diagnostics()`, shell status/refreshing state, and a closed error kind. It must not expose tokens, usernames, response bodies, sample values, labels, or source IDs.
4. Each platform route publishes that reader to `window.__osiMobileHistoryDiagnostics` only when both the internal route and `VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS` are the exact string `'true'`. Delete the property on route unmount only if the route still owns it. No query, local-storage value, or runtime function may enable it.

Use these exact optional registration names so the seam stays recognizable and removable:

```ts
type ChartHostInternalDiagnosticsReader = () => {
  renderedViewport: { from: number; to: number };
  plotRect: { left: number; top: number; width: number; height: number };
};

// Optional ChartHost prop
registerInternalDiagnostics?: (
  reader: ChartHostInternalDiagnosticsReader | null,
) => void;

// Optional MobileTensionHistory prop
registerInternalDiagnostics?: (
  diagnostics: MobileHistoryDiagnostics | null,
) => void;
```

Use this read-only shape:

```ts
interface MobileHistoryDiagnosticSnapshot {
  requestedViewport: { from: number; to: number };
  renderedViewport: { from: number; to: number } | null;
  plotRect: { left: number; top: number; width: number; height: number } | null;
  loader: {
    foregroundActive: boolean;
    prefetchActive: boolean;
    entries: number;
    points: number;
  };
  shell: {
    status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
    refreshing: boolean;
    errorKind: null | 'auth-401' | 'auth-403' | 'sources' | 'size' | 'transient' | 'protocol';
  };
}

interface MobileHistoryDiagnostics {
  snapshot(): MobileHistoryDiagnosticSnapshot;
}
```

Before ChartHost mounts, and after it unregisters during an initial failure, route-local 403, or teardown, `snapshot()` returns `renderedViewport: null` and `plotRect: null`; it never calls a missing or destroyed adapter and never throws. ChartHost registers the reader only after the adapter is live, unregisters it before `adapter.destroy()`, and the platform removes the global when the route itself unmounts. Ready-state assertions require both renderer fields to be nonnull.

The test computes renderer error from the two independently sourced nonnull viewports. It must never read the store twice or infer uPlot scales from the visible-window text. Frame sampling stays in the Playwright helper: run the same `requestAnimationFrame` delta sampler and nearest-rank p95 calculation as the tracked dense benchmark. This avoids shipping frame collection code or mutable test controls in the application.

Sample diagnostics before each action, throughout delayed requests and gestures, after request settlement, and after cache hits. Record maximum entries and points plus every observed lane pair. A cache hit may show both lanes false. Fail above eight entries or 20,000 points, if the renderer differs from the requested viewport after settlement, or if an ordinary ready state exposes an error kind.

## Dense benchmark and production acceptance

Keep two workloads separate:

- Rerun `npm run test:browser:loading-baseline` from `web/history-zoom-prototypes` before and after the completed core. The tracked prototype imports the current canonical loader, gestures, uPlot adapter, and uPlot data conversion, so its unchanged `8 x 672` fixture remains the paired dense renderer/loader benchmark. Verify `tests/browser/loading-baseline.spec.ts` has SHA-256 `237f37d465543fc7d4a8e19642228ef658159262f5211f6ec4c3a3ac35a5183b`, the file from commit `2b57875e5`; do not edit its points, delay, gestures, or thresholds during the comparison.
- Run the production internal routes with the valid 25/169-bucket Analysis fixtures above. Never send 672 alleged hourly buckets through the normalizer; that would be a malformed Analysis response rather than a dense hourly case.

The dense comparison keeps the parent-plan limits: at most 771,396 response bytes, paired first-ready median at most 1.2 times its Task 0 counterpart, frame p95 at most 33.4 ms, zero renderer error, no renderer/page/request errors, and no increase beyond the loader's one foreground, one prefetch, eight entries, and 20,000 points.

The enabled production-route suite uses the fixed 448 × 998 CSS-pixel viewport, DPR 3, touch enabled, and the same 20-step CDP pinch and pan recipe as the dense benchmark. Measure navigation-to-zone, zone-to-catalog, discovery bytes/completion, series bytes/delay, and first-ready separately. Require first-ready no later than catalog completion plus imposed transfer delay plus 1,000 ms. Keep the parent plan's request, frame, viewport, interaction, failure, responsive, and CPU-throttled scenarios.

Retain the shell brief's real-canvas axis check at 320 px and 448 px under normal and 200% root text. Capture only numeric uPlot `fillText` calls whose alignment is right/middle, treat the recorded `x` as the text's right anchor, and require the kPa unit right edge within 1 CSS px. Do not add `measureText()` width to a right-aligned anchor.

For error scenarios, alter one contract fact at a time through named fixture states: access-denied dropped source, other missing source, 413 or cloud `range_too_large`, 500 transient, stale delayed response, 401, and 403. Record the request that triggered the state and assert the closed UI behavior. Do not create a catch-all error response whose origin is unclear.

The 4x CPU-throttled run reports its frame distribution separately. It does not use the unthrottled 33.4 ms gate. Neither workload claims physical-phone interaction, radio latency, backend query cost, or cancellation of backend work.

## Required plan amendments

Before Task 5 implementation, amend the parent plan in three places:

1. Add exact-string `VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS` typing and on-build wiring, plus the opt-in ChartHost adapter reader and shell snapshot described here. Keep the diagnostics global absent from ordinary and off builds.
2. Add the disabled `/history` side-effect fixtures: edge scope/stats/features; cloud profile twice, linked gateways, module preferences, STOMP, devices, zones, and features.
3. State that the unchanged tracked `8 x 672` pilot is the dense paired benchmark while production routes use only valid 25/169 hourly grids. Report their timings and bytes separately.

## Root review

Approved after correcting source keys, STOMP teardown, logical-span labels, and unmounted diagnostics. Implement the optional reader and literal diagnostics gate with Task 4, so Task 5 only builds the harness against that reviewed interface. Browser snapshots must compare the store to the actual adapter, not two copies of the store. No data values or credentials belong in diagnostics.
