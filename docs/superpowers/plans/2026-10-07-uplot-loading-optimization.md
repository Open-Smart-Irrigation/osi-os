# uPlot loading optimization implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated and directional uPlot history navigation reuse safe work, start one useful neighboring request before the loaded edge is reached, and keep same-context background loading quiet without weakening the pilot's auth, data, or viewport fences.

**Architecture:** Put all card-data decisions behind one session-scoped history loader and one viewport scheduler in `usePilotHistory`. The loader stores bounded, complete normalized responses, joins exact or covering in-flight work, and permits at most one foreground request plus one prefetch request; the scheduler is the sole path for initial load, gestures, presets, Back/Forward, Latest, Retry, and directional prefetch. A response may enter the cache after its viewport has moved, but only the current foreground demand may replace accepted chart data, and no network completion writes the viewport.

**Tech stack:** React 18, TypeScript 5.9, Vite 7, uPlot 1.6.32, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-uplot-real-history-pilot-design.md`

**Evidence:** `.superpowers/sdd/2026-10-07-uplot-loading-analysis/observations.json`

## Global constraints

- Work only in `/home/phil/Repos/osi-os/.worktrees/mobile-history-zoom-prototypes`, starting from baseline `d8e825c28` or its reviewed descendant.
- Change only the standalone package under `web/history-zoom-prototypes`, its tests, and its package documentation. Do not change either production GUI, an API, backend code, schema, sync, auth, Node-RED flows, or production infrastructure.
- Preserve `#/uplot`, `#/echarts`, and `#/chartjs` and their comparison behavior. Loading optimization applies only to the authenticated pilot routes.
- Keep every request as an existing same-origin authenticated `GET` with `credentials:'same-origin'`, `cache:'no-store'`, `redirect:'error'`, an `AbortSignal`, and the existing token equality and session-generation fences.
- Never put a raw token in a cache key, serialized request key, React state, DOM, probe, error, screenshot, or log. Cache and in-flight identity uses `platform`, `sessionEpoch`, `zoneId`, `cardId`, bounds, and requested aggregation.
- Preserve authoritative nulls, exact unit groups, response normalization, the 2,000-point server limit, truncation UI, and the current malformed-response behavior.
- Cache only whole normalized responses. Do not merge series, aggregate buckets, partial ranges, or samples from different responses.
- Network completion never calls `store.set`, changes the horizon, or moves the chart. Gestures and explicit controls remain the only viewport writers.
- Keep no more than one physical foreground card-data request and one physical prefetch request. Zone and card catalog requests retain their existing single-owner fencing.
- A direct foreground response may still be shown when truncated or when its actual aggregation differs from the requested aggregation. Such a response is never reusable cache coverage and never satisfies a prefetch.
- No product deployment is part of these implementation tasks. Root coordinates any previously authorized test-server deployment after review and verification.

## Fixed policy values

These values are part of the reviewed design and must be named exports from `historyLoader.ts` so tests and implementation share one source of truth:

```ts
export const HISTORY_CACHE_MAX_ENTRIES = 8;
export const HISTORY_CACHE_MAX_POINTS = 20_000;
export const HISTORY_CACHE_TTL_MS = 5 * 60_000;
export const HISTORY_LATEST_TTL_MS = 15_000;
export const HISTORY_PREFETCH_IDLE_MS = 500;
export const HISTORY_PREFETCH_COOLDOWN_MS = 500;
export const HISTORY_SETTLE_MS = 150;
export const HISTORY_NEIGHBOR_SHIFT = 0.8;
```

`pointCost` is the sum of all normalized `series[].points.length`, not the server's potentially ambiguous `aggregation.pointCount`. An entry larger than the total point budget is not cached. Eviction removes expired entries first, then least-recently-used entries until both the entry and point limits hold. Empty valid responses have cost zero and may be cached.

An entry is reusable only when all of these are true:

1. context and requested aggregation match;
2. its validated coverage contains the desired visible interval;
3. `limits.truncated === false`;
4. `aggregation.level === request.aggregation` exactly;
5. its TTL has not elapsed.

Use the 15-second TTL when the request ended within one minute of the horizon end recorded at insertion; use five minutes for older intervals. Lookup chooses the smallest covering response, then the most recently used response. It never unions entries. Latest and Retry bypass cache lookup, but may join an already-running exact or covering request.

## Review focus

- Latest after time advances: update the 90-day horizon and make exactly one network request, even though rebuilding the viewport store also emits lifecycle work; do not reuse a cached latest response.
- A response finishes after the user moves elsewhere: cache it when eligible, but apply it only if the current context, generation, requested aggregation, and visible viewport still match its coverage.
- A prefetch returns `401` or `403`: clear all account-scoped data and cache exactly like a foreground auth failure; non-auth prefetch failures stay silent.
- A response is truncated or the server returns a different actual aggregation: it may satisfy the direct foreground display, but it never becomes reusable coverage or suppresses the next correct request.
- The page hides with a 150 ms timer or prefetch pending: cancel the timer and prefetch; an auth-current foreground may finish only through the unchanged intent fences. Unmount and session change additionally clear all in-flight work. Visible return rechecks the token before optionally refreshing a stale latest window.

---

### Task 1: Whole-response loader and the single request scheduler

This task owns the coupled loading policy. Assign `historyLoader.ts`, `range.ts`, `usePilotHistory.ts`, `types.ts`, and their unit tests to one implementer; do not split these files between workers.

**Files:**
- Create: `web/history-zoom-prototypes/src/pilot/historyLoader.ts`
- Create: `web/history-zoom-prototypes/tests/unit/pilot-history-loader.test.ts`
- Modify: `web/history-zoom-prototypes/src/pilot/range.ts`
- Modify: `web/history-zoom-prototypes/src/pilot/types.ts`
- Modify: `web/history-zoom-prototypes/src/pilot/usePilotHistory.ts`
- Modify: `web/history-zoom-prototypes/tests/unit/pilot-range.test.ts`
- Modify: `web/history-zoom-prototypes/tests/unit/pilot-history.test.tsx`
- Modify: `web/history-zoom-prototypes/tests/unit/pilot-request-owner.test.ts` only if the catalog owner tests need to distinguish it from card-data ownership

**Interfaces:**

Add these types and exports. `context` deliberately excludes the token.

```ts
export interface PilotHistoryContext {
  platform: PilotPlatform;
  sessionEpoch: number;
  zoneId: number;
  cardId: string;
}

export type PilotHistoryReason =
  | 'initial'
  | 'gesture'
  | 'preset'
  | 'back'
  | 'forward'
  | 'latest'
  | 'retry'
  | 'visibility'
  | 'prefetch';

export interface PilotHistoryDemand {
  context: PilotHistoryContext;
  visible: Viewport;
  request: PilotRangeRequest;
  horizon: Viewport;
  reason: PilotHistoryReason;
  forceFresh: boolean;
}

export interface PilotHistoryLoadValue {
  data: PilotAcceptedData;
  receivedAt: number; // physical response completion time; preserved on cache hits
}

export interface PilotHistoryLoadHandle {
  source: 'cache' | 'network' | 'in-flight';
  request: PilotRangeRequest;
  result: Promise<PilotHistoryLoadValue>;
}

export class PilotHistoryAbortError extends Error {
  readonly name: 'AbortError';
  readonly reason: 'superseded' | 'cleared' | 'destroyed';
}

export interface PilotHistoryLoader {
  foreground(
    demand: PilotHistoryDemand,
    load: (signal: AbortSignal) => Promise<PilotAcceptedData>,
  ): PilotHistoryLoadHandle;
  prefetch(
    demand: PilotHistoryDemand,
    load: (signal: AbortSignal) => Promise<PilotAcceptedData>,
  ): Promise<'cached' | 'joined' | 'skipped'>;
  abortPrefetch(): void;
  clear(): void;
  destroy(): void;
  diagnostics(): {
    entries: number;
    points: number;
    foregroundActive: boolean;
    prefetchActive: boolean;
  };
}

export function createPilotHistoryLoader(options?: {
  now?: () => number;
}): PilotHistoryLoader;

export function neighborRequest(
  viewport: Viewport,
  direction: 'back' | 'forward',
  horizon: Viewport,
): PilotRangeRequest | null;
```

Extend `UsePilotHistoryOptions` only for deterministic unit injection:

```ts
historyLoader?: PilotHistoryLoader;
```

Keep `UsePilotHistoryResult.status` unchanged for first-load and error compatibility, but add:

```ts
refreshing: boolean; // true only for a physical foreground network wait with accepted data
```

The hook creates one loader for a platform/session lifetime. Zone and card catalog loading continues through `createRequestOwner`; card-data loading moves out of that owner and exclusively through `PilotHistoryLoader`. A session or platform transition clears the old loader and drops its instance behind a lifetime-generation fence. Zone/card changes clear accepted UI immediately but may leave other same-session context entries in the bounded loader for a later return.

- [ ] **Step 1: Write failing loader tests for cache admission, lookup, and bounds.**

Use a fake clock and small normalized `PilotAcceptedData` fixtures. Pin all of these cases:

- exact and covering hits return without calling `load`;
- lookup never combines two adjacent responses;
- context or requested-aggregation mismatch misses;
- truncated and actual/requested-aggregation mismatch responses are returned to their direct foreground caller but are not cached;
- empty valid data can be cached;
- point cost uses the normalized samples, an oversized entry is skipped, and LRU eviction obeys 8 entries and 20,000 points;
- historical entries expire at five minutes and horizon-edge entries at 15 seconds;
- cache results preserve the entry's original `receivedAt` rather than making old data fresh at lookup time;
- `forceFresh:true` bypasses a cached entry;
- `clear()` removes all entries and aborts both slots; `destroy()` permanently skips new work.

Representative assertions:

```ts
const first = loader.foreground(demand, load);
expect(first.source).toBe('network');
await first.result;
const second = loader.foreground(demand, load);
expect(second.source).toBe('cache');
await second.result;
expect(load).toHaveBeenCalledTimes(1);

clock.advance(HISTORY_LATEST_TTL_MS + 1);
await loader.foreground(latestDemand, load).result;
expect(load).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: Run the new loader test and confirm it fails because the module is absent.**

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/pilot-history-loader.test.ts`
Expected: FAIL with module resolution errors for `historyLoader`.

- [ ] **Step 3: Implement bounded storage and cache qualification without request concurrency yet.**

Use a plain `Map` for deterministic LRU order. Store the entire normalized response plus its context, requested bounds/aggregation, horizon end at insertion, point cost, insertion time, and last-used time. Never mutate `PilotAcceptedData`. Reinsert on hit to update LRU order. Keep `cacheEligible(data)` private and require non-truncated, exact actual aggregation, finite ordered coverage, and finite sample cost.

- [ ] **Step 4: Add failing concurrency tests.**

Use deferred promises and record passed abort signals. Assert:

1. two exact foreground demands share one physical call;
2. a later visible interval contained by an in-flight request at the same requested aggregation joins it;
3. `forceFresh` still joins qualifying in-flight work;
4. a prefetch promoted by a matching foreground is not restarted;
5. a new foreground miss demotes a still-useful old foreground into the prefetch slot and starts immediately;
6. if both slots are occupied, the loader applies the exact usefulness order below and aborts the obsolete request;
7. never more than two physical signals are live, and never more than one has foreground priority;
8. completing a demoted request may populate cache but does not identify it as the current foreground result;
9. a prefetch completion does not automatically start another prefetch;
10. non-auth prefetch rejection resolves as `skipped`, while `PilotAuthError` rejects for the hook to clear the session.
11. abort, `clear()`, and `destroy()` settle every affected handle with `PilotHistoryAbortError` carrying the exact reason and produce no unhandled rejection.
12. a prefetch response that is truncated, exceeds the point budget, or reports an actual aggregation different from its requested aggregation returns `skipped`, does not enter cache, and cannot suppress foreground work.

In-flight covering checks use requested bounds and requested aggregation. Cache insertion waits for the response and applies the stricter truncation/actual-aggregation checks.

- [ ] **Step 5: Implement the two-slot coordinator and rerun loader tests.**

Model each physical request once with its controller, promise, context, request, priority, and consumers. Do not put React setters in this module. `foreground()` returns its handle synchronously so React can distinguish a cache result from a physical wait before setting `refreshing`. Promotion changes priority without restarting. Demotion preserves useful work. Normalize the platform `AbortError` raised by `fetch` into `PilotHistoryAbortError` with the coordinator's reason. Aborting one slot rejects its consumers with that error; never leave a handle unresolved and never leak an unhandled rejection. `diagnostics()` exposes counts and booleans only; it must never expose paths, tokens, response data, card ids, or device data.

Apply this deterministic priority order whenever a new foreground demand arrives:

1. advance the hook's visible-intent generation before consulting cache or in-flight work, so no older completion can apply after this demand;
2. if eligible cache covers the demand, retire the prior foreground demand id before any resolved-Promise callback can run, return the cache handle, reclassify at most one useful older physical request as prefetch, and abort other old work; `foregroundActive` must be false after the cache result wins;
3. otherwise, if an in-flight request covers the demand, promote/join it and abort any now-less-relevant second request;
4. otherwise, start the newest foreground immediately; never queue it behind an old or hung request;
5. retain the former foreground in the prefetch slot only when it is useful by the rule below and is more useful than the existing prefetch; abort whichever old request loses that comparison.

A pending request is useful only when its context and requested aggregation match and either (a) its request bounds intersect the current visible interval, or (b) its request bounds intersect the exact `neighborRequest(currentVisible, currentDirection, horizon)` bounds. Case (a) outranks case (b); ties keep the newer request. If neither condition holds, abort it. This is the complete rule: do not add an undefined proximity or “adjacent” heuristic. No superseded request may call the hook's apply path even if it later completes successfully into cache.

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/pilot-history-loader.test.ts`
Expected: PASS.

- [ ] **Step 6: Write failing range tests for directional targets.**

`neighborRequest` shifts the current viewport by exactly 80% of its span, clamps through the existing viewport/horizon rules, and then calls `bufferedRequest`. This makes the normal Back/Forward destination a cache hit, including an exact 24-hour raw window that cannot receive padding at its tier cap.

Cover:

- latest 24 h shifted back produces the exact next Back destination;
- forward at `horizon.to` and back at `horizon.from` return `null`;
- 7 d, 30 d, and 90 d stay inside their aggregation tiers and horizon;
- a clamped target that makes no progress returns `null`;
- no response merging is needed for the returned request to cover the target viewport.

- [ ] **Step 7: Implement `neighborRequest` and run range tests.**

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/pilot-range.test.ts`
Expected: PASS.

- [ ] **Step 8: Replace the hook's competing `begin` paths with one scheduler, starting with failing hook tests.**

Build a deterministic `Probe` around an injected loader and fake timers. Extend the unit tests to pin this event policy:

- initial selection schedules one foreground demand and, only after it is accepted and 500 ms remains quiet, one Back prefetch;
- the prefetch does not update `accepted`, `status`, `loadingRequest`, `error`, or the viewport;
- a gesture notification retains the 150 ms trailing foreground wait;
- directional movement of at least 5% of the visible span may start one neighbor prefetch before gesture end, with a 500 ms start cooldown;
- preset, Back, and Forward go through the scheduler immediately rather than also firing the gesture timer;
- Back into a prefetched response applies it without a network call; Forward back to the prior response also uses cache;
- rapid successive misses let a now-stale but useful response finish into cache, and apply only the response covering the current visible interval;
- an accepted network response never changes `store.get()`;
- a cache hit does not set `loadingRequest` or `refreshing`;
- a cache hit retires the previous visible-intent id synchronously, before its resolved `result` Promise callback, so a formerly current background result cannot replace the cached selection;
- a physical same-context foreground network wait retains accepted data, sets `refreshing:true`, and keeps `status:'ready'` (or `'empty'` when the accepted response is empty);
- initial loading without accepted data remains `status:'loading'` and `refreshing:false`;
- a foreground failure retains accepted data and exact Retry request; Retry bypasses cache;
- prefetch failure is silent except `401`/`403`, which clears all account data and the loader;
- truncated or actual-aggregation-mismatch foreground data displays, but navigating away and back requests again;
- the 150 ms timer is cancelled on unmount, identity change, explicit control, hidden transition, and session change.

- [ ] **Step 9: Implement the scheduler in `usePilotHistory`.**

Use one internal function with this conceptual signature; keep it private unless extracting it makes the hook materially smaller:

```ts
scheduleViewport(
  viewport: Viewport,
  reason: Exclude<PilotHistoryReason, 'prefetch'>,
  options?: { forceFresh?: boolean; failedRequest?: PilotRangeRequest },
): void;
```

The store subscription handles only `source:'gesture'`. Explicit handlers call `store.set(..., 'external')` and invoke this same scheduler themselves, so one action cannot produce a control request plus a delayed duplicate. Cancel any pending gesture timer before scheduling an explicit action.

At schedule time, capture the current raw token only in the hook's closure. Before starting a load, before applying an immediately returned cache handle, and again when any handle settles, require `readToken()` to equal that capture in addition to mounted/session/context/visible-intent generation checks. A same-tab `localStorage` mutation does not reliably emit `storage` in that tab, so event listeners are not the acceptance fence. A mismatch clears account state and the loader before anything applies.

Invalidate the visible-intent generation on every actual gesture viewport change, before starting the 150 ms timer. An obsolete foreground consumer never changes UI, even when its response covers the newer viewport; its physical request may populate the cache, and the newest consumer may join that work or select its cached result. When a handle settles for the still-current visible intent and the current viewport still matches the demand viewport, apply its direct response even if validated response coverage is smaller than requested, it is truncated, or its actual aggregation differs. This yields a finite `ready`/`empty` state and lets the existing not-loaded/truncation UI describe the partial result. A cache result must not flash loading state. A network/in-flight handle sets `refreshing` synchronously only when accepted data already exists.

Track the last viewport center to infer `back` or `forward`. During gestures, allow one leading prefetch once movement reaches 5% of the span and the 500 ms cooldown permits it. After initial or foreground acceptance, schedule at most one neighbor prefetch after 500 ms in the last direction; default initial direction is Back. Only a viewport event or foreground acceptance may schedule prefetch. Prefetch completion itself schedules nothing.

- [ ] **Step 10: Make Latest, horizon changes, visibility, and session teardown explicit and test them.**

Add tests that prove:

- Latest floors the new clock to a minute, rebuilds the 90-day horizon/store around the preserved span, bypasses cache, cancels any old timer, and issues exactly one physical request;
- a duplicate Latest while that exact request is pending joins it;
- advancing the clock and pressing Latest updates the future horizon and does not reuse the former live-edge entry;
- changing token aborts foreground/prefetch, clears cache/zones/cards/accepted/errors, increments the public session epoch, and rejects late data;
- on `document.hidden`, cancel the settle timer and abort prefetch but do not discard accepted historical data or abort an auth-current foreground request; that foreground may apply only under the unchanged token/context/visible-intent fences;
- on visible return, recheck the token; with the same token, force-refresh only when the visible interval touches the horizon end and `receivedAt` is older than 15 seconds;
- unmount clears the active loader, advances a lifetime guard, and leaves no pending timer or unhandled promise.

Do not call `destroy()` from ordinary React effect cleanup: development StrictMode runs cleanup and replays the effect against the same memoized instance. Use `clear()` plus mounted/lifetime guards for cleanup; reserve `destroy()` for an explicitly retired instance or direct loader tests. The StrictMode hook test must render inside `<React.StrictMode>`, complete the replay, and still load successfully once the replayed effects run.

For Latest, store the pending target and reason before changing `horizonEnd`; let the new store/horizon lifecycle consume that intent exactly once. Do not call a foreground load against the old store and then another from the horizon effect. When the floored clock equals the current `horizonEnd`, schedule the force-fresh demand directly against the current store instead of waiting for a state change that React will elide; a second click then joins the exact pending request.

- [ ] **Step 11: Run all loading-policy unit tests.**

Run:

```bash
cd web/history-zoom-prototypes
npx vitest run \
  tests/unit/pilot-history-loader.test.ts \
  tests/unit/pilot-range.test.ts \
  tests/unit/pilot-history.test.tsx \
  tests/unit/pilot-request-owner.test.ts \
  tests/unit/pilot-api.test.ts \
  tests/unit/pilot-normalize.test.ts
```

Expected: PASS, with no unhandled rejection or fake-timer leak.

- [ ] **Step 12: Commit Task 1.**

```bash
git add \
  web/history-zoom-prototypes/src/pilot/historyLoader.ts \
  web/history-zoom-prototypes/src/pilot/range.ts \
  web/history-zoom-prototypes/src/pilot/types.ts \
  web/history-zoom-prototypes/src/pilot/usePilotHistory.ts \
  web/history-zoom-prototypes/tests/unit/pilot-history-loader.test.ts \
  web/history-zoom-prototypes/tests/unit/pilot-range.test.ts \
  web/history-zoom-prototypes/tests/unit/pilot-history.test.tsx \
  web/history-zoom-prototypes/tests/unit/pilot-request-owner.test.ts
git commit -m "perf(history-pilot): reuse and prefetch whole responses"
```

### Task 2: Quiet same-context loading UI

This task may be implemented after Task 1's result interface is stable. Its files do not overlap Task 1.

**Files:**
- Modify: `web/history-zoom-prototypes/src/pilot/PilotApp.tsx`
- Modify: `web/history-zoom-prototypes/src/styles.css`
- Modify: `web/history-zoom-prototypes/tests/unit/pilot-app.test.tsx`

**Interfaces:**

Consumes `UsePilotHistoryResult.refreshing`, existing `loadingRequest`, `accepted`, `status`, `error`, and `failedRequest`. It does not inspect loader diagnostics or cache state.

- [ ] **Step 1: Add failing component tests for loading prominence.**

Cover the exact visible behavior:

- first load with no accepted data announces `Loading history…` and may use the existing blocking chart-area treatment;
- a same-context physical foreground wait keeps the chart fully visible and interactive, does not render `.pilot-loading-overlay`, and leaves the live status text as `Ready`;
- background refresh exposes a non-live, visually quiet `Updating nearby history…` text only while a physical foreground network request is active; cache hits and prefetches show no updating text;
- the not-loaded hatching remains the progress cue outside accepted coverage;
- background failure still shows the existing interval-specific inline error and Retry while keeping the chart;
- initial failure still shows the full error panel;
- prefetch never produces loading, success, or failure UI;
- `aria-live` does not repeatedly announce pan/prefetch churn.

Do not assert private loader calls. Drive the component with hook state or the existing API harness and assert rendered behavior.

- [ ] **Step 2: Implement quiet loading in `PilotApp` and scoped CSS.**

Derive:

```ts
const initialLoading = history.status === 'loading' && !history.accepted;
const backgroundLoading = history.refreshing && !!history.accepted;
```

Keep the primary `role="status"` message stable at `Ready` during background work. Render `Updating nearby history…` as small non-live metadata (`aria-live="off"` or `aria-hidden="true"` with an equivalent accessible stable status). Remove the full-chart blue loading overlay for accepted-data refreshes. Do not add a spinner to sensor toggles, controls, or chart gestures.

- [ ] **Step 3: Run the focused component tests.**

Run: `cd web/history-zoom-prototypes && npx vitest run tests/unit/pilot-app.test.tsx tests/unit/pilot-history.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit Task 2.**

```bash
git add \
  web/history-zoom-prototypes/src/pilot/PilotApp.tsx \
  web/history-zoom-prototypes/src/styles.css \
  web/history-zoom-prototypes/tests/unit/pilot-app.test.tsx
git commit -m "fix(history-pilot): quiet background loading feedback"
```

### Task 3: Deterministic request-count and interaction evidence

This task owns browser fixture and test authorship. It starts after Tasks 1 and 2 are integrated. Root owns browser execution, README wording, any operations record, and deployment; a test worker must not start the shared preview server or browser suite.

**Files:**
- Modify: `web/history-zoom-prototypes/tests/browser/pilot-fixtures.ts`
- Modify: `web/history-zoom-prototypes/tests/browser/pilot-history.spec.ts`
- Root modify after test review: `web/history-zoom-prototypes/README.md`

**Interfaces:**

Extend recorded requests with a test-only snapshot. Browser URLs cannot reveal whether an in-flight request was promoted or demoted, so browser evidence classifies only known bounds/reasons and total physical/aborted work; pure loader tests own the one-foreground/one-prefetch lane invariant.

```ts
export interface PilotRequestSnapshot {
  initial: readonly RecordedRequest[];
  neighbor: readonly RecordedRequest[];
  latest: readonly RecordedRequest[];
  total: readonly RecordedRequest[];
  aborted: readonly RecordedRequest[];
}
```

The production client must not add diagnostic request parameters, headers, or globals to make tests easier.

- [ ] **Step 1: Repair the browser harness for automatic background traffic.**

Change pilot navigation helpers from `goto(..., { waitUntil:'networkidle' })` to `domcontentloaded`, then await the chart and stable `Ready` status. Automatic prefetch is allowed to remain in flight and must not make navigation hang.

Change `releaseAll` to resolve each `DeferredReply` from `reply.request`; remove the current last-N index arithmetic, which becomes incorrect when foreground and prefetch requests interleave. Add helpers that find a request by exact bounds and aggregation. Existing race tests must wait for the intended foreground request, not `pendingData.length` or the last global request.

- [ ] **Step 2: Preserve the existing 13 pilot browser scenarios under prefetch.**

Update their synchronization without weakening their meaning:

- pinch/pan remains interactive during a delayed foreground request;
- later foreground demand wins without moving the viewport;
- auth revocation fences all pending work;
- unit, null/zero, truncation, empty, malformed, auth, and retry assertions remain intact;
- expected aborted requests are correlated with the deferred foreground/prefetch URL that the test owns;
- no test disables production prefetch merely to retain old request counts.

- [ ] **Step 3: Add a deterministic request-efficiency scenario.**

Use a fixed clock, 600 ms delayed contract fixtures, and recorded request bounds. Assert all of these in one isolated test or a small serial group:

1. initial foreground starts once;
2. after acceptance and 500 ms quiet, one Back neighbor prefetch starts and no completion-triggered prefetch chain follows;
3. Back uses the pending or cached neighbor without a duplicate physical request;
4. Forward to the original interval makes zero new physical requests;
5. two Latest clicks while the first exact refresh is pending produce exactly one physical request;
6. a directional drag can start a useful request before touch end, subject to the 500 ms cooldown;
7. at every sample, active card-data requests are at most two total; loader unit tests separately prove their lane priorities;
8. initial, neighbor, Latest, total, and aborted counts are written to a JSON attachment under the normal Playwright results directory.

Use bounds plus aggregation to distinguish known work and document that a neighbor request may later be promoted without changing its URL. Do not infer current priority from “last request.”

Measure request start, response release, and UI-ready polling as separate timestamps. The baseline observation released the first pan response about 719 ms after touch end, while the recorded ready poll was later and included polling delay; do not report the release interval as UI-ready latency. The primary acceptance claim is reduced physical request/abort count with no interaction regression.

- [ ] **Step 4: Add a browser scenario for excluded cache entries and auth failures.**

Return a truncated response and, separately, an actual/requested aggregation mismatch; navigate away and back and assert another physical request occurs. Return `401` from a prefetch and assert login-required state, no accepted chart/account labels, and no late reappearance after deferred foreground responses are released. A non-auth prefetch `500` must leave `Ready`, accepted chart data, and no Retry/error UI.

- [ ] **Step 5: Hand the authored browser changes to root for the focused pilot run.**

Root runs: `cd web/history-zoom-prototypes && npx playwright test tests/browser/pilot-history.spec.ts`

Expected: PASS. Root inspects the request-count attachment and confirms it contains no authorization value or response payload. The author does not launch a competing browser run.

- [ ] **Step 6: Root updates package documentation after the browser evidence is reviewed.**

In `README.md`, describe the bounded session cache, directional neighbor prefetch, Latest freshness, and quiet background feedback in user terms. State that cached responses remain whole and bounded, `fetch` still uses `no-store`, and auth/session changes clear reusable history. Do not advertise offline history or claim partial-range merging.

- [ ] **Step 7: Commit Task 3.**

```bash
git add \
  web/history-zoom-prototypes/tests/browser/pilot-fixtures.ts \
  web/history-zoom-prototypes/tests/browser/pilot-history.spec.ts
git commit -m "test(history-pilot): prove bounded loading reuse"
```

### Task 4: Integrated verification and independent review

**Files:**
- Review all files changed by Tasks 1–3
- Do not create or update a success report until every command below has current evidence

- [ ] **Step 1: Run the complete unit suite.**

Run: `cd web/history-zoom-prototypes && npm test`
Expected: PASS with no unhandled rejection, act warning, or fake-timer leak.

- [ ] **Step 2: Run the production build.**

Run: `cd web/history-zoom-prototypes && npm run build`
Expected: PASS for `tsc --noEmit` and Vite. Confirm no backend or production-GUI artifact was generated or modified.

- [ ] **Step 3: Run the full browser suite serially.**

Run: `cd web/history-zoom-prototypes && npm run test:browser`
Expected: PASS for the existing comparison routes and both pilot routes. Do not overlap this command with another browser worker.

- [ ] **Step 4: Inspect the diff and working tree.**

Run:

```bash
git diff --check d8e825c28...HEAD
git status --short
git diff --stat d8e825c28...HEAD
```

Expected: no whitespace errors; only the planned standalone package, tests, and plan/docs files changed. Preserve unrelated user changes if the working tree is not otherwise clean.

- [ ] **Step 5: Perform the independent Sol review requested by the user.**

Review cache/session isolation, concurrency slots, Latest exact-one behavior, visibility teardown, truncated/aggregation exclusion, quiet UI, and request-count evidence against this plan and the original pilot design. Re-run the smallest focused test for every correction. Record findings by severity with exact file and line references; GREEN requires no open correctness, auth, data-integrity, or viewport-ownership finding.

- [ ] **Step 6: Controller integrates the reviewed commits and decides deployment separately.**

Root reviews and revises this plan, coordinates Luna implementation and Sol review, and may perform the already authorized test-server deployment after local verification. No additional user confirmation is required by this plan, and no worker should access a production cloud host or a live gateway.
