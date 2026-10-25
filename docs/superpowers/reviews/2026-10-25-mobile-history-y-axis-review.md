# Mobile history y-axis correction review

## Verdict

The scoped edge patch passes static and focused review against `docs/superpowers/plans/2026-10-25-mobile-history-y-axis-correction.md`. I found no product or test blocker in the two changed source files.

This verdict covers the shell prop, its component regression and the supplied RED/GREEN evidence. The edge production matrix, root's independent final reruns and cloud resync are now complete, as recorded below. Hosted checks remain a merge gate.

## Source and regression

`MobileTensionHistory` now passes `yRange="auto"` to its existing `ChartHost`, matching the established `MobileSoilHistory` choice. The adapter implementation and its fixed default remain unchanged, as do APIs, selection limits, flags, geometry and performance thresholds.

The component regression uses a typed `MountAdapter` spy and an accepted response whose same series contains both 150 and 151 kPa in points and hourly buckets. It waits until those two finite values reach `setData`, then checks the actual fourth mount argument for `{ yRange: 'auto' }`. This exercises the public mobile shell boundary rather than an isolated range helper.

The captured RED run failed on the intended contract: accepted high values reached the chart, but the adapter options contained `yRange: undefined`. The focused GREEN run passed after the one-prop change. The supplied canonical package run passed 141 tests across 13 files, and `tsc --noEmit` passed.

## Real renderer evidence

Root's actual-component Chromium probe records the prior shell with 150–151 kPa data but a 0–100 axis. With the patch, the same shell reports `yRange: "auto"` and ticks from 150 through 151. Its companion cases retain measured zero with a range around zero and all-null data with the adapter's empty range; none produced page errors. Evidence is in `/tmp/mobile-history-y-axis-shell-red.json` and `/tmp/mobile-history-y-axis-shell-green.json`.

The completed production matrices cover 21 edge cases and 22 cloud cases. Cloud received the mechanical vendor resync with verified byte/hash provenance.


## Root completion evidence

After the scoped review, root independently passed the final 141-test core suite, package build and edge host typecheck. The production browser matrix completed with 21 passing cases, 21 opposite-project exclusions and no failures or flaky retries. The real-shell all-null probe also asserted the empty-range message and recovery button. Cloud commit `be7dfea39867508a03a0fc57d53ea3881ca464f7` pins edge source commit `a86b01f6e96a5c7e3d11b2bad69b77410fee67f3`; all 43 vendor files match. Cloud also passed 141 core tests, package build, host typecheck/build and 22 production browser cases, plus actual-shell high-value, zero and null checks. Hosted checks remain separate: edge checks are pending and cloud jobs cannot start because of the account payment/spending-limit restriction.
