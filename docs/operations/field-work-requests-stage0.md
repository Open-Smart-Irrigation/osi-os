# Field Work Requests Stage 0

Stage 0 lets authenticated edge users submit bug, improvement, or feedback
requests from the gateway GUI. The gateway stores the request locally, queues a
`WORK_REQUEST_SUBMITTED` sync event, and later applies bounded cloud status
updates through the existing pending-command poll.

Stage 0 is feedback-to-issue only. It does not provision runner VMs, run agents,
create draft PRs, classify work for autonomous execution, or promote anything to
production. Roll this out on local or test-server environments only; do not use
`osicloud.ch` without a separate production approval.

## Edge behavior

- GUI route: `/support-requests`, linked from the dashboard menu as "Support &
  Requests".
- Local API:
  - `GET /api/improvement-requests`
  - `GET /api/improvement-requests/diagnostics-preview`
  - `POST /api/improvement-requests`
- Local table: `improvement_requests` in `/data/db/farming.db`.
- Sync event: insert trigger `trg_improvement_requests_outbox_ai` writes
  `WORK_REQUEST_SUBMITTED` into `sync_outbox`.
- Status command: `WORK_REQUEST_STATUS` updates `cloud_status`,
  `cloud_reason`, `cloud_human_message`, `released_version`, and
  `last_status_at` on the matching local request.

Status commands are data-only. The pending-command splitter routes
`WORK_REQUEST_STATUS` to the improvement-request status function before the
normal actuator/downlink path, and ACKs are queued through the durable REST
command-ACK flow.

## Consent and diagnostics

`consent_public=true` is required. The public request text is sanitized on the
gateway before storage and again on OSI Server before issue publication.

Diagnostics are optional. If the user disables diagnostics, the gateway stores
and syncs an empty diagnostics object. If diagnostics are enabled, the gateway
collects bounded health, sync, device-count, GUI-route, and gateway-identity
facts for OSI Server private inspection. Diagnostics are never part of the
GitHub issue body.

## Server requirements

The server side must be deployed on the test server with the Stage 0 work-request
schema and services. Required server configuration is documented in the sibling
repo at `/home/phil/Repos/osi-server/docs/operations/field-work-requests-stage0.md`.

At minimum, the server needs a stable `WORK_REQUESTS_PSEUDONYM_SECRET`. GitHub
publishing additionally needs the GitHub App env vars. If the GitHub App config
is unset, server publishing fails closed with `PUBLISH_BLOCKED_CONFIG` and no
public issue is created.

## Operator checks

After submitting a request from the edge GUI:

1. Query the edge DB and confirm a row exists in `improvement_requests`.
2. Confirm `sync_outbox` contains a `WORK_REQUEST_SUBMITTED` event for the same
   request UUID.
3. After the server ingests the event, open the server admin console at
   `/admin/work-requests`.
4. Publish only after the public artifact shown in the admin queue contains no
   real gateway EUI, local username, email, token, app key, raw logs, or private
   diagnostics.
5. Confirm the gateway receives a `WORK_REQUEST_STATUS` update and the GUI shows
   the latest cloud status or human message.

## Troubleshooting

- No local row: verify the edge user is authenticated and the POST body includes
  `consent_public=true`.
- No outbox event: verify migration `0005__field_work_requests.sql` and the seed
  trigger are present.
- No cloud status: check `/api/v1/sync/gateways/{eui}/pending-commands` on the
  test server and the edge command ACK queue.
- Published issue blocked: inspect the server request state. Missing GitHub App
  config gives `PUBLISH_BLOCKED_CONFIG`; public-artifact scanner findings give
  `PUBLISH_BLOCKED_SECRET`.

## Verification

Relevant edge gates:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/test-improvement-requests-schema.js
node scripts/test-contract-schemas.js
node --test scripts/verify-sync-op-parity.test.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
scripts/check-mqtt-topics.sh
cd web/react-gui
npm run test:unit
npm run typecheck
npm run build
```
