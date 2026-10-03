# WATERMARK cloud parity — architectural design

Date: 2026-09-30 · Status: approved architecture; implementation plan deferred

## 1. Purpose and boundary

Phase 1 made the edge the working home of WATERMARK on a Dragino LSN50. The
edge decodes FPort 11, owns calibration, stores raw diagnostics, writes
canonical soil-tension values to `device_data`, and excludes every WATERMARK
observation from irrigation scheduling.

This design defines cloud parity without moving authority away from the edge.
It covers calibration, the existing generic probe-depth fields, the Chameleon
configuration command foundation, cloud contact state, and safe display of
canonical history. It does not admit WATERMARK readings to the scheduler and
does not copy `watermark_readings` to the cloud.

This document supersedes the cloud and scheduler sections of
`2026-09-25-watermark-lsn50-design.md` and the conflicting decisions in the
older Phase 2 and Phase 3 implementation plans. Those plans remain historical
evidence and are not executable.

Migration number `0068` is reserved for the edge part of this work. No other
change may claim that number while this design is active.

## 2. Binding decisions

| Area | Decision |
|---|---|
| Authority | `WATERMARK_CALIBRATION` is an edge-authoritative, device-keyed sync resource. The cloud stores a mirror and desired state; it does not write the mirror directly. |
| Cloud mutations | Calibration, generic probe depths, and Chameleon configuration use the pending-command path. A successful cloud request means queued, not applied. |
| Capabilities | `watermark_v1` gates calibration parity, `chameleon_config_commands_v1` gates Chameleon configuration, and `device_soil_depth_commands_v1` gates generic soil-depth edits. |
| Ordering | The cloud contract and appliers deploy before an edge advertises or emits a new capability. |
| Gateway binding | Every command, event, bootstrap item, and contact observation is accepted only in the authenticated gateway context that currently owns the device. |
| MQTT | An accepted FPort 11 radio contact produces a contact-only MQTT message. It contains no reading or diagnostic values. |
| Time | Existing `Device.lastSeen` / `devices.last_seen` records contact. Existing `Device.currentStateRecordedAt` / `devices.current_state_recorded_at` records the canonical snapshot observation. No timestamp column is added. |
| Raw data | `watermark_readings`, payload bytes, ADC codes, resistance, offset, supply, die temperature, channel flags, and conversion diagnostics remain edge-local. |
| History labels | Historical `swt_1` and `swt_2` remain **Soil tension 1** and **Soil tension 2** until row-level sensor provenance exists. Current calibration state must not relabel old rows. |
| Qualification | Phase 2 qualification work is non-blocking. Phase 3 scheduler admission remains disabled until an independently referenced, versioned qualification policy is approved and implemented. |

## 3. Shipped baseline

- Migration `0061__watermark_lsn50.sql` owns `watermark_calibrations` and
  `watermark_readings`. Neither table has a sync trigger.
- Canonical WATERMARK values already travel in ordinary `DEVICE_DATA_APPENDED`
  history and history-correction traffic as `swt_1`, `swt_2`, and
  `ext_temperature_c`.
- Generic probe depths and `chameleon_enabled` are fields on `devices`; they
  therefore belong to the existing `DEVICE` aggregate rather than new mirror
  resources.
- The phase 1 scheduler interlock rejects every `device_data` row linked to a
  `watermark_readings` row. This design leaves that interlock in place.
- FPort 11 is currently dropped by the generic telemetry builder, so it does
  not update cloud liveness.
- Cloud `effectiveObservedAt` keeps its existing meaning and computation.

## 4. `WATERMARK_CALIBRATION` resource

The aggregate key is the uppercase device EUI. The resource contains:

- `gateway_device_eui` and `device_eui`;
- the four channel-1 electrical coefficients and four channel-2 electrical
  coefficients already stored at the edge;
- `measured_at`, `method`, `worst_residual_pct`, and `notes`;
- `sync_version`, `updated_at`, and `deleted_at`.

The event names are `WATERMARK_CALIBRATION_UPSERTED` and
`WATERMARK_CALIBRATION_DELETED`. The corresponding commands are
`SET_WATERMARK_CALIBRATION` and `DELETE_WATERMARK_CALIBRATION`. Commands carry
the desired-state ledger's base version. Calibration keys have these exact
formats:

- `watermark_calibration:set:{gateway_eui}:{device_eui}:{base_sync_version}`;
- `watermark_calibration:delete:{gateway_eui}:{device_eui}:{base_sync_version}`.

The terminal command ledger stores and verifies a trusted binding hash over
command type, resource, device, gateway, local actor UUID, base version,
operation, and normalized intent. The effect-key contract requires that same
persisted base and binding; a key alone is not proof of equivalence.

Migration `0068__watermark_cloud_parity.sql` adds linked-gateway outbox
triggers for calibration upserts and tombstones. It must not add a trigger for
`watermark_readings` and must not modify the frozen boot-DDL block.

Bootstrap and force-sync snapshots include the live calibration row or its
tombstone. This prevents a calibration saved before account linking from being
stranded. The cloud treats an event whose device dependency has not arrived as
retryable rather than terminally invalid.

Each snapshot item carries its effective operation, including
`WATERMARK_CALIBRATION_DELETED` for a retained tombstone. After snapshot
application, including when an older item is ignored, bootstrap reloads the
retained canonical mirror and calls `DesiredStateService.observeMirror` with
that retained row's effective operation, payload, and version. It never reports
the incoming snapshot item as the retained state. Bootstrap can replace a
missing mirror event; it cannot replace a missing acknowledgement. A lost
acknowledgement requires durable command replay or redelivery before the
ACK-plus-mirror convergence rule can mark the operation applied.

The cloud maintains both the calibration mirror version and the resource
watermark. Base selection uses the maximum retained mirror and resource-
watermark version and never falls back to zero because the live row is deleted.
Equal-version identical input is a replay; equal-version divergent operation
or payload is rejected. A missing parent device remains retryable.

The local calibration GET exposes a retained tombstone's `sync_version` and
deleted state. Recreate therefore quotes the tombstone version as its exact
base instead of starting from zero. Cloud GET and pending-state responses
preserve the same base.

Payload comparison gives coefficients and residuals one canonical JSON numeric
representation before hashing. For optional metadata, omission means keep the
stored value and
explicit `null` means clear it. Desired state, the event payload, mirror
comparison, and binding hash use those same normalized semantics.

The edge command applier must call the same transactional writer as the local
API. Validation, optimistic concurrency, tombstones, and calibration backfill
therefore have one implementation.

Command handling follows this order:

1. Build trusted actor, gateway, device, resource, base, operation, and intent
   context; validate semantic key binding.
2. For an existing `commandId`, return the recorded terminal result only when
   its trusted binding hash matches. Otherwise refuse the replay.
3. For an existing effect key, return the recorded terminal result only when
   its trusted binding hash and normalized intent match. Different intent is a
   conflict.
4. Otherwise commit the local mutation and terminal ledger result atomically.

## 5. Pending-first configuration foundation

All cloud-originated writes follow one sequence:

1. The cloud validates the actor, gateway capability, device binding, and a
   confirmed edge base. Calibration uses the higher retained calibration or
   resource-watermark version, with zero for first creation. Chameleon and
   soil-depth writes require the accepted `DEVICE` resource watermark.
2. It records desired state and queues a pending command. The API returns
   `202 Accepted` with the command state.
3. The edge verifies the authenticated target and exact base version, applies
   the local writer, and acknowledges the command.
4. The cloud updates its mirror only when the edge event or a later snapshot
   arrives.
5. The command becomes applied only when acknowledgement and mirrored state
   converge. Conflicts, rejection, timeout, and supersession remain visible.

This foundation covers three mutations:

| Cloud intent | Edge-owned target | Command |
|---|---|---|
| Save or delete WATERMARK calibration | `watermark_calibrations` | `SET_WATERMARK_CALIBRATION` / `DELETE_WATERMARK_CALIBRATION` |
| Save generic soil-moisture probe depths | the existing depth fields on `devices` | `UPSERT_DEVICE_SOIL_DEPTHS` |
| Enable or disable Chameleon configuration | `devices.chameleon_enabled` and its existing local writer | `SET_CHAMELEON_CONFIG` |

Their exact effect keys are:

- `device_soil_depths:set:{gateway_eui}:{device_eui}:{base_sync_version}`;
- `chameleon_config:set:{gateway_eui}:{device_eui}:{base_sync_version}`.

The generic depth fields and `chameleon_enabled` continue to converge through
the `DEVICE` aggregate. They do not acquire separate mirror tables. Their
commands still need explicit registry, router, contract, capability, and
effect-key coverage; sharing a target aggregate is not permission to bypass
pending state.

Cloud forms show pending values separately from confirmed edge values. A page
refresh must not make an unacknowledged value look applied.

For every rewrite, `DesiredStateService.canRewrite` must verify the same
persisted base version and trusted effect binding that command creation used.
It must not authorize a rewrite from resource ID and command type alone.
Only one protected mutation may remain unresolved for a DEVICE resource. A
same-type request may reuse its exact pair only before exposure; an exposed
same-type request and every overlapping protected type are refused until the
predecessor resolves. Reuse also requires that pair to be the latest retained
operation for the resource; shadowed or ambiguous history requires
reconciliation.

### 5.1 Capability contract

All three edge capability builders, `sync-bootstrap-build`,
`al-link-build-req`, and `sync-force-build`, emit identical tokens:

- `watermark_v1` only when calibration set/delete, snapshots, events, and their
  exact-base applier are installed;
- `chameleon_config_commands_v1` only when the exact-base
  `SET_CHAMELEON_CONFIG` applier is installed;
- `device_soil_depth_commands_v1` only when the exact-base
  `UPSERT_DEVICE_SOIL_DEPTHS` applier is installed.

`LinkedGatewayAccountService.applyEdgeCapabilities` persists the three tokens
as `LinkedGatewayAccount.watermarkSupported`,
`chameleonConfigCommandsSupported`, and
`deviceSoilDepthCommandsSupported`. `LinkedGatewaySyncService` exposes those
same booleans in the linked-gateway summary.

`WatermarkCalibrationController` gates calibration commands with
`watermarkSupported`. `DeviceController` gates Chameleon and soil-depth
commands with their corresponding booleans. The frontend
`gatewayCapabilities` helpers and the calibration, Chameleon, and depth forms
use the same three summary fields and fail closed while capability state is
loading or absent.

Advertising a token asserts that the named exact-base applier is installed; a
registry entry or schema enum by itself is insufficient.

Before a planned edge downgrade, the cloud activates the durable delivery
fence. The fence blocks new issuance and first REST delivery. It may atomically
cancel only proven-never-exposed `PENDING` work; exposed work may receive only
immutable REST replay, and only while the gateway still advertises the required
capability. An expired lease, retry exhaustion, or a lost response does not
resolve exposed work. Applied work resolves after both an authoritative applied
result and mirror convergence arrive, in either order. An authoritative
non-application result resolves without mirror convergence.

`safeToDowngrade` requires an active fence, zero unresolved protected
operations, and zero malformed protected deliveries. After the edge downgrade,
the fence remains active until an authenticated capability report confirms the
three tokens are absent and a second safety check passes. Protected work never
falls back to a generic or permissive handler.

### 5.2 Mutation authorization

Command issuance and edge application both require an enabled account and a
mutation-capable role. The command carries a resolvable gateway-local actor
UUID; a cloud numeric account ID is never accepted as actor identity.

Assigned devices use the existing zone owner and grant checks. This includes a
gateway `ADMIN`: that role is not blanket device access. An unassigned device
means `irrigation_zone_id IS NULL` and permits only the approved
mutation-capable owner/admin exception.
Non-null assignments that point to a missing, deleted, or foreign zone fail
closed and never fall through to the unassigned exception. Device types and
mutation scopes stay limited to the three operations in this design.
Account-wide read permission grants no mutation right.

## 6. Gateway and device binding

The authenticated gateway is part of the authorization boundary, not display
metadata.

- A cloud command is sent only to the device's current gateway binding.
- The edge rejects a command whose `gateway_device_eui` differs from its
  resolved local gateway identity or whose device is not locally owned by
  that gateway.
- The cloud accepts ordinary configuration, event, and snapshot mutations only
  when the authenticated gateway matches the device's current non-null binding.
- A device move invalidates pending commands addressed to the previous
  gateway. They are not silently replayed on the new gateway.
- Aggregate concurrency remains device-keyed; gateway validation prevents two
  gateways from writing the same device stream.

Two observation paths have a narrower rule for an existing null-bound sensor:
durable history and forwarded contact. The exception applies only when the
stored device type is `KIWI_SENSOR`, `TEKTELIC_CLOVER`, `DRAGINO_LSN50`,
`SENSECAP_S2120`, `DRAGINO_SDI12`, or `AQUASCOPE_LORAIN`. The stored type is
authoritative; a type supplied by the observation cannot change the row or make
an ineligible row eligible. An authenticated observation from a gateway may
persist the durable history row through the existing history behavior, or it
may advance monotonic contact time, while leaving the binding null. Neither
path binds or rebinds the device. A different non-null binding is foreign and
the cloud rejects the observation.

The observation writer locks the device row and rechecks the binding and stored
type immediately before mutation. If an assignment to another gateway commits
before the observation acquires that lock, the observation is rejected. If the
observation holds the lock first, it may finish against the still-authoritative
binding; the assignment waits and becomes authoritative afterward. A
durable-history write may update the canonical measurement state that the
existing history path already maintains; the forwarded-contact path cannot.
`EdgeOwnershipService` remains strict and unchanged. Callers use this exception
only in the two named observation paths rather than weakening ordinary ownership
checks.

The existing null-bound `STREGA_VALVE` observation and MQTT-history path remains
separate. It keeps its current validation and mutation behavior and is not
folded into the six-type sensor contact exception.

All EUIs are canonical uppercase hexadecimal strings at the contract boundary.
Fixtures, when needed, use the documented example range starting at
`A840410000000001`.

## 7. Contact-only FPort 11 MQTT

Every structurally attributable FPort 11 uplink may refresh contact state even
when frame validation, calibration, or a channel conversion fails. The message
uses the existing authenticated gateway telemetry route and contains only the
gateway identity, child device identity, device type, radio port, and observed
time needed to establish contact.

The trusted gateway identity comes from the MQTT topic and authenticated
connection, never from a payload field. On first contact, the router calls the
four-argument `DeviceService.upsertFromHeartbeat(deviceEui, type, null,
gatewayEui)` with that trusted topic gateway. A new device is created with the
binding. For an existing device, the stored type controls eligibility. A
matching non-null binding may advance contact; a null binding may do so only
for one of the six sensor types listed in section 6. The update leaves a null
binding unchanged. A different non-null binding is foreign and rejected
without refreshing contact.

The contact writer locks the device row and performs a final binding check
before updating it. A concurrent assignment to another gateway therefore
rejects the contact instead of letting the earlier null-binding check win.
Only an explicit authenticated inventory or sync repair may establish a
binding for an existing null-bound device; MQTT never binds or rebinds it.

It must omit:

- `swt_1`, `swt_2`, soil temperature, and any other canonical measurement;
- payload bytes, ADC codes, flags, resistance, offset, status, supply, and die
  temperature;
- calibration coefficients or versions and conversion versions.

Contact updates existing `Device.lastSeen` / `devices.last_seen`. Canonical
snapshot observation updates existing `Device.currentStateRecordedAt` /
`devices.current_state_recorded_at`. No new timestamp column is introduced.
An accepted frame may advance the canonical snapshot time even when one or
both channel values are null; frame acceptance and channel value availability
are separate facts. A rejected frame updates contact only.

A forwarded-contact update changes only monotonic `lastSeen`. It does not
change canonical state, `currentStateRecordedAt`, IP address, stored device
type, or history. Durable history remains a separate path and may update its
canonical measurement through the existing history behavior described in
section 6. The null-bound `STREGA_VALVE` observation and MQTT-history behavior
also remains separate from this contact-only sensor path.

The LSN50 response derives online state and contact age from `lastSeen` and
exposes `currentStateRecordedAt` separately for measurement age.
`effectiveObservedAt` remains unchanged.

Both timestamps are monotonic per device. Duplicate or older messages may be
acknowledged, but they cannot move either value backwards. A contact message
must never create a canonical history row, advance `currentStateRecordedAt`,
or refresh current sensor values.

## 8. Cloud display and historical provenance

Cloud parity exposes confirmed calibration, pending calibration edits, generic
probe depths, contact age from `lastSeen`, measurement age from
`currentStateRecordedAt`, and the canonical soil-tension history already
synchronized through `device_data`.

Calibration existence means only **calibration configured**. It is not proof
that the latest frame used that calibration, that a WATERMARK circuit is still
connected, or that the installation is qualified for irrigation.

History channels are labelled **Soil tension 1** and **Soil tension 2**. The
cloud must not infer row provenance from the device's current calibration,
current firmware, or latest contact. WATERMARK-specific historical labels can
be introduced only with an immutable per-row provenance field and a compatible
history contract.

Cloud displays do not expose edge-only diagnostics. Operators who need channel
flags, resistance, offset, supply, die temperature, or raw payload evidence use
the edge diagnostic view and the qualification record.

## 9. Qualification and scheduler boundary

Qualification improvements may be documented and tested during Phase 2, but
none is a release gate for cloud parity. The scheduler interlock remains the
only executable policy: WATERMARK observations cannot drive irrigation.

Any future Phase 3 admission design must require all of the following before
it can be enabled:

- accuracy against an independent soil-water-tension reference; continuity,
  interpolation, and rolling-median checks establish self-consistency only;
- resistor-fit evidence for both channels and both polarities, including
  cross-channel interference, ground state, supply range, and the installed
  cable length;
- per-depth soil temperature, or recorded evidence that one DS18B20
  measurement represents both probe depths within the accepted limit;
- a versioned applicability envelope covering resistance and kPa range,
  temperature, supply, cable, grounding, channel, placement, and relevant
  salinity or EC observations;
- explicit per-channel freshness, minimum-point, hysteresis, and re-arm rules.

The policy must judge individual samples without smoothing or interpolation.
Smoothing may support diagnostics and trends, but it cannot turn an ineligible
sample into scheduler input.

A material calibration change means a change to any of the eight electrical
coefficients. It revokes an existing qualification and requires new evidence
plus explicit human reacceptance. Metadata-only changes do not revoke it.
Updating coefficients must never advance an accepted calibration version
automatically.

The exact independent-reference tolerance and scheduler freshness/hysteresis
limits are intentionally not selected here. Until a later approved design
fixes them and implements a separate admission resource, admission stays
disabled.

## 10. Failure and conflict semantics

- A stale calibration or DEVICE base version is acknowledged as a conflict;
  the cloud retains the confirmed edge state and exposes the failed intent.
- If the accepted `DEVICE` resource watermark is absent, protected DEVICE
  issuance returns `409 reconciliation_required` and queues nothing.
- A same-type edit after exposure, or a different protected DEVICE edit while
  one is unresolved, returns a conflict rather than creating a replacement.
- A command for a foreign gateway or device is rejected without mutation.
- An acknowledgement without the matching mirror event does not mark desired
  state applied. Reconciliation or a snapshot must close the gap.
- Durable command-ID replay is checked before effect-key replay. Either replay
  returns its recorded terminal result only when the trusted binding hash
  matches; a same key with different intent or context is a hard conflict.
- An event that arrives before its device is retried. An event with a mismatched
  gateway binding is quarantined rather than rebound.
- DEVICE desired state observes the retained `Device` row after application,
  not the submitted event payload. If its gateway, resource, or exact version
  cannot be proven, the event remains retryable and does not advance its
  resource watermark.
- MQTT contact continues during calibration absence or conversion failure, but
  `currentStateRecordedAt` and history do not advance unless a canonical
  snapshot is accepted.
- Deleting calibration produces a tombstone. It does not delete canonical
  history or rewrite historical labels.

## 11. Rollout and compatibility

1. Deploy cloud contract acceptance, mirror schema, event appliers, pending
   command support, and neutral UI first.
2. Deploy edge contracts, migration `0068`, command routes, snapshot fields,
   capabilities, and contact-only publishing.
3. Enable cloud write controls only for gateways advertising the exact command
   capabilities they implement.
4. Reconcile a pre-existing edge calibration through bootstrap before allowing
   a cloud edit against it.

Older gateways continue to sync ordinary `device_data`. They expose neither
the new forms nor a false WATERMARK classification. During mixed-version
rollout, unsupported commands remain unavailable rather than falling back to a
direct cloud write.

The upgraded E2 edge routes only the identified legacy soil-depth shape through
its compatibility path. The payload requires `deviceEui`, `gatewayDeviceEui`,
`soilMoistureProbeDepthsJson`, `soilMoistureProbeDepthsConfigured`, and
`syncVersion`; it permits only a matching redundant `commandType` in addition.
The path retains the transport command ID and legacy version semantics. It does
not fabricate an actor, exact base, or protected metadata, and malformed or
mixed protected payloads cannot fall back to it.

A pre-E2 rollback target uses the older `Build UPDATE SQL` path. That code does
not read protected `values`; given a protected payload, it sees no top-level
depth map, writes `{}`, and defaults the configured state to enabled. The
delivery fence must therefore reach `safeToDowngrade` before rollback.

## 12. Acceptance conditions

Implementation planning must preserve these observable outcomes:

- a local calibration upsert and delete each produce one device- and
  gateway-bound event; redelivery does not duplicate mutation;
- bootstrap and force sync converge calibrations saved before linking;
- bootstrap applies retained tombstones, reloads the retained row before
  `observeMirror`, closes a lost-event operation, ignores a stale snapshot
  without reporting it as convergence, retries a missing parent, and rejects
  divergent equal-version state;
- bootstrap alone does not close a lost-acknowledgement operation; durable
  command replay or redelivery supplies the missing acknowledgement before
  ACK-plus-mirror convergence can mark it applied;
- successfully applied calibration, depth, and Chameleon cloud writes remain
  pending until the edge acknowledgement and mirror convergence both arrive,
  in either order; definitive non-application settles without mirror
  convergence;
- DEVICE writes cannot queue without a confirmed resource watermark;
  calibration alone may use zero for first creation;
- `DesiredStateService.canRewrite` refuses a changed base or trusted effect
  binding, any exposed command, and every ambiguous or overlapping unresolved
  pair;
- DEVICE convergence uses retained canonical state and cannot be completed by
  a submitted payload that the canonical row did not accept;
- all three builders report identical capability sets; cloud persistence,
  controller issuance, and GUI gates use the exact token for each operation;
- negative authorization tests cover a viewer, disabled account, foreign
  owner, missing local actor identity, absent zone grant, and non-null dangling
  assignment. Each is denied at cloud issuance and edge application;
- a gateway `ADMIN` without the assigned zone grant is denied, while the narrow
  owner/admin exception works only when `irrigation_zone_id IS NULL` on an
  otherwise eligible device;
- exact `commandId` replay and same-intent effect-key replay return the recorded
  result; changed binding or intent conflicts without mutation;
- an FPort 11 contact advances `lastSeen` without advancing
  `currentStateRecordedAt`, current values, or history;
- first contact binds a new device to the trusted topic gateway through the
  four-argument writer; foreign devices are rejected, while eligible null-bound
  sensors may advance contact without being rebound;
- an accepted canonical frame can advance `currentStateRecordedAt` with null
  channel values, while a rejected frame cannot;
- no WATERMARK raw-reading or per-reading diagnostic field appears in a sync
  event, bootstrap, or MQTT contact payload;
- existing LSN50 FPort 2 ingest and assigned-device behavior are unchanged;
- historical channels remain Soil tension 1/2 before and after calibration
  edits;
- every WATERMARK-linked `device_data` row remains excluded from the scheduler.

## 13. Explicitly deferred work

- A calibration-fit wizard. It is a useful Phase 2 operator aid, but equivalent
  manually recorded resistor evidence remains valid.
- Cloud display of board temperature, supply, conversion status, and version.
  If added later, board temperature must be labelled as a board diagnostic,
  never soil or ambient temperature, and an invalid firmware status must show
  unavailable rather than a numeric value.
- Row-level WATERMARK provenance in canonical history.
- Raw-diagnostic cloud storage or synchronization.
- A Phase 3 scheduler-admission resource and its exact sampling policy.
- KIWI conversion changes.

The field qualification runbook is
`docs/operations/watermark-field-qualification.md`. The deferred-work index is
`docs/superpowers/plans/2026-09-29-watermark-deferred-work.md`.
