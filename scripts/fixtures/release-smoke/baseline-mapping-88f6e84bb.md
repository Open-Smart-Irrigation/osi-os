# Smoke baseline after the sandbox and HTTP-reply fixes

The first baseline update reduced the list from 26 to 9 cases after rebasing onto
`88f6e84bb251a03034dc4a6e8fa8e3a10992a2e4` (#631, #632 and #634 included).
The council follow-up expands it from 9 to 11: one scheduler case now has
controlled writer contention (F-7), and a populated dendrometer weather case
reproduces NEW-1. The payload base stays the same, so the evidence filename
stays `baseline-88f6e84bb.txt`. The six stage-1 valve scenarios and all their
expected outcomes remain unchanged.

The first real-runtime run kept the original 26 entries. It exited 1 with
182 passed, 23 failed and 3 known-to-fail: 17 listed cases now passed and
six listed cases had changed signatures. No previously passing, unlisted
case failed. Only after that run were the 17 entries removed and the six
signatures narrowed: #632 now exposes `503 valve_busy` instead of losing the
HTTP reply. The remaining database/radio failures were already present.

## F-13/F-14 wiring follow-up

Rebased onto main `b0a5e3cfa2b905256a0e6e5491230e7d663d420c`, #649 makes
both no-token POSTs answer 401 and removes the unconfigured SQLite node. The
earlier unchanged-list run on `23bfda61` rejected exactly those three
now-passing allowances. Main #648 removed its six valve cases. After rebasing
and removing only the three F-13/F-14 entries,
ordinary mode reports 214 passed, zero unexpected failures and two known
failures. The historical baseline filename is retained; its header identifies
the new base and candidate flow checksum.

The new scoped catches add deliveries for `al-link-validate` and
`sync-force-build`, beside the existing recording catches. Their respective
messages remain `Error: Unauthorized` and `Error: Missing bearer token`.
The matcher checks case, source, type and message, so the 33 expected-refusal
entries need no change. No other refusal is permitted.

## Removed cases

Each case below passed its original HTTP, stored-state and radio assertions
in the unchanged-list run. The fix is shown per case. The scheduler's
crypto/save failure remains fixed by #631; its new contention precondition
now exposes the separate F-7 persistence defect.

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
| `no-token:POST /api/account-link` | [#649](https://github.com/Open-Smart-Irrigation/osi-os/pull/649) |
| `no-token:POST /api/sync/force` | [#649](https://github.com/Open-Smart-Irrigation/osi-os/pull/649) |
| `startup-node-errors` | [#649](https://github.com/Open-Smart-Irrigation/osi-os/pull/649) |

#631 fixed seven cases; #632 fixed ten. #634 grants a size-ratchet exception
and did not itself fix a smoke case.

## Earlier remaining cases before #648

Every remaining case has exactly one finding ID from
[tracking issue #637](https://github.com/Open-Smart-Irrigation/osi-os/issues/637).
The eight remaining cases cover five findings. The two added cases map to existing
F-7 and NEW-1, so no new finding ID was needed. The classifier also rejects entries that combine finding IDs.

| Case | Finding | Observed failure |
|---|---|---|
| `open-no-report-open-later` | F-1 | Later ordinary open is refused; its frame and commanded record are absent. |
| `no-clock-open-report-close-open` | F-2 | CLOSED stays OPEN; later open is refused; untrusted reporting leaves the command pending and a separate run. |
| `no-clock-open-no-report-open-later` | F-1 | Later ordinary open is refused; its frame and commanded record are absent. |
| `open-after:close-duration` | F-4 | Open after the service command is refused; no new open frame or commanded record. |
| `open-after:timed-close` | F-4 | Open after the service command is refused; no new open frame or commanded record. |
| `open-after:flushing` | F-4 | Open after the service command is refused; no new open frame or commanded record. |
| `scheduler-irrigates` | F-7 | Under one held native SQLite writer lock, both legacy SQLite nodes report exactly `Error: SQLITE_BUSY: database is locked`; the irrigation event and last-triggered timestamp are absent although the exact open frame arrives. |
| `dendro-weather-transport` | NEW-1 | The enabled daily inject reaches a populated dendro zone. Both weather warnings say `require is not defined`; stored rain is NULL and VPD source is unavailable. |

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

## After the valve fix (#648)

The owner decided on 12 November 2026 that valves behave as in v0.8.1: an
ordinary open is not refused because of an earlier command. The pull request
that makes it so changes the six valve cases with the fix, as the assessment
above assigned to it. The untouched-list run on that change exited 1 with 200
passed, 6 failed and 5 known-to-fail: five listed cases passed, and
`no-clock-open-report-close-open` failed only its old `stored` assertion,
which required an observed close time without a trusted clock. The six entries
were then removed and the assertions changed. No other entry was touched; the
scheduler case (F-7) is unchanged.

| Case | Finding | What it asserts now |
|---|---|---|
| `open-no-report-open-later` | F-1 | As before (open, three days, monitor tick, open: 202), with the valve's complete call list at the radio stand-in: two `enqueue 2/4101` without expiry and no flush. Two records, each with its own command id and 60 seconds, and no record without a command. |
| `open-no-report-open-at-once` | F-1, new | Open, then two more opens at once: no ageing, no report, no monitor tick. Three times 202, three expiry-free `2/4101` and no flush, three records with their own command ids. A refusal that lets go after any wait fails here. |
| `no-clock-open-no-report-open-later` | F-1 | The same as the first case with the NTP marker absent. |
| `no-clock-open-no-report-open-at-once` | F-1, new | The same as the second case with the NTP marker absent. |
| `no-clock-open-report-close-open` | F-2 | Marker absent: open, OPEN report, CLOSED report, open. `current_state` follows the last report the gateway accepted (OPEN, then CLOSED). The second open is 202 and the call list is two expiry-free `2/4101`. Exactly two records, one per commanded open, and no record without a command. The first record carries both reports as untrusted evidence (`transport_json.untrusted_report`), has no observed open or close time and stays `PENDING_OBSERVATION`; the old requirement of an observed close time is gone. Then the marker returns: a third open is 202 and the first record is unchanged. |
| `open-after:close-duration`, `:timed-close`, `:flushing` | F-4 | As before (service command, three days, CLOSED report, open: 202), with the call list: the service frame, then one expiry-free `2/4101`, no flush. One record for the open, with a command id and 60 seconds. |
| `open-at-once-after:close-duration`, `:timed-close`, `:flushing` | F-4, new | The open right behind the service command, with no ageing and no report: 202, the same call list, one record for the open. |

On `main` at `5040db091`, without the fix, the eleven cases above all fail
(`503 valve_busy`, and for the F-2 case also CLOSED shown as OPEN and a second
run without a command).

Not established by these cases, as before: conditional owners in either
direction, the cancel, reboots and clock corrections. They are covered by
`scripts/test-valve-v081-equivalence.js` and the module tests of
`osi-valve-control`, outside the real runtime.

Remaining after #648 and this F-13/F-14 fix, two cases over two findings:

| Case | Finding |
|---|---|
| `scheduler-irrigates` | F-7 |
| `dendro-weather-transport` | NEW-1 |

`after-valve-fix-648.txt` is the strict output on that change: 211 passed, 0
unexpected failures, 5 known failing cases, exit 1.

## Evidence

`baseline-88f6e84bb.txt` replaces the old payload-baseline output. The historical filename is retained; its header names the current main base
and candidate payload checksum. Evidence paths in that file use `<scratch>`; only the
local scratch-directory spelling was normalized. The JSON result and logs
retain the original absolute path outside the repository.

## Council blocker coverage

The final sweep invokes all 29 enabled injects once through their real nodes,
including manual, delayed, repeat-only and cron-only sources. Timer handles
are paused after the normal boot initialization window, making coverage
independent of host speed. Function completions and native SQLite callbacks
must settle, followed by 250 ms without message activity; an unfinished flow
fails after 15 seconds. Each inject's wired targets must appear among its
recorded recipients. This does not qualify arbitrary delayed callbacks inside
handlers, elapsed schedule behavior or every branch of those handlers.

All catch-node deliveries retain their source id/type and exact message.
The 33 expected refusal tuples apply only to named unauthenticated scenarios
and source nodes. F-13 now passes its HTTP answer assertion, including both scoped catch deliveries. The two exact
scheduler BUSY errors belong to the F-7 case; any other BUSY, source, message,
or scenario fails the final catch check. No product write is retried.

The two repository negative controls alter only scratch flow copies. They
must fail the late-handler error check and the catch-delivery check,
respectively; byte-integrity or HTTP failures alone do not satisfy them.
The release procedure requires strict hosted success on the release SHA
before tag creation and the tag's own success before image builds.
