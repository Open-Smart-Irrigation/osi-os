# Conditional irrigation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task by task. Track work with the checkboxes below.

Goal: add VWC and scheduled condition checks, with Wet/Moist/Dry SWT preferences
and explanations in accessible help overlays.

Architecture: one typed zone policy attaches to selected weekly valve schedules.
The gateway decides each occurrence and reserves its command before dispatch.
Conversion uses the existing empty-program push and ACK ledger; its physical
uncertainty remains explicit. There is no operator-attested ownership subsystem.

Tech stack: CommonJS modules, Node-RED, SQLite ordered migrations, React/TypeScript,
ChirpStack gRPC; Java/Spring and PostgreSQL/Flyway in the paired server repository.

Spec: [revised design](../specs/2026-10-13-conditional-irrigation-design.md).
Review: [finding dispositions and evidence limits](2026-10-13-conditional-irrigation-review.md).

Revised 2026-10-20. Tasks0–6, Task7a and the Task7b1 core checkpoint are accepted; Task7b2 is next.
Checked implementation items below refer to local software evidence, not live
deployment or hardware qualification. Acceptance evidence is in the
[execution report](2026-10-13-conditional-irrigation-execution-report.md). Slice A is independent. B installs inactive support; C exposes activation
only after its gates. No production connection or deployment is included.

## Global constraints

- Wet=20, Moist=30, Dry=50 kPa; preserve Custom exactly, including 29.9.
- “Recommended” is inside Moist's help overlay only. No extra permanent helper text.
- Check at the selected time; never latch a threshold crossing or replay missed runs.
- Every selected probe supplies evidence; VWC zero is valid and has its own unit.
- Local-only DENDRO evidence, fixed/proportional modes; maximum effective run 240 minutes.
- Policy timezone is authoritative; mismatched schedule timezones are rejected explicitly.
- Conditional conversion uses normal empty-plan pushes; all required ACKs gate dispatch.
- New shared valve exclusion changes conflicting manual opens to valve_busy.
- New schema and trigger swaps are additive migrations; sync-init-fn stays frozen.
- Both runtime profiles match. Preserve user edits and all unconverted legacy settings.
- Edge is canonical; REST carries cloud commands; new events require peer support.

## Review focus

1. Delayed ACKs can match the wrong clear generation. Task 5 tests the software gate
   and incident detection without claiming physical proof.
2. A flush can race a queued open. Task 4 retains ambiguous reservations and never
   blindly re-enqueues; all transport outputs and cancellation fallbacks participate.
3. A reboot with yesterday's clock must send nothing. Task 3 tests boot-scoped trust,
   timestamp normalization and calendar identity.
4. Old clients can overwrite a condition or miss disable-all. Tasks 6–7 test omission,
   explicit disable and permanently rejected unknown events.
5. Slice A must stand alone. Task 1 tests decimal preservation, metric tabs, drawer
   edits and help semantics before adding any policy API.

## Baseline and execution layout

Start implementation from isolated checkouts of fetched origin mains. Do not run
this plan directly on the stale local mains or copy their dirty files. The inspected
edge is `f130073205aa26abaa5d71097b354df39e9fe753`; server is
`113696c1bcdb27747a8fe62c1158dcdf0168695f`. Re-fetch, record actual bases, and review
a diff from these pins before execution. Carry these documents into the new checkout.

Use these shell path abbreviations in the edge checkout:

```bash
IRRIGATION_RUNTIME=conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
IRRIGATION_MODULE=$IRRIGATION_RUNTIME/osi-irrigation-policy
```

New module files: model.js (validation), evaluate.js (predicate/duration),
observations.js (authorized evidence), occurrences.js (calendar), clock.js (clock
trust), store.js (atomic policies/occurrences), worker.js (due decisions), api.js
(local routes), replication.js (sync), index.js/package.json (module entry).
Each has focused adjacent .test.js coverage. Valve conversion lives in the existing
osi-valve-control plan/push/store/ack/workers code; new dispatch.js owns shared
actuation reservations and device writer serialization. Do not create ownership.js.

## Task 0: Pin the current base and qualification boundary

- [x] Run `git fetch origin main --no-tags` in both repos. Record `git rev-parse origin/main`
  and `git rev-list --left-right --count HEAD...origin/main` in the execution report.
- [x] Recheck spec §2 against those refs, including flow output inventory, cloud
  controllers, capability builders, current helper/cancel/store behavior and migration
  ownership map. Amend the plan if interfaces changed, before editing product code.
- [x] List ordered edge migrations and server Flyway migrations. At the inspected
  edge head, use 0076 for the conditional schema and 0077 for its sync migration. Never
  overwrite 0068–0073 or change an applied checksum. Rehearse from 0073, not 0067.
- [x] Run untouched-base checks relevant to the slice: frontend typecheck/unit/build
  for A; schema, valve, sync and server gates listed in Task 10 for B/C. Record
  pre-existing failures with commands/exit codes rather than attributing them to this work.
- [x] Keep activation false for B. Record supported generations only after Task 9
  supplies clear-frame, expiry and delivery-latency evidence. No hardware is assumed
  available from the existence of this plan.

Commit sequence below follows Tasks 1–9, with the final verification/report commit
in Task 10. Stage only named changed files; each runtime commit includes its bcm2709
mirror. Server commits are separate and cross-reference the paired edge change.

## Task 1: Ship the independent SWT slice

Files: modify `web/react-gui/src/components/farming/ScheduleSection.tsx`,
`AdvancedScheduleDrawer.tsx`, their callers in `IrrigationZoneCard.tsx`, and
`valves/ValveControlPanel.tsx`. Extract its `ValveControlHelp` to
`shared/ValveControlHelp.tsx`; create `shared/SwtPreference.tsx`.
Extend `__tests__/AdvancedScheduleDrawer.test.tsx`,
`__tests__/ScheduleSection.normalize.test.ts` and add
`__tests__/SwtPreference.test.tsx`, `__tests__/ScheduleSection.persistence.test.tsx`
and `valves/__tests__/ValveLocales.test.ts`.
All these paths are under `web/react-gui/src/components/farming/`.
New locale keys go in `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/valves.json`.
Mirror behavior in the existing corresponding server frontend components.

Interfaces: `SwtPreference({value:number,onChange:(value:number)=>void})` emits an
exact preset value; `ValveControlHelp({label:string,children:ReactNode})` is the
shared help overlay. The drawer gets `onEditSchedule:()=>void` and delegates all
schedule edits to ScheduleSection; it no longer submits updateSchedule itself.

- [x] Add regression tests: load/save 29.9 unchanged; switch SWT→DENDRO→SWT and
  retain its draft; save duration through the drawer's delegated editor without
  overwriting metric/kPa; missing schedule never defaults to DENDRO/2 on save.
- [x] Add the help interaction test (imports and vi.fn setup in the test file):

```tsx
const onChange = vi.fn();
render(<SwtPreference value={50} onChange={onChange} />);
const help = screen.getByRole('button', { name: 'About Moist' });
expect(help).toHaveAttribute('aria-expanded', 'false');
const panel = document.getElementById(help.getAttribute('aria-controls')!);
expect(panel).not.toBeVisible();
fireEvent.click(help);
expect(panel).toBeVisible();
expect(panel).toHaveTextContent('Recommended.');
expect(screen.getByRole('radio', { name: /^Dry$/ })).toBeChecked();
expect(onChange).not.toHaveBeenCalled();
fireEvent.keyDown(document, { key: 'Escape' });
expect(panel).not.toBeVisible();
```

- [x] Run `npx vitest run src/components/farming/__tests__/SwtPreference.test.tsx src/components/farming/__tests__/ScheduleSection.persistence.test.tsx src/components/farming/__tests__/AdvancedScheduleDrawer.test.tsx`
  from web/react-gui. Confirm the initial failure is the missing control/current
  roundtrip bug, then implement the exact presets and separate per-metric drafts.
- [x] Remove Math.round/clamp from valid custom SWT serialization; validate finite
  range and preserve exact values. Use the same saved value in every editable route.
  Keep the old payload shape and backend contract; test the actual request, not only
  a pure mapper. If either legacy backend rounds, fix that serializer in this slice.
- [x] Extract the existing help implementation and use spec §3 disclosure semantics.
  Keep a hidden DOM target for aria-controls, use aria-expanded, labelled region,
  Escape/outside dismissal and a ≥44 px button. Test hover into the overlay,
  keyboard focus/activation, touch pinning, unmount cleanup and selection independence.
- [x] Replace the drawer's duplicate scheduling form with an edit action that opens
  the current shared editor. Preserve its separate agronomy settings. Test actual
  zone-card reachability and latest-data refresh, including session/account change.
- [x] Add full-depth key parity for valves.json across all seven locales. Test that
  Recommended occurs only inside Moist help. Reuse the same English text on cloud.
- [x] Run those component tests plus `npm run typecheck`, `npm run test:unit`,
  `npm run build` in web/react-gui and the paired frontend. Expected: exit 0.
  Commit `feat: add SWT preferences and preserve custom settings`.

## Task 2: Define conditions and trustworthy evidence

Files: create `$IRRIGATION_MODULE/{model,evaluate,observations}.js` and adjacent
tests. Read/extend `osi-dendro-analytics/index.js` and the `dendro-compute-fn`
wrapper for a policy-independent local analysis view. Reuse commissioned probe
metadata from osi-sdi12-normalize/commissioning; do not use broad device-type guesses.

Interfaces: `validatePolicyInput(input)`, `evaluateCondition(condition,evidence,dueAt,windowMinutes)`
returns `{status:'MET'|'NOT_MET'|'UNKNOWN',reason,value,unit,sources}`;
`durationFor(condition,baseMinutes,action)` returns integer minutes;
`readEvidence({db,policy,dueAt})` returns normalized samples or local analysis evidence.

- [x] Write boundary fixtures first. SWT >= and VWC <= include equality; reject
  null, strings, NaN/infinity and out-of-range values; VWC 0 remains MET for threshold22.
  Unknown source/channel and missing one of two selected sources yield UNKNOWN.

```js
const assert = require('node:assert/strict');
const { evaluateCondition } = require('./evaluate');
const due = '2026-10-16T06:00:00Z';
const source = {device_eui:'0016C001F1000002',channel:'vwc_1'};
const c = {kind:'VWC',threshold_percent:22,sources:[source]};
const evidence = value => ({sources:[{...source,eligible:true,
  samples:[{at:'2026-10-16T05:55:00Z',value}]}]});
assert.equal(evaluateCondition(c,evidence(0),due,60).status,'MET');
assert.equal(evaluateCondition(c,evidence(null),due,60).status,'UNKNOWN');
assert.equal(evaluateCondition(c,evidence(23),due,60).status,'NOT_MET');
```

- [x] Run `node --test "$IRRIGATION_MODULE/evaluate.test.js"`; expect missing
  implementation, then implement finite typed values, source allowlists and exact
  means. Bind query values; allowlisted channel identifiers are the only dynamic SQL.
- [x] Normalize SQLite UTC and ISO recorded_at before filtering/deduplication. Test
  both formats at exact lower/upper bounds, future/invalid values, duplicate timestamps
  and unequal sample counts. Samples existing at decision time are the evidence;
  later arrivals cannot change a decided occurrence. Observation window is1–1440,
  default 60; there is no observation_window_too_short cadence rule.
- [x] Implement local DENDRO evidence from saved analysis inputs before legacy
  schedule filtering. Do not rerun stateful daily analytics merely to read a decision.
  Capture raw evidence before filtering in the normal daily calculation. A cached
  row without it stays UNKNOWN until the next normal calculation; conversion never
  replays stateful analysis.
  Test applyDendroSchedulePolicy with enabled 1 versus 0, a cached downgrade before
  conversion, holds, below-threshold stress, no trees, unknown action and age 36 h.
- [x] Test maintain with passing stress (MET), maintain with failing stress (NOT_MET),
  suppression/recovery hold at severe stress (NOT_MET), and fixed/proportional duration.
  No aggressive mode and no action-only cloud fallback. The explicit predicate decides
  whether to water; an action alone cannot bypass it.
- [x] Run all three module test files and actual SQLite source-selection fixtures.
  Expected: pass, including real commissioned VWC channels and ineligible WATERMARK.
  Commit `feat: define typed irrigation conditions and local evidence`.

## Task 3: Add schema, clock trust and calendar validation

Files: create `database/migrations/ordered/0076__conditional_irrigation.sql`,
`$IRRIGATION_MODULE/{store,occurrences,clock}.js` and adjacent tests,
`scripts/test-conditional-irrigation-schema.js`,
`scripts/test-conditional-irrigation-clock.js`.
> **Owner decision 2026-10-24 (supersedes the NTP requirement for opens and policy activation):** gateway-originated opens (fixed schedules, manual, conditional and ONCE) no longer require an NTP synchronization since boot, and enabling a policy no longer requires it either. The boot-scoped marker stays as a display and diagnostics value. The only clock refusal left on these paths is a clock behind data the gateway already holds (the last decided dueAt or the newest relevant sample), reported as `clock_untrusted_lower_bound`.

Create runtime payload `files/etc/hotplug.d/ntp/70-osi-irrigation-clock` under both
profiles. Existing OpenWrt `openwrt/package/utils/busybox/files/sysntpd` already
passes `-S ntpd-hotplug`, which forwards NTP events; do not modify upstream BusyBox.

Interfaces: `occurrencesBetween(schedule,from,to)` returns stable local date/time
and dueAt; `clockStatus({bootId,marker,uptime,now,lastDue,latestSample})` returns
trusted/reason; `validateScheduleSet(policy,schedules)` rejects with422 and affected
IDs; store claims use the single composite primary key in spec §5.

- [x] Write a migration rehearsal from origin head 0073 with legacy schedules,
  device/history data and seeded sync rows. Add schema exactly as spec §8 defines:
  policy, occurrences, runtime singleton; plain nullable TEXT additions on schedules,
  valve_settings and sync_link_state (including local link_attempt_json for the
  pending link fence, separate from background capability requests); add local transport_json TEXT to valve_schedule_pushes
  and valve_actuation_expectations. New ADD COLUMN clauses have no REFERENCES or
  CHECK that breaks compatible-column reapplication. Validate structure in the module.
- [x] Keep one occurrence PK `(schedule_uuid,local_date,local_time)` and unique
  nullable command_id; index device/due_at. Store queue IDs, evidence, expiry and
  reservation bounds. No duplicate occurrence_key PK or ownership/peer table.
- [x] Rehearse fresh install, upgrade, same-column compatibility and customer-branch
  renumbering; verify history counts, FK checks and seed fingerprints. No legacy data
  backfill is needed. Run schema test before/after migration implementation.
- [x] Implement local-time resolution with Intl offset candidates and roundtrip
  validation, using first fold instant and skipping gaps. Pin Zurich 2026-03-29 02:30
  nonexistent and 2026-10-25 02:30 first=00:30Z. Versions never change occurrence identity.
- [x] Implement the NTP hook: accept only ACTION=stratum with lowercase stratum
  strictly parsed as decimal 1–15. Atomically write `/var/run/osi-irrigation-clock.json`
  containing boot ID, epoch, uptime and stratum. Preserve the last-good marker on
  unsync, step, periodic, invalid fields or unknown actions; none creates trust.
  BusyBox unsync means missed replies. Runtime progression checks detect clock jumps.
  Test ignored events preserve marker bytes and cannot create one; starting ntpd
  is not synchronization.
  Verify real event/env behavior on the shipped BusyBox during Task 9 before enabling.
- [x] Read boot ID and uptime from procfs in clock.js. Require same boot marker,
  wall-clock elapsed versus uptime elapsed within 5 seconds, no backwards movement,
  and spec lower bounds. Test stale marker, stale clock reboot, unsynced NTP,
  backward/manual jumps, resync and same-boot offline operation. Missing hook/marker
  is clock_untrusted, not an assumed success.
- [x] Implement ten-minute inclusive decision grace; later slots SKIPPED/missed_start.
  Bound missed audit to last trusted tick/max 24 h. On restoring trust, respect effective_from
  and existing decisions; never backfill commands for old starts.
- [x] Add delivery settings (per-valve configured interval default 10, range 1–60). Compute
  L=10+2I+1 minutes. Validate whole weekly sets with maximum 1.5× proportional duration,
  delivery allowance, gap, local-day budget and timezone agreement. Test two 180-minute
  runs at 240-minute budget,30min pulse separation with 60-minute gap, >240 effective duration,
  mismatched timezone, cross-midnight/DST, and same-time duplicate schedules.
- [x] Run module clock/calendar/store tests and both new scripts; expected pass.
  Commit `feat: persist policy occurrences and validate scheduling time`.

## Task 4: Add shared dispatch reservations, expiry and flush recovery

Files: create `osi-valve-control/dispatch.js`, `dispatch.test.js`,
`scripts/test-conditional-irrigation-transport.js`,
`scripts/test-conditional-irrigation-writer-guards.js`.
Modify `osi-chirpstack-helper/index.js`, `osi-valve-control/{cancel,push,store,unclaim,cloud-commands}.js`,
osi-command-ledger integration and flow expectation/encoder/transport wrappers.

Interfaces: `reserveValveCommand({db,command,now})` returns a stable expectation or
existing result; `withValveWriter(deviceEui,fn)` serializes transport mutations;
`flushValveQueue({db,deviceEui,reason,transport})` persists intent and reconciles
queue IDs; `enqueueDownlink({devEui,fPort,data,confirmed,expiresAt})` sets protobuf expiry.

- [x] Add two-connection SQLite tests for simultaneous schedules/manual opens, same
  command replay, and failure after claim. Before implementation expect duplicate
  insertion or conflicting acceptance; after implementation expect one reservation
  and a visible valve_busy for a different command.
- [x] Extract the inline write-strega-expectation INSERT to the shared guard. Preserve
  timed duration, volume estimate and reconciliation fields. Integrate command ledger
  result replay; matching reserved command can advance once, not authorize another send.
  Use BEGIN IMMEDIATE; reread rows instead of relying on facade run() change counts.
- [x] Persist RESERVED→ATTEMPTED before enqueue. A crash after ATTEMPTED is UNKNOWN;
  never retry by assuming the network request failed. Reserve exclusion through the
  physical effect end and full possible watering minutes per affected day (Task 4c
  separates the physical deadline from queue expiry). Reconcile observation
  once by expectation/command ID; no double counting.
  Capture the minimum gap and exact exclusion_end_at in immutable decision evidence.
  Join occurrence/expectation before exclusion and budget checks. At the captured
  horizon, qualified bounded commands without unresolved open evidence stop
  excluding while SENT/UNKNOWN and daily charge remain, under Task 4c. Malformed
  bounds, open-only observations and unqualified timing still block. Test exact boundary, policy edits and observation refinement.
- [x] Add expiry using the installed google-protobuf Timestamp binding:

```js
function attachExpiry(item, expiresAt, nowMs) {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms) || ms <= nowMs) {
    throw Object.assign(new Error('Command expired'), {code:'command_expired'});
  }
  const { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb');
  item.setExpiresAt(Timestamp.fromDate(new Date(ms)));
}
```

- [x] Route every STREGA queue write through awaited gRPC inside withValveWriter,
  including plan/status/clock, ordinary timed opens, cancellation rebuilds and
  conditional opens. Keep non-STREGA shared MQTT output intact; no STREGA payload
  may reach an MQTT sink. Task 4c extends expiry to ordinary/ONCE and CLOSE. Persist transport
  intent before enqueue and phase/queue ID in local transport_json before releasing
  the gate; uncertain enqueue blocks conditional conversion/dispatch until reconciled.
  Never replay an ambiguous write to obtain an acknowledgement. Surface ordinary
  command transport failures to local/cloud callers. Test due+10min inclusive decision,
  expiresAt equality refusing enqueue, strict server expiry and exactly one output.
  Delay enqueue completion and prove a concurrent flush cannot overtake it.
- [x] Inventory every actuator path in both flow profiles. Assert guards for input
  link-in "from scheduler/manual", expectation writer, encoder "Build STREGA downlink +
  emit log ctx", simulation link-in "link in 1", MQTT outputs "MQTT to ChirpStack",
  `valve-push-mqtt-out`, "Valve plan downlinks -> ChirpStack (cloud cmd)",
  `delete-device-valve-mqtt-out`, plus new gRPC output. Simulation
  cannot bypass physical-open reservation. Include clock/profile/status/housekeeping
  and all helper FlushQueue callers in the test's inventory.
- [x] Serialize flushes with enqueue. Persist all affected STREGA queue IDs and
  unresolved enqueue intents before flushing, with their occurrence/expectation/push
  owner or durable opaque owner in conditional_control_json. Reconcile every owner
  after success/crash; never project conditional occurrence states onto ordinary
  push ACKs. Preserve payload/FPort/original expiry for opaque rebuild entries,
  rebuilding only proven-unsent, authorized, non-superseded items. Unknown opaque
  entries stay durable and block conditional operation. For conditional opens,
  successful proven non-delivery becomes EXPIRED/command_expired, ambiguity remains
  UNKNOWN and reserved. No automatic re-enqueue. Test cancel's queue-rebuild path and
  whole-flush fallback, unclaim, failed flush, crash after flush before DB update and
  send-versus-flush race. Superseded plan/status rows must never be restored.
- [x] Pin ChirpStack's actual flush evidence: accepted queue ID plus a successful
  flush remains UNKNOWN for nonpending, pending and absent snapshots. None may
  release a reservation or authorize rebuild/resend. Include a radio fake that
  copies the payload before the database flush and transmits afterward. Only a
  durable never-attempted intent or proven pre-acceptance failure can expire locally.
  Cancellation reports formerly rebuilt plan/configuration entries as uncertain;
  update local/cloud result tests to this explicit behavior change.
- [x] Test manual conflict error reaches local UI and cloud command result. Timed
  duration/closing and cancellation remain; busy rejection and uncertain queue
  entries are explicit.
- [x] Preserve advanced TIMED_ACTION OPEN in seconds, minutes or hours, with an
  integer amount from 1 to 255. Bind its exact persisted duration to the encoded
  frame; do not round seconds to minutes or apply the ordinary minute-form limit
  to hours. Test the actual encoder with subminute and hours commands.
- [x] Run dispatch/helper tests and the two new scripts; expected pass. Commit
  `feat: serialize valve dispatch and expire conditional commands`.


### Task 4c: Separate transport audit from bounded command effects

Task 4a core and 4b writer integration must pass their scoped reviews first. Execute
4c in two bounded units, each with a fresh Luna implementer and Sol review. Task 5
starts only after both pass. The specification §7.1 controls every rule below.

**4c1: effect classification, bounds and conflict/accounting core.** Add small effect
and qualification helpers in osi-valve-control, defaulting production qualification
false. Persist exact payload/provenance and immutable timing in existing transport
JSON; use occurrence decision evidence for matching bounds, without a migration.
Implement the allowlist and conflict matrix, scoped CLOSE quiescence, qualified
self-closing release and conservative ordinary-command accounting. Update model
bounds and reservation checks to distinguish actual queue expiry from physical end.
Use policy interval/default 10, manual reservation anchor, ONCE fire_at anchor and
L=10+2I+1. Keep encoded seconds exact; preserve all existing conditional limits.
Qualification and runtime clock checks are internal dependencies, not caller flags.
No new configuration ACK parser or physical-authority attestation.

Tests must fail before changes and prove:

- interval/default/source and manual/ONCE anchors; next occurrence/gap rejects a
  shortened full allowance; late ONCE claim does not extend the original deadline;
- caller-supplied or later-mutated bytes, flags or metadata cannot change the
  captured effect, bound or qualification; finite release requires a captured
  qualified identity and current provider validation of it; revoked, mismatched or
  originally unqualified records cannot gain finite release;
- qualified ACCEPTED/UNKNOWN timed opens block before and release exactly at the
  captured horizon with unchanged audit and full daily charge; open-only/current OPEN
  remains blocking; close-only/absent observations can release;
- runtime clock distrust on reboot, jumps and persistence failure blocks time release;
  future deadlines are not past-evidence lower bounds; resync preserves timestamps;
- fresh CLOSED quiesces only a permanent CLOSE owner, including repeated CLOSED with
  explicit uncertainty; CLOSE captures duration and gap zero and releases exactly
  at its qualified physical deadline; prior timed-close/partial/return-open/opaque
  hazards remain;
- reporting/magnet/clock commands do not block solely on missing ACK, while plan
  authority remains governed by current clear ACKs; malformed/captured/confirmed/
  encrypted items never receive finite-release treatment;
- restart and timezone/accounting reconstruction retain exact immutable bounds,
  duration, effect identity and uncertainty; no double counting.

**4c2: bind every live writer and observation path.** Consume reviewed 4c1 interfaces.
Persist snapshot before I/O and bind actual encoded frames, qualification context,
clock checks and gRPC expiry for local/cloud/manual/legacy/simulation/ONCE/conditional
writers and permanent CLOSE. Acquire the shared writer before conflict/release and
reservation decisions; commit the snapshot before I/O, then recheck clock, current
qualification and expiry immediately before the attempt in that same gate. Existing
reentrant helpers may reuse its owner, never acquire another gate. No transaction
while waiting for the gate or RPC. Commands, request JSON and transport objects
cannot supply trusted:true, qualification metadata or their own snapshot. Connect
existing fresh CLOSED telemetry to only the CLOSE owner; Task 5 owns unexplained-open
incident production. The default provider remains
false and must be reused by Task 6 API/worker.

Apply §7.1's explicit send-permission matrix. All timed OPENs, including manual,
need a trusted clock before reservation and at the sole claim. Keep ordinary
unqualified OPEN available once the clock is trusted. New exact permanent CLOSE
can use UNBOUNDED_SAFE_CLOSE_V1 while clock trust is absent: no invented wall bounds,
no existing expiry removed, no finite release or later retroqualification. Validate
its exact frame and internal boot/uptime receipts. Test every invalid/null variant,
explicit request expiry, bounded replay after clock loss, and current qualification
revocation. Fresh CLOSED settlement must satisfy the per-owner proof in §7.1;
one event can settle multiple independently eligible CLOSE owners, never another
effect class. Report the manual-open waiting-for-clock cost after reboot.

Run actual builder/writer/encoder and ONCE wrappers with injected qualified fixtures,
assert immutable expiry at the gRPC seam, near-grace claims, replay/restart/flush
uncertainty, both timestamp formats and production-unqualified behavior. Include
no-endpoint one-minute runs, post-horizon OPEN, failed qualification identity and
CLOSE followed by OPEN with an older hazardous owner. Rerun paired valve/policy/helper
suites and touched flow/inventory gates. Report public APIs for Task 5/6 and exact
remaining hardware registry/identity limitations. No benchmark result is inferred.

The standalone flow-size ratchet is also required here. Task4b enlarged ten existing
writer/route wrappers beyond the pinned base; Task4c1 does not change those flows.
Move command behavior into the valve module while integrating the shared composition,
leaving thin Node-RED wrappers and preserving actual-wrapper regression coverage.
Do not raise allowances or change the base to hide the growth. Run
verify-flows-size-ratchet.js explicitly with the pinned base; verify-sync-flow.js
does not invoke it. The exact affected nodes and measurements are in the execution
report and Task4c2 brief.

## Task 5: Convert through the normal plan path and detect unexpected watering

Files: modify `osi-valve-control/{plan,push,store,ack,workers,api,cloud-commands,runtime,unclaim}.js`
and their tests; use conditional_control_json in valve_settings for local readiness.
Create `scripts/test-conditional-irrigation-conversion.js`.

Interfaces: extend `compileWindows` to exclude condition_policy_uuid rows;
`compileAndQueue` records a desired revision/required push-ID set;
`conditionalReadiness(db,deviceEui)` derives pending/ready/blocked from that set;
`recordUnexpectedOpen` persists a sticky incident with actuation accounting.

Expose a Tx-only clear-revision preparer for Task 6's atomic multi-valve edit, and a
per-device post-commit sender that rechecks the exact revision, membership and live
conflicts under its writer. Preparation performs no gate acquisition or external I/O.

- [x] Test conversion compiles empty on-valve programs: Gen1 seven all-FF weekday
  frames, Gen2 empty daymask. Test fixed rows remain unchanged and mixed enabled
  modes are rejected. The current compiler has no conditional exclusion yet.
- [x] Commit desired revision and supersede old QUEUED plan/status rows before flush.
  Flush errors abort sending and leave pending/failed state visible. Queue complete
  clear frames and persist exact required push IDs. Successful ACKs for every current
  required push permit software readiness; partial/negative ACKs do not.
- [x] Test superseded older known plan/status rows with UNKNOWN transport. They
  remain blockers until the current revision's complete clear ACK set; afterward
  retain UNKNOWN audit history while retiring only those superseded push blockers.
  Capture predecessor_push_ids including unresolved FAILED known plan/status rows;
  retain their failure state and release only listed predecessors after all clears.
  Never call that non-delivery proof or restore them. No other owner is settled by
  those clear ACKs; Task 4c governs its exclusion, and later unexpected watering still
  raises the incident.
- [x] Test stale resume rows, reorder/restart/retry, tile/cloud ACTIVE and resend,
  profile reconciliation, two simultaneous editors and fixed conversion in reverse.
  Known old push IDs cannot satisfy a new revision; an indistinguishable same-port
  late ACK remains the documented protocol risk, not a passing proof of physical clear.
- [x] Match conditional ACKs by current required IDs and ordinary ACKs by the newest
  eligible same-command row. Both require durable attempt evidence and parsed
  receivedAt >= attempted_at. Test response-loss UNKNOWN without a queue ID, negative
  and malformed status, both UTC formats, and raw Gen2 hexadecimal battery prefixes.
- [x] Apply §6's command-specific ACK rules. Gen1 ordinary weekday/clock 00 remains
  a named provisional assumption; it cannot satisfy conditional readiness. Gen1
  status semantics and conditional success remain unverified without an internal
  generation/firmware rule. Test injected verified rules, mismatched identity,
  ordinary clock/status during conversion, and rejection of caller overrides.
  Exercise and report the default unverified ordinary Gen1 scheduler-status path,
  including pending and stale-failure states; its ACK compatibility is not preserved.
- [x] Extend observations beyond compiled windows. During conditional mode, schedule-
  attributed or unexplained OPEN without a matching authorized expectation blocks
  dispatch and counts once. Test a stale fixed run after its row was converted,
  an authorized manual run, delayed telemetry, repeated OPEN reports and unknown duration.
- [x] Move stateful telemetry attribution into a Tx-only module helper under the
  valve writer. Persist an explicit-report watermark and physical-run link in existing
  control JSON; do not use devices.updated_at. Keep repeated CLOSED delivery to the
  separate exact-CLOSE observer after commit. Remove reconciliation's state broadcast
  to owners; recover only linked endpoints and immutable-horizon timeouts.
- [x] Include commandless physical runs in shared daily accounting, deduplicated by
  expectation ID. Report-time pairs do not prove duration. A linked fresh CLOSED
  supplies a conservative upper end; report-only lower start stays unbounded unless
  independently proven. Expose possible-interval metadata so Task 6 blocks precisely
  the candidate local days that can intersect an unknown run. Incident clearance
  preserves accounting history and never invents minutes. Test midnight, timezone
  edits, missing end and a finitely ended previous-day run.
- [x] Retry clears the sticky incident only after observed/reconciled end and all new
  clear ACKs. Always conversion disables gateway dispatch before ordinary fixed push;
  no release projection/attestation endpoints. Deleting last row sends empty plan.
- [x] Run valve module tests plus conversion/writer-guard scripts; expected pass.
  Commit `feat: convert schedules using acknowledged empty valve programs`.

Execute the observation part of Task 5 in three reviewed units. In 5b1, implement
observation/run-link/incident/accounting modules and their writer → real-clock →
transaction composition. Keep any endpoint-writing Tx helper private or require
module-created proof; do not expose a caller-trusted timestamp interface. Test
future reports, untrusted boot, resync and conservative unknown-run accounting.
In 5b2, wire real ingest, ACK incident finalization and the observation/reconciliation
ticks, runtime, recent-command and journal projections, then prove behavior through
the actual wrappers. In 5b3, omit internal report-only expectation rows from v1
archive/bootstrap/force and durable history. Apply the same exclusion to fresh and
dirty batches, manifests, counts and hashes; finish local-only dirty keys without
quarantine or perpetual retry. Matching irrigation_events still sync with null
duration. Ordinary command-backed history is unchanged. Task5b is incomplete until
all three units pass independent review. Each uses a fresh Luna implementer and Sol
reviewer. No intermediate unit qualifies deployment.

The history slice also fixes the existing valve cursor representation mismatch:
the server returns a full `VALVE_ACTUATION|gateway|id` ACK while the edge snapshot
and SQL cursor use the raw expectation ID. Normalize loaded and incoming valve
ACK cursors against the exact current gateway prefix. Keep wire history keys,
hashes and dedupe identities unchanged. Mixed multi-batch tests must prove both
digit-leading and alphabetic-leading IDs progress without skips or replays. Other
history tables remain outside this repair.

## Task 6: Wire atomic policy edits and due evaluation

Execute as separately reviewed slices:6a policy API,6b1 due worker,6b2a lifecycle
clear transport/invalidation, and6b2b atomic lifecycle service/adapters.6b2a also
fences local/cloud STREGA claim, schedule and generation mutations against stale
clear sends and routes explicit plan resend to lifecycle recovery.6b2b consumes
those accepted seams across every legacy/deletion/movement adapter. Task6 is
complete only when all slices pass; none is an intermediate deployment.

Enabled policy saves require the durable clock gate after writer acquisition and
one internal trusted activation instant. Paused drafts create no new boundary;
pause preserves existing boundaries without requiring clock trust. Enable stamps
the policy and all live enabled conditional rows. Due evaluation requires dueAt to
be strictly later than both policy and schedule effective_from values. Cover the
untrusted-write/recovered-clock case that would otherwise admit a pre-edit slot.

Files: create `$IRRIGATION_MODULE/{worker,api,index}.js`, package.json and tests,
`scripts/test-conditional-irrigation-flow.js`. Modify `flows.json` wrappers,
`feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`, `deploy.sh` and
module/image delivery registrations found by the registration verifiers.

Interfaces: GET/PUT/pause/retry-valve/decisions routes from spec §8;
`applyPolicyEdit({db,actor,request,now})` shared by local/cloud;
`runDue({db,clock,now,transport})` handles one 60-second tick.

- [x] Refresh deploy.sh COMMAND_LEDGER_INDEX_SHA256 to the final ledger candidate
  while wiring module delivery. Task 4b changed the ledger and invalidated this pin;
  it is feature-stack debt, not an origin failure. Preserve paired watermark
  dependency activation/rollback and run
  `node --test scripts/deploy-command-ledger-dependency.test.js`.
- [x] Consume the reviewed Task 4c2 reservation/writer interface and internal
  qualification provider in both API and worker. Provider false keeps conditional
  activation unavailable. Request JSON and runDue arguments cannot supply
  qualification metadata or trusted:true. Use captured queue expiry separately
  from the physical-start/effect-end bounds; preserve the final in-gate checks.
- [x] Write API tests for expected-version conflicts and rollback with no partial
  schedule edits. Include invalid source/target scope, duplicate IDs, unknown keys,
  timezone mismatch, feasible schedules, no targets, unsupported peer/runtime and
  mixed fixed/conditional rows. Assert 422 includes the settings that need changing.
- [x] Discover all affected current/requested valve EUIs, including removals,
  reassignment, legacy disabling and prepared clear revisions. Acquire the canonical
  sorted unique set before opening a transaction. Add a narrow withValveWriters
  helper with full held-set reentrancy and immediate rejection of unheld expansion;
  the current single-EUI context self-deadlocks on A -> B -> A.
- [x] Reread versions and membership in one short transaction. If a newly affected
  EUI is not held, roll back, release all gates and rediscover for a bounded retry.
  Persist policy/schedules, legacy disabling and Task 5's prepared revisions together.
  Stale/deleted/busy targets roll back the entire edit. Release all gates after commit;
  per-valve senders reacquire one gate and recheck revision, membership and conflicts
  before flush/enqueue. Use Task 5's Tx-only preparation and sender interfaces.
- [x] Test reversed editor order, held-set reentrancy, expansion refusal, newly
  discovered lower-order membership, manual commands racing save/send, full rollback
  and a superseded post-commit sender. Assert no transaction during gate/RPC waits.
  Copy current scoped-access/auth and facade close patterns. Pause handles pending
  opens through Task 4.
- [x] Add one 60 s inject and thin module wrappers. Query legacy "Build zones query (enabled schedules)"
  excludes any live policy including paused policies. Preserve the existing unconverted
  06:00 process-time path and clock-jump guard.
- [x] Gate due checks on clock, current configuration, data and readiness; claim once
  transactionally, reserve limits, then send using Task 4. Block active/unresolved
  actuation, missing sources, unknown analysis, skip-today and scope loss. Test a
  changed revision between evidence read and claim invalidates the attempt.
- [x] Legacy UPSERT_SCHEDULE/UPDATE_SCHEDULE explicit disabled writes pause managed
  policies; other legacy mutations conflict. Both local/cloud disable-all enumerate
  policies even with disabled/missing legacy rows. Test queued stale legacy commands.
- [x] Cover device/zone deletion, EUI or zone UUID changes and reassignment: block
  future dispatch, reconcile pending commands, retire references, preserve history.
- [x] Include NTP hook installation in the software-update path as well as firmware images.
  On first hook activation request fresh synchronization through sysntpd; stable
  ntpd does not repeat stratum callbacks. Preserve an existing marker, never create
  one synthetically, and retain a retry path if service activation fails. Cover
  disabled NTP explicitly and include the hook in offline deploy bundles.
- [x] Script-edit flows only after a byte-identical no-op roundtrip. Add module load
  failure/unavailable tests and registration/deploy coverage. Mirror touched files.
- [x] Run module API/worker tests, new flow test, `node scripts/test-flows-wiring.js`,
  helper/module coverage checks. Commit `feat: expose and evaluate scheduled irrigation policies`.

## Task 7: Add cloud compatibility and guarded replication

Task7a passed independent verification and Sol review at edge `bf0ee2d0e` and
server `90766a389`. Task7b1 passed core/schema review and independent checks at
edge `72a4488f5` and server `8c3dc8041`. Task7b2 owns the remaining runtime adapters
and the inherited silent-catch gate repair.

Execution uses three checkpoints: 7a cloud contracts and mirrors; 7b1 edge replication
core and migration; 7b2 shipped link, delivery and command adapters. Each has a Luna
implementer and Sol review. 7b1 is not a deployment boundary and advertises no new
capability. Task7b is accepted only after 7b2 passes the combined service, schema and
actual-flow gates. All requirements below remain in scope across these checkpoints.

Edge files: new `$IRRIGATION_MODULE/replication.js` and tests,
`database/migrations/ordered/0077__conditional_irrigation_sync.sql`,
`docs/contracts/sync-schema/conditional-irrigation-v1.schema.json`,
`scripts/test-conditional-irrigation-contract.js`.
Modify contract resource/event/command schemas, canonicalization-v2.md, effect-keys.md,
README; bootstrap/force-sync/link/pending-command adapters; sync verifiers;
`scripts/verify-runtime-schema-parity.js`.

Server files under `backend/src/main/java/org/osi/server/`: create
`irrigation/IrrigationPolicy.java`, `IrrigationPolicyRepository.java`,
`IrrigationPolicyController.java`, `IrrigationPolicyCommandService.java`, and
`sync/IrrigationPolicyApplier.java`. Modify `valve/ValveSchedule.java`,
`ValveScheduleResponse.java`, `ValveController.java`, **`ValveCommandController.java`**,
`sync/{ValveScheduleApplier,EdgeSyncController,EdgeSyncService,SyncPayloadCanonicalizer,SyncRowOwnership,SyncEventTxExecutor}.java`,
`user/AuthController.java`, `zonemutation/IrrigationZoneController.java` and event
registrations. Add matching irrigation/sync tests and a new free Flyway version
under `backend/src/main/resources/db/migration/` after checking version ordering.
Update `scripts/verify-edge-sync-contract-vendor.sh` and the vendored contract files.

Interfaces: IRRIGATION_POLICY_UPSERTED; commands UPSERT_IRRIGATION_POLICY,
PAUSE_IRRIGATION_POLICY, RETRY_IRRIGATION_VALVE; supportedSyncCapabilities in link
and bootstrap; explicit runtime summaries distinct from editable resources.

- [ ] Write shared golden fixtures for 29.9 kPa, 0% VWC, local DENDRO, delivery settings,
  observation windows 60/180, tombstone, out-of-order policy/schedule and scope rejection.
  Canonicalize typed JSON structurally, sorted EUIs/channels and delivery entries;
  equal-version different payload is a conflict.
- [ ] Implement additive trigger swap migration 0077. Register all policy triggers
  in MIGRATION_OWNED_TRIGGERS; change both valve-schedule trigger owners from 0024
  to 0077. Do not change valve-settings sync payload for local conditional_control_json.
  Use the current migration runner; no destructive backup/FK fence for trigger swaps.
- [ ] Add edge capabilities in sync-bootstrap-build, al-link-build-req and
  sync-force-build. Add server support responses in AuthController and
  **EdgeSyncController**, which owns bootstrap response construction.
- [ ] Add `POST /auth/local-sync/conditional-irrigation-v1` in AuthController.
  Check the shared server capability provider before delegating to LocalSyncService;
  unsupported returns503 CONDITIONAL_IRRIGATION_UNSUPPORTED. Edge selects this route
  for any live policy, including paused, and never falls back after404/unsupported.
  No-policy links keep `/auth/local-sync`. Persist route/nonce and policy snapshot
  atomically; reject concurrent policy mutations with link_in_progress until the
  attempt terminates. Reconcile interrupted attempts or invalidate their nonce on
  a fresh attempt; no DB transaction spans network IO. Test unsupported registration
  creates no user/claim/credential/installation-link/link record, supported delegation
  occurs once, missing support on2xx prevents local finalization, and concurrent
  policy creation cannot cross a legacy link attempt. Local installation-identity
  maintenance is permitted before support verification.
- [ ] Cache peer capabilities on sync_link_state with captured identity/context and
  request nonce. Initialize linked old rows without inventing support. Clear on
  unlink/relink/server or identity change. Test delayed response after relink to
  the same account, absent capability field, concurrent requests and token refresh.
- [ ] Gate outbox production, delivery and bootstrap/force snapshots on peer support.
  New-edge/old-server test uses unknown-op permanent rejection semantics and asserts
  no unsupported event was sent. Do not strip a condition to fit an older schema.
- [ ] Add guarded `POST /api/v1/sync/edge/events/conditional-irrigation-v1` and
  `POST /api/v1/sync/edge/bootstrap/conditional-irrigation-v1`. Check the shared
  capability provider before apply, migration or token rotation; delegate once to
  existing authenticated handlers. Preserve protocol-2 limits and per-event results.
  Route ordinary outbox/bootstrap and both force-sync phases here when the captured
  peer context permits conditional replication. Never fall back to legacy routes.
  Test cached support followed by404/503 at the same URL: outbox rows stay pending,
  bootstrap cursors/tokens/success timestamps stay unchanged, and peer support is
  invalidated. Test absent support causes zero application of a mixed policy/schedule
  batch or bootstrap. Supported delegation runs once; unknown/unsupported peers
  receive only legacy payloads omitting whole conditional resources.
- [ ] Implement server mirror/apply and pending commands. Preserve new schedule
  columns when incoming key is absent; explicit null requires authorized explicit
  conversion. Out-of-order references stay unresolved and noneditable. Edge validates
  again; server command dedupe and edge version checks prevent duplicate mutation.
- [ ] Guard ValveCommandController schedule CRUD, resend, scheduler status and manual
  open. Disable-all creates policy pauses for managed zones and legacy disabled writes
  for others. Test both new route and old UPSERT_SCHEDULE disabled fallback.
- [ ] Mirror new contract file and add it to vendor script's strict list. Keep existing
  staged commands/events exceptions; run with EDGE_CONTRACT_ROOT pointing at the
  paired edge checkout. Deploy order in release notes: cloud readers/guards, then edge.
- [ ] Run contract script, `node scripts/test-contract-schemas.js`,
  `node scripts/verify-sync-contract.js`, `node scripts/verify-sync-op-parity.js`,
  `node scripts/verify-communication-contract.js`; server targeted IrrigationPolicy,
  ValveSchedule and canonicalizer tests; `sh scripts/verify-flyway-ordering.sh` and
  vendor script. Expected exit 0. Commit paired `feat: sync conditional irrigation policies`.

### Task7 runtime contract completion

Implement the three read-only projections and public route/view boundary in design
§9, alongside the policy resource. Task7a owns schemas and fixtures, the cloud
mirrors/appliers, revision conflict handling, pending views and guarded receivers.
Task7b owns migration0077's projection cache, consistent projection/outbox transaction,
post-commit notification, 60-second reconciliation and guarded snapshot convergence.
Existing actuator source transactions remain unchanged. Test a crash between source
commit and notification, out-of-order and conflicting equal revisions, clock rollback,
retirement/reassignment, stale cached-payload rejection, unchanged-scan coalescing,
unknown peers and the evidence allowlist. Do not extend
`VALVE_RUNTIME_CHANGED` or copy raw conditional-control/transport state into cloud.

## Task 8: Add the policy form and conversion preview

Files: create `web/react-gui/src/components/farming/IrrigationPolicyEditor.tsx`,
`web/react-gui/src/utils/irrigationPolicy.ts` and component tests. Modify
ScheduleSection, AdvancedScheduleDrawer, IrrigationZoneCard,
valves/ValveScheduleDialog, ValveScheduleOverview, services/api.ts and types/farming.ts.
Use Task 1's shared help and all seven valves.json locales. Mirror behavior in the
server frontend; its service writes pending commands, not canonical mirrors.

Interfaces: `IrrigationPolicyEditor({zoneId,onSaved})`; service
`irrigationPolicyAPI.get/save/pause/retryValve/decisions`; normalized PolicyView
contains editable policy and separate per-valve update/runtime state.

- [ ] Test real entry points before component implementation: no immediate option,
  daily time when no selected schedules, VWC no default/zero preserved, explicit
  channels/targets, Custom SWT preserved and policy version conflicts visible.
- [ ] Implement one timing/duration editor using existing weekday widgets. Surface
  observation window, valve interval, minimum gap and daily budget under Advanced
  with help overlays. No duplicate writable duration in the drawer.
- [ ] Preview old cron in actual timezone and new policy times. Show changed DENDRO
  behavior/local evidence, fixed/proportional choice and incompatible schedule rows.
  A 422 never looks like a successful conversion that will silently skip every day.
- [ ] Show 202 as Updating valve; partial multi-valve readiness is per valve. Ready
  means ACK gate passed, not physical proof. Show unexpected-watering/clock/error
  state and last result; help contains explanations. Always is a normal edit.
- [ ] Test old/new server compatibility, pending cloud edits and session fences;
  hide unsupported activation, preserve current schedules. Test 320px layouts and
  keyboard/tap overlays in Task 9. Run frontend typecheck/unit/build and commit
  `feat: edit timed irrigation conditions and preview conversion`.

## Task 9: Build browser coverage and qualify integration

Files: create `scripts/test-conditional-irrigation-integration.js`,
`web/react-gui/playwright.irrigation.config.ts`,
`web/react-gui/e2e/irrigation.spec.ts`, `web/react-gui/e2e/fixtures/irrigation.ts`,
`docs/operations/conditional-irrigation.md`. Add `test:irrigation:browser` script
running `playwright test --config playwright.irrigation.config.ts`.

There is no existing general GUI browser harness. The new config runs the actual
Vite app, uses authenticated fixture API responses and real routes/components,
blocks non-local requests, and does not exercise only the demo or design-preview.
Create equivalent real-route coverage for server pending-edit behavior.

- [ ] Integration fixture: legacy trigger+weekly valve, explicit conversion, clear
  ACKs, due evidence, one timed command, observed run/close and decision history.
  Repeat false/missing condition and DENDRO hold; no legacy duplicate command.
- [ ] Add flush during pending open, stale clock reboot, both recorded_at formats,
  manual race, missed start, deletion/reassignment, disable-all, old-server unknown-op
  and out-of-order sync scenarios. Assert durable DB state across worker restarts.
- [ ] Rehearse 0073→new head and fresh seed using migration runner, compatible existing
  columns and boot flow. Compare devices/device_data/events/recommendations/legacy
  rows and prove trigger preservation without touching sync-init-fn.
- [ ] Run `npm run test:irrigation:browser` in web/react-gui. Cover 320/390/1440 px,
  light/dark, all seven locales, keyboard and touch. Assert ≥44 px targets, existing
  aria-controls target, no persistent Recommended, no overflow/form movement and
  unchanged selection when asking for help. Save route-named screenshots.
- [ ] On an authorized test bench, execute spec §10: every Gen1 day cleared, Gen2
  one-byte acceptance, delayed ACK misattribution, expiry/offline uplinks, flush/send
  races, power loss, real NTP hook events and at least 20 measured opens per generation.
  Qualify margin B for both selection-to-open and selection-to-final-CLOSED/no-flow,
  short runs with lost endpoint uplinks, permanent CLOSE near expiry, external-input
  incidents, and reliable deployed identity matching the qualification registry.
  Record due/enqueue/observed times, p95/max/count and versions. Qualification must
  include the worst uplink phase and queue contention, not only immediate uplinks.
- [ ] Keep activation false if any required hardware/transport test is unavailable
  or fails. Report it as not run/failed; never infer hardware success from mocks.
- [ ] Write operational steps for pending/blocked states, configured valve intervals,
  retry, disable-all, fixed conversion, old peers and downgrade. Run prose checker.
  Commit `test: cover irrigation conversion recovery and delivery`.

## Task 10: Verify independently and prepare the paired changes

- [ ] Update only new migration checksums; prove every historical checksum unchanged.
  Regenerate seeds with `node scripts/build-seed-db.js`, mirror changed runtime files,
  and run the relevant gates below once the implementation is final.
- [ ] If the work is a stack, set OSI_FLOWS_SIZE_BASE_REF, OSI_DDL_BASE_REF and
  OSI_MIGRATIONS_BASE_REF to its recorded common base. Set OSI_IDENTITY_BASE_REF to
  the same base: verify-sync-flow invokes verify-live-gateway-identity as a child.

```bash
node --test "$IRRIGATION_MODULE"/*.test.js
node --test "$IRRIGATION_RUNTIME"/osi-valve-control/*.test.js
node scripts/test-conditional-irrigation-schema.js
node scripts/test-conditional-irrigation-clock.js
node scripts/test-conditional-irrigation-transport.js
node scripts/test-conditional-irrigation-writer-guards.js
node scripts/test-conditional-irrigation-writer-wrappers.js
node scripts/test-conditional-irrigation-conversion.js
node scripts/test-conditional-irrigation-flow.js
node scripts/test-conditional-irrigation-contract.js
node scripts/test-conditional-irrigation-integration.js
node scripts/test-scheduler-clock-jump.js
node scripts/test-valve-schedule-sync-triggers.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-seed-db-ledger.js
node scripts/test-journal-schema.js
node scripts/verify-agroscope-linkage.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-flows-fn-parse.js
node scripts/test-flows-wiring.js
node scripts/flows-bare-require-scan.js
node scripts/verify-helper-registration.js
node scripts/verify-module-file-deploy-coverage.js
node --test scripts/deploy-command-ledger-dependency.test.js
node scripts/verify-command-safety.js
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
git diff --check
```

- [ ] Run frontend typecheck/unit/build and browser gates in both repos; run server
  backend `./gradlew test` and `./gradlew build`, Flyway ordering and contract vendor
  checks. Record exact commands/exit codes and explain unrelated base failures.
- [ ] Update AGENTS.md and rollout notes to final behavior. Write
  `docs/superpowers/plans/2026-10-13-conditional-irrigation-execution-report.md`
  with bases, commits, evidence and hardware limits. Do not mark an unrun gate green.
- [ ] Have a non-author reviewer compare spec→plan→diff; a non-author verifier reruns
  gates and probes ACK ambiguity, delayed delivery, stale clock and old clients.
  Resolve required findings before exposing C. Prepare paired PRs with deployment
  order and qualification evidence; merging or production deployment is separate.

## Requirement coverage

| Requirement / external finding | Tasks |
|---|---|
| Current origins and free migration numbers, R1 | 0, 3, 7 |
| SWT/Custom/tooltip semantics and locale coverage, R9 | 1, 8, 9 |
| VWC evidence and absent cadence data, R6 | 2, 8 |
| DENDRO threshold/hold/conversion behavior, R5 | 2, 6, 8, 9 |
| Clock, timezones and timestamps, R7 | 2, 3, 8, 9 |
| Feasible converted schedules and limits, R8 | 3, 4, 8 |
| Clear-plan conversion and unexpected opens, R2 | 4, 5, 9 |
| Expiry, radio latency, queue flushes, R3 | 3, 4, 9 |
| New shared guard and every writer, R4 | 4, 5, 6 |
| Cloud support, old clients, disable-all and vendor check, R10 | 6, 7, 9 |
| Additive migration safety and trigger ownership, R11 | 3, 7, 9, 10 |
