# Cloud desired-state design

**Status:** Approved for Task 4 implementation by the AgroLink parity
orchestrator.

**Scope:** OSI Server persistence, command lifecycle integration, one zone
configuration consumer, and reusable frontend status presentation. Journal and
scoped-access domain handlers consume this foundation in later tasks.

## Problem

Cloud edits to edge-backed resources currently create `device_commands` rows
and return an optimistic response. The command row records delivery and ACK
state, but it does not durably retain:

- the canonical version the user edited;
- the complete desired representation shown to the user;
- the latest canonical representation received from the edge;
- whether an ACK has converged with a later mirror event;
- a stable conflict, rejection, expiry, or supersession result.

This gap makes an HTTP `202 Accepted` look more final than it is. A refresh can
also replace the optimistic representation with the older cloud mirror while
the edge is offline.

## Existing constraints

- The edge remains canonical.
- REST pending-command polling is the only cloud-to-edge command path. MQTT
  publication remains best effort and cannot establish success.
- `device_commands` already owns command identifiers, lease state, attempt
  counts, ACK fields, `expires_at`, and `effect_key`.
- An edge event is accepted through the inbox, ownership, canonical payload
  hash, and resource-watermark gates before its mirror mutation commits.
- Retries update the same command row. They must not allocate a new command
  identifier or effect key.
- The shared sync contract accepts `CONFLICT`, but the server handler is not
  enabled at the Task 4 base.

## Considered approaches

### Add desired fields to `device_commands`

This avoids a new table, but command transport and resource convergence have
different lifecycles. A safe unleased command may be coalesced for a newer
edit, while the earlier user operation must remain auditable as superseded.
One command can therefore correspond to more than one user operation over
time. Expanding `device_commands` would erase that distinction.

### Event-source all cloud edits

An append-only desired-state event stream can reconstruct every state, but it
adds projections, replay rules, and recovery tooling before the server has a
second consumer. That is larger than the parity task requires.

### Separate desired-state ledger linked to commands

This is the selected design. `device_commands` remains the delivery mechanism.
A `desired_state_operations` table owns user intent and convergence. Multiple
operations may refer to one coalesced, unleased command, while every leased or
physical-effect command remains immutable.

## Data model

`desired_state_operations` stores:

| Field | Contract |
|---|---|
| `operation_uuid` | Server-generated UUID and API identity |
| `gateway_eui` | Normalized gateway that owns the resource |
| `resource_type`, `resource_id` | Watermark-compatible resource identity |
| `command_type` | Edge command operation |
| `mutation_kind` | `CONFIG` or `PHYSICAL_EFFECT` |
| `status` | State machine value below |
| `base_sync_version` | Canonical version observed when the edit began |
| `target_sync_version` | Expected next canonical version |
| `desired_json` | Complete expected resource subset, using edge event keys |
| `canonical_json` | Latest canonical subset observed after the edit |
| `command_id` | Foreign key to `device_commands`; not unique |
| `created_by` | Cloud user who requested the edit |
| `ack_result`, `acknowledged_at` | Latest terminal or retryable edge result |
| `mirrored_sync_version`, `mirrored_at` | Latest relevant edge mirror |
| `rejection_code`, `rejection_detail` | Stable machine and bounded human reason |
| `expires_at` | Required for physical effects; optional for configuration |
| `superseded_by` | Newer operation replacing this intent |
| timestamps | Creation and last state change |

Status values are `PENDING`, `ACKNOWLEDGED`, `APPLIED`, `CONFLICTED`,
`REJECTED`, `EXPIRED`, and `SUPERSEDED`. The API normalizes them to lowercase.
`ACKNOWLEDGED` is still pending from the user's perspective: an ACK alone does
not prove that the cloud mirror has converged.

PostgreSQL indexes cover command lookup, latest resource operation, and active
expiry scans. The migration uses the next free Flyway version at execution
time.

## State machine

| Input | Prior state | Result |
|---|---|---|
| Cloud edit | none or terminal | `PENDING` |
| Safe coalesced cloud edit | older active config operation | older `SUPERSEDED`; newer `PENDING` on the same unleased command |
| Edit while command leased | older active config operation | older `SUPERSEDED`; newer `PENDING` on a new command |
| `FAILED_RETRYABLE` ACK | `PENDING` | `PENDING`; the command row retains its identifier and effect key |
| `APPLIED` ACK without matching mirror | `PENDING` | `ACKNOWLEDGED` |
| Matching mirror without ACK | `PENDING` | `PENDING` with canonical evidence |
| ACK and matching mirror, in either order | `PENDING` or `ACKNOWLEDGED` | `APPLIED` |
| `CONFLICT` ACK | active | `CONFLICTED` |
| Mirror advances beyond the base but differs from desired | active | `CONFLICTED` |
| `REJECTED_PERMANENT` ACK | active | `REJECTED` |
| `EXPIRED` ACK or physical-effect deadline | active | `EXPIRED` |

Terminal input for a `SUPERSEDED` operation is recorded on the command but does
not reopen or overwrite the operation.

## Command creation and supersession

`DesiredStateService.request(...)` is the only API for creating a tracked
operation. The request supplies a gateway, resource identity, command type,
mutation kind, non-negative base version, desired representation, command
payload, effect key, optional expiry, and actor.

For a configuration edit, the service locks the latest active operation for
the resource:

1. If its command has the same command type, is `PENDING` or legacy `SENT`, and
   has no lease owner or lease timestamps, the service marks the old operation
   `SUPERSEDED`, updates that command in place, and links the new operation to
   it. The command identifier, event UUID, and effect key stay unchanged.
2. Otherwise the service marks the old intent `SUPERSEDED` and creates a new
   command. A leased command is never rewritten.
3. A physical effect never coalesces or supersedes another physical effect.
   It requires a future expiry and an operation-specific effect key.

The service does not mutate the cloud mirror during command creation.

## ACK handling

`CommandAckController` continues to validate protocol, gateway ownership, and
lease ownership before changing a command. After the command transition is
saved, it calls the desired-state service with the normalized result.

- `APPLIED` records acknowledgment and waits for mirror convergence.
- `FAILED_RETRYABLE` leaves the operation pending.
- `REJECTED_PERMANENT` records `REJECTED`.
- `EXPIRED` records `EXPIRED`.
- `CONFLICT` records `CONFLICTED`, clears the lease, and returns a terminal
  `CONFLICT` result. The command keeps `ack_result='CONFLICT'`.

Unknown results remain non-terminal and do not change desired state.

## Mirror convergence

`SyncEventTxExecutor` notifies the desired-state service only after:

- operation support is confirmed;
- ownership is accepted;
- the version and payload watermark checks pass;
- the domain applier succeeds; and
- the new watermark is written.

The notification carries normalized gateway and resource identity, event sync
version, and event payload. The service compares the stored desired JSON as a
recursive subset of the canonical payload. Object key order is irrelevant;
array order and scalar values remain significant.

A matching mirror records canonical evidence. The operation becomes
`APPLIED` only if an `APPLIED` ACK is also present. A newer non-matching mirror
records the canonical payload and marks the operation `CONFLICTED`. Stale,
duplicate, rejected, and retryable events never advance desired state.

## Expiry

A scheduled expiry job marks overdue active physical-effect operations and
their uncompleted commands `EXPIRED`. Pending-command leasing excludes rows
whose `expires_at` has passed. Configuration operations do not expire unless a
caller explicitly supplies a deadline.

The expiry method is public at the service boundary so integration tests can
run it deterministically without waiting for a scheduler.

## API and zone proof

Task 4 converts the existing edge-backed zone-configuration update to
`DesiredStateService`. Its `202 Accepted` body retains the desired zone fields
and adds a `desiredState` object containing:

- operation UUID and normalized status;
- resource and command identity;
- base and target versions;
- desired and canonical values;
- rejection details and timestamps.

`GET /api/v1/irrigation-zones` attaches the latest visible zone-config
operation. While it is pending or acknowledged, the response overlays the
stored desired values on the canonical zone. Conflict and rejection responses
retain both desired and canonical representations in `desiredState`; the
primary zone fields remain desired so the user's edit does not disappear.

`GET /api/v1/desired-state/operations/{operationUuid}` returns the same view to
its creator. Later journal and access controllers call the service directly;
the generic controller does not accept arbitrary command creation.

## Frontend contract

Normalization remains in `frontend/src/services/api.ts`. It accepts camelCase
or snake_case backend fields and produces one `DesiredStateOperation` type.

`PendingStateNotice` is a resource-neutral component:

- pending and acknowledged: change is waiting for the hub;
- conflicted: hub state differs, with a caller-supplied retry action;
- rejected: stable reason and retry action;
- expired: effect did not complete before its deadline;
- applied and superseded: no persistent warning.

The zone card uses the component immediately. Journal Task 5 reuses it without
forking status labels or transition logic.

## Failure and security rules

- Operation creation and command mutation are one transaction.
- Gateway and current resource ownership checks remain in the domain
  controller; the operation-status endpoint also requires the creating user.
- Repository locks serialize edits to the same resource.
- JSON and rejection detail sizes are bounded before persistence.
- Logs contain operation, command, gateway, and resource identifiers but never
  bearer tokens or command payload contents.
- Missing desired-state rows do not block legacy commands or ACKs.
- A desired-state callback failure rolls back the ACK transaction, preventing
  command and operation state from diverging.

## Verification

Backend unit tests cover every transition and subset comparison. PostgreSQL
integration tests cover migration, command creation, ACK-before-mirror,
mirror-before-ACK, conflict, rejection, coalescing, leased supersession,
retry-in-place, and expiry. Controller tests cover immediate desired responses
and authorization.

Frontend tests cover API normalization and every visible
`PendingStateNotice` state. The complete backend suite, frontend unit suite,
and guarded frontend build are required before Task 4 is accepted.
