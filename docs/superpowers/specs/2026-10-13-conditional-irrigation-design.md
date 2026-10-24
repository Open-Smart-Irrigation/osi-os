# Conditional irrigation and farmer-friendly SWT settings

Created 2026-10-13; revised 2026-10-18 during implementation and protocol review.
Status: implementation in progress; no hardware qualification. Accepted slices and
outstanding gates are recorded in the [execution report](../plans/2026-10-13-conditional-irrigation-execution-report.md).

The farmer chooses when the gateway checks a sensor condition and how long to water
if it passes. Add VWC alongside SWT and dendrometer. Reuse selected weekly schedules,
or use a configured daily start. Earlier dry readings do not latch a watering request.

## 1. Requirements and scope

The agreed SWT choices are Wet = 20 kPa, Moist = 30 kPa and Dry = 50 kPa.
“Recommended” appears inside the Moist help overlay only. Explanations use help
overlays, without additional permanent subtext. Preserve custom numeric thresholds.
Without selected schedules, wait for the configured daily start; never open immediately
on a threshold crossing. At each due time, evaluate the condition again.

Deliver three slices:

- A: SWT presets and accessible help, including the existing form's preservation bugs.
  This slice works with the legacy API and can ship independently.
- B: inactive policy infrastructure and paired cloud compatibility.
- C: conversion and activation, after software tests and valve/transport qualification.

Proposed engineering choices: one policy per zone, explicit sensor channels and target
valves, fixed or proportional dendrometer duration, 60-minute minimum gap and 240-minute
daily budget by default. These are operational defaults, not crop recommendations.
Conversion uses the existing empty-program push mechanism. It requires no visit to the
valve, Bluetooth interface, operator attestation, or separate ownership-release worker.
The residual ACK ambiguity is described in §6; it is not a guarantee of physical isolation.

## 2. Reverified starting point

Fetched and inspected on 2026-10-16:

| Repository | Current `origin/main` inspected |
|---|---|
| osi-os | `f130073205aa26abaa5d71097b354df39e9fe753` |
| osi-server | `113696c1bcdb27747a8fe62c1158dcdf0168695f` |

The earlier edge base `1939a04a6` was the fork point, 63 upstream commits behind.
Local edge main also has the original documentation commit. Server main is 42 commits
behind its origin. Inspecting origin did not rebase either working tree or incorporate
unrelated local edits. Edge migrations through `0073__zone_env_rain_quality_sync.sql`
exist; the conditional migration is `0076` and its later sync migration is reserved as `0077`.

Runtime paths below are under
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` unless stated otherwise.
Mirror changed runtime payloads to bcm2709.

| Surface at the inspected origin | Actual behavior and consequence |
|---|---|
| `flows.json`, inject "Schedule time" and queries "Build zones query (enabled schedules)", "Build mean query (last hour, all datapoints)" | Legacy daily cron is 06:00 in process time; default gateways use UTC. It chooses the first STREGA valve and averages recent SWT. Conversion must show the real old time and explicitly select targets. |
| `osi-dendro-analytics/index.js`, `applyDendroSchedulePolicy`; `dendro-compute-fn` | Enabled legacy threshold ranks filter escalation into `maintain`; disabled rows do not filter. The stored daily action may still reflect an earlier enabled row. |
| Decision node "Decide + build actuator cmd + build DB logs" | Legacy DENDRO still waters for maintain and hold actions, including below-threshold downgrades; response_mode is ignored. Conversion changes this. |
| `osi-zone-env/index.js`; server `ZoneEnvironmentService` | Server-preferred bundle carries an action, not the stress/source evidence needed by the new predicate. V1 uses local analysis. |
| `osi-valve-control/plan.js`, `api.js`, `unclaim.js` | Empty enabled weekly sets produce Gen1 all-FF weekday frames or Gen2 empty day-mask frames. Deletion/unclaim already request a clear. Exclusion of new conditional rows must be added. |
| `osi-valve-control/push.js`, `store.js`, `ack.js` | Flush failures are currently swallowed, QUEUED rows can be replayed, and ACK matching uses port/purpose/day rather than a command nonce. These are conversion integration work. |
| `osi-valve-control/workers.js` | ONCE dispatch is allowed through exactly due + 10 minutes; later starts become SKIPPED. Observed schedule runs are inferred using current local windows, so stale fixed runs after conversion can appear unexplained. |
| `write-strega-expectation` | Existing inline INSERT has no exclusion transaction or idempotent replay; a duplicate ID can throw and lose the downlink. A shared dispatch guard is new behavior. |
| `osi-sdi12-normalize`, commissioned probe profiles | Real VWC channels already exist. Device type alone does not establish available channels; use commissioned capabilities. No per-device sensor reporting interval is stored. |
| `ScheduleSection.tsx`, `AdvancedScheduleDrawer.tsx` | Save rounds/clamps custom SWT; tab switching resets it; drawer saves can resend stale/default metric and threshold. Slice A must fix all three. |
| `ValveControlPanel.tsx`, `ValveControlHelp` | Existing touch/keyboard help provides the reuse point. Extract and correct its semantics instead of adding a separate tooltip implementation. |
| Server `EdgeSyncController`, `ValveCommandController`, `ValveScheduleApplier`, `SyncEventTxExecutor` | Controller builds bootstrap response; command controller writes/resends/status/opens; applier overwrites fields; unknown event operations are permanently dead-lettered. Capability negotiation and absent-field preservation are new work. |

ChirpStack 4.12.1 checks queue expiry with strict `expires_at < now`; MQTT
`DownlinkCommand` has no expiry field. Conditional opens therefore need the gRPC
DeviceQueueItem path. This is source verification, not a test of a deployed gateway.
Sources: [queue handling](https://github.com/chirpstack/chirpstack/blob/v4.12.1/chirpstack/src/downlink/data.rs),
[MQTT command schema](https://github.com/chirpstack/chirpstack/blob/v4.12.1/api/proto/integration/integration.proto).

## 3. Farmer interaction and slice A

Keep “Trigger-based irrigation” as the zone entry point. The policy form contains
When, Water if, Run for, and Valves. “Every day” offers a time picker, initially
06:00 for a new unsaved draft; “Selected days and times” reuses weekly schedule
controls. Save explicitly. Never enable watering merely by opening the form.

Selecting existing schedules preserves their UUIDs, days, times and durations if
valid. Show the proposed conversion, timezone, affected valves and any incompatible
limits before saving. “Always” in the schedule editor means ordinary fixed scheduling.
Saving that change back uses the normal fixed-plan push. There is one editor for each
saved fact, shared by the zone and valve entry points.

SWT is a native radio group labelled “Watering preference”. Exactly 20/30/50 select
the corresponding option; all other saved values show Custom in Advanced. Keep 29.9
as 29.9 through load, tab switching, saving and advanced edits. A new SWT draft selects
Moist. Maintain separate unsaved SWT and DENDRO drafts when switching metric tabs.
Remove the drawer's independent schedule save: its scheduling tab opens the same
schedule editor, initialized from current data. Its agronomy configuration saves stay
separate. This avoids resending stale metric/kPa defaults when editing duration.

| Option | Help text |
|---|---|
| Wet | Water sooner to keep the soil wetter. Check at the scheduled time and water at 20 kPa or higher. This is a watering preference, not the current soil-status label. |
| Moist | Recommended. Allow some drying before watering. Check at the scheduled time and water at 30 kPa or higher. |
| Dry | Allow more drying before watering. Check at the scheduled time and water at 50 kPa or higher. This is a watering preference, not the current soil-status label. |

Keep the existing soil-status boundaries unchanged; 50 kPa can still show Moist in
a status pill. Numeric thresholds, not labels, are canonical. Validate invalid custom
input and display an error instead of rounding or clamping it silently.

Extract `ValveControlHelp` into a shared disclosure-style toggletip. Its separate
help button has an accessible name, `aria-expanded`, and `aria-controls` referencing
an existing hidden-or-visible overlay element. Use a labelled `role="region"` for
expanded content, not a persistent `role="tooltip"`. Hidden content is absent from
the accessibility tree; tests check visibility, not DOM absence. Support tap/click,
keyboard Enter/Space, Escape and outside dismissal; hover/focus may open it, and
pointer movement onto the overlay keeps it open. Help never selects a radio.
Targets are at least 44 × 44 CSS pixels. Clamp the overlay to the viewport without
moving the form. No `title`-only help and no persistent Recommended badge.

VWC uses an explicit percentage and device/channel selection, showing known depth.
There is no invented VWC default; measured or entered zero remains zero. Missing
sensor choices have accessible explanations. Compact state shows next check, last
outcome, and actual operational states such as “Updating valve” or “Unexpected
watering”. Those states and save errors remain visible; explanatory text stays in
help overlays. New strings use `valves.json` in en, de-CH, fr, it, es, pt and lg,
with full-depth locale parity tests in both frontends.

## 4. Conditions and evidence

```ts
type Source = { device_eui: string; channel: string };
type Condition =
  | { kind: 'SWT'; threshold_kpa: number; sources: Source[] }
  | { kind: 'VWC'; threshold_percent: number; sources: Source[] }
  | { kind: 'DENDRO'; minimum_stress: 'mild' | 'moderate' | 'significant' | 'severe';
      response_mode: 'fixed' | 'proportional' };
```

SWT thresholds accept finite `0 < threshold <= 300`; incoming SWT samples accept
finite `0 <= value <= 1,000,000`. Source eligibility preserves Chameleon/WATERMARK,
admits exactly `swt_1` and `swt_2` for KIWI_SENSOR, and admits DRAGINO_SDI12 only
when the profile is TENSIOMARK with a validated explicit channel layout. Generic
SDI-12, CLOVER, and undeclared channels remain unavailable. Canonical swt_1/2/3
use legacy aliases normalized at the read boundary. VWC accepts finite 0–100 and available
vwc_1 through vwc_10. Compare SWT >= threshold and VWC <= threshold. Validate
readings against their channel range; zero VWC is valid. Do not use threshold_kpa
or aggregate_kpa to carry VWC.

Select 1–32 unique sources explicitly. At save and execution require zone assignment,
actual commissioned channel capability, enabled sensor and existing calibration/fault
interlocks. WATERMARK channels remain excluded while their irrigation interlock applies;
TEKTELIC's planned VWC channel is not an implemented source. Use one resolver for
source options, validation and reads. Never silently substitute another probe.

Policy-level observation_window_minutes defaults to 60, range 1–1440. There is no
reporting-interval validation because that data does not exist. Its help explains
that a longer window admits older evidence. Every selected source must supply a
valid sample in the closed interval `[dueAt - window, dueAt]` when the decision is
made. Compute each source's mean, then average source means equally. Deduplicate
source/timestamp by highest device_data.id. Missing evidence yields UNKNOWN and
no watering; a sample after dueAt is excluded. Persist the evidence used and never
reconsider a decided slot for later-arriving readings.

Normalize both SQLite `YYYY-MM-DD HH:MM:SS` (UTC) and ISO timestamps to instants.
Window selection must use parsed time or SQLite time functions, never raw lexical
comparison. Reject malformed/future evidence explicitly.

DENDRO v1 uses local daily analysis only: stress, usable_tree_count, action and
computed_at no more than 36 hours before dueAt, and not after it. Require usable
trees and a recognized stress rank at or above minimum_stress. Rain suppression
and recovery hold actions veto watering even when stress is high. A plain maintain
action may water if the independent stress predicate passes; never infer stress
from an action code. Unknown actions or missing evidence yield UNKNOWN.

Capture a versioned unfiltered decision and its evidence during normal daily
analysis, before applying the legacy schedule filter. On conversion, disable the
old row. Cached records without this raw evidence are UNKNOWN until the next
normal local calculation; do not replay stateful analytics from a policy read.
The current helper bypasses filtering when enabled != 1; prove that in a test,
including a pre-conversion cached downgrade.
Conversion preview states that below-threshold and hold days will now skip and
that local analysis replaces any server-preferred action.

Fixed uses base duration. Proportional multipliers are decrease_20=0.8,
decrease_10=0.9, maintain=1, increase_10=1.1, increase_20=1.2,
emergency_irrigate=1.5. Round once to whole minutes, minimum 1. Validate the maximum
possible duration <=240 rather than silently truncating it. New policies have no
aggressive mode. Existing response_mode values are ignored by legacy execution;
conversion defaults explicitly to proportional and shows this choice, including
for a saved aggressive value. Emergency actions still obey timing and limits.

## 5. Time, delivery window and limits

Policy timezone is authoritative for attached schedules and per-valve daily budgets.
Initialize it from a valid zone timezone, then gateway configuration; otherwise
require a selection. Persist an IANA name. Attached valve_schedules.timezone must
match it. Conversion of a mismatched row returns 422 timezone_mismatch with the
row IDs; the farmer must explicitly edit/re-express those times before conversion.
Later zone timezone changes do not silently reinterpret policies. Preview the legacy
cron using the actual process timezone: 06:00 UTC is 08:00 Zurich in summer and
07:00 in winter, not 06:00 Zurich.
The edge read model and cloud zone-runtime projection expose nullable
`legacy_process_timezone`, read from the actual Node.js process. The cloud stores
the received value unchanged and exposes it in the read DTO only while the runtime
summary is fresh; otherwise that DTO field is null. An unknown timezone, stale
summary or untrusted clock makes the old-time preview unavailable. Neither frontend
assumes UTC or the browser timezone. This display field does not control scheduling.

A 60-second tick may decide a slot from dueAt through dueAt + 10 minutes inclusive,
matching the existing ONCE start grace. Later slots are SKIPPED with missed_start;
there is no separate MISSED state. Nonexistent DST local times are skipped; repeated
local times are checked at the first instant only. The key is the single composite
primary key `(schedule_uuid, local_date, local_time)`, independent of revisions.
New/edited/enabled schedules apply only to future instants. A missed-start audit
looks back to the last trusted tick, capped at 24 hours; it does not replay an outage.

Require a trusted clock before deciding, marking skipped slots, or dispatching.
Add a boot-scoped NTP synchronization marker using OpenWrt's existing ntpd hotplug
path. Only exact ACTION=stratum with lowercase stratum parsed as decimal 1–15
writes a complete marker atomically. Ignore unsync, step, periodic and invalid fields;
they never create trust and preserve any last-good marker. BusyBox unsync reports
missed peer replies, not a clock change. After successful synchronization, compare
wall-time progression with uptime;
a backward jump or material discontinuity invalidates trust until resynchronization.
Also require now >= the persisted last decided dueAt and latest relevant recorded_at.
A marker from another boot is invalid. This is deliberately stricter than using
history lower bounds alone: an old database cannot prove that today's clock is
correct. Offline operation continues after synchronization within the same boot;
a reboot without a trusted clock shows “Waiting for clock” and sends nothing.

A policy save whose result is enabled also requires the durable clock gate before
its atomic write. Capture one internal trusted instant after acquiring the affected
valve writers; HTTP or cloud input cannot supply that authority. An untrusted save
returns the clock reason and leaves policy, schedules and prepared revisions
unchanged. Stamp the policy and each new or edited enabled conditional schedule
with that instant. Enabling a paused policy stamps every live enabled conditional
schedule too. A slot must be strictly later than both policy and schedule boundaries.

Paused drafts may be saved without clock trust. They create no new activation
boundary: new or changed draft rows may keep effective_from null, while unchanged
historical boundaries remain. A later enable overwrites the applicable boundaries
with trusted time. Pause remains available while the clock is untrusted, preserves
existing boundaries, and still reconciles pending commands. For a single predictable
API rule, every PUT resulting in an enabled policy requires trusted time, including
an edit limited to a disabled row; pause uses its separate operation.

Decision grace and radio delivery expiry are separate. STREGA normally reports every
10 minutes; no per-device interval is currently stored. Add explicit per-valve
`delivery_interval_minutes` to the policy's delivery settings (integer 1–60, default
10, labelled “Valve reporting interval” under Advanced). It is an assumed/configured
actuator interval, not sensor cadence or a measurement. The help asks users to match
a changed valve interval. Persist it per valve and include it in conversion preview.
The API field delivery_settings is an object keyed by canonical uppercase valve EUI;
each value is `{ "delivery_interval_minutes": 10 }` with the configured integer.
The database stores this object in delivery_settings_json. Reject keys that collide
after EUI normalization. Materialize the default for each attached valve at save time;
only the owning zone's selected valves may appear in the persisted map.

For interval I, grace G=10 minutes, tick allowance T=1 minute, maximum run D and
minimum gap M, require the full delivery allowance L=G+2I+T. Default L is 31 minutes.
The latest physical-start deadline is `min(dueAt+L, nextDueAt-D-M)`, using the next
enabled occurrence for that valve, including across week boundaries. Reject a static
schedule set whose bound would shorten L. At runtime recompute using current
reservations, and skip rather than shorten the full allowance. The actual queue
expiry precedes that deadline by the qualified physical effect margin in §7.1.
Do not enqueue at or after queue expiry. ChirpStack checks expiry at queue selection
with a strict comparison; selection at exactly expiry remains possible, and radio
delivery and valve motion follow selection.
An unavailable or still-busy radio queue yields a skip; do not queue a conditional
open behind unfinished plan changes. Measure actual delivery latency before release.

Each valve allows at most four starts per weekday. Conditional base/effective
run lengths are 1–240 minutes. Default minimum gap is 60 minutes after the latest
possible end; configurable 0–1440. Default daily budget is 240 watering minutes;
configurable 1–1440. Validate the whole converted schedule set, maximum adaptive
duration and delivery allowance over a weekly cycle, midnight and DST transitions.
At save time validate an ordinary weekly cycle and the next400days of resolved
occurrences from an explicit reference instant, padded for boundary carryover. Return
the validation bounds. Before dispatch recheck actual upcoming occurrence bounds;
a finite save-time horizon cannot predict later timezone-rule changes.
Reject incompatible sets with 422 and affected rows/reasons, rather than save a plan
that predictably skips. Examples: two 180-minute runs exceed a 240-minute daily
limit; starts 30 minutes apart violate a 60-minute gap. Proportional's maximum is
1.5×; if another mode is ever added, validation must use its actual maximum.

Reserve the full watering duration against each local day it could occupy if
starting anywhere between dispatch and the latest physical-start deadline. This can
conservatively charge both days for an ambiguous near-midnight command. Reserve
valve exclusion through that deadline plus duration, then apply minimum gap. The delay itself is not watering minutes.
Use observed/confirmed timing to refine reservations; do not free budget merely
because a transport request timed out. Count manual, ONCE, conditional and observed
valve-fired/unexplained runs once, linked to expectations when possible. Unknown
run duration blocks further automatic starts until reconciled. Manual actions may
exceed an automatic budget but reduce subsequent automatic allowance.

Treat an occurrence and its expectation as one run, joined by command_id. Capture
minimum_gap_minutes and exclusion_end_at in the immutable decision evidence;
exclusion_end_at must equal reservation_end_at plus that captured gap. A qualified
bounded command without unresolved open evidence stops excluding new starts when
a trusted clock reaches this half-open horizon, under §7.1. Keep its SENT/UNKNOWN state, acceptance audit and historical
daily charge. Elapsed time is not proof of non-delivery. A later policy edit cannot
change a previous command's captured horizon.

Daily-limit queries use the current policy timezone for every run. Project immutable
UTC reservation intervals and complete observed spans into that timezone with the
shared calendar helpers; count each command once. Captured local_days and the old
policy timezone remain decision audit evidence. A timezone edit changes current
calendar-day buckets, but never rewrites an earlier run's UTC bounds or exclusion
horizon. The accounting query requires an explicit valid timezone, including for
ordinary observed runs; it must not silently default those runs to UTC.

A complete, unambiguously linked open/close observation can refine that same run's
exclusion and accounting once. Open-only evidence, a currently running/stale-open
state, or an unexplained run with unknown duration continues to block until
reconciled. A close-only or absent observation does not prevent release at a valid,
qualified self-closing horizon; it does not erase the conservative charge. Missing
or malformed bounds, unqualified timing, and legacy commands without expiry remain
blocking until positive reconciliation. True opaque commands have no finite horizon.

For observed valve-fired or unexplained runs without a command, use the physical
expectation ID as the stable accounting identity. Keep report-only duration unknown:
the difference between OPEN and CLOSED receive times is not watering duration.
Represent the conservative possible interval separately from observed endpoints.
A fresh, ordered explicit CLOSED linked to that run supplies a latest possible end;
its receive time is an upper bound, not the exact physical close time. Report receipt
cannot supply a lower start bound: a valve could reopen between sampling CLOSED and
receipt of that report. Without independent command/program or trusted sample evidence,
the possible start remains unbounded past. Missing or invalid end evidence remains
unbounded future.

An unknown physical run blocks an automatic decision if its possible interval can
intersect any local day the candidate watering could occupy, using the current policy
timezone. Thus a finitely ended run yesterday does not block every future day, while
an unknown run that could occupy today blocks today's starts. Keep the history and
unknown duration after incident clearance; a successful clear-program retry does not
supply watering minutes. Existing unresolved command owners retain their separate
shared-exclusion and accounting rules.

## 6. Conversion through existing program pushes

Ordinary weekly schedules execute on the valve. Conditional schedules execute on
the gateway via OPEN_FOR_DURATION; the valve closes itself. All enabled WEEKLY rows
for a valve must be either unconditional or attached to the same policy. Reject
mixed sets with 409 mixed_schedule_mode and affected rows. ONCE remains explicit
and shares per-valve dispatch exclusion.

Saving conversion is an atomic schedule edit: attach selected rows, disable the
legacy zone trigger, and set a new desired plan revision before any external I/O.
Before that transaction, discover the union of current and requested valve EUIs,
including removals, reassignment, legacy disabling and every prepared clear revision.
Acquire the unique canonical EUIs in ascending order with no database transaction
open. The writer context must retain the full held set: any held valve is reentrant,
and adding an unheld valve from inside that context fails immediately. Reread versions
and membership in the edit transaction. If another affected EUI appears, roll back,
release all gates, and rediscover before a bounded retry; never expand the set while
holding a transaction or earlier gates. A stale version, deleted target or live
actuation conflict rolls back the entire edit.

Commit the edit and prepared revisions, then release all gates. Each per-valve sender
reacquires its device gate and rereads the desired revision, current membership and
live conflicts before any flush or enqueue. A stale revision cannot send. This keeps
a manual command that wins the gate after the edit from being flushed by the sender.

Exclude conditional rows in compileWindows so the normal compiler builds an empty
program for the converted valve. Preparation runs in the caller's edit transaction;
the following flush and sends run under the per-device writer after commit:

1. Reject conversion during active/unresolved actuation.
2. Mark older QUEUED plan/status pushes SUPERSEDED, including stale resume commands.
   Persist the new revision and pending conversion before flushing. Capture immutable
   predecessor_push_ids for every unresolved older known plan/status owner this
   revision replaces, including FAILED rows with accepted or UNKNOWN transport.
3. Flush the device queue; fail closed on failure, never swallow the error.
4. Queue the complete empty program through the normal push path. Record the exact
   push IDs for this revision (all seven days for Gen1; the empty day-mask program
   for Gen2). Never replay superseded rows.
5. Permit conditional dispatch only after every required clear push for that current
   revision has a successful ACK and no blocking incident or other reservation exists.
   Starts during this update are skipped, never replayed after ACK.

Store revision, required push IDs, readiness and incident information as local
`valve_settings.conditional_control_json`. This is execution metadata, not an
ownership table or a synced editable resource. Keep cloud runtime summaries read-only.
A crash at any step leaves dispatch blocked until the recorded revision is reconciled.
A retry repeats the clear for a new revision through the same path.

After every required clear ACK for the current revision, only known plan/status
rows in predecessor_push_ids may stop blocking readiness and shared dispatch.
Preserve their FAILED state, error details and UNKNOWN transport
audit outcome: this is reconciliation to a newer desired program, not proof they
were never transmitted. Never rebuild them or count their known push IDs toward the
new set. Other owners remain subject to §7.1; current clear ACKs cannot settle a
timed-open or opaque command. Unexpected later watering
still records the incident below.

ACK matching requires an actual attempt: the selected owner must have a durable
ATTEMPTED, ACCEPTED or UNKNOWN transport phase and a valid attempted_at. Parse both
supported UTC timestamp formats and require receivedAt at or after that attempt.
Conditional plan ACKs match exact current required IDs. Ordinary fixed-plan, status
and clock ACKs match the newest eligible row for the same device, purpose, port
and weekday; they do not need a conditional revision. An ACK before the current
attempt cannot settle its row. Lost enqueue responses do not disqualify a later ACK.
A negative required ACK fails that revision; a later positive ACK cannot revive the
same row. An explicit retry creates fresh required IDs. Ordinary uplinks cannot
silently turn this failure into a new clear revision. Profile/generation recovery
must be tied to a durable unfinished transition; a healthy matching profile and
current program are a no-op on plan, status and clock ACKs.

Decode Gen1 status as exactly two hexadecimal characters and Gen2 status as an
integer byte without coercion. Raw Gen2 ACK battery prefixes also accept hexadecimal
letters, matching the vendor codec. Missing or malformed status never proves success.
For supported Gen2 commands, use command-specific semantics: plan/clock success is
1; scheduler status must echo the queued mode (30/0, 31/1 or 32/2 in hexadecimal
payload/decimal status notation). Physical confirmation remains a release gate.

Gen1 success polarity is not established by the available primary evidence. The
newer HW4/5 manual is not evidence for Gen1. Preserve strict 00 only as a provisional
ordinary weekday-plan/clock compatibility assumption; it cannot satisfy a conditional
required ID. Gen1 scheduler-status semantics are also unverified, so retain its
candidate diagnostically without marking success. Conditional Gen1 ACKs remain
pending with ack_protocol_unverified until an internal generation/firmware rule
defines the exact predicate. Tests may inject such a rule; request fields and
operator attestation cannot. A later verified rule requires an explicit fresh retry.
Physical timing qualification is separate and cannot imply ACK semantics. Provisional
valve clock bookkeeping does not establish the gateway clock trust required by §5.
An ordinary Gen1 scheduler-status push can remain pending and later fail as stale
while its semantics are unverified. Release evidence must report this behavior
until a verified rule is available.

This ACK gate follows the existing delivery ledger. ACKs identify ports/status,
not a program hash or nonce; a delayed ACK can be assigned to the wrong generation.
“Ready” therefore means the configured software gate passed, not verified physical
ownership. A stale program may still run, potentially more than once before it is
observed. Do not promise that one bad ACK permits at most one extra watering.
The help overlay explains that valve-side edits can bypass conditional checks.
Gen2 acceptance of the one-byte empty frame remains a hardware activation gate.

While conditional mode is configured, any `on_valve_schedule` open or open not
matched to an authorized timed-command expectation records a sticky incident and
blocks new conditional dispatch. Extend observation beyond current compiled windows:
a stale fixed run otherwise becomes “unexplained” and disappears from the schedule
observer. Persist its timing/accounting once; report “Unexpected watering” to the
farmer. Recovery uses an explicit retry of the empty-program push after the run has
ended/reconciled. Missing telemetry cannot prove that no external watering occurred.

Each new incident starts with a null retry_revision. Only explicit retry preparation
binds a newly generated clear revision to that incident in the same transaction.
Ordinary edits and resends cannot supply this proof. Clearance requires the incident's
retry_revision, the supplied revision and the current desired revision to match,
plus that exact required ACK set and the incident's own ended-run evidence. A READY
revision whose ACKs predate the incident cannot clear it. Preserve run/accounting
history after clearance; a later new incident starts with no retry proof.

Report-only physical expectations stay local in this release. Their explicit
transport_json.physical_run marker owns unknown duration and possible bounds. In
the legacy NOT NULL columns, duration seconds -1 and an empty expected-close string
are storage sentinels only. Public accounting/event duration is null; no reader may
use these columns as command timing, a timeout or a volume estimate. Shared projections
omit these rows from ValveActuation archive/bootstrap/force-sync and durable history,
and finish their dirty keys as local-only without quarantine or endless retry. The
matching irrigation_event may sync with null duration, and capability-gated incident
summaries provide cloud status. Ordinary command-backed history remains unchanged.

Use a separate v1 local-only classifier with the same result in JavaScript and SQL.
It requires a null command ID plus either the safety parser's report-only result
or both exact storage sentinels. This also keeps malformed commandless transport
local as uncertain evidence. Valid legacy commandless rows with real timing and
no non-null physical-run marker still replicate. Do not change the safety parser
for sync. Apply the replication predicate before query limits, cursor bounds and
manifest counts; a later object projection must not change that population.

An adopted pre-existing on-valve expectation is a narrow compatibility exception.
Durable history v1 cannot remove a mirrored row, so recovery must preserve that
row's existing export identity. Capture a validated legacy_v1_compatibility record
inside physical_run in the adoption transaction, retaining the original expectation
ID, timing, volume and trigger as audit. Local accounting and its new irrigation
event use unknown duration; the old positive values do not prove an installed
program. The validated compatibility row stays in every v1 export and manifest
population. New report-only sentinel rows never qualify.

Accept edge-produced legacy UTC timestamps with uppercase T/Z, seconds and zero
to nine fractional digits, with strict calendar/time validation. Preserve raw
values in the compatibility record. If a previously replicable row cannot meet
the compatibility rule, leave it unchanged and return unsupported_legacy_recovery;
do not make it local-only as a fallback. The compatibility cost is that the old
v1 resource retains historical estimates while local decisions and the nullable
event represent unknown duration. No deletion or new raw-history protocol is added.

Apply stateful telemetry and owner attribution in one short transaction under the
valve writer. Persist an explicit-report watermark and physical-run link in the local
control JSON; generic devices.updated_at is not state evidence. Repeated same-state
reports advance the watermark, older reports remain audit only, and equal-time conflicts
retain uncertainty without completing an owner. Restart recovery uses this durable link;
it must not infer observation endpoints from devices.current_state or compiled windows.

The observation module owns writer acquisition, real runtime clock validation and
endpoint transaction as one boundary. After acquiring the writer, obtain fresh clock
proof outside the transaction and require report_at at or before that same checked
instant. Persist the watermark, run link, owner endpoints and internal proof metadata
atomically. Caller-provided trusted flags or checked timestamps cannot grant this
proof. Failed proof retains raw telemetry: an OPEN remains a blocking unknown run;
a CLOSED cannot change authoritative safety state, end a run or narrow accounting.
Do not advance the authoritative watermark into the future. Later trusted reports
reconcile the same physical run without retroactively attributing an untrusted OPEN
to a command. The post-commit exact-CLOSE observer applies its independent proof.

The first explicit OPEN may match one sole valid, actually attempted timed owner even
without an earlier watermark. Its receive timestamp must be temporally possible under
the complete immutable snapshot, from attempted_at through future_effect_end. An OPEN
report after latest_physical_start_at can still describe a valid ongoing run. No match
or multiple eligible matches records one unexpected run; never-attempted reservations
cannot authorize it. CLOSED ends only that run's stored link. Preserve the separate
post-commit exact-CLOSE observer for every explicit CLOSED report, including repeats.
Periodic reconciliation may recover durable finalization or apply timeouts using
future_effect_end; it must not broadcast one device state into several owners' endpoints.

Guard local and cloud schedule edits, resend, scheduler-status, profile/generation
reconciliation, simulation inputs, unclaim/decommission, cancellation and transport
outputs. Resume/ACTIVE cannot bypass conversion; SKIP_TODAY and pause affect gateway
checks for conditional valves. Re-send in conditional mode sends the empty plan and
invalidates readiness until its ACKs arrive. No automatic FPort 21 resume is part
of conversion. Keep clock synchronization serialized with other device queue writers.

Changing back to Always atomically blocks gateway dispatch and clears condition
references after validating the fixed set; after unresolved commands settle, the
normal compiler pushes that fixed plan. No projection worker or attestation is
needed. Pending/failure status is visible. Deleting the last conditional row requests
an empty program; it never revives the old zone trigger. Device/zone deletion or
reassignment first cancels pending automatic work, then retires invalid policy
references without deleting occurrence history.

## 7. Dispatch, queue flushes and recovery

Use `osi-valve-control/dispatch.js` for transactional reservations and shared writer
composition. All timed-open paths, including manual/cloud, legacy, ONCE, simulation
and conditional commands, bind the final encoded frame to their reservation inside
that composition. Acquire the writer before reserving, commit before network I/O,
and retain the enqueue primitive's sole attempt claim as detailed in §7.1.
Normalize action aliases. Reusing the same command ID returns
the existing result without another send; a different command while the valve is
active/reserved/unresolved returns valve_busy. This deliberately changes manual
semantics: a second conflicting manual open is rejected and shown to the user.
Cancellation remains available. It is not a hidden change to existing behavior.

For conditional commands, claim the occurrence, recheck authority/revisions/time,
condition evidence, readiness, exclusions and limits, and reserve the expectation
inside one BEGIN IMMEDIATE transaction. RESERVED can advance to ATTEMPTED only
once; persist ATTEMPTED before transport. Crash/timeout after that becomes UNKNOWN,
never an automatic resend. SENT means ChirpStack accepted the queue item, not that
watering occurred. SKIPPED is a decision with a reason. Terminal delivery failure
uses EXPIRED/command_expired; observation uses the existing actuation lifecycle.

All STREGA queue writes retain their command ledger, authorization and encoder
behavior, then await exactly one gRPC enqueue inside the shared device writer gate.
This includes plan/status/clock writes, ordinary timed opens, queue rebuilds and
conditional opens. Persist transport intent before the RPC and its returned queue
ID before releasing the gate. MQTT publication has no ChirpStack acceptance barrier
and cannot be ordered against a gRPC flush; no STREGA command may also reach an
MQTT sink. Shared MQTT outputs may continue carrying non-STREGA commands.

Conditional, ordinary manual and ONCE timed opens, plus new permanent CLOSE
commands with a trusted clock, receive persisted queue expiry under §7.1. That
section defines the narrow safety-CLOSE exception when the clock is untrusted.
Record transport phase, attempt
time and queue ID in local transport_json on push and expectation rows, separately
from valve ACK/reconciliation state. A timeout or crash after any enqueue attempt
leaves UNKNOWN transport state. Conflict checks use actual command effects and
qualified horizons; passing a horizon preserves UNKNOWN and does not prove
non-delivery. An empty
queue alone cannot prove non-delivery. Do not replay an ambiguous write merely to
obtain an acknowledgement.
Ordinary valve writes now depend on the local gRPC service and its deadline; expose
transport failures to their local/cloud caller.

Every queue flush passes the same serialized device gate, including the cancellation
fallback, program pushes, delete/unclaim and cloud writers. Before flushing, persist
a flush intent covering every affected STREGA queue item and unresolved enqueue.
Record each owner (occurrence, expectation, push or opaque), queue ID and transport
phase. Keep opaque cancellation-rebuild entries in conditional_control_json, keyed
by original queue ID, with their payload, FPort and original expiry. They must not
fall out of recovery merely because no push/expectation row owns them. On success
invalidate every affected queue ID and reconcile its owning transport state; push
ACKs and observed actuation state remain separate. Rebuild only entries proven
unsent, still authorized and not superseded, preserving any original expiry. An
ambiguous opaque item stays UNKNOWN in the durable flush record and blocks
conditional operation until reconciled. Never re-enqueue a conditional open.
For a conditional open, if non-delivery is proven,
mark EXPIRED with command_expired and release its reservation. If transmission
could have raced the flush, keep UNKNOWN and the conservative watering reservation
through the latest physical-start deadline plus duration. Valve exclusion lasts
through the captured exclusion_end_at,
which also includes the minimum gap. A missing queue item alone is not proof of
non-delivery.
GetQueue followed by a successful FlushQueue never proves non-delivery in
ChirpStack4.12.1, even for an exact queue ID with is_pending=false. The radio path
may already hold the item in memory while the flush deletes only its database row.
Present/nonpending, present/pending and absent snapshots all retain UNKNOWN after
an accepted enqueue. Only a durable never-attempted local intent or a failure that
proves no request was accepted permits the current adapter to release a reservation
before its captured horizon or remove its daily charge. A timeout is not such a failure. The v1 store permits attempted expiry only from
ATTEMPTED with recognized pre-acceptance evidence bound to the command and no
accepted queue ID. SENT and UNKNOWN cannot use this recovery path. Caller assertions
about flush results cannot unlock it. Stronger radio-correlated proof would need a separate
verified contract; current queue APIs do not provide it. See the versioned
[flush handler](https://github.com/chirpstack/chirpstack/blob/v4.12.1/chirpstack/src/api/device.rs#L1132-L1155)
and [pending-state ordering](https://github.com/chirpstack/chirpstack/blob/v4.12.1/chirpstack/src/downlink/data.rs#L954-L973).

This also changes cancellation's queue rebuild behavior: previously accepted plan
or configuration entries cannot be automatically put back on snapshot/flush evidence.
Report their retained uncertainty and required reconciliation to the local/cloud
caller. Timed closing and cancellation remain available. A fresh authorized program
update follows the normal readiness rules; cancellation must not silently replay an
uncertain older write.
A crash or failed flush keeps the intent unresolved and dispatch blocked. Program
edits normally reject while a command is pending; explicit cancel/unclaim may flush
it and must apply these rules. Cancel does not erase an ambiguously transmitted run.

Record reasons including condition_not_met, sensor_unavailable, dendro_hold,
recent_irrigation, daily_limit, valve_busy, plan_update_pending, unexpected_watering,
clock_untrusted, scope_lost, missed_start, dispatch_unknown and command_expired.
Evidence includes metric/unit/value, threshold, samples/analysis, dueAt/timezone,
policy/schedule revisions, requested duration, expiry, command ID and transport state.


### 7.1. Command effects and bounded release

Transport audit and future command effects are separate. Persist an immutable effect
snapshot alongside transport intent before external I/O. It includes the exact FPort,
bytes, confirmation/encryption flags and local encoder provenance. Classification
uses an allowlist of supported payloads, never a caller's action label or supplied
qualification fields. Unknown, malformed, captured, encrypted, or flag-ambiguous
items remain opaque. Confirmed commands cannot use finite release without separate
qualification of their retry lifecycle.

| Effect | Supported examples | Conflict with a later timed open or conversion |
|---|---|---|
| NON_ACTUATING | Reporting/tamper interval, magnet setting, clock sync | No watering exclusion from this owner; schedule readiness still requires every current clear ACK |
| CLOSE_ONLY | Exact permanent CLOSE | Blocks until fresh post-attempt CLOSED evidence or its qualified physical deadline |
| SELF_CLOSING_OPEN | Exact timed OPEN | Blocks until positively reconciled or its qualified effect horizon, including any captured gap |
| MAY_END_OPEN | Timed CLOSE (reopens), partial opening, flush returning OPEN | Remains blocking until positively reconciled; CLOSE cannot settle its earlier future effects |
| OPAQUE | Unsupported payloads or missing provenance | Remains blocking until positive reconciliation |

Plan and scheduler-status writes keep Task5's existing current-clear reconciliation
rule. Do not classify resume as a harmless setting. SET_STREGA_MODEL is DB-only.
Flush returning CLOSED opens for about five seconds; it remains opaque in this first
allowlist, pending a separately qualified duration and observation contract. Safe
close/cancel and non-actuating configuration remain available while opening is blocked.

Resolve the delivery interval from the valve's live policy setting, otherwise use
10 minutes. Capture the value and source. There is no persisted, device-confirmed
reporting interval today; accepting SET_INTERVAL cannot supply one. Use
`L = 10 + 2 * I + 1` minutes for all new bounded commands. Manual commands anchor at
transactional reservation time. ONCE anchors at its immutable fire_at; its inclusive
ten-minute claim grace does not restart the radio lifetime. Conditional commands
anchor at dueAt. For a known next gateway-owned occurrence, require the complete
allowance, duration and applicable gap to fit; reject manual commands or skip ONCE
when they cannot. Never silently shorten L. Existing valve-resident fixed programs
remain independent physical authority.

ONCE recovery inspects the command owner's actual transport evidence before applying
the grace rule. An unclaimed durable reservation may resume through the original
ten-minute boundary, subject to its stored cutoff; afterward it becomes SKIPPED.
An ATTEMPTED/UNKNOWN handoff never resends and never becomes an unsent miss merely
because that boundary passed. An ACCEPTED replay performs no RPC and atomically
finalizes intent SENT, schedule FIRED and its log/event records once, including
recovery from interrupted bookkeeping. Intent labels alone do not prove a handoff.

One internal qualified physical effect margin B must bound both selection-to-effective
open by B and selection-to-final-CLOSED/no-flow by B plus encoded duration. For
permanent CLOSE it bounds selection-to-final-CLOSED with duration zero. CLOSE captures
a zero minimum gap for its own owner, so its exclusion ends exactly at that deadline. Capture the
qualification identity and device context before the attempt. Set:

```text
queue_expires_at = latest_physical_start_at - B
future_effect_end = latest_physical_start_at + encoded_duration
exclusion_end_at = future_effect_end + captured_minimum_gap
```

The occurrence's expires_at is the actual queue cutoff. Its reservation_end_at is
the physical effect end; these no longer differ by duration alone. Keep matching
bounds in occurrence evidence and its expectation's transport snapshot, rejecting
inconsistency. Ordinary commands use the same immutable snapshot. Encoded seconds,
including advanced seconds/hours commands, must match the captured duration exactly.
Replay, flush and restart never extend these bounds. Daily accounting retains the
full encoded duration on each possible local day; it is commanded time, not measured
water volume or a guarantee that motor movement is instantaneous.

The internal qualification provider defaults false. Tests may inject qualified
fixtures; request JSON, UI controls, persisted labels and operator attestation cannot
grant qualification. Today no reliable deployed firmware identity is persisted.
A production qualification registry and reliable identity matching are therefore
release gates, not existing capabilities. Finite release requires both the captured
qualified identity/bound and current provider validation of that captured identity.
Missing, revoked or mismatched qualification prevents finite release; current provider
approval cannot rewrite the captured bound. An old unqualified reservation never becomes qualified
retroactively. With qualification false, new ordinary commands still get the logical
queue cutoff at their start deadline, but time alone cannot settle them. Conditional
activation remains unavailable.

All timed OPEN paths require a trusted clock before reservation and again at the
sole attempt claim. This includes ordinary manual, legacy, simulation and ONCE
commands. An ordinary unqualified OPEN can send after clock trust is established;
qualification remains required for conditional dispatch and finite effect release.
Before current-boot synchronization, return retryable clock_untrusted (local HTTP
503; cloud FAILED_RETRYABLE), with no new reservation, OPEN log or downlink. A later
clock failure before the claim preserves the reservation but makes no attempt.
This adds a manual-operation availability cost after reboot. Same-boot offline
operation follows §5. Qualified OPEN also revalidates the captured identity at claim.

Safe CLOSE, cancellation and allowlisted non-actuating configuration bypass opening
clock/qualification restrictions, but never discard an existing expiry or release
another effect owner. A bounded CLOSE retains its original cutoff; if clock loss
prevents proving it unexpired, that exact attempt waits retryably. Qualification
revocation prevents its finite release, without preventing a still-unexpired CLOSE.

A new exact permanent CLOSE may use timing_contract UNBOUNDED_SAFE_CLOSE_V1 while
the clock is untrusted. This is a separate persisted variant, never a rewrite of a
bounded owner. Require classifier-proven FPort1 payload30, full canonical frame and
local provenance, device context, duration0, gap0, finite_release false and permanently
false qualification. All wall anchors, interval/allowance values, deadlines, cutoff
aliases and effect-end fields are null; interval_source is not_applicable. Persist
internal reservation boot ID/uptime, then internal attempt boot ID/uptime at the sole
claim. Missing runtime receipt evidence fails closed. Any other command or partial-null
shape is invalid. The variant has no gRPC expiry and can never gain finite release
through a later qualification. An explicit request/cloud expiry still binds and
cannot be discarded to select this variant.

For a bounded owner with an explicit request/cloud expiry, persist that normalized
upper bound with the immutable owner and snapshot. Set queue_expires_at and its
expires_at alias to the earlier of the calculated cutoff and the explicit bound.
Validate that minimum relationship when reading the snapshot. Keep physical-start,
effect-end, exclusion and accounting horizons on the original full delivery allowance;
an earlier explicit queue expiry does not prove earlier physical settlement. A later
explicit expiry cannot extend the calculated cutoff. Replay cannot clear or replace
the explicit bound, and any non-null explicit bound excludes the unbounded variant.

Acquire the one device writer before live conflict/release and reservation decisions.
Commit the immutable snapshot before I/O, then recheck clock, qualification and expiry
immediately before the attempt inside that same gate. Existing reentrant helper calls
may reuse its owner; they must not acquire another gate. Never hold a database
transaction while waiting for the gate or doing RPC. At every time-based conflict
release, call runtimeClockStatus inside the acquired writer. A command, API request
or transport object cannot supply trusted:true or equivalent qualification metadata. Validate past bounds such as reservation/attempt, last decided due time
and latest relevant observation. Future expiry/deadline/horizon values are compared
separately; they are not evidence of a bad clock before they arrive. Reboot without
a current synchronization marker, clock jumps or persistence faults prevent release.
A fresh synchronization evaluates the original bounds without extending them.

A qualified self-closing owner with no open evidence, or only close evidence, can
stop excluding at its horizon. Unresolved observed/current OPEN still blocks, even
after the horizon. Missing or stale OPEN telemetry cannot be relabelled CLOSED.
Retain transport uncertainty and conservative accounting after release; later
unmatched OPEN creates Task5's sticky unexpected-watering incident.

A permanent CLOSE may quiesce its own owner on fresh post-attempt CLOSED telemetry
accepted by the existing device/profile gate. This does not prove delivery: a later
CLOSE could truncate a subsequent run. Record that degraded certainty. It never
retires an earlier timed-close, partial, return-open, plan or opaque owner. Legacy
CLOSE rows may use this rule only when their exact local provenance and payload are
already durable; never invent an expiry or classification for a captured item.

Use the explicit profile-gated CLOSED event and its own timestamp after telemetry
persistence, under the writer with no transaction held while waiting. Neither generic
devices.updated_at nor the latest device_data row proves when state was observed.
One event may quiesce each independently eligible exact CLOSE owner, recording
separate evidence for each; selecting only the newest can strand older CLOSE owners.
Every other effect remains subject to its own reconciliation rule.

For UNBOUNDED_SAFE_CLOSE_V1, require same-boot monotonic receipt at or after the
owner's attempt and a currently trusted runtime clock. If the claim itself had a
trusted clock, its immutable trusted_at is the event-time lower bound. Otherwise
require the valid current synchronization marker's uptime at or after the attempt,
and use that marker's epoch as the lower bound. The explicit event timestamp must
fall between that lower bound and the same checked runtime instant. Missing proof,
a different boot or an unbounded event timestamp leaves the owner UNKNOWN. This
does not prove CLOSE delivery; a delayed old CLOSE can still truncate later watering.

No magnet-disabled, Bluetooth-disabled, DI-disabled, Gen1 or FULL exclusion is added.
External inputs can still open a valve; detection blocks later automatic dispatch,
and missing telemetry can delay that detection. New FPort11/22 ACK parsing is deferred:
non-actuating classification restores their liveness without depending on an ACK.

## 8. Persistence and API

Add `osi-irrigation-policy` with pure model/evaluation/calendar helpers and separate
observation, store, worker, API and replication files. Reuse valve-control plan and
transport machinery. There is no new ownership module.

| Storage | Required contents |
|---|---|
| irrigation_policies | policy_uuid PK, zone_uuid, condition_json, timezone, enabled, observation_window_minutes, min_interval_minutes, max_daily_minutes, delivery_settings_json (per-valve intervals), effective_from, sync_version, timestamps/tombstone; unique live zone |
| valve_schedules additions | nullable condition_policy_uuid TEXT and effective_from TEXT; no REFERENCES on the added column |
| irrigation_occurrences | single composite PK (schedule_uuid,local_date,local_time); policy/valve identity, due/expiry, versions, decision/evidence, duration, unique nullable command_id, queue_id, state, reservation and attempt timestamps |
| valve_settings addition | nullable conditional_control_json TEXT for revision/push set/incident/flush and unresolved writer intents; local only |
| valve_schedule_pushes and valve_actuation_expectations additions | nullable transport_json TEXT for phase, attempted_at and queue_id; local only, separate from ACK/observation state |
| irrigation_runtime_state | singleton last trusted tick/decided dueAt; local only, no cascading references |
| sync_link_state additions | peer_capabilities_json, peer_capabilities_context_json, peer_capabilities_request_id; current-link cache only; local link_attempt_json holds pending link nonce/context/route |

New policy/occurrence references have no cascading or restrictive physical FKs.
Validate authorized live references in the mutation service and again at execution.
This avoids blocking existing zone UUID changes/device deletion and preserves history.
Lifecycle routes must retire affected configurations explicitly. Out-of-order cloud
mirrors keep unresolved references non-runnable.

Deleting a zone tombstones and disables its policy and attached conditional
schedules. Moving or unclaiming a configured source pauses its policy and retains
the unavailable source reference. Moving or unclaiming a target valve pauses its
policy and tombstones that valve's conditional schedules; other rows remain for
explicit review. An unrelated device assignment does not pause a destination
policy. These operations preserve historical identities and never convert a
conditional row to Always. Unclaim retains existing ordinary-schedule cleanup.

Retirement removes future authority even while earlier commands or physical runs
remain unresolved. Keep those owners and their conservative accounting. Physical
clear work needs a persisted lifecycle intent whose sender revalidates the exact
retired identity/version; a later reclaim or reassignment obsoletes it. A blocked
or uncertain clear stays visibly pending and cannot undo canonical retirement.
No new identity-replacement endpoint is required: execution revalidates stale EUI
and zone UUID references and never transfers them to a replacement automatically.

Persist lifecycle-clear authority in the existing conditional control JSON and tag
its push rows so generic queued-plan carry cannot resend them. Bind stable device
row identity, ownership, membership and tombstone fields, generation, the lifecycle
revision, exact policy/schedule versions and the complete live schedule state.
Do not bind devices.sync_version: ordinary STREGA state reports advance it. Claim,
reassignment, schedule and generation writers must share the valve writer and
atomically invalidate or replace lifecycle authority when its binding changes,
including an ownership change that later returns to the same visible fields.

Use the existing local plan-resend route and cloud RESEND_VALVE_PLAN for explicit
lifecycle retry. Mark that purpose separately from force, which also accompanies
generation changes. Resume only an unchanged authorized intent, preserve ACCEPTED
or UNKNOWN evidence, and recover ambiguous flushes through the existing ledger.
A proven pre-acceptance failure may receive a new revision on explicit retry.
Unresolved owners prohibit destructive flushing; an empty scheduler plan may queue
behind them while its result remains pending. Transport progress does not prove
physical completion. Local and cloud ACTIVE scheduler requests remain rejected
while a lifecycle-clear intent governs the valve; they cannot resume an old resident
program through the new control mode. Explicit fixed-plan replacement follows the
normal transition.

Use ordered additive migrations for schema and trigger swaps, consistent with 0024
and 0065–0067; no table rebuild or legacy data rewrite is needed. Do not edit
sync-init-fn. Register every new trigger in MIGRATION_OWNED_TRIGGERS and change
ownership of the two valve-schedule outbox triggers from 0024 to the new sync migration.
Verify compatible reapplication through add-column-compat and customer renumbering.
Regenerate seeds through scripts/build-seed-db.js; upgrade alone changes no watering.

Local policy base route is `/api/irrigation-zones/:id/irrigation-policy`:

| Route | Behavior |
|---|---|
| GET base | Policy, eligible sources, schedules, per-valve update/incident state, next check and last result |
| PUT base | Atomic policy and explicit schedule edits, including conversion to conditional or Always; expected versions required |
| POST base + /pause | Disable future automatic decisions and handle pending commands using §7 |
| POST base + /retry-valve | Retry clear-program update for an affected valve after reconciliation |
| GET base + /decisions | Newest-first paginated results, maximum 100 per page |

PUT carries expected_policy_version (null for create), typed policy fields and schedule
edits with UUID, expected_sync_version, device_eui, weekdays_mask, start_time,
duration_minutes, enabled and explicit execution `conditional` or `always`.
Missing UUID creates a row. Omitted rows stay unchanged. Detach/delete is explicit;
reject duplicate IDs, unknown keys and foreign-zone references. Reject conversion
with no targets. Return 200 saved, 202 awaiting push, 400 malformed, 403 forbidden,
409 version/mode/busy conflict, 422 incompatible settings, 503 missing capability.
Every failure includes a stable reason and affected IDs.

Any live policy, even paused, excludes legacy automatic execution. Reject legacy
schedule mutations on managed zones except an explicitly disabled legacy schedule
write: map that to policy pause without copying stale metric/duration fields.
Local and cloud disable-all must include managed policies even when their old legacy
row is already disabled. A pause never converts rows to Always.

The existing disable-all response field disabledSchedules counts distinct authorized
zones whose enabled automatic configuration this request changed to disabled.
Count a zone once when both legacy and policy configuration changed; an already
paused policy with no enabled legacy row contributes zero. This preserves the
legacy-only count while including policy-only zones.

## 9. Cloud compatibility

Add conditional_irrigation_v1 to all three edge capability builders when the schema
and module are installed. Advertise hardware activation readiness separately; an
installed API is not evidence of qualified transport/valves. The server newly returns
supportedSyncCapabilities on authenticated local-sync and bootstrap responses, built
in AuthController and EdgeSyncController respectively.

Store peer support on sync_link_state. A request creates a nonce there and captures
the current server/account/gateway/installation identity; accept a response only when
both still match. Unlink, relink or identity/server change clears support and invalidates
the nonce. Token refresh within the same identity does not invent support. Missing
capabilities means unsupported. This avoids a separate peer table/link_epoch while
rejecting a delayed response after unlink/relink to the same account.

Gate new event emission, delivery and snapshots on current peer support: old servers
dead-letter unknown operations. Never downgrade a conditional schedule to a legacy
payload that looks unconditional. If support disappears, hold new-resource replication
and cloud edits, show compatibility state, and keep already-active local policies
operating. Linked activation requires known support. An unlinked gateway may operate
locally. Any live policy, including a paused policy, selects
`POST /auth/local-sync/conditional-irrigation-v1`. That endpoint checks the same
server capability provider used for responses before delegating once to
LocalSyncService. Unsupported support returns 503
`CONDITIONAL_IRRIGATION_UNSUPPORTED`; old servers return 404. Neither result may
fall back to `/auth/local-sync`. Gateways without live policies keep the legacy route.
This prevents unsupported cloud registration, claims, broker credentials,
installation-link and linked-account mutations, and edge UCI/link finalization.
Local installation-identity maintenance before the request remains permitted.

Record the link attempt in sync_link_state.link_attempt_json, separately from
background capability requests. Capture nonce/context and route from one live-policy snapshot in a short
SQLite transaction. While the attempt is pending, policy mutations return
`link_in_progress`; never hold a transaction across the HTTP request. Finalization
checks nonce/context and returned support before caching support or changing linked
state. Terminal failure releases the fence; interrupted attempts require explicit
reconciliation or a new link attempt that invalidates the old nonce, never a stale
response. A separate probe followed by the legacy route cannot guarantee this across
a rolling deployment. Test absent support in a 2xx response as a local failure.

Cached support cannot protect a later request routed to an older server instance.
When the captured peer context authorizes conditional replication, send every event
batch and snapshot through guarded endpoints:

- `POST /api/v1/sync/edge/events/conditional-irrigation-v1`
- `POST /api/v1/sync/edge/bootstrap/conditional-irrigation-v1`

Each endpoint checks the shared capability provider before any application, gateway
migration or token rotation, then delegates once to the existing authenticated
handler. Preserve protocol-2 limits and per-event results. Old servers return404;
capable binaries with support disabled return503 CONDITIONAL_IRRIGATION_UNSUPPORTED.
Use these routes for normal bootstrap, outbox delivery and both force-sync phases.
Never retry a guarded request through a legacy endpoint. On404/503, leave selected
outbox rows pending, preserve bootstrap cursors, tokens and success timestamps,
invalidate support for the captured peer context, and show compatibility state.
An unsupported or unknown peer may receive a legacy-only payload that omits whole
policy resources and conditional schedules. It must never receive a schedule with
its condition stripped. Capability fields or headers on legacy endpoints cannot
protect against receivers that ignore them.

Add IRRIGATION_POLICY_UPSERTED with zone-authorized policy_uuid aggregate identity,
monotonic sync_version, canonical payload and tombstones. Extend valve schedules with
condition_policy_uuid and effective_from. Policy snapshots precede schedules when
possible; appliers must still accept reversed delivery, keep missing references
unresolved and never treat them as Always. ValveScheduleApplier writes new fields
only if the incoming key is present. Explicit null has meaning; omission preserves.
Runtime update/incident summaries are read-only and separately capability-gated.

Cloud uses UPSERT_IRRIGATION_POLICY, PAUSE_IRRIGATION_POLICY and RETRY_IRRIGATION_VALVE
via REST pending commands with the same validation/version rules as local requests.
Always conversion uses the ordinary atomic policy/schedule edit, not a release command.
Configuration remains pending until edge application, then can remain Updating valve
until pushes finish. Cloud never evaluates or issues conditional scheduled opens.

Include ValveCommandController's open, schedule CRUD, resend and scheduler-status
routes, zonemutation/IrrigationZoneController.disableAllSchedules, sync appliers,
canonicalization, ownership and event catalogs in the change. Extend
verify-edge-sync-contract-vendor.sh's strict file list with
conditional-irrigation-v1.schema.json; preserve its documented staged exceptions
for commands/events rather than asserting all existing contracts are identical.
Deploy server compatibility before edge activation. Downgrade requires disabling
policies, resolving pending commands and completing ordinary fixed/empty plan pushes;
never replace a live database with a seed.

### Cloud policy views and read-only status

Cloud policy routes use `/api/v1/irrigation-zones/by-uuid/{zoneUuid}/irrigation-policy`,
with GET/PUT and `/pause`, `/retry-valve`, `/decisions` actions matching the local
service. Mutation fields use the edge's snake-case names and expected versions.
The route owns zone identity. Materialize missing resource UUIDs before enqueueing
so retries preserve identity. Responses keep edge-applied `policy` and `schedules`
separate from `pending.policy_edit`, `pending.actions` and read-only `runtime`.
A 202 records a requested change, not canonical application or physical delivery.

The new cloud PUT, pause and retry HTTP envelopes require a canonical UUID
`request_id`. The client creates it once per user action and retains it across
network retries. Scope it to the authenticated owner, gateway, zone and action.
The same ID and canonical request reuse the command and materialized resource UUIDs;
a changed request under the same ID returns409. A later deliberate action gets a new
ID and remains subject to version and protected-command conflict rules. Pending views
return the ID and materialized request. Transport metadata carries the request identity;
the adapter removes it before calling the accepted edge policy API. Internal legacy
disable bridges derive a stable pause ID from zone, policy and expected version.

Configuration events cannot carry changing runtime state under the policy version.
Add three capability-gated projections:

| Operation | Stable resource identity | Guarded snapshot list |
|---|---|---|
| `IRRIGATION_POLICY_RUNTIME_CHANGED` | Zone UUID | `irrigation_policy_runtime` |
| `IRRIGATION_POLICY_VALVE_RUNTIME_CHANGED` | Valve EUI | `irrigation_policy_valve_runtime` |
| `IRRIGATION_POLICY_DECISION_UPSERTED` | Zone UUID, schedule UUID, local date and time | `irrigation_policy_decisions` |

Keep existing `VALVE_RUNTIME_CHANGED` unchanged: its timestamp ordering cannot
order independent conditional incidents. Migration0077 adds one local-only
`conditional_irrigation_sync_projections` table keyed by projection kind and key,
with positive `projection_revision`, canonical payload hash and JSON. Cloud adds
three read-only mirrors. Lower revisions are stale; equal revision/equal hash is a
duplicate; equal revision/different hash is a conflict; higher revisions apply.
The envelope sync version equals the payload revision. Timestamps never order
these applies, and ordinary unlink/relink never resets a reused identity's revision.

A short projection transaction reads consistent current source state and commits
the revision, payload and any supported-peer outbox event together. It cannot use a
cached pre-transaction source payload. Source mutations retain their own accepted
transactions; post-commit notification and the existing 60-second tick reconcile
changes after a crash. Reconciliation scans the union of current source keys and
cached projection keys, retaining higher-revision tombstones and counters for retired
or reassigned resources. Ordinary unlink/relink never clears them. Garbage collection
requires proof that the identity cannot recur and its cloud watermark is retired.
Projection failure
cannot change a completed actuator command's result. Clock probes and network work
stay outside transactions. Bootstrap reconciles current source state, then replays
stored payload/revision pairs without rebuilding content under an old revision.

Unchanged scans coalesce by semantic content excluding revision and freshness timestamps.
Allocate a revision only for a source/trust change or a due five-minute refresh.

Zone status contains source choices, qualification, next check, last result and clock
status. Each of source_choices.SWT, VWC and DENDRO is an array.
Valve status contains only policy/zone identity, update readiness and a small
incident summary. Decision summaries contain the occurrence's calendar identity,
policy/schedule versions, result/reason, effective duration and allowlisted evidence:
condition settings, aggregate values, sample counts/timestamps and DENDRO
stress/action/tree count. Exclude raw samples or analysis, control/transport JSON,
queue/command/push IDs, physical-run references, qualification identity and effect
snapshots. No report-only actuation rows enter this protocol. Decision snapshots
contain the newest200 retained summaries per gateway; cloud pagination covers the
mirrored history and uses its own opaque cursor, with at most100 results per page.

Refresh eligible zone and managed-valve status at least every five minutes; changed
state is reconciled on the 60-second tick. Trusted status expires seven minutes after
its edge timestamp, capped in cloud by seven minutes after receipt. Untrusted clock
status has no expiry presented as fresh. Expose unavailable, clock_untrusted, stale
or fresh explicitly; stale or untrusted data cannot make activation look qualified.
The UI may display dated evidence. Cloud never computes qualification or a due time.
Task8a corrects the shared edge next-check preview for newly saved schedules with no
materialized occurrence, using the accepted strict calendar without creating a run.

## 10. Evidence required before activation

Software gates include concurrent SQLite claims, queue flush races, manual conflict
semantics, unknown clock on reboot, both timestamp formats, DST, schedule feasibility,
old-client disable-all, out-of-order sync and an old server that dead-letters unknown
ops. Browser coverage must use a newly built real-application harness; the current
Playwright setup is demo-only. Test all seven locales, touch/keyboard, 320/390/1440px
and both themes, with help overlays that neither overflow nor move the form.

Bench evidence must cover Gen1 clears on every weekday, Gen2 empty-frame acceptance,
delayed/misassigned ACKs, radio outage, queue expiry/flush and power loss during send.
Capture accepted and rejected plan writes, clock ACKs and each scheduler-status
mode on the exact supported generation/firmware to establish command-specific ACK
semantics. Synthetic fixtures cannot supply this evidence.
Measure due-to-enqueue and enqueue-to-observed-open latency at the configured interval,
including queue contention; record maximum and p95 latency, sample count, firmware
and ChirpStack versions. Test at least 20 opens per supported generation, including
worst-phase dispatch, and show every non-expired test open fits its reserved envelope.
Also measure the selection-to-effective-open and selection-to-final-CLOSED/no-flow
bounds for the captured margin B, including short runs, lost endpoint uplinks and
permanent CLOSE near expiry. Verify qualification identity matching and external
magnet/Bluetooth/DI incident detection. A passing sample set does not establish an
unbounded timing guarantee: document the operating envelope and reject profiles
without an established bound. This qualifies an operating setting, not the nonce-free
ACK protocol. Keep activation
disabled for an unqualified generation or transport. No farm deployment is part of
writing or implementing these documents.

Later work may add soil-calibrated VWC presets, weather holds, pulse-and-soak,
shared-pump capacity and calibrated volume targets.

Implementation: [plan](../plans/2026-10-13-conditional-irrigation.md).
Review history: [record](../plans/2026-10-13-conditional-irrigation-review.md).
