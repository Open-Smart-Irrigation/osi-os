# Conditional irrigation document review

Created 2026-10-13; revised 2026-10-16. Scope: specification and implementation plan.

The earlier statement that no required findings remained is withdrawn. That review
used a stale base and introduced a valve-side attestation requirement that excluded
Gen1 and remote users. It did not establish implementation readiness. This record
supersedes its conclusions and its claimed schema validation as evidence for the
revised design; the new proposed schema has not been rehearsed yet.

Documents:

- [Design](../specs/2026-10-13-conditional-irrigation-design.md)
- [Implementation plan](2026-10-13-conditional-irrigation.md)

## Evidence and scope

Fetched origin/main in both repositories on 2026-10-16, without changing the checked-out
branches. Edge origin is `f130073205aa26abaa5d71097b354df39e9fe753`; server origin is
`113696c1bcdb27747a8fe62c1158dcdf0168695f`. Local edge main is one documentation commit
ahead and 63 upstream commits behind; local server is 42 behind. Edge migrations
0068–0073 are already present. Read-only source snapshots of those refs were used
rather than the dirty local runtime files.

An independent review context, `review_irrigation_docs`, rechecked empty-plan encoding,
ACK matching, queue flushing, observed-run classification and dendrometer behavior
against those pins. The author checked the affected UI, migration compatibility and
trigger ownership, cloud controllers/appliers, capability responses and vendor gate.
ChirpStack 4.12.1 source confirms strict queue-expiry comparison and the absence of
expiry in its MQTT command schema; the design links those primary sources.

No product code was edited, application builds run, migration rehearsal performed,
valve actuated, or production host accessed for this revision. Documentation checks
are recorded below and do not substitute for implementation or hardware evidence.

## Required findings and disposition

| Finding | Revision |
|---|---|
| R1: stale origin bases and occupied migration numbers | Replaced baseline with fetched commit pins, current source behavior and migration head 0073. Plan uses provisional 0074/0075 and requires rechecking numbers at execution. |
| R2: operator inspection excludes supported users/valves | Removed attestation, ownership table and release projection. Ordinary edits compile conditional rows out, supersede old pushes, flush and push empty programs; all clear ACKs gate dispatch. Reversion uses ordinary fixed-plan pushes. |
| R3: expiry too short and flush fate undefined | Separated inclusive 10-minute decision grace from radio delivery allowance; added explicit per-valve interval setting because no stored interval exists. Budget/exclusion cover possible delivery through expiry plus duration. Flush invalidates queue IDs, never blindly resends and retains ambiguity. Latency/expiry tests gate activation. |
| R4: guard described as pre-existing; incomplete writer inventory | Spec states shared transactional guard is new and conflicting manual opens become valve_busy. Plan inventories simulation, all four MQTT outputs, gRPC and cancellation/plan/status/clock writers. |
| R5: incorrect legacy DENDRO threshold/cloud claims | Documented upstream threshold downgrade and continued legacy maintain/hold watering. New local-only evidence uses an independent stress predicate and hold veto; preview discloses changed behavior. Tests include disabled legacy filter and stale cached downgrade. |
| R6: nonexistent sensor cadence data | Removed observation_window_too_short rule. Every selected source must still provide a valid sample. New actuator delivery interval is explicit configuration, not fictitious sensor metadata. |
| R7: process time, timezone conflict, stale clock and timestamp format | Preview actual legacy 06:00 process time; policy timezone is authoritative and mismatches return 422. Add boot-scoped NTP trust, rollback guards and normalized UTC/ISO observation times. |
| R8: invalid conversions silently skip | Validate complete schedule set against maximum adaptive duration, delivery allowance, gap and per-day budget. Return422 with affected rows; test 2 × 180 min/day and 30-minute pulse separation. |
| R9: standalone UI breaks custom values and accessibility | Slice A removes rounding/clamping/reset paths and duplicate drawer schedule writes. Extract ValveControlHelp as disclosure-style toggletip with persistent DOM target, visibility assertions and valid anchored role-name queries. Recommended stays inside Moist help. |
| R10: incomplete cloud paths and unsupported event emission | Include EdgeSyncController and ValveCommandController, new server capability responses, conditional absent-field writes, managed-zone disable-all and new contract file in vendor list. Gate event creation/delivery/snapshots against current peer support. |
| R11: unsafe/redundant schema design | Use additive trigger swaps, update MIGRATION_OWNED_TRIGGERS and transfer valve-trigger ownership from 0024. Added schedule column has no REFERENCES; no ownership table or restrictive new device/zone FK. Rehearse compatible-column/renumbering paths. |

Two qualifications to the external review are retained. First, compileWindows does
not already know the new condition column; exclusion is implementation work.
Second, current on_valve_schedule classification uses local windows and can miss a
stale fixed run after conversion. The new observer must also record unexplained
opens. ACK ambiguity is not bounded to “one extra run”: repeated watering may occur
before observation, and absent telemetry cannot prove no external watering occurred.

DENDRO maintain is not universally prohibited. If local stress independently passes
the chosen threshold, maintain uses base duration; below-threshold maintain skips.
Rain/recovery holds veto even with high stress. This avoids treating an action code
as a substitute for the predicate.

## Additional review requests

| Item | Decision |
|---|---|
| Browser harness did not exist | Plan explicitly creates a real-app Playwright config, fixture routes and tests. Demo/design-preview are not counted as production GUI coverage. |
| Locale parity | New strings live in valves.json; add full-depth checks in both frontends. |
| Missing scenarios | Add pending-open flush, untrusted reboot clock, both timestamp formats, managed disable-all, old-server dead-letter behavior and converted DENDRO hold. |
| Unused OSI_IDENTITY_BASE_REF | Removed from this plan; its consumer is not among these checks. |
| Separate peer table/link_epoch | Replaced with current-link cache and request nonce on sync_link_state; unlink/relink invalidates stale responses even for the same account. |
| Late-reading rule | Use evidence present at decision with recorded_at <= dueAt; no later reconsideration. |
| Duplicate occurrence identity | Single composite primary key; command_id uniqueness serves command idempotency only. |
| Dendrometer mode count | Fixed and proportional only for new policies; preview legacy ignored response_mode explicitly. |
| Expiring ONCE commands | Deferred as separate behavior; unresolved old-path commands block conditional dispatch. |
| Missed-start lookback | Capped at 24 h from last trusted tick, SKIPPED/missed_start consistent with ONCE terminology. |
| Dry preference/status label clash | Keep 20/30/50 values and existing status boundaries; help explains preference versus current status. |

## Remaining qualification gates

This revision removes the known documentary blockers; it does not certify a
controller. Implementation must demonstrate all-writer serialization, transaction
idempotency, compatible migrations, cloud gating and real GUI behavior. Hardware
qualification still includes the Gen2 one-byte clear frame, NTP event integration,
actual queue expiry and measured Class A delivery latency for both generations.

Slice A can be implemented and reviewed independently with the preservation and
accessibility fixes included. B remains inactive infrastructure. C remains gated on
software and bench evidence. The ACK protocol's inability to identify a program
revision remains a documented operating limitation after those tests.

## Documentation validation

The prose checker passed with no tier-1 findings. All relative Markdown links
resolved; the documented origin pins matched the fetched refs, and existing edge
verification-script paths were checked against that origin. The obsolete endpoint,
migration-name and invalid test-option scan passed. `git diff --check` passed for
the three documents. Requirement coverage is mapped in the plan's final table.

The independent follow-up found one remaining contradiction in the old review
record while it was being rewritten. After rereading this replacement, the reviewer
confirmed that the record, spec and plan agree. That is a document-consistency
result, not implementation approval or a software/hardware test result.

## Implementation preflight, 2026-10-17

Sol identified a transport-ordering gap before Task 4 implementation. The existing
QoS 0 MQTT sinks have no ChirpStack acceptance response; a lock around node.send
cannot prevent an old plan publish from arriving after a gRPC flush. Even a broker
PUBACK would not establish that ordering. Sections 7–8 and Tasks 3–4 now require
every STREGA queue write to await gRPC enqueue under the shared device writer gate,
with durable intent and queue ID. Ordinary commands keep their no-expiry behavior.
Local transport_json on push/expectation rows records uncertainty separately from
valve ACKs, and an uncertain ordinary enqueue blocks conditional operation.
Non-STREGA commands may continue using the shared MQTT output. This expands the
ordinary-valve transport regression surface; it does not remove the device ACK
ambiguity or the bench qualification gates.

The local DENDRO evidence contract was also clarified: normal daily analysis saves
its raw decision before legacy filtering. Cached rows without it remain UNKNOWN
until the next normal calculation. Conversion never replays stateful analytics,
which may defer the first new DENDRO decision.

## Link handshake execution correction

Sol verified that LocalSyncService commits claims and credentials before returning
capabilities. Section9 and Task7 now require a guarded conditional-policy link route
that checks support before delegation, with no legacy fallback. A durable local
link attempt fences policy mutations without holding a transaction across HTTP.
This preserves old-server linking for gateways without live policies and prevents
unsupported registration or link mutations. Local identity maintenance remains
permitted. The cost is one endpoint plus link-attempt recovery coverage.

## Replication delivery execution correction

Sol confirmed that an old server can dead-letter the policy event while applying
its schedule as an ordinary schedule, or accept a bootstrap after discarding its
policy collection. Cached support does not protect a later request after rollback
at the same URL. Section9 and Task7 now require guarded event and bootstrap routes
that check support before application and reuse existing authenticated handlers.
Unsupported requests have no legacy fallback and leave local delivery state pending.
This adds two endpoints and covers ordinary delivery plus force sync. The focused
server tests establishing the old-receiver behavior passed; implementation remains
part of Task7. Sol’s scoped documentary follow-up accepted the amended contract.

## Clock hook execution clarification

Sol verified the exact BusyBox1.36.1 source and OpenWrt callback adapter. Only
ACTION=stratum with lowercase stratum1–15 proves synchronization. An unsync event
reports missed peer replies and does not change wall time. Deleting the marker
there would contradict section5's same-boot offline operation. The hook now preserves
the last-good marker on unsync and other ignored events; runtime boot/progression
checks reject discontinuities. This resolves the plan's earlier invalidation rule.
The physical hotplug test remains unrun.

## Flush evidence execution clarification

Sol checked the ChirpStack4.12.1 queue and radio paths. A nonpending queue item can
already be copied into a radio task when FlushQueue deletes its database row. The
flush response does not identify a pre-radio deletion. Section7 and Task4 now pin
all accepted-item snapshot cases to UNKNOWN and prohibit automatic rebuild from
that evidence. Only never-attempted local work or a proven pre-acceptance failure
can use the current local expiry path. This changes cancellation's queued-plan/
configuration recovery; the caller must see the uncertainty. Hardware qualification
and full reservations remain required.

The scoped documentary follow-up accepted the flush rule and identified Task5's
reconciliation boundary: after all current clear ACKs, older superseded known
plan/status pushes stop blocking readiness while their UNKNOWN audit outcome stays.
Timed-open and opaque uncertainty still blocks. The spec and plan now require a
focused test for this boundary; it does not claim proof of physical non-delivery.

## Command effect core review

Sol approved Task4c1 at `3d3346e18` after three scoped fix rounds. Persisted frames now
determine effect identity before either conflict release or accounting; a coherent
class relabel cannot reduce a command's charge. Clock checks retain every past
lower bound and compare horizons with the same runtime instant they validated.
Owner-specific OPEN/CLOSE order, qualified physical bounds and immutable manual,
ONCE and conditional anchors are covered by public API tests. The final paired
profiles each pass 16 focused and 429 combined valve/policy tests. Live writer
composition and telemetry production remain Task4c2.

The conversion ACK preflight separately found that the available HW4/5 manual cannot
establish Gen1 success polarity. Section6 now distinguishes provisional ordinary
Gen1 weekday/clock bookkeeping from conditional proof. Gen1 scheduler-status can
remain pending and fail stale until a verified rule exists; release evidence must
show that behavior. Sol accepted this documented boundary. No hardware result is
inferred from the synthetic fixtures.
