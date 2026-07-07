# Field-to-PR Stage 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Repo split:** this plan file lives in **osi-os**, but Stage 0 changes span `/home/phil/Repos/osi-os` and `/home/phil/Repos/osi-server`. Use separate feature worktrees/branches and separate PRs. Do not touch `osicloud.ch`.
> **Spec:** [`docs/superpowers/specs/2026-07-08-field-to-pr-design.md`](../specs/2026-07-08-field-to-pr-design.md). This plan implements **Stage 0 only**: feedback-to-issue, no runner, no agent, no draft PR automation.

**Goal:** Let authenticated field users submit public-consented bug/improvement/feedback requests from the edge GUI, sync them to OSI Server through the existing edge event path, triage/publish them through an admin gate as sanitized GitHub issues, and show request status back on the gateway.

**Architecture:** The Pi remains a submission terminal: React form -> authenticated Node-RED endpoint -> SQLite `improvement_requests` -> `sync_outbox`. OSI Server extends `/api/v1/sync/edge/events` with `WORK_REQUEST_SUBMITTED`, stores private diagnostics in Postgres, applies deterministic redaction/dedup/rate/quarantine rules, and exposes an admin publish gate that creates GitHub issues only after public-artifact scanning. Status returns through the existing pending-command poll as a bounded `WORK_REQUEST_STATUS` command handled by a dedicated edge function.

**Tech Stack:** OSI OS React/Vite/Vitest/i18next, Node-RED `flows.json`, SQLite ordered migrations + bundled DB parity, OSI Server Java 17/Spring Boot/Flyway/JPA/Mockito/MockWebServer, OSI Server React admin UI.

---

## Scope Split

This spec covers four independent systems: edge intake, server intake/admin/GitHub, runner VM, and agent PR workflow. Per the writing-plans scope check, Stage 1-3 need their own specs/plans after Stage 0 ships. This plan intentionally excludes:

- Forge runner VM provisioning.
- Agent prompt assembly, worktree execution, independent reviewer loop, draft PR creation.
- Class 0/1/2 agent classification beyond storing an initial deterministic `risk_class`.
- Production promotion to `osicloud.ch`.

## Stage 0 Decisions From Open Questions

- GitHub integration: use a GitHub App, not a PAT. If app config is absent, publish attempts fail closed with `PUBLISH_BLOCKED_CONFIG`, and no public issue is created.
- Production promotion: out of scope. Use local/test-server deployment only; `osicloud.ch` promotion is a later gated production change.
- Status-back: add `WORK_REQUEST_STATUS` to pending commands and handle it in a dedicated edge status function.
- Diagnostics retention: default private diagnostics retention is 90 days on OSI Server, configurable by `work-requests.diagnostics-retention-days`.
- Runner token/time caps: not applicable in Stage 0.
- NEEDS_INFO UX: Stage 0 shows `NEEDS_INFO` and a human-readable reason in the GUI, but does not implement in-GUI replies. Admin follow-up is out of band until a Stage 0.5 reply-thread plan.

## Global Constraints

- No production access. Do not SSH to `osicloud.ch`, inspect it, or use production credentials.
- Every public artifact is built from sanitized fields only. `diagnostics_json`, real gateway EUI, local username, email, tokens, logs, and raw private metadata never leave OSI Server.
- Edge schema change is additive but still high-consequence. Add `0005__field_work_requests.sql`, update `database/seed-blank.sql`, all 7 bundled DBs, `deploy.sh` live repair, and schema verifiers in one osi-os PR.
- `flows.json` edits are script-only and applied to both maintained profiles: `bcm2712` canonical and `bcm2709` mirror.
- Extend sync contracts in `docs/contracts/sync-schema/` before changing flow/server sync behavior.
- The existing `/api/v1/sync/edge/events` authentication remains the only edge->server intake path.
- Status commands are inert data-only updates to `improvement_requests`; they must not trigger actuator/downlink logic.
- Public issue bodies include the request text verbatim in a fenced block after server-side redaction and scanner pass.

## File Structure

### osi-os

- Modify: `docs/contracts/sync-schema/events.schema.json`
- Modify: `docs/contracts/sync-schema/commands.schema.json`
- Modify: `scripts/test-contract-schemas.js`
- Modify: `scripts/verify-sync-op-parity.test.js`
- Create: `database/migrations/ordered/0005__field_work_requests.sql`
- Modify: `database/seed-blank.sql`
- Modify: all 7 bundled `farming.db` copies listed by `find . -name farming.db -not -path '*/node_modules/*'`
- Modify: `scripts/verify-db-schema-consistency.js`
- Modify: `deploy.sh`
- Create: `scripts/test-improvement-requests-schema.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/types/farming.ts`
- Modify: `web/react-gui/src/App.tsx`
- Modify: `web/react-gui/src/components/DashboardHeader.tsx`
- Create: `web/react-gui/src/pages/SupportRequests.tsx`
- Create: `web/react-gui/src/pages/__tests__/SupportRequests.test.tsx`
- Modify: `web/react-gui/src/components/__tests__/DashboardHeader.test.tsx`
- Create/modify locale namespace files under `web/react-gui/public/locales/*/support.json`
- Modify: `web/react-gui/src/i18n/config.ts`
- Modify: `web/react-gui/src/types/i18next.d.ts`

### osi-server

- Create: `backend/src/main/resources/db/migration/V2026_07_08_001__work_requests.sql` (rename if a later migration exists at execution time)
- Create package: `backend/src/main/java/org/osi/server/workrequest/`
- Create package tests: `backend/src/test/java/org/osi/server/workrequest/`
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify: `backend/src/main/java/org/osi/server/security/EdgeOwnershipService.java`
- Modify: `backend/src/main/java/org/osi/server/security/RateLimitFilter.java`
- Modify: sync/security tests near `EdgeSyncService*Test`, `EdgeOwnershipServiceTest`, `RateLimitProxyIdentityTest`
- Modify: `backend/src/main/resources/application.yml`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types/farming.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/DashboardHeader.tsx`
- Create: `frontend/src/pages/admin/AdminWorkRequests.tsx`
- Create: `frontend/src/pages/admin/__tests__/AdminWorkRequests.test.tsx`
- Modify: `frontend/src/__tests__/AppRouting.test.tsx`
- Modify: `frontend/src/components/__tests__/DashboardHeader.test.tsx`
- Modify: `frontend/public/locales/*/admin.json`

## Task 1: Sync Contract And Edge Schema

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

In `scripts/test-contract-schemas.js`, extend the event enum assertion so `WORK_REQUEST_SUBMITTED` is required and add a sample event with:

```js
const sampleWorkRequestEvent = {
  eventUuid: 'req-0016C001F11715E2-20260708T120000Z',
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
    gui_user: { local_user_id: 7, username: 'field-user' }
  }
};
```

Run: `node scripts/test-contract-schemas.js`
Expected: FAIL because `WORK_REQUEST_SUBMITTED` and `WORK_REQUEST_STATUS` are not in the schemas yet.

- [ ] **Step 1.3: Update sync schemas**

In `docs/contracts/sync-schema/events.schema.json`, add `"WORK_REQUEST_SUBMITTED"` to `properties.op.enum`.

In `docs/contracts/sync-schema/commands.schema.json`, add `"WORK_REQUEST_STATUS"` to `properties.command_type.enum`. Keep `additionalProperties: false`, and add nullable fields used by status payloads:

```json
"request_id": {"type": ["string", "null"]},
"status": {"type": ["string", "null"]},
"reason": {"type": ["string", "null"]},
"human_message": {"type": ["string", "null"]},
"released_version": {"type": ["string", "null"]},
"updated_at": {"type": ["string", "null"], "format": "date-time"}
```

Add an `allOf` branch requiring `request_id` and `status` when `command_type` is `WORK_REQUEST_STATUS`.

Run: `node scripts/test-contract-schemas.js`
Expected: PASS, including the new work request sample.

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
      'gui_user', json_object('local_user_id', NEW.user_id)
    ),
    NEW.sync_version,
    NEW.submitted_at,
    NEW.gateway_device_eui
  );
END;
```

Apply equivalent DDL to `database/seed-blank.sql` after `sync_inbox`/`sync_cursor` or another sync-adjacent section. The seed must include the same table, indexes, and trigger.

- [ ] **Step 1.5: Add schema regression script**

Create `scripts/test-improvement-requests-schema.js` that creates a scratch DB from `database/seed-blank.sql`, inserts a user, inserts one `improvement_requests` row, and asserts:

```js
assert.equal(row.op, 'WORK_REQUEST_SUBMITTED');
assert.equal(row.aggregate_type, 'WORK_REQUEST');
assert.equal(JSON.parse(row.payload_json).contract_version, 1);
assert.equal(JSON.parse(row.payload_json).consent_public, true);
assert.equal(JSON.parse(row.payload_json).request_id, requestUuid);
```

Run: `node scripts/test-improvement-requests-schema.js`
Expected: PASS.

- [ ] **Step 1.6: Update bundled DBs and schema verifier**

Regenerate all 7 bundled `farming.db` copies with the new migration. Extend `scripts/verify-db-schema-consistency.js` so it checks:

- `improvement_requests` table exists.
- Columns listed in Step 1.4 exist.
- Both indexes exist.
- `trg_improvement_requests_outbox_ai` contains `WORK_REQUEST_SUBMITTED` and `contract_version`.

Run:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-db-schema-consistency.js
node scripts/test-improvement-requests-schema.js
node scripts/verify-profile-parity.js
```

Expected: all pass; profile parity ends `All parity checks passed.`

- [ ] **Step 1.7: Add deploy-time live repair**

In `deploy.sh`, add `ensure_improvement_requests_schema` following `ensure_gateway_health_schema`: execute only the additive migration SQL against an existing `/data/db/farming.db`, assert the `-- risk: additive` header, and verify the table exists afterward. Do not reseed or replace `/data/db/farming.db`.

Run: `bash -n deploy.sh`
Expected: no syntax errors.

- [ ] **Step 1.8: Commit**

```bash
git add docs/contracts/sync-schema scripts database deploy.sh conf database web/react-gui/farming.db
git diff --cached --check
git commit -m "feat: add edge field work request schema"
```

## Task 2: Edge Node-RED Intake And Status Apply

**Files:**
- Modify both maintained `flows.json` profile copies
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 2.1: Write flow wiring tests first**

Extend `scripts/test-flows-wiring.js` to assert:

- HTTP IN nodes exist for:
  - `GET /api/improvement-requests`
  - `GET /api/improvement-requests/diagnostics-preview`
  - `POST /api/improvement-requests`
- The intake router function has an `osiDb` lib binding and calls `.close(`.
- `sync-pending-split` has two outputs: normal commands to `reject-indefinite-open`, status commands to `work-request-status-apply`.
- `work-request-status-apply` has an `osiDb` lib binding, updates `improvement_requests`, and wires to `command-ack-queue-rest`.

Run: `node scripts/test-flows-wiring.js`
Expected: FAIL with missing improvement request nodes.

- [ ] **Step 2.2: Script-edit `flows.json`**

Use a scratch Node script with the mandatory roundtrip guard from `.claude/skills/osi-flows-json-editing/SKILL.md`. Add a new self-contained API cluster on the system/admin tab:

- `GET /api/improvement-requests` -> `improvement-requests-api-router`
- `GET /api/improvement-requests/diagnostics-preview` -> same router
- `POST /api/improvement-requests` -> same router
- router -> `http response`

The router must:

- Copy the `verifyBearer` block from the newest authenticated API handler.
- Validate title length 3-80, description length 10-4000, enum fields, and `consent_public === true`.
- Build `diagnostics_json` from a bounded object: build version/fallback version, current route if supplied by the GUI, `flow.get('sync_state')` summary, gateway identity from env, device counts by `type_id`, and system health fields already available in globals.
- Redact diagnostics and text with a fixed pattern list for bearer tokens, JWT-like strings, AppKeys, passwords, emails, and 16-hex EUIs in display-only fields. Keep `gateway_device_eui` as a private structured field, not in public text.
- Insert into `improvement_requests`; rely on the trigger to enqueue `WORK_REQUEST_SUBMITTED`.
- Return `{ request_id, local_status: "QUEUED" }` for POST and a list of request cards for GET.

Modify `sync-pending-split` to separate `WORK_REQUEST_STATUS` from normal commands. Add `work-request-status-apply`, which updates one local row by `request_id`, sets `cloud_status`, `cloud_reason`, `cloud_human_message`, `released_version`, `last_status_at`, `updated_at`, and returns an ACK message to `command-ack-queue-rest`.

- [ ] **Step 2.3: Update sync verifiers**

In `scripts/verify-sync-flow.js`, add static checks for:

- `WORK_REQUEST_STATUS` is routed to the status apply node, not actuator/downlink nodes.
- `WORK_REQUEST_SUBMITTED` appears only in the new improvement request trigger/contract flow path.
- The intake node contains the copied auth block and `consent_public`.

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
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-flows-wiring.js scripts/verify-sync-flow.js
git diff --cached --check
git commit -m "feat: add edge field request intake flow"
```

## Task 3: Edge React Support Requests UI

**Files:**
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/types/farming.ts`
- Modify: `web/react-gui/src/App.tsx`
- Modify: `web/react-gui/src/components/DashboardHeader.tsx`
- Create: `web/react-gui/src/pages/SupportRequests.tsx`
- Create: `web/react-gui/src/pages/__tests__/SupportRequests.test.tsx`
- Modify: `web/react-gui/src/components/__tests__/DashboardHeader.test.tsx`
- Create/modify: `web/react-gui/public/locales/*/support.json`
- Modify: `web/react-gui/src/i18n/config.ts`
- Modify: `web/react-gui/src/types/i18next.d.ts`

- [ ] **Step 3.1: Add failing UI tests**

Create `web/react-gui/src/pages/__tests__/SupportRequests.test.tsx` with tests that mock `supportRequestsAPI` and assert:

- The form renders three steps: request text, area/severity, diagnostics/consent.
- Submit is disabled until `consent_public` is checked.
- Diagnostics preview renders without raw `0016C001F11715E2` text.
- After submit, the "My Requests" list shows `Saved, waiting for internet` for `QUEUED` and `Being reviewed` for `TRIAGED`.
- `NEEDS_INFO` shows the server human message but no reply box in Stage 0.

Run: `cd web/react-gui && npm run test:unit:vitest -- src/pages/__tests__/SupportRequests.test.tsx`
Expected: FAIL because the page/API do not exist.

- [ ] **Step 3.2: Add typed API boundary**

In `web/react-gui/src/types/farming.ts`, add closed union types for request type, severity, local/cloud status, and `SupportRequest`.

In `web/react-gui/src/services/api.ts`, add:

```ts
export const supportRequestsAPI = {
  list: async (): Promise<SupportRequest[]> =>
    api.get<SupportRequest[]>('/api/improvement-requests').then((r) => r.data),
  diagnosticsPreview: async (route?: string): Promise<SupportDiagnosticsPreview> =>
    api.get<SupportDiagnosticsPreview>('/api/improvement-requests/diagnostics-preview', { params: { route } }).then((r) => r.data),
  create: async (request: SupportRequestCreateRequest): Promise<SupportRequestCreateResponse> =>
    api.post<SupportRequestCreateResponse>('/api/improvement-requests', request).then((r) => r.data),
};
```

Keep auth handling in the existing axios interceptor.

- [ ] **Step 3.3: Build page and route**

Create `SupportRequests.tsx` as a work-focused page, not a marketing surface:

- Header with back link to `/dashboard`.
- Three-step form with radio groups, text inputs, textarea fields, dropdowns, diagnostics accordion, and consent checkboxes.
- "My Requests" list with status chips.
- No public GitHub/PR links for farm users.
- Offline send errors render as a retryable banner; successful local submit renders "Saved, waiting for internet".

Add route `/support-requests` in `App.tsx`, protected by `PrivateRoute`.

Add `Support & Requests` to `DashboardHeader` Account menu.

- [ ] **Step 3.4: Add i18n namespace**

Add `support.json` for every existing locale directory (`en`, `de-CH`, `es`, `fr`, `it`, `lg`, `pt`). Non-English files may initially use English strings, but the keys must exist so the UI is i18n-ready and Luganda does not fall back to missing keys.

Update `web/react-gui/src/i18n/config.ts` namespace list and `web/react-gui/src/types/i18next.d.ts`.

- [ ] **Step 3.5: Verify frontend**

Run:

```bash
cd web/react-gui
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

## Task 4: Server Persistence, Intake, Redaction, Dedup, Rate Limit

**Files (osi-server):**
- Create: `backend/src/main/resources/db/migration/V2026_07_08_001__work_requests.sql`
- Create: `backend/src/main/java/org/osi/server/workrequest/WorkRequest*.java`
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify: `backend/src/main/java/org/osi/server/security/EdgeOwnershipService.java`
- Modify: `backend/src/main/java/org/osi/server/security/RateLimitFilter.java`
- Modify tests in `backend/src/test/java/org/osi/server/workrequest/`, `sync/`, and `security/`

- [ ] **Step 4.1: Create osi-server worktree/branch**

```bash
cd /home/phil/Repos/osi-server
git fetch origin
git worktree add .worktrees/field-to-pr-stage0 origin/main
cd .worktrees/field-to-pr-stage0
git switch -c feat/field-to-pr-stage0
```

- [ ] **Step 4.2: Write failing service tests**

Create tests for `WorkRequestIntakeService`:

- Stores real `gateway_eui` privately and computes `gateway_pseudonym` as `gw_` + first 12 hex chars of HMAC-SHA256 using `work-requests.pseudonym-secret`.
- Redacts emails, bearer tokens, JWT-like strings, AppKeys, and 16-hex EUIs from `public_title`, `public_description`, and GitHub issue body.
- Stores diagnostics JSON only in `work_requests.diagnostics_json`.
- Computes a dedup hash from normalized type/title/description/area/gateway pseudonym.
- Marks duplicate submissions as `DUPLICATE_OF` with `duplicate_of_id`.
- Enforces 3/day and 10/week per gateway and returns `RATE_LIMITED`.
- Blocks quarantined gateways with `REJECTED` and event reason `gateway_quarantined`.

Run: `cd backend && ./gradlew test --tests 'org.osi.server.workrequest.*' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL because package/classes do not exist.

- [ ] **Step 4.3: Add Flyway migration**

Create `V2026_07_08_001__work_requests.sql` (rename if a later migration exists):

```sql
CREATE TABLE work_requests (
    id BIGSERIAL PRIMARY KEY,
    request_uuid VARCHAR(64) NOT NULL UNIQUE,
    gateway_eui VARCHAR(32) NOT NULL,
    gateway_pseudonym VARCHAR(32) NOT NULL,
    local_user_ref VARCHAR(128),
    country_code CHAR(2),
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
    dedup_hash VARCHAR(64) NOT NULL,
    duplicate_of_id BIGINT REFERENCES work_requests(id),
    risk_class INTEGER NOT NULL DEFAULT 4,
    disposition VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
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

CREATE INDEX ix_work_request_events_request_created ON work_request_events(work_request_id, created_at);

CREATE TABLE work_request_gateway_controls (
    gateway_eui VARCHAR(32) PRIMARY KEY,
    quarantined BOOLEAN NOT NULL DEFAULT false,
    quarantine_reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 4.4: Implement domain services**

Create these focused classes:

- `WorkRequest.java`, `WorkRequestEvent.java`, `WorkRequestGatewayControl.java`
- Repositories for each entity.
- `WorkRequestPayload.java` record for the sync payload.
- `WorkRequestRedactor` with the exact redaction patterns tested in Step 4.2.
- `WorkRequestPublicArtifactBuilder` that builds issue title/body from public fields only.
- `WorkRequestRateLimiter` that queries `work_requests` by gateway and submitted window.
- `WorkRequestIntakeService` that validates, redacts, dedups, classifies deterministic risk class, stores events, and returns intake result.

Classification in Stage 0 is deterministic:

- `type=feedback` or description shorter than 20 after trim -> `ISSUE_ONLY`, class 4.
- Areas `watering`, `sync`, `devices`, `system`, `other` -> `ISSUE_ONLY`, class 4 unless admin later changes.
- Areas `dashboard`, `history`, `analysis`, `copy` -> `AWAITING_PUBLISH`, class 0 or 1 by keyword, but no agent eligibility is used in Stage 0.
- Any text containing `ssh`, `password`, `token`, `.github`, `workflow`, `deploy`, `osicloud`, or `production` -> `ISSUE_ONLY`, class 4.

- [ ] **Step 4.5: Wire sync event handler**

In `EdgeSyncService`:

- Add `WORK_REQUEST_SUBMITTED` to `applyEvent`.
- Map `WORK_REQUEST_SUBMITTED` to resource type `WORK_REQUEST`.
- Build the `WORK_REQUEST` resource id as `gatewayDeviceEui + "|" + request_id` so the watermark is per request.
- Inject `WorkRequestIntakeService` and call it from the handler.

In `EdgeOwnershipService`, add `WORK_REQUEST`: allow mutate only when the resource id prefix before `|` equals the authenticated gateway EUI.

Run:

```bash
cd backend
./gradlew test --tests 'org.osi.server.workrequest.*' --tests 'org.osi.server.sync.EdgeSyncService*Test' --tests 'org.osi.server.security.EdgeOwnershipServiceTest' -x buildFrontend -x buildTerraIntelligenceFrontend
```

Expected: all selected tests pass.

- [ ] **Step 4.6: Extend rate-limit identity helper**

Extract the existing trusted-proxy/X-Forwarded-For logic in `RateLimitFilter` into a reusable package-private helper or public `ClientIpResolver`. Use it in work request intake to resolve the source IP for GeoIP.

Add tests covering trusted proxy, untrusted XFF ignored, and missing GeoIP DB -> `country_code = 'ZZ'`.

- [ ] **Step 4.7: Commit**

```bash
git add backend/src/main/resources/db/migration backend/src/main/java/org/osi/server backend/src/test/java/org/osi/server backend/src/main/resources/application.yml
git diff --cached --check
git commit -m "feat: ingest field work requests on server"
```

## Task 5: Publish Gate And GitHub Issue Creation

**Files (osi-server):**
- Create: `backend/src/main/java/org/osi/server/workrequest/GitHubAppTokenService.java`
- Create: `backend/src/main/java/org/osi/server/workrequest/GitHubIssueClient.java`
- Create: `backend/src/main/java/org/osi/server/workrequest/PublicArtifactSecretScanner.java`
- Create: `backend/src/main/java/org/osi/server/workrequest/WorkRequestAdminController.java`
- Tests under `backend/src/test/java/org/osi/server/workrequest/`

- [ ] **Step 5.1: Write failing publish tests**

Test cases:

- `PublicArtifactSecretScanner` rejects raw EUI, bearer token, JWT-like string, AppKey-like hex, and email.
- Publish with missing GitHub App config leaves state `PUBLISH_BLOCKED_CONFIG`, creates event, and does not call GitHub.
- Publish with safe artifact calls GitHub issue endpoint with labels `from-field`, `class:N`, `sev:*`, `gw:<pseudonym>`.
- Issue body contains country code/flag text and fenced request text, but not diagnostics JSON.
- Duplicate publish is idempotent: if `github_issue_number` is already set, return existing issue metadata and do not create another issue.

Use `MockWebServer` for GitHub HTTP calls. No live GitHub calls in tests.

- [ ] **Step 5.2: Add GitHub App client**

Add configuration under `work-requests.github`:

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

`GitHubAppTokenService` signs a short-lived JWT and exchanges it for an installation token. `GitHubIssueClient` only implements `createIssue(ownerRepo, title, body, labels)`.

- [ ] **Step 5.3: Add admin publish endpoints**

Create `WorkRequestAdminController` under `/api/v1/admin/work-requests`:

- `GET /api/v1/admin/work-requests?state=SUBMITTED`
- `POST /api/v1/admin/work-requests/{id}/triage`
- `POST /api/v1/admin/work-requests/{id}/publish`
- `POST /api/v1/admin/work-requests/{id}/reject`
- `POST /api/v1/admin/work-requests/gateways/{gatewayEui}/quarantine`

All endpoints require admin role through existing `/api/v1/admin/**` security.

- [ ] **Step 5.4: Verify backend**

Run:

```bash
cd backend
./gradlew test --tests 'org.osi.server.workrequest.*' -x buildFrontend -x buildTerraIntelligenceFrontend
```

Expected: all workrequest tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add backend/src/main/java/org/osi/server/workrequest backend/src/test/java/org/osi/server/workrequest backend/src/main/resources/application.yml
git diff --cached --check
git commit -m "feat: add field request publish gate"
```

## Task 6: Server Admin Console

**Files (osi-server):**
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types/farming.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/DashboardHeader.tsx`
- Create: `frontend/src/pages/admin/AdminWorkRequests.tsx`
- Create: `frontend/src/pages/admin/__tests__/AdminWorkRequests.test.tsx`
- Modify: route/header tests
- Modify: `frontend/public/locales/*/admin.json`

- [ ] **Step 6.1: Add failing frontend tests**

Test that admin route `/admin/work-requests` renders:

- queue rows with request title, pseudonym, country code, class, state.
- diagnostics are not printed in the table.
- publish/reject buttons call `adminWorkRequestsAPI`.
- gateway quarantine action requires confirmation.

Run: `cd frontend && npm run test:unit -- src/pages/admin/__tests__/AdminWorkRequests.test.tsx`
Expected: FAIL because page/API do not exist.

- [ ] **Step 6.2: Add API/types and route**

Add typed admin API methods in `frontend/src/services/api.ts` under the existing `adminAPI` object or a focused `adminWorkRequestsAPI`.

Add `/admin/work-requests` route inside `AdminRoute` in `App.tsx`.

Add Admin menu item `Work Requests` in `DashboardHeader`.

- [ ] **Step 6.3: Build admin page**

`AdminWorkRequests.tsx` should:

- Use `useSWR` with `/api/v1/admin/work-requests`.
- Render dense table layout for repeated review work.
- Show public artifact preview separately from private diagnostics.
- Require explicit click for publish/reject/quarantine.
- Show GitHub issue URL only in admin console after publish.

- [ ] **Step 6.4: Verify frontend**

Run:

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

## Task 7: Status Back To Edge

**Files:**
- osi-server backend workrequest services/tests
- osi-os `flows.json`, flow verifiers if not completed in Task 2
- osi-os React status display if not completed in Task 3

- [ ] **Step 7.1: Write server status command tests**

Test that state transitions enqueue `WORK_REQUEST_STATUS` command against the submitting gateway for:

- `SUBMITTED` -> payload status `SUBMITTED`
- `AWAITING_PUBLISH` -> `BEING_REVIEWED`
- `NEEDS_INFO` -> `NEEDS_INFO` with `human_message`
- `ISSUE_OPEN` -> `BEING_REVIEWED`
- `REJECTED` -> `NOT_PLANNED` with reason

Use `CommandService.issueGatewayCommand` with command type `WORK_REQUEST_STATUS`, aggregate type `WORK_REQUEST`, aggregate key `request_uuid`, and payload containing `request_id`, `status`, `reason`, `human_message`, `updated_at`.

- [ ] **Step 7.2: Implement command enqueue**

Add `WorkRequestStatusNotifier` that resolves the gateway `Device` and issues the command. Call it after intake and admin state transitions. Do not publish over MQTT; `CommandService` may best-effort MQTT publish, but the edge command delivery contract remains REST pending commands.

- [ ] **Step 7.3: Verify edge command application**

Run osi-os flow tests:

```bash
node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js
```

Then run server tests:

```bash
cd /home/phil/Repos/osi-server/.worktrees/field-to-pr-stage0/backend
./gradlew test --tests 'org.osi.server.workrequest.*' --tests 'org.osi.server.command.*' -x buildFrontend -x buildTerraIntelligenceFrontend
```

Expected: pass.

- [ ] **Step 7.4: Commit in each repo**

osi-server:

```bash
git add backend/src/main/java/org/osi/server/workrequest backend/src/test/java/org/osi/server/workrequest
git diff --cached --check
git commit -m "feat: send field request status to edge"
```

osi-os if Task 2/3 did not already commit status handling:

```bash
git add conf web/react-gui scripts
git diff --cached --check
git commit -m "feat: display field request cloud status"
```

## Task 8: End-To-End Verification And Docs

**Files:**
- Create: `docs/operations/field-work-requests-stage0.md` in osi-os
- Create: `docs/operations/field-work-requests-stage0.md` in osi-server or cross-link to osi-os doc
- Update PR bodies with exact verification output

- [ ] **Step 8.1: Add operator docs**

Document:

- Stage 0 scope and non-goals.
- Test-server only rollout.
- Required server env vars for GitHub App and pseudonym secret.
- Rate limits and quarantine behavior.
- Public artifact safety rule: diagnostics never go to GitHub.
- How to disable publishing by unsetting GitHub config.
- How to inspect private diagnostics in admin console.

- [ ] **Step 8.2: Full osi-os gates**

Run from osi-os worktree root:

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
cd web/react-gui && npm run test:unit && npm run typecheck && npm run build
```

Expected: all pass. Capture exact output in the PR body.

- [ ] **Step 8.3: Full osi-server gates**

Run from osi-server worktree:

```bash
cd backend
./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend
cd ../frontend
npm run test:unit
npm run build
cd ../backend
./gradlew test
```

Expected: all pass. The final `./gradlew test` includes frontend builds through `processResources`; capture output.

- [ ] **Step 8.4: Manual local smoke**

Use local/dev server only:

1. Start osi-server dev backend with test env and GitHub MockWebServer disabled unless intentionally testing against a sandbox repo.
2. Start edge GUI/Node-RED dev environment if available.
3. Submit a request with `consent_public=true`.
4. Verify `improvement_requests` has a row and `sync_outbox` has `WORK_REQUEST_SUBMITTED`.
5. POST the event batch to local osi-server.
6. Verify `work_requests.diagnostics_json` is populated and admin queue shows the request.
7. Publish with missing GitHub config and confirm fail-closed `PUBLISH_BLOCKED_CONFIG`.
8. Configure sandbox GitHub App only if available and publish one issue to a sandbox repo; confirm public body has no EUI/token/email/diagnostics.

- [ ] **Step 8.5: Commit docs and open PRs**

Commit docs in each repo:

```bash
git add docs/operations/field-work-requests-stage0.md
git diff --cached --check
git commit -m "docs: document field request stage0 operations"
```

Open two PRs:

- osi-os PR: edge schema, flow, GUI, docs.
- osi-server PR: server intake, admin, GitHub publish gate, docs.

The osi-server PR depends on the osi-os contract PR only for field testing; backend tests should still pass independently.

## Self-Review

**Spec coverage:** Stage 0 covers GUI form, offline edge queueing, double redaction, test-server intake, rate limiting, dedup, quarantine, publish gate, GitHub issue creation, and GUI status-back. It intentionally does not cover Forge runner, agent jobs, draft PRs, token budgets, or PR verifier gates; those are Stage 1-3 plans.

**Open question handling:** GitHub App is chosen; production promotion is deferred; status-back uses pending commands; diagnostics retention is fixed at configurable 90 days; runner caps are not applicable; NEEDS_INFO replies are deferred with a visible no-reply status.

**Code-quality risks addressed:** Redaction is duplicated across Node/Java by necessity, so shared contract fixtures and public-artifact scanner tests are the drift guard. Public artifact building is isolated from persistence/GitHub client to prevent diagnostics leakage. Status-back uses a named command and dedicated edge handler so it cannot fall through to actuator/downlink command logic.

**Verification gates:** Both repos have local unit/build gates, osi-os schema/profile/flow parity gates, and osi-server backend/frontend gates. No live production verification is part of this plan.
