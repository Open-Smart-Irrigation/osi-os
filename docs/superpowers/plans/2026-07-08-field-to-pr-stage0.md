# Field-to-PR Stage 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Repo split:** this plan file lives in **osi-os**, but Stage 0 changes span `/home/phil/Repos/osi-os` and `/home/phil/Repos/osi-server`. Use separate feature worktrees/branches and separate PRs. Do not touch `osicloud.ch`.
> **Spec:** [`docs/superpowers/specs/2026-07-08-field-to-pr-design.md`](../specs/2026-07-08-field-to-pr-design.md). This plan implements **Stage 0 only**: feedback-to-issue, no runner, no agent, no draft PR automation.

**Goal:** Let authenticated field users submit public-consented bug/improvement/feedback requests from the edge GUI, deliver them to OSI Server through an unlinked support endpoint (and linked sync for backward compatibility), triage/publish them through an admin gate as sanitized GitHub issues, and show request status back on the gateway.

**Architecture:** The Pi remains a submission terminal: React form → authenticated Node-RED endpoint → SQLite `improvement_requests` → unlinked support delivery worker → `POST /api/v1/support/edge/work-requests`. OSI Server validates known-EUI (via the existing `devices` table which tracks GATEWAY heartbeats), applies deterministic redaction/dedup/rate/quarantine rules, stores private diagnostics in Postgres, and exposes an admin publish gate that creates GitHub issues only after public-artifact scanning. Status returns through the existing pending-command poll as a bounded `WORK_REQUEST_STATUS` command. Linked sync also accepts `WORK_REQUEST_SUBMITTED` through `/api/v1/sync/edge/events` for backward compatibility (e.g., Kaba100's pending event). Server-side idempotency by `request_uuid` makes dual delivery harmless.

**Tech Stack:** OSI OS React/Vite/Vitest/i18next, Node-RED `flows.json`, SQLite ordered migrations + bundled DB parity, OSI Server Java 17/Spring Boot/Flyway/JPA/Mockito/MockWebServer, OSI Server React admin UI.

**Implementation note — known-EUI gate:** The existing `devices` table already records GATEWAY heartbeats via `DeviceService.upsertFromHeartbeat` in `MqttMessageRouter.handleHeartbeat`. The known-EUI gate queries `devices` directly (`type = 'GATEWAY' AND last_seen > now() - 90 days`), avoiding a redundant migration.

---

## Global Constraints

- **No production access.** Do not SSH to / inspect / run commands on `osicloud.ch`.
- **Every public artifact is built from sanitized fields only.** `diagnostics_json`, real gateway EUI, local username, email, tokens, logs never leave OSI Server.
- **Edge schema change is additive but high-consequence.** Add `0005__field_work_requests.sql`, update `database/seed-blank.sql`, all bundled DBs, `deploy.sh` live repair, and schema verifiers in one osi-os PR.
- **`flows.json` edits are script-only** and applied to both maintained profiles: `bcm2712` canonical and `bcm2709` mirror.
- **Extend sync contracts** in `docs/contracts/sync-schema/` before changing flow/server sync behavior.
- **Payload size limits:** 64 KB total body, 32 KB diagnostics, title 3–80 chars, description 10–4000 chars.
- **Known-EUI validation:** the unlinked endpoint rejects requests from gateways the server has never seen.
- **Rate limits:** 10/day per source IP, 10/day per known EUI, 50/week per known EUI, 500 global pending unlinked circuit breaker.
- **Status commands are inert data-only updates** to `improvement_requests`; must not trigger actuator/downlink logic.

## Scope Split

This plan covers Stage 0 only. Excluded:

- Forge runner provisioning (Stage 1).
- Agent prompt assembly, worktree execution, draft PR creation (Stage 1).
- Deploy/verify wrappers for test devices (Stage 2).
- Sandbox repo validation (Stage 0.5 — follow-up).
- Production promotion to `osicloud.ch`.

## Stage 0 Decisions

- GitHub integration: GitHub App, not PAT. Missing config fails closed `PUBLISH_BLOCKED_CONFIG`.
- Status-back: `WORK_REQUEST_STATUS` pending command + dedicated edge apply node.
- Diagnostics retention: 90 days on server, configurable.
- NEEDS_INFO UX: shows status + reason, no in-GUI reply in Stage 0.
- Entry point: Settings → "Support & Requests". If the Settings shell has not shipped, add a temporary `/support-requests` route with a link from the account menu.

---

## Task 1: Sync Contract and Edge Schema

**Files:**
- Modify: `docs/contracts/sync-schema/events.schema.json`
- Modify: `docs/contracts/sync-schema/commands.schema.json`
- Modify: `scripts/test-contract-schemas.js`
- Create: `database/migrations/ordered/0005__field_work_requests.sql`
- Modify: `database/seed-blank.sql`
- Modify: `scripts/verify-db-schema-consistency.js`
- Modify: bundled `farming.db` copies
- Modify: `deploy.sh`
- Create: `scripts/test-improvement-requests-schema.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `improvement_requests` table DDL, `trg_improvement_requests_outbox_ai` trigger, `WORK_REQUEST_SUBMITTED` in event schema, `WORK_REQUEST_STATUS` in command schema, `scripts/test-improvement-requests-schema.js`

- [ ] **Step 1.1: Create the osi-os worktree/branch**

```bash
cd /home/phil/Repos/osi-os
git fetch origin
git worktree add .worktrees/field-to-pr-stage0 origin/main
cd .worktrees/field-to-pr-stage0
git switch -c feat/field-to-pr-stage0
```

Expected: worktree on `feat/field-to-pr-stage0`, no edits yet.

- [ ] **Step 1.2: Extend event contract tests first**

In `scripts/test-contract-schemas.js`, add `WORK_REQUEST_SUBMITTED` to the event op enum assertion and add a sample event:

```js
const sampleWorkRequestEvent = {
  eventUuid: 'work-request-019ff001-1111-7222-8333-aaaaaaaaaaaa',
  aggregateType: 'WORK_REQUEST',
  aggregateKey: '019ff001-1111-7222-8333-aaaaaaaaaaaa',
  op: 'WORK_REQUEST_SUBMITTED',
  syncVersion: 1,
  occurredAt: '2026-07-08T12:00:00.000Z',
  payload: {
    contract_version: 1,
    schema_version: 1,
    request_id: '019ff001-1111-7222-8333-aaaaaaaaaaaa',
    type: 'bug',
    title: 'Pump status is confusing',
    description: 'The dashboard says the pump is open after I closed it.',
    area: 'dashboard',
    severity: 'annoying',
    consent_public: true,
    consent_diagnostics: true,
    gateway_device_eui: '0016C001F11715E2',
    diagnostics: { sync: { pending_outbox_count: 0 } },
    gui_user: { local_user_id: 7 }
  }
};
```

Also add `WORK_REQUEST_STATUS` to the command enum assertion and a sample command:

```js
const sampleWorkRequestStatusCommand = {
  command_id: '019ff002-2222-7333-8444-bbbbbbbbbbbb',
  command_type: 'WORK_REQUEST_STATUS',
  device_eui: '0016C001F11715E2',
  issued_at: '2026-07-08T13:00:00.000Z',
  request_id: '019ff001-1111-7222-8333-aaaaaaaaaaaa',
  status: 'TRIAGED',
  reason: null,
  human_message: 'Your request is being reviewed.',
  released_version: null,
  updated_at: '2026-07-08T13:00:00.000Z'
};
```

Run: `node scripts/test-contract-schemas.js`
Expected: FAIL because the ops are not in the schemas yet.

- [ ] **Step 1.3: Update sync schemas**

In `docs/contracts/sync-schema/events.schema.json`, add `"WORK_REQUEST_SUBMITTED"` to `properties.op.enum`.

In `docs/contracts/sync-schema/commands.schema.json`:

1. Add `"WORK_REQUEST_STATUS"` to `properties.command_type.enum`.
2. Add nullable fields to `properties`:

```json
"request_id": {"type": ["string", "null"]},
"status": {"type": ["string", "null"]},
"human_message": {"type": ["string", "null"]},
"released_version": {"type": ["string", "null"]},
"updated_at": {"type": ["string", "null"], "format": "date-time"}
```

Note: `reason` already exists in the command schema.

3. Add an `allOf` branch requiring `request_id` and `status` when command is `WORK_REQUEST_STATUS`:

```json
{
  "if": {"properties": {"command_type": {"const": "WORK_REQUEST_STATUS"}}},
  "then": {
    "required": ["request_id", "status"],
    "properties": {
      "request_id": {"type": "string", "minLength": 1},
      "status": {"type": "string", "minLength": 1}
    }
  }
}
```

Run: `node scripts/test-contract-schemas.js`
Expected: PASS, including the new work request samples.

- [ ] **Step 1.4: Write additive SQLite migration**

Create `database/migrations/ordered/0005__field_work_requests.sql`:

```sql
-- risk: additive
-- 0005: Store field-originated improvement requests and sync them to OSI Server.

CREATE TABLE IF NOT EXISTS improvement_requests (
  request_uuid              TEXT PRIMARY KEY,
  user_id                   INTEGER NOT NULL,
  type                      TEXT NOT NULL CHECK (type IN ('bug','improvement','feedback')),
  title                     TEXT NOT NULL,
  description               TEXT NOT NULL,
  expected                  TEXT,
  actual                    TEXT,
  steps                     TEXT,
  area                      TEXT NOT NULL,
  severity                  TEXT NOT NULL CHECK (severity IN ('cant_work','workaround','annoying','idea')),
  consent_diagnostics       INTEGER NOT NULL DEFAULT 1 CHECK (consent_diagnostics IN (0,1)),
  consent_public            INTEGER NOT NULL CHECK (consent_public = 1),
  diagnostics_json          TEXT NOT NULL DEFAULT '{}',
  gateway_device_eui        TEXT,
  status_secret_hash        TEXT,
  contact_email             TEXT,
  local_status              TEXT NOT NULL DEFAULT 'QUEUED',
  cloud_status              TEXT,
  cloud_reason              TEXT,
  cloud_human_message       TEXT,
  released_version          TEXT,
  submitted_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_status_at            TEXT,
  created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_version              INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_improvement_requests_user_created_at
  ON improvement_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_improvement_requests_status
  ON improvement_requests(local_status, cloud_status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_improvement_requests_outbox_ai
AFTER INSERT ON improvement_requests
BEGIN
  INSERT OR IGNORE INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  )
  VALUES (
    'work-request-' || NEW.request_uuid,
    'WORK_REQUEST',
    NEW.request_uuid,
    'WORK_REQUEST_SUBMITTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'request_id', NEW.request_uuid,
      'type', NEW.type,
      'title', NEW.title,
      'description', NEW.description,
      'expected', NEW.expected,
      'actual', NEW.actual,
      'steps', NEW.steps,
      'area', NEW.area,
      'severity', NEW.severity,
      'consent_public', CASE WHEN NEW.consent_public = 1 THEN json('true') ELSE json('false') END,
      'consent_diagnostics', CASE WHEN NEW.consent_diagnostics = 1 THEN json('true') ELSE json('false') END,
      'diagnostics', json(NEW.diagnostics_json),
      'gateway_device_eui', NEW.gateway_device_eui,
      'status_secret_hash', NEW.status_secret_hash,
      'gui_user', json_object('local_user_id', NEW.user_id)
    ),
    NEW.sync_version,
    NEW.submitted_at,
    NEW.gateway_device_eui
  );
END;
```

Apply the equivalent DDL to `database/seed-blank.sql` after the `sync_link_state` section (after line ~580). The seed must include the same table, indexes, and trigger.

- [ ] **Step 1.5: Add schema regression script**

Create `scripts/test-improvement-requests-schema.js` that creates a scratch DB from `database/seed-blank.sql`, inserts a user, inserts one `improvement_requests` row, and asserts the trigger fired:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function createDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-schema-'));
  const dbPath = path.join(tmp, 'farming.db');
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'),
    encoding: 'utf8',
  });
  return dbPath;
}

function sqlJson(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

function sqlExec(dbPath, sql) {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}

test('improvement_requests insert triggers WORK_REQUEST_SUBMITTED outbox event', () => {
  const dbPath = createDb();
  const requestUuid = crypto.randomUUID();

  sqlExec(dbPath, `
    INSERT INTO users(username, password_hash, role) VALUES ('test-user', 'x', 'admin');
  `);
  const userId = sqlJson(dbPath, `SELECT id FROM users WHERE username='test-user'`)[0].id;

  sqlExec(dbPath, `
    INSERT INTO improvement_requests(
      request_uuid, user_id, type, title, description, area, severity,
      consent_public, consent_diagnostics, diagnostics_json, gateway_device_eui
    ) VALUES (
      '${requestUuid}', ${userId}, 'bug', 'Test title', 'Test description that is long enough',
      'dashboard', 'annoying', 1, 1, '{}', '0016C001F11715E2'
    );
  `);

  const rows = sqlJson(dbPath, `SELECT * FROM sync_outbox WHERE aggregate_type='WORK_REQUEST'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, 'WORK_REQUEST_SUBMITTED');
  assert.equal(rows[0].aggregate_key, requestUuid);

  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.contract_version, 1);
  assert.equal(payload.consent_public, true);
  assert.equal(payload.request_id, requestUuid);
  assert.equal(payload.type, 'bug');
  assert.equal(payload.gateway_device_eui, '0016C001F11715E2');
  assert.equal(payload.gui_user.local_user_id, userId);

  fs.rmSync(path.dirname(dbPath), { recursive: true });
});

test('improvement_requests rejects consent_public != 1', () => {
  const dbPath = createDb();
  sqlExec(dbPath, `INSERT INTO users(username, password_hash, role) VALUES ('u', 'x', 'admin');`);
  assert.throws(() => {
    sqlExec(dbPath, `
      INSERT INTO improvement_requests(
        request_uuid, user_id, type, title, description, area, severity,
        consent_public, consent_diagnostics, diagnostics_json
      ) VALUES ('bad', 1, 'bug', 'T', 'D', 'dashboard', 'idea', 0, 1, '{}');
    `);
  });
  fs.rmSync(path.dirname(dbPath), { recursive: true });
});
```

Run: `node --test scripts/test-improvement-requests-schema.js`
Expected: PASS.

- [ ] **Step 1.6: Update bundled DBs and schema verifier**

Regenerate all bundled `farming.db` copies with the new migration. Extend `scripts/verify-db-schema-consistency.js` so it checks:

- `improvement_requests` table exists with all columns from step 1.4.
- Both indexes exist.
- `trg_improvement_requests_outbox_ai` exists and contains `WORK_REQUEST_SUBMITTED`.

Run:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-db-schema-consistency.js
node --test scripts/test-improvement-requests-schema.js
node scripts/verify-profile-parity.js
```

Expected: all pass.

- [ ] **Step 1.7: Add deploy-time live repair**

In `deploy.sh`, add `ensure_improvement_requests_schema` following the pattern of `ensure_gateway_health_schema`: execute only the additive migration SQL against an existing `/data/db/farming.db`, verify `-- risk: additive` header, and assert the table exists afterward. Do not reseed or replace `/data/db/farming.db`.

Run: `bash -n deploy.sh`
Expected: no syntax errors.

- [ ] **Step 1.8: Commit**

```bash
git add docs/contracts/sync-schema scripts database deploy.sh
git diff --cached --check
git commit -m "$(cat <<'EOF'
feat: add edge field work request schema

Sync contract, SQLite migration 0005, outbox trigger, deploy repair,
schema verifiers, and bundled DB updates for improvement_requests.
EOF
)"
```

---

## Task 2: Edge Node-RED Intake, Delivery Worker, and Status Apply

**Files:**
- Modify both `flows.json` profile copies (script-only)
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/verify-sync-flow.js`

**Interfaces:**
- Consumes: Task 1's `improvement_requests` table, `WORK_REQUEST_SUBMITTED` event contract, `WORK_REQUEST_STATUS` command contract
- Produces: `GET /api/improvement-requests` endpoint, `GET /api/improvement-requests/diagnostics-preview` endpoint, `POST /api/improvement-requests` endpoint, support delivery worker, `work-request-status-apply` node

- [ ] **Step 2.1: Write flow wiring tests first**

Extend `scripts/test-flows-wiring.js` to assert:

- HTTP IN nodes exist for `GET /api/improvement-requests`, `GET /api/improvement-requests/diagnostics-preview`, and `POST /api/improvement-requests`.
- The intake router function has an `osiDb` lib binding and calls `.close(`.
- The intake router validates `consent_public`, title length (3–80), description length (10–4000), and total payload size.
- The intake router contains a redaction function stripping bearer tokens, JWT-like strings, AppKey hex, and email patterns.
- An inject node with a 300000 ms (5 min) interval exists with name containing `support-delivery`.
- `sync-pending-split` has a path routing `WORK_REQUEST_STATUS` to `work-request-status-apply` (not to actuator/downlink nodes).
- `work-request-status-apply` has an `osiDb` lib binding, updates `improvement_requests`, and wires to `command-ack-queue-rest`.

Run: `node scripts/test-flows-wiring.js`
Expected: FAIL with missing improvement request nodes.

- [ ] **Step 2.2: Script-edit `flows.json`**

Use a scratch Node script with the mandatory roundtrip guard from `.claude/skills/osi-flows-json-editing/SKILL.md`. Add a new self-contained API cluster on the system/admin tab:

**Intake API nodes:**
- `HTTP IN GET /api/improvement-requests` → `improvement-requests-api-router` → `http response`
- `HTTP IN GET /api/improvement-requests/diagnostics-preview` → same router
- `HTTP IN POST /api/improvement-requests` → same router

The router function must:

- Copy the `verifyBearer` auth block from the nearest authenticated API handler.
- Validate on POST: title length 3–80, description length 10–4000, type in `['bug','improvement','feedback']`, area is a non-empty string, severity in `['cant_work','workaround','annoying','idea']`, `consent_public === true`, total body JSON size < 65536 bytes.
- Build `diagnostics_json` from bounded sources: `flow.get('guiVersion')`, current route, `flow.get('sync_state')` summary (linked/pending counts), gateway EUI from `env.get('DEVICE_EUI')`, device count by type from a query, and `flow.get('gateway_health')` if available. Cap at 32 KB.
- Generate `request_uuid` as `crypto.randomUUID()`.
- Generate `status_secret` as 32 bytes of `crypto.randomBytes(32).toString('hex')` (256 bits). Store `SHA-256(status_secret)` as `status_secret_hash`. Return `status_secret` in the response so the React UI can store it locally.
- Redact text fields (title, description, expected, actual, steps) with fixed patterns: bearer tokens (`/[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g` → `[REDACTED]`), JWT-like strings (`/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g` → `[REDACTED]`), AppKey-like hex (`/\b[0-9A-Fa-f]{32}\b/g` → `[REDACTED]`), email patterns (`/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g` → `[REDACTED]`), and 16-hex EUI patterns in user text (`/\b[0-9A-Fa-f]{16}\b/g` → `[REDACTED]`). Keep `gateway_device_eui` as a structured field, not in redacted text.
- Insert into `improvement_requests`; rely on the trigger to enqueue `WORK_REQUEST_SUBMITTED`.
- Return `{ request_id, local_status: 'QUEUED', status_secret }` for POST and a list of request cards for GET.

**Support delivery worker nodes:**
- `inject` node, interval 300000 ms (5 min), name `support-delivery-tick`
- `support-delivery-worker` function node with `osiDb` lib binding

The delivery worker:

- Reads pending requests: `SELECT * FROM improvement_requests WHERE local_status = 'QUEUED' ORDER BY created_at ASC LIMIT 20`, then attempts at most five non-backed-off rows per tick.
- For each pending request, builds the unlinked endpoint payload from the corresponding `sync_outbox` row's `payload_json` (keyed by `'work-request-' || request_uuid`).
- Reads the server URL from `flow.get('sync_state')?.server_url` or falls back to `env.get('OSI_CLOUD_SERVER_URL')` or the hardcoded default `'https://server.opensmartirrigation.org'`.
- POSTs to `<serverUrl>/api/v1/support/edge/work-requests` with `Content-Type: application/json`. No auth header.
- On HTTP 200/202 with `result: 'accepted'` or `'duplicate'`: updates `improvement_requests SET local_status = 'SUBMITTED'` and stores GUI-known `cloud_status` values (`SUBMITTED` or `DUPLICATE`).
- On `result: 'rate_limited'` or HTTP 429: leaves the row `QUEUED`, persists `support_delivery_retries[request_uuid] = { count, lastAttempt }`, and retries after exponential backoff.
- On `result: 'quarantined'` or `'invalid'`: updates `local_status = 'REJECTED', cloud_status = 'REJECTED', cloud_reason = response.reason, cloud_human_message = response.human_message`.
- On missing local outbox payload: retries with backoff up to a bounded cap, then marks the request `REJECTED` with `cloud_reason = 'missing_outbox_payload'` so retry state cannot grow forever.
- On network error or HTTP 5xx: leaves the row as `QUEUED` for retry on next tick. Tracks retry count and `lastAttempt` in a flow variable `support_delivery_retries[request_uuid]` and backs off: skip if retry count > 0 and `Date.now() < lastAttempt + min(300000 * 2^retries, 3600000)`.

Wire: `support-delivery-tick` → `support-delivery-worker` (no output wiring needed; worker is self-contained with HTTP via the shared `osiCloudHttp.requestJsonIpv4` helper, and declares `osiDb` plus `osiCloudHttp` in `libs`).

**Status apply node:**
- Modify `sync-pending-split` to route commands with `command_type === 'WORK_REQUEST_STATUS'` to a new output wired to `work-request-status-apply`.
- `work-request-status-apply` function node with `osiDb` lib binding: updates `improvement_requests` by `request_id`, sets `cloud_status`, `cloud_reason`, `cloud_human_message`, `released_version`, `last_status_at = datetime('now')`, `updated_at = datetime('now')`. Returns an ACK to `command-ack-queue-rest`.

- [ ] **Step 2.3: Update sync verifiers**

In `scripts/verify-sync-flow.js`, add static checks for:

- `WORK_REQUEST_STATUS` is routed from `sync-pending-split` to the status apply node, NOT to actuator/downlink nodes.
- `WORK_REQUEST_SUBMITTED` appears only in the outbox trigger path, not in any MQTT subscribe or actuator node.
- The intake node contains `consent_public` validation and the `verifyBearer` auth block.
- The delivery worker contains the server URL resolution and no auth token transmission.

Run:

```bash
node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
node scripts/verify-profile-parity.js
```

Expected: all pass.

- [ ] **Step 2.4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-flows-wiring.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "$(cat <<'EOF'
feat: add edge field request intake flow and delivery worker

Node-RED intake API, unlinked support delivery worker (5 min interval
with exponential backoff), and WORK_REQUEST_STATUS command apply node.
EOF
)"
```

---

## Task 3: Edge React Support Requests UI

**Files:**
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/types/farming.ts`
- Modify: `web/react-gui/src/App.tsx`
- Create: `web/react-gui/src/pages/SupportRequests.tsx`
- Create: `web/react-gui/src/pages/__tests__/SupportRequests.test.tsx`
- Create/modify: `web/react-gui/public/locales/*/support.json`
- Modify: `web/react-gui/src/i18n/config.ts`
- Modify: `web/react-gui/src/types/i18next.d.ts`

**Interfaces:**
- Consumes: Task 2's `GET/POST /api/improvement-requests` and `GET /api/improvement-requests/diagnostics-preview`
- Produces: `/support-requests` route, `SupportRequests.tsx` page, `supportRequestsAPI` in `api.ts`, `SupportRequest`/`SupportRequestCreateRequest` types, `support.json` i18n namespace

- [ ] **Step 3.1: Add failing UI tests**

Create `web/react-gui/src/pages/__tests__/SupportRequests.test.tsx` with tests that mock the API and assert:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SupportRequests from '../SupportRequests';
import * as api from '../../services/api';

vi.mock('../../services/api');

describe('SupportRequests', () => {
  it('renders the form with type, title, description, area, severity, consent', () => {
    render(<MemoryRouter><SupportRequests /></MemoryRouter>);
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/consent/i)).toBeInTheDocument();
  });

  it('disables submit until consent_public is checked', () => {
    render(<MemoryRouter><SupportRequests /></MemoryRouter>);
    const submit = screen.getByRole('button', { name: /submit/i });
    expect(submit).toBeDisabled();
  });

  it('shows QUEUED as "Saved, waiting for internet"', async () => {
    vi.mocked(api.supportRequestsAPI.list).mockResolvedValue([
      { request_uuid: 'r1', title: 'Test', local_status: 'QUEUED', cloud_status: null,
        type: 'bug', area: 'dashboard', severity: 'annoying', created_at: '2026-07-08' }
    ]);
    render(<MemoryRouter><SupportRequests /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/waiting for internet/i)).toBeInTheDocument());
  });

  it('shows NEEDS_INFO with server message but no reply box', async () => {
    vi.mocked(api.supportRequestsAPI.list).mockResolvedValue([
      { request_uuid: 'r2', title: 'T', local_status: 'SUBMITTED', cloud_status: 'NEEDS_INFO',
        cloud_human_message: 'Please provide steps to reproduce.',
        type: 'bug', area: 'dashboard', severity: 'annoying', created_at: '2026-07-08' }
    ]);
    render(<MemoryRouter><SupportRequests /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText(/steps to reproduce/i)).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: /reply/i })).not.toBeInTheDocument();
    });
  });

  it('shows unknown cloud_status as generic update', async () => {
    vi.mocked(api.supportRequestsAPI.list).mockResolvedValue([
      { request_uuid: 'r3', title: 'T', local_status: 'SUBMITTED', cloud_status: 'FUTURE_STATE',
        type: 'bug', area: 'dashboard', severity: 'idea', created_at: '2026-07-08' }
    ]);
    render(<MemoryRouter><SupportRequests /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/status update/i)).toBeInTheDocument());
  });
});
```

Run: `cd web/react-gui && npx vitest run src/pages/__tests__/SupportRequests.test.tsx`
Expected: FAIL because the page/API do not exist.

- [ ] **Step 3.2: Add typed API boundary**

In `web/react-gui/src/types/farming.ts`, add:

```ts
export type SupportRequestType = 'bug' | 'improvement' | 'feedback';
export type SupportSeverity = 'cant_work' | 'workaround' | 'annoying' | 'idea';
export type SupportLocalStatus = 'DRAFT' | 'QUEUED' | 'SUBMITTED' | 'REJECTED';

export interface SupportRequest {
  request_uuid: string;
  type: SupportRequestType;
  title: string;
  description: string;
  area: string;
  severity: SupportSeverity;
  local_status: SupportLocalStatus;
  cloud_status: string | null;
  cloud_reason: string | null;
  cloud_human_message: string | null;
  released_version: string | null;
  created_at: string;
}

export interface SupportRequestCreateRequest {
  type: SupportRequestType;
  title: string;
  description: string;
  expected?: string;
  actual?: string;
  steps?: string;
  area: string;
  severity: SupportSeverity;
  consent_public: true;
  consent_diagnostics: boolean;
  contact_email?: string;
  route?: string;
}

export interface SupportRequestCreateResponse {
  request_id: string;
  local_status: string;
  status_secret: string;
}

export interface SupportDiagnosticsPreview {
  diagnostics: Record<string, unknown>;
  redacted_fields: string[];
}
```

In `web/react-gui/src/services/api.ts`, add:

```ts
export const supportRequestsAPI = {
  list: async (): Promise<SupportRequest[]> =>
    api.get<SupportRequest[]>('/api/improvement-requests').then((r) => r.data),
  diagnosticsPreview: async (route?: string): Promise<SupportDiagnosticsPreview> =>
    api.get<SupportDiagnosticsPreview>('/api/improvement-requests/diagnostics-preview',
      { params: { route } }).then((r) => r.data),
  create: async (request: SupportRequestCreateRequest): Promise<SupportRequestCreateResponse> =>
    api.post<SupportRequestCreateResponse>('/api/improvement-requests', request).then((r) => r.data),
};
```

- [ ] **Step 3.3: Build page and route**

Create `SupportRequests.tsx`:

- Header with back link to `/dashboard`.
- Two sections: **Submit a Request** (form) and **My Requests** (list).
- Form: type radio (`bug`/`improvement`/`feedback`), title input (3–80), description textarea (10–4000), optional expected/actual/steps textareas, area dropdown, severity dropdown, diagnostics accordion (fetched via `diagnosticsPreview`), consent checkbox, optional contact email.
- Submit button disabled until `consent_public` is checked and title/description meet length requirements.
- On submit: call `supportRequestsAPI.create()`. Store returned `status_secret` in `localStorage` keyed by `request_id`. Show "Saved, waiting for internet" banner.
- My Requests list: status chips mapping `local_status`/`cloud_status` to friendly strings. Known cloud statuses map to specific labels. Unknown `cloud_status` values display "Status update received".
- `NEEDS_INFO` shows `cloud_human_message` but no reply box.

Add route `/support-requests` in `App.tsx`, protected by `PrivateRoute`.

Entry point: if the Settings page shell (`/settings`) exists, add a "Support & Requests" link there. If not, add a temporary entry in the account `HeaderMenu` dropdown in `DashboardHeader.tsx` linking to `/support-requests`.

- [ ] **Step 3.4: Add i18n namespace**

Add `support.json` for all 7 locale directories (`en`, `de-CH`, `es`, `fr`, `it`, `lg`, `pt`). All files must have the same keys. Non-English files may initially use English strings.

Keys to include: `title`, `description`, `submit`, `consent_public`, `consent_diagnostics`, `type_bug`, `type_improvement`, `type_feedback`, `severity_*`, `status_queued`, `status_submitted`, `status_triaged`, `status_needs_info`, `status_rejected`, `status_duplicate`, `status_being_worked_on`, `status_pr_proposed`, `status_released`, `status_unknown`, `my_requests`, `no_requests`.

Update `web/react-gui/src/i18n/config.ts` namespace list to include `'support'`. Update `web/react-gui/src/types/i18next.d.ts`.

- [ ] **Step 3.5: Verify frontend**

```bash
cd web/react-gui
npx vitest run src/pages/__tests__/SupportRequests.test.tsx
npm run test:unit
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 3.6: Commit**

```bash
git add web/react-gui
git diff --cached --check
git commit -m "feat: add edge support request UI"
```

---

## Task 4: Server Persistence, Intake, Unlinked Endpoint, Linked Adapter

**Files (osi-server):**
- Create: `backend/src/main/resources/db/migration/V2026_07_09_001__work_requests.sql`
- Create: `backend/src/main/java/org/osi/server/workrequest/` (package)
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify: `backend/src/main/resources/application.yml`
- Create: `backend/src/test/java/org/osi/server/workrequest/` (tests)

**Interfaces:**
- Consumes: Task 1's sync contract (events.schema.json)
- Produces: `WorkRequestIntakeService.ingest(WorkRequestPayload, provenance)` → `IntakeResult`, `UnlinkedWorkRequestController`, `EdgeSyncService` handler for `WORK_REQUEST_SUBMITTED`, `WorkRequest` entity, `WorkRequestEvent` entity

- [ ] **Step 4.1: Create osi-server worktree/branch**

```bash
cd /home/phil/Repos/osi-server
git fetch origin
git worktree add .worktrees/field-to-pr-stage0 origin/main
cd .worktrees/field-to-pr-stage0
git switch -c feat/field-to-pr-stage0
```

- [ ] **Step 4.2: Write failing service tests**

Create `backend/src/test/java/org/osi/server/workrequest/WorkRequestIntakeServiceTest.java`:

```java
@ExtendWith(MockitoExtension.class)
class WorkRequestIntakeServiceTest {

    @Mock WorkRequestRepository workRequestRepo;
    @Mock WorkRequestEventRepository eventRepo;
    @Mock WorkRequestGatewayControlRepository controlRepo;
    @Mock DeviceRepository deviceRepo;
    @InjectMocks WorkRequestIntakeService service;

    @Test
    void acceptsValidRequestFromKnownGateway() {
        when(deviceRepo.existsByDeviceEuiAndTypeAndLastSeenAfter(
            eq("0016C001F11766E7"), eq("GATEWAY"), any()))
            .thenReturn(true);
        when(workRequestRepo.findByRequestUuid(any())).thenReturn(Optional.empty());
        when(workRequestRepo.countByGatewayEuiAndCreatedAtAfter(any(), any())).thenReturn(0L);
        when(controlRepo.findById(any())).thenReturn(Optional.empty());

        var payload = testPayload("0016C001F11766E7");
        var result = service.ingest(payload, "UNLINKED_SUPPORT");

        assertThat(result.result()).isEqualTo("accepted");
        verify(workRequestRepo).save(any());
        verify(eventRepo).save(argThat(e -> e.getEventType().equals("SUBMITTED")));
    }

    @Test
    void rejectsUnknownGateway() {
        when(deviceRepo.existsByDeviceEuiAndTypeAndLastSeenAfter(
            eq("AAAAAAAAAAAAAAAA"), eq("GATEWAY"), any()))
            .thenReturn(false);

        var payload = testPayload("AAAAAAAAAAAAAAAA");
        var result = service.ingest(payload, "UNLINKED_SUPPORT");

        assertThat(result.result()).isEqualTo("invalid");
        assertThat(result.reason()).isEqualTo("unknown_gateway");
        verify(workRequestRepo, never()).save(any());
    }

    @Test
    void returnsDuplicateForSameRequestUuid() {
        when(deviceRepo.existsByDeviceEuiAndTypeAndLastSeenAfter(any(), any(), any()))
            .thenReturn(true);
        var existing = new WorkRequest();
        existing.setState("SUBMITTED");
        when(workRequestRepo.findByRequestUuid("dup-uuid")).thenReturn(Optional.of(existing));

        var payload = testPayload("0016C001F11766E7");
        payload = payload.withRequestId("dup-uuid");
        var result = service.ingest(payload, "UNLINKED_SUPPORT");

        assertThat(result.result()).isEqualTo("duplicate");
    }

    @Test
    void redactsEmailAndBearerFromPublicFields() {
        when(deviceRepo.existsByDeviceEuiAndTypeAndLastSeenAfter(any(), any(), any()))
            .thenReturn(true);
        when(workRequestRepo.findByRequestUuid(any())).thenReturn(Optional.empty());
        when(workRequestRepo.countByGatewayEuiAndCreatedAtAfter(any(), any())).thenReturn(0L);
        when(controlRepo.findById(any())).thenReturn(Optional.empty());

        var payload = testPayload("0016C001F11766E7")
            .withTitle("Bug with token Bearer abc123def456.xyz")
            .withDescription("Contact me at user@example.com about AppKey 0123456789ABCDEF0123456789ABCDEF");

        var result = service.ingest(payload, "UNLINKED_SUPPORT");
        assertThat(result.result()).isEqualTo("accepted");

        var saved = captureSavedWorkRequest();
        assertThat(saved.getPublicTitle()).doesNotContain("abc123def456");
        assertThat(saved.getPublicBody()).doesNotContain("user@example.com");
        assertThat(saved.getPublicBody()).doesNotContain("0123456789ABCDEF");
    }

    @Test
    void enforcesPerGatewayDailyRateLimit() {
        when(deviceRepo.existsByDeviceEuiAndTypeAndLastSeenAfter(any(), any(), any()))
            .thenReturn(true);
        when(workRequestRepo.findByRequestUuid(any())).thenReturn(Optional.empty());
        when(workRequestRepo.countByGatewayEuiAndCreatedAtAfter(
            eq("0016C001F11766E7"), any()))
            .thenReturn(10L); // at the 10/day limit
        when(controlRepo.findById(any())).thenReturn(Optional.empty());

        var result = service.ingest(testPayload("0016C001F11766E7"), "UNLINKED_SUPPORT");
        assertThat(result.result()).isEqualTo("rate_limited");
    }

    @Test
    void blocksQuarantinedGateway() {
        when(deviceRepo.existsByDeviceEuiAndTypeAndLastSeenAfter(any(), any(), any()))
            .thenReturn(true);
        when(workRequestRepo.findByRequestUuid(any())).thenReturn(Optional.empty());
        var control = new WorkRequestGatewayControl();
        control.setQuarantined(true);
        control.setQuarantineReason("abuse");
        when(controlRepo.findById("0016C001F11766E7")).thenReturn(Optional.of(control));

        var result = service.ingest(testPayload("0016C001F11766E7"), "UNLINKED_SUPPORT");
        assertThat(result.result()).isEqualTo("quarantined");
    }
}
```

Include `testPayload` and `captureSavedWorkRequest` helper methods.

Run: `cd backend && ./gradlew test --tests 'org.osi.server.workrequest.*' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL because package/classes do not exist.

- [ ] **Step 4.3: Add Flyway migration**

Create `backend/src/main/resources/db/migration/V2026_07_09_001__work_requests.sql`:

```sql
CREATE TABLE work_requests (
    id BIGSERIAL PRIMARY KEY,
    request_uuid VARCHAR(64) NOT NULL UNIQUE,
    gateway_eui VARCHAR(32) NOT NULL,
    gateway_pseudonym VARCHAR(40) NOT NULL,
    local_user_ref VARCHAR(128),
    contact_email VARCHAR(254),
    country_code CHAR(2),
    provenance VARCHAR(32) NOT NULL,
    request_type VARCHAR(24) NOT NULL,
    area VARCHAR(64) NOT NULL,
    severity VARCHAR(32) NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    expected TEXT,
    actual TEXT,
    steps TEXT,
    public_title TEXT NOT NULL,
    public_body TEXT NOT NULL,
    diagnostics_json JSONB,
    status_secret_hash VARCHAR(128),
    dedup_hash VARCHAR(64) NOT NULL,
    duplicate_of_id BIGINT REFERENCES work_requests(id),
    risk_class INTEGER NOT NULL DEFAULT 4,
    state VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
    github_repo VARCHAR(128),
    github_issue_number INTEGER,
    github_issue_url TEXT,
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_work_requests_gateway_created ON work_requests(gateway_eui, created_at DESC);
CREATE INDEX ix_work_requests_state_created ON work_requests(state, created_at DESC);
CREATE INDEX ix_work_requests_dedup_hash ON work_requests(dedup_hash);

CREATE TABLE work_request_events (
    id BIGSERIAL PRIMARY KEY,
    work_request_id BIGINT NOT NULL REFERENCES work_requests(id) ON DELETE CASCADE,
    actor VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    reason TEXT,
    evidence_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_work_request_events_request_created
    ON work_request_events(work_request_id, created_at);

CREATE TABLE work_request_gateway_controls (
    gateway_eui VARCHAR(32) PRIMARY KEY,
    quarantined BOOLEAN NOT NULL DEFAULT false,
    quarantine_reason TEXT,
    daily_count_override INTEGER,
    weekly_count_override INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 4.4: Implement domain services**

Create these classes in `backend/src/main/java/org/osi/server/workrequest/`:

**`WorkRequest.java`** — JPA entity with all columns from the migration. Lombok `@Data @Builder @Entity @Table(name = "work_requests")`.

**`WorkRequestEvent.java`** — JPA entity for audit log. `@Data @Builder @Entity`.

**`WorkRequestGatewayControl.java`** — JPA entity for quarantine/rate overrides. `@Data @Entity`.

**`WorkRequestRepository.java`** — JPA repository:

```java
public interface WorkRequestRepository extends JpaRepository<WorkRequest, Long> {
    Optional<WorkRequest> findByRequestUuid(String requestUuid);
    long countByGatewayEuiAndCreatedAtAfter(String gatewayEui, Instant after);
    long countByGatewayEuiAndCreatedAtAfterAndProvenance(String gatewayEui, Instant after, String provenance);
    long countByProvenanceAndStateIn(String provenance, List<String> states);
    List<WorkRequest> findByStateInOrderByCreatedAtDesc(List<String> states);
}
```

**`WorkRequestPayload.java`** — record for deserialized edge payload:

```java
public record WorkRequestPayload(
    int contractVersion, int schemaVersion, String requestId, String type,
    String title, String description, String expected, String actual,
    String steps, String area, String severity, boolean consentPublic,
    boolean consentDiagnostics, Map<String, Object> diagnostics,
    String gatewayDeviceEui, String statusSecretHash, String contactEmail,
    GuiUser guiUser
) {
    public record GuiUser(int localUserId, String username) {}

    public WorkRequestPayload withRequestId(String id) {
        return new WorkRequestPayload(contractVersion, schemaVersion, id, type,
            title, description, expected, actual, steps, area, severity,
            consentPublic, consentDiagnostics, diagnostics, gatewayDeviceEui,
            statusSecretHash, contactEmail, guiUser);
    }

    public WorkRequestPayload withTitle(String t) {
        return new WorkRequestPayload(contractVersion, schemaVersion, requestId, type,
            t, description, expected, actual, steps, area, severity,
            consentPublic, consentDiagnostics, diagnostics, gatewayDeviceEui,
            statusSecretHash, contactEmail, guiUser);
    }

    public WorkRequestPayload withDescription(String d) {
        return new WorkRequestPayload(contractVersion, schemaVersion, requestId, type,
            title, d, expected, actual, steps, area, severity,
            consentPublic, consentDiagnostics, diagnostics, gatewayDeviceEui,
            statusSecretHash, contactEmail, guiUser);
    }
}
```

**`IntakeResult.java`** — record for intake response:

```java
public record IntakeResult(
    String requestId, String result, String status,
    String reason, String humanMessage, Instant serverReceivedAt
) {}
```

**`WorkRequestRedactor.java`** — stateless utility:

```java
@Component
public class WorkRequestRedactor {
    private static final List<Pattern> PATTERNS = List.of(
        Pattern.compile("[Bb]earer\\s+[A-Za-z0-9._~+/=-]{20,}"),
        Pattern.compile("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"),
        Pattern.compile("\\b[0-9A-Fa-f]{32}\\b"),
        Pattern.compile("[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"),
        Pattern.compile("\\b[0-9A-Fa-f]{16}\\b")
    );

    public String redact(String text) {
        if (text == null) return null;
        String result = text;
        for (Pattern p : PATTERNS) {
            result = p.matcher(result).replaceAll("[REDACTED]");
        }
        return result;
    }
}
```

**`WorkRequestIntakeService.java`** — core service:

```java
@Service
@RequiredArgsConstructor
public class WorkRequestIntakeService {
    private final WorkRequestRepository workRequestRepo;
    private final WorkRequestEventRepository eventRepo;
    private final WorkRequestGatewayControlRepository controlRepo;
    private final DeviceRepository deviceRepo;
    private final WorkRequestRedactor redactor;

    @Value("${work-requests.pseudonym-secret:default-dev-secret}")
    private String pseudonymSecret;

    @Transactional
    public IntakeResult ingest(WorkRequestPayload payload, String provenance) {
        String eui = payload.gatewayDeviceEui().toUpperCase();

        // 1. Known-EUI gate (skip for LINKED_SYNC — already auth'd)
        if ("UNLINKED_SUPPORT".equals(provenance)) {
            boolean known = deviceRepo.existsByDeviceEuiAndTypeAndLastSeenAfter(
                eui, "GATEWAY", Instant.now().minus(Duration.ofDays(90)));
            if (!known) {
                return new IntakeResult(payload.requestId(), "invalid",
                    null, "unknown_gateway", "Gateway not recognized.", Instant.now());
            }
        }

        // 2. Idempotency by request_uuid
        var existing = workRequestRepo.findByRequestUuid(payload.requestId());
        if (existing.isPresent()) {
            return new IntakeResult(payload.requestId(), "duplicate",
                existing.get().getState(), null, null, Instant.now());
        }

        // 3. Quarantine check
        var control = controlRepo.findById(eui);
        if (control.isPresent() && control.get().isQuarantined()) {
            return new IntakeResult(payload.requestId(), "quarantined",
                null, "gateway_quarantined", control.get().getQuarantineReason(),
                Instant.now());
        }

        // 4. Rate limit (10/day, 50/week per EUI)
        long dailyCount = workRequestRepo.countByGatewayEuiAndCreatedAtAfter(
            eui, Instant.now().minus(Duration.ofDays(1)));
        if (dailyCount >= 10) {
            return new IntakeResult(payload.requestId(), "rate_limited",
                null, "daily_limit", "Daily request limit reached.", Instant.now());
        }
        long weeklyCount = workRequestRepo.countByGatewayEuiAndCreatedAtAfter(
            eui, Instant.now().minus(Duration.ofDays(7)));
        if (weeklyCount >= 50) {
            return new IntakeResult(payload.requestId(), "rate_limited",
                null, "weekly_limit", "Weekly request limit reached.", Instant.now());
        }

        // 5. Global circuit breaker (500 pending unlinked)
        if ("UNLINKED_SUPPORT".equals(provenance)) {
            long pending = workRequestRepo.countByProvenanceAndStateIn(
                "UNLINKED_SUPPORT", List.of("SUBMITTED", "TRIAGED", "AWAITING_PUBLISH"));
            if (pending >= 500) {
                return new IntakeResult(payload.requestId(), "rate_limited",
                    null, "global_limit", "System is busy. Try again later.", Instant.now());
            }
        }

        // 6. Redact + build
        String pseudonym = computePseudonym(eui);
        String publicTitle = redactor.redact(payload.title());
        String publicBody = redactor.redact(payload.description());
        String dedupHash = computeDedupHash(payload, pseudonym);
        int riskClass = classifyRisk(payload);

        WorkRequest wr = WorkRequest.builder()
            .requestUuid(payload.requestId())
            .gatewayEui(eui)
            .gatewayPseudonym(pseudonym)
            .localUserRef(payload.guiUser() != null
                ? String.valueOf(payload.guiUser().localUserId()) : null)
            .contactEmail(payload.contactEmail())
            .provenance(provenance)
            .requestType(payload.type())
            .area(payload.area())
            .severity(payload.severity())
            .title(payload.title())
            .description(payload.description())
            .expected(payload.expected())
            .actual(payload.actual())
            .steps(payload.steps())
            .publicTitle(publicTitle)
            .publicBody(publicBody)
            .diagnosticsJson(payload.diagnostics())
            .statusSecretHash(payload.statusSecretHash())
            .dedupHash(dedupHash)
            .riskClass(riskClass)
            .state("SUBMITTED")
            .submittedAt(Instant.now())
            .build();
        workRequestRepo.save(wr);

        eventRepo.save(WorkRequestEvent.builder()
            .workRequestId(wr.getId())
            .actor("system")
            .eventType("SUBMITTED")
            .reason(provenance)
            .build());

        return new IntakeResult(payload.requestId(), "accepted",
            "SUBMITTED", null, "Request received.", Instant.now());
    }

    private String computePseudonym(String eui) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(pseudonymSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] hash = mac.doFinal(eui.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder("gw_");
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", hash[i]));
            return sb.toString(); // gw_ + 16 hex chars = 64 bits
        } catch (Exception e) {
            throw new IllegalStateException("HMAC failed", e);
        }
    }

    private String computeDedupHash(WorkRequestPayload p, String pseudonym) {
        String input = String.join("|",
            p.type().toLowerCase().trim(),
            p.title().toLowerCase().trim(),
            p.description().toLowerCase().trim().substring(0, Math.min(200, p.description().trim().length())),
            p.area().toLowerCase().trim(),
            pseudonym);
        return Hex.toHexString(MessageDigest.getInstance("SHA-256")
            .digest(input.getBytes(StandardCharsets.UTF_8)));
    }

    private int classifyRisk(WorkRequestPayload p) {
        String text = (p.title() + " " + p.description()).toLowerCase();
        if (text.matches(".*\\b(ssh|password|token|\\.github|workflow|deploy|osicloud|production)\\b.*"))
            return 4;
        if ("feedback".equals(p.type()) || p.description().trim().length() < 20) return 4;
        if (Set.of("dashboard", "history", "analysis", "copy").contains(p.area().toLowerCase()))
            return 1;
        return 4;
    }
}
```

- [ ] **Step 4.5: Create unlinked endpoint controller**

Create `backend/src/main/java/org/osi/server/workrequest/UnlinkedWorkRequestController.java`:

```java
@RestController
@RequestMapping("/api/v1/support/edge")
@RequiredArgsConstructor
public class UnlinkedWorkRequestController {

    private final WorkRequestIntakeService intakeService;
    private final ObjectMapper objectMapper;
    private final RateLimitFilter rateLimitFilter; // reuse IP extraction

    @PostMapping("/work-requests")
    public ResponseEntity<IntakeResult> submit(
            @RequestBody String rawBody,
            HttpServletRequest request) {
        // Payload size gate
        if (rawBody.length() > 65536) {
            return ResponseEntity.badRequest().body(new IntakeResult(
                null, "invalid", null, "payload_too_large",
                "Request body exceeds 64 KB limit.", Instant.now()));
        }

        WorkRequestPayload payload;
        try {
            payload = objectMapper.readValue(rawBody, WorkRequestPayload.class);
        } catch (Exception e) {
            return ResponseEntity.badRequest().body(new IntakeResult(
                null, "invalid", null, "malformed_payload",
                "Invalid request format.", Instant.now()));
        }

        if (payload.contractVersion() != 1 || !payload.consentPublic()) {
            return ResponseEntity.badRequest().body(new IntakeResult(
                payload.requestId(), "invalid", null, "invalid_contract",
                "Contract version 1 and public consent are required.", Instant.now()));
        }

        IntakeResult result = intakeService.ingest(payload, "UNLINKED_SUPPORT");
        int status = switch (result.result()) {
            case "accepted" -> 202;
            case "duplicate" -> 200;
            case "rate_limited" -> 429;
            case "quarantined" -> 403;
            case "invalid" -> 400;
            default -> 500;
        };
        return ResponseEntity.status(status).body(result);
    }
}
```

Add to `SecurityConfig` to permit this endpoint without authentication (same pattern as public health endpoints).

- [ ] **Step 4.6: Wire linked sync adapter**

In `EdgeSyncService.applyEvent`, add a case for `WORK_REQUEST_SUBMITTED`:

```java
case "WORK_REQUEST_SUBMITTED" -> {
    if (!dryRun) {
        var payload = objectMapper.convertValue(event.payload(), WorkRequestPayload.class);
        intakeService.ingest(payload, "LINKED_SYNC");
    }
    return true;
}
```

Add `@Autowired WorkRequestIntakeService` to `EdgeSyncService`.

The linked adapter's ownership is already handled: `EdgeOwnershipService` validates that the gateway EUI in the sync request matches the authenticated sync token, and `WORK_REQUEST` uses `gatewayDeviceEui` as the resource key prefix.

- [ ] **Step 4.7: Add config**

In `application.yml`:

```yaml
work-requests:
  pseudonym-secret: ${WORK_REQUESTS_PSEUDONYM_SECRET:dev-pseudonym-secret-change-me}
  diagnostics-retention-days: ${WORK_REQUESTS_DIAGNOSTICS_RETENTION_DAYS:90}
```

- [ ] **Step 4.8: Run tests**

```bash
cd backend
./gradlew test --tests 'org.osi.server.workrequest.*' \
  --tests 'org.osi.server.sync.EdgeSyncService*Test' \
  -x buildFrontend -x buildTerraIntelligenceFrontend
```

Expected: all pass.

- [ ] **Step 4.9: Commit**

```bash
git add backend/src/main/resources/db/migration \
        backend/src/main/java/org/osi/server/workrequest \
        backend/src/test/java/org/osi/server/workrequest \
        backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
        backend/src/main/resources/application.yml \
        backend/src/main/java/org/osi/server/config/SecurityConfig.java
git diff --cached --check
git commit -m "$(cat <<'EOF'
feat: ingest field work requests on server

Flyway migration, WorkRequestIntakeService with known-EUI gate and
redaction, unlinked POST endpoint, linked sync adapter, rate limits
(10/day, 50/week per EUI), quarantine support, and dedup by UUID.
EOF
)"
```

---

## Task 5: Publish Gate and GitHub Issue Creation

**Files (osi-server):**
- Create: `backend/src/main/java/org/osi/server/workrequest/GitHubAppTokenService.java`
- Create: `backend/src/main/java/org/osi/server/workrequest/GitHubIssueClient.java`
- Create: `backend/src/main/java/org/osi/server/workrequest/PublicArtifactSecretScanner.java`
- Create: `backend/src/main/java/org/osi/server/workrequest/WorkRequestAdminController.java`
- Create: tests

**Interfaces:**
- Consumes: Task 4's `WorkRequestIntakeService`, `WorkRequest`, `WorkRequestRepository`
- Produces: `WorkRequestAdminController` endpoints (triage, publish, reject, quarantine), `PublicArtifactSecretScanner.scan()`, `GitHubIssueClient.createIssue()`

- [ ] **Step 5.1: Write failing publish tests**

Test cases in `WorkRequestPublishServiceTest.java`:

```java
@Test
void scannerRejectsRawEuiInPublicBody() {
    assertThat(scanner.scan("Bug with device 0016C001F11766E7"))
        .containsExactly("16-hex EUI pattern detected");
}

@Test
void scannerRejectsBearerToken() {
    assertThat(scanner.scan("Error: Bearer eyJhbGciOiJIUzI1NiJ9.test"))
        .isNotEmpty();
}

@Test
void scannerAcceptsCleanText() {
    assertThat(scanner.scan("The pump status is wrong after closing")).isEmpty();
}

@Test
void publishWithMissingGitHubConfigFailsClosed() {
    // GitHub config has empty appId
    var result = publishService.publish(workRequestId);
    assertThat(result.state()).isEqualTo("PUBLISH_BLOCKED_CONFIG");
    verify(githubClient, never()).createIssue(any(), any(), any(), any());
}

@Test
void publishWithSafeArtifactCreatesIssue() {
    when(githubClient.createIssue(any(), any(), any(), any()))
        .thenReturn(new GitHubIssueResult("osi-os", 42, "https://github.com/…/42"));
    var result = publishService.publish(workRequestId);
    assertThat(result.state()).isEqualTo("ISSUE_OPEN");
    verify(eventRepo).save(argThat(e -> e.getEventType().equals("PUBLISHED")));
}

@Test
void publishTransientGitHubFailureLeavesAwaitingPublish() {
    when(githubClient.createIssue(any(), any(), any(), any()))
        .thenThrow(new RuntimeException("GitHub 503"));
    var result = publishService.publish(workRequestId);
    assertThat(result.state()).isEqualTo("AWAITING_PUBLISH");
    verify(eventRepo).save(argThat(e -> e.getEventType().equals("PUBLISH_FAILED")));
}

@Test
void duplicatePublishIsIdempotent() {
    workRequest.setGithubIssueNumber(42);
    var result = publishService.publish(workRequestId);
    assertThat(result.state()).isEqualTo("ISSUE_OPEN");
    verify(githubClient, never()).createIssue(any(), any(), any(), any());
}
```

Run: `cd backend && ./gradlew test --tests 'org.osi.server.workrequest.*Publish*' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL.

- [ ] **Step 5.2: Implement scanner, GitHub client, and publish service**

**`PublicArtifactSecretScanner.java`** — scans text for secret-like patterns. Returns list of findings (empty = safe). Same patterns as `WorkRequestRedactor` but returns violations instead of replacing.

**`GitHubAppTokenService.java`** — signs short-lived JWT from App private key, exchanges for installation token. Config:

```yaml
work-requests:
  github:
    app-id: ${WORK_REQUESTS_GITHUB_APP_ID:}
    installation-id: ${WORK_REQUESTS_GITHUB_INSTALLATION_ID:}
    private-key-pem: ${WORK_REQUESTS_GITHUB_PRIVATE_KEY_PEM:}
    api-base-url: ${WORK_REQUESTS_GITHUB_API_BASE_URL:https://api.github.com}
    default-repo: ${WORK_REQUESTS_GITHUB_DEFAULT_REPO:Open-Smart-Irrigation/osi-os}
    allowed-repos: ${WORK_REQUESTS_GITHUB_ALLOWED_REPOS:Open-Smart-Irrigation/osi-os,Open-Smart-Irrigation/osi-server}
```

If `app-id` is blank, `isConfigured()` returns false.

**`GitHubIssueClient.java`** — `createIssue(ownerRepo, title, body, labels)`. Uses `RestTemplate` with the installation token.

**`WorkRequestPublishService.java`**:

```java
@Transactional
public PublishResult publish(Long workRequestId) {
    WorkRequest wr = workRequestRepo.findById(workRequestId).orElseThrow();

    // Idempotent: already published
    if (wr.getGithubIssueNumber() != null) {
        return new PublishResult("ISSUE_OPEN", wr.getGithubIssueUrl());
    }

    // Config gate
    if (!githubTokenService.isConfigured()) {
        wr.setState("PUBLISH_BLOCKED_CONFIG");
        workRequestRepo.save(wr);
        eventRepo.save(event(wr, "PUBLISH_BLOCKED_CONFIG", "GitHub App not configured"));
        return new PublishResult("PUBLISH_BLOCKED_CONFIG", null);
    }

    // Secret scan on public fields
    List<String> findings = scanner.scan(wr.getPublicTitle() + " " + wr.getPublicBody());
    if (!findings.isEmpty()) {
        wr.setState("PUBLISH_BLOCKED_SECRETS");
        workRequestRepo.save(wr);
        eventRepo.save(event(wr, "PUBLISH_BLOCKED_SECRETS", String.join("; ", findings)));
        return new PublishResult("PUBLISH_BLOCKED_SECRETS", null);
    }

    // Build issue
    String title = "[from-field] " + wr.getPublicTitle();
    String body = buildIssueBody(wr);
    List<String> labels = List.of("from-field",
        "class:" + wr.getRiskClass(),
        "sev:" + wr.getSeverity(),
        "area:" + wr.getArea(),
        wr.getGatewayPseudonym());

    try {
        var issue = githubClient.createIssue(
            wr.getGithubRepo() != null ? wr.getGithubRepo() : defaultRepo,
            title, body, labels);
        wr.setGithubRepo(issue.repo());
        wr.setGithubIssueNumber(issue.number());
        wr.setGithubIssueUrl(issue.url());
        wr.setState("ISSUE_OPEN");
        workRequestRepo.save(wr);
        eventRepo.save(event(wr, "PUBLISHED", "Issue #" + issue.number()));
        return new PublishResult("ISSUE_OPEN", issue.url());
    } catch (Exception e) {
        eventRepo.save(event(wr, "PUBLISH_FAILED", e.getMessage()));
        return new PublishResult("AWAITING_PUBLISH", null);
    }
}
```

Issue body format:

```
**From field** | {country_flag} | {gateway_pseudonym} | class {risk_class} | {severity}

> {public_body}

---
*Submitted via OSI Field Request pipeline. Private diagnostics available in admin console.*
```

No diagnostics, no real EUI, no email, no username in the issue body.

- [ ] **Step 5.3: Add admin endpoints**

Create `WorkRequestAdminController` at `/api/v1/admin/work-requests`:

```java
@RestController
@RequestMapping("/api/v1/admin/work-requests")
@RequiredArgsConstructor
public class WorkRequestAdminController {

    @GetMapping
    public List<WorkRequestAdminDto> list(@RequestParam(defaultValue = "SUBMITTED") String state) { ... }

    @PostMapping("/{id}/triage")
    public WorkRequestAdminDto triage(@PathVariable Long id, @RequestBody TriageRequest req) { ... }

    @PostMapping("/{id}/publish")
    public PublishResult publish(@PathVariable Long id) { ... }

    @PostMapping("/{id}/reject")
    public WorkRequestAdminDto reject(@PathVariable Long id, @RequestBody RejectRequest req) { ... }

    @PostMapping("/gateways/{gatewayEui}/quarantine")
    public void quarantine(@PathVariable String gatewayEui, @RequestBody QuarantineRequest req) { ... }
}
```

All endpoints require admin role (existing `/api/v1/admin/**` security rule).

- [ ] **Step 5.4: Verify**

```bash
cd backend
./gradlew test --tests 'org.osi.server.workrequest.*' -x buildFrontend -x buildTerraIntelligenceFrontend
```

Expected: all pass.

- [ ] **Step 5.5: Commit**

```bash
git add backend/src/main/java/org/osi/server/workrequest \
        backend/src/test/java/org/osi/server/workrequest \
        backend/src/main/resources/application.yml
git diff --cached --check
git commit -m "feat: add field request publish gate and GitHub issue creation"
```

---

## Task 6: Server Admin Console

**Files (osi-server):**
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types/farming.ts`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/pages/admin/AdminWorkRequests.tsx`
- Create: `frontend/src/pages/admin/__tests__/AdminWorkRequests.test.tsx`
- Modify: `frontend/src/components/DashboardHeader.tsx`
- Modify: `frontend/public/locales/*/admin.json`

**Interfaces:**
- Consumes: Task 5's admin endpoints (`GET /api/v1/admin/work-requests`, `POST .../triage`, `.../publish`, `.../reject`, `.../quarantine`)
- Produces: `/admin/work-requests` route, admin menu entry

- [ ] **Step 6.1: Add failing frontend tests**

Create `frontend/src/pages/admin/__tests__/AdminWorkRequests.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminWorkRequests from '../AdminWorkRequests';
import * as api from '../../../services/api';

vi.mock('../../../services/api');

describe('AdminWorkRequests', () => {
  it('renders queue with title, pseudonym, class, state', async () => {
    vi.mocked(api.adminWorkRequestsAPI.list).mockResolvedValue([
      { id: 1, requestUuid: 'r1', publicTitle: 'Bug title', gatewayPseudonym: 'gw_abc123',
        riskClass: 1, state: 'SUBMITTED', area: 'dashboard', severity: 'annoying',
        createdAt: '2026-07-08T12:00:00Z' }
    ]);
    render(<MemoryRouter><AdminWorkRequests /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Bug title')).toBeInTheDocument();
      expect(screen.getByText('gw_abc123')).toBeInTheDocument();
    });
  });

  it('does not display diagnostics in queue table', async () => {
    vi.mocked(api.adminWorkRequestsAPI.list).mockResolvedValue([
      { id: 1, requestUuid: 'r1', publicTitle: 'T', gatewayPseudonym: 'gw_x',
        diagnosticsJson: { sync: { pending: 5 } },
        riskClass: 1, state: 'SUBMITTED', area: 'a', severity: 's',
        createdAt: '2026-07-08' }
    ]);
    render(<MemoryRouter><AdminWorkRequests /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.queryByText('pending')).not.toBeInTheDocument();
    });
  });

  it('quarantine action requires confirmation', async () => {
    vi.mocked(api.adminWorkRequestsAPI.list).mockResolvedValue([]);
    render(<MemoryRouter><AdminWorkRequests /></MemoryRouter>);
    // Quarantine button should require confirm dialog
  });
});
```

Run: `cd frontend && npx vitest run src/pages/admin/__tests__/AdminWorkRequests.test.tsx`
Expected: FAIL.

- [ ] **Step 6.2: Add API/types and route**

In `frontend/src/services/api.ts`, add `adminWorkRequestsAPI`:

```ts
export const adminWorkRequestsAPI = {
  list: async (state?: string) =>
    api.get('/api/v1/admin/work-requests', { params: { state } }).then(r => r.data),
  triage: async (id: number, body: { state: string; reason?: string }) =>
    api.post(`/api/v1/admin/work-requests/${id}/triage`, body).then(r => r.data),
  publish: async (id: number) =>
    api.post(`/api/v1/admin/work-requests/${id}/publish`).then(r => r.data),
  reject: async (id: number, body: { reason: string }) =>
    api.post(`/api/v1/admin/work-requests/${id}/reject`, body).then(r => r.data),
  quarantine: async (gatewayEui: string, body: { reason: string }) =>
    api.post(`/api/v1/admin/work-requests/gateways/${gatewayEui}/quarantine`, body).then(r => r.data),
};
```

Add `/admin/work-requests` route inside `AdminRoute` in `App.tsx`. Add "Work Requests" entry in admin menu in `DashboardHeader.tsx`.

- [ ] **Step 6.3: Build admin page**

`AdminWorkRequests.tsx`:

- Dense table: public title, pseudonym, country code, class, area, severity, state, created_at.
- Diagnostics are NOT shown in the table; available via expand/detail view only.
- Public artifact preview column (separate from private diagnostics).
- Action buttons: Publish, Reject, Quarantine Gateway. Each with confirmation dialog.
- GitHub issue URL shown after publish (admin-only).
- Filter by state dropdown.

- [ ] **Step 6.4: Verify frontend**

```bash
cd frontend
npm run test:unit
npm run build
```

Expected: pass.

- [ ] **Step 6.5: Commit**

```bash
git add frontend
git diff --cached --check
git commit -m "feat: add work request admin console"
```

---

## Task 7: Status Back to Edge

**Files (osi-server + osi-os):**
- osi-server: workrequest services/tests
- osi-os: verify Task 2's status apply node works end-to-end

**Interfaces:**
- Consumes: Task 4's `WorkRequestIntakeService` state transitions, Task 2's `work-request-status-apply` node, existing `CommandService`
- Produces: `WorkRequestStatusNotifier`, status polling endpoint

- [ ] **Step 7.1: Write server status command tests**

```java
@ExtendWith(MockitoExtension.class)
class WorkRequestStatusNotifierTest {

    @Mock CommandService commandService;
    @Mock DeviceRepository deviceRepo;
    @InjectMocks WorkRequestStatusNotifier notifier;

    @Test
    void submittedStateEnqueuesStatusCommand() {
        var wr = workRequest("SUBMITTED");
        var device = gatewayDevice(wr.getGatewayEui());
        when(deviceRepo.findByDeviceEui(wr.getGatewayEui())).thenReturn(Optional.of(device));

        notifier.notify(wr);

        verify(commandService).issueGatewayCommand(
            eq(device), eq("WORK_REQUEST_STATUS"), argThat(params -> {
                assertThat(params.get("request_id")).isEqualTo(wr.getRequestUuid());
                assertThat(params.get("status")).isEqualTo("SUBMITTED");
                return true;
            }),
            isNull(), eq("WORK_REQUEST"), eq(wr.getRequestUuid()), isNull(), isNull());
    }

    @Test
    void needsInfoIncludesHumanMessage() {
        var wr = workRequest("NEEDS_INFO");
        wr.setRejectionReason("Please provide steps.");
        var device = gatewayDevice(wr.getGatewayEui());
        when(deviceRepo.findByDeviceEui(wr.getGatewayEui())).thenReturn(Optional.of(device));

        notifier.notify(wr);

        verify(commandService).issueGatewayCommand(
            any(), eq("WORK_REQUEST_STATUS"), argThat(params -> {
                assertThat(params.get("status")).isEqualTo("NEEDS_INFO");
                assertThat(params.get("human_message")).isEqualTo("Please provide steps.");
                return true;
            }),
            isNull(), any(), any(), isNull(), isNull());
    }
}
```

Run: fail because `WorkRequestStatusNotifier` doesn't exist.

- [ ] **Step 7.2: Implement notifier and status polling endpoint**

**`WorkRequestStatusNotifier.java`:**

```java
@Component
@RequiredArgsConstructor
public class WorkRequestStatusNotifier {
    private final CommandService commandService;
    private final DeviceRepository deviceRepo;

    public void notify(WorkRequest wr) {
        Device device = deviceRepo.findByDeviceEui(wr.getGatewayEui()).orElse(null);
        if (device == null) return; // unregistered gateway — skip silently

        Map<String, Object> params = new HashMap<>();
        params.put("request_id", wr.getRequestUuid());
        params.put("status", wr.getState());
        params.put("reason", wr.getRejectionReason());
        params.put("human_message", wr.getRejectionReason()); // for NEEDS_INFO
        params.put("released_version", wr.getReleasedVersion());
        params.put("updated_at", wr.getUpdatedAt().toString());

        commandService.issueGatewayCommand(device, "WORK_REQUEST_STATUS", params,
            null, "WORK_REQUEST", wr.getRequestUuid(), null, null);
    }
}
```

Call `notifier.notify(wr)` after state transitions in `WorkRequestIntakeService` and `WorkRequestAdminController`.

**Status polling endpoint** (in `UnlinkedWorkRequestController`):

```java
@GetMapping("/work-requests/{requestId}/status")
public ResponseEntity<?> pollStatus(
        @PathVariable String requestId,
        @RequestHeader(value = "X-Status-Secret", required = false) String secret) {
    var wr = workRequestRepo.findByRequestUuid(requestId).orElse(null);
    if (wr == null) return ResponseEntity.notFound().build();
    if (wr.getStatusSecretHash() == null || secret == null) {
        return ResponseEntity.status(403).body(Map.of("error", "status_secret_required"));
    }
    String hash = Hex.toHexString(MessageDigest.getInstance("SHA-256")
        .digest(secret.getBytes(StandardCharsets.UTF_8)));
    if (!MessageDigest.isEqual(hash.getBytes(), wr.getStatusSecretHash().getBytes())) {
        return ResponseEntity.status(403).body(Map.of("error", "invalid_secret"));
    }
    return ResponseEntity.ok(Map.of(
        "contract_version", 1,
        "request_id", requestId,
        "status", wr.getState(),
        "human_message", wr.getRejectionReason(),
        "updated_at", wr.getUpdatedAt()
    ));
}
```

Rate-limit this endpoint to 10/min/IP using the existing `RateLimitFilter` pattern.

- [ ] **Step 7.3: Verify**

Server:

```bash
cd backend
./gradlew test --tests 'org.osi.server.workrequest.*' \
  --tests 'org.osi.server.command.*' \
  -x buildFrontend -x buildTerraIntelligenceFrontend
```

Edge (verify status apply node wiring):

```bash
cd /home/phil/Repos/osi-os/.worktrees/field-to-pr-stage0
node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js
```

Expected: all pass.

- [ ] **Step 7.4: Commit**

osi-server:

```bash
git add backend/src/main/java/org/osi/server/workrequest \
        backend/src/test/java/org/osi/server/workrequest
git diff --cached --check
git commit -m "feat: send field request status to edge and add status polling"
```

---

## Task 8: End-to-End Verification and Docs

**Files:**
- Create: `docs/operations/field-work-requests-stage0.md` in osi-os
- Both repos: PR bodies

**Interfaces:**
- Consumes: all prior tasks
- Produces: operator docs, verification evidence, PRs

- [ ] **Step 8.1: Add operator docs**

Create `docs/operations/field-work-requests-stage0.md` in osi-os. Document:

- Stage 0 scope and non-goals (no runner, no agent, no draft PR).
- Test-server only rollout — server deploys first, then edge.
- Required server env vars: `WORK_REQUESTS_PSEUDONYM_SECRET`, `WORK_REQUESTS_GITHUB_APP_ID`, `WORK_REQUESTS_GITHUB_INSTALLATION_ID`, `WORK_REQUESTS_GITHUB_PRIVATE_KEY_PEM`.
- Rate limits: 10/day, 50/week per EUI; 10/day per IP; 500 global pending.
- Known-EUI gate: gateway must have sent at least one heartbeat in the last 90 days.
- Public artifact safety: diagnostics never go to GitHub.
- How to disable publishing: unset `WORK_REQUESTS_GITHUB_APP_ID`.
- How to quarantine a gateway.
- How to inspect private diagnostics in admin console.

- [ ] **Step 8.2: Full osi-os gates**

Run from osi-os worktree root:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node --test scripts/test-improvement-requests-schema.js
node scripts/test-contract-schemas.js
node --test scripts/verify-sync-op-parity.test.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
scripts/check-mqtt-topics.sh
cd web/react-gui && npm run test:unit && npm run typecheck && npm run build
```

Expected: all pass. Capture exact output in the PR body.

- [ ] **Step 8.3: Full osi-server gates**

```bash
cd backend
./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend
cd ../frontend
npm run test:unit
npm run build
cd ../backend
./gradlew test
```

Expected: all pass.

- [ ] **Step 8.4: Manual local smoke**

1. Start osi-server dev backend with test env.
2. Submit a request to `POST /api/v1/support/edge/work-requests` with a known gateway EUI.
3. Verify `work_requests` row exists with redacted public fields.
4. Verify unknown EUI returns 400 `unknown_gateway`.
5. Verify 11th request from same EUI returns 429 `daily_limit`.
6. Publish with missing GitHub config → confirm `PUBLISH_BLOCKED_CONFIG`.
7. If sandbox GitHub App available: publish one issue, confirm body has no EUI/email/diagnostics.

- [ ] **Step 8.5: Commit docs and open PRs**

Commit docs:

```bash
git add docs/operations/field-work-requests-stage0.md
git diff --cached --check
git commit -m "docs: document field request Stage 0 operations"
```

Open two PRs:

- **osi-os PR:** edge schema, flow (intake + delivery worker + status apply), GUI, docs.
- **osi-server PR:** server intake, unlinked endpoint, linked adapter, admin UI, GitHub publish gate, status-back, docs.

Deployment order: osi-server PR merges and deploys to test server first. osi-os PR merges second. The edge delivery worker retries gracefully if the server endpoint is not yet available.

---

## Self-Review

**Spec coverage:** Stage 0 covers GUI form, offline edge queueing, double redaction, unlinked delivery worker, known-EUI gate, test-server intake, rate limiting (10/day, 50/week per EUI), dedup, quarantine, publish gate, GitHub issue creation, status polling, and GUI status-back. It intentionally excludes Forge runner, agent jobs, draft PRs, deploy wrappers, token budgets, and sandbox validation (Stage 0.5).

**Implementation note — known-EUI gate:** `DeviceService.upsertFromHeartbeat` already creates Device records with `type='GATEWAY'` for every heartbeat. The known-EUI gate queries the existing `devices` table: `existsByDeviceEuiAndTypeAndLastSeenAfter(eui, "GATEWAY", 90 days ago)`. This avoids a redundant Flyway migration while satisfying the same logical requirement.

**Dual delivery strategy:** The support delivery worker reads from `improvement_requests` (WHERE `local_status = 'QUEUED'`), not from `sync_outbox`. This keeps it independent of the existing sync worker. The `sync_outbox` trigger still fires for linked sync compatibility (Kaba100's pending event). Server-side idempotency by `request_uuid` makes dual delivery harmless.

**Deployment order:** Server first (adding WORK_REQUEST_SUBMITTED support + unlinked endpoint), then edge. If the edge deploys first, the sync worker may reject the new event type, but the delivery worker handles delivery independently via the unlinked endpoint.

**Forward compatibility:** Unknown `cloud_status` values from `WORK_REQUEST_STATUS` commands are stored as-is and displayed as "Status update received."

**Verification gates:** Both repos have local unit/build gates, osi-os schema/profile/flow parity gates, and osi-server backend/frontend gates.
