# Slice 1 core implementation review

Reviewed commit: `6724bf61d`, over baseline `253095ad3`.

Verdict: requires correction before vendoring or route integration. Sol performed the specification review; root independently ran the existing tests and added behavioral regressions.

The submitted core suite passed 84 tests and TypeScript compilation. Four additional root tests failed: invalid hourly averages remained in plotted points, controlled selection changes were ignored, a denied source could be selected again, and a loaded all-null interval reported ready. The regression file is `web/history-uplot-core/tests/root-task1-regressions.test.tsx`.

## Required changes

1. Use one mandatory normalized Analysis boundary carrying grid, dropped-ID and per-series truncation facts. Validate it before producing chart data. Sanitize invalid averages in both plotted points and inspector buckets, preserving actual intervals, count and quality.
2. Unify controlled and manual selection updates. Maintain a denied-ID set for the current authorization scope and update refs, display and revision fences together.
3. Cancel obsolete selection requests before they can enter the loader cache. Reuse compatible accepted backing data even when it exceeds the cache admission limit.
4. Check read-policy equality at direct commit, merge and cache admission, as well as cache lookup and request joining. Give prefetch transport the decorated request.
5. Pass an explicit snapshot of ordered selected IDs to transport. A sorted cache key cannot supply selected order, and a render closure is vulnerable to stale selection.
6. Connect complete visible coverage and finite bucket overlap to the hook's empty state. Keep no selection distinct from an empty loaded interval.
7. Pass locale/timezone to the axes and both visible-window formatting paths. Preserve legacy nearest-point formatting when the new mode is omitted.
8. Preserve missing/dropped IDs and reasons in structured failures. Network failures offer transient retry; 401 and 403 remain distinct.

The original tests did not cover these failures. The correction plan must add red tests for the listed behavior before changing implementation, then rerun the complete core suite. No vendor or product route work has started.

## Correction round 1 review

Reviewed range: `6724bf61d..ef9e4196f`. Verdict: RED. The DTO boundary, sanitized renderer values, revision allocator, controlled removal, initial-load removal restart, and wholesale response replacement improved. The following remain required:

- Direct Analysis responses bypass the policy/completeness check when the viewport has not moved.
- Every addition still schedules a request, even with retained complete backing; the supposed oversized test used only eight points.
- Zero selection is guarded only at initialization, and removing the final finite series leaves the wrong ready state.
- Clearing denied IDs on a new scope does not restore a controlled selection whose array reference is unchanged. Initial selection is not deduplicated.
- Callback freshness is incomplete. The ordered-context test does not assert ordered IDs or the third transport argument.
- Non-finite coverage is accepted. Required public normalizer and structured failure test cases remain absent.
- Containing-bucket fallback interval formatting omits the explicit locale/timezone mode; nearest-point numbers still use the new formatter.

Root independently ran `npx vitest run tests/root-correction-regressions.test.tsx`: four failures, one pass. The failing cases are wrong read policy, zero-selection preset, actual 20,800-point backing after the debounce, and last-finite removal. Controlled prop removal passed. Log: `/tmp/mobile-history-root-correction-regressions.log`.

Root ruling: preserve the pre-existing partial direct response and status behavior for legacy card-default consumers. Strict complete-response admission and finite-bucket empty detection apply to selected-ID Analysis mode. Changing the legacy test to require full coverage would break the existing not-loaded overlay behavior.

## Final core verdict

Sol passed Task 1 at `43d5320d4` after scoped correction reviews. Commit `c0f9aa412` changes only a test title to describe its foreground coverage accurately. The core now rejects incompatible direct Analysis responses, retains compatible backing through selection changes, settles cancelled/error state, and keeps zero selection request-free. Legacy card-default partial direct behavior remains intact.

Root independently ran the 100-test suite/build at `55008ea9f` and the 103-test suite/build at `701cba32a`. The final zero-selection regression was added afterward. The missing explicit hook-triggered prefetch-context assertion is nonblocking test-depth debt, to remain visible in final review.
