# Mobile history legend, 18 October 2026

The shared edge/cloud uPlot view now keeps four or more selected series behind an expandable legend. One to three remain inline. Selecting a legend row highlights its trace without changing inclusion, loading data, resetting the viewport, or clearing a pinned reading. Show all clears emphasis. Sensors controls inclusion and stays open while changing several checkboxes.

Colour, dash, and marker styles remain stable when channels are hidden, reordered, or refreshed. Full focused names wrap beside their swatch. Both the legend list and pinned readings scroll within bounded areas. All-hidden and empty-interval recovery remain available.

This change does not migrate the complete five-view design into the applications. The connected HTML preview exercises the proposed layout with illustrative data. It does not establish live data accuracy or gesture performance. Irrigation settings and historical sensor-spike repairs remain separate work.

## Verification

Sol planned and independently reviewed the implementation; root revised the plan, reviewed screenshots, and verified integration; Luna workers implemented the code and corrections. Final code review was green.

| Check | Result |
| --- | --- |
| Canonical shared package and cloud vendor | 67 tests each; TypeScript passed |
| Canonical/vendor and installed host source parity | Exact match |
| Comparison prototype | 188 tests; build passed |
| Edge frontend | 228 Node tests; 2,606 Vitest tests; TypeScript and preview build passed |
| Cloud frontend | 169 Node tests; 2,482 Vitest tests, 2 skipped; TypeScript and preview build passed |
| Built edge/cloud browser suite | 22 Playwright tests passed |
| Connected HTML preview | 320/390/448 px and doubled text passed |

The browser cases use controlled API data and native Chromium touch events. They cover eight/twelve channels, long names, legend focus and clearing without a fetch, retained canvas/viewport/inspection, stable swatches, repeated selection, all-hidden recovery, empty intervals, pan/pinch, bounded requests, and desktop fallback. These are emulated phone results, not physical Pixel 8 Pro results.

The existing session-boundary tests now locate sensor checkboxes by role because names also appear in the legend. The empty-recovery browser assertion compares document coordinates so scrolling to a preset button is not mistaken for a change in chart geometry. Cloud Luganda uses its mandated English fallback for the new labels and five previously divergent mobile-history labels. Edge `lg` is human Luganda: the `mobileUplot.*` strings first written here by implementation agents now ship English, pending a human pass (`docs/i18n/pending-luganda-translations.md`).

## Test-cloud deployment

Preview: https://server.opensmartirrigation.org/prototypes/mobile-soil/

Release: `/data/prototypes/mobile-soil/releases/20261018T203900Z` in the Caddy container. All 108 served files match local artifact hashes. Nested history routes serve the preview index. Main-page, health, comparison-preview, and neighboring-route baseline responses remained unchanged. The backend image remains `ghcr.io/open-smart-irrigation/osi-server-backend:main-e0a018ae`.

The deployment replaced only the existing canary root, requiring the reviewed previous release `20261007T231228Z`. Activation and rollback guard the complete Caddyfile hash and preserve its inode. The previous release remains available. Guarded rollback:

```bash
ssh <test-host> bash /home/rocky/caddy/deploy-staging/mobile-soil-20261018T203900Z/rollback.sh
```

All 11 Playwright cases passed against the deployed files using controlled API responses. Unmocked navigation reached the real login form with no page errors or failed JS/CSS/locale assets. An authenticated field-data session and physical Pixel 8 Pro gestures were not verified in this slice. No Pi deployment or access to a production cloud host was performed.

Local evidence and deployment scripts are under `.superpowers/sdd/2026-10-18-mobile-history-legend/`. Test logs are `/tmp/legend-*.log`. The shared implementation plan is `docs/superpowers/plans/2026-10-18-mobile-history-legend.md`.
