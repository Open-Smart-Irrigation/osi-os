# Mobile history Slice 1 final product review

**Verdict: PASS for the Task 1–4 product implementation.**

Reviewed product changes from edge base `55ec323f90d12864eab50cfeda74cb3bf8910834` through `b5a3af005`, and cloud base `f214163f29153c35821fe8f554b28ca7359760c2` through `7d6cecc31`. The in-progress Task 5 browser harness and execution reports were excluded. This was a read-only integration review; root owns the final test gates.

No concrete blocking product defect remains.

The integrated implementation preserves the reviewed contracts:

- The canonical core and cloud vendor source trees are byte-identical. The cloud provenance manifest remains pinned to canonical core commit `90820bb806aaed44dbf51e02f351d7d7634dae6a`; subsequent edge commits affect platform test typing and timezone validation rather than canonical source.
- Edge aligns only its transport bounds to UTC hours and uses `edge-hourly`. Cloud keeps the logical request bounds and distinguishes `cloud-raw-hourly` from `cloud-rollup-hourly`. Both pass ordered selected IDs and cancellation signals to their real Analysis clients.
- Both adapters enter the same mandatory normalizer. It rejects incomplete/truncated responses, policy mismatch, malformed platform grids, missing/duplicate/unrequested IDs, invalid units/counts/timestamps and non-covering ranges. Renderer points and inspector buckets share the sanitized values and preserve bucket count, quality, coverage and partial final-edge interval.
- Selection, backing response, request revision and denied-source state have separate ownership. Compatible full backing supports local removal and re-addition; incompatible removals restart transport; zero selection settles without transport; selection revision fencing prevents obsolete admission.
- Catalog SWR keys include platform, session and zone. Automatic retry is disabled, forced source-failure refresh is bounded by generation, and cancellation remains outside the visible closed error taxonomy.
- Route gates are literal build-time checks behind the existing private routers. Zone/timezone/session context, auth 401 expiry, route-local 403, locale, policy and diagnostics ownership are wired consistently on edge and cloud.
- The final timezone-validity change from `Intl.DateTimeFormat(undefined, ...)` to `Intl.DateTimeFormat('en', ...)` only removes host-locale dependence from IANA-zone validation. It does not alter the locale used for rendered chart values or timestamps.
- Existing Analysis/card behavior remains on its established paths. Edge's broader DTO optionality matches real Analysis payloads, while existing daily CSV handling retains its explicit timezone fallback.

The known cloud backend sub-second ceiling limitation remains a follow-up: a logical end just after an exact UTC hour can yield a grid ending at the prior exact hour because backend alignment ignores nanoseconds. The client correctly rejects that non-covering response. This does not block the internal Slice 1 route, whose normal horizon is minute-aligned, and backend production changes were explicitly outside this slice.

Release scope remains limited to the internal opt-in 24-hour/7-day hourly chart. The reviewed specification still gates public release and later 30/90-day work on browser acceptance, farm-day parity, historical-source policy, raw-reading validation, and the documented valid-UTC ambiguity.

## Follow-up from browser review

The initial verdict was superseded by the empty-state recovery finding: “Show latest 24 hours” preserved a seven-day span. Canonical commit `e17437634` fixes that action through one atomic span override; cloud mirrors it in `7b245892`. Sol scoped re-review passed, and root independently verified all 128 canonical tests plus build. The advanced-horizon and shell regressions both prove one fresh 24-hour request. Prototype caller compatibility was corrected separately in `52c4da265`. The integrated product verdict is restored to PASS, subject to the separate browser acceptance gates.

## Initial selection correction, 2026-10-25

Browser acceptance exposed a second bounded shell defect: a nonempty default selection could briefly render the hook's previous `no-selection` state as an empty interval before any response existed. Canonical commit `e397fd527` now renders Loading during that transition and requires accepted `no-finite-data` before offering interval recovery. Cloud mirrors it in `cc89d945`. Sol scoped review passed; root independently passed 129 tests across 13 files and the core build. The new deferred-loader test failed before the change and covers both pre-request and pending-response loading, then genuine completed-empty behavior. Loader/cache semantics are unchanged.
