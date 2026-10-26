# Empty-state “latest 24 hours” correction

## Defect

`MobileTensionHistory.tsx` renders the empty-state action with the label `showLatest24h`, but its handler calls `model.showLatest()` with no span. `useHistoryWindow.showLatest()` currently preserves `viewportStore.get().to - viewportStore.get().from`. Therefore an empty seven-day viewport sends another seven-day request when the farmer chooses “Show latest 24 hours.” The visible label and Slice 1 contract require one force-fresh request for the latest 24 hours.

## Bounded API correction

Change the public result signature in `web/history-uplot-core/src/history/useHistoryWindow.ts` from:

```ts
showLatest(): void;
```

to:

```ts
showLatest(spanOverride?: '24h' | '7d' | '30d' | '90d'): void;
```

Keep every existing zero-argument caller unchanged. A zero-argument call continues to preserve the current viewport span, including the Time-sheet `Latest` action.

Implement the override inside the existing `showLatest` transition:

1. Define/reuse the preset-duration map already used by `selectPreset`.
2. Compute `span` from `spanOverride` when present; otherwise use the current viewport span.
3. Clamp it to `maxSpanMs` and assign `visibleSpan.current = span`.
4. Compute the minute-aligned latest `to` exactly as today.
5. If `to === horizon.to`, set `{ from: to - span, to }` once and call `schedule(..., 'latest', { forceFresh: true })` once.
6. If the clock advanced past `horizon.to`, store `{ to, span }` in the existing `pendingLatest` ref and update `horizonEnd`. The existing horizon effect then sets the viewport and schedules the single force-fresh request. Do not call `selectPreset` followed by `showLatest`; that creates an intermediate request and two state transitions.

Change only the empty-state button in `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx` to:

```tsx
onClick={() => model.showLatest('24h')}
```

Leave the Time-sheet `Latest` handler as `model.showLatest()`.

## RED tests before implementation

Add a hook regression in `web/history-uplot-core/tests/useHistoryWindow.test.tsx`:

- Use `analysisHourlyRangeStrategy`, a seven-day maximum and a mutable `now` value.
- Settle an accepted request, select the seven-day preset, and settle that request.
- Advance `now` by one hour so the test exercises the existing `pendingLatest`/horizon-update path.
- Clear the load mock, invoke `result.current.showLatest('24h')`, and wait for the scheduled load.
- Assert exactly one load call, `request.to === floor(now / MINUTE_MS) * MINUTE_MS`, `request.to - request.from === DAY_MS`, and `request.rangeLabel === '24h'`. Assert the viewport equals that same interval. This proves there is no intermediate seven-day request.
- Retain the existing zero-argument Latest test and add/assert that `showLatest()` still preserves its current span.

Strengthen the shell test in `web/history-uplot-core/tests/mobileTensionHistory.test.tsx`:

- Return complete all-null responses.
- Move to the seven-day preset and wait for the shell to become empty.
- Clear recorded load calls, click `Show latest 24 hours`, and assert the next and only request spans exactly 24 hours with label `24h`.

These tests exercise behavior through the public hook and shell rather than checking for the new optional argument syntactically.

## Browser fixture correction

In both platform fixture modules, define the `finite-outside-viewport` data using absolute fixture time, not `bucketIndex`. For example, choose a fixed old interval inside the seven-day window and ending more than 24 hours before `FIXTURE_NOW`:

```ts
const OLD_FINITE_FROM = FIXTURE_NOW - 7 * DAY_MS;
const OLD_FINITE_TO = FIXTURE_NOW - 6 * DAY_MS;
const finiteOldValue = pointAt >= OLD_FINITE_FROM && pointAt < OLD_FINITE_TO;
```

Return ordinary finite values only when `finiteOldValue`; return null otherwise. On cloud, preserve the grid anchor before logical `from` and evaluate overlap by the bucket interval. An anchor earlier than logical `from` is still in-view when `bucketTo > logicalFrom`.

The browser flow should then prove:

1. Initial latest 24 hours is EMPTY.
2. Seven days is READY because the old fixed interval overlaps it.
3. Selecting 24 hours returns to EMPTY while the accepted seven-day backing still contains finite older data.
4. Switch the fixture to normal, click `Show latest 24 hours`, and assert exactly one new request with label `24h`, a 24-hour logical span (25 aligned edge buckets; 25 cloud grid buckets for the minute-offset fixture), latest endpoint, and READY recovery.

Keep the separate all-null/gesture recovery case if useful, but it does not replace the seven-day-to-24-hour regression.

## Canonical/vendor sequence and verification

1. Implement and run the two focused canonical test files:

```bash
cd web/history-uplot-core
npx vitest run tests/useHistoryWindow.test.tsx tests/mobileTensionHistory.test.tsx
npm run build
```

2. Commit the canonical fix, resync the cloud vendor from that reviewed commit, and run both vendor parity modes. Do not hand-edit the vendored copy.
3. Update the edge and cloud browser fixtures/specifications with the absolute-time scenario and run their focused browser cases as part of root's existing Task 5 matrix.
4. Record the corrected canonical source commit in the cloud vendor manifest.

No backend, cache, route, locale, or existing zero-argument Latest behavior changes are required.
