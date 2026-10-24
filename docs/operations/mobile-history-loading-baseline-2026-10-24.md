# Mobile history loading baseline, 24 October 2026

The existing pilot kept its viewport responsive while synthetic history responses were delayed. This baseline measures the browser and loader under a repeatable response-delay model. It does not measure an edge database, cloud backend, mobile radio or physical Pixel 8 Pro.

## Method

Code baseline: `5b62f8706`, built preview served at `http://127.0.0.1:4180/`. Playwright Chromium used a 448 × 998 CSS-pixel viewport, DPR 3 and touch emulation, without CPU throttling. The existing `#/pilot/edge` and `#/pilot/cloud` routes used synthetic authentication and intercepted local API responses; no live account or backend was accessed.

Each data response contained eight kPa series with 672 points each. Samples were evenly spaced across the requested interval, with value `20 + seriesIndex + sin(pointIndex / 10)`. The response contained 5,376 points and occupied 321,415 UTF-8 JSON bytes. The interceptor delayed fulfillment by `600 ms + responseBytes / 125,000 bytes-per-second`, about 3,171 ms. This simulates a 600 ms response delay plus a 1 Mbps payload transfer; it does not reproduce TCP, compression or contention between transfers. Zone and card discovery had no added delay.

Each fresh browser run opened the 24-hour view, waited for Ready, then performed a 20-step pinch from 70 to 140 pixels and a 20-step horizontal pan from 30% to 70% of the plot width, with 16 ms pauses. Frame sampling covered those gestures. A further five-second observation window counted replacement/prefetch requests. Three runs used each API prefix.

## Results

| Route | First Ready, three runs (ms) | Median (ms) | Highest run frame p95 (ms) | Worst frame (ms) |
| --- | --- | --- | --- | --- |
| edge API prefix | 3433, 3399, 3398 | 3399 | 16.7 | 16.8 |
| cloud API prefix | 3452, 3442, 3447 | 3447 | 16.8 | 66.7 |

All six runs completed. Each generated two data requests and 642,830 total JSON payload bytes, with at most one simulated response handler active at a time. Requested and rendered viewport bounds matched exactly after the gestures. The cloud-prefix runs included isolated 50–66.7 ms frames; both prefixes ran the same synthetic workload, so this does not establish a backend performance difference.

The initial delay dominates this workload. Retain the existing one-foreground/one-prefetch scheduling limit and 8-entry/20,000-point cache ceiling while integrating the new API. Those are existing implementation bounds, not limits derived from six observations. A response contributes 5,376 points in this benchmark, so the point ceiling becomes relevant before eight such responses can be retained.

The tracked benchmark below now reproduces this recipe and asserts request, gesture and renderer bounds. The new-route acceptance must additionally assert loader memory and lane diagnostics. Compare new and baseline implementations under the same environment, including rapid reversals, cancellation, repeated cached windows and 25-source loads. Measure actual authenticated API latency and physical-device interaction separately before rollout. API completeness, aggregation resolution and freshness require contract tests; this benchmark cannot prove them.

## Tracked reproduction after external review

The tracked runner is `web/history-zoom-prototypes/tests/browser/loading-baseline.spec.ts`, using the existing `playwright.config.ts`. It asserts a roughly halved viewport span after pinch, visible viewport movement after pan, and exact renderer agreement after the delayed response settles. Diagnostics are written even when a gesture assertion fails.

Root reran it against a fresh local build of prototype HEAD `3b85b784f` plus the new runner and package script. The command built and served port 4178 itself; it did not reuse the earlier 4180 preview. Chromium was `153.0.8010.12`, with measured viewport 448 × 998 and DPR 3. Result: **6 passed (1.4m)**, including the build/typecheck.

| Route | First Ready, three runs (ms) | Median (ms) | Highest run frame p95 (ms) | Worst frame (ms) |
| --- | --- | --- | --- | --- |
| edge API prefix | 3471, 3452, 3447 | 3452 | 16.7 | 16.8 |
| cloud API prefix | 3433, 3436, 3440 | 3436 | 16.7 | 66.6 |

Every run fulfilled two requests, totaling 642,830 serialized JSON bytes, with one active response handler at most. There were no recorded aborts, request errors or page errors. All six renderer errors were zero. The isolated 66.6 ms frame remains visible in the evidence; the p95 does not describe the worst frame.

From `web/history-zoom-prototypes`, after installing project dependencies and Playwright Chromium:

```bash
npm run test:browser:loading-baseline
```

Each test writes `diagnostics.json` below ignored `test-results/slice1-baseline/`. The runner, fixture construction and package command are tracked; generated records are local evidence. A clean execution worktree must import the reviewed runner and package script before measuring its own baseline against the audited edge ref. Do not compare new product results only to the older prototype numbers above.

The earlier exploratory runner used `key` instead of the pilot contract's `id` for series identity, yielding an empty chart. Those discarded runs are excluded from both result tables.
