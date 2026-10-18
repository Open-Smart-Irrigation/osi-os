# Mobile history zoom prototypes

This package compares ECharts, uPlot, and Chart.js against the same synthetic soil-water history. The browser suite drives the production preview with native Chrome DevTools touch events and reads each adapter's requested and rendered viewport through the page probe.

```bash
npm ci
npm run dev
npm test
npm run build
npm run preview
npm run test:browser
```

For a LAN check, use the host address printed by Vite and open `http://HOST:5173/#/echarts`, `http://HOST:5173/#/uplot`, or `http://HOST:5173/#/chartjs`. The uPlot route is the feel reference for comparison. Browser tests use the production preview on `127.0.0.1:4178`; set `HISTORY_ZOOM_BASE_URL` to a deployed HTTPS subpath to run the same tests against it.

The browser suite writes frame and gesture evidence under `test-results/diagnostics/`. The frame files are Chromium touch-emulation diagnostics at 448×998 CSS pixels and DPR 3. They do not measure physical Pixel 8 Pro performance. The user's phone comparison ranked uPlot first, ECharts second, and Chart.js last. Production deployment is outside this pilot's scope.

## Phone comparison

Open the test-server preview on your phone:

- [uPlot](https://server.opensmartirrigation.org/prototypes/history-zoom/#/uplot)
- [ECharts](https://server.opensmartirrigation.org/prototypes/history-zoom/#/echarts)
- [Chart.js](https://server.opensmartirrigation.org/prototypes/history-zoom/#/chartjs)

Pinch to zoom, drag with one finger to pan, and tap to pin a reading. Scroll outside the plot to move the page. Candidate buttons preserve the selected dataset and time window. Choose a fixture and press **Load fixture** to apply it; **Reset view** returns to the last 24 hours.

All candidates use the same D3 gesture controller. The data is synthetic: Nominal has 10,175 points, and Stress has 129,600 points across three series. The interaction surface intentionally accepts touch rather than desktop mouse gestures. This standalone comparison does not replace edge or cloud Data History.

The native Chart.js zoom-plugin experiment failed the agreed gesture checks; the final Chart.js candidate uses D3. See the [verification record](../../docs/operations/mobile-history-zoom-prototypes-2026-10-07.md) for measurements and the deployment record.


## Real-history pilot

The selected uPlot renderer also has two opt-in routes:

- [Cloud pilot](https://server.opensmartirrigation.org/prototypes/history-zoom/#/pilot/cloud) (`#/pilot/cloud`) reads `/api/v1/irrigation-zones` and `/api/v1/history/zones/...`.
- `#/pilot/edge` reads `/api/irrigation-zones` and `/api/history/zones/...`.

Serve the bundle on the same origin as its API. Sign in to that host in the same browser (`/login` for cloud, `/gui/#/login` for edge), then return to the pilot URL. The pilot reads the existing session for authenticated GET requests. It does not create accounts or change sensor data, settings, or saved history views.

Choose a zone and a numeric history card, then a unit and the series to display. Pinch and pan the chart; the pilot starts loading nearby history during movement and requests the settled interval after a 150 ms pause. Previously loaded windows can appear from the session cache. The chart remains interactive during loading, with a quiet update message that does not move the plot. The pilot starts at the latest 24 hours. Each view spans at most 90 days; pan or use Back to visit older intervals. Range buttons, Forward and Latest also move the viewport. Navigation has a finite technical lower bound of 1 January 1970, without requesting that entire period.

The session cache holds up to eight whole responses and 20,000 normalized samples. Historical responses expire after five minutes; responses at the latest boundary expire after 15 seconds. Latest and Retry bypass cached results while sharing matching work already in flight. One foreground request and one neighboring prefetch may run together. Network requests still use `no-store`, and session changes clear reusable history. Responses are never merged across intervals.

The page labels the returned aggregation and warns when the server limits a result. Missing readings remain gaps; areas beyond the loaded interval are marked separately. Empty results keep the timeline interactive, so pinch or drag can recover without a button. Existing unit and sensor selections survive an empty interval, but old samples are not plotted there. Only one unit is plotted at a time. Irrigation events, gateway health and calendar views remain in the existing host application.

Results cover the selected host, card, channels, interval, and resolution. The Pi and cloud can retain different history; a date may have daily aggregates but no raw readings. This pilot does not backfill cloud data or silently substitute a different resolution.

For an edge installation, place `dist/` in a new subdirectory of its existing static GUI directory, for example `/usr/lib/node-red/gui/prototypes/history-zoom/`. Open `/gui/prototypes/history-zoom/#/pilot/edge` on that gateway. Preserve the existing GUI bundle. This repository change does not deploy files to a live gateway.

Run the focused pilot browser tests with:

```bash
npx playwright test tests/browser/pilot-history.spec.ts tests/browser/pilot-empty-recovery.spec.ts
```

The browser suite intercepts edge/cloud API requests with contract fixtures. Those tests exercise loading races and native touch input; they do not establish that a live account's sensor history is available. Run the complete suite against an installed static bundle with:

```bash
HISTORY_ZOOM_BASE_URL=https://server.opensmartirrigation.org/prototypes/history-zoom/ npm run test:browser
```

See the [pilot execution record](../../docs/operations/uplot-real-history-pilot-2026-10-07.md) for the deployment status and separate authenticated live-data result.

The [loading optimization record](../../docs/operations/uplot-loading-optimization-2026-10-07.md) contains the controlled request measurements. The [coverage and recovery record](../../docs/operations/uplot-history-coverage-recovery-2026-10-07.md) documents the field gateway observations and subsequent verification.
