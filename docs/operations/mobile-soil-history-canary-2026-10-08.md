# Mobile soil history canaries, 8 October 2026

The uPlot soil-history integration is deployed as a separate preview in both real applications. Static deployment, login routing, and browser checks against the deployed files passed. Authenticated verification against real sensor data remains pending an operator-provided test login or saved session. These previews are not promoted to either main frontend.

| Preview | URL |
| --- | --- |
| Test cloud | https://server.opensmartirrigation.org/prototypes/mobile-soil/ |
| Field gateway, private network access | http://<gateway-address>:1880/gui/previews/mobile-soil/ |

Sign in through the preview, open Data History, and select a soil card on a phone. The new chart is the mobile soil line-chart view. Desktop, other card types, and an explicitly selected soil-profile view retain their existing components. Ordinary builds keep the new path disabled.

## Source and review

Sol wrote the plan and independently reviewed the implementation; root reviewed the plan, coordinated verification, and deployed; Luna workers implemented the changes and review corrections.

| Repository | Commit | Change |
| --- | --- | --- |
| osi-os | `098f8b1c5` | Canonical `web/history-uplot-core` package and prototype compatibility adapters |
| osi-os | `e47f4e56a` | Edge integration, translations, host browser tests |
| osi-server | `86c69332` | Cloud integration and byte-identical vendor package |
| osi-server | `d6924f31` | Base-aware favicon asset |

The canonical package owns the uPlot adapter, gestures, viewport, bounded response cache, new history hook, and mobile surface. The comparison prototype retains its own page and wrapper hook, delegating common rendering, loading, range, and gesture logic to the package. This keeps the ECharts and Chart.js comparison routes working while real hosts use the new shared surface.

The host owns authentication, source/card selection, API requests, and translations. Edge forwards an advertised source key; cloud identifies the source through its card ID. Session, scope, card, and source changes abort old work and discard old data. Nulls remain gaps; zero remains a measurement.

Each viewport/request spans at most 90 days, but navigation can move farther back. Empty responses retain the chart and its gestures. The API does not report the earliest available sample, so the UI labels the loaded interval without claiming it is the full retained history. Backend retention, aggregation policy, and sync behavior are unchanged.

## Verification

All commands below exited zero. Unit runs used at most two workers to limit memory use.

| Check | Result |
| --- | --- |
| Canonical package `npm test`; `npm run build` | 53 tests; TypeScript passed |
| Prototype `npm test -- --maxWorkers=2` | 187 tests |
| Prototype `npm run test:browser` | 60 browser tests, including its build |
| Edge `npm run test:unit:tsx-runner` | 228 tests |
| Edge `npm run test:unit:vitest -- --maxWorkers=2` | 2,606 tests in 242 files |
| Cloud `npm run test:unit -- --maxWorkers=2` | 169 Node tests; 2,482 Vitest tests, 2 skipped |
| Edge typecheck; ordinary and preview builds | Passed after clean `npm ci` |
| Cloud ordinary and preview builds | Passed after clean `npm ci` |
| Actual-host browser suite on local preview builds | 18 tests |
| Ordinary build browser smoke checks | Edge/cloud at 390 px and 1,024 px: legacy UI, no new uPlot surface |
| Actual-host browser suite on deployed previews | 9 edge and 9 cloud tests |
| Unmocked preview login routing | Both login forms rendered; no page errors or failed JS/CSS/locale assets |
| Canonical/vendor verifier and its deliberate mismatch fixture | Passed |

The host browser cases use controlled API fixtures and native Chromium touch events. They cover pan/pinch, initial and subsequent empty intervals, delayed loading without chart movement, unit selection, inspection, Latest, all-hidden series, navigation beyond 90 days with bounded requests, desktop fallback, touch-target size, and date-label placement. Tests run at 390 px and 448 px; this is phone emulation, not a physical Pixel 8 Pro result.

Screenshot inspection found cramped controls and overlapping legacy date labels before release. The final screenshots show spaced 44 px controls and a visible date readout below the chart. Both final fixture sessions had no page or console errors. Cloud still uses the existing page header and card navigation; reducing that surrounding vertical space is a later UX task.

Re-run the deployed fixture suite from `web/history-zoom-prototypes`:

```bash
EDGE_HISTORY_BASE_URL=http://<gateway-address>:1880 \
CLOUD_HISTORY_BASE_URL=https://server.opensmartirrigation.org \
  npx playwright test -c playwright.hosts.config.ts --workers=1 --timeout=90000
```

Build previews with `VITE_HISTORY_UPLOT_SOIL_ENABLED=true` and the corresponding `VITE_BASE_PATH`: `/gui/previews/mobile-soil/` on edge; `/prototypes/mobile-soil/` on cloud. Both hosts use `install-links=true` and locked local-package dependencies; clean installs do not depend on the prototype's installed packages.

## Live deployment evidence

Field-gateway payload `20261007T230959Z-mobile-soil` cloned the active pair and added only the preview directory. The prior pair is `20261007T221220Z-history-cursor-34ab3c6bb`. All main GUI files and flows remained byte-identical; schema compatibility remained valid. Node-RED stayed at PID `18241`, process start tick `10147591`. All 90 preview files matched their local hashes when served over HTTP. No service restart or database write was part of deployment.

The operation record is `/data/osi-ops/20261007T230959Z-mobile-soil/`. Its `result.json` reports `healthy` at `2026-10-07T23:10:14.251Z`. Both payloads are retained. A rollback must first confirm the current pair is this canary and the old pair still matches the live schema, then use the paired-payload helper to restore the old pair; do not replace individual files or restart Node-RED for this static rollback.

Cloud release `/data/prototypes/mobile-soil/releases/20261007T231228Z` serves 108 verified files. Direct nested routes return the preview index. The main page, health endpoint, prior comparison preview, and neighboring unmatched URL retained their baseline HTTP status/body hashes. The backend image remained `ghcr.io/open-smart-irrigation/osi-server-backend:main-a613a083-terra-23e6757f-test`.

The cloud deployment preserved the Caddyfile inode, validated the candidate, and reloaded Caddy. The guarded rollback command is:

```bash
ssh <test-host> bash /home/rocky/caddy/deploy-staging/mobile-soil-20261007T231228Z/rollback.sh
```

That rollback refuses if the configuration has changed since this deployment. No production cloud host was accessed.

Local evidence, including manifests, deployment scripts, review records, and rollback details, is under `.superpowers/sdd/2026-10-08-mobile-soil-history-integration/`. Test logs are `/tmp/mobile-soil-*.log`; the successful cloud full-suite log is `/tmp/mobile-soil-cloud-green-unit.log`.

## Remaining release gate

Use an authenticated test session to check the actual field soil card on both previews: source selection, returned aggregation and coverage, older retained data, background loading, and empty-range recovery. Run the same gestures on the user's Pixel 8 Pro. Fixture responses and successful login-page routing do not establish these real-data results. Keep the main applications unchanged until those checks pass.
