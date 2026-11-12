# Smoke baseline after the sandbox and HTTP-reply fixes

The known-to-fail list shrank from 26 to 9 cases after rebasing onto
`88f6e84bb251a03034dc4a6e8fa8e3a10992a2e4` (#631, #632 and #634 included).
The stage-1-sensitive sequences and all expected outcomes were not changed.

The first real-runtime run kept the original 26 entries. It exited 1 with
182 passed, 23 failed and 3 known-to-fail: 17 listed cases now passed and
six listed cases had changed signatures. No previously passing, unlisted
case failed. Only after that run were the 17 entries removed and the six
signatures narrowed: #632 now exposes `503 valve_busy` instead of losing the
HTTP reply. The remaining database/radio failures were already present.

## Removed cases

Each case below passed its HTTP, stored-state and radio assertions in the
unchanged-list run. The merged fix is shown per case.

| Case | Fix |
|---|---|
| `command-accepted:close` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `command-accepted:close-duration` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `command-accepted:open-duration` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `command-accepted:interval` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `command-accepted:timed-close` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `command-accepted:magnet` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `command-accepted:partial-close` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `command-accepted:flushing` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `open-report-close-open` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `no-clock-safety-close` | [#632](https://github.com/Open-Smart-Irrigation/osi-os/pull/632) |
| `lifecycle:assign` | [#631](https://github.com/Open-Smart-Irrigation/osi-os/pull/631) |
| `lifecycle:remove` | [#631](https://github.com/Open-Smart-Irrigation/osi-os/pull/631) |
| `lifecycle:delete-device` | [#631](https://github.com/Open-Smart-Irrigation/osi-os/pull/631) |
| `scheduler-irrigates` | [#631](https://github.com/Open-Smart-Irrigation/osi-os/pull/631) |
| `no-token:DELETE /api/devices/:deveui` | [#631](https://github.com/Open-Smart-Irrigation/osi-os/pull/631) |
| `no-token:PUT /api/irrigation-zones/:id/devices/:deveui` | [#631](https://github.com/Open-Smart-Irrigation/osi-os/pull/631) |
| `no-token:DELETE /api/irrigation-zones/:id/devices/:deveui` | [#631](https://github.com/Open-Smart-Irrigation/osi-os/pull/631) |

#631 fixed seven cases; #632 fixed ten. #634 grants a size-ratchet exception
and did not itself fix a smoke case.

## Remaining cases

Every remaining case has exactly one finding ID from
[tracking issue #637](https://github.com/Open-Smart-Irrigation/osi-os/issues/637).
Several cases exercise variants of the same finding. No new finding was
needed. The classifier also rejects entries that combine finding IDs.

| Case | Finding | Observed failure |
|---|---|---|
| `startup-node-errors` | F-14 | Startup SQLite node has no configured database. |
| `open-no-report-open-later` | F-1 | Later ordinary open is refused; its frame and commanded record are absent. |
| `no-clock-open-report-close-open` | F-2 | CLOSED stays OPEN; later open is refused; untrusted reporting leaves the command pending and a separate run. |
| `no-clock-open-no-report-open-later` | F-1 | Later ordinary open is refused; its frame and commanded record are absent. |
| `open-after:close-duration` | F-4 | Open after the service command is refused; no new open frame or commanded record. |
| `open-after:timed-close` | F-4 | Open after the service command is refused; no new open frame or commanded record. |
| `open-after:flushing` | F-4 | Open after the service command is refused; no new open frame or commanded record. |
| `no-token:POST /api/account-link` | F-13 | Unauthenticated request gives no HTTP answer. |
| `no-token:POST /api/sync/force` | F-13 | Unauthenticated request gives no HTTP answer. |

`no-clock-open-no-report-open-later` belongs to F-1: the marker is absent,
but no OPEN report arrives, so it does not reproduce the report-attribution
sequence that defines F-2. F-5 is absent from the new list because #632 fixed
the reply path, including the initial accepted requests in the six cases
that remain blocked by F-1, F-2 or F-4.

## Accepted-close timing observation

A later local run returned 202 and handed over the correct expiry-free CLOSE,
then `no-clock-safety-close` sampled zero actuator-log rows before the asynchronous
insert completed. The completed run's database contained the correct CLOSE row.
This case already failed on the old baseline under F-5; it was not a previously
passing baseline case. The check now polls for that same stored row within the existing five-second
wait window before asserting its original result. No finding or allowance was
added for the timing race. All stage-1-sensitive cases remain unchanged.

## Stage-1 assessment

Stage 1 accepts an ordinary open after an unconfirmed ordinary command as
v0.8.1 does, without a bounded wait. Records remain bookkeeping and must not
invent trusted times or completion. This assessment reads the two valve
rulings and the existing cases; it does not execute a stage-1 candidate.

| Case | Compatibility and change needed |
|---|---|
| `open-no-report-open-later` | Acceptance, second frame and second commanded record agree with stage 1. The test first ages three days; add an immediate retry without aging, reports or a reconciliation tick to prove there is no bounded wait. |
| `no-clock-open-no-report-open-later` | Same acceptance rule and timing gap, with the marker absent. Add the immediate retry. |
| `no-clock-open-report-close-open` | Acceptance agrees with stage 1. Requiring `observed_close_at` without a trusted clock conflicts with the rule against invented trusted completion. Replace that assertion with per-command duration/identity checks, no report-only duplicate when attribution is unique, and retained untrusted report evidence. CLOSED means the last report the gateway accepted, not physical state. |
| `open-after:close-duration` | Acceptance and an additional commanded record agree with stage 1. Add an immediate open without the current three-day aging or CLOSED-report prerequisite. |
| `open-after:timed-close` | Same timing/report prerequisites must be absent from an immediate acceptance variant. |
| `open-after:flushing` | Same gap for an opaque ordinary service owner: no wait or report may be required before the next ordinary open. |

None of these cases demands that an earlier retry be refused. The delayed
cases are weaker than the no-bounded-wait rule and could pass an incorrect
bounded-fence implementation. The no-clock completion assertion needs an
actual contract change. Per-command durations and identities also need
stronger assertions than row counts. Those changes are deferred to the
owner-confirmed stage-1 work; this baseline update changes no scenario or
assertion. Conditional-owner classification in both directions, the stage-1
cancel rule, reboots and clock interleavings are not established by these cases.

## Evidence

`baseline-88f6e84bb.txt` replaces the old payload-baseline output. The base
name follows the main commit whose shipped payload runs, rather than this
PR's test-only head. Evidence paths in that file use `<scratch>`; only the
local scratch-directory spelling was normalized. The JSON result and logs
retain the original absolute path outside the repository.
