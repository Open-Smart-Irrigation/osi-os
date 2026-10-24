# Mobile history Slice 1 external review consolidation

The external review identified implementation blockers in plan commit `3b85b784f`. The prior readiness verdict is withdrawn. Root checked findings 1–7 against the named code snapshots; Sol checked the browser, package and locale findings. This record distinguishes verified defects from proposed fixes that needed adjustment.

Evidence refs: edge `55ec323f90d12864eab50cfeda74cb3bf8910834`, cloud `f214163f29153c35821fe8f554b28ca7359760c2`. These are local Git snapshots, not deployed-state evidence. The prototype branch supplies the approved UI and measured benchmark. No production host was accessed.

## Required corrections

| Finding | Verified evidence | Disposition and planned correction |
| --- | --- | --- |
| 1. Edge bucket anchors move | Edge `osi-history-helper/index.js`, `aggregationBuckets`, starts hourly buckets at `startMs` and clips the last one. `analysis.js` passes request bounds through. | Accept. Align edge transport bounds outward to UTC hours. Keep logical viewport bounds separate. Prove overlapping requests over unchanged rows produce the same shared-hour anchors and means. Edge Analysis does not return a bucket duration field: validate applied hourly aggregation and aligned bounds before deriving intervals; validate cloud's supplied grid. |
| 2. Padding changes cloud data path | Cloud `AnalysisSeriesService.isShortRange` checks original request duration. `AnalysisGrid` chooses grain from the label. Existing core hourly buffering permits longer requests. | Accept. No padding at spans up to 24 hours. Cloud receives exact logical bounds; edge alone receives aligned bounds. Labels are `24h` at up to 24 hours and `7d` above. Keep aligned transport width distinct from the seven-day viewport cap. |
| 3. Source changes blank the chart | Core `useHistoryWindow` keys accepted data by full context and calls `resetAccepted` on identity changes. The plan put selected IDs in that context. | Accept. Separate authorization scope, viewport, selected sources and request revisions. Removing from a loaded selection is a local filter with no network request. Addition retains compatible series during loading. Preserve stale-response rejection and bounded caches. |
| 4. Recovery can loop forever | Cloud catalog TTL is 60 seconds; series access is checked again. Edge raw-row overflow returns 413. The hook recognizes `HistoryAuthError`, not an arbitrary axios error. | Accept. Classify auth, source unavailability, size limits, protocol faults and transient network failures. Refresh the catalog once after missing/dropped IDs, but offer removal even if that refresh is stale. Evict access-denied series immediately. Size errors offer fewer sources or a shorter window, not identical Retry. |
| 5. Invalid constituents survive averaging | Edge `statsForValues` averages finite values. Cloud `JdbcHistoryRawQueryRepository.findHourlyReadingsForAnalysis` uses `AVG(value)` over numeric rows without the frontend SWT-domain predicate. | Accept with a bounded scope. Validate and count invalid hourly averages only. A mixed `30`/`1,000,001` fixture produces an apparently valid `500,015.5` mean and documents the limitation. Do not claim raw-reading validation or add a backend repair to this UI slice. Add locale number formatting to the inspector. |
| 6. Inspector uses point tolerance | Core `shared/inspection.ts` uses `min(6 hours, max(5 minutes, viewportSpan/80))` around the nearest point. | Accept. Add an opt-in bucket inspector that selects `[bucketFrom,bucketTo)`, preserves null gaps and labels the interval as an average. Test 1-hour, 24-hour and 7-day views, including exact boundaries. Keep legacy observation inspection unchanged. |
| 7. Empty means zero series | `useHistoryWindow` uses `series.length`; both Analysis paths can return selected series containing only null buckets. | Accept. No selection makes no request and shows Choose sources. Loaded visible intervals with no finite selected bucket values show the empty recovery state. Pending coverage is not empty. Use bucket overlap, including an anchor just before the visible start. |
| 8. Browser harness and baseline are not reproducible | Edge `demo/serve.mjs` has `connect-src 'none'`; its Vite entry and i18n differ from the real app. Cloud lacks Playwright. The measured baseline runner was ignored. | Accept. Track the existing baseline runner. Define separate real-app configs and build-matrix runners, edge `/gui/` serving, cloud SPA fallback and explicit auth/session/API stubs. Do not substitute a component test for cloud browser acceptance. |
| 9. Duplicate React risk | Cloud Vite/Vitest lacks dedupe; installing the vendored package's dev dependencies creates a second local React resolution path. | Accept. Dedupe React and React DOM in cloud Vite/Vitest and verify hook rendering after installing vendor dependencies. A clean CI install alone does not cover this condition. |
| 10. Shared contracts and provenance are missing | Task 3 consumes types not produced by Task 1; shared UI cannot import platform policy. Analysis response time is not a data watermark. | Accept. Define types, selection/reconciliation, validation and failure classification in the canonical package first. Platform adapters normalize and call their APIs. Show latest returned non-null bucket as that fact only; do not call `generatedAt` freshness. Reuse existing session serialization. |
| 11. Locale rules differ from the plan | Cloud locale parity requires new `lg` values to match English, and translated prose elsewhere. Edge's pending-Luganda policy also explicitly permits English for new untranslated keys. | Accept, with corrected remedy. Reuse existing reviewed translations. New de-CH/es/fr/it/pt text must be translated and reviewed. New Luganda keys use exact English until a human pass; edge tracks these in its pending document and focused tests. Preserve existing human Luganda. A new human translation is not a prerequisite for this internal slice. |
| 12. Responsive matrix was dropped | The roadmap requires 320/390/448 and 200% text; the detailed plan named only 448. | Accept. Restore all six width/text combinations on both real-app builds. Cover header, Time/source sheets, cap notice, Details, clipping, page overflow and 44-pixel targets. |

## Additional root finding: cache compatibility

The cloud read path must be part of cache compatibility. `historyLoader.findCache` checks aggregation and coverage, but does not compare range labels. Once both 24-hour and seven-day requests are hourly, a cached seven-day rollup can satisfy the 24-hour request without making the raw-hourly request.

Add a transport-policy discriminator to cache lookup, in-flight joins and completed-response reuse. Do not change viewport identity when that policy changes. A regression test must load seven-day rollups, zoom to 24 hours, and observe the raw-hourly request despite existing coverage. Old data may remain visible with a loading state; it cannot be accepted as the new path's completed result.

## Other corrections included

- Cloud's retry can omit selected series without adding them to `dropped`; correct the specification and retain complete ID-set validation.
- Enforce vendor self-consistency from its committed manifest in cloud CI, with source-to-vendor comparison as the stronger paired-repository check. A self-check is not proof that the manifest came from the approved source commit.
- Say at most one foreground and one prefetch. Read lane ownership from loader diagnostics; network traffic proves only observed concurrency.
- Use direct Vitest commands for focused edge files. Appending filenames to the package script also runs its fixed directory list.
- Reuse cloud `serializeSessionIdentity`; do not introduce a duplicate helper.
- Include discovery latency in end-to-end evidence and report a separate CPU-throttled run. Keep it distinct from the unthrottled baseline.

## Independent review corrections

The follow-up Sol review required explicit startup fixtures for edge `/api/me` and `/api/system/stats`, and cloud `/api/v1/users/me/linked-gateways`, plus a failure on unhandled API requests. It also required common-grid validation for every bucket anchor, an explicit per-series cache eviction operation, and a rule that an incomplete response never replaces previously accepted data with its partial subset. These are now in the detailed plan.

Root corrected selection revisions to advance immediately, with only the addition request debounced. HTTP 413 needs no body error code on edge. Swiss German number formatting uses a decimal point; the comma example is tested with French. Hourly browser fixtures derive their count from aligned transport bounds: minute-offset 24-hour and seven-day requests contain 25 and 169 buckets.

## Release limits retained

Hourly averages are not raw observations. Raw/15-minute detail, retained-history discovery, long-range timezone parity and upstream reading validity remain release requirements. A mixed-invalid bucket cannot be repaired by frontend filtering after averaging.

A valid zone timezone does not establish that the farmer chose it: both databases can default to UTC. Display the stored timezone honestly and verify configuration before rollout. Do not infer the farm timezone from the phone.

Neither intercepted browser tests nor AbortSignal prove Pi database performance, live cloud rollup freshness or cancellation of backend work. Report those as unmeasured until tested on representative systems. Physical Pixel 8 Pro testing remains separate from desktop touch emulation.

The plan adopts lazy loading and verifies that the default-off bundle excludes the internal route. Default ordering by device/depth and WebKit coverage remain optional later improvements. They do not replace the listed correctness fixes or silently change the approved source-default policy.

## Verification scope

This revision verifies the plan against code and makes the benchmark reproducible. Commit `2b57875e5` tracks the runner and command; root’s fresh-build reproduction passed all six cases, with the measurements recorded in [the baseline](../../operations/mobile-history-loading-baseline-2026-10-24.md). It does not implement the new history route or modify either backend. A fresh independent Sol review passed the amended plan on 2026-10-24 after checking all twelve findings, the read-policy cache discriminator and the follow-up corrections against the audited refs. Root reviewed and incorporated those corrections. This is plan approval only; implementation and live-system verification remain outstanding.
