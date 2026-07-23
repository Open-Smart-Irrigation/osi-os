# Journal server parity design

**Date:** 2026-07-23

## Purpose

OSI Server must mirror the portable journal resources already defined by the
edge and let an authenticated user request the same five mutations through the
existing pending-command path. The edge remains canonical. A successful cloud
request means that the desired operation is durable and queued; it does not
mean that the journal record has changed on the edge.

This design consumes the canonical files under `docs/contracts/sync-schema/`,
the edge tables introduced by migration `0018`, the owner columns introduced
by `0020`, and the command implementation in `osi-journal/commands.js`. It does
not create a second journal domain model.

## Supported surface

The first cloud journal slice supports:

- `JOURNAL_ENTRY_UPSERTED` and `JOURNAL_ENTRY_VOIDED`;
- `JOURNAL_VOCAB_UPSERTED`;
- `JOURNAL_PLOT_UPSERTED`;
- `JOURNAL_PLOT_GROUP_UPSERTED`;
- `UPSERT_JOURNAL_ENTRY` and `VOID_JOURNAL_ENTRY`;
- `UPSERT_JOURNAL_CUSTOM_VOCAB`;
- `UPSERT_JOURNAL_PLOT`;
- `UPSERT_JOURNAL_PLOT_GROUP`.

Drafts remain browser-local until finalization, matching the edge capture
workflow. Attachments, products, catalog authoring, and ADAPT export are not
part of this slice.

## Cloud mirror

Flyway creates four resource tables:

- `journal_entries_mirror`;
- `journal_vocab_mirror`;
- `journal_plots_mirror`;
- `journal_plot_groups_mirror`.

Each table stores the canonical resource UUID, gateway EUI, owner UUID,
`sync_version`, tombstone timestamp, the complete aggregate as `jsonb`, and
timestamps needed for filtering. Entry rows additionally expose status,
occurrence time, activity, plot, and zone. The selected columns make ownership,
tombstone, timeline, and scope queries indexable while `aggregate_json`
preserves every contract field without inventing cloud-only semantics.

Each event operation has a dedicated `SyncEventApplier`. The shared mirror
service checks that:

- the event aggregate type and key match the payload;
- the payload gateway matches the authenticated event gateway;
- the payload contains a non-negative `sync_version`;
- entry upsert carries `final`, while entry void carries `voided`;
- resource UUIDs and owner UUIDs are present;
- plot-group members and entry values remain in the aggregate.

The existing sync watermark transaction rejects duplicates, stale versions,
and equal-version payload conflicts before an applier writes. Tombstones are
stored, not deleted. The applier write, watermark, desired-state observation,
and inbox terminal record share one transaction.

## Authorization and future scope hooks

Every API path selects one gateway. The gateway must be claimed by the current
server user. Resource reads also require the mirror's `owner_user_uuid` to
equal the user's `user_uuid`. This is the Phase A ownership rule, not the final
grant union.

The controller delegates gateway and resource access to
`JournalAccessService`. Task 7 can replace its owner-only decision with
gateway membership plus account and plot grants without changing journal
mutation, mirror, or export code. The cloud user's global role is not consulted
by this service.

Out-of-scope resources return 404. A gateway that is not owned by the caller
returns 403.

## Cloud mutation protocol

The API accepts a contract-shaped command resource with
`base_sync_version`. The server overwrites trusted identity fields:

- `owner_user_uuid` is the current user's UUID;
- `author_principal_uuid` is the current user's UUID;
- `author_label` is the current username;
- `gateway_device_eui` is the selected gateway;
- entry `origin` is `cloud-ui`.

The server generates the logical `command_id`, effect key, and pending-command
event UUID. Effect keys use the edge contract's base version:

```text
journal_entry:<entry_uuid>:<base_sync_version>
journal_vocab:<custom_field_uuid>:<base_sync_version>
journal_plot:<plot_uuid>:<base_sync_version>
journal_plot_group:<group_uuid>:<base_sync_version>
```

The full edge command payload is saved through `DesiredStateService` as a
configuration mutation. The desired subset is the trusted resource without
`base_sync_version`. A later unleased edit of the same command type may
coalesce through the existing desired-state rule. A leased command and an
entry void are never rewritten into another command type.

The existing command service normally adds a camel-case `commandType` member
to its stored payload. Journal payloads already carry the canonical
`command_type`; the service must not add the extra member in that case.
Focused tests pin this exception so journal commands remain valid against the
closed contract schema without changing legacy command payloads.

The response is HTTP 202 with the desired resource and desired-state
operation. Lists return the canonical mirror plus the caller's latest active
desired operation. Continued editing while pending rewrites against the
unchanged canonical base version and remains explicit about canonical versus
desired values.

`CONFLICT`, permanent rejection, retryable failure, ACK-before-mirror, and
mirror-before-ACK use the Task 4 state machine unchanged.

## API

All endpoints are under `/api/v1/journal/gateways/{gatewayEui}`:

- `GET /entries`, `/plots`, `/plot-groups`, `/custom-vocab`;
- `POST /entries`, `/plots`, `/plot-groups`, `/custom-vocab`;
- `PUT /entries/{uuid}`, `/plots/{uuid}`, `/plot-groups/{uuid}`,
  `/custom-vocab/{uuid}`;
- `POST /entries/{uuid}/void`;
- `GET /export.json`;
- `GET /export.csv`.

`FAILED_RETRYABLE` keeps the existing command pending for automatic lease
retry. Conflict, permanent rejection, and expiry recovery use an edited
resubmission against the latest canonical base. Journal does not add a second
retry endpoint beside the Task 4 state machine.

JSON export contains the canonical aggregate objects selected by the same
filters as the list endpoint. CSV uses UTF-8, CRLF, RFC 4180 quoting, and
formula-prefix protection for text cells. It exports stable entry columns plus
one row per value. The research-package and ADAPT formats remain edge-only
until their full metadata and streaming contracts are ported.

## Frontend

The server adds `/journal` behind the normal private route and a Journal entry
in dashboard navigation. The cloud workspace provides:

- gateway selection;
- canonical final and voided entry timeline;
- filters for plot, status, and occurrence range;
- contract-shaped final-entry capture;
- correction and void actions;
- plot, plot-group, and custom-vocabulary editors;
- JSON and CSV exports;
- immediate desired rendering through the shared pending-state component;
- conflict, rejection, and expiry recovery controls plus visible automatic
  retry state.

The UI calls a journal-specific API adapter, but response normalization remains
in `frontend/src/services/api.ts`. Draft persistence is local browser state.

## Capability rollout

Journal event acceptance and command issuance remain separate. The five event
operations move from staged to enabled only after mirror replay tests pass.
The five commands move from staged to enabled only after controller and
pending-command tests pass. The server exposes journal editing only when the
selected gateway has produced a valid journal bootstrap advertisement or a
`field_journal_v1` capability. OSI Server persists that capability beside the
existing linked-auth and force-sync flags on `LinkedGatewayAccount`. Task 7 may
fold the flag into its broader capability mirror without changing the API. A
gateway without the capability remains read-only even after the server-side
command issuer is enabled.

## Verification

Acceptance requires:

- migration and index tests on PostgreSQL;
- applier tests for replay, duplicate, stale, equal-version conflict, and
  tombstones;
- command tests for all five mutations, continued editing, conflict,
  automatic retry, rejection recovery, and void;
- byte-identical contract vendor gates;
- comparison against canonical edge command and aggregate fixtures;
- controller authorization and export tests;
- frontend API, route, workflow, and pending-state tests;
- complete server backend and frontend suites;
- edge contract, schema, journal command, journal API, and sync-flow gates.
