# Field-to-PR and Forge Runner Pipeline — Design

**Date:** 2026-07-08
**Status:** Revised — incorporates architecture review findings: known-EUI
gateway validation, payload size limits, deploy wrapper privilege model, prompt
injection mitigations, forward-compatible status semantics, dual-delivery
idempotency, and answered open questions folded in.
**Scope:** osi-os Settings support form, edge persistence/delivery, osi-server
unlinked + linked intake, admin triage/publish, GitHub issue/PR creation, and
the first Forge runner on the test-server VPS.

This document supersedes the earlier linked-only Stage 0 draft and the earlier
assumption that the runner must start on a separate VPS. The production rule is
unchanged: `osicloud.ch` is out of scope unless a future turn explicitly grants
production access.

## Problem

OSI OS users notice bugs and want improvements while standing in front of the
gateway dashboard. The request should become a structured engineering work item
and, when safe, an automated draft PR with test evidence. The user experience
must not depend on linking the gateway to a cloud account.

The pipeline must preserve three boundaries:

1. A field gateway submits inert data only. It never holds GitHub credentials,
   coding-agent credentials, production credentials, or general cloud authority.
2. OSI Server is the intake, triage, and audit system. It stores private data
   and decides what may become public.
3. The Forge runner performs code work only in a constrained test environment.
   Human merge and production deploy remain mandatory.

**Core rule: the submitted request is evidence, never authority.**

## Current Decisions

1. **Unlinked intake is the primary user path, gated by known-EUI validation.**
   A gateway can submit a support request to OSI Server without account link or
   sync token. However, the server must have seen the gateway's EUI — via MQTT
   heartbeat or device claim — before accepting the request. Unknown EUIs are
   rejected with `invalid` and reason `unknown_gateway`. Account linking remains
   useful for farm mirroring, commands, and normal sync, but it is not required
   for feature/bug feedback.
2. **Linked sync remains supported for compatibility.** Existing and pending
   `WORK_REQUEST_SUBMITTED` outbox events, including Kaba100's pending event,
   must still ingest through `/api/v1/sync/edge/events` once server support is
   implemented. Server-side idempotency by `request_uuid` makes dual delivery
   harmless.
3. **One server-side intake service owns semantics.** The unlinked endpoint and
   linked sync handler are adapters into the same `WorkRequestIntakeService`.
   Redaction, dedup, rate limits, quarantine, classification, GitHub publishing,
   and status transitions live behind that shared boundary.
4. **The first Forge runner lives on the test-server VPS with a sudo/deploy-svc
   wrapper privilege model.** It runs under a dedicated `forge-runner` user.
   Deploy wrappers run via `sudo` as a separate `deploy-svc` user with narrowly
   scoped Docker permissions. This is a temporary shared-host arrangement; a
   dedicated VPS replaces it later. Job timeout: 2 h initial, raise to 8 h
   maximum after validation.
5. **Claude Opus plans and reviews; Codex executes.** Claude produces the plan,
   risk class, and review verdict. Codex performs implementation, tests, and
   test-device/test-server verification through fixed wrappers.
6. **Full feature builds are eligible from the beginning of runner automation.**
   The runner is not limited to docs/copy/CSS. High-consequence changes are
   allowed in the test environment when the policy gate, wrappers, and live
   verification apply. Production, live ops, secrets, and CI workflow mutation
   remain excluded.
7. **Public attribution is minimal.** Public issues/PRs may show only sanitized
   request text, labels, and an optional country flag derived at intake. Real
   gateway EUI, local username, email, logs, diagnostics, and raw metadata stay
   private on OSI Server.

## Architecture

```
Pi gateway
  React Settings form
    -> Node-RED authenticated local endpoint
    -> SQLite improvement_requests
    -> sync_outbox WORK_REQUEST_SUBMITTED
    -> unlinked support delivery worker (separate from sync worker)

OSI Server test host
  devices(type=GATEWAY)              (heartbeat-populated known-EUI records)
  /api/v1/support/edge/work-requests (unlinked adapter, known-EUI gate)
  /api/v1/sync/edge/events           (linked sync adapter)
       -> WorkRequestIntakeService
       -> work_requests + work_request_events
       -> admin triage / publish gate
       -> GitHub issue

Forge runner on test-server VPS
  forge-runner user (no sudo, no docker, no server secrets)
  deploy-svc user (docker restart for one container, via sudoers)
  controller + tmux sessions
  Claude Opus plan/review
  Codex exec implementation
  local tests + fixed deploy/verify wrappers (sudo -> deploy-svc)
       -> agent/* branch + draft PR

GitHub public repos (osi-os, osi-server only)
  Issue first
  Draft PR with evidence
  human review, human merge
```

The Pi is still offline-first. It writes local state first and can show the
request immediately. Delivery is retried in the background. If the gateway is
linked, normal sync may also deliver the same request; server-side idempotency
by `request_uuid` makes duplicate delivery harmless — whichever delivery
succeeds first determines the local status, and subsequent deliveries are
idempotent no-ops on the server.

## Edge Intake and Delivery

The Settings page owns the user-facing entry point: **Settings -> Support &
Requests**. Page-level "report this page" shortcuts may prefill the same form,
but they must not create a second intake path.

### Payload Size Limits

Enforced on the edge before enqueue and on the server at intake:

| Field | Limit |
|---|---|
| Total request body | 64 KB |
| `diagnostics` object | 32 KB |
| `title` | 3–80 characters |
| `description` | 10–4000 characters |
| `expected`, `actual`, `steps` | 4000 characters each |
| `contact_email` | 254 characters |

Requests exceeding these limits are rejected locally before enqueue. The server
rejects oversized payloads at intake with `invalid` and a descriptive reason.

### Edge Persistence

The edge writes an `improvement_requests` row with:

- `request_uuid`
- request type: `bug`, `improvement`, or `feedback`
- title, description, optional expected/actual/steps
- area and user-perceived severity
- public consent and diagnostics consent
- redacted diagnostics JSON
- private gateway identity
- local status and last known cloud status
- optional `status_secret_hash` for unlinked status polling

`status_secret` must be >= 128 bits of cryptographic random, generated on the
edge. `status_secret_hash` is `SHA-256(status_secret)`, stored locally. Only the
hash is sent in the intake payload. The raw secret stays on the edge and is sent
later only in the `X-Status-Secret` polling header, where the server hashes it
for constant-time comparison.

### Outbox Enqueue

The same insert enqueues a `sync_outbox` event:

- `aggregate_type`: `WORK_REQUEST`
- `op`: `WORK_REQUEST_SUBMITTED`
- `aggregate_key`: request UUID
- `payload_json`: the versioned work-request payload

### Unlinked Support Delivery Worker

A new support delivery worker reads queued `improvement_requests` rows, fetches
the matching `WORK_REQUEST_SUBMITTED` payload from `sync_outbox`, and posts it to
the unlinked server endpoint. It runs on its own timer, separate from the
existing sync worker, with a 5-minute initial interval and exponential backoff on
failure (5 min → 10 min → 20 min → cap at 1 h). It must not attempt to deliver
telemetry, farm state, commands, or account-linked sync data. Normal sync
continues to deliver the event through `/api/v1/sync/edge/events` when a sync
token exists.

Delivery result handling:

- HTTP `202` or linked-sync `applied` marks the local request as submitted and
  records the server status.
- `duplicate` marks the local request submitted with the existing server state.
- `rate_limited` stores retry state and leaves the request queued for backoff.
- `quarantined` or `invalid` stores the server reason and stops retrying until
  user action or a future support-worker policy says otherwise.
- Network failure leaves the event pending for retry with backoff.

The support worker must not mutate any other outbox rows. This avoids making an
unlinked endpoint a bypass for normal edge-cloud sync.

### Edge Retention

Terminal states: `MERGED`, `RELEASED`, `REJECTED`, `DUPLICATE`. Rows in
`improvement_requests` that have been in a terminal `cloud_status` for > 180
days may be pruned by the edge housekeeping worker (same daily tick as gateway
health pruning). Non-terminal rows are never pruned.

## Server Intake Contract

### Known Gateway Gate

The server reuses existing `devices` rows to track known gateways:

| Column | Type | Purpose |
|---|---|---|
| `device_eui` | VARCHAR | Uppercase 16-hex EUI |
| `type` | VARCHAR | `GATEWAY` |
| `last_seen` | TIMESTAMPTZ | Most recent heartbeat or claim |

The MQTT heartbeat path already upserts gateway `devices` records on every
heartbeat. Device claim (`/api/v1/devices/claim-bulk`) can also refresh known
gateway records. A gateway is considered known when a `type='GATEWAY'` device
row has `last_seen` within the last 90 days.

### Unlinked Endpoint

`POST /api/v1/support/edge/work-requests`

This endpoint intentionally does not require a cloud account, sync token, or
claimed gateway. It treats every field as untrusted. It validates the claimed
`gateway_device_eui` against `devices` — unknown EUIs are rejected
with result `invalid` and reason `unknown_gateway`. It rate-limits by source IP
and known gateway EUI, then calls `WorkRequestIntakeService` with provenance
`UNLINKED_SUPPORT`.

Rate limits:

| Scope | Limit | Reset |
|---|---|---|
| Per source IP (all EUIs) | 10 requests/day | Rolling 24 h |
| Per known EUI | 10 requests/day | Rolling 24 h |
| Per known EUI | 50 requests/week | Rolling 7 days |
| Global pending unlinked | 500 total | Circuit breaker |

The per-IP limit applies first, before EUI lookup. The global circuit breaker
returns `rate_limited` when total pending unlinked requests exceed 500.

Caddy (reverse proxy) must enforce a 128 KB request body limit on this path as
an outer envelope; the application layer enforces the 64 KB payload limit.

Required payload fields:

```json
{
  "contract_version": 1,
  "schema_version": 1,
  "request_id": "6f169ae4-debe-4e5e-90f6-0dc9f40d0cb4",
  "submitted_at": "2026-07-08T17:56:20.097Z",
  "type": "improvement",
  "title": "Add SenseCAP S2100",
  "description": "Please add support for the device.",
  "area": "devices",
  "severity": "idea",
  "consent_public": true,
  "consent_diagnostics": true,
  "gateway_device_eui": "0016C001F11766E7",
  "diagnostics": {},
  "gui_user": {
    "local_user_id": 7
  }
}
```

Optional fields: `expected`, `actual`, `steps`, `contact_email`,
`status_secret_hash`, `firmware_version`, `gui_version`, `route`, `locale`,
`gui_user.username`, and bounded diagnostics subdocuments.
`status_secret_hash` is required only if the edge wants unlinked status polling.
`contact_email` is private only and must never be copied to public GitHub
artifacts. `gui_user.username` is transmitted for admin visibility but is
private on the server — never published to GitHub.

Response semantics:

```json
{
  "contract_version": 1,
  "request_id": "6f169ae4-debe-4e5e-90f6-0dc9f40d0cb4",
  "result": "accepted",
  "status": "SUBMITTED",
  "reason": null,
  "human_message": "Request received.",
  "server_received_at": "2026-07-08T18:00:00.000Z"
}
```

Allowed `result` values:

- `accepted`
- `duplicate`
- `rate_limited`
- `quarantined`
- `invalid`
- `server_error`

`invalid`, `rate_limited`, and `quarantined` responses include a
human-readable message suitable for the edge UI. They do not include private
server diagnostics.

### Linked Sync Adapter

`WORK_REQUEST_SUBMITTED` must also be accepted through the existing v2 sync
event endpoint. The linked adapter validates normal sync ownership first, then
calls `WorkRequestIntakeService` with provenance `LINKED_SYNC`.

Linked sync response semantics follow the existing v2 per-event result contract:

- applied or already-applied for successful/idempotent intake
- rejected with a stable reason for schema validation or ownership failure
- retryable failure only for true transient server errors

This compatibility is required so a currently pending edge event can be safely
ingested after server support is deployed. It is also the clean path for linked
gateways that already run normal sync.

**Dual-delivery idempotency:** `request_uuid` is the primary idempotency key
(UNIQUE constraint on `work_requests`). If a request arrives via the unlinked
endpoint first and the same `request_uuid` arrives later via linked sync (or
vice versa), the second arrival returns `duplicate` / `already-applied` without
creating a second row. The `dedup_hash` is a separate mechanism for detecting
semantically similar but distinct requests from the same gateway; it flags
duplicates for admin triage but does not automatically reject.

### Status Back

Unlinked and linked status return paths differ:

- Unlinked requests that supplied `status_secret_hash` may poll
  `GET /api/v1/support/edge/work-requests/{request_id}/status` with the raw
  status secret in an `X-Status-Secret` header. The server computes
  `SHA-256(raw_secret)` and compares against the stored `status_secret_hash`
  using a constant-time comparison. This endpoint is rate-limited to
  10 requests/minute/IP.
- Unlinked requests without a status secret receive only the immediate delivery
  result on the edge; their later state remains visible in the server admin
  queue and public GitHub issue if published.
- Linked requests may also receive `WORK_REQUEST_STATUS` through the existing
  pending-command poll. The command is data-only and may update only the local
  `improvement_requests` row.

**Forward compatibility:** if the edge receives an unknown `cloud_status` value
via `WORK_REQUEST_STATUS`, it stores the value as-is and displays a generic
"Status update received" string in the UI. The edge must not reject or crash on
unknown status values.

The edge UI shows friendly states: queued, sent, being reviewed, needs info,
being worked on, PR proposed, released, duplicate, rate-limited, not planned,
and failed.

## Server Persistence and Publishing

Server-side tables:

- `devices`: known gateways by EUI (`type='GATEWAY'`), populated by heartbeat
  and claim paths, queried by the unlinked endpoint's known-EUI gate.
- `work_requests`: current projection, private request fields, public artifact
  fields, gateway EUI, gateway pseudonym, provenance, state, dedup hash, GitHub
  issue/PR metadata, diagnostics retention timestamps.
- `work_request_events`: append-only audit log of every transition. Every event
  records the actor (system, admin user ID, agent).
- `work_request_gateway_controls`: quarantine and rate-limit overrides.
- `work_request_artifacts`: optional private runner logs, prompt artifacts,
  review results, and deployment evidence.

**Gateway pseudonym:** `gw_` + first 16 hex chars of
`HMAC-SHA256(work-requests.pseudonym-secret, gateway_eui)`. 16 hex chars = 64
bits of entropy; collision probability < 0.0001% at 10,000 gateways.

**Dedup hash:** `SHA-256(lower(trim(type)) + '|' + lower(trim(title)) + '|' +
lower(trim(first_200_chars_of_description)) + '|' + lower(trim(area)) + '|' +
gateway_pseudonym)`, stored as 64-char hex. This is a soft duplicate flag for
admin triage, not an automatic rejection gate. `request_uuid` uniqueness is the
hard idempotency gate.

**Provenance values:** `UNLINKED_SUPPORT` (from unlinked endpoint) or
`LINKED_SYNC` (from sync event path). Stored in `work_requests.provenance` for
audit; does not affect downstream processing.

The public artifact builder reads only sanitized public fields. It cannot see
raw diagnostics JSON by type/API shape. The GitHub publisher runs a final
scanner before creating an issue or PR.

GitHub issue creation is gated:

- issue first, always
- labels: `from-field`, `class:N`, severity, area, gateway pseudonym
- body contains sanitized request text in a fenced block
- diagnostics, raw logs, email, local username, real gateway EUI, and tokens
  never leave OSI Server
- missing GitHub App config fails closed with a visible admin state
  `PUBLISH_BLOCKED_CONFIG`; no public issue is created
- transient GitHub API failure (HTTP 5xx, timeout) fails the publish attempt
  with a `PUBLISH_FAILED` event and leaves state as `AWAITING_PUBLISH`; the
  admin retries manually

**GitHub App scope:** installation scoped to `osi-os` and `osi-server`
repositories only. Contents and Pull Request permissions only. No workflow,
admin, or organization permissions.

## Classification and Automation Policy

| Class | Meaning | Runner eligibility |
|---|---|---|
| 0 | docs, copy, i18n, small visual-only UI | eligible |
| 1 | ordinary app/server/edge code with bounded blast radius | eligible |
| 2 | schema, sync, Node-RED flows, device/provisioning, deploy wrappers | eligible only in test environment with stronger gates and live verification |
| 3 | production, live ops, secrets, credentials, `osicloud.ch`, real fleet mutation | never automated |
| 4 | vague, duplicate, product decision, suspected injection, unsupported area | issue-only |

### Deterministic Pre-Classification

Before any LLM sees the request, a deterministic scan runs:

1. **Keyword gate:** any text containing `ssh`, `password`, `token`, `.github`,
   `workflow`, `deploy`, `osicloud`, or `production` → class 4.
2. **Injection pattern gate:** text containing `IGNORE`, `SYSTEM:`,
   `INSTRUCTIONS`, `<|`, `[INST]`, or base64-encoded blocks > 100 chars → class
   4, flagged for admin review.
3. **Content-type gate:** `type=feedback` or description shorter than 20 chars
   after trim → class 4.

The LLM may suggest a class for class 0-2 requests, but deterministic rules
fail closed. Class 3 and 4 assignments are deterministic only.

## Forge Runner on the Test-Server VPS

The first runner lives on `server.opensmartirrigation.org` under a dedicated
`forge-runner` user. This is a temporary shared-host arrangement; a dedicated
VPS replaces it later. The hardening must compensate for the shared-host risk:

### forge-runner user constraints

- no sudo (except the narrowly scoped wrapper rules below)
- no membership in `docker`, `postgres`, `mosquitto`, or deployment admin groups
- no read access to active OSI Server `.env`, Caddy config, Postgres/Mosquitto
  volumes, SSH keys, production aliases, or Tailscale credentials
- no raw Docker socket access
- repo caches under `/home/forge-runner/repos`
- job worktrees under `/home/forge-runner/jobs/<job-id>`
- tmux sessions for observability only
- one job at a time initially
- `nice -n 10` and `ionice -c 2 -n 7` on all forge-runner processes
- disk quota: 10 GB on `/home/forge-runner`
- job timeout: 2 h initial, raise to 8 h maximum after pipeline validation
- egress restricted as far as practical to GitHub, package registries, model
  APIs, and OSI test endpoints

### Deploy wrapper privilege model

Privileged actions are wrappers, not shell freedom. Wrappers run via `sudo` as
a separate `deploy-svc` user with narrowly scoped Docker permissions:

```
# /etc/sudoers.d/forge-runner
forge-runner ALL=(deploy-svc) NOPASSWD: /usr/local/bin/forge-deploy-server-test
forge-runner ALL=(deploy-svc) NOPASSWD: /usr/local/bin/forge-deploy-edge-test
forge-runner ALL=(deploy-svc) NOPASSWD: /usr/local/bin/forge-verify-edge-test
forge-runner ALL=(deploy-svc) NOPASSWD: /usr/local/bin/forge-verify-server-test
```

Wrapper hardening rules:

- Wrappers accept only a validated job-ID (`^[a-z0-9-]{1,64}$`), never a file
  path. The wrapper resolves artifacts from
  `/home/forge-runner/jobs/<job-id>/artifact/` itself.
- Wrapper source is owned by root, mode 755, not writable by forge-runner or
  deploy-svc.
- Wrappers validate artifact integrity (presence, size, expected structure)
  before acting.
- `forge-deploy-server-test` can restart exactly the `osi-backend` Docker
  container. It cannot access arbitrary containers, volumes, or the Docker
  socket directly.
- `forge-deploy-edge-test <job-id> <target>` may deploy to allowlisted test
  devices only. The allowlist is a root-owned config file.
- `forge-verify-edge-test <job-id> <target> <scenario>` collects bounded
  runtime proof from allowlisted test devices.
- Wrapper logs every invocation with timestamp, job-ID, target, and exit code
  to `/var/log/forge-wrappers.log`.
- Wrapper logs are attached to the work request as artifacts.

When the dedicated VPS is provisioned, `forge-runner` gets its own Docker
socket and the sudo/deploy-svc indirection is removed. The wrapper scripts
themselves are reusable.

The first edge target should be a disposable/demo Pi if available. Kaba100
should not become an automated runner target unless explicitly approved as part
of the automation lab.

## Agent Workflow

The controller, not the agents, owns orchestration. Claude and Codex communicate
through structured artifacts and command outputs, not an open-ended chat.

1. Controller claims an approved/eligible job from OSI Server.
2. Controller creates a clean worktree and assembles a fixed prompt. **The field
   request text is inserted as a user message or tool-result block, never
   concatenated into the system prompt.** The system prompt is a hardened,
   static template that cannot be overridden by user content. Request text is
   truncated to 4000 characters before insertion. The text is labeled as
   untrusted data with explicit fencing.
3. Claude Opus planning pass emits:
   - `plan.md`
   - risk class
   - expected file/path scope
   - tests to run
   - runtime verification matrix
   - explicit "do not touch" list
4. Deterministic pre-execution gate checks the plan against policy.
5. Codex executes with `codex exec` in the worktree:
   - verify reality first
   - add failing tests where practical
   - implement
   - run local verifiers
   - prepare deployment artifact if runtime verification applies
6. Codex deploys only through fixed wrappers.
7. Codex writes `execution-report.md` with commands, outputs, diffs, and
   verification evidence.
8. Claude Opus review pass reads the original request, plan, diff, test output,
   and deployment evidence. It emits `review.json` and may request one bounded
   fix cycle.
9. Deterministic post-execution gate checks:
   - changed path policy (no `.github/workflows`, no `deploy.sh` unless class 2)
   - no secrets by scanner
   - no production host references except docs/tests
   - no direct SSH/deploy command leakage
   - branch name is `agent/req-<shortid>-<slug>`
   - **content-level diff scan:** no new outbound HTTP/MQTT calls to
     non-allowlisted hosts, no new `env.get()` calls for unknown env vars, no
     raw IP addresses or hostnames outside docs/tests, no new credential
     patterns (`Bearer`, `token`, `password`, `secret` as key names in code)
10. Runner pushes the branch and opens a draft PR with issue link and evidence.

The runner never approves its own PR, never merges, and never deploys to
production.

## Runtime Verification Matrix

Automated test deployment and live verification are mandatory when the change
has runtime behavior on the affected surface.

| Change area | Required verification |
|---|---|
| docs/spec only | markdown/self-review; no deployment |
| copy/i18n-only UI | unit/build; screenshot if layout risk |
| edge GUI workflow | unit/build plus deploy to test edge and browser/UI smoke |
| Node-RED API/flow | flow static checks plus deploy to test edge and live endpoint check |
| edge SQLite/schema | migration replay plus deploy to test edge using a copied DB or disposable device |
| sync contract | osi-os contract tests, osi-server sync tests, test edge -> test server round trip |
| server-only API/admin | backend/frontend tests plus test-server deploy and live API smoke |
| device onboarding/decoder/provisioning | decoder tests plus test edge runtime/provisioning smoke where hardware exists |
| deploy wrapper/script | wrapper dry run plus disposable test target; never production |

This means most real OSI feature builds need some live verification, but not
all changes need a Pi deployment. Server-only work can verify on the test
server; docs-only work should not consume a device.

## State Machine

```
DRAFT(edge)
  -> QUEUED(edge)
  -> SUBMITTED(server)
  -> TRIAGED
      -> ISSUE_ONLY
      -> NEEDS_INFO
      -> REJECTED
      -> DUPLICATE
      -> AWAITING_AGENT
  -> AGENT_PLANNING
  -> AGENT_IMPLEMENTING
  -> TEST_DEPLOYING
  -> VERIFYING
      -> AGENT_FAILED
      -> PR_OPEN
  -> IN_REVIEW
  -> MERGED
  -> RELEASED
```

Every transition creates a `work_request_events` row with actor identity. User-
visible status is a projection of this state, not a separate source of truth.

Terminal states: `MERGED`, `RELEASED`, `REJECTED`, `DUPLICATE`. Edge rows in a
terminal `cloud_status` for > 180 days are eligible for housekeeping pruning.

## Safety Controls

- Request text and diagnostics are always untrusted data.
- Redaction happens on the edge and again on OSI Server.
- Public GitHub artifacts are built from sanitized fields only.
- GitHub App installation scoped to `osi-os` and `osi-server` repositories
  only. Contents and Pull Request permissions. No workflow, admin, or
  organization permissions.
- Runner branches are `agent/*`; branch protection prevents direct `main`
  mutation.
- No Pi-side GitHub token.
- No production credentials on the runner.
- No `osicloud.ch` access in this pipeline.
- Test-device deployment uses wrappers and allowlists.
- Class 3 requests never reach the runner.
- A global kill switch disables publishing and job dispatch.
- Known-EUI validation prevents unauthenticated abuse from arbitrary sources.
- Deterministic pre-classification scan catches injection patterns before
  any LLM processes the request.
- Deploy wrappers accept only validated job-IDs, not arbitrary paths.
- Post-execution gate includes content-level diff scanning, not just path
  checks.
- Status polling uses >= 128-bit secrets with constant-time comparison.
- Payload size limits enforced on edge and server.
- Rate limits: per-IP (10/day) + per-known-EUI (10/day, 50/week) + global
  circuit breaker (500 pending unlinked).
- Bucket4j in-memory rate limits reset on backend restart — accepted for
  Stage 0; persistent rate limits (Redis/DB) are a Stage 3 enhancement if
  abuse appears.
- GitHub App private key accessible only to the backend container (Docker
  secret or mounted file with 600 permissions), not as a host env var readable
  by forge-runner.

## Rollout

### Stage 0 — Intake and Publishing Foundation

Build the unlinked support endpoint, known-EUI gateway registration, linked
sync compatibility for `WORK_REQUEST_SUBMITTED`, shared server intake service,
persistence, admin queue, publish gate, GitHub issue publisher, and status
return. Build the edge form, local persistence, unlinked delivery worker, and
status display.

Stage 0 does not run coding agents yet.

### Stage 0.5 — Sandbox Validation

After deploying Stage 0 to the test server, validate the full
intake → triage → publish pipeline with synthetic requests against a sandbox
GitHub repo (e.g., `osi-os-sandbox`). This is a required gate before connecting
the pipeline to the real `osi-os` and `osi-server` repos for GitHub issue
creation. Verify: known-EUI rejection, rate limiting, dedup, redaction,
publish → issue creation, status-back to edge.

### Stage 1 — Forge Runner on Test-Server VPS

Create the `forge-runner` user, `deploy-svc` user, sudoers rules, controller,
job worktrees, Claude plan/review calls, Codex execution calls, policy gates,
GitHub draft PR creation, and local test evidence capture. The runner may
attempt full feature builds for classes 0-2, but only against branches and test
targets.

**Stage 1 starts with manually created GitHub issues, not field intake.** The
first runner jobs should come from hand-written issues to validate the pipeline
without exposing real user requests to early-stage bugs.

### Stage 2 — Test-Device Deployment Wrappers

Add and harden the fixed deploy/verify wrappers for allowlisted test devices.
Make runtime verification mandatory by matrix before PR creation for changes
where it matters.

### Stage 3 — Wider Intake and Automation Tuning

Open intake beyond demo/test gateways, tune rate limits (consider persistent
rate limits if in-memory proves insufficient), add better NEEDS_INFO round
trips, add duplicate clustering, and decide whether some class-0 jobs can
start without per-request human dispatch. Human merge and production deploy
remain mandatory.

## Kaba100 Pending Event Risk Assessment

The existing Kaba100 pending event should be safe to ingest after server support
exists if the handler is idempotent and treats the request as untrusted input.
It should not be manually replayed before the server has:

- `WORK_REQUEST_SUBMITTED` support in linked sync
- persistence for work requests
- redaction and public artifact scanning
- dedup keyed by request UUID and gateway
- clear per-event sync result semantics
- no automatic GitHub publication without the publish gate

Once those are in place, the pending event can be accepted as a normal field
request. Publishing or agent dispatch should remain separate explicit states.

## Open Questions

1. Which disposable/demo Pi is the first allowlisted automated test-device
   target?
2. Should Stage 1 auto-dispatch all class 0-2 requests in the test environment,
   or should admin approval remain required per job until several runs have
   passed?
3. What are the first monthly token budgets for the runner?
4. Should unlinked status polling be implemented in Stage 0, or is linked
   `WORK_REQUEST_STATUS` enough for the first deployment while unlinked status
   remains server-side/admin-only?
5. Which sandbox GitHub repo should be used for Stage 0.5 validation?

## Self-Review

- No production access is part of the design.
- The request path no longer requires account link, but requires known-EUI.
- Linked sync remains supported so existing pending events are not stranded.
- Dual delivery is explicitly idempotent by `request_uuid`.
- Class 2 is eligible for full automated builds in the test environment, but
  production and live ops remain excluded.
- The runner host is the test-server VPS with a dedicated user and wrappers,
  not the active OSI Server process/user. A dedicated VPS replaces it later.
- Deploy wrappers use sudo/deploy-svc with job-ID-only arguments.
- Status semantics distinguish unlinked polling from linked pending commands.
- Forward compatibility: unknown status values stored as-is, displayed generically.
- GitHub public artifacts are constrained to sanitized fields.
- Payload size limits enforced on edge and server.
- Rate limits are tiered: per-IP, per-known-EUI, and global circuit breaker.
- Prompt injection mitigated by system-message separation, deterministic
  pre-scan, request text truncation, and content-level post-execution gate.
- Gateway pseudonym uses 64 bits (16 hex chars) — collision-safe to 10k gateways.
- Dedup hash algorithm specified: SHA-256 of normalized fields.
