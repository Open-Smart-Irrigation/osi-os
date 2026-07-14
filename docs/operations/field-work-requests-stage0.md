# Field Work Requests Stage 0

Stage 0 lets authenticated edge users submit bug, improvement, or feedback
requests from the gateway GUI. The gateway stores the request locally, then the
support delivery worker posts the sanitized payload to the server's unlinked
support endpoint. The legacy `WORK_REQUEST_SUBMITTED` outbox event is still
created for linked-sync compatibility and traceability.

Stage 0 is feedback-to-issue only. It does not provision runner VMs, run agents,
create draft PRs, classify work for autonomous execution, or promote anything to
production. Roll this out on local or test-server environments only; do not use
`osicloud.ch` without a separate production approval.

Deployment order is server first, then edge. The server must accept Stage 0
intake and status-back commands before field gateways start delivering queued
requests. If an edge build reaches the test server early, the edge delivery
worker retries instead of dropping the request.

## Edge behavior

- GUI route: `/support-requests`; current navigation is owned by the global
  Settings page.
- Local API:
  - `GET /api/improvement-requests`
  - `GET /api/improvement-requests/diagnostics-preview`
  - `POST /api/improvement-requests`
- Local table: `improvement_requests` in `/data/db/farming.db`.
- Delivery worker: `support-delivery-worker` posts queued requests to
  `/api/v1/support/edge/work-requests` without an Authorization header. It
  resolves the target server from the linked `users.server_url`, then
  `flow.sync_state`, then `OSI_CLOUD_SERVER_URL`, then the default cloud URL.
- Compatibility event: insert trigger `trg_improvement_requests_outbox_ai` writes
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

Required server configuration:

```bash
WORK_REQUESTS_PSEUDONYM_SECRET=<stable random secret>
WORK_REQUESTS_GITHUB_APP_ID=<app id>
WORK_REQUESTS_GITHUB_INSTALLATION_ID=<installation id>
WORK_REQUESTS_GITHUB_PRIVATE_KEY_PEM=<pkcs8 pem>
```

If `WORK_REQUESTS_PSEUDONYM_SECRET` is missing or still set to the placeholder,
intake fails closed. To disable GitHub publishing while keeping intake enabled,
unset `WORK_REQUESTS_GITHUB_APP_ID` or another required GitHub App value. Publish
attempts then fail closed with `PUBLISH_BLOCKED_CONFIG` and no public issue is
created.

Server intake limits are:

- 10 requests per 24 hours per known gateway EUI.
- 50 requests per 7 days per known gateway EUI.
- 10 requests per 24 hours per source IP for unlinked public intake.
- 500 globally pending unlinked requests before new unlinked intake is blocked.

The unlinked support endpoint only accepts known gateway EUIs. A known EUI is a
gateway device that has sent at least one heartbeat in the last 90 days.

Gateway quarantine is managed on the server:

```text
POST /api/v1/admin/work-requests/gateways/{gatewayEui}/quarantine
```

Quarantined gateways are rejected with `gateway_quarantined` until an operator
removes the quarantine from the admin workflow.

## Operator checks

After submitting a request from the edge GUI:

1. Query the edge DB and confirm a row exists in `improvement_requests`.
2. Confirm `support-delivery-worker` delivers the request to
   `/api/v1/support/edge/work-requests` on the linked test server. The
   `sync_outbox` row should also exist for linked-sync compatibility.
3. After the server ingests the request, open the server admin console at
   `/admin/work-requests`.
4. Publish only after the public artifact shown in the admin queue contains no
   real gateway EUI, local username, email, token, app key, raw logs, or private
   diagnostics.
5. Inspect private diagnostics only from the admin detail drawer
   (`GET /api/v1/admin/work-requests/{id}`); do not copy them into the public
   GitHub issue.
6. Confirm the gateway receives a `WORK_REQUEST_STATUS` update and the GUI shows
   the latest cloud status or human message.

## Troubleshooting

- No local row: verify the edge user is authenticated and the POST body includes
  `consent_public=true`.
- No delivery: verify the gateway is linked to the test server (`users.server_url`)
  and inspect the support delivery retry state.
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
