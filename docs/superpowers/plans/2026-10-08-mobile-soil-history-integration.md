# Mobile soil history integration implementation plan

Execution evidence and the remaining authenticated release gate: [canary report](../../operations/mobile-soil-history-canary-2026-10-08.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Write each regression first, observe the stated failure, then make the smallest implementation change.

**Goal:** Put the reviewed uPlot history experience behind a default-off build flag in one real mobile soil-history card on edge and cloud, without changing desktop history, backend policy, or the main deployed applications during the canary.

**Architecture:** Extract the selected chart, gesture controller, bounded response loader, range policy, and mobile soil surface into the canonical local package `web/history-uplot-core`. The edge and cloud applications keep ownership of authentication, card discovery, source selection, API calls, and translations. A small adapter in each application normalizes its existing history response into the shared contract and passes an abortable loader to the shared surface. The cloud repository receives a byte-identical vendor copy guarded from the canonical package. Canary builds use separate same-origin static paths and an explicit Vite flag; ordinary builds keep the existing components.

**Bases:** Edge work starts from `93ffe716b` in `/home/phil/Repos/osi-os/.worktrees/mobile-history-zoom-prototypes`. Cloud work starts from `a613a083` in `/home/phil/Repos/osi-server/.worktrees/mobile-soil-history`, which matches the current test image lineage.

**Prior evidence:** `docs/superpowers/specs/2026-10-07-uplot-real-history-pilot-design.md`, `docs/superpowers/plans/2026-10-07-uplot-loading-optimization.md`, and `docs/superpowers/plans/2026-10-07-uplot-history-coverage-recovery.md` define the reviewed behavior. The prototype package is the implementation source, rather than a visual reference to reproduce independently.

## Scope and invariants

- The new path requires all four conditions: `VITE_HISTORY_UPLOT_SOIL_ENABLED === 'true'`, the existing server-provided history UX permission is ready and enabled, the current layout is mobile, and the selected card has `cardType === 'soil'`. A missing, empty, or differently cased build value is false.
- The build flag is frontend-only. Do not add a backend feature flag, endpoint, query parameter, schema field, or deployment dependency.
- Desktop continues through its current history component even in a flag-enabled build. Non-soil mobile cards do too. The canary defaults mobile soil to `line-chart`; an explicitly selected soil-profile, calendar, or advanced view keeps its existing implementation. Only the soil line-chart owns the new gesture controller and loader.
- Edge passes only an API-advertised `sourceKey`. Cloud does not add `sourceKey`: its card ID already identifies the history source and its controller does not accept that parameter.
- Keep requests on the existing authenticated same-origin clients. Add `AbortSignal` plumbing where absent. The shared package never reads a token, Axios singleton, route, username store, or browser storage.
- A loader context contains a host-created session epoch/key, scope, card ID, and optional source key. It contains no raw token. The host must destroy the prior loader and clear accepted data when authentication identity changes, including a same-tab token transition.
- Preserve the reviewed loader limits: 8 whole responses, 20,000 normalized points, five-minute historical TTL, 15-second latest TTL, one foreground plus one prefetch request, 150 ms gesture settle, 500 ms prefetch idle/cooldown, and an 80% neighbor shift. Truncated or actual/requested-aggregation-mismatch responses may satisfy their current direct demand but are not reusable coverage.
- Each request/view spans at most 90 days. The navigation extent reaches the Unix epoch so a user may pan farther back without a giant request. Latest rebuilds the horizon from the current clock.
- Null samples stay gaps and numeric zero stays a sample. The renderer never connects across an absent value or converts missing data to zero.
- Empty valid responses keep the chart mounted, its viewport interactive, and the prior same-context series metadata/toggle layout stable without retaining old points. Unsupported, unauthenticated, and malformed responses keep their current host error behavior.
- Never label a date as the earliest available measurement. The current APIs do not provide that fact. Show the response's actual aggregation, returned point count, and loaded request/coverage interval. Show coverage percentage or `dataAsOf` only when the backend supplied it. Older cloud intervals can be empty under the unchanged 30-day retention policy.
- Do not add automatic aggregation fallback. Do not change raw retention, rollup jobs, sync, history schemas, backend query policy, or April data backfill.
- Do not ship Chart.js or ECharts through the shared package or either real application integration.

## Shared interfaces

Create `web/history-uplot-core` as the canonical package named `@osi/history-uplot`. Its public entry points expose the chart/controller and the mobile history model, not pilot authentication or catalog code.

```ts
export type HistoryAggregation = 'raw' | '15m' | 'hourly' | 'daily';

export interface HistoryWindowContext {
  sessionKey: string;       // opaque host epoch, never a bearer token
  scopeKey: string;         // for example zone:7
  cardId: string;
  sourceKey?: string | null;
}

export interface HistoryWindowRequest {
  from: number;
  to: number;
  rangeLabel: '24h' | '7d' | '30d';
  aggregation: HistoryAggregation;
}

export interface HistoryWindowResponse {
  request: HistoryWindowRequest;
  coverage: { from: number; to: number };
  series: readonly HistorySeries[];
  unitGroups: readonly HistoryUnitGroup[];
  aggregation: {
    level: string;
    pointCount: number;
    coveragePct?: number | null;
  };
  limits: { maxPointsPerSeries: number; truncated: boolean };
  freshness?: { dataAsOf?: string | null; syncState?: string | null };
}

export interface HistoryWindowOptions {
  enabled: boolean;
  context: HistoryWindowContext | null;
  load(request: HistoryWindowRequest, signal: AbortSignal): Promise<HistoryWindowResponse>;
  now?: () => number;
  navigationStartMs?: number; // defaults to 0
}
```

`useHistoryWindow(options)` returns `status`, `accepted`, `refreshing`, `error`, `viewportStore`, `horizon`, `selectPreset`, `moveWindow`, `showLatest`, and `retry`. A cache hit does not set `refreshing`; a physical foreground refresh with accepted data does. The current intent generation, viewport equality, session key, scope/card/source identity, visibility, and component lifetime all fence result acceptance. A `401` or `403` is returned to the host's existing auth handler even when the failed physical request began as prefetch or was later demoted.

`MobileSoilHistory` accepts the model, host-provided labels, a locale/time-zone formatter, and optional source controls. It owns uPlot rendering, unit tabs, per-series toggles, the inspector, preset/Back/Forward/Latest controls, quiet refresh text, actual aggregation and loaded-interval text, truncation/not-loaded shading, and the non-blocking empty overlay. Host pages keep headings, breadcrumbs, selectors, exports, and routing.

## Task 1: Extract the canonical uPlot package and keep the prototype on it

**Files:**

- Create `web/history-uplot-core/package.json`, `tsconfig.json`, and `src/index.ts`
- Move or copy with history into `web/history-uplot-core/src/`: `ChartHost.tsx`, `adapters/uplot.ts`, `adapters/uplot-data.ts`, `shared/gestures.ts`, `shared/inspection.ts`, `shared/loading.ts`, `shared/types.ts`, `shared/viewport.ts`, `pilot/historyLoader.ts`, and `pilot/range.ts`
- Create `web/history-uplot-core/src/history/useHistoryWindow.ts` and `src/mobile/MobileSoilHistory.tsx`
- Create package unit tests by moving the corresponding prototype tests, then add `useHistoryWindow.test.tsx` and `MobileSoilHistory.test.tsx`
- Modify `web/history-zoom-prototypes/package.json`, imports, and narrow compatibility re-exports
- Modify `web/history-zoom-prototypes/src/pilot/usePilotHistory.ts` and `PilotApp.tsx` to consume the shared controller/model/surface where this does not require changing the comparison routes

- [ ] Write failing package tests for the public exports and the complete scheduler matrix before extracting code. Keep the loader/range tests from the reviewed pilot intact rather than reducing them to source-string guards.
- [ ] Extract only the selected uPlot path. Keep `chartjs.ts`, `echarts.ts`, their dependencies, and the three-way comparison shell in `history-zoom-prototypes`.
- [ ] Generalize `usePilotHistory` into `useHistoryWindow` by injecting `load`, `context`, and `now`. Do not carry platform probing, login, token reads, zone/card catalog requests, or pilot API code into the package.
- [ ] Extract the mobile soil surface from `PilotApp` with metadata scoped by the full `sessionKey/scopeKey/cardId/sourceKey` identity. On a same-context empty response retain descriptors and toggle choices but pass an empty point array to uPlot. On any identity change discard both metadata and points.
- [ ] Keep `ChartHost`'s separate navigation extent and `maxSpanMs`; D3 scale extent must be `[navigationDuration / maxSpanMs, navigationDuration / minSpanMs]`. Keep the explicit `dblclick.zoom` removal because a second inspection tap must not zoom.
- [ ] Run `npm test` and `npm run build` in both `web/history-uplot-core` and `web/history-zoom-prototypes`. Run the prototype Playwright suite after the package conversion. Expected: all existing uPlot, gesture, loading, empty-recovery, past-90-day, max-span, and inspection cases remain green.

## Task 2: Add the edge adapter and default-off mobile soil branch

**Files:**

- Modify `web/react-gui/package.json` and lockfile to depend on `file:../history-uplot-core`
- Create `web/react-gui/src/history/mobileSoilUplot.ts` and `mobileSoilHistoryAdapter.ts`
- Create `web/react-gui/src/components/history/mobile/MobileSoilUplotHistory.tsx`
- Modify `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify `web/react-gui/src/services/api.ts` only to pass an `AbortSignal` through the existing history request
- Modify `web/react-gui/src/i18n/config.ts`, locale history JSON files, `vite.config.js`, and `src/vite-env.d.ts`
- Add focused unit tests beside the files above and a Playwright spec for the flag-enabled canary

- [ ] Test the gate as a pure function. It is true only for explicit build value `true`, ready/enabled `historyUx`, mobile layout, and soil card. Prove flag-absent, desktop, non-soil, permission-loading, permission-disabled, and unsupported-card paths retain the current component and request pattern.
- [ ] Test the adapter with existing edge response fixtures. It sends current card ID, numeric scope, selected advertised `sourceKey`, range label, requested aggregation, bounds, and signal through `historyAPI`; it preserves server `aggregation`, `limits`, null points, zero points, units, sensor labels, and coverage fields.
- [ ] Mount `MobileSoilUplotHistory` only in the existing mobile detail seam. Do not change `HistoryDesktopShell`, `HistoryCardFrame`, or the existing visualization used by other cards.
- [ ] Build `sessionKey` from the host's authenticated session epoch/account identity, never its token. Tests release an old deferred response after logout/login and after source/card changes and assert that it neither repopulates the chart nor its metadata. A prefetch `401/403` must enter the existing login-required path; a prefetch `500` remains silent while accepted data stays visible.
- [ ] Translate every new label through the existing history namespace. Add no pilot, cache, request-lane, or implementation terminology to the UI.
- [ ] Make Vite base configurable with `VITE_BASE_PATH`, defaulting exactly to `/gui/`. Build locale URLs from `import.meta.env.BASE_URL`. Unit-test the default and `/gui/previews/mobile-soil/` values.
- [ ] Add browser coverage at a 390 px viewport: real mobile soil card selection, source parameter, unit and series toggles, pointer/touch inspection, continuous drag prefetch before lift, Back/Forward cache reuse, Latest freshness, quiet refresh, empty-interval gesture recovery, null/zero rendering, past-90-day navigation, and reverse pinch capped at 90 days. Assert foreground/prefetch/abort request classes from captured requests, not array positions.
- [ ] Run edge unit tests, production build with no flag, and canary build with `VITE_HISTORY_UPLOT_SOIL_ENABLED=true VITE_BASE_PATH=/gui/previews/mobile-soil/`. The ordinary build must exercise the existing route; the canary's asset and locale URLs must stay under its base.

## Task 3: Vendor the package and add the cloud adapter

**Files:**

- Vendor canonical `web/history-uplot-core` to `/home/phil/Repos/osi-server/.worktrees/mobile-soil-history/frontend/vendor/history-uplot-core`
- Modify cloud `frontend/package.json` and lockfile to use `file:vendor/history-uplot-core`
- Create cloud `frontend/src/history/mobileSoilUplot.ts` and `mobileSoilHistoryAdapter.ts`
- Create cloud `frontend/src/components/history/MobileSoilUplotHistory.tsx`
- Modify cloud `frontend/src/components/history/HistoryMobileShell.tsx` and/or `HistoryCardFrame.tsx` only at the mobile soil seam
- Modify cloud `frontend/src/services/api.ts` only for abort-signal plumbing
- Modify cloud `frontend/src/App.tsx`, `src/i18n/config.ts`, locale files, `vite.config.ts`, and `src/vite-env.d.ts`
- Add cloud unit and Playwright tests beside existing history tests

- [ ] Copy the reviewed canonical package byte for byte. Do not hand-port its behavior or alter vendored files in the cloud repository.
- [ ] Apply the same four-part gate. Ensure `HistoryDesktopShell` and all non-soil `HistoryCardFrame` behavior remain unchanged when the flag is true.
- [ ] Normalize the existing cloud card response without adding `sourceKey`. Tests must fail if the adapter sends one. Preserve its card-derived source, actual aggregation, point count, truncation, nulls, zeros, and any backend-supplied coverage/freshness fields.
- [ ] Fence session changes using the authenticated cloud identity/epoch available to `HistoryDashboard`. A delayed response from a previous login, scope, or card cannot enter cache, chart, metadata, or labels.
- [ ] Make cloud Vite base configurable through `VITE_BASE_PATH`, default `/`. Set `BrowserRouter` basename from the normalized `import.meta.env.BASE_URL` and build locale URLs from the same base. Test `/`, `/prototypes/mobile-soil/`, direct navigation to the nested history route, asset URLs, and locale URLs.
- [ ] Run the cloud frontend unit suite and ordinary build with the flag absent. Then build the canary with `VITE_HISTORY_UPLOT_SOIL_ENABLED=true VITE_BASE_PATH=/prototypes/mobile-soil/` and run its mobile soil browser cases.

## Task 4: Guard the cross-repository source of truth

**Files:**

- Create `scripts/verify-history-uplot-vendor.sh`
- Create `scripts/test-verify-history-uplot-vendor.sh`
- Document the package provenance and update command in `web/history-uplot-core/README.md` and the cloud vendor README

- [ ] Make the verifier require `OSI_SERVER_ROOT`, resolve both roots, and compare the package manifest, TypeScript source, and package tests while excluding generated output and dependency directories. A missing cloud checkout must fail with a clear message rather than silently skip.
- [ ] Prove the verifier red by changing a temporary copied file, then prove it green against the reviewed cloud worktree.
- [ ] Record both repository SHAs and the verifier result in each execution report. Any later package change must update the vendor copy in the same reviewed slice.

## Task 5: Independent verification and same-origin canaries

Root owns deployment and live credentials. Product workers prepare artifacts and evidence only.

- [ ] Run fresh, independent unit suites and builds for `history-uplot-core`, the prototype, edge GUI, and cloud frontend. Run the prototype browser suite and the new host browser specs. Record commands, exit codes, counts, and artifact paths.
- [ ] Build ordinary applications without `VITE_HISTORY_UPLOT_SOIL_ENABLED`; prove the existing mobile and desktop history paths still render. Build separate canary artifacts with the flag and base path values from Tasks 2 and 3.
- [ ] Deploy the cloud static canary at `/prototypes/mobile-soil/` with a new Caddy prefix and guarded configuration rollback; preserve the backend and main frontend. For edge `/gui/previews/mobile-soil/`, clone the current immutable paired payload, add the preview only in the staged GUI, recreate compatibility metadata, and prove flows plus every GUI file outside the preview are byte-identical. Flip the pair through `deploy-payload-swap.js` without restarting Node-RED. Verify unchanged PID/start time and main GUI bytes. Retain the old pair and roll back to it on failure. Do not change database, flow content, settings, or firmware metadata.
- [ ] Verify direct-load routing, JavaScript/CSS assets, locale files, login/session handling, and same-origin history API calls at each canary path. Edge verification uses the Pi's private same-origin URL; do not add a public proxy. Do not store tokens in traces, screenshots, reports, or request dumps.
- [ ] With an authenticated soil card, verify the actual selected source/card in the request, response aggregation, loaded interval, point count, null gaps, zero samples, toggles, inspection, continuous pinch/pan, background loading, cache reuse, empty recovery, older navigation, and Latest. Confirm every request span is at most 90 days and no label claims an earliest available date.
- [ ] Open the ordinary desktop history route on both hosts after canary deployment and confirm its component and request behavior are unchanged. Check console errors and horizontal overflow at 390 px and 448 px.
- [ ] If no authenticated canary session is available, stop before claiming real-data verification. Record static/auth-gate results as partial evidence and leave the deployment unpromoted until the authenticated cases run.

## Commit and review order

1. Commit the canonical package extraction and prototype conversion in `osi-os` after its unit/build/browser gates pass.
2. Commit the edge adapter, flag, base-path support, translations, and tests separately.
3. Commit the byte-identical cloud vendor copy and cloud integration in `osi-server` from base `a613a083`.
4. Commit the cross-repository verifier and execution reports after it proves both the red and green cases.
5. Sol independently reviews each product diff against this plan. Root records amendments and deployment evidence. Luna fixes any material finding before the final verification run.

The canary is the end of this slice. Replacing either main frontend requires a later explicit promotion decision based on the authenticated canary evidence.
