# AgroLink schedule and irrigation-calibration parity design

**Status:** Approved for autonomous execution by the AgroLink parity
orchestrator.

**Scope:** Task 8, row 2. This design covers zone irrigation schedules and the
measured zone flow-rate calibration used to estimate timed valve volume. It
does not change valve actuation, device configuration, irrigation-event
history, or the scheduler algorithm.

## Current behavior and gaps

The edge owns both resources:

- `PUT /api/irrigation-zones/:id/schedule` writes one
  `irrigation_schedules` row per zone.
- `POST /api/irrigation-zones/:id/calibration` writes one
  `zone_irrigation_calibration` row per zone.

Schedule updates increment `sync_version` and emit `SCHEDULE_UPSERTED`. OSI
Server mirrors that event and can issue legacy `UPSERT_SCHEDULE` commands, but
cloud edits bypass durable desired state. The legacy edge command uses an
unconditional SQL upsert, so it does not enforce a base version or preserve a
terminal conflict.

Irrigation calibration has no sync version, event, server mirror, cloud API,
or pending command. The edge GUI can edit the measured flow rate and
measurement method; the cloud GUI cannot display or edit them.

The schedule vocabulary also differs. The edge table accepts:

```text
SWT_WM1 SWT_WM2 SWT_AVG SWT_1 SWT_2 SWT_3 DENDRO
```

The server additionally accepts `SWT_WM3` and `VWC`, which an edge-backed
schedule cannot store. Those values remain valid for a cloud-local zone, but
an edge-backed editor must use the edge vocabulary. An existing unsupported
value remains readable and requires an explicit supported choice before it
can be saved to an edge-backed zone.

## Domain boundaries

Schedule and irrigation calibration are separate aggregates keyed by the
zone UUID. A schedule edit must not consume the calibration version, and a
new bucket-test result must not conflict with a pending schedule change.

One capability, `irrigation_config_desired_state_v1`, activates both protected
consumers. The edge advertises it only after its schedule and calibration
handlers, schemas, and outbox paths pass. OSI Server stores the capability per
linked gateway and issues protected commands only when it is present. Older
gateways retain their existing schedule command behavior and do not expose
cloud calibration mutation.

## Portable resources

### Schedule

The canonical command and desired-state object contains:

- `contract_version`
- `zone_uuid`
- `gateway_device_eui`
- `trigger_metric`
- `threshold_kpa`
- `enabled` as `0` or `1`
- `duration_minutes`
- `response_mode`
- `sync_version`
- `deleted_at`
- `last_applied_at`

The trigger metric uses the seven-value edge vocabulary. `duration_minutes`
is an integer from 1 through 240. `response_mode` is `proportional`, `fixed`,
or `aggressive`. SWT thresholds are finite values from 1 through 300 kPa.
Dendrometer thresholds are the integers 1 through 4.

`last_triggered_at` is scheduler runtime state. It remains a read-only mirror
and is excluded from desired-state comparison. Cloud edits cannot forge a
prior scheduler execution.

`UPSERT_SCHEDULE` is the protected command. `UPDATE_SCHEDULE` and the existing
unprotected `UPSERT_SCHEDULE` shape remain accepted for older gateways.
Protected effects use:

```text
schedule:<zone_uuid>:<base_sync_version>
```

Create requires base `0` and target `1`. Update requires the stored schedule
version as its base and exactly `base + 1` as its target.

### Irrigation calibration

The portable object contains:

- `contract_version`
- `zone_uuid`
- `gateway_device_eui`
- `measured_flow_rate_lpm`
- `measurement_method`
- `measured_at`
- `sync_version`
- `deleted_at`
- `last_applied_at`

The flow rate must be finite and greater than zero. The measurement method is
at most 200 characters. `measured_at` is a canonical UTC timestamp selected
when the mutation is requested and preserved through edge application.

`valve_device_eui` remains edge-local. It identifies the local actuator used
for a measurement and is not currently editable by either zone-calibration
API. Protected application leaves it unchanged.

The event is `ZONE_IRRIGATION_CALIBRATION_UPSERTED`; the protected command is
`UPSERT_ZONE_IRRIGATION_CALIBRATION`. Effects use:

```text
irrigation_calibration:<zone_uuid>:<base_sync_version>
```

## Edge persistence and application

Migration `0036` is additive. It adds `sync_version`, `deleted_at`, and
`last_applied_at` to `zone_irrigation_calibration`, then creates insert,
update, and outbox triggers. Migration `0037` is data-risk: it backs up the
database, assigns version `1` to existing calibration rows, and lets the new
update trigger enqueue their initial mirrors on linked gateways.

The blank seed and all seven bundled databases receive both migrations. The
runtime boot-DDL block stays frozen.

A registered Node-RED helper applies protected schedule and calibration
commands through the generic command ledger. In one SQLite transaction it:

1. validates command identity, gateway binding, effect key, and resource
   shape;
2. verifies that the active zone UUID exists;
3. checks the exact current aggregate version;
4. inserts or updates the canonical row with bound parameters; and
5. records the terminal ACK.

Version drift returns `CONFLICT`. Permanent shape, zone, or gateway errors
return `REJECTED_PERMANENT`. Database failures roll back and remain retryable.
Exact command replay returns the stored terminal result.

Local schedule and calibration APIs continue to write canonical SQLite first.
They increment only their resource version and let the outbox triggers emit
the resulting mirror.

Bootstrap and force-sync payloads include calibration rows so pre-existing
calibrations reach the cloud even if no later edit occurs.

## Cloud mirror and mutation

OSI Server adds a one-to-one irrigation-calibration mirror keyed by zone. The
schedule mirror remains the existing `IrrigationSchedule` entity.
`EdgeSyncService` applies schedule and calibration resources with monotonic
watermarks, equal-version equality, gateway ownership, and desired-state
observation.

Two narrow services own mutation construction:

- `ScheduleMutationService`
- `IrrigationCalibrationMutationService`

Both resolve per-gateway access, require a non-viewer membership and zone
scope, read the canonical mirror version, coalesce only an unleased config
operation at the same base, and request durable desired state. Neither writes
the canonical mirror before the edge event arrives.

The existing schedule endpoint returns the pending schedule representation
and operation. A matching cloud calibration endpoint accepts the edge field
names in camel case. Cloud-local zones retain direct server persistence.

## Cloud user experience

Zone list responses overlay active desired values while retaining each
resource's operation status. `IrrigationSchedule` gains its own
`desiredState`. Calibration is a nested response with measured flow rate,
method, measurement timestamp, sync metadata, and `desiredState`.

The schedule editor:

- renders pending, acknowledged, conflicted, rejected, and expired states;
- does not claim edge success from the HTTP `202`;
- refreshes the zone list after a save;
- permits another edit at the unchanged canonical base while the prior
  command is still unleased; and
- limits edge-backed saves to the seven-value edge vocabulary.

The zone configuration modal gains the measured-flow-rate and method fields
already present in the edge GUI. Schedule, zone configuration, and irrigation
calibration remain separate requests because they have separate aggregate
versions.

## Alternatives rejected

Embedding calibration in the zone aggregate was rejected because a bucket
test would conflict with an unrelated crop, location, or soil edit.

Embedding calibration in the schedule aggregate was rejected because flow
measurement and scheduler policy change independently and have different
timestamps.

Keeping calibration read-only in the cloud was rejected because the current
edge mutation is portable, human-entered farm configuration and Task 8
requires bidirectional convergence for portable mutations.

Reusing `zone_desired_state_v1` was rejected because older images may support
protected zones without the new schedule and calibration consumers. A
separate capability prevents unsafe early issuance.

## Verification

The accepted slice must prove:

1. local schedule create and update mirror to the cloud;
2. local calibration create, existing-row backfill, and update mirror to the
   cloud;
3. capable cloud edits apply at the edge and converge after ACK plus mirror;
4. stale schedule and calibration bases become recoverable conflicts;
5. command replay is idempotent and database failure rolls back;
6. viewers and out-of-scope users cannot mutate either resource;
7. legacy gateways retain schedule behavior and reject cloud calibration
   mutation as unsupported;
8. the cloud UI keeps pending and conflicted values visible;
9. unsupported edge-backed metrics cannot be saved; and
10. the edge contract, server vendor, profile parity, schema, backend, and
    frontend gates all pass.
