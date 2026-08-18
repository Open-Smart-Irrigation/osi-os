# Cross-repository sync contract CI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make incompatible edge/server sync HTTP changes fail in CI before either repository is deployed, with OSI OS remaining the canonical contract source and OSI Server proving its actual serialized responses against that source.

**Architecture:** Add one small mixed-version HTTP-semantics fixture plus executable bootstrap Device/Zone examples beside the existing edge-owned JSON Schemas. Bootstrap/events remain v2. Token-bound pending commands and ACKs use additive v3 endpoints with an exact capability header; existing v2 endpoints remain isolated compatibility paths so either repository can merge without breaking the old fleet. The existing `Device`/`Zone` definitions describe local API/database resources (`deveui,type_id` and numeric `zone_id`), while real cross-edge bootstrap uses stable sync identities (`device_eui,type` and `zone_uuid`). Add distinct `SyncBootstrapDevice`/`SyncBootstrapZone` definitions rather than treating those shapes as aliases. OSI OS derives examples through shipped functions and validates them. OSI Server vendors those bytes only as test resources, exercises real parsing/serialization, per-entry transactions, concurrency, and service ingestion, and compares the vendored bytes with `osi-os/main` in CI. No workflow deploys either repository or accesses a live host.

**Tech Stack:** Node.js 22 and `node:test`, Java 21 runtime with Java 17 source, JUnit 5, Jackson, Gradle, GitHub Actions.

## Global constraints

- Execute `2026-07-15-sync-delivery-stop-loss.md` first and ChirpStack reconciliation Task 4 second. Generate this plan's edge producer fixture only after `cs-reg-cloud-fn` owns atomic registration completion, `cs-reg-cloud-ack-fn` is wake-only, and the updated stop-loss producer inventory passes. This plan consumes that final graph plus the explicit bootstrap, event-result, command-ACK, and pending-command semantics.
- Base the edge half on `origin/main` containing merged [OSI OS PR #146](https://github.com/Open-Smart-Irrigation/osi-os/pull/146), merge commit `f50950b1767a1aa6302ef2553d68a4e379b5b142` or a verified descendant. The canonical producer fixture is generated only after the sync and ChirpStack plans preserve the merged identity sentinel and final callback/wake graph; server vendoring then pins those exact bytes.
- Pin the OSI Server base the same way: before Task 2, fetch and record the exact `origin/main` HEAD SHA of the server checkout in the execution report, confirm `HEAD == origin/main` there, and base Tasks 2 through 4 plus the paired PR on that SHA or a reviewed descendant. Every server file named in this plan was inventoried against a specific local checkout; a moved or deleted class at the recorded SHA is a plan-revision trigger, not something to patch around.
- Generate pending-command cases through both merged entry points: scheduled `sync-pending-build` and manual/internal `sync-force-build`. Each exercises missing/present/malformed/unreadable/unavailable-`fs` sentinel state plus the full capability/disposition/restore matrix: historical `UNASSESSED|RECONCILIATION_REQUIRED`, database-restore `RECONCILIATION_REQUIRED`, and a missing/malformed activity ledger perform zero transport/dispatch; historical CLEAR plus database-restore CLEAR and `UNNEGOTIATED` permits only the capability negotiation request and commits no command effect; both CLEAR states plus a valid activity ledger and `NEGOTIATED(LEGACY_V2|V3_PINNED)` permit the matching poll/parser/producer path. Also cover identity restart/relink followed by sentinel removal and attempted post-pin downgrade. Both entry points use the same state reader, strict parser, lease-token provenance, and protected ledger context; no fixture-only builder may substitute.
- Under `2026-07-15-refactor-repair-program.md`, export `OSI_REPAIR_PROGRAM_MODE=1`; the edge slice contributes its reviewed ownership fragment to the program's single integrated A1 documentation checkpoint. The separate OSI Server `AGENTS.md` adoption step remains server-owned.
- OSI OS is canonical for `docs/contracts/sync-schema/**` and the new HTTP semantics fixture. Do not create a competing server-owned schema source.
- Do not access Kaba100, the test server, or `osicloud.ch`; this plan is CI and local verification only.
- Do not add a production runtime dependency on a sibling checkout. OSI Server vendors test resources and uses the edge checkout only during CI verification.
- Permit only the narrow OSI Server production changes required to make REST the single command-ACK owner and preserve linked-auth completion; this plan still performs no deployment.
- Do not make OSI OS CI depend on the current OSI Server branch. The merge-safe order is additive edge fixture/capability-gated client first, additive server v3 implementation second, then live v3 enablement only after capability proof. Strict v2 replacement or legacy retirement is outside this plan.
- Preserve edge authority and REST-only cloud-to-edge command delivery.
- A file comparison alone is insufficient: server tests must serialize real response types or controller results, and edge tests must execute the real flow functions.
- A failed checkout, absent contract file, skipped test, empty result set, or parse error is failure.

## Contract surface

The fixture covers only the high-risk HTTP seams found during this refactor audit:

| Endpoint family | Correlation key | Completion evidence |
|---|---|---|
| Bootstrap | request gateway EUI | HTTP 2xx and top-level `success:true` |
| Event batch v2 | `eventUuid` | `APPLIED`, `DUPLICATE`, or `REJECTED`; `RETRYABLE_ERROR` remains pending |
| Command ACK batch v3 | `commandId` + server-issued `leaseToken` | each result's explicit `accepted:true`; lifecycle `terminal` and batch counters never substitute for transport evidence |
| Pending commands v3 | `commandId` + `leaseToken` | exact capability header and every command reaches durable intent/dedupe before mutation |

All four strict families share one transport rule: only an integer status from 200 through 299 may enter body-level success handling. Status zero, a missing/non-numeric status, or any other class is failure and leaves local work pending. Command v3 additionally requires exact path/header capability. Legacy command v2 is documented and tested separately, never used as v3 evidence.

This plan does not invent a general OpenAPI generator or replace the existing resource JSON Schemas.

## File map

### OSI OS repository

| File | Responsibility after this plan |
|---|---|
| `scripts/fixtures/sync-http-high-risk-contract.json` | Canonical correlation, status, transport-acceptance, lifecycle-terminal, and required-field semantics for the four high-risk HTTP seams. |
| `scripts/fixtures/sync-resource-v1-examples.json` | Canonical Device/Zone objects emitted by the shipped bootstrap projection; prevents server-only alias fixtures from masquerading as edge resources. |
| `scripts/lib/sync-delivery-flow-harness.js` | Shared loader and callback-style fake runtime extracted from the stop-loss executable suite. |
| `scripts/verify-sync-http-high-risk-contract.js` | Validates the fixture and executes shipped edge flow behavior against every status class. |
| `scripts/verify-sync-http-high-risk-contract.test.js` | Negative fixture, missing-correlation, mixed-result, and retry controls. |
| `scripts/test-sync-delivery-fail-closed.js` | Consumes the shared harness without weakening its original regression cases. |
| `scripts/verify-sync-contract.js` | Chains the HTTP contract verifier after schema/registry checks. |
| `docs/contracts/sync-schema/resources.schema.json` | Retains local `Device`/`Zone` and adds production-shaped `SyncBootstrapDevice`/`SyncBootstrapZone` definitions keyed by EUI/UUID. |
| `.github/workflows/verify-sync-flow.yml` | Names the HTTP verifier and test suite as required gates. |
| `scripts/test-ci-guard-wiring.js` | Pins both direct HTTP-contract commands with remove-one controls. |
| `docs/contracts/sync-schema/README.md` | Records ownership, compatibility order, and the server-vendor rule. |

### OSI Server repository

| File | Responsibility after this plan |
|---|---|
| `backend/src/test/resources/sync-contract/sync-http-high-risk-contract.json` | Byte-identical vendored edge HTTP semantics fixture. |
| `backend/src/test/resources/sync-contract/sync-resource-v1-examples.json` | Byte-identical vendored production-shaped Device/Zone examples generated and checked on the edge. |
| `backend/src/test/resources/sync-contract/commands.schema.json` | Byte-identical vendored edge command schema. |
| `backend/src/test/resources/sync-contract/events.schema.json` | Byte-identical vendored edge event schema. |
| `backend/src/test/resources/sync-contract/resources.schema.json` | Byte-identical vendored edge resource schema. |
| `backend/src/test/java/org/osi/server/sync/SyncHttpHighRiskContractTest.java` | Serializes actual server responses and checks correlation, transport acceptance, and lifecycle terminality. |
| `backend/src/test/java/org/osi/server/sync/SyncSchemaValidationTest.java` | Validates real canonical command/event/resource projections with the vendored draft-07 schemas. |
| `backend/build.gradle.kts` | Adds the Jackson-2-compatible validator `com.networknt:json-schema-validator:2.0.4` as a test-only dependency; no production dependency. |
| `backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java` | Pins top-level bootstrap `success:true` and v2 event result serialization. |
| `backend/src/main/java/org/osi/server/sync/EdgeSyncController.java` | Adds the capability-gated v3 pending endpoint while leaving the v2 controller method and serialization unchanged. |
| `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java` and `EdgeSyncServiceControlPlaneTest.java` | Keeps v2 stable and returns server-issued lease tokens only through the additive v3 pending response. |
| `backend/src/test/java/org/osi/server/command/CommandAckControllerTest.java` | Pins mixed per-entry accepted/unaccepted and terminal/nonterminal ACK results with exact identities. |
| `backend/src/main/java/org/osi/server/command/CommandAckController.java` | Retains the current transactional v2 method unchanged; only the additive v3 method coordinates strict entries through isolated transactions. |
| New `CommandAckV3Request.java`, `CommandAckV3Response.java`, and `CommandAckV3BodyParser.java` | Carry and strictly parse the exact nine-field request plus independent per-entry `accepted`/`terminal` response without weakening the global mapper. |
| `backend/src/main/java/org/osi/server/command/DeviceCommand.java` | Persists the active lease-generation token with the leased command. |
| `backend/src/main/java/org/osi/server/command/DeviceCommandRepository.java` | Provides the shared row-lock/CAS primitive used by v3 ACK, lease, expiry, and reclaim. |
| `backend/src/main/java/org/osi/server/command/CommandLeaseService.java` and its test | Generates one fresh cryptographic UUID token under the same command-row lock as every competing transition. |
| New `CommandAckEntryService.java` and test | Applies one v3 entry in `REQUIRES_NEW`, including command, linked-auth, and receipt, so one bad batch sibling cannot poison another. |
| `backend/src/main/java/org/osi/server/command/CommandAckReceipt.java` and repository | Persist long-lived replay tombstones keyed by gateway/command plus one-way lease-token SHA256, never the raw bearer token, with canonical outcomes. |
| `backend/src/main/resources/db/migration/V2026_07_15_001__command_ack_lease_receipts.sql` | Adds the raw token only to the active command lease plus immutable receipts keyed/indexed by `lease_token_sha256`. |
| `backend/src/main/java/org/osi/server/user/LinkedAuthAckCompletionService.java` | Derives linked user/version from the persisted command and records terminal linked-auth success or failure idempotently. |
| `backend/src/test/java/org/osi/server/user/LinkedAuthAckCompletionServiceTest.java` | Pins aggregate-key parsing, outcome policy, replay idempotency, and retryable no-op behavior. |
| `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java`, repository, and current writer service | Add one shared optimistic-version or pessimistic-lock boundary used by ACK completion and every competing verifier/account writer. |
| `backend/src/main/java/org/osi/server/mqtt/MqttMessageRouter.java` | No longer mutates cloud command state from MQTT command-ACK messages. |
| `backend/src/test/java/org/osi/server/mqtt/MqttMessageRouterTest.java` | Proves MQTT telemetry cannot complete commands or linked-auth state. |
| `backend/src/test/java/org/osi/server/workrequest/WorkRequestStatusNotifierTest.java` | Pins the emitted command type and schema-required request/status fields. |
| `backend/src/test/java/org/osi/server/retention/CommandRetentionJobTest.java` and repository DB test | Prove terminal command cleanup preserves long-lived receipt replay tombstones and active command state. |
| `backend/src/test/java/org/osi/server/command/CommandLeaseAckConcurrencyIT.java` | Uses the real PostgreSQL 16/Flyway schema and two transactions to prove lease/ACK/reclaim serialization plus receipt uniqueness. |
| `backend/src/test/java/org/osi/server/command/CommandAckEntryTransactionIT.java` | Proves the Spring-proxied per-entry `REQUIRES_NEW` boundary commits/rolls back mixed siblings independently on PostgreSQL. |
| `backend/src/test/java/org/osi/server/command/CommandReceiptRetentionIT.java` | Executes the real retention job on PostgreSQL, clears persistence context, and proves receipt-only replay after terminal command deletion. |
| `backend/src/test/java/org/osi/server/testsupport/FlywayMigrationIT.java` | Verifies the receipt table, normalized uniqueness constraint, indexes, and deliberate absence of a deleting command FK in the migrated PostgreSQL schema. |
| `backend/src/test/java/org/osi/server/testsupport/PostgresSyncTestBase.java` | Existing PostgreSQL 16 singleton/Flyway harness, documented for sync and command-contract integration tests. |
| `.github/workflows/backend-ci.yml` | Checks out `osi-os/main`, compares all vendored contract bytes, then runs backend tests. |
| `AGENTS.md` | Records edge-first contract ownership and the two-repository verification rule. |

### Task 1: Define executable edge-owned HTTP semantics

**Repository:** `/home/phil/Repos/osi-os`

**Files:**

- Create: `scripts/fixtures/sync-http-high-risk-contract.json`
- Create: `scripts/fixtures/sync-resource-v1-examples.json`
- Create: `scripts/lib/sync-delivery-flow-harness.js`
- Create: `scripts/verify-sync-http-high-risk-contract.js`
- Create: `scripts/verify-sync-http-high-risk-contract.test.js`
- Modify: `scripts/test-sync-delivery-fail-closed.js`
- Modify: `scripts/verify-sync-contract.js`
- Modify: `docs/contracts/sync-schema/resources.schema.json`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `scripts/test-ci-guard-wiring.js`
- Modify: `docs/contracts/sync-schema/README.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Produces: `loadContract(path) -> SyncHttpHighRiskContract`, rejecting unknown fields and unsupported formats.
- Produces: `executeFlowFunction(nodeId, msg, options) -> Promise<{ result, sql, flowState, errors }>` from the shared harness.
- Produces: `classifyEventResult(result) -> { identity: string, terminal: boolean }`.
- Produces: `classifyCommandAckResult(result) -> { identity: number, accepted: boolean, terminal: boolean }`.
- Produces: `verifyEdgeHttpContract({ flows, contract }) -> string[]`; empty is PASS.
- Produces: `buildCanonicalResourceExamples({ flows, databaseRows }) -> { Device, Zones }`, executing the real `sync-bootstrap-build` node with deterministic rows and retaining both scheduling-mode Zone cases rather than reimplementing its projection.

- [ ] **Step 1: Write the bounded fixture**

Use exact status values and field names:

```json
{
  "format": 2,
  "transport": {
    "successStatusMin": 200,
    "successStatusMax": 299,
    "missingStatusIsFailure": true
  },
  "bootstrap": { "successField": "success", "requiredValue": true },
  "eventBatchV2": {
    "resultsField": "results",
    "identityField": "eventUuid",
    "statusField": "status",
    "terminalStatuses": ["APPLIED", "DUPLICATE", "REJECTED"],
    "retryableStatuses": ["RETRYABLE_ERROR"]
  },
  "commandAckBatchV3": {
    "protocol": 3,
    "pathTemplate": "/api/v1/sync/v3/gateways/{gatewayEui}/command-acks",
    "capabilityHeader": { "name": "X-OSI-Sync-Protocol", "value": "3" },
    "requestBodyField": "acks",
    "requestFields": {
      "commandId": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "required": true, "aliases": ["commandId", "command_id"] },
      "status": { "type": "string", "required": true, "aliases": ["status"] },
      "detail": { "type": ["string", "null"], "required": true, "aliases": ["detail"] },
      "result": { "type": ["string", "null"], "required": true, "aliases": ["result"] },
      "appliedAt": { "type": ["string", "null"], "format": "date-time", "required": true, "aliases": ["appliedAt", "applied_at"] },
      "appliedSyncVersion": { "type": ["integer", "null"], "minimum": 0, "maximum": 9007199254740991, "required": true, "aliases": ["appliedSyncVersion", "applied_sync_version"] },
      "duplicate": { "type": "boolean", "required": true, "default": false, "aliases": ["duplicate"] },
      "reason": { "type": ["string", "null"], "required": true, "aliases": ["reason"] },
      "leaseToken": { "type": "string", "format": "uuid", "required": true, "aliases": ["leaseToken", "lease_token"] }
    },
    "requestSemantics": [
      { "status": "ACKED", "result": "APPLIED", "accepted": true, "terminal": true },
      { "status": "NACKED", "result": "REJECTED_PERMANENT", "accepted": true, "terminal": true },
      { "status": "EXPIRED", "result": "EXPIRED", "accepted": true, "terminal": true },
      { "status": "FAILED_RETRYABLE", "result": "FAILED_RETRYABLE", "accepted": true, "terminal": false }
    ],
    "serverFixtureAttemptCount": 0,
    "requestExamples": [
      { "commandId": 1001, "status": "ACKED", "detail": "applied", "result": "APPLIED", "appliedAt": "2026-07-15T00:00:01Z", "appliedSyncVersion": 7, "duplicate": false, "reason": null, "leaseToken": "00000000-0000-4000-8000-000000000001" },
      { "commandId": 1002, "status": "NACKED", "detail": "rejected", "result": "REJECTED_PERMANENT", "appliedAt": "2026-07-15T00:00:02Z", "appliedSyncVersion": null, "duplicate": false, "reason": "invalid_command", "leaseToken": "00000000-0000-4000-8000-000000000002" },
      { "commandId": 1003, "status": "EXPIRED", "detail": "expired", "result": "EXPIRED", "appliedAt": "2026-07-15T00:00:03Z", "appliedSyncVersion": null, "duplicate": false, "reason": "command_expired", "leaseToken": "00000000-0000-4000-8000-000000000003" },
      { "commandId": 1004, "status": "FAILED_RETRYABLE", "detail": "retryable", "result": "FAILED_RETRYABLE", "appliedAt": "2026-07-15T00:00:04Z", "appliedSyncVersion": null, "duplicate": false, "reason": "transient_failure", "leaseToken": "00000000-0000-4000-8000-000000000004" }
    ],
    "producerExamples": [],
    "producerTokenInputs": [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
      "00000000-0000-4000-8000-000000000103",
      "00000000-0000-4000-8000-000000000104"
    ],
    "responseTopLevelFields": {
      "processed": { "type": "integer", "required": true },
      "succeeded": { "type": "integer", "required": true },
      "results": { "type": "array", "required": true }
    },
    "resultsField": "results",
    "responseEntryFields": {
      "commandId": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "required": true },
      "status": { "type": "string", "required": true },
      "error": { "type": ["string", "null"], "required": true },
      "accepted": { "type": "boolean", "required": true },
      "terminal": { "type": "boolean", "required": true },
      "leasedAgain": { "type": "boolean", "required": true }
    },
    "responseSemantics": [
      { "case": "default", "requestStatus": "ACKED", "requestResult": "APPLIED", "responseStatus": "ACKED", "error": null, "accepted": true, "terminal": true, "leasedAgain": false },
      { "case": "default", "requestStatus": "NACKED", "requestResult": "REJECTED_PERMANENT", "responseStatus": "NACKED", "error": null, "accepted": true, "terminal": true, "leasedAgain": false },
      { "case": "default", "requestStatus": "EXPIRED", "requestResult": "EXPIRED", "responseStatus": "EXPIRED", "error": null, "accepted": true, "terminal": true, "leasedAgain": false },
      { "case": "non_exhausted", "requestStatus": "FAILED_RETRYABLE", "requestResult": "FAILED_RETRYABLE", "responseStatus": "PENDING", "error": null, "accepted": true, "terminal": false, "leasedAgain": true },
      { "case": "attempts_exhausted", "requestStatus": "FAILED_RETRYABLE", "requestResult": "FAILED_RETRYABLE", "responseStatus": "NACKED", "error": "max_attempts_exceeded", "accepted": true, "terminal": true, "leasedAgain": false },
      { "case": "invalid_semantic_pair", "requestStatus": "ACKED", "requestResult": "FAILED_RETRYABLE", "responseStatus": "INVALID_ACK", "error": "invalid_status_result_pair", "accepted": false, "terminal": false, "leasedAgain": false },
      { "case": "lease_token_mismatch", "requestStatus": "ACKED", "requestResult": "APPLIED", "responseStatus": "LEASE_MISMATCH", "error": "lease_mismatch", "accepted": false, "terminal": false, "leasedAgain": false }
    ],
    "identityField": "commandId",
    "acceptedField": "accepted",
    "terminalField": "terminal"
  },
  "pendingCommandsV3": {
    "protocol": 3,
    "pathTemplate": "/api/v1/sync/v3/gateways/{gatewayEui}/pending-commands",
    "capabilityHeader": { "name": "X-OSI-Sync-Protocol", "value": "3" },
    "responseBodyFields": ["protocol", "commands"],
    "protocolField": "protocol",
    "protocolValue": "3",
    "commandsField": "commands",
    "commandFields": {
      "commandId": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "required": true },
      "eventUuid": { "type": ["string", "null"], "required": true },
      "commandType": { "type": "string", "required": true },
      "aggregateType": { "type": ["string", "null"], "required": true },
      "aggregateKey": { "type": ["string", "null"], "required": true },
      "appliedSyncVersion": { "type": ["integer", "null"], "minimum": 0, "maximum": 9007199254740991, "required": true },
      "payload": { "type": ["object", "null"], "required": true },
      "createdAt": { "type": "string", "format": "date-time", "required": true },
      "leaseGrantedAt": { "type": "string", "format": "date-time", "required": true },
      "leaseExpiresAt": { "type": "string", "format": "date-time", "required": true },
      "leasedToGateway": { "type": "string", "required": true },
      "status": { "type": "string", "required": true, "allowed": ["LEASED"] },
      "leaseToken": { "type": "string", "format": "uuid", "required": true }
    },
    "durableIntentRequiredBeforeMutation": true
  },
  "legacyCommandV2": {
    "compatibilityOnly": true,
    "maySatisfyV3": false,
    "retirementRequiresSeparateApproval": true
  }
}
```

The empty `producerExamples` array shown in the template is a generation slot and must be populated before the fixture can pass. Add `commandAckBatchV3.producerExamples` as a separate generated array. Every entry has exactly `producerId`, `branch`, `effectClass`, `semanticIndex`, `tokenSource`, and `request`; `request` is the exact nine-field canonical object produced by executing that branch through the shipped v3 queue canonicalizer with a deterministic edge-owned `producerTokenInputs` UUID injected into the protected pending envelope. The harness reaches that canonicalizer only through receipt-bound historical/database-restore CLEAR, a valid activity ledger, and `NEGOTIATED(V3_PINNED)` state; UNASSESSED, either reconciliation-required state, missing/malformed activity state, and negotiation-only harness runs must produce an empty ledger. Protected context also carries fixed non-secret capability `identitySha256` and proves the internal ledger key is namespaced by it; neither fact enters the nine-field transport object. This fixture is not claiming that the edge issues runtime tokens. The server contract test injects deterministic UUIDs through the real lease service and requires persisted lease state before posting producer bytes. Production retains cryptographically random tokens. The four `requestExamples` remain representative semantic rows. The producer/branch set exactly equals the audited graph inventory; entries are sorted and unique. Remove-one, disposition/restore/activity bypass, extra producer, branch rename, wrong effect class/semantic index/token provenance, hand-built request, cross-identity numeric-ID dedupe, non-atomic SQLite route, missing external intent, MQTT-only route, and REST-plus-MQTT route mutations fail.

Parser validation requires format 2, exactly these top-level/nested keys, transport bounds 200/299, `missingStatusIsFailure === true`, exact v3 paths/capability headers, the nine ACK request fields, exact three top-level response fields, exact six response-entry fields and types, every response semantic including `error` and `leasedAgain`, exact pending top-level fields, string protocol value `"3"`, all thirteen pending-command field definitions including `leaseToken`, and the three legacy-isolation Booleans. Every request, response, and pending `commandId` has exact inclusive bounds `1..9007199254740991`; nullable `appliedSyncVersion` has exact inclusive bounds `0..9007199254740991`. Require unique local aliases and deterministic token inputs, `serverFixtureAttemptCount === 0`, four exact request semantic rows, one nine-field example per row, and the complete producer ledger. The edge response parser rejects missing, unknown, duplicate, wrong-typed, fractional, or JS-unsafe numeric response keys before grouping; it classifies transport delivery only from `accepted`, never from batch counts, `status`, `terminal`, or `leasedAgain`. Receipts persist and replay every response field deterministically, including nullable `error` and `leasedAgain`, and bind the canonical response bytes/hash. Every valid v3 request row is transport-accepted; terminality remains separate. The UUID token is generated by the runtime server lease service; deterministic fixture tokens are injected only through its test token source, preserved in a same-token outbox retry, and replaced only from a new protected pending envelope. Hand editing or generating a token inside the edge producer fails provenance. Invalid status/result pairs, missing/changed token, legacy `SUCCESS`, null result, changed response expectation, or widened numeric range is invalid. Also require unique/disjoint event statuses, `requiredValue === true`, and `durableIntentRequiredBeforeMutation === true`.

- [ ] **Step 2: Add red edge behavior tests**

For every v3 response, require `processed` to equal the number of submitted entries and `succeeded` to equal the number of `accepted:true` results. These counters are exact response bytes but never classify an individual row; missing, extra, duplicate, negative, non-integer, or inconsistent counters fail the strict parser and leave all affected edge rows pending.

Extract the loader, callback-style fake database, flow context, and `executeFlowFunction` from `scripts/test-sync-delivery-fail-closed.js` into `scripts/lib/sync-delivery-flow-harness.js`. Keep assertions and test cases in the original executable. The module must accept an explicit flows path, expose no singleton state between cases, and throw if a caller accesses `.prepare`. Both executables import it; do not create a second function-node interpreter. Cover:

- bootstrap 2xx with `success:true` advances; missing/false does not;
- event results correlate by `eventUuid`, with terminal statuses delivered and `RETRYABLE_ERROR` pending;
- mixed v3 command ACK results correlate by `commandId`, deliver only `accepted:true`, and preserve each independent `terminal` Boolean;
- the real outgoing v3 POST body contains only the fixture's nine canonical camelCase fields, converts every local alias once, preserves same-token bytes, binds a fresh token only on new-lease replay, preserves valid explicit nulls/types, accepts only positive safe-integer `commandId` and null-or-nonnegative safe-integer `appliedSyncVersion`, and rejects 0/negative/fractional/`2^53`/rounding-adjacent numeric values, conflicts, absent nullable keys, invalid types/token/timestamp, unknown fields, or a pair outside `requestSemantics` before transport;
- every audited producer and semantic branch appears exactly once in `producerExamples`, commits SQLite effect+ledger+outbox together or persists external intent before effect, and has no command-completion MQTT path;
- the final `REGISTER_DEVICE` branch executes `persistExternalIntent -> ChirpStack read-back -> completeIdempotentExternalEffect`, commits its parameterized local row plus ledger outcome plus ACK outbox once, and emits only a data-free/coalescible REST scanner wake afterward; removing the callback transaction, adding a post-return queue insert, or restoring MQTT fails;
- absent, duplicate, or unknown result identities leave the corresponding local row pending;
- both scheduled and force-sync entry points reject historical `UNASSESSED|RECONCILIATION_REQUIRED`, database-restore `RECONCILIATION_REQUIRED`, and missing/malformed activity state before HTTP; allow historical/database-restore CLEAR plus `UNNEGOTIATED` to perform negotiation only with zero producer calls; and allow polling/fixture generation only after the same receipt-bound both-CLEAR, valid-activity, `NEGOTIATED` state reverifies; removing any disposition/restore/activity check from either entry point fails;
- the strict v3 pending parser rejects an extra/missing top-level or command field, omitted nullable field, wrong/null nonnullable scalar, unsafe/fractional/out-of-range command or sync-version integer, non-`LEASED` status, malformed time/token, duplicate command identity/token, v2/v3 endpoint/header/body mixing, and post-capability downgrade before any producer sees the envelope; pending `WORK_REQUEST_STATUS` and a normal command both persist durable intent before their appliers; and
- status zero, missing/non-numeric status, malformed JSON, and non-2xx never become success, using the fixture's transport bounds rather than a second hardcoded classifier.

The fixture parser tests must fail on an added unknown field, widened or inverted transport or numeric bounds, `missingStatusIsFailure:false`, an ACK request-field removal/type/default/alias change or cross-field alias collision, a response top-level or entry-field removal/addition/type/range change, a pending numeric range change, a missing/extra/duplicate/reordered/mismatched request or response semantic pair, changed `error`/`leasedAgain`, overlapping event status sets, a renamed identity field, `requiredValue:false`, and missing dedupe requirement.

Create `sync-resource-v1-examples.json` from deterministic database rows passed through node `sync-bootstrap-build` with a fake clock. Retain the exact emitted bootstrap objects: Device requires `device_eui` and `type`; Zone requires `zone_uuid` and `name`. Include two production-shaped Zone examples whose `scheduling_mode` values are exactly `local` and `server_preferred`. Add `SyncBootstrapDevice` and `SyncBootstrapZone` to `resources.schema.json`, reusing `Eui64`, `Uuid`, and a shared device-type enum where possible, plus the actual optional bootstrap fields; `SyncBootstrapZone.scheduling_mode` has only that two-value enum, which is intentionally distinct from any legacy/local `Zone` vocabulary. Do not weaken or rename the existing local `Device`/`Zone` definitions. Validate the examples against `#/definitions/SyncBootstrapDevice` and `/SyncBootstrapZone`. Add mutation controls that remove each required field, substitute local-only `deveui,type_id,zone_id`, use a non-EUI/non-UUID identity, omit either scheduling-mode case, use a third/legacy scheduling value, or mutate the production SQL/projection back to a divergent name; all must fail. The committed bytes must be reproducible from the shipped flow fixture, so a hand-edited or server-only map cannot pass.

- [ ] **Step 3: Chain and name the gates**

Have `verify-sync-contract.js` call the exported verifier and propagate failures. Also name both commands in `verify-sync-flow.yml`:

```yaml
- name: Verify edge-server high-risk sync HTTP contract
  run: |
    node scripts/verify-sync-http-high-risk-contract.js
    node --test scripts/verify-sync-http-high-risk-contract.test.js
```

Extend `scripts/test-ci-guard-wiring.js` with both direct commands and table-driven remove-one controls. The aggregate contract or flow verifier cannot stand in for either executable.

- [ ] **Step 4: Run and commit the canonical contract**

```bash
node scripts/verify-sync-http-high-risk-contract.js
node --test scripts/verify-sync-http-high-risk-contract.test.js
node scripts/test-sync-delivery-fail-closed.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-flow.js
node scripts/test-ci-guard-wiring.js
git diff --check
```

```bash
git add scripts/fixtures/sync-http-high-risk-contract.json scripts/fixtures/sync-resource-v1-examples.json \
  scripts/lib/sync-delivery-flow-harness.js scripts/test-sync-delivery-fail-closed.js \
  scripts/verify-sync-http-high-risk-contract.js scripts/verify-sync-http-high-risk-contract.test.js \
  scripts/verify-sync-contract.js docs/contracts/sync-schema/resources.schema.json \
  scripts/test-ci-guard-wiring.js .github/workflows/verify-sync-flow.yml
git commit -m "test: define edge sync HTTP contract"
```

- [ ] **Step 5: Record edge ownership before merge**

In `docs/contracts/sync-schema/README.md` and OSI OS `AGENTS.md`, record that OSI OS owns the schemas and HTTP terminal/transport semantics; compatible additions merge edge-first, server test vendors must be byte-identical to `osi-os/main`, and removal or reinterpretation requires server adoption before a second edge change. State that the server copies are test inputs, not an authority.

```bash
node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/sync-schema/README.md AGENTS.md
git add docs/contracts/sync-schema/README.md
if [ "${OSI_REPAIR_PROGRAM_MODE:-0}" != "1" ]; then
  git add AGENTS.md
fi
git commit -m "docs: record edge sync contract ownership"
```

Merge the backwards-compatible OSI OS contract and ownership commits before opening the server vendor update against them.

### Task 2: Prove actual OSI Server response serialization

**Repository:** `/home/phil/Repos/osi-server`

**Files:**

- Create: `backend/src/test/resources/sync-contract/sync-http-high-risk-contract.json`
- Create: `backend/src/test/resources/sync-contract/sync-resource-v1-examples.json`
- Create: `backend/src/test/resources/sync-contract/commands.schema.json`
- Create: `backend/src/test/resources/sync-contract/events.schema.json`
- Create: `backend/src/test/resources/sync-contract/resources.schema.json`
- Create: `backend/src/test/java/org/osi/server/sync/SyncHttpHighRiskContractTest.java`
- Create: `backend/src/test/java/org/osi/server/sync/SyncSchemaValidationTest.java`
- Modify: `backend/build.gradle.kts`
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`
- Modify: `backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`
- Modify: `backend/src/test/java/org/osi/server/command/CommandAckControllerTest.java`
- Modify: `backend/src/main/java/org/osi/server/command/CommandAckController.java`
- Create: `backend/src/main/java/org/osi/server/command/CommandAckV3Request.java`
- Create: `backend/src/main/java/org/osi/server/command/CommandAckV3Response.java`
- Create: `backend/src/main/java/org/osi/server/command/CommandAckV3BodyParser.java`
- Modify: `backend/src/main/java/org/osi/server/command/DeviceCommand.java`
- Modify: `backend/src/main/java/org/osi/server/command/DeviceCommandRepository.java`
- Modify: `backend/src/main/java/org/osi/server/command/CommandLeaseService.java`
- Modify: `backend/src/test/java/org/osi/server/command/CommandLeaseServiceTest.java`
- Create: `backend/src/main/java/org/osi/server/command/CommandAckEntryService.java`
- Create: `backend/src/test/java/org/osi/server/command/CommandAckEntryServiceTest.java`
- Create: `backend/src/main/java/org/osi/server/command/CommandAckReceipt.java`
- Create: `backend/src/main/java/org/osi/server/command/CommandAckReceiptRepository.java`
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify: `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceControlPlaneTest.java`
- Create: `backend/src/main/resources/db/migration/V2026_07_15_001__command_ack_lease_receipts.sql`
- Create: `backend/src/main/java/org/osi/server/user/LinkedAuthAckCompletionService.java`
- Create: `backend/src/test/java/org/osi/server/user/LinkedAuthAckCompletionServiceTest.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccountRepository.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccountService.java`
- Modify: `backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java`
- Modify: `backend/src/main/java/org/osi/server/mqtt/MqttMessageRouter.java`
- Modify: `backend/src/test/java/org/osi/server/mqtt/MqttMessageRouterTest.java`
- Modify: `backend/src/test/java/org/osi/server/workrequest/WorkRequestStatusNotifierTest.java`
- Modify: `backend/src/test/java/org/osi/server/retention/CommandRetentionJobTest.java`
- Modify: `backend/src/test/java/org/osi/server/command/DeviceCommandRepositoryDbTest.java`
- Create: `backend/src/test/java/org/osi/server/command/CommandLeaseAckConcurrencyIT.java`
- Create: `backend/src/test/java/org/osi/server/command/CommandAckEntryTransactionIT.java`
- Create: `backend/src/test/java/org/osi/server/command/CommandReceiptRetentionIT.java`
- Modify: `backend/src/test/java/org/osi/server/testsupport/FlywayMigrationIT.java`
- Modify: `backend/src/test/java/org/osi/server/testsupport/PostgresSyncTestBase.java`

**Interfaces:**

- Consumes: the vendored fixture only from test classpath.
- Verifies: real Jackson field names and values for bootstrap/events, plus scoped strict parsing and actual serialization for command v3.
- Adds: v3 `accepted` while leaving legacy v2 request/response types, endpoint method, transaction annotation, serialization, and rollback behavior unchanged; `terminal` remains independent command lifecycle state.
- Produces: one fresh server-issued UUID `leaseToken` per command lease generation and immutable accepted-ACK receipts keyed by gateway, command, and token.

- [ ] **Step 1: Vendor exact canonical files**

Copy, without formatting or regeneration:

```bash
cp ../osi-os/scripts/fixtures/sync-http-high-risk-contract.json \
  backend/src/test/resources/sync-contract/sync-http-high-risk-contract.json
cp ../osi-os/scripts/fixtures/sync-resource-v1-examples.json \
  backend/src/test/resources/sync-contract/sync-resource-v1-examples.json
cp ../osi-os/docs/contracts/sync-schema/commands.schema.json \
  backend/src/test/resources/sync-contract/commands.schema.json
cp ../osi-os/docs/contracts/sync-schema/events.schema.json \
  backend/src/test/resources/sync-contract/events.schema.json
cp ../osi-os/docs/contracts/sync-schema/resources.schema.json \
  backend/src/test/resources/sync-contract/resources.schema.json
```

- [ ] **Step 2: Test DTO serialization against the fixture**

Load the fixture with the production-configured Jackson mapper, but parse the v3 ACK body through a scoped raw-byte `CommandAckV3BodyParser`. Enable Jackson strict duplicate detection for that reader only. Require exact top-level `acks`, a non-null array, non-null object entries, and exactly the nine canonical camelCase keys in every entry; aliases are edge-input normalization only and are not server JSON keys. Check presence and numeric tokens before Java `Long` binding so omitted nullable fields/defaults and values outside the JS-safe domain cannot collapse or round. Reject duplicate keys, camel+snake coexistence, unknown keys, null batch/entry, missing each of the nine keys one at a time, invalid time/token, wrong scalar, fractional value, `commandId` 0/-1/`2^53`, `appliedSyncVersion` -1/`2^53`, and adjacent unsafe integers with bounded 4xx/no mutation; accept both exact maxima and `appliedSyncVersion:0`. A structurally valid entry with an invalid status/result pair returns per-entry `accepted:false,terminal:false`. Do not change the global `ObjectMapper` or legacy v2 parser.

Add v3 pending/ACK endpoints at the exact fixture paths; every successful v3 response emits exact `X-OSI-Sync-Protocol: 3`. Keep the current v2 paths, DTOs, serialization, and behavior unchanged, and prove an old v2 request still passes. In particular, retain the existing v2 `ackGatewayBatch` method's `@Transactional` boundary and all-or-nothing rollback behavior; only the new v3 method is a nontransactional coordinator. `CommandLeaseService` writes a fresh cryptographically random UUID for every v3 lease generation in the same locked transaction as `LEASED`, `leasedToGateway`, and timestamps; `EdgeSyncService.PendingCommandV3Response` returns it. Its test-only injected token source must reproduce the edge fixture UUID inputs through the real lease transition; production wiring always uses the cryptographic source and cannot select fixture tokens. Re-leasing changes the token. V2 responses never contain the v3 capability header and cannot satisfy a v3 test. Then serialize:

- `SyncEventBatchResponse` containing one each of `APPLIED`, `DUPLICATE`, `REJECTED`, and `RETRYABLE_ERROR`;
- `CommandAckV3Response` containing two accepted results with distinct command IDs and opposite `terminal` values, plus one unaccepted token mismatch; and
- `PendingCommandV3BatchResponse` containing a token-bound `WORK_REQUEST_STATUS` command.

For each result, resolve fields by the fixture's configured names and assert exact identity, status, transport acceptance, lifecycle terminality/retryability, and array order. Assert no entry-level identity is null and no batch counter is used to classify an entry. Add negative fixture copies with `eventUuid` renamed and with a widened transport range; prove the assertion helper rejects both.

- [ ] **Step 3: Pin controller and emitter behavior**

In `EdgeSyncControllerTest`, require HTTP 200 for successful bootstrap and event-batch v2 responses; serialize bootstrap `success:true`; require unauthorized responses outside 2xx. Separately prove old pending v2 bytes are unchanged and contain no v3 capability header. For v3 pending, require the exact header, token, path, and strict body. Validate `commandId` and `appliedSyncVersion` against the fixture's JS-safe bounds before lease mutation or serialization; an unsafe pending row fails the whole v3 response without issuing/rotating a token or advancing status. Exercise 0, negative, exact maxima, `2^53`, fractional, and adjacent-collision cases for both the pending emitter and ACK response. Exercise event JSON with all four statuses.

Make only the additive v3 method in `CommandAckController` a nontransactional batch coordinator. The existing v2 `ackGatewayBatch` method retains its current annotation, parser, DTOs, serialization, mutation ordering, and rollback behavior. Add a v2 regression that forces the second entry to fail and proves the first rolls back with byte-compatible response serialization. The v3 method performs raw structural parsing and invokes a separate proxied `CommandAckEntryService` once per valid entry. That service is `REQUIRES_NEW`. It computes lowercase SHA256 over the exact validated UUID token in memory and first looks up normalized `(command_id,gateway_eui,lease_token_sha256)` without requiring a command row: an exact canonical request hash returns the stored six-field result, while a conflicting hash is unaccepted, so replay still works after command retention. When no receipt exists, it acquires the command row through one `DeviceCommandRepository` pessimistic-write lock or equivalent compare-and-set shared with lease, expiry, and reclaim, then rereads the receipt under that digest identity to close the first-lookup race. It validates the active raw token through constant-time comparison, applies command + linked-auth mutation, inserts only the digest/canonical hashes/response, and commits one result. A bounded entry failure rolls back only that entry and returns `accepted:false,terminal:false`; valid siblings commit and their response remains truthful. Never use self-invocation or log the raw token.

The migration gives `command_ack_receipts` a database UNIQUE constraint on normalized `(command_id,gateway_eui,lease_token_sha256)`, where the digest is lowercase 64-hex over the validated random UUID token. It has immutable canonical request SHA256, exact response `status`, nullable `error`, `accepted`, `terminal`, and `leasedAgain`, canonical response SHA256/bytes, plus digest/created-at indexes. It has no raw `lease_token`, request-body, or payload column and no deleting FK to `device_commands`. The raw token exists only on the active `device_commands` lease and is cleared/rotated under the row lock. Retain receipts indefinitely in v1 because the edge retry/offline horizon is unbounded. `CommandRetentionJob` may delete a 180-day terminal command while its receipt remains; digest replay is checked before command lookup. Repository/catalog/log tests inspect columns, entity serialization, SQL parameters, and captured logs to prove raw token and fixture UUID never enter a receipt, tombstone log, or diagnostic output; canonical request SHA may bind the request without storing it.

In entry/controller tests, seed four current tokens and post exact edge rows. Require `accepted:true` for all; the first three are terminal and non-exhausted retryable is nonterminal. At `maxAttempts - 1`, retryable returns accepted terminal NACK. Invalid pairs/tokens are unaccepted/nonterminal with no mutation. An exact canonical replay returns the receipt without a second command, attempt-count, or linked-auth mutation, even after a new lease. A conflicting same-token request is unaccepted. An unreceipted superseded token is unaccepted and cannot mutate the current lease; the edge's tested new-token supersession removes that obsolete row. Batch counters never classify entries.

Keep Mockito/service tests and the H2 `DeviceCommandRepositoryDbTest` as fast behavior/SQL-shape checks; neither is concurrency acceptance evidence. Add `CommandLeaseAckConcurrencyIT` extending the existing `PostgresSyncTestBase`, with `@DataJpaTest`, `@AutoConfigureTestDatabase(replace = NONE)`, and class-level `@Transactional(propagation = NOT_SUPPORTED)`. Use actual repositories, the Spring-proxied services, and two real connections/transactions. Barrier-control simultaneous identical ACKs, conflicting same-token ACKs with each order forced, ACK versus lease expiry/reclaim with ACK-first and reclaim-first order, and two lease contenders. Put latches around a spy of the real locking repository method; do not use sleeps or mocked persistence. The shared row lock/CAS plus real PostgreSQL UNIQUE digest constraint permits one mutation/attempt outcome. Exact losers deterministically replay the winner; conflicting or superseded losers are unaccepted. Assert one receipt per token digest, exact attempts, no duplicate linked-auth/effect, current lease preservation, and absence of raw UUID bytes from receipt rows/logs. Use class-specific gateway EUIs/commands and never truncate the singleton shared test database.

Add `CommandAckEntryTransactionIT` on the same PostgreSQL base/annotations. Invoke the real `CommandAckEntryService` Spring proxy through a test harness: one valid sibling commits, a linked-auth failure rolls back command/account/receipt together, and a later valid sibling commits. Deliberately roll back the outer harness transaction; the two valid entry transactions must remain, proving real `REQUIRES_NEW`. Clear the persistence context before asserting database facts. Also cover terminal/retryable lost responses, first ACK request dropped through expiry then fresh-token edge supersession, accepted/nonterminal followed by re-lease/new token, delayed old request/response, and two distinct legitimate retryable attempts across unit and PostgreSQL suites. Add `CommandReceiptRetentionIT` on the same real PostgreSQL base: create an eligible terminal command and receipt, run the actual `CommandRetentionJob`, clear the persistence context, prove the command row is gone, then replay solely through the v3 controller/service and require the exact persisted six-field response with no command/account mutation.

Extend `FlywayMigrationIT` to inspect the migrated PostgreSQL catalog and require `command_ack_receipts`, normalized command/gateway/`lease_token_sha256` uniqueness, digest/created-at indexes, no raw-token/payload column, and no deleting FK to `device_commands`. Broaden only the documentation comment on `PostgresSyncTestBase` from sync/Flyway to sync/Flyway/command; do not create a second container base.

Make the ACK proof a byte-continuous two-leg executable chain. The edge test inserts one protected pending-envelope row for every producer/semantic branch using the edge-owned deterministic UUID inputs, executes the shipped v3 queue builder/canonicalizer, writes deterministic `producerExamples`, and derives representatives. The server injects those UUIDs through the real lease service's test token source, verifies persisted lease state, vendors the edge bytes, parses through the scoped strict parser, posts through the real v3 coordinator/entry service, and asserts the exact six-field transport/lifecycle result. Regenerating examples without shipped edge functions or the real injected lease transition, or testing a hand-built DTO, fails provenance.

Make REST the only server-side cloud-command completion owner. `MqttMessageRouter` may parse/meter legacy telemetry but cannot mutate commands or linked auth. Test forged/linked-auth messages with no state change. The authoritative gateway REST controller enforces gateway ownership, current or receipted lease-token identity, allowed semantic pairs, per-entry `accepted`, and independent terminality.

Preserve `SYNC_LINKED_AUTH` through `LinkedAuthAckCompletionService` inside the entry transaction and before receipt insertion. It accepts only persisted command, normalized gateway, canonical pair, terminal Boolean, and persisted/applied version. Add one `PESSIMISTIC_WRITE` lookup to `LinkedGatewayAccountRepository` and make both this service and every modifying method in the current `LinkedGatewayAccountService` reload through that same locking lookup before mutation; no writer may save a caller-supplied stale entity. A valid command version lower than `offlineVerifierVersion` returns `STALE_VERSION_NOOP`: command and receipt complete and are accepted, but account state never regresses. Current/future valid versions apply the intended success/fixed failure; exhausted retryable records `max_attempts_exceeded`; nonterminal retryable performs no account transition. Malformed aggregate, gateway mismatch, missing version/account, or a non-stale write failure throws and rolls back that entry's command/account/receipt. Exact receipt replay bypasses the service. Never accept local UUID/version from extra ACK fields.

Add isolated transaction tests for APPLIED, permanent, expired, nonterminal retryable, max-attempt failure, exact replay, side-effect exception, false non-stale write, malformed aggregate, missing account/version, wrong gateway, v2-before-v1 success/failure arrival, and a mixed batch containing one valid normal command plus one linked-auth failure. In `CommandAckEntryTransactionIT`, add a barrier-controlled PostgreSQL race between a newer verifier write and an older ACK, forcing both commit orders through the shared account lock; neither order may regress verifier version or status. Assert each entry either commits command + account/no-op + receipt once or changes nothing, response truth matches committed state, newer account version never regresses, and MQTT cannot double-complete.

In `WorkRequestStatusNotifierTest`, assert the emitted command type is `WORK_REQUEST_STATUS` and its payload supplies nonblank `request_id` and `status`, matching the canonical command schema's required fields. Do not add a second server command-type registry.

- [ ] **Step 4: Consume all three vendored schemas with real server values**

Add `testImplementation("com.networknt:json-schema-validator:2.0.4")` to `backend/build.gradle.kts`; this is the Jackson 2 line used by the current Spring Boot application, and it must remain test-only. Construct `SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_7, builder -> builder.schemas(schemaByAbsoluteIri).nodeReader(reader -> reader.jsonMapper(objectMapper)))`, load each root with a stable absolute `SchemaLocation`, call `initializeValidators()` before accepting the fixture, and then call `Schema.validate(JsonNode)`. Map the canonical absolute `$id`/`$ref` IRI for `resources.schema.json` to its exact vendored bytes. An unresolved reference, unsupported dialect, or nonempty validation-error list is failure; do not use a permissive default dialect or network resolution.

In `SyncSchemaValidationTest`:

- issue a real `WORK_REQUEST_STATUS` `DeviceCommand`, then build the canonical edge command projection from its actual event UUID as `command_id`, command type, gateway EUI, and flattened persisted payload; validate it against `commands.schema.json`;
- serialize a real `EdgeSyncService.SyncEventRecord` and validate that exact JSON against `events.schema.json`; and
- load the vendored `sync-resource-v1-examples.json` objects that OSI OS produced through its shipped `sync-bootstrap-build` node, validate them against `resources.schema.json#/definitions/SyncBootstrapDevice` and `/SyncBootstrapZone`, and pass those exact same maps through real `EdgeSyncService.applyBootstrap` service cases. Assert saved Device/Zone facts correspond to `device_eui,type` and `zone_uuid,name`, and assert both `scheduling_mode:'local'` and `'server_preferred'` survive into the intended server scheduling fact. Keep separate tests for local `Device`/`Zone`; never add `deveui,type_id,zone_id` or a legacy local scheduling enum to a bootstrap fixture merely to satisfy the wrong definition. No new server-side projection class is introduced unless an actual production boundary consumes it; the edge production projection remains the authority.

The legacy `PendingCommandResponse` and additive `PendingCommandV3BatchResponse` remain separate camelCase/numeric-ID envelopes governed by `sync-http-high-risk-contract.json`; do not validate either envelope against the canonical snake-case command schema or let the v2 type satisfy v3 capability. Add mutation negatives for each vendored schema: remove `request_id` from the work-request command, remove `eventUuid` from the event, remove `device_eui`/`type` from `SyncBootstrapDevice`, remove `zone_uuid`/`name` from `SyncBootstrapZone`, and replace each valid bootstrap scheduling mode with a third or legacy-local value. Also prove local `Device`/`Zone` still reject their own missing required fields without forcing their scheduling vocabulary onto `SyncBootstrapZone`. Each must produce a schema error naming the field. A test that only loads or byte-compares a schema is insufficient.

- [ ] **Step 5: Run and commit server tests**

```bash
cd backend && ./gradlew test --no-daemon \
  -x buildFrontend -x buildTerraIntelligenceFrontend \
  --tests '*SyncHttpHighRiskContractTest' \
  --tests '*SyncSchemaValidationTest' \
  --tests '*EdgeSyncControllerTest' \
  --tests '*EdgeSyncServiceControlPlaneTest' \
  --tests '*CommandAckControllerTest' \
  --tests '*CommandAckEntryServiceTest' \
  --tests '*CommandLeaseServiceTest' \
  --tests '*LinkedAuthAckCompletionServiceTest' \
  --tests '*MqttMessageRouterTest' \
  --tests '*WorkRequestStatusNotifierTest' \
  --tests '*CommandRetentionJobTest' \
  --tests '*DeviceCommandRepositoryDbTest' \
  --tests '*FlywayMigrationIT' \
  --tests '*CommandLeaseAckConcurrencyIT' \
  --tests '*CommandAckEntryTransactionIT' \
  --tests '*CommandReceiptRetentionIT'
```

Run this exact PostgreSQL/Testcontainers selection locally in Task 2 and require every selection to be nonempty. Task 3 owns the single `.github/workflows/backend-ci.yml` edit that installs the identical named command beside vendor verification; do not stage workflow wiring in this feature commit.

Then run the full backend test gate:

```bash
cd backend && ./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend
```

```bash
git add backend/src/test/resources/sync-contract \
  backend/src/test/java/org/osi/server/sync/SyncHttpHighRiskContractTest.java \
  backend/src/test/java/org/osi/server/sync/SyncSchemaValidationTest.java \
  backend/src/main/java/org/osi/server/sync/EdgeSyncController.java \
  backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java \
  backend/src/test/java/org/osi/server/command/CommandAckControllerTest.java \
  backend/src/main/java/org/osi/server/command/CommandAckController.java \
  backend/src/main/java/org/osi/server/command/CommandAckV3Request.java \
  backend/src/main/java/org/osi/server/command/CommandAckV3Response.java \
  backend/src/main/java/org/osi/server/command/CommandAckV3BodyParser.java \
  backend/src/main/java/org/osi/server/command/CommandAckEntryService.java \
  backend/src/test/java/org/osi/server/command/CommandAckEntryServiceTest.java \
  backend/src/main/java/org/osi/server/command/DeviceCommand.java \
  backend/src/main/java/org/osi/server/command/DeviceCommandRepository.java \
  backend/src/main/java/org/osi/server/command/CommandLeaseService.java \
  backend/src/test/java/org/osi/server/command/CommandLeaseServiceTest.java \
  backend/src/main/java/org/osi/server/command/CommandAckReceipt.java \
  backend/src/main/java/org/osi/server/command/CommandAckReceiptRepository.java \
  backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
  backend/src/test/java/org/osi/server/sync/EdgeSyncServiceControlPlaneTest.java \
  backend/src/main/resources/db/migration/V2026_07_15_001__command_ack_lease_receipts.sql \
  backend/src/main/java/org/osi/server/user/LinkedAuthAckCompletionService.java \
  backend/src/test/java/org/osi/server/user/LinkedAuthAckCompletionServiceTest.java \
  backend/src/main/java/org/osi/server/user/LinkedGatewayAccountRepository.java \
  backend/src/main/java/org/osi/server/user/LinkedGatewayAccountService.java \
  backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java \
  backend/src/main/java/org/osi/server/mqtt/MqttMessageRouter.java \
  backend/src/test/java/org/osi/server/mqtt/MqttMessageRouterTest.java \
  backend/src/test/java/org/osi/server/workrequest/WorkRequestStatusNotifierTest.java \
  backend/src/test/java/org/osi/server/retention/CommandRetentionJobTest.java \
  backend/src/test/java/org/osi/server/command/DeviceCommandRepositoryDbTest.java \
  backend/src/test/java/org/osi/server/command/CommandLeaseAckConcurrencyIT.java \
  backend/src/test/java/org/osi/server/command/CommandAckEntryTransactionIT.java \
  backend/src/test/java/org/osi/server/command/CommandReceiptRetentionIT.java \
  backend/src/test/java/org/osi/server/testsupport/FlywayMigrationIT.java \
  backend/src/test/java/org/osi/server/testsupport/PostgresSyncTestBase.java \
  backend/build.gradle.kts
git commit -m "fix: add authoritative v3 command ACK transport"
```

### Task 3: Make server CI reject stale edge contracts

**Repository:** `/home/phil/Repos/osi-server`

**Files:**

- Modify: `.github/workflows/backend-ci.yml`
- Create: `scripts/verify-edge-sync-contract-vendor.sh`
- Create: `scripts/verify-edge-sync-contract-vendor.test.sh`

**Interfaces:**

- Consumes: `EDGE_CONTRACT_ROOT`, the checked-out OSI OS repository root.
- Produces: exit zero only when all five vendored files are byte-identical to the canonical edge files.

- [ ] **Step 1: Write vendor verification with a negative control**

The POSIX script must check every source and destination is a nonempty regular file, then use `cmp -s`. Print the relative path on mismatch without dumping schema contents. The test creates temporary source/vendor trees, proves equality passes, changes one byte in each of the five files in turn, and requires each case to fail.

- [ ] **Step 2: Check out the canonical edge contract in backend CI**

After the normal server checkout, add:

```yaml
- name: Check out canonical OSI OS sync contract
  uses: actions/checkout@v4
  with:
    repository: Open-Smart-Irrigation/osi-os
    ref: main
    path: .contract/osi-os
    persist-credentials: false
    fetch-depth: 1
- name: Verify vendored edge sync contract
  env:
    EDGE_CONTRACT_ROOT: ${{ github.workspace }}/.contract/osi-os
  run: |
    sh scripts/verify-edge-sync-contract-vendor.test.sh
    sh scripts/verify-edge-sync-contract-vendor.sh
- name: Verify PostgreSQL command lease and ACK transactions
  working-directory: backend
  run: |
    ./gradlew test --no-daemon \
      -x buildFrontend -x buildTerraIntelligenceFrontend \
      --tests '*FlywayMigrationIT' \
      --tests '*CommandLeaseAckConcurrencyIT' \
      --tests '*CommandAckEntryTransactionIT' \
      --tests '*CommandReceiptRetentionIT'
```

The comparison runs before Gradle. The named PostgreSQL/Testcontainers command gate runs before the existing full backend test step and cannot be replaced by H2 or Mockito coverage. Checkout failure, main-contract mismatch, Docker/Testcontainers failure, or command IT failure blocks server CI. Do not use `continue-on-error`, a floating artifact download, `curl`, or a branch supplied by untrusted pull-request code.

- [ ] **Step 3: Run and commit CI wiring**

```bash
EDGE_CONTRACT_ROOT=/home/phil/Repos/osi-os sh scripts/verify-edge-sync-contract-vendor.test.sh
EDGE_CONTRACT_ROOT=/home/phil/Repos/osi-os sh scripts/verify-edge-sync-contract-vendor.sh
(
  cd backend
  ./gradlew test --no-daemon \
    -x buildFrontend -x buildTerraIntelligenceFrontend \
    --tests '*FlywayMigrationIT' \
    --tests '*CommandLeaseAckConcurrencyIT' \
    --tests '*CommandAckEntryTransactionIT' \
    --tests '*CommandReceiptRetentionIT'
)
(
  cd backend
  ./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend
)
git diff --check
```

```bash
git add .github/workflows/backend-ci.yml \
  scripts/verify-edge-sync-contract-vendor.sh \
  scripts/verify-edge-sync-contract-vendor.test.sh
git commit -m "ci: reject stale edge sync contracts"
```

### Task 4: Record server vendor ownership

**Repository:** `/home/phil/Repos/osi-server`.

**Files:**

- Modify in OSI Server: `AGENTS.md`

- [ ] **Step 1: Document the two-phase compatibility rule**

Record the server half of the already-merged edge rule:

```text
OSI OS owns sync schemas and HTTP completion semantics. Additive v3 fixture and
capability-gated edge handling merge first without changing v2. OSI Server then
adds exact v3 endpoints while retaining v2. Edge enables strict v3 only after
the exact capability response. V2 removal requires separate fleet evidence and
approval. Server CI compares its test vendor with osi-os/main.
```

State that the vendored server copies are test inputs, not an authority and not production resources. Link to the merged OSI OS ownership text; do not edit OSI OS from the server branch.

- [ ] **Step 2: Run prose and final contract gates**

```bash
cd /home/phil/Repos/osi-server
EDGE_CONTRACT_ROOT=/home/phil/Repos/osi-os sh scripts/verify-edge-sync-contract-vendor.sh
cd backend && ./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend
cd ..
node ../osi-os/.claude/skills/anti-slop-writing/slop-check.js AGENTS.md
git diff --check
```

Commit server documentation separately:

```bash
git add AGENTS.md
git commit -m "docs: record edge-owned sync contract adoption"
```

Do not claim cross-repo green until the merged OSI OS contract and current server worktree both pass.

## Exit criteria

This plan is complete only when:

- OSI OS owns one mixed-version HTTP-semantics fixture; real flow functions prove v2 isolation, v3 capability pinning, every accepted/terminal case, same-token stability, and new-token supersession;
- OSI Server leaves v2 bytes intact and serializes bootstrap `success:true`, event identities/statuses, v3 per-command `accepted`/`terminal`, lease tokens, paths, and capability headers exactly as required;
- strict raw v3 parsing rejects every missing/extra/duplicate/wrong-type field before mutation, while semantic pair failures return a truthful per-entry result;
- `WORK_REQUEST_STATUS` and every command family persist durable intent before effects; SQLite effects are atomic with ledger/outbox and ambiguous external effects cannot repeat;
- command/lease/reclaim/receipt concurrency serializes through one DB lock/CAS and receipt uniqueness, with per-entry transactions isolating batch siblings;
- linked-auth stale versions are accepted no-ops, current failures roll back one entry, and receipt tombstones survive command retention for indefinite replay;
- server CI fails on any byte drift in the fixture or three schemas before running backend tests;
- negative controls prove edge behavior, server serialization, and vendor drift checks can fail;
- the backwards-compatible edge fixture/client commit is merged before the additive server vendor commit, with no strict v2 replacement; and
- neither CI workflow accesses or deploys a live system.
