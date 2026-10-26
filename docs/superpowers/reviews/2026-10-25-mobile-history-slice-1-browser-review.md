# Task 5 edge browser harness review

**Verdict: PASS for the final frozen static harness.** Root's production-build edge off/on matrix remains the runtime acceptance gate.

The all-null gesture now waits for the initial fulfilled response and settled EMPTY state before acting. Its live poll then requires renderer agreement and a fulfilled foreground request whose hourly floor/ceil wire bounds match the current final viewport. Only afterward does the test capture and close one or two new requests. An optional prefetch is limited to the same selectors, hourly aggregation, aligned span, and a distinct nearby overlapping range. Exact Details coverage proves the foreground response was admitted. Show latest remains exactly one fresh request.

The rest of the harness remains consistent with the acceptance brief:

- The matrix builds literal-off/on production bundles, exercises the protected route, verifies lazy-chunk exclusion, and keeps API traffic local and allowlisted.
- Selection tests cover backing reuse, one stable uncached addition, pending-addition fencing, the 25-source cap, zero selection, and loader caps.
- Stale and rapid cases allow only the named superseded route to fulfill or abort and prove current ownership with exact Details coverage.
- Inspector events retain fractional coordinates and verify adjacent values and accessible intervals on both sides of an hourly boundary.
- Responsive cases isolate each navigation's 25-selector request and verify actual 16 px and 32 px root sizes, control size, zero overflow, and transformed canvas alignment. The unit is inside the viewport and above the diagnostic plot; shell-box containment is not imposed.
- Diagnostic sampling covers delayed work, gesture foreground and prefetch lanes, and cache hits. CPU-throttled evidence remains separate from the unthrottled frame gate.

Static review cannot establish Chromium rendering, request event delivery, or timing measurements. Those claims depend on root's pending matrix.

## Runtime closure

Root's final edge production-build matrix completed with 21 passing tests, 21 intentional project skips, and no failures or flaky retries. Root also visually reviewed the 320 px normal and 200 percent captures. This closes the runtime limitation above for the edge harness; the edge Task 5 verdict is PASS.
