# Journal DST-fold test determinism prerequisite

## Scope

This is an edge test-only prerequisite for the mobile-history PR. Do not change Journal production behavior, occurrence resolution, timers, timeouts, or mobile-history code.

The host clock reached `2026-10-25T02:29+01:00` in `Europe/Zurich`, inside the repeated DST hour. The four unchanged suites initialize Journal forms from the real current local minute. `resolveOccurrence('2026-10-25T02:30', 'Europe/Zurich')` correctly returns `ambiguous_local_time`, so normal form progress stops and downstream assertions time out. The dedicated occurrence regression already proves the fold behavior and must remain unchanged.

## Test change

Apply the same Date-only clock fixture to these four files:

- `web/react-gui/src/pages/__tests__/JournalPage.test.tsx`
- `web/react-gui/src/components/journal/desktop/__tests__/DetailPanel.test.tsx`
- `web/react-gui/src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx`
- `web/react-gui/src/components/journal/__tests__/capture/JournalCaptureFlowCropCycle.test.tsx`

Use one explicit unambiguous instant, such as:

```ts
const TEST_NOW = new Date('2026-07-16T12:30:00.000Z');
```

In each suite's existing top-level `beforeEach`, add:

```ts
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(TEST_NOW);
```

In its top-level `afterEach`, add `vi.useRealTimers()`. Add the missing `afterEach` imports in `JournalPage.test.tsx` and `DetailPanel.test.tsx`. Preserve existing cleanup, mock restoration, and console-warning assertions.

`toFake: ['Date']` is required: `setTimeout`, `setInterval`, animation scheduling, and Testing Library polling must remain real. Do not raise a timeout or convert these suites to fully fake timers.

`JournalCaptureFlow.test.tsx` has one focused test that installs full fake timers and pins `2026-01-15T22:30:00.000Z`. Keep that test's clock and its `finally { vi.useRealTimers(); }`. The suite-level `afterEach` restores timers again, and the next test's `beforeEach` reinstalls the Date-only clock. Do not replace the focused timezone assertion with the suite clock.

## RED/GREEN evidence

Record the current failure as the RED result:

- `JournalPage.test.tsx`: 1 failure
- `DetailPanel.test.tsx`: 6 failures
- `JournalCaptureFlow.test.tsx`: 68 failures
- `JournalCaptureFlowCropCycle.test.tsx`: 9 failures

Then run the four files together under the same `Europe/Zurich` environment while the system clock remains in the fold hour. All must pass with their existing assertions and real polling timers. Run the full edge Vitest command afterward. Do not weaken the explicit `occurrence.test.ts` fold regression; run it as a named check if it is not included in the full command.

Commit this as a separate test-only prerequisite so reviewers can distinguish CI clock determinism from mobile-history behavior.

## Existing product behavior

The production form currently derives a local default from a real instant but does not carry that instant's known offset into the fold-hour form state. This can require an offset choice when capture opens during the repeated hour. Do not change it in this PR. File a separate Journal issue to decide whether an automatically generated “now” value should preserve the current offset while manually entered ambiguous times continue to require explicit disambiguation.

If the cloud suite shows the same real-clock failure, apply the same Date-only pattern only to its affected Journal test files in a separate cloud prerequisite commit. Do not copy edge test changes speculatively.
