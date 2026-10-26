# Mobile history final corrections review

## Verdict

Static review passes the edge correction patch against `docs/superpowers/plans/2026-10-25-mobile-history-final-review-corrections.md`. I found no open source or test defect in the reviewed StrictMode, prefetch, rollback-formatting or Markdown-table changes.

This verdict does not declare either PR merge-ready. Edge host suites, the production browser matrix, the dense benchmark, the canonical commit, cloud vendor resync and the cloud gates remain separate completion evidence.

## Reviewed behavior

`MobileTensionHistory` now clears its retained loader during effect cleanup. `clear()` aborts slots and removes cache state while allowing React StrictMode's setup-cleanup-setup replay to reuse the instance. The loader's terminal `destroy()` API and post-destroy behavior are unchanged. The component regression uses real `React.StrictMode` and proves both a transport call and finite data passed to the chart adapter.

`useHistoryWindow` now gives a prefetch demand the exact neighbor request bounds. Request construction, read policy, ordered selected IDs, selection revision, foreground admission and cache limits are unchanged. Public-hook tests cover two button moves and two gesture-source moves, verify one transport per target neighbor, and allow only the next legitimate prefetch. Loader tests prove short coverage, a wrong policy and a missing selected series cannot enter the cache and cannot satisfy a later foreground demand.

The uPlot axis formats all splits as one batch. It identifies a rollback only when two instants share the same local year, month, day, hour and minute but have different short offsets. Ordinary Kampala labels, equal clock times on different dates and ranges wider than 48 hours keep their prior text. The batch creates its three `Intl.DateTimeFormat` instances once and remains private to the adapter.

Rollback labels use a second line. The x-axis band expands from 36 px to 52 px only when those labels are present. The right padding callback returns 12 px during initialization and ordinary layouts, and 28 px for a fold layout. Its reservation remains sticky within later convergence cycles, then resets on cycle 1 of a subsequent ordinary layout. Unit tests cover initialization, fold sizing, the fold-to-ordinary convergence case, ordinary reset and unchanged wider-range labels.

The containing-bucket inspector uses a separate exact-instant formatter with `shortOffset` for its target and bucket endpoints. The mobile label override calls the same formatter, so it cannot bypass disambiguation. The visible-window summary, transport coverage, latest-bucket summary, mobile date header and legacy nearest-point formatting retain their existing paths. The edge browser oracle changed only to expect the new inspector endpoint format.

The two documentation edits repair malformed table cells without changing the catalog or DTO contracts.

## Evidence available at review time

Root independently reverted the two StrictMode/prefetch production lines in a scratch copy. Three regressions failed as expected: StrictMode never called the loader, and the button and gesture neighbor cases each observed one request where two were required. Restoring the two lines passed 135 core tests and TypeScript compilation. Evidence: `/tmp/mobile-history-review-independent-red.log` and `/tmp/mobile-history-review-independent-core-green.log`.

The final combined core passed 140 tests across 13 files and its build. Test inventory scanned 832 files, and `git diff --check` passed. Evidence: `/tmp/mobile-history-final-corrections-core-root.log`.

Root's real Chromium/uPlot check passed at 320, 390 and 448 CSS pixels with DPR 3. Every rollback label stayed within the canvas. A fold-to-ordinary-to-fold transition produced 28/52 px, 12/36 px and 28/52 px right/bottom geometry respectively; the Kampala rectangle and wider date-only labels remained unchanged. Evidence: `/tmp/mobile-history-dst-visual.json`, `/tmp/mobile-history-dst-visual.log` and `/tmp/mobile-history-dst-axis-{320,390,448}.png`.

## Remaining gates

Before committing the edge correction, complete the edge GUI unit/type/build checks, production browser matrix, unchanged dense benchmark and hygiene checks. Push the canonical commit and require its GitHub checks to pass before marking edge ready. Resync cloud mechanically from that clean edge commit. Cloud must pass source and manifest parity, the Node 20/npm 10 clean-export gates, its production browser matrix and hosted checks. The known GitHub billing block still prevents a merge-ready cloud PR until those hosted jobs can start and pass.

## Post-review local verification

Luna completed edge typecheck, 339 Node/TSX tests, 3,011 Vitest tests and the production build. The final production browser matrix passed 21 cases with zero failures/flaky retries; root read the JSON results at `/tmp/osi-mobile-history-edge-final-r10/results.json`.

Root independently passed the unchanged six-case dense benchmark after other task browser/build workloads stopped. Each case used two requests and 642,830 bytes; maximum gesture p95 was 16.8 ms against the unchanged 33.4 ms limit, with zero renderer mismatch. The fixture hash stayed unchanged. Evidence: `/tmp/mobile-history-final-corrections-dense.log`. Private-term/documentation hygiene and the silent-catch gate also passed. The canonical commit, mechanical cloud resync and final-head hosted checks remain the next steps.
