# Mobile history legend integration

The approved mobile legend keeps many channel names behind an inline disclosure. Selecting a name emphasizes its trace, closes the list, and leaves every selected channel plotted. Show all clears emphasis. Sensors remains the inclusion control. Full focused names wrap rather than disappear behind ellipsis.

Implement this in the existing shared uPlot package and mirror it to cloud. Also update the connected five-view HTML preview. This slice does not migrate the five-view shell to production, change loading or gesture policy, add irrigation settings, or repair historical sensor values.

## Evidence and design decisions

The canonical package is `web/history-uplot-core`; cloud vendors it under `frontend/vendor/history-uplot-core`. Both host frontends use packed local dependencies, not source symlinks. Baseline package tests (53), typecheck, and vendor parity passed before editing.

Existing sensor checkboxes use an available-series index for their swatches, while uPlot uses the visible-series index. Hiding a channel therefore changes its neighbours' colours. `MobileSoilHistory` also allocates `visibleSeries` on every render, which causes `ChartHost` to reset its data and inspector on unrelated UI changes. Both defects must be corrected for the new legend to work.

The accepted visual comparison is `mobile-history-many-sensors-refined.html` in the local companion session. Its chart and focused identity can grow or shrink with text size; a fixed 44-pixel height is only a baseline for the unfocused compact row, not a promise for all states.

## Shared contracts

Add `SeriesAppearance` in `src/shared/types.ts`:

```ts
interface SeriesAppearance {
  color: string;
  dash: readonly number[];
  marker: 'circle' | 'square' | 'triangle' | 'diamond';
}
```

Add optional `appearance` to `SensorSeries`, optional `setFocusedSeries(id: string | null): void` to `ChartAdapter`, and optional `focusedSeriesId: string | null` to `ChartHostProps`. Existing non-uPlot adapters remain compatible.

Create `src/shared/seriesAppearance.ts` with `getSeriesAppearance(index: number): SeriesAppearance`, using twelve colour/dash/marker combinations. Each mobile history context keeps a per-unit registry keyed by series ID. Hide/show, source reorder, and data refill retain an existing ID's style. A context change resets the registry. Unit changes clear emphasis but can retain that unit's registry for a return visit. Apply styles before filtering enabled channels.

Create `SeriesLegendLabels` with `legend`, `showAll`, `plottedSeries`, `seriesCount(count)`, `focusAnnouncement(label)`, and `allSeriesAnnouncement`. Add these under required `seriesLegend` in `MobileSoilHistoryLabels`. Hosts own translations.

## Task 1: renderer focus and appearance

Owner: fresh Luna worker. Files: shared types and appearance helper; `ChartHost.tsx`; `adapters/uplot.ts`; corresponding focused tests; package exports if necessary. Do not edit the mobile component or CSS.

1. Add meaningful failing tests for a focus-only host update preserving adapter, data, viewport, and inspection pin. Test style encoding and stable ID-based focus through adapter reconciliation.
2. Implement the contracts above. uPlot must use the supplied appearance, including matching point shapes where markers are shown. Preserve the existing marker-density limit and missing-value gaps.
3. Implement focus with the installed uPlot 1.6.32 public API: `setSeries(index, { focus: true })` and `setSeries(null, { focus: false })`. Resolve indices from current IDs; reapply emphasis after data reconciliation. Focus never calls `setData`, changes scales, or remounts the chart. Use the existing public alpha setting for dimming.
4. Keep data and focus effects separate in `ChartHost`. A data update may reapply the current focus after updating samples; a focus-only update must retain the pin.
5. Run focused tests, the full package suite, and package typecheck. A temporary compile failure from a concurrent UI edit must be reported with its owning path.

## Task 2: shared mobile legend and inclusion disclosure

Owner: fresh Luna worker. Files: `mobile/SeriesLegend.tsx`, `mobile/MobileSoilHistory.tsx`, `mobile/styles.css`, and mobile tests. Use Task 1's exact contract; do not edit its files.

1. Test eight-channel compact mode, three-channel inline mode, full labels, focus/clear, all-hidden recovery, focus reset boundaries, and style retention through refill/reorder/hide/show.
2. Memoize styled available and visible series. Legend UI state must not alter the data array or invoke any loading/navigation method.
3. Keep one-to-three-channel legend entries inline. For four or more, show a count and Legend button. Expand a bounded scrollable list directly below the chart. Buttons are at least 44 pixels, use `aria-expanded`, `aria-controls`, and `aria-pressed`, and have matching swatches.
4. Clicking a legend row emphasizes that ID, collapses the list, and restores focus to a useful control. Show all restores equal emphasis. Escape collapses and returns focus to Legend. Full focused identities wrap. Announce emphasis changes through translated status text.
5. Preserve focus on ordinary accepted-data refresh or reorder. Clear focus and close the panel on context, unit, or inclusion changes. An empty interval retains descriptor metadata and does not silently change the user's selection. All-hidden remains supported by the real component.
6. Put the existing Sensors checkbox list behind a compact disclosure when more than three channels are available. Keep the zero-selected recovery control available. This is an inclusion action, separate from legend emphasis; it does not rewrite data or units.
7. Run mobile tests and package typecheck. Existing range, metadata, loading, error, and chart recovery behavior must remain intact.

## Task 3: host labels, mirror, and real-browser verification

Owner: Luna for host labels; parent for integration and verification after independent review.

Update both `MobileSoilUplotHistory.tsx` wrappers and all seven `history.json` locales in each repo for `seriesLegend`. Preserve translations and placeholders; update the edge locale leaf-count guard to reflect actual additions. Add no API normalization changes.

Copy the complete canonical package to cloud, excluding generated dependencies and outputs, and run `scripts/verify-history-uplot-vendor.sh` with the explicit cloud worktree. Refresh both packed host dependencies and prove their source bytes match the reviewed package before builds.

Use the existing actual-host Playwright fixtures with eight and twelve same-unit channels. Verify opening, focus, clearing, and selection preserve the requested viewport; focus adds no history requests; a pinned inspection survives focus; hiding channels keeps styles stable; long names and 200% text do not overflow. Run on both host routes. Existing gestures and empty recovery must still work.

Required gates: canonical and vendored package test/build; prototype test/build; edge typecheck, unit suite, and build; cloud unit suite and build; vendor parity; relevant actual-host browser tests; `git diff --check` in both worktrees. Distinguish any pre-existing failure from this change with evidence. Do not repeatedly broaden verification after successful gates without a new concern.

## Task 4: connected preview

Create a new companion HTML filename from the accepted connected preview, preserving the original. Integrate the approved legend behavior, enough explicitly illustrative soil channels to exercise eight-series mode, stable identities, and honest profile/calendar selection handling. Preserve dates, five-view navigation, event return, empty recovery, and sheet accessibility. No irrigation settings or command controls.

Check the connected flows and legend at 320/390/448 pixels. Keep this sample-data preview distinct from the real shared uPlot implementation and from authenticated live verification.

## Review and completion

Sol authored the initial integration plan; the parent revised it into explicit worker ownership and interface contracts. Sol independently reviews the implementation, and the parent verifies the result. Record source/build/browser evidence before any test deployment. Access to a production cloud host is excluded. Deployment, if performed, uses the existing test canary and preserves the main frontend and backend.
