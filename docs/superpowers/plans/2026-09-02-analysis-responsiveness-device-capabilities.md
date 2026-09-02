# Analysis Responsiveness and Device Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Analysis workspace responsive before charts load, expose Sentek sources on AgroLink cloud, and list only channels a soil device can actually measure.

**Architecture:** Keep analysis metadata and source discovery lightweight, and move ECharts behind the selected-series boundary. Edge derives Sentek channels from its persisted probe configuration; cloud derives them from the finite values in its mirrored device state, with numeric zero treated as a measurement. The AgroLink deployment line receives its missing Sentek catalog commit plus these general fixes, while the reusable fixes are also prepared from main.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Apache ECharts, Node.js `node:test`, Node-RED helper modules, Spring Boot, JUnit 5, MockMvc.

**Spec:** User-approved bounded design from the 2026-09-02 session; no separate specification file.

## Global Constraints

- Do not access or mutate `osicloud.ch`; only public `agro-link.ch` asset inspection is in scope.
- Preserve the desktop-only Analysis route guard.
- Do not load ECharts until at least one series is selected.
- Edge Sentek `DRAGINO_SDI12` channels come from `soil_moisture_probe_depths_json` or the canonical channel layout; cloud channels come from finite values in mirrored current state, where numeric zero is valid.
- A Sentek source must not advertise `swt_1`, `swt_2`, or `swt_3` unless those fields are actually measured.
- Keep the bcm2712 and bcm2709 runtime helper copies byte-for-byte identical.
- Change English button copy to `Stack` and `Overlay`; do not rename the persisted layout values `stacked` and `overlaid`.
- Cache only Vite fingerprinted `/assets/**` resources as immutable; keep HTML and API responses uncached.
- Use failing tests before implementation changes and run repository-specific verification before completion.

---

### Task 1: Edge source capability filtering

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.test.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.js`

**Interfaces:**
- Consumes: a device row with `type_id`, capability flags, and JSON `current_state`.
- Produces: `displaySafeDeviceContext(device)` with parsed measurement facts and `cardChannelsForSource(cardType, source)` returning only supported channel keys.

- [ ] **Step 1: Write the failing capability tests**

Add tests that pass a Sentek depth projection containing `vwc_1` and `vwc_8`. Assert the result is exactly `['vwc_1', 'vwc_8']` and excludes every SWT channel. Add fallback assertions for Chameleon and Kiwi soil sources.

- [ ] **Step 2: Run the focused test and confirm the wrong fallback**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js`

Expected: FAIL because a non-Chameleon soil source currently receives the complete soil manifest.

- [ ] **Step 3: Implement finite-measurement channel selection**

Parse object or JSON-string depth/layout configuration defensively, retain only manifest-backed configured fields, and use explicit legacy fallbacks: Chameleon gets `swt_1..3`; Kiwi gets its two canonical SWT channels; unknown soil devices do not receive the full manifest.

- [ ] **Step 4: Mirror and verify both profiles**

Run:

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.test.js
node scripts/test-history-helper.js
node scripts/verify-profile-parity.js
```

Expected: all history-helper assertions pass and profile parity reports success.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm27{09,12}/files/usr/share/node-red/osi-history-helper/{analysis.js,analysis.test.js}
git commit -m "fix: derive analysis channels from device measurements"
```

### Task 2: Frontend loading boundary and chart payload

**Files:**
- Modify: `web/react-gui/tests/analysis-lazy-route.test.ts`
- Modify: `web/react-gui/src/App.tsx`
- Modify: `web/react-gui/src/components/analysis/AnalysisChartPanel.tsx`
- Modify: `web/react-gui/src/components/analysis/EChart.tsx`
- Modify: `web/react-gui/src/components/analysis/__tests__/AnalysisChartPanel.test.tsx`
- Modify: `web/react-gui/src/components/analysis/__tests__/EChart.test.tsx`
- Apply equivalent changes under `osi-server/frontend/`.

**Interfaces:**
- Consumes: `AnalysisChartPanelProps` and existing ECharts option objects.
- Produces: the same rendered charts and imperative `EChartHandle`, with chart modules fetched only for non-empty series.

- [ ] **Step 1: Change route and chart-boundary tests first**

Require `App.tsx` to statically import the small `AnalysisRoute` guard, require the guard to lazy-load `CrossZoneAnalysisPage`, and require `AnalysisChartPanel` to lazy-load `EChart` and `CorrelationPanel`. Retain the empty-state assertion so no lazy chart component renders for `series=[]`.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run the edge and cloud analysis route and chart-panel test files with their existing Node/Vitest runners.

Expected: FAIL because App has an extra lazy hop and the chart components are static imports.

- [ ] **Step 3: Move the lazy boundary to chart rendering**

Statically import `AnalysisRoute` in the edge App. Use `React.lazy` and `Suspense` around chart/correlation rendering inside both `AnalysisChartPanel` copies, after the empty-series return. Preserve `chartRef`, layouts, normalization, and correlation behavior.

- [ ] **Step 4: Replace whole-package ECharts imports**

Register `LineChart`, `ScatterChart`, `GridComponent`, `TooltipComponent`, `LegendComponent`, and `CanvasRenderer` through `echarts/core`, then call `init` from that module. Update mocks to target the modular entry points.

- [ ] **Step 5: Build and enforce payload boundaries**

Run both frontend production builds, then run the bundle contract tests. Assert the initial index and Analysis workspace shell do not contain ECharts, and record raw and gzip sizes for the generated index, Analysis page, and chart chunks.

- [ ] **Step 6: Commit in each repository**

```bash
git commit -m "perf: defer analysis chart engine until selection"
```

### Task 3: Analysis labels and cloud asset caching

**Files:**
- Modify: `web/react-gui/public/locales/en/common.json`
- Modify: `osi-server/frontend/public/locales/en/common.json`
- Create: `osi-server/backend/src/main/java/org/osi/server/config/StaticAssetCacheConfig.java`
- Create: `osi-server/backend/src/test/java/org/osi/server/config/StaticAssetCacheConfigTest.java`

**Interfaces:**
- Consumes: Vite fingerprinted requests under `/assets/**`.
- Produces: `Cache-Control: public, max-age=31536000, immutable` for fingerprinted assets only.

- [ ] **Step 1: Add failing copy and cache-policy tests**

Assert the English translation values are `Stack` and `Overlay`. With MockMvc, assert a representative `/assets/index-abc123.js` response receives immutable caching while `/index.html` and `/api/...` do not.

- [ ] **Step 2: Run focused tests and confirm old behavior**

Expected: copy assertions report `Stacked`/`Overlaid`, and Spring Security supplies `no-cache, no-store` for the asset.

- [ ] **Step 3: Implement the narrow policy**

Change only the English display strings. Add a Spring MVC resource policy scoped to `/assets/**`; do not alter authentication, SPA forwarding, API headers, or Terra assets.

- [ ] **Step 4: Run focused and full relevant tests**

Run both frontend label tests and the cloud cache-policy test. Re-run frontend production builds and the focused analysis backend tests.

- [ ] **Step 5: Commit in each repository**

```bash
git commit -m "fix: clarify analysis layout actions"
git commit -m "perf: cache fingerprinted frontend assets"
```

### Task 4: AgroLink deployment and main-line integration branches

**Files:**
- No new source files; cherry-pick the reviewed commits onto isolated branches based on the deployment and main refs.

**Interfaces:**
- Consumes: edge and cloud commits from Tasks 1-3 plus cloud Sentek catalog commit `082f05e3` where absent.
- Produces: clean, verified branches for AgroLink deployment review and general main-line review.

- [ ] **Step 1: Create clean integration worktrees**

Create new branches from the current `origin/main`, edge AgroLink deployment ref, and `deploy/agrolink-websocket-production`. Do not modify any existing dirty worktree.

- [ ] **Step 2: Apply only applicable commits**

Cherry-pick the general source-capability, lazy-chart, copy, and cache commits. Add `082f05e3` to the cloud deployment line because that line does not contain the measured Sentek catalog support already present on `AgroLink`.

- [ ] **Step 3: Resolve branch differences with tests, not broad merges**

If main lacks `DRAGINO_SDI12`, keep the generic capability invariant without importing unrelated AgroLink device work. If a cherry-pick conflicts, edit the smallest owning module and repeat its focused failing/passing test cycle.

- [ ] **Step 4: Verify each integration branch**

Run edge history-helper/profile/frontend gates and cloud analysis backend/frontend/cache gates in the branch where the code will ship. Confirm every worktree is clean after commits.

### Task 5: Final verification and handoff

**Files:**
- Review all changed files and generated build manifests; do not commit generated frontend build output unless already tracked.

**Interfaces:**
- Consumes: all implementation and integration commits.
- Produces: evidence-backed commit SHAs, bundle-size comparison, deployment order, and explicit remaining limitations.

- [ ] **Step 1: Run repository gates**

Edge:

```bash
node scripts/test-history-helper.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit && npm run build
```

Cloud:

```bash
./gradlew test --tests org.osi.server.analysis.AnalysisCatalogServiceTest --tests org.osi.server.history.HistoryCardServiceTest --tests org.osi.server.config.StaticAssetCacheConfigTest -x buildFrontend -x buildTerraIntelligenceFrontend
cd frontend && npm run test:unit && npm run build
```

- [ ] **Step 2: Inspect diffs and artifacts**

Check `git diff --check`, profile byte equality, source maps/import graphs, and asset sizes. Confirm no unrelated dirty-tree files entered a commit.

- [ ] **Step 3: Report deployment-ready results**

Provide the AgroLink edge/cloud branch names and commit order, the main-line branch names, verified tests, before/after payload sizes, and the inability to collect authenticated API timings or SSH diagnostics because browser control was unavailable and the gateway host key was not trusted.
