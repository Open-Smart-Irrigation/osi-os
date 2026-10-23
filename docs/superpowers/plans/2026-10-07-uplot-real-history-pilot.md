# uPlot real-history pilot implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in edge and cloud routes that render authenticated real sensor history through the proven uPlot and D3 mobile interaction stack.

**Architecture:** Extend the standalone history comparison package with a fixed same-origin API adapter and a pilot shell. Keep one accepted buffered interval, subscribe to the imperative viewport store after gestures settle, and preserve accepted data during same-identity loads. Existing candidate routes retain their defaults.

**Tech stack:** React 18, TypeScript 5.9, Vite 7, uPlot 1.6.32, D3 zoom/selection/scale, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-uplot-real-history-pilot-design.md`

## Global constraints

- Work only in `/home/phil/Repos/osi-os/.worktrees/mobile-history-zoom-prototypes`.
- Do not change Node-RED flows, either host GUI, an API, a schema, sync, auth, or production infrastructure.
- Preserve `#/uplot`, `#/echarts`, and `#/chartjs` and all baseline tests.
- Add only `#/pilot/edge` and `#/pilot/cloud`; all API requests remain same-origin GETs.
- Never log, persist, decode, clear, place in a URL, or include in an error the `auth_token` value.
- Preserve `value: null` as null. Only an absent `value` property may use `latest`, `mean`, or `median`.
- Network acceptance never writes the viewport. Gestures and explicit range controls are the only viewport writers.
- Use one accepted buffered interval. Do not add a page cache, infinite scrolling, a service worker, or client downsampling.
- The pilot plots one exact unit group at a time and never infers a missing unit.
- Interactive controls have a minimum 44 px target and visible keyboard focus.
- Do not overwrite `.superpowers/sdd/2026-10-07-uplot-real-history-pilot/progress.md`.

## Review focus

- A token changes while a slow response is in flight: clear account data and refuse the response even if abort arrives late.
- A point contains `{ value: null, mean: 12 }`: render a gap, not 12.
- Sparse samples cover only part of a valid response interval: treat the response range as loaded coverage, not the sample min/max.
- The user pans while a buffered request resolves: replace data and coverage without moving the viewport.
- A server sets `limits.truncated=true`: retain the chart, label it incomplete, and offer a 24 h request.

### Task 1: Real-history contract, normalization, and fenced loading

**Files:**
- Create: `web/history-zoom-prototypes/src/pilot/types.ts`
- Create: `web/history-zoom-prototypes/src/pilot/platform.ts`
- Create: `web/history-zoom-prototypes/src/pilot/range.ts`
- Create: `web/history-zoom-prototypes/src/pilot/normalize.ts`
- Create: `web/history-zoom-prototypes/src/pilot/api.ts`
- Create: `web/history-zoom-prototypes/src/pilot/requestOwner.ts`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-platform.test.ts`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-range.test.ts`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-normalize.test.ts`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-api.test.ts`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-request-owner.test.ts`

**Interfaces:**

```ts
export type PilotPlatform = 'edge' | 'cloud';
export type PilotAggregation = 'raw' | '15m' | 'hourly' | 'daily';
export interface PilotZone { id: number; name: string; }
export interface PilotCard {
  cardId: string;
  cardType: string;
  title: string;
  views: string[];
  sourceLabels: string[];
  available: boolean;
}
export interface PilotRangeRequest {
  from: number;
  to: number;
  rangeLabel: '24h' | '7d' | '30d';
  aggregation: PilotAggregation;
}
export interface PilotAcceptedData {
  cardId: string;
  request: PilotRangeRequest;
  coverage: { from: number; to: number };
  series: readonly SensorSeries[];
  unitGroups: readonly { unit: string; label: string; seriesIds: readonly string[] }[];
  aggregation: { level: string; pointCount: number };
  limits: { maxPointsPerSeries: number; truncated: boolean };
}
export interface PilotPlatformConfig {
  historyPrefix: '/api/history' | '/api/v1/history';
  zonesPath: '/api/irrigation-zones' | '/api/v1/irrigation-zones';
  loginPath: '/gui/#/login' | '/login';
}
export function platformConfig(platform: PilotPlatform): PilotPlatformConfig;
export function requestForViewport(viewport: Viewport): PilotRangeRequest;
export function bufferedRequest(viewport: Viewport, horizon: Viewport): PilotRangeRequest;
export function minuteViewport(viewport: Viewport): Viewport;
export function coverageContains(
  accepted: Pick<PilotAcceptedData, 'coverage' | 'request'>,
  visible: Viewport,
  desiredAggregation: PilotAggregation,
): boolean;
export function normalizeZones(raw: unknown): PilotZone[];
export function normalizeCards(raw: unknown): PilotCard[];
export function normalizeCardData(raw: unknown, request: PilotRangeRequest): PilotAcceptedData;
export function createPilotApi(platform: PilotPlatform, dependencies?: PilotApiDependencies): PilotApi;
export function createRequestOwner(readToken?: () => string | null): PilotRequestOwner;
```

Use these complete API and owner definitions:

```ts
export interface PilotApiDependencies {
  fetchImpl?: typeof fetch;
  origin?: string;
}
export interface PilotAuthInput { token: string; signal: AbortSignal; }
export interface PilotApi {
  getZones(input: PilotAuthInput): Promise<PilotZone[]>;
  getCards(input: PilotAuthInput & { zoneId: number }): Promise<PilotCard[]>;
  getCardData(input: PilotAuthInput & {
    zoneId: number;
    cardId: string;
    view: 'line-chart';
    request: PilotRangeRequest;
  }): Promise<PilotAcceptedData>;
}
export class PilotAuthError extends Error {
  constructor(status: 401 | 403, message: string);
  readonly status: 401 | 403;
}
export class PilotHttpError extends Error {
  constructor(status: number, message: string);
  readonly status: number;
}
export class PilotResponseError extends Error { constructor(message: string); }
export type PilotRunResult = 'applied' | 'superseded' | 'cancelled' | 'auth-required';
export interface PilotRequestOwner {
  readonly sessionEpoch: number;
  run<T>(input: {
    load(signal: AbortSignal, token: string): Promise<T>;
    apply(value: T): void;
  }): Promise<PilotRunResult>;
  cancel(): boolean; // true only when an active request was aborted
  destroy(): void;
}
```

`PilotApi.getCardData` compares the normalized response `cardId` with its input `cardId` and throws `PilotResponseError` on mismatch. `normalizeCardData` stays independent of the request URL. The API never accepts an arbitrary base URL; `origin` is test injection and equals `window.location.origin` in browser use. The token remains a local call value and never enters React state, request-key text, diagnostics, the DOM, or errors. `PilotRequestOwner.run` captures a generation and token, invokes `load`, and calls `apply` only when generation, token, and liveness still match. `cancel()` aborts and advances the generation, returning whether a request was active; observing a different token advances `sessionEpoch`. `destroy()` calls `cancel()` and permanently refuses work.

- [ ] **Step 1: Write contract and platform tests that fail before the modules exist.**

Cover exact edge/cloud prefixes and login paths, reject unknown platforms at the parser boundary, normalize wrapped or array zone lists, keep only positive integer zone ids with nonblank names, and enable cards only when `views` contains `line-chart` and the card is available. Assert that neither platform exposes a `sourceKey` parameter.

```ts
expect(platformConfig('edge')).toEqual({
  historyPrefix: '/api/history',
  zonesPath: '/api/irrigation-zones',
  loginPath: '/gui/#/login',
});
expect(platformConfig('cloud').historyPrefix).toBe('/api/v1/history');
expect(normalizeCards({ cards: [{ cardId: 'soil-a', cardType: 'soil', views: ['line-chart'], availability: { available: true } }] })[0].available).toBe(true);
```

- [ ] **Step 2: Run the new contract tests and confirm module-resolution failures.**

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/pilot-platform.test.ts tests/unit/pilot-normalize.test.ts`\
Expected: FAIL because `src/pilot/*` does not exist.

- [ ] **Step 3: Add the types and fixed platform map, then implement strict zone/card normalization.**

Use `unknown` at the HTTP boundary. Do not copy the host GUI's broad `any` normalizers. A malformed top-level object throws `PilotResponseError`; malformed rows are dropped only when the remaining response is structurally usable.

- [ ] **Step 4: Write failing range-policy tests.**

Pin the exact table and buffering behavior:

```ts
expect(requestForViewport({ from: 0, to: 24 * HOUR_MS }).aggregation).toBe('raw');
expect(requestForViewport({ from: 0, to: 7 * DAY_MS }).aggregation).toBe('15m');
expect(requestForViewport({ from: 0, to: 30 * DAY_MS }).aggregation).toBe('hourly');
expect(requestForViewport({ from: 0, to: 90 * DAY_MS })).toMatchObject({ rangeLabel: '30d', aggregation: 'daily' });
expect(bufferedRequest({ from: 10 * DAY_MS, to: 10.5 * DAY_MS }, { from: 0, to: 90 * DAY_MS })).toMatchObject({
  from: 9.875 * DAY_MS,
  to: 10.625 * DAY_MS,
});
```

Also test flooring both minute endpoints without widening an exact 24 h span, 90-day horizon clamping, exact boundary spans receiving no padding, padding never crossing an aggregation tier, and `coverageContains(accepted, visible, aggregation)` returning false when either the visible interval is outside coverage or the desired aggregation differs from `accepted.request.aggregation`. Do not compare against the response's actual aggregation level.

- [ ] **Step 5: Implement the range policy and rerun its tests.**

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/pilot-range.test.ts`\
Expected: PASS.

- [ ] **Step 6: Write failing series-normalization tests for zero, explicit null, omitted value fallback, non-finite input, invalid and duplicate timestamps, exact units, response-range coverage, and truncation.**

The core regression assertion is:

```ts
const accepted = normalizeCardData(responseWith([
  { t: '2026-10-01T00:00:00Z', value: 0 },
  { t: '2026-10-01T01:00:00Z', value: null, mean: 12 },
  { t: '2026-10-01T02:00:00Z', mean: 13 },
]), request);
expect(accepted.series[0].points.map((point) => point.value)).toEqual([0, null, 13]);
expect(accepted.coverage).toEqual({ from: request.from, to: request.to });
```

Add a sparse response whose only samples are in the middle but whose response range spans the request. Coverage must remain the response range. Missing units group under `{ unit: '', label: 'Unit not reported' }` and never merge with a named unit.

- [ ] **Step 7: Implement response normalization and make those tests pass.**

Clip a valid response range to the request. Use the request when range fields are missing or invalid. Reject `from >= to` and invalid series arrays. Return the normalized response `cardId`; `PilotApi.getCardData` validates it against the requested card. Preserve explicit null by checking `Object.prototype.hasOwnProperty.call(point, 'value')` before fallbacks.

- [ ] **Step 8: Write failing API and request-owner tests.**

Use a fake `fetch` and deferred promises. Assert:

- exact encoded paths and `view=line-chart`, explicit `from/to`, range label, and aggregation;
- `Authorization: Bearer …`, `credentials:'same-origin'`, `cache:'no-store'`, and `redirect:'error'`;
- no request without a token;
- a resolved URL with another origin is rejected before `fetch`;
- a later generation wins;
- `cancel()` aborts;
- token mismatch at acceptance refuses data;
- `401` and `403` become `PilotAuthError` without clearing storage;
- error messages never contain the token or raw body.

- [ ] **Step 9: Implement the API and owner, then run all Task 1 tests.**

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/pilot-platform.test.ts tests/unit/pilot-range.test.ts tests/unit/pilot-normalize.test.ts tests/unit/pilot-api.test.ts tests/unit/pilot-request-owner.test.ts`\
Expected: PASS.

- [ ] **Step 10: Commit Task 1.**

```bash
git add web/history-zoom-prototypes/src/pilot web/history-zoom-prototypes/tests/unit/pilot-*.test.ts
git commit -m "feat(history-pilot): add fenced real-history data boundary"
```

### Task 2: Dynamic chart primitives and pilot interface

**Files:**
- Modify: `web/history-zoom-prototypes/src/shared/types.ts`
- Modify: `web/history-zoom-prototypes/src/shared/viewport.ts`
- Modify: `web/history-zoom-prototypes/src/shared/gestures.ts`
- Modify: `web/history-zoom-prototypes/src/adapters/uplot.ts`
- Modify: `web/history-zoom-prototypes/src/ChartHost.tsx`
- Modify: `web/history-zoom-prototypes/src/routes.ts`
- Modify: `web/history-zoom-prototypes/src/App.tsx`
- Modify: `web/history-zoom-prototypes/src/styles.css`
- Create: `web/history-zoom-prototypes/src/pilot/PilotApp.tsx`
- Create: `web/history-zoom-prototypes/src/pilot/usePilotHistory.ts`
- Modify: `web/history-zoom-prototypes/tests/unit/routes.test.ts`
- Modify: `web/history-zoom-prototypes/tests/unit/gestures.test.ts`
- Modify: `web/history-zoom-prototypes/tests/uplot-adapter.test.ts`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-app.test.tsx`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-history.test.tsx`

**Interfaces:**

```ts
export interface ChartRenderOptions {
  extent?: Viewport;
  minSpanMs?: number;
  yRange?: 'fixed-0-100' | 'auto';
}
export type MountAdapter = (
  host: HTMLElement,
  initial: Viewport,
  onViewportChange: (viewport: Viewport) => void,
  options?: ChartRenderOptions,
) => ChartAdapter;
export function attachD3ViewportController(
  host: HTMLElement,
  layer: HTMLElement,
  adapter: ChartAdapter,
  store: ViewportStore,
  options?: Pick<ChartRenderOptions, 'extent' | 'minSpanMs'>,
): D3ViewportController;
export interface UsePilotHistoryOptions {
  platform: PilotPlatform;
  api?: PilotApi;
  readToken?: () => string | null;
  now?: () => number;
}
export interface UsePilotHistoryResult {
  status: 'auth-required' | 'loading' | 'ready' | 'empty' | 'error';
  zones: readonly PilotZone[];
  cards: readonly PilotCard[];
  selectedZoneId: number | null;
  selectedCardId: string | null;
  accepted: PilotAcceptedData | null;
  loadingRequest: PilotRangeRequest | null;
  error: string | null;
  horizon: Viewport;
  store: ViewportStore;
  selectZone(zoneId: number): void;
  selectCard(cardId: string): void;
  selectPreset(span: '24h' | '7d' | '30d' | '90d'): void;
  moveWindow(direction: 'back' | 'forward'): void;
  showLatest(): void;
  retry(): void;
}
export function usePilotHistory(options: UsePilotHistoryOptions): UsePilotHistoryResult;
```

- [ ] **Step 1: Extend route tests first.**

Assert `routeFromHash('#/pilot/edge')` and `routeFromHash('#/pilot/cloud')`, keep all three candidate results unchanged, and keep the unknown-hash fallback `#/uplot`. Change `candidateFromHash` to `routeFromHash` and make `App` branch to `PilotApp` only for `kind:'pilot'`.

- [ ] **Step 2: Write failing primitive tests for a dynamic 90-day extent and automatic y scale.**

Test a pilot extent ending at a fixed clock, a one-hour minimum span, derived D3 `scaleExtent([1, extentSpan / minSpan])`, and auto y range for negative, positive, zero-only, and flat series. Keep an existing candidate test asserting 0–100 when options are omitted.

- [ ] **Step 3: Implement optional chart options without changing candidate defaults.**

`transformToViewport` accepts optional min/max span values instead of importing fixture limits internally. `attachD3ViewportController` defaults to `FIXTURE_EXTENT` and `HOUR_MS`, derives its maximum zoom, and passes the same constraints to viewport conversion. `mountUplot` defaults to `fixed-0-100`; `auto` computes a finite range across enabled series with 5% padding and at least 1 unit for a flat line.

Add `extent`, `minSpanMs`, and `yRange` props to `ChartHost`. Pass options to the adapter and controller. Include `store`, extent endpoints, minimum span, and y mode in the mount effect dependencies. Keep the data effect separate so a new response calls `setData` without remounting. Clear the pinned inspector and guide when the series identity or semantic chart key changes.

- [ ] **Step 4: Run the primitive tests.**

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/routes.test.ts tests/unit/gestures.test.ts tests/uplot-adapter.test.ts tests/unit/viewport.test.ts`\
Expected: PASS, including unchanged candidate defaults.

- [ ] **Step 5: Write failing hook tests for initial loading, settled viewport loading, and auth/session invalidation.**

Use fake timers. Pin these transitions:

1. Valid token loads zones, the first zone, supported cards, and the first card's latest 24 h.
2. Store gesture notifications do not render React state or fetch immediately; one request starts 150 ms after the last notification.
3. The minute-normalized visible viewport inside accepted coverage at the same requested aggregation starts no request; buffering is computed only after this check says a request is needed.
4. Leaving coverage or crossing an aggregation threshold requests the 25% buffered interval.
5. Response acceptance changes `accepted` and coverage but leaves `store.get()` byte-for-byte equal.
6. Changing zone or card clears accepted data before loading.
7. A same-identity load retains accepted data and exposes `loadingRequest`.
8. `storage` and visible `visibilitychange` token mismatches cancel and clear all account state.
9. Unmount clears the 150 ms timer and aborts work.

- [ ] **Step 6: Implement `usePilotHistory` with one owner, one timer, one accepted interval, and cleanup.**

Do not mirror every viewport change into React. Subscribe imperatively to the store, retain the latest viewport in a ref, and set React loading state only when the settled request actually starts. The hook constructs a new 90-day horizon and viewport store on platform/session/zone/card semantic identity. `selectZone` and `selectCard` validate ids against the loaded lists and clear accepted data synchronously. Presets set a window ending at the current viewport end, Back/Forward move 80% of its span within `horizon`, and `showLatest` rebuilds the horizon from `now()` before setting the latest interval. These handlers call `store.set(..., 'external')`; response handlers never call `store.set`.

- [ ] **Step 7: Write failing component tests for the required states and controls.**

Cover auth-required login paths, zone/card/unit selectors, unsupported-card explanation, a chart for enabled sensors only, 44 px control classes, empty data, same-identity loading with the chart still mounted, background error with Retry, full error before first acceptance, unit-change clearing, daily aggregation text, “Not loaded” outside coverage, and truncation with “Show 24 h”. Assert no source selector or `sourceKey` request exists.

- [ ] **Step 8: Implement `PilotApp` and scoped CSS.**

Render selectors before the chart; derive unit groups from accepted data and default to the first group. Reset checked series to all valid ids when card or unit changes. Pass enabled series, the 90-day horizon, `minSpanMs={HOUR_MS}`, and `yRange="auto"` to `ChartHost`. Build the not-loaded overlay from viewport versus accepted coverage. Keep the chart mounted during same-identity requests and errors.

Controls are: `24 h`, `7 d`, `30 d`, `90 d`, `Back`, `Forward`, `Latest`, `Retry`, and `Show 24 h` when truncated. Back/Forward move 80% of the selected span and clamp to the horizon. Platform, card, exact unit label, response aggregation, point count, accepted range, and truncation status remain visible.

- [ ] **Step 9: Run Task 2 tests and the full unit/build baseline.**

Run:

```bash
cd web/history-zoom-prototypes
npx vitest run tests/unit/pilot-history.test.tsx tests/unit/pilot-app.test.tsx
npm test
npm run build
```

Expected: pilot tests PASS; full suite has at least the baseline 78 tests plus the new tests; TypeScript and Vite build PASS.

- [ ] **Step 10: Commit Task 2.**

```bash
git add web/history-zoom-prototypes/src web/history-zoom-prototypes/tests
git commit -m "feat(history-pilot): render authenticated uPlot history"
```

### Task 3: Browser acceptance and static test-server handoff

**Files:**
- Create: `web/history-zoom-prototypes/tests/browser/pilot-history.spec.ts`
- Create: `web/history-zoom-prototypes/tests/browser/pilot-fixtures.ts`
- Modify: `web/history-zoom-prototypes/tests/browser/browser-helpers.ts`
- Modify: `web/history-zoom-prototypes/README.md`
- Create: `docs/operations/uplot-real-history-pilot-2026-10-07.md`

**Interfaces:**

```ts
export async function installPilotApi(
  page: Page,
  platform: PilotPlatform,
  scenario: PilotScenario,
): Promise<PilotApiProbe>;
export interface PilotApiProbe {
  requests: Array<{ pathname: string; search: string; authorization: string | null }>;
  resolveData(index: number, response: unknown): Promise<void>;
}
```

Fixtures use the real camelCase history envelope: `cardId`, `cardType`, `view`, `range`, `aggregation`, `limits`, `series[].points[]`, `freshness`, and empty arrays for unused response fields. Tokens in fixtures are fixed test strings and must never be written by the app to output.

- [ ] **Step 1: Add failing Playwright cases with intercepted same-origin APIs.**

At 390 × 844, test both API prefixes and login links. For the main edge case: seed `auth_token`, accept a 24 h response, start a deferred panned-window response, pinch and inspect the accepted chart while loading, resolve the response, and assert the viewport did not jump. Assert the Authorization header is present in the in-memory probe but never print its value.

Add cases for out-of-order responses, a token change before resolve, explicit null next to measured zero, unit switching, sensor toggles, empty response, malformed response, `401`, and truncation. Reuse the existing CDP touch helpers.

- [ ] **Step 2: Implement only the browser-test helpers needed to satisfy those cases.**

Keep all route interception same-origin. Make deferred responses resolve under test control rather than using fixed sleeps. When checking auth fencing, dispatch a `StorageEvent('storage', { key:'auth_token', oldValue:'test-a', newValue:'test-b' })` after changing local storage, then resolve the old request and assert no old labels remain.

- [ ] **Step 3: Run the new browser file, then the complete browser suite.**

Run:

```bash
cd web/history-zoom-prototypes
npx playwright test tests/browser/pilot-history.spec.ts
npm run test:browser
```

Expected: pilot file PASS; all 34 baseline browser tests plus new pilot tests PASS. Existing diagnostics for the three candidates are still produced.

- [ ] **Step 4: Update the README and write the test-server record.**

Document all five hash routes, same-origin requirements, edge/cloud login links, the read-only API surface, the 90-day horizon, aggregation labels, and the fact that production history is unchanged. Give exact local commands and the existing `HISTORY_ZOOM_BASE_URL` deployed check.

The operations record must include commit, artifact checksum, backup path, install path, rollback command, all verification exit codes, and two separate live results: unauthenticated auth-gate smoke and authenticated real-data acceptance. If no authorized test session is available, write `BLOCKED: no existing test account/session supplied`; do not create an account, mutate a database, or add an auth bypass.

- [ ] **Step 5: Run the complete package gate and prose checker.**

Run:

```bash
cd web/history-zoom-prototypes && npm run check
cd ../.. && node .claude/skills/anti-slop-writing/slop-check.js \
  web/history-zoom-prototypes/README.md \
  docs/operations/uplot-real-history-pilot-2026-10-07.md \
  docs/superpowers/specs/2026-10-07-uplot-real-history-pilot-design.md \
  docs/superpowers/plans/2026-10-07-uplot-real-history-pilot.md
git diff --check
```

Expected: unit, build, and browser gates PASS; `slop-check: PASS (no tier-1 findings)`; `git diff --check` exits 0.

- [ ] **Step 6: Commit Task 3.**

```bash
git add web/history-zoom-prototypes/README.md web/history-zoom-prototypes/tests/browser docs/operations/uplot-real-history-pilot-2026-10-07.md
git commit -m "test(history-pilot): verify real-data mobile behavior"
```

- [ ] **Step 7: Deploy the static bundle to the authorized test server only after the root reviewer approves the implementation.**

Follow `docs/operations/mobile-history-zoom-prototypes-2026-10-07.md`: build `dist/`, checksum it, back up the existing `/prototypes/history-zoom/` directory, copy only the static artifact, and retain the rollback command. No live production host access is authorized.

- [ ] **Step 8: Verify the deployed artifact.**

Run the read-only Playwright suite with `HISTORY_ZOOM_BASE_URL` set to the HTTPS test-server subpath. Open the pilot route in the installed browser when available; if its native bridge remains unavailable, record Playwright Chromium as the fallback. Verify the auth gate without credentials. Perform real-data checks only through an existing authorized session, then record zone/card names only when they contain no raw EUI and never record sensor values or tokens.

## Plan self-review record

- Spec coverage: all route, auth, race, viewport ownership, range, units, nulls, truncation, empty/error, mobile, test, and deployment requirements map to one of the three tasks.
- Placeholder scan: no `TBD`, `TODO`, “implement later,” or unspecified error/test step remains.
- Type consistency: `PilotRangeRequest`, `PilotAcceptedData`, `ChartRenderOptions`, `PilotApi`, and `PilotRequestOwner` names are stable across tasks.
- Review-focus tests: each of the five cases at the top has an explicit unit, hook, component, or browser assertion.
