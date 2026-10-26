# Mobile history final review corrections

## Scope

Fix loader lifecycle and neighboring prefetch defects, disambiguate repeated-hour chart labels, and repair two Markdown table cells. Resync the edge-owned canonical history core into cloud afterward. Do not change APIs, backend code, cache limits, request concurrency, foreground response validation, selection fencing, route gates or browser acceptance thresholds.

Implement the loader fixes as separate RED/GREEN steps, then verify the repeated-hour labels through actual uPlot rendering. Commit the reviewed corrections together. Cloud receives a mechanical vendor resync, provenance update and the matching browser inspector date oracle after that edge commit exists.

## A. Keep the loader reusable through React StrictMode effect replay

### Root cause

`MobileTensionHistory` creates one loader in `loaderRef` during render and registers `useEffect(() => () => loader.destroy(), [loader])`. React 18 development StrictMode replays mounted effects as setup, cleanup, setup on the same retained component state. The first cleanup terminally destroys the loader, but the second setup retains the same ref. `useHistoryWindow` then sends foreground work to a destroyed loader, which rejects with `HistoryAbortError('destroyed')` and never calls the supplied transport.

The loader has no external resource beyond its request slots and bounded cache. `useHistoryWindow` already aborts timers and slots and clears the loader during cleanup. A replayable component cleanup must reset the retained loader, not terminally destroy it. Keep `HistoryLoader.destroy()` and its standalone post-destroy contract unchanged for true owners that need terminal disposal.

### RED regression

In `web/history-uplot-core/tests/mobileTensionHistory.test.tsx`, add a component-level regression that renders the real `MobileTensionHistory` under `React.StrictMode` with an eligible default source and the real hook lifecycle.

Use an isolated load spy and chart adapter. Assert both:

1. The load spy is eventually called after StrictMode's setup-cleanup-setup replay.
2. The adapter eventually receives a series containing a finite value, proving that the response is admitted and rendered rather than merely starting transport.

The test must fail against the current terminal cleanup. Do not test a helper or call lifecycle methods manually. Keep the existing non-StrictMode cases.

### Minimal fix

In `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx`, replace the component cleanup's `loader.destroy()` with `loader.clear()`. This aborts active foreground and prefetch slots and drops cache state on replay or unmount while leaving the retained instance usable for the second StrictMode setup.

Do not recreate the loader in an effect, weaken `destroy()`, or remove `HistoryAbortError('destroyed')` behavior. Do not change `useHistoryWindow` lifecycle, selection state or loader ownership.

## B. Validate and cache prefetch data for the requested neighbor

### Root cause

`useHistoryWindow.schedulePrefetch(visible)` computes a neighbor `request` but constructs `HistoryDemand` with `visible` still set to the foreground viewport. Two errors follow:

1. `loader.prefetch()` can find the current foreground cache entry and report the neighbor already cached because that entry covers `demand.visible`.
2. If the neighbor request reaches transport, `makeSlot()` applies `historyResponseSatisfiesDemand` to the foreground viewport. A valid hourly neighbor response commonly covers its requested interval without covering the entire foreground interval, so it is not admitted.

The loader validator is correct for foreground work. The prefetch producer supplies an incoherent demand.

### RED regressions

Add the public hook regression to `web/history-uplot-core/tests/useHistoryWindow.test.tsx` using fake timers, `document.hidden = false`, `analysisHourlyRangeStrategy`, one selected series and responses whose hourly coverage exactly equals each request.

Exercise this sequence:

1. Resolve the initial foreground window.
2. Advance the 500 ms idle timer and prove a distinct backward-neighbor request is sent. This catches the current false cache hit.
3. Call `moveWindow('back')` into that exact prefetched interval and prove no additional transport starts.
4. Advance the idle timer again and prove the next backward neighbor is prefetched.
5. Call `moveWindow('back')` a second time and prove that interval is also served without another transport.

Assert the neighbor request bounds, hourly aggregation, read policy and ordered selected-ID load context. Assert transport counts at every stage so three network calls cannot conceal two foreground reloads. Restore timers and the `document.hidden` descriptor in `finally`. Include two actual `viewportStore` gesture-source moves, advancing settle and idle timers separately; the button helper alone does not cover the reported panning path. Count transport per target interval, and assert the bounds of any legitimate next-neighbor prefetch on the second gesture rather than treating it as a duplicate foreground request.

Update the existing “passes ordered selection context to the foreground lane” test because a working prefetch now adds a second load. Rename it to describe both lanes and assert the same ordered ID snapshot for the foreground and neighbor calls; do not retain an expectation that prefetch performs no transport.

In `web/history-uplot-core/tests/historyLoader.test.ts`, add or extend a parameterized public-loader regression proving that a prefetch response with any of these defects is not cached:

- coverage shorter than its requested neighbor interval;
- a mismatched read policy;
- a missing selected series ID.

Set each prefetch demand's visible interval to the full request bounds. For short coverage, choose a response that would cover the old foreground interval but misses the neighbor end, such as coverage 0..99 for a request 0..100. After each response, require zero admitted entries or require an exact subsequent foreground demand to use `source: 'network'`. This protects the existing validator while changing the producer. Do not assert only the prefetch return label, which does not itself prove cache admission.

### Minimal fix

In `web/history-uplot-core/src/history/useHistoryWindow.ts`, construct the prefetch demand with:

```ts
visible: { from: request.from, to: request.to }
```

Keep `request`, `neighbor: request`, selected IDs, selection key, revision and read policy unchanged. Keep the load callback bound to `demand.request`.

Do not change `historyResponseSatisfiesDemand`, `findCache`, `makeSlot`, cache keys, cache capacity, TTLs, priority arbitration or foreground admission. A valid neighbor must satisfy its own request; invalid coverage, policy or selected-series membership must still be rejected.

## Canonical verification and edge PR

Run the two new regressions RED before product edits, then GREEN after each minimal fix. Run:

1. The focused `mobileTensionHistory`, `useHistoryWindow` and `historyLoader` test files.
2. The complete canonical core test suite and core build.
3. Edge GUI typecheck, aggregate unit tests and production build, including the App route test.
4. The tracked edge production browser matrix, with attention to gesture cancellation, neighboring prefetch, request caps, empty recovery and stale-response admission.
5. Run the unchanged six-case dense loading benchmark with other browser/build workloads paused. Keep its fixture, byte/request budgets and frame thresholds unchanged.
6. `git diff --check`, vendor/profile parity, test inventory and the normal edge PR checks.

Commit the canonical source and tests on edge as one clean correction commit. Push edge PR #518 and return it to draft while new required checks run. The literal build gate remains false by default.

## Cloud resync and verification

After the edge correction commit is final, run the existing history-uPlot sync script from a clean edge worktree. The cloud manifest must pin that new edge commit and contain the exact canonical file set and hashes. Do not hand-edit vendored source or the manifest.

Review the cloud diff as a mechanical resync. `frontend/package.json`, cloud application adapters, routes, backend code and workflows must remain unchanged. The npm 10 lock correction must remain semantically valid; regenerate the cloud root lock only if a clean Node 20/npm 10 install proves it necessary, and apply the same no-version-change review contract used for commit `4890d7a58`.

Then run:

1. Vendor verifier self-tests and both source and manifest modes.
2. Canonical vendored tests/build.
3. A fresh-export Node 20.20.2/npm 10.9.0 `npm ci`, `npm exec -- tsc --noEmit`, full frontend unit suite and production build.
4. The tracked cloud production browser matrix, focusing on the same gesture/prefetch cases.
5. `git diff --check` and all cloud required checks.

Push cloud PR #391 only after the edge correction is pushed. Keep it draft and merge second. If edge is merged with a squash or rebase instead of **Create a merge commit**, resync and repin cloud from the resulting edge `main` before cloud merges.

## C. Disambiguate the repeated local hour

### Root cause and boundary

`formatUplotTimeTick` emits only `HH:mm` for windows up to 48 hours. During the Europe/Zurich rollback on 2026-10-25, `2026-10-25T00:00:00Z` and `2026-10-25T01:00:00Z` are distinct instants but both render as `02:00`. The containing-bucket inspector has the same ambiguity because its target and interval endpoints omit the UTC offset; a bucket crossing the rollback can read `02:00 – 02:00`.

Keep ordinary axis labels compact. A repeated clock time on another calendar day is not a rollback pair, and a wider date-only axis must remain unchanged. The legacy nearest-point inspector, visible-window summary, transport coverage, latest-bucket summary and mobile date header also retain their current format.

### RED regressions

Add tests before changing the formatters:

1. In `web/history-uplot-core/tests/uplot.test.ts`, mount the adapter with locale `en-GB` and timezone `Europe/Zurich`, then invoke the captured x-axis `values` callback with the two UTC instants above in a narrow range. Assert that the rendered labels remain `02:00` clock labels but are distinct and carry `GMT+2` and `GMT+1`. This test must exercise the adapter callback, not only a newly exported helper.
2. In the same test, prove an ordinary `Africa/Kampala` narrow range produces the existing offset-free `HH:mm` labels. Prove a range wider than 48 hours still produces the existing date-only labels.
3. In `web/history-uplot-core/tests/chartHost.test.tsx`, render the containing-bucket mode without a custom `bucketInterval` label. Use a bucket whose endpoints are the two Zurich rollback instants. Click the plot and assert that the target is offset-qualified and that the fallback interval distinguishes both endpoints. Retain the existing nearest-point raw-value and default-date assertions unchanged.
4. In `web/history-uplot-core/tests/mobileTensionHistory.test.tsx`, render the real mobile wrapper with a fixed clock, `Europe/Zurich`, and a response containing the rollback bucket. Open the inspector through the chart host and assert that the localized `labels.bucketInterval` override receives or renders both offset-qualified endpoints. This closes the product path that bypasses the chart host's fallback formatter.

### Axis algorithm

Keep `formatUplotTimeTick(value, min, max, locale, timeZone)` as the single-value legacy formatter. Add a batch formatter used only by the uPlot x-axis `values` callback:

```ts
formatUplotTimeTicks(
  values: readonly number[],
  min: number,
  max: number,
  locale?: string,
  timeZone?: string,
): string[]
```

For a range wider than 48 hours, return the existing date-only result for every value. For a narrow range:

1. Format each base label with the existing `HH:mm` options.
2. Derive a locale-independent local wall-minute key from `Intl.DateTimeFormat(...).formatToParts()`: year, month, day, hour and minute in the requested timezone.
3. Extract each instant's `timeZoneName` using `timeZoneName: 'shortOffset'`.
4. Mark a wall-minute key only when it occurs more than once with different offsets.
5. Append the short offset on a second line only to ticks in those marked groups. Use the conditional bottom and right margins below so the added line fits; leave every other label byte-for-byte equal to the existing output.

This distinguishes the two Zurich `02:00` ticks without adding offsets to Uganda, ordinary hours or the same clock time on different dates. The axis callback receives the complete split array, so the decision belongs there. Do not change tick spacing, global inset constants, locale defaults or the 48-hour threshold.

The offset is a second line. The fixed 36 px x-axis band clips that line at the bottom of the 360 px canvas: the real 320 px-wide, DPR 3 uPlot check measured its bottom at 366.75 px. Change the x-axis `size` to uPlot's supported callback form and derive it from the already-formatted `values`:

```ts
size: (_plot, values) =>
  PLOT_INSETS.bottom + (values?.some((label) => label.includes('\n')) ? 16 : 0)
```

uPlot 1.6.32 calls the size function with `values = null` during initialization despite the narrower declaration in `uPlot.d.ts`; the optional chain is required. This reserves the second line only when the axis actually contains a rollback label. Do not raise `PLOT_INSETS.bottom` globally. Extend the adapter test to call the size function with the initialization null and assert 36 px, then assert 52 px for the fold labels and 36 px for Uganda and wide date-only labels. The real uPlot check at 320 px and 448 px must prove both lines stay inside the canvas, while an ordinary chart retains its previous plot rectangle and bottom inset.

The longer offset label also needs conditional right padding. At 448 px, Chromium measured the last `GMT+1` label through x=453.479 on a 448 px canvas with the ordinary 12 px right inset. Keep the ordinary inset at 12 px and return 28 px only for a layout cycle that renders a newline-bearing fold label. Use uPlot's `PaddingSide` callback; `axesCalc()` runs the x-axis `values` callback before `paddingCalc()` in each convergence cycle.

Store whether the latest x-axis labels contain a newline in a closure local to `mountUplot`. Because a narrower second cycle could choose different splits, make the fold reservation sticky within one convergence run: reset it from the current labels when `cycleNum` is 1, then OR in any fold label seen in later cycles. The initialization call at cycle 0 returns the ordinary 12 px value. A later render starts at cycle 1 and resets to 12 px when its current labels contain no fold annotation. This avoids a 12↔28 px oscillation without leaving extra padding after the viewport moves away from the fold.

Add adapter assertions for initialization at 12 px, fold layout at 28 px, cycle-local stickiness, and a subsequent ordinary cycle reset to 12 px. The real 320 px and 448 px checks must place every fold-label text bound within the canvas horizontally and vertically. Check an ordinary Kampala render too: its plot rectangle must retain the existing right and bottom geometry. Do not measure canvas text in product code or add a permanent global margin.

Construct the base-label, wall-key and offset `Intl.DateTimeFormat` objects once per batch callback. Do not call the singular formatter for every split from the batch helper. Keep the batch helper private to the adapter; tests exercise it through the captured axis callback.

### Inspector algorithm

Add one small exact-instant formatter local to the history core. It uses the existing explicit mobile date/time fields plus `timeZoneName: 'shortOffset'`. Use it only for:

- the containing-bucket inspector target;
- the chart host's fallback bucket endpoints;
- the two endpoint strings passed by `MobileTensionHistory` to `labels.bucketInterval`.

Do not replace `MobileTensionHistory`'s general `dateText`; that function also formats compact header and Details content. Do not alter the nearest-point mode's `new Date(timestamp).toLocaleString()` default. The formatter receives the existing explicit locale and IANA timezone and does not consult browser defaults.

## D. Repair the two Markdown table cells

Escape the literal union separators in these existing plan rows so Markdown renders the intended two- and three-column tables:

- `docs/superpowers/plans/2026-10-24-mobile-history-real-data-slice-1.md`: write ``current \| other_supported \| unknown`` inside the code span, or replace the union with comma-separated prose.
- `docs/superpowers/plans/2026-10-24-mobile-history-slice-1-adapter-brief.md`: write ``string \| null`` in the dropped-series type.

Run the repository Markdown/prose checks on both files. These are documentation corrections; they do not change the adapter contract.

## Acceptance

The corrections are complete when real StrictMode rendering loads and displays finite data; two backward moves reuse the two completed hourly neighbor prefetches; invalid prefetch coverage, policy and selected IDs are not cached; the Zurich rollback labels identify both offsets through the actual axis, fallback inspector and mobile-label paths; ordinary Uganda and wide-range labels remain unchanged; foreground validation, cancellation, revision fencing and cache bounds remain green; edge required checks pass; and cloud required checks execute and pass. The existing GitHub billing/spending-limit block still prevents cloud merge readiness until hosted checks can run. Issue #390 and rollout issue #516 continue to block feature enablement, not the default-off code merge.
